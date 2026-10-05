import ts from 'typescript';
import {
  NodeFlag,
  type AnalyzeEvent,
  type AnalyzeOptions,
  type CodeGraph,
  type NodeKind,
  type RepoRef,
} from '../graph/types';
import { GraphBuilder } from './graph-builder';
import { ModuleResolver, ROOT, VirtualFs, toAbs, toRel } from './resolver';
import { computeGroups } from './structure';
import { stronglyConnectedComponents } from './cycles';
import { rankForTruncation } from './filters';
import { UserFacingError } from '../repoInput';

export interface BuildInput {
  /** rel path → source text */
  sources: Map<string, string>;
  /** rel path → tsconfig/jsconfig/package.json text */
  configs: Map<string, string>;
  repo: RepoRef;
  options: AnalyzeOptions;
  /** Files already dropped during download (size, generated). */
  skipped?: number;
  downloadBytes?: number;
  downloadMs?: number;
  /** Wall-clock budget for type-checker-backed resolution before degrading to cheap lookups. */
  semanticBudgetMs?: number;
}

type Emit = (event: AnalyzeEvent) => void;

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.ClassExpression;

interface FileCtx {
  id: number;
  rel: string;
  abs: string;
  sf: ts.SourceFile;
  group: number;
  /** Module-level functions/classes declared in this file, by local name. */
  locals: Map<string, number[]>;
  /** Every module-level variable name (for `obj.method = function…` patterns). */
  vars: Set<string>;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const PROGRAM_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  noLib: true,
  types: [],
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  experimentalDecorators: true,
  allowImportingTsExtensions: true,
  maxNodeModuleJsDepth: 0,
  ignoreDeprecations: '6.0',
};

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function skipOuter(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

/**
 * The function (or class) a variable initializer evaluates to, looking through
 * HOC wrappers such as `memo(() => …)`, `forwardRef(function X() {…})`, `withAuth(async (req) => …)`.
 */
function unwrapFunction(expr: ts.Expression, depth = 0): FunctionLike | undefined {
  expr = skipOuter(expr);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) return expr;
  if (ts.isCallExpression(expr) && depth < 3) {
    for (const arg of expr.arguments) {
      const fn = unwrapFunction(arg, depth + 1);
      if (fn) return fn;
    }
  }
  return undefined;
}

function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression;
    if (ts.isPropertyAccessExpression(e)) return `[${e.getText()}]`;
    if (ts.isStringLiteralLike(e)) return e.text;
  }
  return undefined;
}

/** `a.b.c` → ['a','b','c']; undefined for anything fancier. */
function propertyChain(expr: ts.Expression): string[] | undefined {
  const out: string[] = [];
  let e: ts.Expression = expr;
  while (true) {
    if (ts.isPropertyAccessExpression(e)) {
      out.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      out.unshift(e.argumentExpression.text);
      e = e.expression;
    } else if (ts.isIdentifier(e)) {
      out.unshift(e.text);
      return out;
    } else {
      return undefined;
    }
  }
}

function modifierFlags(node: ts.Node): ts.ModifierFlags {
  try {
    return ts.getCombinedModifierFlags(node as ts.Declaration);
  } catch {
    return ts.ModifierFlags.None;
  }
}

/** True when `id` names something (declaration, property, attribute) rather than referencing a local binding. */
function isNameSlot(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p || ts.isShorthandPropertyAssignment(p) || ts.isExportSpecifier(p)) return false; // these reference the local
  return (p as ts.Node & { name?: ts.Node }).name === id;
}

function extensionOf(path: string): ts.Extension {
  const m = /\.(d\.)?([cm]?[jt]sx?)$/i.exec(path);
  const ext = m ? `.${m[2].toLowerCase()}` : '.js';
  return (Object.values(ts.Extension) as string[]).includes(ext) ? (ext as ts.Extension) : ts.Extension.Js;
}

