import type { UniverseModel } from './model';

/** How strongly control points lean toward their bundling anchors (0 = straight lines). */
export const BUNDLE = 0.8;

/**
 * Control polygon of edge `e` as drawn: a cubic Bézier from source to target whose
 * inner control points are the straight-line thirds pulled toward the edge's
 * hierarchical bundling anchors (see `edgeViaA` / `edgeViaB` in the model).
 * Writes xyz triples at offset `o` of `start`, `c1`, `c2` and `end`.
 */
export function edgeCurve(
  model: UniverseModel,
  p: Float32Array,
  e: number,
  bundle: number,
  start: Float32Array,
  c1: Float32Array,
  c2: Float32Array,
  end: Float32Array,
  o: number,
): void {
  const s = model.edgeSource[e] * 3;
  const t = model.edgeTarget[e] * 3;
  const sx = p[s], sy = p[s + 1], sz = p[s + 2];
  const tx = p[t], ty = p[t + 1], tz = p[t + 2];
  start[o] = sx;
  start[o + 1] = sy;
  start[o + 2] = sz;
  end[o] = tx;
  end[o + 1] = ty;
  end[o + 2] = tz;
  let ax = sx + (tx - sx) / 3, ay = sy + (ty - sy) / 3, az = sz + (tz - sz) / 3;
  let bx = sx + ((tx - sx) * 2) / 3, by = sy + ((ty - sy) * 2) / 3, bz = sz + ((tz - sz) * 2) / 3;
  const va = model.edgeViaA[e];
  if (va >= 0 && bundle > 0) {
    const vA = va * 3;
    const vB = model.edgeViaB[e] * 3;
    ax += (p[vA] - ax) * bundle;
    ay += (p[vA + 1] - ay) * bundle;
    az += (p[vA + 2] - az) * bundle;
    bx += (p[vB] - bx) * bundle;
    by += (p[vB + 1] - by) * bundle;
    bz += (p[vB + 2] - bz) * bundle;
  }
  c1[o] = ax;
  c1[o + 1] = ay;
  c1[o + 2] = az;
  c2[o] = bx;
  c2[o + 1] = by;
  c2[o + 2] = bz;
}

/** Evaluate the cubic Bézier stored at offset `o` (same layout as `edgeCurve`) at parameter `t`. */
export function bezierAt(
  start: Float32Array,
  c1: Float32Array,
  c2: Float32Array,
  end: Float32Array,
  o: number,
  t: number,
  out: Float32Array,
  outOffset: number,
): void {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  for (let k = 0; k < 3; k++) {
    out[outOffset + k] = a * start[o + k] + b * c1[o + k] + c * c2[o + k] + d * end[o + k];
  }
}
