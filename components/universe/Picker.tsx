'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useView } from '@/lib/store';
import { KIND } from '@/lib/viz/model';
import type { UniverseRuntime } from '@/lib/viz/runtime';

const viewProj = new THREE.Matrix4();

/**
 * Screen-space picking: project every visible body and take the nearest one
 * within its on-screen radius. Far more forgiving than raycasting tiny,
 * constantly-moving billboards, and ~0.5 ms for 20k nodes.
 */
export function pickNode(runtime: UniverseRuntime, camera: THREE.Camera, px: number, py: number, w: number, h: number): number {
  const { model, positions, nodeAlpha } = runtime;
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = viewProj.elements;
  const focal = camera.projectionMatrix.elements[5] * h * 0.5;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < model.n; i++) {
    if (nodeAlpha[i] < 0.2) continue;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 0.01) continue;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w;
    const sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5) * h;
    const dx = sx - px, dy = sy - py;
    const d2 = dx * dx + dy * dy;
    const kind = model.kind[i];
    const radiusPx = (model.size[i] * focal) / cw;
    const hit = kind === KIND.dir ? Math.min(12, radiusPx * 0.15) : Math.max(radiusPx * (kind === KIND.file ? 1.4 : 1.2), 7);
    if (d2 > hit * hit) continue;
    const score = Math.sqrt(d2) / hit + (kind === KIND.dir ? 1 : 0) + (nodeAlpha[i] < 0.5 ? 0.5 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function Picker({ runtime }: { runtime: UniverseRuntime }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastClick = useRef({ id: -1, t: 0 });

  useEffect(() => {
    const el = gl.domElement;
    const local = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const onMove = (ev: PointerEvent) => {
      const p = local(ev);
      runtime.pointer.x = p.x;
      runtime.pointer.y = p.y;
      runtime.pointer.inside = true;
    };
    const onLeave = () => {
      runtime.pointer.inside = false;
      useView.getState().setHovered(-1);
    };
    const onDown = (ev: PointerEvent) => {
      const p = local(ev);
      down.current = { x: p.x, y: p.y, t: performance.now() };
    };
    const onUp = (ev: PointerEvent) => {
      const start = down.current;
      down.current = null;
      if (!start || ev.button !== 0) return;
      const p = local(ev);
      if (Math.hypot(p.x - start.x, p.y - start.y) > 5) return; // it was a drag
      // Click selects (highlights connections); double-click flies there.
      const { select } = useView.getState();
      const hovered = pickNode(runtime, camera, p.x, p.y, el.clientWidth, el.clientHeight);
      const now = performance.now();
      const isDouble = hovered >= 0 && lastClick.current.id === hovered && now - lastClick.current.t < 350;
      lastClick.current = { id: hovered, t: now };
      if (hovered >= 0) select(hovered, { fly: isDouble });
      else select(-1);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
  }, [gl, camera, runtime]);

  useFrame(() => {
    if (!runtime.pointer.inside || down.current) return;
    const { width, height } = runtime.viewport;
    const id = pickNode(runtime, camera, runtime.pointer.x, runtime.pointer.y, width, height);
    useView.getState().setHovered(id);
    gl.domElement.style.cursor = id >= 0 ? 'pointer' : 'grab';
  });

  return null;
}
