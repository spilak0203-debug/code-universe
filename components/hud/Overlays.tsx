'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useView } from '@/lib/store';
import { KIND_NOUN, groupColorCss, nodeColorCss } from '@/lib/viz/describe';
import { KIND, type UniverseModel } from '@/lib/viz/model';
import type { UniverseRuntime } from '@/lib/viz/runtime';

const v = new THREE.Vector3();

/** Project a world position to CSS pixels; returns false when behind the camera. */
function project(runtime: UniverseRuntime, x: number, y: number, z: number, out: { x: number; y: number; depth: number }): boolean {
  const cam = runtime.camera;
  if (!cam) return false;
  v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
  out.depth = -v.z;
  if (out.depth <= 0.1) return false;
  v.applyMatrix4(cam.projectionMatrix);
  out.x = (v.x * 0.5 + 0.5) * runtime.viewport.width;
  out.y = (0.5 - v.y * 0.5) * runtime.viewport.height;
  return true;
}

export function Tooltip({ runtime }: { runtime: UniverseRuntime }) {
  const hovered = useView((s) => s.hovered);
  const ref = useRef<HTMLDivElement>(null);
  const model = runtime.model;

  useEffect(() => {
    const update = () => {
      const el = ref.current;
      if (!el) return;
      el.style.left = `${runtime.pointer.x}px`;
      el.style.top = `${runtime.pointer.y}px`;
    };
    runtime.frameListeners.add(update);
    return () => void runtime.frameListeners.delete(update);
  }, [runtime]);

  if (hovered < 0 || !runtime.pointer.inside) return <div ref={ref} style={{ display: 'none' }} />;
  const node = model.graph.nodes[hovered];
  const kind = model.kind[hovered];
  const detail =
    kind === KIND.file
      ? `${node.loc} lines · ${model.children[hovered].length} symbols`
      : kind === KIND.dir
        ? `${node.loc} lines`
        : kind === KIND.external
          ? `${model.inEdges[hovered].length} importing files`
          : `${node.loc} lines · ${model.fanIn[hovered]} in · ${model.fanOut[hovered]} out`;
  return (
    <div ref={ref} className="tooltip glass" style={{ left: runtime.pointer.x, top: runtime.pointer.y }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="dot" style={{ color: nodeColorCss(model, hovered) }} />
        <span className="t-name">{kind === KIND.file ? node.name : model.displayName[hovered]}</span>
      </div>
      <div className="t-sub">
        {KIND_NOUN[kind]} · {detail}
      </div>
      {node.path && kind !== KIND.file && <div className="t-sub">{node.path}{node.line ? `:${node.line}` : ''}</div>}
      {kind === KIND.file && <div className="t-sub">{node.path}</div>}
    </div>
  );
}

interface LabelSpec {
  id: number;
  text: string;
  color: string;
  className: string;
  /** World-space anchor: a node id, or a group index for region labels. */
  group?: number;
  priority: number;
}

const MAX_LABELS = 36;
const AMBIENT_LABELS = 22;
const viewProj = new THREE.Matrix4();

/**
 * DOM labels positioned every frame from projected world positions:
 * region names when browsing, and the selection's neighbourhood when focused.
 */
export function Labels({ runtime }: { runtime: UniverseRuntime }) {
  const model = runtime.model;
  const focusNodes = useView((s) => s.focusNodes);
  const selected = useView((s) => s.selected);
  const spotlight = useView((s) => s.spotlight);
  const labelsOn = useView((s) => s.settings.labels);
  const hiddenGroups = useView((s) => s.hiddenGroups);
  const container = useRef<HTMLDivElement>(null);
  const ambientContainer = useRef<HTMLDivElement>(null);

  // Files belonging to each group, for centroid labels.
  const groupFiles = useMemo(() => {
    const out: number[][] = model.graph.groups.map(() => []);
    for (let i = 0; i < model.n; i++) if (model.kind[i] === KIND.file && model.group[i] >= 0) out[model.group[i]].push(i);
    return out;
  }, [model]);

  const specs = useMemo<LabelSpec[]>(() => {
    if (!labelsOn) return [];
    const focusing = selected >= 0 || spotlight.type !== 'none';
    if (!focusing) {
      return model.graph.groups
        .map((g, i) => ({ id: -1, group: i, text: g.name, color: groupColorCss(model, i), className: 'label group', priority: g.files }))
        .filter((s) => !hiddenGroups.has(s.group) && groupFiles[s.group].length > 0)
        .slice(0, 24);
    }
    if (spotlight.type === 'path') {
      // Number the bodies along the route; picked endpoints that aren't on it keep a plain label.
      const route = spotlight.path?.nodes ?? [];
      const extra = [spotlight.from, spotlight.to].filter((id) => !route.includes(id));
      return [
        ...route.map((id, i) => ({
          id,
          text: `${i + 1}. ${model.kind[id] === KIND.file ? model.graph.nodes[id].name : model.displayName[id]}`,
          color: i === 0 || i === route.length - 1 ? '#fff' : nodeColorCss(model, id),
          className: 'label',
          priority: MAX_LABELS - i,
        })),
        ...extra.map((id) => ({
          id,
          text: model.kind[id] === KIND.file ? model.graph.nodes[id].name : model.displayName[id],
          color: '#fff',
          className: 'label',
          priority: 0,
        })),
      ].slice(0, MAX_LABELS);
    }
    const ids = [...new Set([selected, ...focusNodes].filter((id) => id >= 0))].slice(0, MAX_LABELS);
    return ids.map((id, rank) => ({
      id,
      text: model.kind[id] === KIND.file ? model.graph.nodes[id].name : model.displayName[id],
      color: id === selected ? '#fff' : nodeColorCss(model, id),
      className: 'label',
      priority: MAX_LABELS - rank,
    }));
  }, [labelsOn, selected, spotlight, focusNodes, model, hiddenGroups, groupFiles]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const divs = Array.from(el.children) as HTMLDivElement[];
    // Label sizes don't change while specs are stable: measure once.
    const sizes = divs.map((d) => ({ w: d.offsetWidth, h: d.offsetHeight }));
    const p = { x: 0, y: 0, depth: 0 };
    const placed: number[] = [];
    const fits = (x0: number, y0: number, x1: number, y1: number) => {
      for (let q = 0; q < placed.length; q += 4) {
        if (x0 < placed[q + 2] && x1 > placed[q] && y0 < placed[q + 3] && y1 > placed[q + 1]) return false;
      }
      return true;
    };

    // Ambient labels: name whatever is large on screen right now (e.g. the planets of the
    // system you just flew to). Re-ranked every few frames; text only touched on change.
    const ambientDivs = ambientContainer.current ? (Array.from(ambientContainer.current.children) as HTMLDivElement[]) : [];
    const ambientIds = new Int32Array(ambientDivs.length).fill(-1);
    const ambientShown = new Int32Array(ambientDivs.length).fill(-2);
    const ambientW = new Float32Array(ambientDivs.length);
    const ambientH = new Float32Array(ambientDivs.length);
    const pinned = new Set(specs.map((s) => s.id));
    let frame = 0;
    const rankAmbient = () => {
      ambientIds.fill(-1);
      const cam = runtime.camera;
      if (!cam || !labelsOn) return;
      const e = viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
      const focal = cam.projectionMatrix.elements[5] * runtime.viewport.height * 0.5;
      const best: number[] = [];
      const bestPx: number[] = [];
      const pos = runtime.positions;
      for (let i = 0; i < model.n; i++) {
        const k = model.kind[i];
        if (k === KIND.dir || runtime.nodeAlpha[i] < 0.5 || pinned.has(i)) continue;
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 0.1) continue;
        const sx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
        const sy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
        if (sx < -1 || sx > 1 || sy < -1 || sy > 1) continue;
        const px = (model.size[i] * focal) / w;
        if (px < (k === KIND.file ? 5 : 3.2)) continue;
        // Keep the N largest (tiny insertion sort; N is small).
        if (best.length === ambientIds.length && px <= bestPx[best.length - 1]) continue;
        let at = best.length;
        while (at > 0 && bestPx[at - 1] < px) at--;
        best.splice(at, 0, i);
        bestPx.splice(at, 0, px);
        if (best.length > ambientIds.length) {
          best.pop();
          bestPx.pop();
        }
      }
      for (let k = 0; k < best.length; k++) ambientIds[k] = best[k];
    };

    const update = () => {
      const pos = runtime.positions;
      placed.length = 0;
      // Specs arrive in priority order; a label is dropped if it would overlap a more important one.
      for (let k = 0; k < specs.length; k++) {
        const spec = specs[k];
        const div = divs[k];
        if (!div) continue;
        let x = 0, y = 0, z = 0, lift = 0;
        if (spec.group !== undefined) {
          const files = groupFiles[spec.group];
          for (const f of files) {
            x += pos[f * 3];
            y += pos[f * 3 + 1];
            z += pos[f * 3 + 2];
          }
          x /= files.length;
          y /= files.length;
          z /= files.length;
        } else {
          x = pos[spec.id * 3];
          y = pos[spec.id * 3 + 1];
          z = pos[spec.id * 3 + 2];
          lift = model.size[spec.id];
        }
        const visible = project(runtime, x, y, z, p) && (spec.group !== undefined || runtime.nodeAlpha[spec.id] > 0.5);
        if (!visible) {
          div.style.opacity = '0';
          continue;
        }
        const offset = spec.group !== undefined ? 0 : Math.max(8, (lift * runtime.viewport.height) / p.depth) + 4;
        const { w, h } = sizes[k];
        const x0 = p.x - w / 2 - 3, x1 = p.x + w / 2 + 3, y1 = p.y - offset, y0 = y1 - h - 2;
        if (!fits(x0, y0, x1, y1)) {
          div.style.opacity = '0';
          continue;
        }
        placed.push(x0, y0, x1, y1);
        const alpha = spec.group !== undefined ? Math.min(0.85, Math.max(0.25, 1.4 - p.depth / (model.galaxyRadius * 3))) : 1;
        div.style.opacity = String(alpha * Math.min(1, runtime.age / 1.5));
        div.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - offset).toFixed(1)}px) translate(-50%, -100%)`;
      }

      if (frame++ % 4 === 0) rankAmbient();
      for (let k = 0; k < ambientDivs.length; k++) {
        const div = ambientDivs[k];
        const id = ambientIds[k];
        if (id < 0 || !project(runtime, pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2], p)) {
          div.style.opacity = '0';
          continue;
        }
        if (ambientShown[k] !== id) {
          ambientShown[k] = id;
          div.textContent = model.kind[id] === KIND.file ? model.graph.nodes[id].name : model.displayName[id];
          div.style.color = nodeColorCss(model, id);
          ambientW[k] = div.offsetWidth;
          ambientH[k] = div.offsetHeight;
        }
        const offset = Math.max(6, (model.size[id] * runtime.viewport.height) / p.depth) + 3;
        const w = ambientW[k], h = ambientH[k];
        const x0 = p.x - w / 2 - 2, x1 = p.x + w / 2 + 2, y1 = p.y - offset, y0 = y1 - h - 1;
        if (!fits(x0, y0, x1, y1)) {
          div.style.opacity = '0';
          continue;
        }
        placed.push(x0, y0, x1, y1);
        div.style.opacity = '0.78';
        div.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - offset).toFixed(1)}px) translate(-50%, -100%)`;
      }
    };
    runtime.frameListeners.add(update);
    return () => void runtime.frameListeners.delete(update);
  }, [runtime, specs, groupFiles, model, labelsOn]);

  return (
    <>
      <div className="labels" ref={container}>
        {specs.map((s) => (
          <div key={`${s.group ?? 'n'}-${s.id}`} className={s.className} style={{ color: s.color, opacity: 0 }}>
            {s.text}
          </div>
        ))}
      </div>
      <div className="labels" ref={ambientContainer}>
        {Array.from({ length: AMBIENT_LABELS }, (_, i) => (
          <div key={i} className="label ambient" style={{ opacity: 0 }} />
        ))}
      </div>
    </>
  );
}
