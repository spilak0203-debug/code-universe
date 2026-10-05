import { NodeFlag, type CodeGraph, type GraphNode } from '../graph/types';
import { KIND, type UniverseModel } from './model';
import { rgbToCss, type RGB } from './palette';

export const KIND_LABEL = ['dir', 'file', 'fn', 'class', 'method', 'pkg'] as const;
export const KIND_NOUN = ['Directory', 'File', 'Function', 'Class', 'Method', 'Package'] as const;
export const EDGE_LABEL = ['Contains', 'Imports', 'Calls', 'Renders', 'Inherits'] as const;

export function nodeColorCss(model: UniverseModel, id: number): string {
  const c = model.color;
  return rgbToCss([c[id * 3], c[id * 3 + 1], c[id * 3 + 2]] as RGB);
}

export function groupColorCss(model: UniverseModel, group: number): string {
  return group >= 0 ? rgbToCss(model.groupColors[group]) : 'rgb(200 210 240)';
}

export function githubUrl(graph: CodeGraph, node: GraphNode): string | null {
  const { owner, repo, sha, ref, subdir } = graph.repo;
  const rev = sha ?? ref;
  const base = `https://github.com/${owner}/${repo}`;
  if (node.kind === 'external') {
    return node.flags & NodeFlag.Builtin
      ? `https://nodejs.org/api/${node.name.replace(/^node:/, '').split('/')[0]}.html`
      : `https://www.npmjs.com/package/${node.name}`;
  }
  const path = [subdir, node.path].filter(Boolean).join('/');
  if (node.kind === 'dir') return `${base}/tree/${rev}/${path}`;
  const lines = node.kind === 'file' ? '' : node.endLine > node.line ? `#L${node.line}-L${node.endLine}` : `#L${node.line}`;
  return `${base}/blob/${rev}/${path}${lines}`;
}

export function repoUrl(graph: CodeGraph): string {
  const { owner, repo, sha, ref, subdir } = graph.repo;
  const base = `https://github.com/${owner}/${repo}`;
  return subdir ? `${base}/tree/${sha ?? ref}/${subdir}` : base;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function flagList(model: UniverseModel, id: number): { label: string; tone?: 'warn' | 'ok' }[] {
  const node = model.graph.nodes[id];
  const out: { label: string; tone?: 'warn' | 'ok' }[] = [];
  const f = node.flags;
  if (f & NodeFlag.Default) out.push({ label: 'default export', tone: 'ok' });
  else if (f & NodeFlag.Exported) out.push({ label: 'exported', tone: 'ok' });
  if (f & NodeFlag.Component) out.push({ label: 'React component' });
  if (f & NodeFlag.Hook) out.push({ label: 'hook' });
  if (f & NodeFlag.Async) out.push({ label: 'async' });
  if (f & NodeFlag.Static) out.push({ label: 'static' });
  if (f & NodeFlag.Builtin) out.push({ label: 'node builtin' });
  if (f & NodeFlag.InCycle) out.push({ label: 'in import cycle', tone: 'warn' });
  if (model.darkMatter[id]) out.push({ label: 'dark matter · unused?', tone: 'warn' });
  if (model.kind[id] === KIND.file && f & NodeFlag.Jsx) out.push({ label: 'JSX' });
  return out;
}

/** Short secondary text for list rows. */
export function nodeSubtitle(model: UniverseModel, id: number): string {
  const node = model.graph.nodes[id];
  switch (model.kind[id]) {
    case KIND.file:
    case KIND.dir:
      return '';
    case KIND.external:
      return node.flags & NodeFlag.Builtin ? 'node builtin' : 'npm package';
    default:
      return `${node.path}:${node.line}`;
  }
}
