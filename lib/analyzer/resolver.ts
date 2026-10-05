import ts from 'typescript';
import { builtinModules } from 'node:module';

/** All repository files live under this virtual root so TypeScript sees rooted POSIX paths. */
export const ROOT = '/repo';

export const toAbs = (rel: string): string => (rel ? `${ROOT}/${rel}` : ROOT);
export const toRel = (abs: string): string => (abs.startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : abs === ROOT ? '' : abs);
export const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));
const NPM_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;

/** In-memory file system implementing the pieces of ts.ModuleResolutionHost / ts.CompilerHost we need. */
export class VirtualFs implements ts.ModuleResolutionHost {
  readonly files = new Map<string, string>();
  private readonly children = new Map<string, Set<string>>();

  constructor(entries: Iterable<[relPath: string, text: string]>) {
    for (const [rel, text] of entries) {
      const abs = toAbs(rel);
      this.files.set(abs, text);
      // Register every ancestor directory.
      let child = abs;
      let dir = dirname(abs);
      while (true) {
        let set = this.children.get(dir);
        if (!set) this.children.set(dir, (set = new Set()));
        const isNew = !set.has(child);
        set.add(child);
        if (!isNew || dir === ROOT || dir === '/') break;
        child = dir;
        dir = dirname(dir);
      }
    }
  }

  fileExists = (path: string): boolean => this.files.has(path);
  readFile = (path: string): string | undefined => this.files.get(path);
  directoryExists = (path: string): boolean => this.children.has(path.replace(/\/$/, ''));
  getDirectories = (path: string): string[] => {
    const set = this.children.get(path.replace(/\/$/, ''));
    if (!set) return [];
    const out: string[] = [];
    for (const child of set) if (this.children.has(child)) out.push(child.slice(child.lastIndexOf('/') + 1));
    return out;
  };
  getCurrentDirectory = (): string => ROOT;
  realpath = (path: string): string => path;
  useCaseSensitiveFileNames = true;
}

export type Resolution =
  | { kind: 'internal'; file: string }
  | { kind: 'external'; pkg: string; builtin: boolean }
  | { kind: 'unresolved' };

interface ConfigInfo {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
}

interface WorkspacePackage {
  name: string;
  /** Absolute dir. */
  dir: string;
  /** Entry candidates from package.json fields, relative to dir, without extension. */
  entries: string[];
  /** `exports` subpath map: "./utils" → candidate bases. */
  subpaths: Map<string, string[]>;
}

const BASE_OPTIONS: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.Latest,
  allowJs: true,
  resolveJsonModule: false,
  allowImportingTsExtensions: true,
  noEmit: true,
  noLib: true,
  types: [],
  ignoreDeprecations: '6.0',
};

/** Options that influence module resolution and are worth inheriting from a repo's tsconfig. */
const INHERITED: (keyof ts.CompilerOptions)[] = ['baseUrl', 'paths', 'pathsBasePath', 'rootDirs', 'customConditions'];

export class ModuleResolver {
  private readonly configByDir = new Map<string, ConfigInfo>();
  private readonly configByPath = new Map<string, ConfigInfo>();
  private readonly cache = new Map<string, Resolution>();
  private readonly workspaces: WorkspacePackage[];
  /** Directories that hold a package.json (project roots for `@/` style aliases). */
  private readonly packageDirs = new Set<string>();
  private readonly defaultConfig: ConfigInfo;

  constructor(
    private readonly fs: VirtualFs,
    /** Absolute paths of files that are part of the graph. */
    private readonly sourceFiles: ReadonlySet<string>,
  ) {
    this.defaultConfig = this.makeConfig({});
    this.workspaces = this.findWorkspaces();
  }

  /** Compiler options for resolving modules imported from `file` (nearest tsconfig/jsconfig wins). */
  optionsFor(file: string): ts.CompilerOptions {
    return this.configFor(dirname(file)).options;
  }

  get workspacePackages(): readonly { name: string; dir: string }[] {
    return this.workspaces;
  }

