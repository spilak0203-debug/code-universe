'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import type * as THREE from 'three';

/**
 * Keep the camera's centre of projection in the middle of the canvas area the
 * HUD doesn't cover (left sidebar / right node panel on desktop, bottom sheet on
 * phones), so a focused body never hides behind a panel. Picking and labels read
 * the same projection matrix, so they stay consistent.
 */
export function ViewOffset() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
  const frame = useRef(0);

  useFrame((_, dt) => {
    const { width: W, height: H } = size;
    // Panel rects only change on interaction; sampling a few times a second is plenty.
    if (frame.current++ % 8 === 0) {
      let left = 0, right = 0, bottom = 0;
      const sidebar = document.querySelector('.sidebar:not(.collapsed)')?.getBoundingClientRect();
      const panel = document.querySelector('.node-panel')?.getBoundingClientRect();
      const narrow = W < 760;
      if (narrow) {
        if (panel) bottom = Math.max(0, H - panel.top);
      } else {
        if (sidebar && sidebar.right < W / 2) left = sidebar.right;
        if (panel && panel.left > W / 2) right = W - panel.left;
      }
      target.current.x = (left - right) / 2;
      target.current.y = -bottom / 2;
    }
    const k = 1 - Math.exp(-dt * 5);
    const c = current.current;
    c.x += (target.current.x - c.x) * k;
    c.y += (target.current.y - c.y) * k;
    if (Math.abs(c.x) < 0.5 && Math.abs(c.y) < 0.5 && !camera.view?.enabled) return;
    // A negative window offset moves the scene the opposite way: toward the free area.
    camera.setViewOffset(W, H, -c.x, -c.y, W, H);
  });

  return null;
}
