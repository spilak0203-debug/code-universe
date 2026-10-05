import type { SimInput } from './simulation';

export type ToLayoutWorker =
  | { type: 'start'; input: SimInput }
  | { type: 'reheat'; alpha: number }
  | { type: 'stop' };

export type FromLayoutWorker =
  | { type: 'tick'; positions: Float32Array; alpha: number; ticks: number }
  | { type: 'end'; positions: Float32Array; ticks: number; ms: number };
