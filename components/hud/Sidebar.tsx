'use client';

import { useMemo, useState } from 'react';
import { useView } from '@/lib/store';
import { formatNumber, groupColorCss } from '@/lib/viz/describe';
import { EDGE_INDEX, KIND, type UniverseModel } from '@/lib/viz/model';
import { NodeRow } from './NodeRow';

type Tab = 'galaxy' | 'insights';

export function Sidebar({ model }: { model: UniverseModel }) {
  const [tab, setTab] = useState<Tab>('galaxy');
  // Phones get the canvas first; the panel is one tap away.
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
  const open = (t: Tab) => {
    setTab(t);
    setCollapsed(false);
  };
  return (
    <div className={`sidebar glass${collapsed ? ' collapsed' : ''}`}>
      <div className="tabs">
        <button className={`tab${tab === 'galaxy' && !collapsed ? ' active' : ''}`} onClick={() => open('galaxy')}>
          Galaxy map
        </button>
        <button className={`tab${tab === 'insights' && !collapsed ? ' active' : ''}`} onClick={() => open('insights')}>
          Insights
        </button>
        <button
          className="tab"
          style={{ flex: 'none', width: 30 }}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="scroll" style={{ marginTop: 4, paddingRight: 2 }}>
          {tab === 'galaxy' ? <Legend model={model} /> : <Insights model={model} />}
        </div>
      )}
    </div>
  );
}

const BODY_LEGEND = [
  { label: 'Star', meaning: 'file', icon: 'star' },
  { label: 'Planet', meaning: 'function', icon: 'planet' },
  { label: 'Ringed planet', meaning: 'class', icon: 'ringed' },
  { label: 'Moon', meaning: 'method', icon: 'moon' },
  { label: 'Beacon', meaning: 'npm package', icon: 'beacon' },
  { label: 'Nebula', meaning: 'directory', icon: 'nebula' },
] as const;

