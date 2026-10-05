'use client';

import { useMemo, useState } from 'react';
import { NodeFlag } from '@/lib/graph/types';
import { useView } from '@/lib/store';
import { flagList, formatNumber, githubUrl, groupColorCss, KIND_NOUN } from '@/lib/viz/describe';
import { EDGE_INDEX, KIND, type UniverseModel } from '@/lib/viz/model';
import { NodeRow } from './NodeRow';

interface Section {
  title: string;
  items: { id: number; weight: number }[];
}

const LIST_LIMIT = 12;

/** Group a node's edges into readable "Calls / Called by / Imports …" sections. */
function relations(model: UniverseModel, id: number): Section[] {
  const out = new Map<string, Map<number, number>>();
  const add = (title: string, other: number, w: number) => {
    let m = out.get(title);
    if (!m) out.set(title, (m = new Map()));
    m.set(other, (m.get(other) ?? 0) + w);
  };
  const outgoing: Record<number, string> = {
    [EDGE_INDEX.import]: 'Imports',
    [EDGE_INDEX.call]: 'Calls',
    [EDGE_INDEX.render]: 'Renders',
    [EDGE_INDEX.inherit]: 'Extends',
  };
  const incoming: Record<number, string> = {
    [EDGE_INDEX.import]: 'Imported by',
    [EDGE_INDEX.call]: 'Called by',
    [EDGE_INDEX.render]: 'Rendered by',
    [EDGE_INDEX.inherit]: 'Extended by',
  };
  for (const e of model.outEdges[id]) add(outgoing[model.edgeKind[e]], model.edgeTarget[e], model.edgeWeight[e]);
  for (const e of model.inEdges[id]) add(incoming[model.edgeKind[e]], model.edgeSource[e], model.edgeWeight[e]);
  const order = ['Called by', 'Calls', 'Rendered by', 'Renders', 'Extends', 'Extended by', 'Imported by', 'Imports'];
  const sections: Section[] = [];
  const kids = model.children[id];
  if (kids.length) {
    const title =
      model.kind[id] === KIND.dir ? 'Contents' : model.kind[id] === KIND.file ? 'Declares' : 'Members';
    sections.push({
      title,
      items: kids
        .map((k) => ({ id: k, weight: model.graph.nodes[k].loc }))
        .sort((a, b) => (model.kind[a.id] === KIND.dir ? -1 : 0) - (model.kind[b.id] === KIND.dir ? -1 : 0) || model.graph.nodes[a.id].line - model.graph.nodes[b.id].line),
    });
  }
  for (const title of order) {
    const m = out.get(title);
    if (!m) continue;
    sections.push({
      title,
      items: [...m.entries()].map(([other, weight]) => ({ id: other, weight })).sort((a, b) => b.weight - a.weight),
    });
  }
  return sections;
}

