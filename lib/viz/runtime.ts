import type { Camera } from 'three';
import { composePositions, type UniverseModel } from './model';
import type { Emphasis } from './emphasis';

/**
 * Mutable per-frame state shared by the scene components and DOM overlays.
 * Lives outside React so 60 fps updates never trigger re-renders.
 */
export class UniverseRuntime {
  readonly model: UniverseModel;
  /** Latest positions from the layout worker (sim bodies only). */
  private simTarget: Float32Array;
  /** Smoothed sim positions actually rendered. */
  private simCurrent: Float32Array;
  /** World positions of every node, recomposed each frame. */
  readonly positions: Float32Array;
  readonly nodeAlpha: Float32Array;
  readonly edgeAlpha: Float32Array;
  private nodeAlphaTarget: Float32Array;
  private edgeAlphaTarget: Float32Array;
  /** Bumped whenever alpha buffers change; consumers re-upload when it moves. */
  alphaVersion = 1;
  private alphaSettling = false;
  orbitTime = 0;
  /** Measured 90th-percentile planar radius of the file stars (the galaxy's visible size). */
  extent: number;
  private readonly extentSample: Int32Array;
  /** Seconds since the layout produced its first frame (drives the intro). */
  age = 0;
  layoutStarted = false;

  camera: Camera | null = null;
  viewport = { width: 1, height: 1 };
  pointer = { x: 0, y: 0, inside: false };
  /** DOM overlays register here; called after the scene updates each frame. */
  readonly frameListeners = new Set<() => void>();

  constructor(model: UniverseModel) {
    this.model = model;
    this.simTarget = Float32Array.from(model.simInput.init);
    this.simCurrent = Float32Array.from(model.simInput.init);
    this.positions = new Float32Array(model.n * 3);
    this.nodeAlpha = new Float32Array(model.n).fill(1);
    this.nodeAlphaTarget = new Float32Array(model.n).fill(1);
    this.edgeAlpha = new Float32Array(model.edgeCount);
    this.edgeAlphaTarget = new Float32Array(model.edgeCount);
    composePositions(model, this.simCurrent, this.positions, 0);
    // Up to 256 evenly strided file bodies are enough to track the galaxy's extent.
    const files: number[] = [];
    for (let s = 0; s < model.simCount; s++) if (model.kind[model.simNodes[s]] === 1) files.push(s);
    const step = Math.max(1, Math.floor(files.length / 256));
    this.extentSample = Int32Array.from(files.filter((_, i) => i % step === 0));
    this.extent = model.galaxyRadius;
  }

  private measureExtent(sim: Float32Array): number {
    const r: number[] = [];
    for (const s of this.extentSample) r.push(Math.hypot(sim[s * 3], sim[s * 3 + 2]));
    if (r.length === 0) return this.model.galaxyRadius;
    r.sort((a, b) => a - b);
    return Math.max(30, r[Math.floor((r.length - 1) * 0.9)]);
  }

  setLayout(positions: Float32Array): void {
    this.simTarget = positions;
    this.layoutStarted = true;
    this.extent = this.measureExtent(positions);
  }

  setEmphasis(emphasis: Emphasis): void {
    this.nodeAlphaTarget = emphasis.node;
    this.edgeAlphaTarget = emphasis.edge;
    this.alphaSettling = true;
  }

  step(dt: number, orbits: boolean, orbitSpeed = 1): void {
    const k = 1 - Math.exp(-dt * 6);
    const cur = this.simCurrent;
    const tgt = this.simTarget;
    for (let i = 0; i < cur.length; i++) cur[i] += (tgt[i] - cur[i]) * k;
    if (orbits) this.orbitTime += dt * orbitSpeed;
    if (this.layoutStarted) this.age += dt;
    composePositions(this.model, cur, this.positions, this.orbitTime);

    if (this.alphaSettling) {
      const a = 1 - Math.exp(-dt * 9);
      let moving = false;
      moving = lerpInto(this.nodeAlpha, this.nodeAlphaTarget, a) || moving;
      moving = lerpInto(this.edgeAlpha, this.edgeAlphaTarget, a) || moving;
      this.alphaSettling = moving;
      this.alphaVersion++;
    }
  }

  /**
   * Where a body is heading: the layout's latest target for its star (or itself, if
   * simulated) plus its current orbital offset. Unlike `position`, this doesn't lag
   * behind smoothing — or stall when frames aren't being rendered.
   */
  settledPosition(id: number, out: { x: number; y: number; z: number }): typeof out {
    const { simIndex, orbitCenter } = this.model;
    let anchor = id;
    while (anchor >= 0 && simIndex[anchor] < 0) anchor = orbitCenter[anchor];
    if (anchor < 0) return this.position(id, out);
    const s = simIndex[anchor];
    const p = this.positions;
    out.x = this.simTarget[s * 3] + p[id * 3] - p[anchor * 3];
    out.y = this.simTarget[s * 3 + 1] + p[id * 3 + 1] - p[anchor * 3 + 1];
    out.z = this.simTarget[s * 3 + 2] + p[id * 3 + 2] - p[anchor * 3 + 2];
    return out;
  }

  position(id: number, out: { x: number; y: number; z: number }): typeof out {
    out.x = this.positions[id * 3];
    out.y = this.positions[id * 3 + 1];
    out.z = this.positions[id * 3 + 2];
    return out;
  }
}

function lerpInto(cur: Float32Array, target: Float32Array, k: number): boolean {
  let moving = false;
  for (let i = 0; i < cur.length; i++) {
    const d = target[i] - cur[i];
    if (d > 0.002 || d < -0.002) {
      cur[i] += d * k;
      moving = true;
    } else {
      cur[i] = target[i];
    }
  }
  return moving;
}
