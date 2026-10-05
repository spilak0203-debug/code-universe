/// <reference lib="webworker" />
import { ForceSimulation } from './simulation';
import type { FromLayoutWorker, ToLayoutWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let sim: ForceSimulation | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticks = 0;
let started = 0;

/** Run as many ticks as fit in a ~14 ms slice, then stream positions back. */
function loop() {
  timer = null;
  if (!sim) return;
  const sliceEnd = performance.now() + 14;
  do {
    sim.tick();
    ticks++;
  } while (!sim.done && performance.now() < sliceEnd);

  const positions = new Float32Array(sim.n * 3);
  sim.writePositions(positions);
  const msg: FromLayoutWorker = sim.done
    ? { type: 'end', positions, ticks, ms: performance.now() - started }
    : { type: 'tick', positions, alpha: sim.alpha, ticks };
  self.postMessage(msg, [positions.buffer]);
  if (!sim.done) timer = setTimeout(loop, 0);
}

self.onmessage = (event: MessageEvent<ToLayoutWorker>) => {
  const msg = event.data;
  if (msg.type === 'start') {
    sim = new ForceSimulation(msg.input);
    ticks = 0;
    started = performance.now();
  } else if (msg.type === 'reheat' && sim) {
    sim.reheat(msg.alpha);
  } else if (msg.type === 'stop') {
    sim = null;
  }
  if (sim && !timer) timer = setTimeout(loop, 0);
};
