import { Octree } from './octree';

/**
 * 3D force-directed layout (velocity Verlet, d3-force semantics) tuned for a
 * "galaxy": a directory tree of star systems pulled together by their
 * dependencies, flattened into a disk, with external packages on an outer ring.
 *
 * Forces per tick:
 *   - springs on links (tree + dependency), degree-biased like d3.forceLink
 *   - many-body repulsion via Barnes–Hut (θ) on the octree
 *   - collisions between star systems (octree pruned by max radius)
 *   - weak central gravity, disk flattening toward y = 0, recentering
 *   - an outer ring for external packages that tracks the galaxy's live extent
 */

export interface SimInput {
  count: number;
  /** Negative = repulsive (d3 convention). */
  charge: Float32Array;
  /** Collision radius. */
  radius: Float32Array;
  /** Minimum ring radius for bodies that live on the outer ring (externals); 0 = free body. */
  ring: Float32Array;
  linkSource: Uint32Array;
  linkTarget: Uint32Array;
  linkDistance: Float32Array;
  linkStrength: Float32Array;
  /** Initial positions, xyz interleaved. */
  init: Float32Array;
  /** Pull toward the y = 0 plane. */
  flatten: number;
}

export interface SimParams {
  theta: number;
  velocityDecay: number;
  alphaMin: number;
  alphaDecay: number;
  collideStrength: number;
  ringStrength: number;
  /** Spring toward the origin; keeps huge monorepos from drifting apart under long-range repulsion. */
  gravity: number;
  /** Outer ring radius as a multiple of the free bodies' 90th-percentile radius. */
  ringMargin: number;
}

export const DEFAULT_PARAMS: SimParams = {
  theta: 0.85,
  velocityDecay: 0.42,
  alphaMin: 0.002,
  alphaDecay: 1 - Math.pow(0.002, 1 / 320),
  collideStrength: 0.75,
  ringStrength: 0.08,
  gravity: 0.02,
  ringMargin: 1.18,
};

export class ForceSimulation {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** Pinned bodies (NaN = free). */
  readonly fx: Float64Array;
  readonly fy: Float64Array;
  readonly fz: Float64Array;
  alpha = 1;
  alphaTarget = 0;
  private readonly charge: Float64Array;
  private readonly radius: Float64Array;
  private readonly bias: Float64Array;
  private readonly tree = new Octree();
  private rng = mulberry32(0x5eed);
  private ticks = 0;
  /** Live 90th-percentile planar radius of free bodies (refreshed every few ticks). */
  private extent = 0;
  private readonly freeBodies: Int32Array;

  constructor(private readonly input: SimInput, readonly params: SimParams = DEFAULT_PARAMS) {
    const n = (this.n = input.count);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.fx = new Float64Array(n).fill(NaN);
    this.fy = new Float64Array(n).fill(NaN);
    this.fz = new Float64Array(n).fill(NaN);
    this.charge = Float64Array.from(input.charge);
    this.radius = Float64Array.from(input.radius);
    for (let i = 0; i < n; i++) {
      this.x[i] = input.init[i * 3];
      this.y[i] = input.init[i * 3 + 1];
      this.z[i] = input.init[i * 3 + 2];
    }
    // d3.forceLink bias: the endpoint with more links moves less.
    const degree = new Uint32Array(n);
    for (let l = 0; l < input.linkSource.length; l++) {
      degree[input.linkSource[l]]++;
      degree[input.linkTarget[l]]++;
    }
    const free: number[] = [];
    for (let i = 0; i < n; i++) if (!(input.ring[i] > 0)) free.push(i);
    this.freeBodies = Int32Array.from(free);
    this.bias = new Float64Array(input.linkSource.length);
    for (let l = 0; l < input.linkSource.length; l++) {
      const s = degree[input.linkSource[l]];
      this.bias[l] = s / (s + degree[input.linkTarget[l]]);
    }
  }

  get done(): boolean {
    return this.alpha < this.params.alphaMin && this.alphaTarget < this.params.alphaMin;
  }

