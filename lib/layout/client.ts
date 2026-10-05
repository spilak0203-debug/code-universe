import { ForceSimulation, type SimInput } from './simulation';
import type { FromLayoutWorker } from './protocol';

export interface LayoutHandle {
  reheat(alpha?: number): void;
  stop(): void;
}

export interface LayoutCallbacks {
  onPositions(positions: Float32Array, done: boolean): void;
  onEnd?(info: { ticks: number; ms: number; worker: boolean }): void;
}

/**
 * Run the force simulation off the main thread; fall back to rAF-sliced
 * main-thread ticks if workers are unavailable.
 */
export function startLayout(input: SimInput, cb: LayoutCallbacks): LayoutHandle {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (worker) {
    const w = worker;
    w.onmessage = (event: MessageEvent<FromLayoutWorker>) => {
      const msg = event.data;
      cb.onPositions(msg.positions, msg.type === 'end');
      if (msg.type === 'end') cb.onEnd?.({ ticks: msg.ticks, ms: msg.ms, worker: true });
    };
    w.onerror = (e) => {
      console.warn('layout worker failed, falling back to main thread', e.message);
      w.terminate();
      Object.assign(handle, runOnMainThread(input, cb));
    };
    w.postMessage({ type: 'start', input });
    const handle: LayoutHandle = {
      reheat: (alpha = 0.5) => w.postMessage({ type: 'reheat', alpha }),
      stop: () => w.terminate(),
    };
    return handle;
  }
  return runOnMainThread(input, cb);
}

function runOnMainThread(input: SimInput, cb: LayoutCallbacks): LayoutHandle {
  const sim = new ForceSimulation(input);
  let raf = 0;
  let ticks = 0;
  const started = performance.now();
  const frame = () => {
    const end = performance.now() + 8;
    do {
      sim.tick();
      ticks++;
    } while (!sim.done && performance.now() < end);
    const positions = new Float32Array(sim.n * 3);
    sim.writePositions(positions);
    cb.onPositions(positions, sim.done);
    if (sim.done) cb.onEnd?.({ ticks, ms: performance.now() - started, worker: false });
    else raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    reheat: (alpha = 0.5) => {
      const wasDone = sim.done;
      sim.reheat(alpha);
      if (wasDone) raf = requestAnimationFrame(frame);
    },
    stop: () => cancelAnimationFrame(raf),
  };
}
