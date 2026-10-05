import { EDGE_INDEX, KIND, type UniverseModel } from './model';

export type PathKind = 'call' | 'import';

export interface PathResult {
  kind: PathKind;
  /** True when no path exists from → to, so this is the path to → from. */
  reversed: boolean;
  /** Bodies along the path, start to end (endpoints may be members of the picked nodes). */
  nodes: number[];
  /** Model edge indices between consecutive nodes. */
  edges: number[];
}

const CALL_KINDS = new Set<number>([EDGE_INDEX.call, EDGE_INDEX.render, EDGE_INDEX.inherit]);

/** A picked node plus everything it speaks for: a file's symbols, a class's methods, a directory's files. */
function expand(model: UniverseModel, id: number): number[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const c of model.children[out[i]]) out.push(c);
  }
  return out;
}

function fileOf(model: UniverseModel, id: number): number {
  let n = id;
  while (n >= 0 && model.kind[n] !== KIND.file && model.kind[n] !== KIND.external) n = model.parent[n];
  return n;
}

/** Multi-source BFS over the directed edges `accept` admits; fewest hops wins. */
function bfs(model: UniverseModel, sources: number[], targets: Set<number>, accept: (e: number) => boolean): { nodes: number[]; edges: number[] } | null {
  const viaEdge = new Int32Array(model.n).fill(-2); // -2 unvisited, -1 source
  const queue = new Int32Array(model.n);
  let head = 0, tail = 0;
  for (const s of sources) {
    if (viaEdge[s] !== -2) continue;
    viaEdge[s] = -1;
    queue[tail++] = s;
  }
  while (head < tail) {
    const v = queue[head++];
    if (targets.has(v)) {
      const nodes = [v];
      const edges: number[] = [];
      for (let cur = v; viaEdge[cur] >= 0; ) {
        const e = viaEdge[cur];
        edges.push(e);
        cur = model.edgeSource[e];
        nodes.push(cur);
      }
      return { nodes: nodes.reverse(), edges: edges.reverse() };
    }
    for (const e of model.outEdges[v]) {
      const w = model.edgeTarget[e];
      if (viaEdge[w] !== -2 || !accept(e)) continue;
      viaEdge[w] = e;
      queue[tail++] = w;
    }
  }
  return null;
}

function search(model: UniverseModel, from: number, to: number): Omit<PathResult, 'reversed'> | null {
  // 1. A call chain: calls / renders / extends between symbols (files start chains with module-level code).
  const targets = new Set(expand(model, to));
  const sources = expand(model, from).filter((s) => !targets.has(s));
  const call = bfs(model, sources, targets, (e) => CALL_KINDS.has(model.edgeKind[e]));
  if (call) return { kind: 'call', ...call };

  // 2. A dependency chain between the files involved.
  const fileTargets = new Set(expand(model, to).map((id) => fileOf(model, id)).filter((f) => f >= 0));
  const fileSources = [...new Set(expand(model, from).map((id) => fileOf(model, id)).filter((f) => f >= 0 && !fileTargets.has(f)))];
  const imp = bfs(model, fileSources, fileTargets, (e) => model.edgeKind[e] === EDGE_INDEX.import);
  return imp ? { kind: 'import', ...imp } : null;
}

/**
 * Shortest route from `from` to `to`: a call chain if one exists, else an import chain,
 * else the same searches in the opposite direction.
 */
export function findPath(model: UniverseModel, from: number, to: number): PathResult | null {
  if (from < 0 || to < 0 || from === to) return null;
  const forward = search(model, from, to);
  if (forward) return { ...forward, reversed: false };
  const backward = search(model, to, from);
  return backward ? { ...backward, reversed: true } : null;
}
