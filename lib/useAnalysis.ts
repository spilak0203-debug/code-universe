'use client';

import { useEffect, useState } from 'react';
import type { AnalyzeEvent, AnalyzeStage, CodeGraph } from './graph/types';

export interface StageProgress {
  stage: AnalyzeStage;
  message: string;
  done?: number;
  total?: number;
}

export type AnalysisState =
  | { status: 'loading'; current: StageProgress | null; reached: AnalyzeStage[] }
  | { status: 'ready'; graph: CodeGraph; cached: boolean }
  | { status: 'error'; message: string };

export interface AnalysisRequest {
  repo: string;
  /** Branch, tag or sha (named `gitRef` because `ref` is reserved for React). */
  gitRef?: string;
  path?: string;
  tests?: boolean;
}

/** Streams NDJSON progress from /api/analyze and resolves to the graph. */
export function useAnalysis(req: AnalysisRequest): AnalysisState {
  const [state, setState] = useState<AnalysisState>({ status: 'loading', current: null, reached: [] });
  const { repo, gitRef, path, tests } = req;

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', current: null, reached: [] });
    const params = new URLSearchParams({ repo });
    if (gitRef) params.set('ref', gitRef);
    if (path) params.set('path', path);
    if (tests) params.set('tests', '1');

    (async () => {
      const res = await fetch(`/api/analyze?${params}`, { signal: controller.signal });
      if (!res.body) throw new Error(`Server responded ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // The final result line can be several MB; collect it in pieces instead of rescanning a growing string.
      let pending: string[] = [];
      let finished = false;
      const handle = (event: AnalyzeEvent) => {
        if (event.type === 'progress') {
          setState((prev) => {
            const reached = prev.status === 'loading' ? prev.reached : [];
            return {
              status: 'loading',
              current: { stage: event.stage, message: event.message, done: event.done, total: event.total },
              reached: reached.includes(event.stage) ? reached : [...reached, event.stage],
            };
          });
        } else if (event.type === 'result') {
          finished = true;
          setState({ status: 'ready', graph: event.graph, cached: event.cached });
        } else {
          finished = true;
          setState({ status: 'error', message: event.message });
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        const text = value ? decoder.decode(value, { stream: true }) : '';
        const pieces = text.split('\n');
        for (let i = 0; i < pieces.length - 1; i++) {
          pending.push(pieces[i]);
          const line = pending.join('').trim();
          pending = [];
          if (line) handle(JSON.parse(line) as AnalyzeEvent);
        }
        pending.push(pieces[pieces.length - 1]);
        if (done) {
          const rest = pending.join('').trim();
          if (rest) handle(JSON.parse(rest) as AnalyzeEvent);
          break;
        }
      }
      if (!finished) setState({ status: 'error', message: 'The analysis stream ended unexpectedly.' });
    })().catch((err: unknown) => {
      if (controller.signal.aborted) return;
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    });

    return () => controller.abort();
  }, [repo, gitRef, path, tests]);

  return state;
}