  resolve(specifier: string, containingFile: string): Resolution {
    const dir = dirname(containingFile);
    const key = `${dir}\0${specifier}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.resolveUncached(specifier, containingFile, dir);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private resolveUncached(spec: string, from: string, dir: string): Resolution {
    if (!spec) return { kind: 'unresolved' };
    if (spec.startsWith('node:')) return { kind: 'external', pkg: spec, builtin: true };

    const cfg = this.configFor(dir);
    const result = ts.resolveModuleName(spec, from, cfg.options, this.fs, cfg.cache).resolvedModule;
    if (result && this.sourceFiles.has(result.resolvedFileName)) return { kind: 'internal', file: result.resolvedFileName };

    const relative = spec.startsWith('.') || spec.startsWith('/');
    if (relative) return { kind: 'unresolved' };

    const ws = this.resolveWorkspace(spec);
    if (ws) return { kind: 'internal', file: ws };

    if (spec.startsWith('@/') || spec.startsWith('~/')) {
      const aliased = this.resolveRootAlias(spec.slice(2), dir);
      return aliased ? { kind: 'internal', file: aliased } : { kind: 'unresolved' };
    }
    if (spec.startsWith('#') || spec.startsWith('~')) return { kind: 'unresolved' };

    const segments = spec.split('/');
    const pkg = spec.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    if (!NPM_NAME.test(pkg)) return { kind: 'unresolved' };
    return BUILTINS.has(pkg) ? { kind: 'external', pkg: `node:${pkg}`, builtin: true } : { kind: 'external', pkg, builtin: false };
  }

  // ---------------------------------------------------------------- tsconfig

  private configFor(dir: string): ConfigInfo {
    const cached = this.configByDir.get(dir);
    if (cached) return cached;
    let info: ConfigInfo;
    const candidate = [`${dir}/tsconfig.json`, `${dir}/jsconfig.json`].find((p) => this.fs.fileExists(p));
    if (candidate) info = this.loadConfig(candidate);
    else if (dir === ROOT || dir === '/' || !dir.startsWith(ROOT)) info = this.defaultConfig;
    else info = this.configFor(dirname(dir));
    this.configByDir.set(dir, info);
    return info;
  }

  private loadConfig(path: string): ConfigInfo {
    const cached = this.configByPath.get(path);
    if (cached) return cached;
    let inherited: ts.CompilerOptions = {};
    try {
      const { config } = ts.readConfigFile(path, this.fs.readFile);
      if (config) {
        const parsed = ts.parseJsonConfigFileContent(
          config,
          { useCaseSensitiveFileNames: true, readDirectory: () => [], fileExists: this.fs.fileExists, readFile: this.fs.readFile },
          dirname(path),
          undefined,
          path,
        );
        for (const key of INHERITED) if (parsed.options[key] !== undefined) inherited[key] = parsed.options[key];
      }
    } catch {
      inherited = {};
    }
    const info = this.makeConfig(inherited);
    this.configByPath.set(path, info);
    return info;
  }

  private makeConfig(inherited: ts.CompilerOptions): ConfigInfo {
    const options = { ...BASE_OPTIONS, ...inherited };
    return { options, cache: ts.createModuleResolutionCache(ROOT, (f) => f, options) };
  }

  // -------------------------------------------------------------- workspaces

  private findWorkspaces(): WorkspacePackage[] {
    const out: WorkspacePackage[] = [];
    for (const [path, text] of this.fs.files) {
      if (!path.endsWith('/package.json')) continue;
      const dir = dirname(path);
      this.packageDirs.add(dir);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof json.name !== 'string' || !json.name) continue;
      const entries: string[] = [];
      const subpaths = new Map<string, string[]>();
      const exportsField = json.exports;
      if (typeof exportsField === 'string') entries.push(...entryBases(exportsField));
      else if (exportsField && typeof exportsField === 'object') {
        const map = exportsField as Record<string, unknown>;
        const isSubpathMap = Object.keys(map).some((k) => k.startsWith('.'));
        if (isSubpathMap) {
          for (const [sub, target] of Object.entries(map)) {
            const leaves = conditionLeaves(target).flatMap(entryBases);
            if (sub === '.') entries.push(...leaves);
            else if (!sub.includes('*')) subpaths.set(sub, leaves);
          }
        } else {
          entries.push(...conditionLeaves(map).flatMap(entryBases));
        }
      }
      for (const field of ['source', 'module', 'main', 'types', 'typings']) {
        const value = json[field];
        if (typeof value === 'string') entries.push(...entryBases(value));
      }
      out.push({ name: json.name, dir, entries, subpaths });
    }
    // Longest name first so `@scope/pkg-utils` wins over `@scope/pkg`.
    return out.sort((a, b) => b.name.length - a.name.length);
  }

  private resolveWorkspace(spec: string): string | null {
    for (const pkg of this.workspaces) {
      if (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`)) continue;
      const sub = spec.slice(pkg.name.length + 1);
      const bases = sub
        ? [...(pkg.subpaths.get(`./${sub}`) ?? []), `src/${sub}`, sub, `lib/${sub}`, `source/${sub}`]
        : [...pkg.entries, 'src/index', 'index', 'lib/index', 'source/index', 'src/main', 'main'];
      for (const base of bases) {
        const hit = this.tryFile(base ? `${pkg.dir}/${base}` : pkg.dir);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** `@/foo` / `~/foo` aliases (Next.js, Nuxt, Vite) when tsconfig paths didn't cover them. */
  private resolveRootAlias(rest: string, dir: string): string | null {
    let d = dir;
    while (d.startsWith(ROOT)) {
      if (this.packageDirs.has(d) || d === ROOT) {
        const hit = this.tryFile(`${d}/src/${rest}`) ?? this.tryFile(`${d}/${rest}`);
        if (hit) return hit;
      }
      if (d === ROOT) break;
      d = dirname(d);
    }
    return null;
  }

  private tryFile(base: string): string | null {
    const has = (p: string) => this.sourceFiles.has(p);
    if (has(base)) return base;
    const stripped = base.replace(/\.(?:[cm]?[jt]sx?)$/, '');
    for (const ext of SOURCE_EXTS) if (has(stripped + ext)) return stripped + ext;
    for (const ext of SOURCE_EXTS) if (has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  }
}

function conditionLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(conditionLeaves);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const preferred = ['source', 'development', 'types', 'import', 'module', 'default', 'require', 'node', 'browser'];
    const keys = [...preferred.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !preferred.includes(k))];
    return keys.flatMap((k) => conditionLeaves(obj[k]));
  }
  return [];
}

/** `./dist/esm/index.js` → [`dist/esm/index`, `src/index`] (published entry → likely source location). */
function entryBases(field: string): string[] {
  const clean = field.replace(/^\.\//, '').replace(/\.d\.[cm]?ts$/, '').replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const srcified = clean.replace(/^(?:dist|lib|build|out|esm|cjs|es|module|types)(?:\/(?:esm|cjs|es|types|module|src))?\//, 'src/');
  return srcified !== clean ? [clean, srcified] : [clean];
}
