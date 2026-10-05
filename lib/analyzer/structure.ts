import type { Group } from '../graph/types';

export interface Grouping {
  groups: Group[];
  /** rel file path → group index */
  groupOf: Map<string, number>;
}

/**
 * Assign every file to a "galactic arm": a workspace package in monorepos,
 * otherwise a top-level directory below the effective source root (we descend
 * through wrapper dirs like `src/` that hold nearly everything).
 */
export function computeGroups(files: readonly string[], workspaces: readonly { name: string; dir: string }[]): Grouping {
  const keyOf = new Map<string, string>();
  const packages = workspaces.filter((w) => w.dir !== '').sort((a, b) => b.dir.length - a.dir.length);

  if (packages.length >= 2) {
    for (const file of files) {
      const pkg = packages.find((p) => file.startsWith(`${p.dir}/`));
      keyOf.set(file, pkg ? pkg.name : topSegment(file, ''));
    }
  } else {
    const root = effectiveRoot(files);
    for (const file of files) keyOf.set(file, topSegment(file, root));
  }

  const counts = new Map<string, number>();
  for (const key of keyOf.values()) counts.set(key, (counts.get(key) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const indexOf = new Map(ordered.map(([key], i) => [key, i]));
  const groupOf = new Map<string, number>();
  for (const [file, key] of keyOf) groupOf.set(file, indexOf.get(key)!);
  return { groups: ordered.map(([name, files]) => ({ name, files })), groupOf };
}

function effectiveRoot(files: readonly string[]): string {
  let root = '';
  for (let depth = 0; depth < 4; depth++) {
    const prefix = root ? `${root}/` : '';
    const inside = files.filter((f) => f.startsWith(prefix));
    const byChild = new Map<string, number>();
    for (const f of inside) {
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash > 0) byChild.set(rest.slice(0, slash), (byChild.get(rest.slice(0, slash)) ?? 0) + 1);
    }
    const [best, count] = [...byChild.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (!best || count < inside.length * 0.7 || byChild.size === 0) break;
    // Descending only helps if the child itself has structure worth splitting.
    const childFiles = inside.filter((f) => f.startsWith(`${prefix}${best}/`));
    const hasSubdirs = childFiles.some((f) => f.slice(prefix.length + best.length + 1).includes('/'));
    if (!hasSubdirs) break;
    root = prefix + best;
  }
  return root;
}

function topSegment(file: string, root: string): string {
  const rest = root ? file.slice(root.length + 1) : file;
  const slash = rest.indexOf('/');
  if (slash < 0) return root ? `${root} (top level)` : '(top level)';
  return root ? `${root}/${rest.slice(0, slash)}` : rest.slice(0, slash);
}