export function NodePanel({ model }: { model: UniverseModel }) {
  const selected = useView((s) => s.selected);
  const history = useView((s) => s.history);
  const select = useView((s) => s.select);
  const back = useView((s) => s.back);
  const flyTo = useView((s) => s.flyTo);
  const routeFrom = useView((s) => s.routeFrom);
  const startRoute = useView((s) => s.startRoute);
  const cancelRoute = useView((s) => s.cancelRoute);
  const sections = useMemo(() => (selected >= 0 ? relations(model, selected) : []), [model, selected]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  if (selected < 0) return null;
  const node = model.graph.nodes[selected];
  const url = githubUrl(model.graph, node);
  const flags = flagList(model, selected);
  const parentId = node.parent;
  const kind = model.kind[selected];

  const metrics: [string, string | number][] =
    kind === KIND.file || kind === KIND.dir
      ? [
          ['lines', formatNumber(node.loc)],
          ['symbols', kind === KIND.file ? model.children[selected].length : countDescendantFiles(model, selected)],
          ['links', model.inEdges[selected].length + model.outEdges[selected].length],
        ]
      : kind === KIND.external
        ? [
            ['importers', model.inEdges[selected].length],
            ['kind', node.flags & NodeFlag.Builtin ? 'builtin' : 'npm'],
            ['', ''],
          ]
        : [
            ['lines', node.loc],
            ['fan-in', model.fanIn[selected]],
            ['fan-out', model.fanOut[selected]],
          ];
  if (kind === KIND.dir) metrics[1] = ['files', countDescendantFiles(model, selected)];

  return (
    <div className="node-panel glass" key={selected}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="kind-badge" style={{ color: groupColorCss(model, model.group[selected]) }}>
          {KIND_NOUN[kind]}
        </span>
        {node.group >= 0 && <span className="chip" style={{ padding: '1px 8px', fontSize: 11 }}>{model.graph.groups[node.group].name}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ height: 26, padding: '0 8px' }} disabled={!history.length} onClick={back} title="Back (Backspace)">
          ←
        </button>
        <button className="btn" style={{ height: 26, padding: '0 8px' }} onClick={() => flyTo(selected)} title="Fly to (F)">
          Fly to
        </button>
        <button
          className="btn"
          style={{ height: 26, padding: '0 8px' }}
          title="Copy a link to this body"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? 'Copied' : 'Link'}
        </button>
        <button className="btn" style={{ height: 26, padding: '0 8px' }} onClick={() => select(-1)} title="Close (Esc)" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="node-title">{kind === KIND.file ? node.name : model.displayName[selected]}</div>
      {url ? (
        <a className="node-path" href={url} target="_blank" rel="noreferrer">
          {node.kind === 'external' ? node.name : `${node.path || '/'}${node.line > 1 && kind !== KIND.file ? `:${node.line}` : ''}`} ↗
        </a>
      ) : null}
      {parentId >= 0 && kind !== KIND.dir && kind !== KIND.file && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--muted)' }}>
          in{' '}
          <button className="btn" style={{ height: 22, fontSize: 12 }} onClick={() => select(parentId, { fly: true })}>
            {model.kind[parentId] === KIND.file ? model.graph.nodes[parentId].name : model.displayName[parentId]}
          </button>
        </div>
      )}
      <div className="metrics">
        {metrics.map(([label, value], i) =>
          label ? (
            <div className="metric" key={i}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ) : null,
        )}
      </div>
      <div className="panel-actions">
        <button
          className={`btn${routeFrom === selected ? ' active' : ''}`}
          onClick={() => (routeFrom === selected ? cancelRoute() : startRoute(selected))}
          title="Find the shortest call (or import) chain from this body to another"
        >
          {routeFrom === selected ? 'Pick a destination…' : 'Trace path to…'}
        </button>
      </div>
      {flags.length > 0 && (
        <div className="flags">
          {flags.map((f) => (
            <span key={f.label} className={`flag${f.tone ? ` ${f.tone}` : ''}`}>
              {f.label}
            </span>
          ))}
        </div>
      )}
      <div className="scroll" style={{ marginTop: 6, marginRight: -6, paddingRight: 6 }}>
        {sections.length === 0 && <div style={{ color: 'var(--muted)', marginTop: 12 }}>No connections found.</div>}
        {sections.map((s) => {
          const open = expanded[s.title];
          const items = open ? s.items : s.items.slice(0, LIST_LIMIT);
          return (
            <div key={s.title}>
              <div className="section-title">
                <span>
                  {s.title} ({s.items.length})
                </span>
              </div>
              {items.map((it) => (
                <NodeRow
                  key={it.id}
                  model={model}
                  id={it.id}
                  value={s.title === 'Declares' || s.title === 'Members' || s.title === 'Contents' ? undefined : it.weight > 1 ? `×${it.weight}` : undefined}
                  onPick={(id) => select(id, { fly: true })}
                />
              ))}
              {s.items.length > LIST_LIMIT && (
                <button className="btn" style={{ height: 24, fontSize: 11, marginTop: 2 }} onClick={() => setExpanded((e) => ({ ...e, [s.title]: !open }))}>
                  {open ? 'Show less' : `Show all ${s.items.length}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function countDescendantFiles(model: UniverseModel, id: number): number {
  let n = 0;
  const stack = [...model.children[id]];
  while (stack.length) {
    const c = stack.pop()!;
    if (model.kind[c] === KIND.file) n++;
    else if (model.kind[c] === KIND.dir) stack.push(...model.children[c]);
  }
  return n;
}
