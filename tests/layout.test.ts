import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stronglyConnectedComponents } from '../lib/analyzer/cycles';
import { Octree } from '../lib/layout/octree';
import { ForceSimulation, mulberry32, type SimInput } from '../lib/layout/simulation';

function randomBodies(n: number, seed = 1) {
  const rand = mulberry32(seed);
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (rand() - 0.5) * 200;
    y[i] = (rand() - 0.5) * 200;
    z[i] = (rand() - 0.5) * 200;
  }
  return { x, y, z };
}

test('octree aggregates charge and centre of charge exactly at the root', () => {
  const n = 500;
  const { x, y, z } = randomBodies(n);
  const charge = new Float64Array(n).fill(-30);
  const radius = new Float64Array(n).fill(1);
  const tree = new Octree();
  tree.build(x, y, z, charge, radius, n);
  assert.ok(Math.abs(tree.charge[0] - -30 * n) < 1e-6);
  const mean = (a: Float64Array) => a.reduce((s, v) => s + v, 0) / n;
  assert.ok(Math.abs(tree.mx[0] - mean(x)) < 1e-9);
  assert.ok(Math.abs(tree.my[0] - mean(y)) < 1e-9);
  assert.ok(Math.abs(tree.mz[0] - mean(z)) < 1e-9);
  // Every body is reachable exactly once.
  let count = 0;
  for (let c = 0; c < tree.cellCount; c++) for (let b = tree.firstBody[c]; b !== -1; b = tree.nextBody[b]) count++;
  assert.equal(count, n);
});

test('octree survives coincident bodies', () => {
  const n = 64;
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const tree = new Octree();
  tree.build(x, y, z, new Float64Array(n).fill(-1), new Float64Array(n).fill(1), n);
  let count = 0;
  for (let c = 0; c < tree.cellCount; c++) for (let b = tree.firstBody[c]; b !== -1; b = tree.nextBody[b]) count++;
  assert.equal(count, n);
});

function chainInput(n: number): SimInput {
  const rand = mulberry32(7);
  const init = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) init[i] = (rand() - 0.5) * 5; // start crowded on purpose
  const links = n - 1;
  return {
    count: n,
    charge: new Float32Array(n).fill(-30),
    radius: new Float32Array(n).fill(4),
    ring: new Float32Array(n),
    linkSource: Uint32Array.from({ length: links }, (_, i) => i),
    linkTarget: Uint32Array.from({ length: links }, (_, i) => i + 1),
    linkDistance: new Float32Array(links).fill(20),
    linkStrength: new Float32Array(links).fill(0.7),
    init,
    flatten: 0.07,
  };
}

test('simulation converges without NaNs, keeps links bounded and separates bodies', () => {
  const n = 120;
  const sim = new ForceSimulation(chainInput(n));
  let ticks = 0;
  while (!sim.done && ticks < 2000) {
    sim.tick();
    ticks++;
  }
  assert.ok(sim.done, 'alpha decays below alphaMin');
  for (let i = 0; i < n; i++) assert.ok(Number.isFinite(sim.x[i] + sim.y[i] + sim.z[i]), `body ${i} finite`);
  // Repulsion from 119 other bodies stretches a chain (as in d3); springs must still bound it.
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const len = Math.hypot(sim.x[i + 1] - sim.x[i], sim.y[i + 1] - sim.y[i], sim.z[i + 1] - sim.z[i]);
    assert.ok(len > 8 && len < 150, `link ${i} length ${len.toFixed(1)}`);
    total += len;
  }
  assert.ok(total / (n - 1) < 60, `mean link length ${(total / (n - 1)).toFixed(1)}`);
  let overlaps = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j], sim.z[i] - sim.z[j]) < 8 * 0.8) overlaps++;
  assert.equal(overlaps, 0);
});

test('Barnes–Hut repulsion stays within a few percent of the exact O(n²) forces', () => {
  const n = 2000;
  const { x, y, z } = randomBodies(n, 3);
  const init = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    init[i * 3] = x[i];
    init[i * 3 + 1] = y[i];
    init[i * 3 + 2] = z[i];
  }
  // Only many-body: no links, no collisions, no flattening.
  const input: SimInput = {
    count: n,
    charge: new Float32Array(n).fill(-30),
    radius: new Float32Array(n),
    ring: new Float32Array(n),
    linkSource: new Uint32Array(0),
    linkTarget: new Uint32Array(0),
    linkDistance: new Float32Array(0),
    linkStrength: new Float32Array(0),
    init,
    flatten: 0,
  };
  const approx = new ForceSimulation(input);
  const exact = new ForceSimulation(input, { ...approx.params, theta: 0 });
  approx.tick();
  exact.tick();
  let err = 0, mag = 0;
  for (let i = 0; i < n; i++) {
    err += Math.hypot(approx.vx[i] - exact.vx[i], approx.vy[i] - exact.vy[i], approx.vz[i] - exact.vz[i]);
    mag += Math.hypot(exact.vx[i], exact.vy[i], exact.vz[i]);
  }
  const relative = err / mag;
  assert.ok(relative < 0.05, `relative force error ${(relative * 100).toFixed(2)}%`);
});

test('Tarjan SCC finds cycles and self loops, ignores DAG parts', () => {
  // 0 → 1 → 2 → 0 (cycle), 2 → 3 → 4 (tail), 5 → 5 (self loop), 6 isolated
  const adj = [[1], [2], [0, 3], [4], [], [5], []];
  const sccs = stronglyConnectedComponents(7, adj).map((c) => [...c].sort());
  assert.deepEqual(sccs, [[0, 1, 2], [5]]);
});

test('Tarjan SCC handles deep chains without recursion limits', () => {
  const n = 200_000;
  const adj = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : [0]));
  const sccs = stronglyConnectedComponents(n, adj);
  assert.equal(sccs.length, 1);
  assert.equal(sccs[0].length, n);
});
