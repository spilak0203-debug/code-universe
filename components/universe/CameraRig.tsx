'use client';

import { CameraControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useView, type FocusRequest } from '@/lib/store';
import { KIND } from '@/lib/viz/model';
import type { UniverseRuntime } from '@/lib/viz/runtime';

const tmp = { x: 0, y: 0, z: 0 };
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();

/** How far to stand from a body so its whole system fits on screen. */
function viewDistance(runtime: UniverseRuntime, id: number): number {
  const m = runtime.model;
  switch (m.kind[id]) {
    case KIND.file:
      return Math.max(14, m.systemRadius[id] * 3.4 + 8);
    case KIND.class:
      return Math.max(8, m.systemRadius[id] * 4 + 4);
    case KIND.function:
    case KIND.method:
      return Math.max(6, m.size[id] * 12);
    case KIND.external:
      return 60;
    default: {
      // Directory: fit its files.
      const p = runtime.settledPosition(id, { x: 0, y: 0, z: 0 });
      let r = 20;
      const stack = [...m.children[id]];
      while (stack.length) {
        const c = stack.pop()!;
        if (m.kind[c] === KIND.file) {
          const q = runtime.settledPosition(c, tmp);
          r = Math.max(r, Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) + m.systemRadius[c]);
        } else if (m.kind[c] === KIND.dir) stack.push(...m.children[c]);
      }
      return m.parent[id] < 0 ? m.galaxyRadius * 2 : r * 2.4;
    }
  }
}

export function CameraRig({ runtime }: { runtime: UniverseRuntime }) {
  const controls = useRef<CameraControls>(null);
  const following = useRef(-1);
  const idleFor = useRef(0);
  /** Set on the first user camera interaction. */
  const touched = useRef(false);
  /** Set once the formed galaxy has been framed, so the intro drift doesn't override it. */
  const framed = useRef(false);
  /** Last focus request acted on, so a request made before the rig mounted is honoured exactly once. */
  const handledSeq = useRef(0);
  const camera = useThree((s) => s.camera);
  const R = runtime.model.galaxyRadius;

  // Intro: start far out and drift in while the galaxy forms.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.smoothTime = 0.55;
    c.draggingSmoothTime = 0.12;
    c.minDistance = 2;
    c.maxDistance = R * 12;
    c.setLookAt(0, R * 2.6, R * 4.2, 0, 0, 0, false);
    const t = setTimeout(() => {
      if (!framed.current) c.setLookAt(0, R * 1.2, R * 2.25, 0, 0, 0, true);
    }, 150);
    return () => clearTimeout(t);
  }, [R]);

  useEffect(() => {
    const fly = (id: number) => {
      const c = controls.current;
      if (!c || id < 0) return;
      const p = runtime.settledPosition(id, { x: 0, y: 0, z: 0 });
      const dist = viewDistance(runtime, id);
      // Keep the current viewing direction, slightly raised so systems read as disks.
      c.getPosition(v1, false);
      c.getTarget(v2, false);
      const dir = v1.sub(v2).normalize();
      if (Math.abs(dir.y) < 0.25) dir.y = 0.25;
      dir.normalize();
      c.setLookAt(p.x + dir.x * dist, p.y + dir.y * dist, p.z + dir.z * dist, p.x, p.y, p.z, true);
      following.current = runtime.model.kind[id] === KIND.dir ? -1 : id;
    };
    /** Frame a set of bodies: bounding sphere of their systems. */
    const frame = (ids: number[], minElevation = 0.3) => {
      const c = controls.current;
      if (!c || !ids.length) return;
      const m = runtime.model;
      let cx = 0, cy = 0, cz = 0;
      for (const id of ids) {
        const q = runtime.settledPosition(id, tmp);
        cx += q.x;
        cy += q.y;
        cz += q.z;
      }
      cx /= ids.length;
      cy /= ids.length;
      cz /= ids.length;
      // 90th-percentile extent: a couple of far-flung files shouldn't shrink everything else.
      const extents = ids.map((id) => {
        const q = runtime.settledPosition(id, tmp);
        return Math.hypot(q.x - cx, q.y - cy, q.z - cz) + m.systemRadius[id];
      });
      extents.sort((a, b) => a - b);
      const r = Math.max(10, extents[Math.min(extents.length - 1, Math.floor(extents.length * 0.9))]);
      // Fit by the narrower field of view so portrait screens see the whole disk too.
      const persp = camera as THREE.PerspectiveCamera;
      const vfov = (persp.fov ?? 50) * (Math.PI / 180);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (persp.aspect ?? 1));
      const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
      c.getPosition(v1, false);
      c.getTarget(v2, false);
      const dir = v1.sub(v2).normalize();
      if (Math.abs(dir.y) < minElevation) dir.y = minElevation;
      dir.normalize();
      c.setLookAt(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist, cx, cy, cz, true);
      following.current = -1;
    };
    /** Once the galaxy has formed, frame it — unless the user already took the controls. */
    const frameGalaxy = () => {
      const s = useView.getState();
      if (touched.current || s.selected >= 0 || s.focus) return;
      const files: number[] = [];
      for (let i = 0; i < runtime.model.n; i++) if (runtime.model.kind[i] === KIND.file) files.push(i);
      framed.current = true;
      frame(files, 0.55);
    };
    const handleFocus = (f: FocusRequest) => {
      if (f.seq === handledSeq.current) return;
      handledSeq.current = f.seq;
      framed.current = true;
      if (f.ids) frame(f.ids, f.elevation);
      else fly(f.id);
    };
    // The 3D bundle loads lazily, so the layout worker may already be done — and a deep link
    // already restored — by the time the rig mounts. Catch up on whatever happened meanwhile.
    const early = setTimeout(() => {
      const s = useView.getState();
      if (s.focus) handleFocus(s.focus);
      else if (s.layoutDone) frameGalaxy();
    }, 200);
    const unsubscribe = useView.subscribe((s, prev) => {
      if (s.focus && s.focus !== prev.focus) handleFocus(s.focus);
      if (s.layoutDone && !prev.layoutDone) frameGalaxy();
      if (s.selected !== prev.selected && s.selected < 0) following.current = -1;
    });
    return () => {
      clearTimeout(early);
      unsubscribe();
    };
  }, [runtime, camera]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const wake = () => {
      idleFor.current = 0;
      touched.current = true;
    };
    c.addEventListener('controlstart', wake);
    c.addEventListener('control', wake);
    return () => {
      c.removeEventListener('controlstart', wake);
      c.removeEventListener('control', wake);
    };
  }, []);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const { selected, settings } = useView.getState();
    idleFor.current += dt;
    // Follow an orbiting body so it stays centred.
    if (following.current >= 0 && following.current === selected) {
      const p = runtime.position(selected, tmp);
      c.moveTo(p.x, p.y, p.z, true);
    }
    if (settings.autoRotate && idleFor.current > 4 && selected < 0) {
      c.rotate(dt * 0.035 * Math.min(1, (idleFor.current - 4) / 3), 0, false);
    }
  });

  return <CameraControls ref={controls} camera={camera} makeDefault />;
}
