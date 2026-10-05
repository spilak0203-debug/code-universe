import { NodeFlag, type CodeGraph, type EdgeKind, type NodeKind } from '../graph/types';
import { mulberry32, type SimInput } from '../layout/simulation';
import { BUILTIN_COLOR, EXTERNAL_COLOR, groupColor, mix, WHITE, type RGB } from './palette';

export const KIND_INDEX: Record<NodeKind, number> = { dir: 0, file: 1, function: 2, class: 3, method: 4, external: 5 };
export const EDGE_INDEX: Record<EdgeKind, number> = { contains: 0, import: 1, call: 2, render: 3, inherit: 4 };
export const KIND = { dir: 0, file: 1, function: 2, class: 3, method: 4, external: 5 } as const;

/** Floats per node in `orbit`: radius, phase, angular speed, u (xyz), v (xyz). */
const ORBIT_STRIDE = 9;
/** Kepler constant: ω = K / r^1.5, so an orbit at r = 3 takes ~20 s. */
const KEPLER = 1.6;

export interface UniverseModel {
  graph: CodeGraph;
  n: number;
  kind: Uint8Array;
  parent: Int32Array;
  group: Int16Array;
  /** Visual radius in world units. */
  size: Float32Array;
  color: Float32Array;
  groupColors: RGB[];

  /** Drawn edges (everything except symbol containment). */
  edgeCount: number;
  edgeSource: Uint32Array;
  edgeTarget: Uint32Array;
  edgeKind: Uint8Array;
  edgeWeight: Float32Array;
  edgeTypeOnly: Uint8Array;
  /**
   * Hierarchical bundling anchors. An edge is drawn as a cubic Bézier whose two
   * control points lean toward `edgeViaA` / `edgeViaB`: the ancestors of the
   * source / target directly below their lowest common ancestor directory (the
   * shared file for intra-file calls). -1 = straight line.
   */
  edgeViaA: Int32Array;
  edgeViaB: Int32Array;
  outEdges: number[][];
  inEdges: number[][];
  children: number[][];
  /** Weighted incoming call + render + inherit references. */
  fanIn: Uint32Array;
  fanOut: Uint32Array;
  darkMatter: Uint8Array;

  simCount: number;
  simIndex: Int32Array;
  simNodes: Int32Array;
  simInput: SimInput;

  orbitCenter: Int32Array;
  orbit: Float32Array;
  /** Outer radius of a node's orbital system (files: planets, classes: moons). */
  systemRadius: Float32Array;
  /** Orbiting nodes, parents before children. */
  orbitOrder: Int32Array;
  galaxyRadius: number;

  displayName: string[];
  searchText: string[];
}

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Orthonormal basis (u, v) of a plane whose normal is tilted `tilt` rad from +Y. */
function planeBasis(rand: () => number, maxTilt: number): [number, number, number, number, number, number] {
  const tilt = (rand() * 2 - 1) * maxTilt;
  const azimuth = rand() * Math.PI * 2;
  const nx = Math.sin(tilt) * Math.cos(azimuth);
  const ny = Math.cos(tilt);
  const nz = Math.sin(tilt) * Math.sin(azimuth);
  // u = normalize(cross(n, X)), fallback Z
  let ux = 0, uy = nz, uz = -ny;
  let len = Math.hypot(ux, uy, uz);
  if (len < 1e-4) {
    ux = ny;
    uy = -nx;
    uz = 0;
    len = Math.hypot(ux, uy, uz);
  }
  ux /= len;
  uy /= len;
  uz /= len;
  // v = cross(n, u)
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  return [ux, uy, uz, vx, vy, vz];
}

