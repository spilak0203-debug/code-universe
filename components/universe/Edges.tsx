'use client';

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useView } from '@/lib/store';
import { BUNDLE, edgeCurve } from '@/lib/viz/bundling';
import { EDGE_COLORS } from '@/lib/viz/palette';
import type { UniverseRuntime } from '@/lib/viz/runtime';

/** Base opacity by edge kind: contains, import, call, render, inherit. */
const KIND_BASE = [0.25, 0.55, 0.85, 0.85, 1.0];

/**
 * Every edge is one instance of a shared line strip (t = 0…1). The vertex
 * shader evaluates a cubic Bézier start → c1 → c2 → end, so the CPU only writes
 * 12 floats per edge per frame no matter how smooth the curve is.
 */
const vertexShader = /* glsl */ `
  attribute float aT;
  attribute vec3 iStart;
  attribute vec3 iC1;
  attribute vec3 iC2;
  attribute vec3 iEnd;
  attribute vec3 iColor;
  attribute float iAlpha;
  attribute float iSeed;
  varying float vT;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  uniform float uIntro;
  void main() {
    float t = aT;
    float u = 1.0 - t;
    vec3 p = u * u * u * iStart + 3.0 * u * u * t * iC1 + 3.0 * u * t * t * iC2 + t * t * t * iEnd;
    vT = t;
    vColor = iColor;
    vAlpha = iAlpha * uIntro;
    vSeed = iSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    if (iAlpha < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  varying float vT;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    // Pulses travel from caller/importer (t = 0) to callee/importee (t = 1).
    float phase = fract(vT * 1.5 - uTime * 0.4 + vSeed);
    float pulse = smoothstep(0.72, 0.97, phase) * (1.0 - smoothstep(0.97, 1.0, phase));
    float emphasis = smoothstep(0.3, 0.9, vAlpha);
    float ends = smoothstep(0.0, 0.05, vT) * smoothstep(1.0, 0.95, vT);
    // Brighter toward the target so direction reads even without motion.
    float grad = mix(0.55, 1.0, vT);
    float a = vAlpha * ends * grad * (0.6 + pulse * mix(0.5, 2.4, emphasis));
    vec3 col = vColor * (1.0 + pulse * mix(0.3, 1.6, emphasis));
    if (a < 0.002) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export function Edges({ runtime }: { runtime: UniverseRuntime }) {
  const { model } = runtime;
  const E = model.edgeCount;
  // Fewer segments for huge graphs; curves stay smooth because they're gentle.
  const segments = E > 30000 ? 6 : E > 10000 ? 10 : 16;

  const { geometry, material, startAttr, c1Attr, c2Attr, endAttr, alphaAttr } = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry();
    const t = new Float32Array(segments + 1);
    for (let i = 0; i <= segments; i++) t[i] = i / segments;
    const index: number[] = [];
    for (let i = 0; i < segments; i++) index.push(i, i + 1);
    // `position` is required by three's attribute bookkeeping; the shader ignores it.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((segments + 1) * 3), 3));
    geometry.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    geometry.setIndex(index);

    const color = new Float32Array(E * 3);
    const seed = new Float32Array(E);
    for (let e = 0; e < E; e++) {
      const kind = model.edgeKind[e];
      const kc = EDGE_COLORS[kind];
      const s = model.edgeSource[e] * 3;
      const base = KIND_BASE[kind] * (model.edgeTypeOnly[e] ? 0.45 : 1) * (1 + Math.min(Math.log2(model.edgeWeight[e]), 3) * 0.12);
      color[e * 3] = (kc[0] * 0.8 + model.color[s] * 0.2) * base;
      color[e * 3 + 1] = (kc[1] * 0.8 + model.color[s + 1] * 0.2) * base;
      color[e * 3 + 2] = (kc[2] * 0.8 + model.color[s + 2] * 0.2) * base;
      seed[e] = ((e * 2654435761) >>> 0) / 4294967296;
    }
    const dyn = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(E * size), size).setUsage(THREE.DynamicDrawUsage);
    const startAttr = dyn(3);
    const c1Attr = dyn(3);
    const c2Attr = dyn(3);
    const endAttr = dyn(3);
    const alphaAttr = new THREE.InstancedBufferAttribute(runtime.edgeAlpha, 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iStart', startAttr);
    geometry.setAttribute('iC1', c1Attr);
    geometry.setAttribute('iC2', c2Attr);
    geometry.setAttribute('iEnd', endAttr);
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(color, 3));
    geometry.setAttribute('iAlpha', alphaAttr);
    geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geometry.instanceCount = E;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uTime: { value: 0 }, uIntro: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry, material, startAttr, c1Attr, c2Attr, endAttr, alphaAttr };
  }, [E, model, runtime, segments]);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  const uploaded = useMemo(() => ({ alpha: 0 }), []);

  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uIntro.value = Math.min(1, Math.max(0, (runtime.age - 0.6) / 1.5));
    const bundle = useView.getState().settings.bundle ? BUNDLE : 0;
    const p = runtime.positions;
    const alpha = runtime.edgeAlpha;
    const start = startAttr.array as Float32Array;
    const c1 = c1Attr.array as Float32Array;
    const c2 = c2Attr.array as Float32Array;
    const end = endAttr.array as Float32Array;
    for (let e = 0; e < E; e++) {
      if (alpha[e] >= 0.002) edgeCurve(model, p, e, bundle, start, c1, c2, end, e * 3);
    }
    startAttr.needsUpdate = true;
    c1Attr.needsUpdate = true;
    c2Attr.needsUpdate = true;
    endAttr.needsUpdate = true;
    if (uploaded.alpha !== runtime.alphaVersion) {
      uploaded.alpha = runtime.alphaVersion;
      alphaAttr.needsUpdate = true;
    }
  });

  return <lineSegments geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}
