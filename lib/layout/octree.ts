/**
 * Barnes–Hut octree over struct-of-arrays bodies.
 *
 * Cells live in flat typed arrays (no per-tick object allocation). Each cell
 * aggregates the |charge|-weighted centre of its bodies, the summed charge and
 * the largest body radius below it (used to prune collision queries).
 */

const MAX_DEPTH = 24;

export class Octree {
  // per cell
  cx = new Float64Array(0);
  cy = new Float64Array(0);
  cz = new Float64Array(0);
  half = new Float64Array(0);
  /** Summed charge. */
  charge = new Float64Array(0);
  /** Sum of |charge| (weights for the centre of charge). */
  weight = new Float64Array(0);
  /** Centre of charge (accumulated as weighted sums, normalised in `finish`). */
  mx = new Float64Array(0);
  my = new Float64Array(0);
  mz = new Float64Array(0);
  maxRadius = new Float64Array(0);
  /** 8 child cell indices per cell, -1 = empty. */
  children = new Int32Array(0);
  /** Leaf: first body index (-1 for internal cells / empty). */
  firstBody = new Int32Array(0);
  depth = new Uint8Array(0);
  cellCount = 0;

  /** Per body: next body in the same leaf (coincident / max-depth chains). */
  nextBody = new Int32Array(0);

  private x!: Float64Array;
  private y!: Float64Array;
  private z!: Float64Array;

  build(x: Float64Array, y: Float64Array, z: Float64Array, charge: Float64Array, radius: Float64Array, n: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.ensureCapacity(Math.max(16, n * 3));
    if (this.nextBody.length < n) this.nextBody = new Int32Array(n);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i];
      if (y[i] < minY) minY = y[i];
      if (z[i] < minZ) minZ = z[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] > maxY) maxY = y[i];
      if (z[i] > maxZ) maxZ = z[i];
    }
    const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) * 0.5 + 1;
    this.cellCount = 0;
    this.newCell((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, size, 0);

    for (let i = 0; i < n; i++) this.insert(i);
    this.accumulate(0, charge, radius);
  }

  private ensureCapacity(cells: number): void {
    if (this.cx.length >= cells) return;
    const cap = Math.ceil(cells * 1.5);
    const grow = <T extends Float64Array | Int32Array | Uint8Array>(old: T, size: number, ctor: new (n: number) => T): T => {
      const next = new ctor(size);
      next.set(old.subarray(0, Math.min(old.length, size)) as never);
      return next;
    };
    this.cx = grow(this.cx, cap, Float64Array);
    this.cy = grow(this.cy, cap, Float64Array);
    this.cz = grow(this.cz, cap, Float64Array);
    this.half = grow(this.half, cap, Float64Array);
    this.charge = grow(this.charge, cap, Float64Array);
    this.weight = grow(this.weight, cap, Float64Array);
    this.mx = grow(this.mx, cap, Float64Array);
    this.my = grow(this.my, cap, Float64Array);
    this.mz = grow(this.mz, cap, Float64Array);
    this.maxRadius = grow(this.maxRadius, cap, Float64Array);
    this.children = grow(this.children, cap * 8, Int32Array);
    this.firstBody = grow(this.firstBody, cap, Int32Array);
    this.depth = grow(this.depth, cap, Uint8Array);
  }

  private newCell(cx: number, cy: number, cz: number, half: number, depth: number): number {
    if (this.cellCount >= this.cx.length) this.ensureCapacity(this.cellCount + 1);
    const c = this.cellCount++;
    this.cx[c] = cx;
    this.cy[c] = cy;
    this.cz[c] = cz;
    this.half[c] = half;
    this.depth[c] = depth;
    this.firstBody[c] = -1;
    this.children.fill(-1, c * 8, c * 8 + 8);
    return c;
  }

  private octant(c: number, i: number): number {
    return (this.x[i] >= this.cx[c] ? 1 : 0) | (this.y[i] >= this.cy[c] ? 2 : 0) | (this.z[i] >= this.cz[c] ? 4 : 0);
  }

  private isLeaf(c: number): boolean {
    const base = c * 8;
    for (let k = 0; k < 8; k++) if (this.children[base + k] !== -1) return false;
    return true;
  }

  private insert(i: number): void {
    this.nextBody[i] = -1;
    let c = 0;
    while (true) {
      if (this.isLeaf(c)) {
        const occupant = this.firstBody[c];
        if (occupant === -1) {
          this.firstBody[c] = i;
          return;
        }
        // Same position or too deep: chain it into this leaf.
        if (
          this.depth[c] >= MAX_DEPTH ||
          (this.x[occupant] === this.x[i] && this.y[occupant] === this.y[i] && this.z[occupant] === this.z[i])
        ) {
          this.nextBody[i] = this.firstBody[c];
          this.firstBody[c] = i;
          return;
        }
        // Split: push the existing chain down one level.
        this.firstBody[c] = -1;
        let b = occupant;
        while (b !== -1) {
          const next = this.nextBody[b];
          const child = this.childFor(c, b);
          this.nextBody[b] = this.firstBody[child];
          this.firstBody[child] = b;
          b = next;
        }
      }
      c = this.childFor(c, i);
    }
  }

  private childFor(c: number, i: number): number {
    const o = this.octant(c, i);
    const slot = c * 8 + o;
    let child = this.children[slot];
    if (child === -1) {
      const h = this.half[c] / 2;
      child = this.newCell(
        this.cx[c] + (o & 1 ? h : -h),
        this.cy[c] + (o & 2 ? h : -h),
        this.cz[c] + (o & 4 ? h : -h),
        h,
        this.depth[c] + 1,
      );
      // `newCell` may have reallocated `children`; write through the fresh array.
      this.children[slot] = child;
    }
    return child;
  }

  /** Post-order aggregation (iterative to keep deep trees off the call stack). */
  private accumulate(root: number, charge: Float64Array, radius: Float64Array): void {
    const order: number[] = [];
    const stack = [root];
    while (stack.length) {
      const c = stack.pop()!;
      order.push(c);
      const base = c * 8;
      for (let k = 0; k < 8; k++) {
        const child = this.children[base + k];
        if (child !== -1) stack.push(child);
      }
    }
    for (let o = order.length - 1; o >= 0; o--) {
      const c = order[o];
      let q = 0, w = 0, sx = 0, sy = 0, sz = 0, r = 0;
      for (let b = this.firstBody[c]; b !== -1; b = this.nextBody[b]) {
        const a = Math.abs(charge[b]);
        q += charge[b];
        w += a;
        sx += this.x[b] * a;
        sy += this.y[b] * a;
        sz += this.z[b] * a;
        if (radius[b] > r) r = radius[b];
      }
      const base = c * 8;
      for (let k = 0; k < 8; k++) {
        const child = this.children[base + k];
        if (child === -1) continue;
        const cw = this.weight[child];
        q += this.charge[child];
        w += cw;
        sx += this.mx[child] * cw;
        sy += this.my[child] * cw;
        sz += this.mz[child] * cw;
        if (this.maxRadius[child] > r) r = this.maxRadius[child];
      }
      this.charge[c] = q;
      this.weight[c] = w;
      this.mx[c] = w > 0 ? sx / w : this.cx[c];
      this.my[c] = w > 0 ? sy / w : this.cy[c];
      this.mz[c] = w > 0 ? sz / w : this.cz[c];
      this.maxRadius[c] = r;
    }
  }
}