  reheat(alpha = 0.6): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick(): void {
    const p = this.params;
    this.alpha += (this.alphaTarget - this.alpha) * p.alphaDecay;
    const alpha = this.alpha;

    this.applyLinks(alpha);
    this.tree.build(this.x, this.y, this.z, this.charge, this.radius, this.n);
    this.applyManyBody(alpha);
    this.applyCollisions();
    this.applyShape(alpha);

    const decay = 1 - p.velocityDecay;
    for (let i = 0; i < this.n; i++) {
      if (Number.isNaN(this.fx[i])) {
        this.vx[i] *= decay;
        this.vy[i] *= decay;
        this.vz[i] *= decay;
        this.x[i] += this.vx[i];
        this.y[i] += this.vy[i];
        this.z[i] += this.vz[i];
      } else {
        this.x[i] = this.fx[i];
        this.y[i] = this.fy[i];
        this.z[i] = this.fz[i];
        this.vx[i] = this.vy[i] = this.vz[i] = 0;
      }
    }
    this.recenter();
  }

  writePositions(out: Float32Array): void {
    for (let i = 0; i < this.n; i++) {
      out[i * 3] = this.x[i];
      out[i * 3 + 1] = this.y[i];
      out[i * 3 + 2] = this.z[i];
    }
  }

  private jitter(): number {
    return (this.rng() - 0.5) * 1e-6;
  }

  private applyLinks(alpha: number): void {
    const { linkSource, linkTarget, linkDistance, linkStrength } = this.input;
    const { x, y, z, vx, vy, vz } = this;
    for (let l = 0; l < linkSource.length; l++) {
      const s = linkSource[l];
      const t = linkTarget[l];
      let dx = x[t] + vx[t] - x[s] - vx[s] || this.jitter();
      let dy = y[t] + vy[t] - y[s] - vy[s] || this.jitter();
      let dz = z[t] + vz[t] - z[s] - vz[s] || this.jitter();
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const k = ((len - linkDistance[l]) / len) * alpha * linkStrength[l];
      dx *= k;
      dy *= k;
      dz *= k;
      const b = this.bias[l];
      vx[t] -= dx * b;
      vy[t] -= dy * b;
      vz[t] -= dz * b;
      vx[s] += dx * (1 - b);
      vy[s] += dy * (1 - b);
      vz[s] += dz * (1 - b);
    }
  }

