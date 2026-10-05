'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AnalyzeStage } from '@/lib/graph/types';
import { startLayout } from '@/lib/layout/client';
import { useView } from '@/lib/store';
import { useAnalysis, type AnalysisRequest, type StageProgress } from '@/lib/useAnalysis';
import { buildModel } from '@/lib/viz/model';
import { UniverseRuntime } from '@/lib/viz/runtime';
import { Hud } from './hud/Hud';

const Universe = dynamic(() => import('./universe/Universe'), { ssr: false });

export function Viewer(props: AnalysisRequest) {
  const analysis = useAnalysis(props);
  const [runtime, setRuntime] = useState<UniverseRuntime | null>(null);

  useEffect(() => {
    if (analysis.status !== 'ready') return;
    const model = buildModel(analysis.graph);
    const rt = new UniverseRuntime(model);
    useView.getState().setModel(model);
    setRuntime(rt);
    const layout = startLayout(model.simInput, {
      onPositions: (positions, done) => {
        rt.setLayout(positions);
        if (done) useView.getState().setLayoutDone(true);
      },
      onEnd: (info) => console.info(`[layout] ${info.ticks} ticks in ${info.ms.toFixed(0)} ms (${info.worker ? 'worker' : 'main thread'})`),
    });
    return () => {
      layout.stop();
      useView.getState().setModel(null);
    };
  }, [analysis]);

  return (
    <main className="viewer">
      {runtime && <Universe runtime={runtime} />}
      {runtime && analysis.status === 'ready' && <Hud runtime={runtime} cached={analysis.cached} />}
      {analysis.status === 'loading' && <LoadingScreen title={props.repo} current={analysis.current} reached={analysis.reached} />}
      {analysis.status === 'error' && (
        <div className="overlay">
          <div className="starfield" />
          <div className="loading-card glass">
            <h2>Could not chart this universe</h2>
            <p style={{ color: 'var(--text-dim)', lineHeight: 1.6 }}>{analysis.message}</p>
            <Link href="/" className="btn primary" style={{ textDecoration: 'none' }}>
              Try another repository
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}

const STAGES: { stage: AnalyzeStage; label: string }[] = [
  { stage: 'resolve', label: 'Locating repository' },
  { stage: 'download', label: 'Streaming the source archive' },
  { stage: 'parse', label: 'Parsing syntax trees' },
  { stage: 'link', label: 'Resolving symbols with the type checker' },
  { stage: 'finalize', label: 'Detecting cycles & metrics' },
];

function LoadingScreen({ title, current, reached }: { title: string; current: StageProgress | null; reached: AnalyzeStage[] }) {
  const activeIndex = current ? STAGES.findIndex((s) => s.stage === current.stage) : 0;
  return (
    <div className="overlay">
      <div className="starfield" />
      <div className="loading-card glass">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span className="brand-mark" />
          <div>
            <h2>Charting {title}</h2>
            <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{current?.message ?? 'Connecting…'}</div>
          </div>
        </div>
        {STAGES.map((s, i) => {
          const done = i < activeIndex || (reached.includes(s.stage) && i < activeIndex);
          const active = i === activeIndex;
          const pct = active && current?.total ? Math.round(((current.done ?? 0) / current.total) * 100) : null;
          return (
            <div key={s.stage}>
              <div className={`stage${active ? ' active' : ''}${done ? ' done' : ''}`}>
                {done ? (
                  <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="m5 12 5 5 9-10" />
                  </svg>
                ) : active ? (
                  <span className="spinner" />
                ) : (
                  <span className="pending" />
                )}
                <span style={{ flex: 1 }}>{s.label}</span>
                {active && current?.total ? (
                  <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {current.done}/{current.total}
                  </span>
                ) : null}
              </div>
              {pct !== null && (
                <div className="progress">
                  <div style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