export function buildModel(graph: CodeGraph): UniverseModel {
  const nodes = graph.nodes;
  const n = nodes.length;
  const kind = new Uint8Array(n);
  const parent = new Int32Array(n);
  const group = new Int16Array(n);
  const children: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    kind[i] = KIND_INDEX[nodes[i].kind];
    parent[i] = nodes[i].parent;
    group[i] = nodes[i].group;
    if (nodes[i].parent >= 0) children[nodes[i].parent].push(i);
  }

  // ------------------------------------------------------------------ edges
  const drawn = graph.edges.filter((e) => e.kind !== 'contains');
  const edgeCount = drawn.length;
  const edgeSource = new Uint32Array(edgeCount);
  const edgeTarget = new Uint32Array(edgeCount);
  const edgeKind = new Uint8Array(edgeCount);
  const edgeWeight = new Float32Array(edgeCount);
  const edgeTypeOnly = new Uint8Array(edgeCount);
  const outEdges: number[][] = Array.from({ length: n }, () => []);
  const inEdges: number[][] = Array.from({ length: n }, () => []);
  const fanIn = new Uint32Array(n);
  const fanOut = new Uint32Array(n);
  drawn.forEach((e, i) => {
    edgeSource[i] = e.source;
    edgeTarget[i] = e.target;
    edgeKind[i] = EDGE_INDEX[e.kind];
    edgeWeight[i] = e.weight;
    edgeTypeOnly[i] = e.typeOnly ? 1 : 0;
    outEdges[e.source].push(i);
    inEdges[e.target].push(i);
    if (e.kind !== 'import') {
      fanIn[e.target] += e.weight;
      fanOut[e.source] += e.weight;
    }
  });

  const darkMatter = new Uint8Array(n);
  const used = NodeFlag.Exported | NodeFlag.Referenced | NodeFlag.Imported;
  for (let i = 0; i < n; i++) {
    if ((kind[i] === KIND.function || kind[i] === KIND.class) && !(nodes[i].flags & used) && fanIn[i] === 0) darkMatter[i] = 1;
  }

  // ---------------------------------------------------------- size & color
  const groupColors = graph.groups.map((_, i) => groupColor(i));
  const size = new Float32Array(n);
  const color = new Float32Array(n * 3);
  const subtreeFiles = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    if (kind[i] !== KIND.file) continue;
    for (let d = parent[i]; d >= 0; d = parent[d]) subtreeFiles[d]++;
  }
  const importers = new Uint32Array(n);
  for (let e = 0; e < edgeCount; e++) if (edgeKind[e] === EDGE_INDEX.import) importers[edgeTarget[e]]++;

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    const base = groupColor(node.group);
    let c: RGB = base;
    switch (kind[i]) {
      case KIND.dir:
        size[i] = parent[i] < 0 ? 26 : 5 + 3.2 * Math.sqrt(subtreeFiles[i]);
        c = parent[i] < 0 ? [1, 0.93, 0.8] : mix(base, WHITE, 0.15);
        break;
      case KIND.file:
        size[i] = 1.3 + 0.85 * Math.log2(1 + node.loc / 40);
        c = mix(base, WHITE, 0.18);
        break;
      case KIND.function:
        size[i] = 0.42 + 0.2 * Math.log2(1 + node.loc / 6);
        break;
      case KIND.class:
        size[i] = 0.7 + 0.24 * Math.log2(1 + node.loc / 10);
        c = mix(base, WHITE, 0.1);
        break;
      case KIND.method:
        size[i] = 0.22 + 0.1 * Math.log2(1 + node.loc / 6);
        c = mix(base, [0.75, 0.78, 0.85], 0.45);
        break;
      case KIND.external:
        size[i] = 1.1 + 0.45 * Math.log2(1 + importers[i]);
        c = node.flags & NodeFlag.Builtin ? BUILTIN_COLOR : EXTERNAL_COLOR;
        break;
    }
    color[i * 3] = c[0];
    color[i * 3 + 1] = c[1];
    color[i * 3 + 2] = c[2];
  }

  // ---------------------------------------------------------------- orbits
  const orbitCenter = new Int32Array(n).fill(-1);
  const orbit = new Float32Array(n * ORBIT_STRIDE);
  const systemRadius = new Float32Array(n);
  const orbitOrder: number[] = [];

  /** Pack bodies into concentric rings around a center of radius `inner`; returns the outer radius. */
  const packRings = (center: number, bodies: number[], slot: (id: number) => number, inner: number, maxTilt: number): number => {
    if (bodies.length === 0) return inner;
    const rand = mulberry32(hash(center));
    const basis = planeBasis(rand, maxTilt);
    const pad = 0.45;
    let prevOuter = inner + 0.8;
    let idx = 0;
    while (idx < bodies.length) {
      // Provisional radius from the first body; the ring may only grow once its biggest body is known.
      let radius = prevOuter + slot(bodies[idx]) + pad;
      const ring: number[] = [];
      let arc = 0;
      let maxSlot = 0;
      while (idx < bodies.length) {
        const s = slot(bodies[idx]);
        const need = 2 * s + pad;
        if (ring.length > 0 && arc + need > 2 * Math.PI * radius) break;
        ring.push(bodies[idx++]);
        arc += need;
        maxSlot = Math.max(maxSlot, s);
      }
      radius = prevOuter + maxSlot + pad;
      // Slight per-ring inclination so systems read as 3D.
      const incline = (rand() - 0.5) * 0.18;
      const [ux, uy, uz, vx0, vy0, vz0] = basis;
      const cosI = Math.cos(incline), sinI = Math.sin(incline);
      // Rotate v around u by the inclination: v' = v cos + (u × v) sin
      const nx = uy * vz0 - uz * vy0, ny = uz * vx0 - ux * vz0, nz = ux * vy0 - uy * vx0;
      const vx = vx0 * cosI + nx * sinI, vy = vy0 * cosI + ny * sinI, vz = vz0 * cosI + nz * sinI;
      const speed = KEPLER / Math.pow(Math.max(radius, 1), 1.5);
      const phase0 = rand() * Math.PI * 2;
      const total = Math.max(arc, 1e-6);
      let acc = 0;
      for (const id of ring) {
        const need = 2 * slot(id) + pad;
        const o = id * ORBIT_STRIDE;
        orbit[o] = radius;
        orbit[o + 1] = phase0 + ((acc + need / 2) / total) * Math.PI * 2;
        orbit[o + 2] = speed;
        orbit[o + 3] = ux;
        orbit[o + 4] = uy;
        orbit[o + 5] = uz;
        orbit[o + 6] = vx;
        orbit[o + 7] = vy;
        orbit[o + 8] = vz;
        orbitCenter[id] = center;
        acc += need;
      }
      prevOuter = radius + maxSlot;
    }
    return prevOuter;
  };

  // Moons (methods) around classes first, so class slot sizes include their moon systems.
  for (let i = 0; i < n; i++) {
    if (kind[i] !== KIND.class && kind[i] !== KIND.function) continue;
    const moons = children[i].filter((c) => kind[c] === KIND.method || kind[c] === KIND.function);
    systemRadius[i] = moons.length ? packRings(i, moons, (id) => size[id], size[i], 0.9) : size[i];
  }
  for (let i = 0; i < n; i++) {
    if (kind[i] !== KIND.file) continue;
    const planets = children[i]
      .filter((c) => kind[c] !== KIND.method)
      .sort((a, b) => systemRadius[a] - systemRadius[b] || nodes[a].line - nodes[b].line);
    systemRadius[i] = packRings(i, planets, (id) => systemRadius[id], size[i] * 1.6, 0.5);
  }
  // Parent-first order for per-frame position updates.
  const visit = (id: number) => {
    for (const c of children[id]) {
      if (orbitCenter[c] >= 0) orbitOrder.push(c);
      visit(c);
    }
  };
  for (let i = 0; i < n; i++) if (parent[i] < 0) visit(i);

  // ------------------------------------------------------------ simulation
  const simIndex = new Int32Array(n).fill(-1);
  const simList: number[] = [];
  for (let i = 0; i < n; i++) {
    if (kind[i] === KIND.dir || kind[i] === KIND.file || kind[i] === KIND.external) {
      simIndex[i] = simList.length;
      simList.push(i);
    }
  }
  const simCount = simList.length;
  const simNodes = Int32Array.from(simList);

  let area = 0;
  for (let i = 0; i < n; i++) if (kind[i] === KIND.file) area += (systemRadius[i] + 7) ** 2;
  const galaxyRadius = Math.max(60, Math.sqrt(2.2 * area));

  const charge = new Float32Array(simCount);
  const radius = new Float32Array(simCount);
  const ring = new Float32Array(simCount);
  for (let s = 0; s < simCount; s++) {
    const id = simNodes[s];
    if (kind[id] === KIND.file) {
      charge[s] = -(30 + 7 * systemRadius[id]);
      radius[s] = systemRadius[id] + 2.5;
    } else if (kind[id] === KIND.dir) {
      charge[s] = -(18 + 5 * Math.sqrt(subtreeFiles[id]));
      radius[s] = parent[id] < 0 ? 8 : 2;
    } else {
      charge[s] = -25;
      radius[s] = size[id] + 3;
      ring[s] = galaxyRadius * 1.3;
    }
  }

  // Links: directory tree + dependencies lifted to file level.
  const links = new Map<number, { s: number; t: number; w: number; tree: boolean }>();
  const addLink = (a: number, b: number, w: number, tree: boolean) => {
    const sa = simIndex[a], sb = simIndex[b];
    if (sa < 0 || sb < 0 || sa === sb) return;
    const lo = Math.min(sa, sb), hi = Math.max(sa, sb);
    const key = lo * simCount + hi;
    const link = links.get(key);
    if (link) {
      link.w += w;
      link.tree ||= tree;
    } else links.set(key, { s: sa, t: sb, w, tree });
  };
  const fileOf = (id: number): number => {
    while (id >= 0 && kind[id] !== KIND.file && kind[id] !== KIND.external) id = parent[id];
    return id;
  };
  for (let i = 0; i < n; i++) {
    if ((kind[i] === KIND.dir || kind[i] === KIND.file) && parent[i] >= 0) addLink(parent[i], i, 0, true);
  }
  for (let e = 0; e < edgeCount; e++) {
    const a = fileOf(edgeSource[e]);
    const b = fileOf(edgeTarget[e]);
    if (a < 0 || b < 0 || a === b) continue;
    const w = edgeKind[e] === EDGE_INDEX.import ? (edgeTypeOnly[e] ? 0.4 : 1) : Math.min(edgeWeight[e], 4) * 0.6;
    addLink(a, b, w, false);
  }
  const linkList = [...links.values()];
  const linkSource = new Uint32Array(linkList.length);
  const linkTarget = new Uint32Array(linkList.length);
  const linkDistance = new Float32Array(linkList.length);
  const linkStrength = new Float32Array(linkList.length);
  const simRadius = (s: number) => radius[s];
  linkList.forEach((l, i) => {
    linkSource[i] = l.s;
    linkTarget[i] = l.t;
    const a = simNodes[l.s], b = simNodes[l.t];
    const external = kind[a] === KIND.external || kind[b] === KIND.external;
    if (l.tree) {
      const childIsDir = kind[b] === KIND.dir;
      linkDistance[i] = simRadius(l.s) * 0.2 + simRadius(l.t) + (childIsDir ? 18 : 6);
      linkStrength[i] = childIsDir ? 0.5 : 0.7;
    } else if (external) {
      linkDistance[i] = galaxyRadius * 0.5;
      linkStrength[i] = 0.004 + 0.004 * Math.log2(1 + l.w);
    } else {
      linkDistance[i] = 22 + simRadius(l.s) + simRadius(l.t);
      linkStrength[i] = Math.min(0.22, 0.02 + 0.035 * Math.log2(1 + l.w));
    }
  });

  // Edge bundling anchors: route each edge through the LCA of its endpoints' files.
  const depth = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let p = parent[i]; p >= 0; p = parent[p]) d++;
    depth[i] = d;
  }
  const edgeViaA = new Int32Array(edgeCount).fill(-1);
  const edgeViaB = new Int32Array(edgeCount).fill(-1);
  for (let e = 0; e < edgeCount; e++) {
    const fa = fileOf(edgeSource[e]);
    const fb = fileOf(edgeTarget[e]);
    if (fa < 0 || fb < 0 || kind[fa] === KIND.external || kind[fb] === KIND.external) continue;
    if (fa === fb) {
      edgeViaA[e] = edgeViaB[e] = fa;
      continue;
    }
    // Climb both sides to equal depth, then together until the parents meet.
    let a = fa, b = fb;
    while (depth[a] > depth[b]) a = parent[a];
    while (depth[b] > depth[a]) b = parent[b];
    while (parent[a] !== parent[b] && parent[a] >= 0 && parent[b] >= 0) {
      a = parent[a];
      b = parent[b];
    }
    if (a === b) {
      // One file's directory chain contains the other's: lean on the shared directory.
      edgeViaA[e] = edgeViaB[e] = a;
      continue;
    }
    // a, b are siblings under the LCA; for a file directly under it, use its directory.
    const lca = parent[a];
    edgeViaA[e] = a === fa ? lca : a;
    edgeViaB[e] = b === fb ? lca : b;
  }

  // Initial positions: a radial tree on the disk, each file's wedge sized by its system.
  const init = new Float32Array(simCount * 3);
  const rand = mulberry32(0xc0de);
  const weightOf = new Float64Array(n);
  const sortedChildren = (id: number) =>
    children[id]
      .filter((c) => kind[c] === KIND.dir || kind[c] === KIND.file)
      .sort((a, b) => kind[a] - kind[b] || nodes[a].name.localeCompare(nodes[b].name));
  const weigh = (id: number): number => {
    let w = kind[id] === KIND.file ? systemRadius[id] + 4 : 0;
    for (const c of sortedChildren(id)) w += weigh(c);
    weightOf[id] = w;
    return w;
  };
  let maxDepth = 1;
  const depthOf = (id: number) => {
    let d = 0;
    for (let p = parent[id]; p >= 0; p = parent[p]) d++;
    return d;
  };
  for (let i = 0; i < n; i++) if (kind[i] === KIND.file) maxDepth = Math.max(maxDepth, depthOf(i));
  const step = (galaxyRadius * 0.55) / maxDepth;
  const angleOf = new Float64Array(n);
  const place = (id: number, from: number, to: number, depth: number) => {
    const mid = (from + to) / 2;
    angleOf[id] = mid;
    const s = simIndex[id];
    const r = depth * step;
    init[s * 3] = Math.cos(mid) * r;
    init[s * 3 + 1] = (rand() - 0.5) * step * 0.3;
    init[s * 3 + 2] = Math.sin(mid) * r;
    let cursor = from;
    const total = weightOf[id] || 1;
    for (const c of sortedChildren(id)) {
      const span = ((to - from) * weightOf[c]) / total;
      place(c, cursor, cursor + span, depth + 1);
      cursor += span;
    }
  };
  for (let i = 0; i < n; i++) {
    if (kind[i] === KIND.dir && parent[i] < 0) {
      weigh(i);
      place(i, 0, Math.PI * 2, 0);
    }
  }
  for (let s = 0; s < simCount; s++) {
    const id = simNodes[s];
    if (kind[id] !== KIND.external) continue;
    // Start externals near the angular mean of their importers.
    let cx = 0, cz = 0;
    for (const e of inEdges[id]) {
      const a = angleOf[fileOf(edgeSource[e])];
      cx += Math.cos(a);
      cz += Math.sin(a);
    }
    const a = cx || cz ? Math.atan2(cz, cx) : rand() * Math.PI * 2;
    init[s * 3] = Math.cos(a) * galaxyRadius * 1.3;
    init[s * 3 + 1] = (rand() - 0.5) * 20;
    init[s * 3 + 2] = Math.sin(a) * galaxyRadius * 1.3;
  }

  const simInput: SimInput = {
    count: simCount,
    charge,
    radius,
    ring,
    linkSource,
    linkTarget,
    linkDistance,
    linkStrength,
    init,
    flatten: 0.07,
  };

  // ----------------------------------------------------------- naming/search
  const displayName = nodes.map((node) => {
    if (node.kind === 'method' && node.parent >= 0) return `${nodes[node.parent].name}.${node.name}`;
    if (node.kind === 'dir') return node.path ? `${node.path}/` : `${node.name}/`;
    return node.kind === 'file' ? node.path : node.name;
  });
  const searchText = nodes.map((node, i) => `${displayName[i]} ${node.path}`.toLowerCase());

  return {
    graph,
    n,
    kind,
    parent,
    group,
    size,
    color,
    groupColors,
    edgeCount,
    edgeSource,
    edgeTarget,
    edgeKind,
    edgeWeight,
    edgeTypeOnly,
    edgeViaA,
    edgeViaB,
    outEdges,
    inEdges,
    children,
    fanIn,
    fanOut,
    darkMatter,
    simCount,
    simIndex,
    simNodes,
    simInput,
    orbitCenter,
    orbit,
    systemRadius,
    orbitOrder: Int32Array.from(orbitOrder),
    galaxyRadius,
    displayName,
    searchText,
  };
}

