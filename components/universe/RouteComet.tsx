'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useView } from '@/lib/store';
import { BUNDLE, bezierAt, edgeCurve } from '@/lib/viz/bundling';
import type { UniverseRuntime } from '@/lib/viz/runtime';

/** Points in the comet: head first, fading tail behind it. */
const TRAIL = 36;
/** Gap between head and tail samples, as a fraction of the route length. */
const SPACING = 0.0045;

const vertexShader = /* glsl */ `
  attribute float aFade;
  attribute float aAlpha;
  uniform float uPixelRatio;
  varying float vFade;
  varying float vAlpha;
  void main() {
    vFade = aFade;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = mix(11.0, 2.0, aFade) * uPixelRatio;
    if (aAlpha < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying float vFade;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float glow = exp(-r * r * 4.0);
    vec3 col = mix(vec3(1.0), vec3(0.45, 0.9, 1.0), vFade);
    float a = glow * pow(1.0 - vFade, 1.6) * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col * (1.4 - vFade), a);
  }
`;

/**
 * While a route is shown, a comet runs from its start to its end along the same
 * bundled Bézier curves the edges are drawn with.
 */
export function RouteComet({ runtime }: { runtime: UniverseRuntime }) {
  const spotlight = useView((s) => s.spotlight);
  const dpr = useThree((s) => s.viewport.dpr);
  const edges = spotlight.type === 'path' && spotlight.path ? spotlight.path.edges : null;

  const { geometry, material, posAttr, alphaAttr } = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const fade = new Float32Array(TRAIL);
    for (let i = 0; i < TRAIL; i++) fade[i] = i / (TRAIL - 1);
    const posAttr = new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const alphaAttr = new THREE.BufferAttribute(new Float32Array(TRAIL), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
    geometry.setAttribute('aAlpha', alphaAttr);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uPixelRatio: { value: 1 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry, material, posAttr, alphaAttr };
  }, []);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  // Per-route scratch: control polygons and cumulative chord lengths.
  const curves = useMemo(() => {
    const m = edges?.length ?? 0;
    return {
      start: new Float32Array(m * 3),
      c1: new Float32Array(m * 3),
      c2: new Float32Array(m * 3),
      end: new Float32Array(m * 3),
      cumulative: new Float32Array(m + 1),
      born: performance.now(),
    };
  }, [edges]);

  useFrame(() => {
    material.uniforms.uPixelRatio.value = dpr;
    const alpha = alphaAttr.array as Float32Array;
    if (!edges || edges.length === 0) {
      if (alpha[0] !== 0) {
        alpha.fill(0);
        alphaAttr.needsUpdate = true;
      }
      return;
    }
    const { start, c1, c2, end, cumulative } = curves;
    const bundle = useView.getState().settings.bundle ? BUNDLE : 0;
    const m = edges.length;
    for (let i = 0; i < m; i++) {
      edgeCurve(runtime.model, runtime.positions, edges[i], bundle, start, c1, c2, end, i * 3);
      const o = i * 3;
      // Control-polygon length: cheap and close enough to the arc length for pacing.
      const seg =
        Math.hypot(c1[o] - start[o], c1[o + 1] - start[o + 1], c1[o + 2] - start[o + 2]) +
        Math.hypot(c2[o] - c1[o], c2[o + 1] - c1[o + 1], c2[o + 2] - c1[o + 2]) +
        Math.hypot(end[o] - c2[o], end[o + 1] - c2[o + 1], end[o + 2] - c2[o + 2]);
      cumulative[i + 1] = cumulative[i] + Math.max(seg, 1e-3);
    }
    const total = cumulative[m];
    // Traverse the whole route in 2.5–6 s regardless of its size, then pause briefly.
    const duration = Math.min(6, 2.5 + m * 0.6);
    const cycle = duration + 0.6;
    const elapsed = ((performance.now() - curves.born) / 1000) % cycle;
    const head = (elapsed / duration) * total;
    const pos = posAttr.array as Float32Array;
    let edge = m - 1;
    for (let k = 0; k < TRAIL; k++) {
      const d = head - k * SPACING * total;
      if (d < 0 || d > total) {
        alpha[k] = 0;
        continue;
      }
      // The trail walks backwards, so the containing edge index only decreases.
      while (edge > 0 && cumulative[edge] > d) edge--;
      while (edge < m - 1 && cumulative[edge + 1] < d) edge++;
      const t = (d - cumulative[edge]) / (cumulative[edge + 1] - cumulative[edge]);
      bezierAt(start, c1, c2, end, edge * 3, Math.min(1, Math.max(0, t)), pos, k * 3);
      alpha[k] = 1;
    }
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}
