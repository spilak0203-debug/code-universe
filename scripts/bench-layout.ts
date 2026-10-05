/**
 * Layout benchmark + quality metrics on saved graphs.
 *   npm run analyze -- facebook/react --out tmp/react.json
 *   npm run bench:layout -- tmp/react.json [more.json…]
 */
import { readFileSync } from 'node:fs';
import { buildModel } from '../lib/viz/model';
import { ForceSimulation } from '../lib/layout/simulation';
import { KIND } from '../lib/viz/model';

for (const file of process.argv.slice(2)) {
  const t0 = performance.now();
  const model = buildModel(JSON.parse(readFileSync(file, 'utf8')));
  const buildMs = performance.now() - t0;

  const t1 = performance.now();
  const sim = new ForceSimulation(model.simInput);
  let ticks = 0;
  while (!sim.done) {
    sim.tick();
    ticks++;
  }
  const layoutMs = performance.now() - t1;

  const files: number[] = [];
  const externals: number[] = [];
  for (let s = 0; s < model.simCount; s++) {
    const k = model.kind[model.simNodes[s]];
    if (k === KIND.file) files.push(s);
    else if (k === KIND.external) externals.push(s);
  }
  const planar = (s: number) => Math.hypot(sim.x[s], sim.z[s]);
  const pct = (values: number[], p: number) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * p)];
  };
  const fileR = files.map(planar);
  const p90 = pct(fileR, 0.9);

  // Star systems whose orbits intersect.
  let overlaps = 0;
  for (let a = 0; a < files.length; a++) {
    for (let b = a + 1; b < files.length; b++) {
      const i = files[a], j = files[b];
      const d = Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j], sim.z[i] - sim.z[j]);
      if (d < (model.systemRadius[model.simNodes[i]] + model.systemRadius[model.simNodes[j]]) * 0.9) overlaps++;
    }
  }

  // Region cohesion: mean distance to the region centroid relative to mean distance to the galaxy centre.
  const byGroup = new Map<number, number[]>();
  for (const s of files) {
    const g = model.group[model.simNodes[s]];
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(s);
  }
  let within = 0, counted = 0;
  for (const members of byGroup.values()) {
    if (members.length < 3) continue;
    let cx = 0, cz = 0;
    for (const s of members) {
      cx += sim.x[s];
      cz += sim.z[s];
    }
    cx /= members.length;
    cz /= members.length;
    for (const s of members) {
      within += Math.hypot(sim.x[s] - cx, sim.z[s] - cz);
      counted++;
    }
  }
  const cohesion = within / counted / (fileR.reduce((a, b) => a + b, 0) / fileR.length);
  const thickness = pct(files.map((s) => Math.abs(sim.y[s])), 0.9) / p90;

  console.log(file.split(/[\\/]/).pop());
  console.log(`  ${model.n} nodes, ${model.edgeCount} edges → ${model.simCount} simulated bodies, ${model.simInput.linkSource.length} springs`);
  console.log(`  buildModel ${buildMs.toFixed(0)} ms · layout ${ticks} ticks in ${layoutMs.toFixed(0)} ms (${(layoutMs / ticks).toFixed(2)} ms/tick)`);
  console.log(`  overlapping systems ${overlaps} · region cohesion ${cohesion.toFixed(2)} (lower = tighter) · disk thickness ${thickness.toFixed(2)}`);
  if (externals.length) console.log(`  package ring at ${(pct(externals.map(planar), 0.1) / p90).toFixed(2)}× the galaxy's p90 radius`);
}