/**
 * Compose world positions: simulation bodies from the (smoothed) layout,
 * everything else from its orbit around its parent at time `t`.
 */
export function composePositions(model: UniverseModel, sim: Float32Array, out: Float32Array, t: number): void {
  const { simNodes, orbit, orbitCenter, orbitOrder } = model;
  for (let s = 0; s < simNodes.length; s++) {
    const id = simNodes[s] * 3;
    out[id] = sim[s * 3];
    out[id + 1] = sim[s * 3 + 1];
    out[id + 2] = sim[s * 3 + 2];
  }
  for (let k = 0; k < orbitOrder.length; k++) {
    const id = orbitOrder[k];
    const o = id * ORBIT_STRIDE;
    const c = orbitCenter[id] * 3;
    const a = orbit[o + 1] + orbit[o + 2] * t;
    const r = orbit[o];
    const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    out[id * 3] = out[c] + ca * orbit[o + 3] + sa * orbit[o + 6];
    out[id * 3 + 1] = out[c + 1] + ca * orbit[o + 4] + sa * orbit[o + 7];
    out[id * 3 + 2] = out[c + 2] + ca * orbit[o + 5] + sa * orbit[o + 8];
  }
}

export function searchNodes(model: UniverseModel, query: string, limit = 12): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: [number, number][] = [];
  const nodes = model.graph.nodes;
  for (let i = 0; i < model.n; i++) {
    const text = model.searchText[i];
    const at = text.indexOf(q);
    if (at < 0) continue;
    const name = nodes[i].name.toLowerCase();
    let score = name === q ? 0 : name.startsWith(q) ? 10 : name.includes(q) ? 20 : 40 + at * 0.01;
    if (model.kind[i] === KIND.dir) score += 6;
    if (model.kind[i] === KIND.method) score += 3;
    score -= Math.min(model.fanIn[i], 50) * 0.05;
    scored.push([score, i]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, limit).map(([, i]) => i);
}