export async function buildGraph(input: BuildInput, emit: Emit): Promise<CodeGraph> {
  const t0 = Date.now();
  const { repo, options } = input;
  let skipped = input.skipped ?? 0;

  // ------------------------------------------------------------ file selection
  let relFiles = [...input.sources.keys()].sort();
  let truncated = false;
  if (relFiles.length > options.maxFiles) {
    const ranked = [...relFiles].sort((a, b) => rankForTruncation(a) - rankForTruncation(b) || a.localeCompare(b));
    const keep = new Set(ranked.slice(0, options.maxFiles));
    skipped += relFiles.length - keep.size;
    relFiles = relFiles.filter((f) => keep.has(f));
    truncated = true;
  }
  if (relFiles.length === 0) throw new UserFacingError('No JavaScript or TypeScript source files found in this repository.');

  const fs = new VirtualFs([
    ...relFiles.map((f) => [f, input.sources.get(f)!] as [string, string]),
    ...input.configs.entries(),
  ]);
  const sourceSet = new Set(relFiles.map(toAbs));
  const resolver = new ModuleResolver(fs, sourceSet);
  const { groups, groupOf } = computeGroups(
    relFiles,
    resolver.workspacePackages.map((w) => ({ name: w.name, dir: toRel(w.dir) })),
  );

  const builder = new GraphBuilder();

  // ---------------------------------------------------------- directory tree
  const dirIds = new Map<string, number>();
  const rootName = repo.subdir ? repo.subdir.split('/').pop()! : repo.repo;
  dirIds.set('', builder.addNode({ kind: 'dir', name: rootName, path: '', parent: -1, group: -1, line: 0, endLine: 0, loc: 0, flags: 0 }));
  const ensureDir = (dir: string): number => {
    const known = dirIds.get(dir);
    if (known !== undefined) return known;
    const slash = dir.lastIndexOf('/');
    const parent = ensureDir(slash < 0 ? '' : dir.slice(0, slash));
    const id = builder.addNode({ kind: 'dir', name: dir.slice(slash + 1), path: dir, parent, group: -1, line: 0, endLine: 0, loc: 0, flags: 0 });
    builder.addEdge(parent, id, 'contains');
    dirIds.set(dir, id);
    return id;
  };

  // ------------------------------------------------------------------- parse
  const files: FileCtx[] = [];
  const fileIdByAbs = new Map<string, number>();
  const sourceFiles = new Map<string, ts.SourceFile>();
  const parseStart = Date.now();
  let lastYield = Date.now();
  for (let i = 0; i < relFiles.length; i++) {
    const rel = relFiles[i];
    const abs = toAbs(rel);
    const text = input.sources.get(rel)!;
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
    sourceFiles.set(abs, sf);
    const slash = rel.lastIndexOf('/');
    const dirId = ensureDir(slash < 0 ? '' : rel.slice(0, slash));
    const lines = sf.getLineStarts().length;
    const group = groupOf.get(rel)!;
    const id = builder.addNode({
      kind: 'file',
      name: rel.slice(slash + 1),
      path: rel,
      parent: dirId,
      group,
      line: 1,
      endLine: lines,
      loc: lines,
      flags: /\.[jt]sx$/i.test(rel) ? NodeFlag.Jsx : 0,
    });
    builder.addEdge(dirId, id, 'contains');
    fileIdByAbs.set(abs, id);
    files.push({ id, rel, abs, sf, group, locals: new Map(), vars: new Set() });
    if (Date.now() - lastYield > 60) {
      emit({ type: 'progress', stage: 'parse', message: 'Parsing syntax trees', done: i + 1, total: relFiles.length });
      await yieldToEventLoop();
      lastYield = Date.now();
    }
  }
  emit({ type: 'progress', stage: 'parse', message: 'Parsing syntax trees', done: relFiles.length, total: relFiles.length });

  // ------------------------------------------------- phase A: declarations
  /** Declaration (or function-like initializer) node → graph node id. */
  const declMap = new Map<ts.Node, number>();

  const addSymbol = (
    ctx: FileCtx,
    kind: NodeKind,
    name: string,
    declNode: ts.Node,
    rangeNode: ts.Node,
    parent: number,
    flags: number,
  ): number => {
    const start = ctx.sf.getLineAndCharacterOfPosition(rangeNode.getStart(ctx.sf)).line + 1;
    const end = ctx.sf.getLineAndCharacterOfPosition(rangeNode.getEnd()).line + 1;
    if (/^use[A-Z0-9]/.test(name) && kind === 'function') flags |= NodeFlag.Hook;
    const id = builder.addNode({ kind, name, path: ctx.rel, parent, group: ctx.group, line: start, endLine: end, loc: end - start + 1, flags });
    builder.addEdge(parent, id, 'contains');
    declMap.set(declNode, id);
    if (parent === ctx.id) {
      const list = ctx.locals.get(name);
      if (list) list.push(id);
      else ctx.locals.set(name, [id]);
    }
    return id;
  };

  const defaultName = (ctx: FileCtx): string => {
    const parts = ctx.rel.replace(/\.[^./]+$/, '').split('/');
    const base = parts[parts.length - 1];
    return base === 'index' && parts.length > 1 ? parts[parts.length - 2] : base;
  };

  const fnFlags = (fn: ts.Node, mods: ts.ModifierFlags): number => {
    let flags = 0;
    if (mods & ts.ModifierFlags.Export) flags |= NodeFlag.Exported;
    if (mods & ts.ModifierFlags.Default) flags |= NodeFlag.Default | NodeFlag.Exported;
    if (mods & ts.ModifierFlags.Static) flags |= NodeFlag.Static;
    if (modifierFlags(fn) & ts.ModifierFlags.Async) flags |= NodeFlag.Async;
    return flags;
  };

  const collectMembers = (ctx: FileCtx, cls: ts.ClassLikeDeclaration, classId: number) => {
    for (const m of cls.members) {
      if (ts.isConstructorDeclaration(m) || ts.isClassStaticBlockDeclaration(m)) {
        declMap.set(m, classId);
        continue;
      }
      let fnNode: ts.Node | undefined;
      let prefix = '';
      if (ts.isMethodDeclaration(m) && m.body) fnNode = m;
      else if (ts.isGetAccessorDeclaration(m) && m.body) (fnNode = m), (prefix = 'get ');
      else if (ts.isSetAccessorDeclaration(m) && m.body) (fnNode = m), (prefix = 'set ');
      else if (ts.isPropertyDeclaration(m) && m.initializer) {
        const fn = unwrapFunction(m.initializer);
        if (fn && !ts.isClassExpression(fn)) fnNode = fn;
      }
      if (!fnNode) continue;
      const name = memberName(m.name);
      if (!name) continue;
      const id = addSymbol(ctx, 'method', prefix + name, m, m, classId, fnFlags(fnNode, modifierFlags(m)));
      if (fnNode !== m) declMap.set(fnNode, id);
    }
  };

  /** `{ foo() {}, bar: () => {} }` used as a namespace object: each function member becomes `obj.foo`. */
  const collectObjectFunctions = (ctx: FileCtx, obj: ts.ObjectLiteralExpression, prefix: string, flags: number) => {
    for (const prop of obj.properties) {
      let fn: ts.Node | undefined;
      if (ts.isMethodDeclaration(prop) && prop.body) fn = prop;
      else if (ts.isPropertyAssignment(prop)) {
        const f = unwrapFunction(prop.initializer);
        if (f && !ts.isClassExpression(f)) fn = f;
      }
      if (!fn) continue;
      const name = memberName(prop.name);
      if (!name) continue;
      const id = addSymbol(ctx, 'function', prefix + name, prop, prop, ctx.id, flags | fnFlags(fn, 0));
      if (fn !== prop) declMap.set(fn, id);
    }
  };

  /** CommonJS / prototype patterns: `module.exports = fn`, `exports.x = fn`, `Foo.prototype.bar = fn`. */
  const collectAssignment = (ctx: FileCtx, expr: ts.Expression) => {
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const chain = propertyChain(expr.left);
    if (!chain || chain.length < 2) return;
    const isModuleExports = chain[0] === 'module' && chain[1] === 'exports';
    const right = skipOuter(expr.right);
    if (isModuleExports && chain.length === 2 && ts.isObjectLiteralExpression(right)) {
      collectObjectFunctions(ctx, right, '', NodeFlag.Exported);
      return;
    }
    const fn = unwrapFunction(expr.right);
    if (!fn) return;
    let nodeKind: NodeKind = ts.isClassExpression(fn) ? 'class' : 'function';
    let name: string;
    let parent = ctx.id;
    let flags = 0;
    if (isModuleExports && chain.length === 2) {
      name = fn.name?.text ?? defaultName(ctx);
      flags = NodeFlag.Exported | NodeFlag.Default;
    } else if (isModuleExports && chain.length === 3) {
      name = chain[2];
      flags = NodeFlag.Exported;
    } else if (chain[0] === 'exports' && chain.length === 2) {
      name = chain[1];
      flags = NodeFlag.Exported;
    } else if (chain.length === 3 && chain[1] === 'prototype') {
      const owner = ctx.locals.get(chain[0])?.[0];
      if (owner !== undefined) {
        parent = owner;
        nodeKind = 'method';
        name = chain[2];
      } else {
        name = `${chain[0]}.${chain[2]}`;
      }
    } else if (chain.length === 2 && ctx.locals.has(chain[0])) {
      parent = ctx.locals.get(chain[0])![0];
      nodeKind = 'method';
      name = chain[1];
      flags = NodeFlag.Static;
    } else if (chain.length === 2 && ctx.vars.has(chain[0])) {
      // `var res = Object.create(...); res.status = function status() {…}`
      name = `${chain[0]}.${chain[1]}`;
    } else {
      return;
    }
    const id = addSymbol(ctx, nodeKind, name, expr, expr, parent, flags | fnFlags(fn, 0));
    declMap.set(fn, id);
    declMap.set(expr.left, id);
    if (ts.isClassExpression(fn)) collectMembers(ctx, fn, id);
  };

  const collectStatements = (ctx: FileCtx, statements: ts.NodeArray<ts.Statement>, prefix: string) => {
    const localExports: string[] = [];
    for (const stmt of statements) {
      if (ts.isFunctionDeclaration(stmt)) {
        if (!stmt.body) continue; // overload signature or `declare function`
        const mods = modifierFlags(stmt);
        const name = stmt.name?.text ?? (mods & ts.ModifierFlags.Default ? defaultName(ctx) : undefined);
        if (name) addSymbol(ctx, 'function', prefix + name, stmt, stmt, ctx.id, fnFlags(stmt, mods));
      } else if (ts.isClassDeclaration(stmt)) {
        const mods = modifierFlags(stmt);
        const name = stmt.name?.text ?? (mods & ts.ModifierFlags.Default ? defaultName(ctx) : undefined);
        if (!name || mods & ts.ModifierFlags.Ambient) continue;
        const id = addSymbol(ctx, 'class', prefix + name, stmt, stmt, ctx.id, fnFlags(stmt, mods));
        collectMembers(ctx, stmt, id);
      } else if (ts.isVariableStatement(stmt)) {
        const mods = modifierFlags(stmt);
        if (mods & ts.ModifierFlags.Ambient) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) ctx.vars.add(decl.name.text);
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const name = prefix + decl.name.text;
          const init = skipOuter(decl.initializer);
          if (ts.isObjectLiteralExpression(init)) {
            collectObjectFunctions(ctx, init, `${name}.`, mods & ts.ModifierFlags.Export ? NodeFlag.Exported : 0);
            continue;
          }
          const fn = unwrapFunction(decl.initializer);
          if (!fn) continue;
          const isClass = ts.isClassExpression(fn);
          const id = addSymbol(ctx, isClass ? 'class' : 'function', name, decl, decl, ctx.id, fnFlags(fn, mods));
          declMap.set(fn, id);
          if (isClass) collectMembers(ctx, fn, id);
        }
      } else if (ts.isModuleDeclaration(stmt)) {
        // namespace A.B { … } → flatten into the file with a qualified prefix
        let body: ts.ModuleBody | undefined = stmt.body;
        let ns = `${prefix}${stmt.name.getText(ctx.sf)}.`;
        while (body && ts.isModuleDeclaration(body)) {
          ns += `${body.name.getText(ctx.sf)}.`;
          body = body.body;
        }
        if (body && ts.isModuleBlock(body)) collectStatements(ctx, body.statements, ns);
      } else if (ts.isExportAssignment(stmt)) {
        const expr = skipOuter(stmt.expression);
        if (ts.isIdentifier(expr)) {
          localExports.push(expr.text);
          continue;
        }
        if (ts.isObjectLiteralExpression(expr)) {
          collectObjectFunctions(ctx, expr, '', NodeFlag.Exported);
          continue;
        }
        const fn = unwrapFunction(stmt.expression);
        if (!fn || declMap.has(fn)) continue;
        const isClass = ts.isClassExpression(fn);
        const id = addSymbol(ctx, isClass ? 'class' : 'function', fn.name?.text ?? defaultName(ctx), stmt, fn, ctx.id,
          NodeFlag.Exported | NodeFlag.Default | fnFlags(fn, 0));
        declMap.set(fn, id);
        if (isClass) collectMembers(ctx, fn, id);
      } else if (ts.isExpressionStatement(stmt)) {
        collectAssignment(ctx, stmt.expression);
      } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) localExports.push((el.propertyName ?? el.name).text);
      }
    }
    for (const name of localExports) for (const id of ctx.locals.get(name) ?? []) builder.setFlag(id, NodeFlag.Exported);
  };

  for (const ctx of files) {
    try {
      collectStatements(ctx, ctx.sf.statements, '');
    } catch {
      // Same guard as linking: one bad file must not sink the whole repository.
    }
  }
  const parseMs = Date.now() - parseStart;

  // ------------------------------------------------------- program + checker
  emit({ type: 'progress', stage: 'link', message: 'Binding symbols & building the type checker', done: 0, total: files.length });
  await yieldToEventLoop();
  const linkStart = Date.now();

  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const cached = sourceFiles.get(fileName);
      if (cached) return cached;
      const text = fs.readFile(fileName);
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => '/__lib__/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: fs.fileExists,
    readFile: fs.readFile,
    directoryExists: fs.directoryExists,
    getDirectories: fs.getDirectories,
    realpath: fs.realpath,
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((lit) => {
        const res = resolver.resolve(lit.text, containingFile);
        if (res.kind !== 'internal') return { resolvedModule: undefined };
        return {
          resolvedModule: {
            resolvedFileName: res.file,
            extension: extensionOf(res.file),
            isExternalLibraryImport: false,
          },
        };
      }),
    resolveTypeReferenceDirectiveReferences: (refs) => refs.map(() => ({ resolvedTypeReferenceDirective: undefined })),
  };

  const program = ts.createProgram({ rootNames: files.map((f) => f.abs), options: PROGRAM_OPTIONS, host });
  const checker = program.getTypeChecker();

  // ------------------------------------------------------ phase B: linking
  const externalIds = new Map<string, number>();
  const externalNode = (pkg: string, builtin: boolean): number => {
    let id = externalIds.get(pkg);
    if (id === undefined) {
      id = builder.addNode({ kind: 'external', name: pkg, path: '', parent: -1, group: -1, line: 0, endLine: 0, loc: 0, flags: builtin ? NodeFlag.Builtin : 0 });
      externalIds.set(pkg, id);
    }
    return id;
  };

  const safe = <T,>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };

  /** Walk aliases / re-exports / `const a = b` chains until we land on a declaration we registered. */
  const followSymbol = (start: ts.Symbol | undefined, semantic: boolean): number => {
    let sym = start;
    const seen = new Set<ts.Symbol>();
    for (let depth = 0; sym && depth < 10; depth++) {
      if (seen.has(sym)) return -1;
      seen.add(sym);
      if (sym.flags & ts.SymbolFlags.Alias) {
        const target: ts.Symbol | undefined = safe(() => checker.getAliasedSymbol(sym!));
        if (!target || target === sym) return -1;
        sym = target;
        continue;
      }
      for (const d of sym.declarations ?? []) {
        const id = declMap.get(d);
        if (id !== undefined) return id;
      }
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) return -1;
      let next: ts.Symbol | undefined;
      if (ts.isShorthandPropertyAssignment(decl)) {
        next = safe(() => checker.getShorthandAssignmentValueSymbol(decl));
      } else if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
        const init = skipOuter(decl.initializer);
        const direct = declMap.get(init);
        if (direct !== undefined) return direct;
        if (ts.isIdentifier(init)) next = safe(() => checker.getSymbolAtLocation(init));
        else if (ts.isPropertyAccessExpression(init)) next = safe(() => checker.getSymbolAtLocation(init.name));
      } else if (ts.isBinaryExpression(decl)) {
        const direct = declMap.get(skipOuter(decl.right)) ?? declMap.get(decl.left);
        if (direct !== undefined) return direct;
      } else if (ts.isPropertyAccessExpression(decl) && decl.parent && ts.isBinaryExpression(decl.parent)) {
        const direct = declMap.get(skipOuter(decl.parent.right));
        if (direct !== undefined) return direct;
      }
      if (!next && semantic && (ts.isBindingElement(decl) || ts.isVariableDeclaration(decl))) {
        // Destructured or computed bindings: a function/class value's type carries the declaring symbol.
        const typeSym = safe(() => checker.getTypeOfSymbol(sym!).getSymbol());
        if (typeSym && typeSym !== sym) next = typeSym;
      }
      sym = next;
    }
    return -1;
  };

  /** In degraded mode we only allow receivers whose symbol lookup doesn't force expression type inference. */
  const cheapReceiver = (expr: ts.Expression): boolean => {
    expr = skipOuter(expr);
    if (expr.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isIdentifier(expr)) return false;
    let sym = safe(() => checker.getSymbolAtLocation(expr));
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = safe(() => checker.getAliasedSymbol(sym!));
    return !!sym && (sym.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.NamespaceModule)) !== 0;
  };

  const resolveCallee = (callee: ts.Expression, semantic: boolean): number => {
    const e = skipOuter(callee);
    let nameNode: ts.Node;
    if (ts.isIdentifier(e)) nameNode = e;
    else if (ts.isPropertyAccessExpression(e)) {
      if (!semantic && !cheapReceiver(e.expression)) return -1;
      nameNode = e.name;
    } else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      if (!semantic) return -1;
      nameNode = e.argumentExpression;
    } else return -1;
    return followSymbol(safe(() => checker.getSymbolAtLocation(nameNode)), semantic);
  };

  let totalCalls = 0;
  let resolvedCalls = 0;
  const budget = input.semanticBudgetMs ?? 25_000;
  const deadline = Date.now() + budget;
  let semantic = true;
  let degradedAt = -1;
  let failedFiles = 0;

  const importEdge = (ctx: FileCtx, spec: string, typeOnly: boolean) => {
    const res = resolver.resolve(spec, ctx.abs);
    if (res.kind === 'internal') builder.addEdge(ctx.id, fileIdByAbs.get(res.file)!, 'import', typeOnly);
    else if (res.kind === 'external') builder.addEdge(ctx.id, externalNode(res.pkg, res.builtin), 'import', typeOnly);
  };

  const markImported = (name: ts.ModuleExportName) => {
    const id = followSymbol(safe(() => checker.getSymbolAtLocation(name)), false);
    if (id >= 0) builder.setFlag(id, NodeFlag.Imported);
  };

  const linkFile = (ctx: FileCtx) => {
    const { sf } = ctx;
    /** Record edges/flags for one node; returns false when its subtree needs no visit. */
    const visit = (node: ts.Node, owner: number): boolean => {
      switch (node.kind) {
        case ts.SyntaxKind.ImportDeclaration: {
          const imp = node as ts.ImportDeclaration;
          if (!ts.isStringLiteralLike(imp.moduleSpecifier)) return false;
          const clause = imp.importClause;
          const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : undefined;
          const typeOnly = !!clause && (clause.isTypeOnly ||
            (!clause.name && !!named && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly)));
          importEdge(ctx, imp.moduleSpecifier.text, typeOnly);
          if (clause?.name) markImported(clause.name);
          for (const el of named?.elements ?? []) markImported(el.name);
          return false;
        }
        case ts.SyntaxKind.ExportDeclaration: {
          const exp = node as ts.ExportDeclaration;
          if (exp.moduleSpecifier && ts.isStringLiteralLike(exp.moduleSpecifier)) {
            importEdge(ctx, exp.moduleSpecifier.text, exp.isTypeOnly);
            if (exp.exportClause && ts.isNamedExports(exp.exportClause)) {
              for (const el of exp.exportClause.elements) markImported(el.name);
            }
            return false;
          }
          break;
        }
        case ts.SyntaxKind.ImportEqualsDeclaration: {
          const ref = (node as ts.ImportEqualsDeclaration).moduleReference;
          if (ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)) importEdge(ctx, ref.expression.text, false);
          return false;
        }
        case ts.SyntaxKind.CallExpression: {
          const call = node as ts.CallExpression;
          const callee = call.expression;
          const arg = call.arguments[0];
          if (callee.kind === ts.SyntaxKind.ImportKeyword) {
            if (arg && ts.isStringLiteralLike(arg)) importEdge(ctx, arg.text, false);
          } else if (ts.isIdentifier(callee) && callee.text === 'require' && arg && ts.isStringLiteralLike(arg)) {
            importEdge(ctx, arg.text, false);
          } else {
            totalCalls++;
            const target = resolveCallee(callee, semantic);
            if (target >= 0) {
              resolvedCalls++;
              builder.addEdge(owner, target, 'call');
            }
          }
          break;
        }
        case ts.SyntaxKind.NewExpression: {
          totalCalls++;
          const target = resolveCallee((node as ts.NewExpression).expression, semantic);
          if (target >= 0) {
            resolvedCalls++;
            builder.addEdge(owner, target, 'call');
          }
          break;
        }
        case ts.SyntaxKind.Decorator: {
          const expr = (node as ts.Decorator).expression;
          if (ts.isIdentifier(expr)) builder.addEdge(owner, resolveCallee(expr, semantic), 'call');
          break;
        }
        case ts.SyntaxKind.JsxOpeningElement:
        case ts.SyntaxKind.JsxSelfClosingElement: {
          builder.setFlag(ctx.id, NodeFlag.Jsx);
          const ownerNode = builder.nodes[owner];
          if (ownerNode.kind === 'function' && /^[A-Z]/.test(ownerNode.name)) builder.setFlag(owner, NodeFlag.Component);
          else if (ownerNode.kind === 'method' && ownerNode.name === 'render') builder.setFlag(ownerNode.parent, NodeFlag.Component);
          const tag = (node as ts.JsxOpeningLikeElement).tagName;
          if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) break; // intrinsic element
          if (ts.isIdentifier(tag) || ts.isPropertyAccessExpression(tag)) {
            builder.addEdge(owner, resolveCallee(tag, semantic), 'render');
          }
          break;
        }
        case ts.SyntaxKind.HeritageClause: {
          for (const t of (node as ts.HeritageClause).types) builder.addEdge(owner, resolveCallee(t.expression, semantic), 'inherit');
          break;
        }
        case ts.SyntaxKind.Identifier: {
          const id = node as ts.Identifier;
          const locals = ctx.locals.get(id.text);
          if (locals && !isNameSlot(id)) for (const l of locals) if (l !== owner) builder.setFlag(l, NodeFlag.Referenced);
          return false;
        }
      }
      return true;
    };

    // Explicit stack instead of recursion: generated code can nest expressions thousands deep.
    const nodes: ts.Node[] = [sf];
    const owners: number[] = [ctx.id];
    while (nodes.length) {
      const node = nodes.pop()!;
      let owner = owners.pop()!;
      const mapped = declMap.get(node);
      if (mapped !== undefined) owner = mapped;
      if (!visit(node, owner)) continue;
      const first = nodes.length;
      ts.forEachChild(node, (child) => {
        nodes.push(child);
        owners.push(owner);
      });
      // Keep source order: reverse the slice just pushed so the first child pops first.
      for (let a = first, b = nodes.length - 1; a < b; a++, b--) {
        [nodes[a], nodes[b]] = [nodes[b], nodes[a]];
        [owners[a], owners[b]] = [owners[b], owners[a]];
      }
    }
  };

  lastYield = Date.now();
  for (let i = 0; i < files.length; i++) {
    if (semantic && Date.now() > deadline) {
      semantic = false;
      degradedAt = i;
    }
    try {
      linkFile(files[i]);
    } catch {
      // Pathological files (e.g. 10k-deep expression chains in generated code) can overflow the
      // recursive walk or trip the checker; keep their declarations, drop their links.
      failedFiles++;
    }
    if (Date.now() - lastYield > 60) {
      emit({
        type: 'progress',
        stage: 'link',
        message: semantic ? 'Resolving calls with the type checker' : 'Resolving calls (fast mode)',
        done: i + 1,
        total: files.length,
      });
      await yieldToEventLoop();
      lastYield = Date.now();
    }
  }
  const resolveMs = Date.now() - linkStart;

  // ------------------------------------------------------------ finalize
  emit({ type: 'progress', stage: 'finalize', message: 'Detecting cycles & computing metrics' });
  const nodes = builder.nodes;
  const edges = builder.edges;

  // Directory sizes and groups (a dir belongs to a group only if all its files do).
  const dirGroup = new Map<number, number>();
  for (const f of files) {
    const loc = nodes[f.id].loc;
    for (let dir = nodes[f.id].parent; dir >= 0; dir = nodes[dir].parent) {
      nodes[dir].loc += loc;
      const g = dirGroup.get(dir);
      dirGroup.set(dir, g === undefined || g === f.group ? f.group : -1);
    }
  }
  for (const [dir, g] of dirGroup) nodes[dir].group = g;

  // Runtime import cycles between files.
  const adjacency: number[][] = [];
  for (const e of edges) {
    if (e.kind !== 'import' || e.typeOnly || nodes[e.target].kind !== 'file') continue;
    (adjacency[e.source] ??= []).push(e.target);
  }
  const cycles = stronglyConnectedComponents(nodes.length, adjacency);
  for (const component of cycles) for (const id of component) nodes[id].flags |= NodeFlag.InCycle;

  const countEdges = (kind: string) => edges.reduce((n, e) => n + (e.kind === kind ? 1 : 0), 0);
  const graph: CodeGraph = {
    version: 1,
    repo,
    nodes,
    edges,
    groups,
    cycles,
    stats: {
      files: files.length,
      functions: builder.count('function'),
      classes: builder.count('class'),
      methods: builder.count('method'),
      externals: externalIds.size,
      importEdges: countEdges('import'),
      callEdges: countEdges('call'),
      renderEdges: countEdges('render'),
      inheritEdges: countEdges('inherit'),
      resolvedCalls,
      unresolvedCalls: totalCalls - resolvedCalls,
      skippedFiles: skipped,
      unlinkedFiles: failedFiles,
      truncated,
      mode: degradedAt >= 0 ? 'partial' : 'semantic',
      totalLoc: files.reduce((n, f) => n + nodes[f.id].loc, 0),
      downloadBytes: input.downloadBytes ?? 0,
      timings: { download: input.downloadMs ?? 0, parse: parseMs, resolve: resolveMs, total: Date.now() - t0 + (input.downloadMs ?? 0) },
    },
  };
  return graph;
}
