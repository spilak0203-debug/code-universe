import { EDGE_INDEX, KIND, type UniverseModel } from './model';
import type { Spotlight, ViewSettings } from '../store';

/** Per-edge opacity levels (multiplied by a per-kind base in the shader). */
export const EDGE_NORMAL = 0.28;
export const EDGE_EMPHASIS = 1;
export const EDGE_DIM = 0.025;
/** Per-node opacity levels. */
const NODE_DIM = 0.08;
const NODE_RELATED = 0.75;
/** Emphasis of edges that belong to the selection's members rather than the selection itself. */
const RELATED_EDGE = 0.35;

export interface EmphasisInput {
  selected: number;
  spotlight: Spotlight;
  hiddenGroups: ReadonlySet<number>;
  settings: ViewSettings;
}

export interface Emphasis {
  node: Float32Array;
  edge: Float32Array;
  /** Nodes considered "in focus" (for labels). */
  focusNodes: number[];
}

export function computeEmphasis(model: UniverseModel, input: EmphasisInput): Emphasis {
  const { n, kind, group, edgeCount, edgeSource, edgeTarget, edgeKind } = model;
  const { settings, hiddenGroups, selected, spotlight } = input;
  const node = new Float32Array(n);
  const edge = new Float32Array(edgeCount);

  // Base visibility from filters.
  for (let i = 0; i < n; i++) {
    let v = 1;
    if (kind[i] === KIND.method && !settings.showMethods) v = 0;
    else if (kind[i] === KIND.external && !settings.showExternals) v = 0;
    else if (kind[i] === KIND.dir && !settings.showNebulae) v = 0;
    else if (group[i] >= 0 && hiddenGroups.has(group[i])) v = 0;
    node[i] = v;
  }
  const edgeVisible = (e: number) =>
    settings.edgeKinds[edgeKind[e]] && node[edgeSource[e]] > 0 && node[edgeTarget[e]] > 0;

  // Selection or spotlight: build the set of nodes / edges in focus.
  const focus = new Map<number, number>(); // node → alpha
  /** Edge → relative emphasis (1 = the selection's own edge, less for its children's). */
  const focusEdges = new Map<number, number>();
  const lightEdge = (e: number, w = 1) => focusEdges.set(e, Math.max(focusEdges.get(e) ?? 0, w));

  if (selected >= 0) {
    focus.set(selected, 1);
    // Ancestors keep the context readable (file of a function, class of a method).
    for (let p = model.parent[selected]; p >= 0 && kind[p] !== KIND.dir; p = model.parent[p]) focus.set(p, NODE_RELATED);
    const sources = [selected];
    if (kind[selected] === KIND.file || kind[selected] === KIND.class || kind[selected] === KIND.dir) {
      // Aggregate the whole subtree: a file "talks" through its functions.
      const stack = [...model.children[selected]];
      while (stack.length) {
        const c = stack.pop()!;
        sources.push(c);
        if (!focus.has(c)) focus.set(c, NODE_RELATED);
        stack.push(...model.children[c]);
      }
    }
    for (const s of sources) {
      // The selection's own edges are full strength; its members' edges are context.
      const w = s === selected ? 1 : RELATED_EDGE;
      const nodeAlpha = s === selected ? 1 : 0.9;
      for (const e of model.outEdges[s]) {
        if (!edgeVisible(e)) continue;
        lightEdge(e, w);
        if (!focus.has(edgeTarget[e])) focus.set(edgeTarget[e], nodeAlpha);
      }
      for (const e of model.inEdges[s]) {
        if (!edgeVisible(e)) continue;
        lightEdge(e, w);
        if (!focus.has(edgeSource[e])) focus.set(edgeSource[e], nodeAlpha);
      }
    }
    // Neighbours' files stay faintly lit so you can see where they live.
    for (const id of [...focus.keys()]) {
      const p = model.parent[id];
      if (p >= 0 && kind[p] === KIND.file && !focus.has(p)) focus.set(p, 0.45);
    }
  } else if (spotlight.type === 'cycle') {
    const members = new Set(model.graph.cycles[spotlight.index] ?? []);
    for (const id of members) focus.set(id, 1);
    for (let e = 0; e < edgeCount; e++) {
      if (edgeKind[e] === EDGE_INDEX.import && !model.edgeTypeOnly[e] && members.has(edgeSource[e]) && members.has(edgeTarget[e])) {
        lightEdge(e);
      }
    }
  } else if (spotlight.type === 'darkMatter') {
    for (let i = 0; i < n; i++) {
      if (!model.darkMatter[i]) continue;
      focus.set(i, 1);
      const p = model.parent[i];
      if (p >= 0 && !focus.has(p)) focus.set(p, 0.4);
    }
  } else if (spotlight.type === 'path') {
    focus.set(spotlight.from, 1);
    focus.set(spotlight.to, 1);
    for (const id of spotlight.path?.nodes ?? []) focus.set(id, 1);
    for (const e of spotlight.path?.edges ?? []) lightEdge(e);
    // Keep the files the route passes through faintly visible for context.
    for (const id of [...focus.keys()]) {
      const p = model.parent[id];
      if (p >= 0 && kind[p] === KIND.file && !focus.has(p)) focus.set(p, 0.4);
    }
  } else if (spotlight.type === 'group') {
    for (let i = 0; i < n; i++) if (group[i] === spotlight.group) focus.set(i, 1);
    for (let e = 0; e < edgeCount; e++) {
      if (group[edgeSource[e]] === spotlight.group || group[edgeTarget[e]] === spotlight.group) lightEdge(e);
    }
  }

  const focusing = selected >= 0 || spotlight.type !== 'none';
  if (focusing) {
    for (let i = 0; i < n; i++) {
      if (node[i] === 0) continue;
      node[i] = focus.get(i) ?? (kind[i] === KIND.dir ? NODE_DIM * 0.5 : NODE_DIM);
    }
    // Spotlight members stay visible even if their group was hidden.
    for (const [id, a] of focus) if (node[id] === 0 && spotlight.type !== 'none') node[id] = a;
  }

  // Additive blending saturates fast: the more edges on screen, the fainter each one.
  let visibleEdges = 0;
  for (let e = 0; e < edgeCount; e++) if (edgeVisible(e)) visibleEdges++;
  const normal = EDGE_NORMAL * Math.min(1, Math.max(0.08, Math.sqrt(350 / Math.max(visibleEdges, 1))));
  const dim = Math.min(EDGE_DIM, normal * 0.15);
  let lit = 0;
  for (const w of focusEdges.values()) lit += w;
  const emphasized = lit > 150 ? EDGE_EMPHASIS * Math.max(0.14, Math.sqrt(150 / lit)) : EDGE_EMPHASIS;
  for (let e = 0; e < edgeCount; e++) {
    const w = focusEdges.get(e);
    if (!edgeVisible(e)) {
      // Cycle and route edges stay visible even when their kind is filtered out.
      edge[e] = w !== undefined && (spotlight.type === 'cycle' || spotlight.type === 'path') ? EDGE_EMPHASIS : 0;
      continue;
    }
    edge[e] = !focusing ? normal : w !== undefined ? Math.max(emphasized * w, normal) : dim;
  }

  const focusNodes = [...focus.entries()]
    .filter(([id, a]) => a >= 0.7 && kind[id] !== KIND.dir)
    .sort((a, b) => b[1] - a[1] || model.fanIn[b[0]] - model.fanIn[a[0]])
    .map(([id]) => id);
  return { node, edge, focusNodes };
}
