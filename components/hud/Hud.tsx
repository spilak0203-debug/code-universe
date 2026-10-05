'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useView } from '@/lib/store';
import { formatNumber, repoUrl } from '@/lib/viz/describe';
import type { UniverseRuntime } from '@/lib/viz/runtime';
import { NodePanel } from './NodePanel';
import { RouteHint, RoutePanel } from './Route';
import { Labels, Tooltip } from './Overlays';
import { Search } from './Search';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import { useDeepLink } from './useDeepLink';

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement) return;
      const s = useView.getState();
      if (e.key === 'Escape') {
        if (s.routeFrom >= 0) s.cancelRoute();
        else if (s.selected >= 0) s.select(-1);
        else if (s.spotlight.type !== 'none') s.setSpotlight({ type: 'none' });
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        s.back();
      } else if (e.key.toLowerCase() === 'f' && s.selected >= 0) {
        s.flyTo(s.selected);
      } else if (e.key.toLowerCase() === 'h') {
        s.home();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function Hud({ runtime, cached }: { runtime: UniverseRuntime; cached: boolean }) {
  useShortcuts();
  const model = runtime.model;
  useDeepLink(model);
  const { repo, stats } = model.graph;
  const layoutDone = useView((s) => s.layoutDone);

  return (
    <div className="hud">
      <Labels runtime={runtime} />
      <div className="topbar glass">
        <Link href="/" className="brand">
          <span className="brand-mark" />
          Code Universe
        </Link>
        <div className="repo-line">
          <a href={repoUrl(model.graph)} target="_blank" rel="noreferrer">
            {repo.owner}/{repo.repo}
          </a>
          {repo.subdir && <span className="mono">/{repo.subdir}</span>}
          <span className="chip mono">{repo.sha ? repo.sha.slice(0, 7) : repo.ref}</span>
        </div>
        <Search model={model} />
      </div>
      <Toolbar model={model} />
      <Sidebar model={model} />
      <NodePanel model={model} />
      <RoutePanel model={model} />
      <RouteHint model={model} />
      <div className="statusbar">
        <span className="chip">{formatNumber(stats.files)} files</span>
        <span className="chip">{formatNumber(stats.functions + stats.methods)} functions</span>
        <span className="chip">{formatNumber(stats.classes)} classes</span>
        <span className="chip">{formatNumber(stats.totalLoc)} lines</span>
        <span
          className="chip"
          title={`${stats.resolvedCalls} of ${stats.resolvedCalls + stats.unresolvedCalls} call sites resolved to repo symbols (the rest call into libraries or builtins)`}
        >
          {formatNumber(stats.callEdges + stats.renderEdges)} call links
        </span>
        <span
          className="chip"
          title={`download ${stats.timings.download} ms · parse ${stats.timings.parse} ms · type-check & link ${stats.timings.resolve} ms`}
        >
          {cached ? 'cached' : `analyzed in ${(stats.timings.total / 1000).toFixed(1)}s`}
          {stats.mode === 'partial' ? ' · fast mode' : ''}
          {stats.truncated ? ` · first ${stats.files} files` : ''}
        </span>
        {!layoutDone && (
          <span className="chip">
            <span className="spinner" style={{ width: 10, height: 10 }} /> forming galaxy…
          </span>
        )}
        <span className="spacer" />
        <span className="chip help" style={{ gap: 10 }}>
          <span>
            <span className="kbd">click</span> select
          </span>
          <span>
            <span className="kbd">dbl-click</span> fly
          </span>
          <span>
            <span className="kbd">/</span> search
          </span>
          <span>
            <span className="kbd">H</span> home
          </span>
        </span>
      </div>
      <Tooltip runtime={runtime} />
    </div>
  );
}