function BodyIcon({ icon }: { icon: (typeof BODY_LEGEND)[number]['icon'] }) {
  return (
    <svg width="22" height="22" viewBox="-11 -11 22 22" style={{ flex: 'none' }}>
      {icon === 'star' && (
        <>
          <circle r="9" fill="url(#halo)" />
          <path d="M-10 0H10M0-10V10" stroke="#fff" strokeOpacity=".5" strokeWidth=".7" />
          <circle r="2.6" fill="#fff" />
        </>
      )}
      {icon === 'planet' && <circle r="5" fill="#7cc4ff" />}
      {icon === 'ringed' && (
        <>
          <circle r="4.6" fill="#ff8fc8" />
          <ellipse rx="9" ry="2.6" fill="none" stroke="#ffd1ea" strokeWidth="1.2" transform="rotate(-12)" />
        </>
      )}
      {icon === 'moon' && <circle r="2.6" fill="#b7bfd6" />}
      {icon === 'beacon' && (
        <>
          <circle r="6.5" fill="none" stroke="#8c9ec7" strokeWidth="1.4" />
          <circle r="1.8" fill="#c9d3ee" />
        </>
      )}
      {icon === 'nebula' && <circle r="9" fill="url(#neb)" />}
      <defs>
        <radialGradient id="halo">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset=".35" stopColor="#b9cdff" stopOpacity=".45" />
          <stop offset="1" stopColor="#b9cdff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="neb">
          <stop offset="0" stopColor="#b69cff" stopOpacity=".55" />
          <stop offset="1" stopColor="#b69cff" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}

function Legend({ model }: { model: UniverseModel }) {
  const hiddenGroups = useView((s) => s.hiddenGroups);
  const spotlight = useView((s) => s.spotlight);
  const toggleGroup = useView((s) => s.toggleGroup);
  const soloGroup = useView((s) => s.soloGroup);
  const showAll = useView((s) => s.showAllGroups);
  const setSpotlight = useView((s) => s.setSpotlight);
  const groups = model.graph.groups;

  return (
    <>
      <div className="section-title">Bodies</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px' }}>
        {BODY_LEGEND.map((b) => (
          <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
            <BodyIcon icon={b.icon} />
            <span>
              {b.label} <span style={{ color: 'var(--muted)' }}>· {b.meaning}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="section-title">
        <span>Regions ({groups.length})</span>
        {hiddenGroups.size > 0 && (
          <button className="btn" style={{ height: 22, fontSize: 11 }} onClick={showAll}>
            Show all
          </button>
        )}
      </div>
      {groups.map((g, i) => {
        const hidden = hiddenGroups.has(i);
        const lit = spotlight.type === 'group' && spotlight.group === i;
        return (
          <div key={g.name} className={`row${lit ? ' active' : ''}`} style={{ opacity: hidden ? 0.45 : 1, cursor: 'default' }}>
            <span className="dot" style={{ color: groupColorCss(model, i) }} />
            <button
              className="main"
              style={{ border: 0, background: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}
              onClick={() => setSpotlight(lit ? { type: 'none' } : { type: 'group', group: i })}
              onDoubleClick={() => soloGroup(i)}
              title="Click to spotlight · double-click to show only this region"
            >
              {g.name}
            </button>
            <span className="num">{g.files}</span>
            <button
              className="btn"
              style={{ height: 22, width: 26, padding: 0 }}
              onClick={() => toggleGroup(i)}
              title={hidden ? 'Show region' : 'Hide region'}
              aria-label={hidden ? 'Show region' : 'Hide region'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                {hidden ? <path d="M3 3l18 18" /> : <circle cx="12" cy="12" r="3" />}
              </svg>
            </button>
          </div>
        );
      })}
    </>
  );
}

function topBy(ids: number[], score: (id: number) => number, n: number): number[] {
  return ids
    .filter((id) => score(id) > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, n);
}

function Insights({ model }: { model: UniverseModel }) {
  const spotlight = useView((s) => s.spotlight);
  const setSpotlight = useView((s) => s.setSpotlight);
  const select = useView((s) => s.select);
  const [showAllDark, setShowAllDark] = useState(false);

  const data = useMemo(() => {
    const all = Array.from({ length: model.n }, (_, i) => i);
    const symbols = all.filter((i) => model.kind[i] >= KIND.function && model.kind[i] <= KIND.method);
    const files = all.filter((i) => model.kind[i] === KIND.file);
    const externals = all.filter((i) => model.kind[i] === KIND.external);
    const importers = (id: number) => model.inEdges[id].filter((e) => model.edgeKind[e] === EDGE_INDEX.import).length;
    const dark = symbols.filter((i) => model.darkMatter[i]).sort((a, b) => model.graph.nodes[b].loc - model.graph.nodes[a].loc);
    return {
      hubs: topBy(symbols, (i) => model.fanIn[i], 10),
      imported: topBy(files, importers, 8),
      largest: topBy(files, (i) => model.graph.nodes[i].loc, 8),
      packages: topBy(externals, importers, 8),
      importers,
      dark,
    };
  }, [model]);

  const cycles = model.graph.cycles;
  const nodes = model.graph.nodes;

  return (
    <>
      <div className="section-title">Supermassive · most called</div>
      {data.hubs.map((id) => (
        <NodeRow key={id} model={model} id={id} value={formatNumber(model.fanIn[id])} />
      ))}

      <div className="section-title">
        <span>Import cycles ({cycles.length})</span>
      </div>
      {cycles.length === 0 && <div className="sub" style={{ color: 'var(--ok)', fontSize: 12.5 }}>No runtime import cycles 🎉</div>}
      {cycles.slice(0, 12).map((cycle, i) => {
        const lit = spotlight.type === 'cycle' && spotlight.index === i;
        return (
          <button
            key={i}
            className={`row${lit ? ' active' : ''}`}
            onClick={() => {
              setSpotlight(lit ? { type: 'none' } : { type: 'cycle', index: i });
            }}
            title={cycle.map((id) => nodes[id].path).join('\n')}
          >
            <span className="dot" style={{ color: 'var(--warn)' }} />
            <span className="main">
              {cycle
                .slice(0, 3)
                .map((id) => nodes[id].name)
                .join(' → ')}
              {cycle.length > 3 ? ' …' : ' ↺'}
            </span>
            <span className="num">{cycle.length} files</span>
          </button>
        );
      })}

      <div className="section-title">
        <span>Dark matter · unused ({data.dark.length})</span>
        {data.dark.length > 0 && (
          <button
            className="btn"
            style={{ height: 22, fontSize: 11 }}
            onClick={() => setSpotlight(spotlight.type === 'darkMatter' ? { type: 'none' } : { type: 'darkMatter' })}
          >
            {spotlight.type === 'darkMatter' ? 'Clear' : 'Reveal'}
          </button>
        )}
      </div>
      <div className="sub" style={{ color: 'var(--muted)', fontSize: 11.5, marginBottom: 4 }}>
        Non-exported functions & classes never referenced in their file.
      </div>
      {(showAllDark ? data.dark : data.dark.slice(0, 6)).map((id) => (
        <NodeRow key={id} model={model} id={id} value={`${nodes[id].loc}L`} />
      ))}
      {data.dark.length > 6 && (
        <button className="btn" style={{ height: 24, fontSize: 11, marginTop: 4 }} onClick={() => setShowAllDark((v) => !v)}>
          {showAllDark ? 'Show less' : `Show all ${data.dark.length}`}
        </button>
      )}

      <div className="section-title">Most imported files</div>
      {data.imported.map((id) => (
        <NodeRow key={id} model={model} id={id} value={data.importers(id)} />
      ))}

      <div className="section-title">Largest stars · lines of code</div>
      {data.largest.map((id) => (
        <NodeRow key={id} model={model} id={id} value={formatNumber(nodes[id].loc)} />
      ))}

      {data.packages.length > 0 && (
        <>
          <div className="section-title">Most used packages</div>
          {data.packages.map((id) => (
            <NodeRow key={id} model={model} id={id} value={data.importers(id)} onPick={(x) => select(x, { fly: true })} />
          ))}
        </>
      )}
    </>
  );
}
