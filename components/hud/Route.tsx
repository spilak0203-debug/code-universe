'use client';

import { Fragment, useState } from 'react';
import { useView } from '@/lib/store';
import { EDGE_COLOR_CSS } from '@/lib/viz/palette';
import { EDGE_INDEX, KIND, type UniverseModel } from '@/lib/viz/model';
import { NodeRow } from './NodeRow';

const VERB: Record<number, string> = {
  [EDGE_INDEX.import]: 'imports',
  [EDGE_INDEX.call]: 'calls',
  [EDGE_INDEX.render]: 'renders',
  [EDGE_INDEX.inherit]: 'extends',
};

function shortName(model: UniverseModel, id: number): string {
  return model.kind[id] === KIND.file ? model.graph.nodes[id].name : model.displayName[id];
}

/** Banner shown while the user is choosing where a traced path should end. */
export function RouteHint({ model }: { model: UniverseModel }) {
  const routeFrom = useView((s) => s.routeFrom);
  const cancelRoute = useView((s) => s.cancelRoute);
  if (routeFrom < 0) return null;
  return (
    <div className="route-hint glass">
      <span className="spinner" style={{ width: 10, height: 10 }} />
      <span>
        Tracing from <b>{shortName(model, routeFrom)}</b> — click a body or search for the destination
      </span>
      <button className="btn" style={{ height: 24, fontSize: 11.5 }} onClick={cancelRoute}>
        Cancel <span className="kbd">Esc</span>
      </button>
    </div>
  );
}

/** The traced route: endpoints, every hop in order with what it does, swap and share. */
export function RoutePanel({ model }: { model: UniverseModel }) {
  const spotlight = useView((s) => s.spotlight);
  const showRoute = useView((s) => s.showRoute);
  const setSpotlight = useView((s) => s.setSpotlight);
  const flyTo = useView((s) => s.flyTo);
  const [copied, setCopied] = useState(false);
  if (spotlight.type !== 'path') return null;
  const { from, to, path } = spotlight;
  const last = path ? path.nodes.length - 1 : 0;

  return (
    <div className="node-panel glass" key={`${from}-${to}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="kind-badge" style={{ color: 'var(--accent-strong)' }}>
          Path
        </span>
        <span className="chip" style={{ padding: '1px 8px', fontSize: 11 }}>
          {path ? (path.kind === 'call' ? 'call chain' : 'import chain') : 'not connected'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ height: 26, padding: '0 8px' }} onClick={() => showRoute(to, from)} title="Swap direction">
          ⇄
        </button>
        <button
          className="btn"
          style={{ height: 26, padding: '0 8px' }}
          title="Copy a link to this path"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? 'Copied' : 'Link'}
        </button>
        <button className="btn" style={{ height: 26, padding: '0 8px' }} onClick={() => setSpotlight({ type: 'none' })} title="Close (Esc)" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="node-title">
        {shortName(model, from)} <span style={{ color: 'var(--muted)' }}>→</span> {shortName(model, to)}
      </div>
      {path ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>
          {path.edges.length} {path.edges.length === 1 ? 'hop' : 'hops'}
          {path.kind === 'import' && ' · no call chain, so this follows file imports'}
          {path.reversed && (
            <div style={{ color: 'var(--amber)', marginTop: 4 }}>
              Nothing leads from {shortName(model, from)} to {shortName(model, to)} — showing the reverse direction.
            </div>
          )}
        </div>
      ) : (
        <p style={{ color: 'var(--text-dim)', lineHeight: 1.55, fontSize: 13 }}>
          No call chain or import chain connects these two in either direction. They may only meet through
          code the analyzer can't see (dynamic dispatch, callbacks registered at runtime, external packages).
        </p>
      )}
      {path && (
        <div className="scroll" style={{ marginTop: 10, marginRight: -6, paddingRight: 6 }}>
          {path.nodes.map((id, i) => (
            <Fragment key={`${id}-${i}`}>
              <NodeRow model={model} id={id} value={i === 0 ? 'start' : i === last ? 'end' : `${i}`} onPick={flyTo} />
              {i < last && (
                <div className="hop">
                  <span className="swatch" style={{ background: EDGE_COLOR_CSS[model.edgeKind[path.edges[i]]] }} />
                  {VERB[model.edgeKind[path.edges[i]]]}
                  {model.edgeWeight[path.edges[i]] > 1 && <span style={{ color: 'var(--muted)' }}> ×{model.edgeWeight[path.edges[i]]}</span>}
                </div>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