  private applyManyBody(alpha: number): void {
    const tree = this.tree;
    const theta2 = this.params.theta * this.params.theta;
    const distMin2 = 1;
    const stack = new Int32Array(tree.cellCount + 8);
    for (let i = 0; i < this.n; i++) {
      const xi = this.x[i], yi = this.y[i], zi = this.z[i];
      let ax = 0, ay = 0, az = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp > 0) {
        const c = stack[--sp];
        if (tree.weight[c] === 0) continue;
        let dx = tree.mx[c] - xi;
        let dy = tree.my[c] - yi;
        let dz = tree.mz[c] - zi;
        let l = dx * dx + dy * dy + dz * dz;
        const width = tree.half[c] * 2;
        if ((width * width) / theta2 < l) {
          // Far enough: the whole cell acts as one body.
          if (l < distMin2) l = Math.sqrt(distMin2 * l);
          const f = (tree.charge[c] * alpha) / l;
          ax += dx * f;
          ay += dy * f;
          az += dz * f;
          continue;
        }
        for (let b = tree.firstBody[c]; b !== -1; b = tree.nextBody[b]) {
          if (b === i) continue;
          dx = this.x[b] - xi || this.jitter();
          dy = this.y[b] - yi || this.jitter();
          dz = this.z[b] - zi || this.jitter();
          l = dx * dx + dy * dy + dz * dz;
          if (l < distMin2) l = Math.sqrt(distMin2 * l);
          const f = (this.charge[b] * alpha) / l;
          ax += dx * f;
          ay += dy * f;
          az += dz * f;
        }
        const base = c * 8;
        for (let k = 0; k < 8; k++) {
          const child = tree.children[base + k];
          if (child !== -1) stack[sp++] = child;
        }
      }
      this.vx[i] += ax;
      this.vy[i] += ay;
      this.vz[i] += az;
    }
  }

  private applyCollisions(): void {
    const tree = this.tree;
    const strength = this.params.collideStrength;
    const stack = new Int32Array(tree.cellCount + 8);
    const { x, y, z, vx, vy, vz, radius } = this;
    for (let i = 0; i < this.n; i++) {
      const ri = radius[i];
      if (ri <= 0) continue;
      const xi = x[i] + vx[i], yi = y[i] + vy[i], zi = z[i] + vz[i];
      let sp = 0;
      stack[sp++] = 0;
      while (sp > 0) {
        const c = stack[--sp];
        // Prune cells whose box, grown by the largest possible overlap, misses body i.
        const reach = tree.half[c] + ri + tree.maxRadius[c];
        if (Math.abs(tree.cx[c] - xi) > reach || Math.abs(tree.cy[c] - yi) > reach || Math.abs(tree.cz[c] - zi) > reach) continue;
        for (let j = tree.firstBody[c]; j !== -1; j = tree.nextBody[j]) {
          if (j <= i) continue; // each pair once
          const rj = radius[j];
          const r = ri + rj;
          let dx = xi - x[j] - vx[j];
          let dy = yi - y[j] - vy[j];
          let dz = zi - z[j] - vz[j];
          let l = dx * dx + dy * dy + dz * dz;
          if (l >= r * r) continue;
          if (l === 0) {
            dx = this.jitter();
            dy = this.jitter();
            dz = this.jitter();
            l = dx * dx + dy * dy + dz * dz;
          }
          l = Math.sqrt(l);
          const k = ((r - l) / l) * strength;
          dx *= k;
          dy *= k;
          dz *= k;
          const ri2 = ri * ri, rj2 = rj * rj;
          const wi = rj2 / (ri2 + rj2);
          vx[i] += dx * wi;
          vy[i] += dy * wi;
          vz[i] += dz * wi;
          vx[j] -= dx * (1 - wi);
          vy[j] -= dy * (1 - wi);
          vz[j] -= dz * (1 - wi);
        }
        const base = c * 8;
        for (let k = 0; k < 8; k++) {
          const child = tree.children[base + k];
          if (child !== -1) stack[sp++] = child;
        }
      }
    }
  }

  /** Galaxy extent the outer ring follows (90th percentile of free bodies' planar radius). */
  get liveExtent(): number {
    return this.extent;
  }

  private measureExtent(): void {
    const free = this.freeBodies;
    if (free.length === 0) return;
    // A strided sample is plenty for a percentile and keeps this O(256 log 256).
    const step = Math.max(1, Math.floor(free.length / 256));
    const sample: number[] = [];
    for (let k = 0; k < free.length; k += step) sample.push(Math.hypot(this.x[free[k]], this.z[free[k]]));
    sample.sort((a, b) => a - b);
    this.extent = sample[Math.floor((sample.length - 1) * 0.9)];
  }

  private applyShape(alpha: number): void {
    const { ring, flatten } = this.input;
    const { ringStrength, gravity, ringMargin } = this.params;
    if (this.ticks++ % 8 === 0) this.measureExtent();
    const outer = this.extent * ringMargin;
    for (let i = 0; i < this.n; i++) {
      this.vy[i] -= this.y[i] * flatten * alpha;
      const minRing = ring[i];
      if (!(minRing > 0)) {
        this.vx[i] -= this.x[i] * gravity * alpha;
        this.vy[i] -= this.y[i] * gravity * alpha;
        this.vz[i] -= this.z[i] * gravity * alpha;
        continue;
      }
      const target = Math.max(minRing, outer);
      const d = Math.hypot(this.x[i], this.y[i], this.z[i]) || 1;
      const k = ((target - d) / d) * ringStrength * alpha;
      this.vx[i] += this.x[i] * k;
      this.vy[i] += this.y[i] * k;
      this.vz[i] += this.z[i] * k;
    }
  }

  private recenter(): void {
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < this.n; i++) {
      sx += this.x[i];
      sy += this.y[i];
      sz += this.z[i];
    }
    sx /= this.n;
    sy /= this.n;
    sz /= this.n;
    for (let i = 0; i < this.n; i++) {
      this.x[i] -= sx;
      this.y[i] -= sy;
      this.z[i] -= sz;
    }
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
