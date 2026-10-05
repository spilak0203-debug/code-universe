'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useView } from '@/lib/store';
import type { UniverseRuntime } from '@/lib/viz/runtime';

/**
 * Every node is one instanced camera-facing quad; the fragment shader draws a
 * different celestial body per kind:
 *   0 dir → nebula, 1 file → star, 2 function → planet, 3 class → ringed planet,
 *   4 method → moon, 5 external package → distant beacon.
 */

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uViewportH;
  uniform float uHovered;
  uniform float uSelected;
  uniform float uRouteA;
  uniform float uRouteB;
  uniform float uIntro;

  attribute vec3 iPos;
  attribute vec3 iColor;
  attribute float iSize;
  attribute float iKind;
  attribute float iAlpha;
  attribute float iSeed;
  attribute float iIndex;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vKind;
  varying float vAlpha;
  varying float vSeed;
  varying float vPx;
  varying float vQuad;
  varying float vMark;

  float quadScale(float k) {
    if (k < 0.5) return 1.0;   // nebula: size is already its full extent
    if (k < 1.5) return 6.0;   // star: halo + diffraction spikes
    if (k < 2.5) return 2.0;   // planet glow
    if (k < 3.5) return 2.6;   // ringed planet
    if (k < 4.5) return 2.0;   // moon
    return 3.0;                // beacon
  }

  void main() {
    vQuad = quadScale(iKind);
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float depth = max(-mv.z, 0.001);
    float pxPerUnit = projectionMatrix[1][1] * uViewportH * 0.5 / depth;

    float hovered = 1.0 - step(0.5, abs(iIndex - uHovered));
    float selected = 1.0 - step(0.5, abs(iIndex - uSelected));
    float routeEnd = max(1.0 - step(0.5, abs(iIndex - uRouteA)), 1.0 - step(0.5, abs(iIndex - uRouteB)));
    vMark = max(max(hovered, selected), routeEnd);

    float size = iSize * (1.0 + 0.45 * hovered + selected * (0.3 + 0.15 * sin(uTime * 3.5)));
    // Keep distant bodies visible as ~1px points, trading size for brightness.
    float corePx = size * pxPerUnit;
    float minPx = iKind < 0.5 ? 0.0 : (iKind < 1.5 ? 1.4 : 0.9);
    float boost = corePx < minPx ? minPx / max(corePx, 1e-4) : 1.0;
    size *= boost;

    // Bodies brushing past the camera would fill the screen as blurry discs: fade them out.
    float nearFade = iKind < 0.5 ? 1.0 : smoothstep(iSize * 2.0, iSize * 7.0, depth);
    vAlpha = iAlpha * nearFade * (boost > 1.0 ? mix(0.45, 1.0, 1.0 / boost) : 1.0) * uIntro;
    vPx = size * pxPerUnit;
    mv.xy += position.xy * size * vQuad;
    gl_Position = projectionMatrix * mv;
    if (iAlpha < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

    vUv = position.xy * vQuad; // in units of the body radius
    vColor = iColor;
    vKind = iKind;
    vSeed = iSeed;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vKind;
  varying float vAlpha;
  varying float vSeed;
  varying float vPx;
  varying float vQuad;
  varying float vMark;

  void main() {
    vec2 p = vUv;
    float r = length(p);
    vec3 col = vColor;
    float a = 0.0;

    if (vKind < 0.5) {
      // Nebula: lumpy gaussian cloud.
      float ang = atan(p.y, p.x);
      float lobes = 0.75 + 0.25 * sin(ang * 3.0 + vSeed * 20.0) * sin(ang * 5.0 - vSeed * 7.0);
      float g = exp(-r * r * 3.2 / lobes);
      a = g * 0.075;
    } else if (vKind < 1.5) {
      // Star: hot core, soft halo, diffraction spikes. Up close the halo and
      // spikes fade so a big star doesn't swallow its own planets.
      float near = clamp(26.0 / max(vPx, 1.0), 0.12, 1.0);
      float core = exp(-r * r * 2.2);
      float halo = exp(-r * 1.15) * 0.42 * near;
      vec2 q = abs(p);
      float spikes = (exp(-q.x * 9.0) * exp(-q.y * 0.55) + exp(-q.y * 9.0) * exp(-q.x * 0.55)) * 0.55;
      spikes *= smoothstep(4.0, 14.0, vPx) * near;
      float twinkle = 0.88 + 0.12 * sin(uTime * 1.7 + vSeed * 61.0);
      col = mix(vColor, vec3(1.0), clamp(core * 1.1, 0.0, 1.0)) * (1.0 + core * mix(0.35, 1.3, near));
      a = (core * 1.25 + halo + spikes) * twinkle;
    } else if (vKind < 2.5 || (vKind > 3.5 && vKind < 4.5)) {
      // Planet / moon: lit sphere with atmosphere glow.
      float disc = 1.0 - smoothstep(0.86, 1.0, r);
      float z = sqrt(max(1.0 - r * r, 0.0));
      vec3 n = vec3(p, z);
      float light = clamp(dot(n, normalize(vec3(-0.45, 0.6, 0.65))), 0.0, 1.0);
      float rim = pow(1.0 - z, 2.5) * disc;
      float glow = exp(-max(r - 1.0, 0.0) * 4.0) * (1.0 - disc) * 0.5;
      col = vColor * (0.32 + 1.05 * light) * disc + vColor * (glow + rim * 0.8);
      a = disc * 0.95 + glow;
    } else if (vKind < 3.5) {
      // Ringed planet (class).
      float disc = 1.0 - smoothstep(0.86, 1.0, r);
      float z = sqrt(max(1.0 - r * r, 0.0));
      float light = clamp(dot(vec3(p, z), normalize(vec3(-0.45, 0.6, 0.65))), 0.0, 1.0);
      vec2 rp = vec2(p.x, p.y * 3.2 + p.x * 0.6);
      float rr = length(rp);
      float ringBand = smoothstep(0.22, 0.0, abs(rr - 1.85)) * (1.0 - step(0.0, p.y * 3.2 + p.x * 0.6) * disc);
      float glow = exp(-max(r - 1.0, 0.0) * 3.0) * (1.0 - disc) * 0.35;
      col = vColor * (0.35 + 1.0 * light) * disc + mix(vColor, vec3(1.0), 0.35) * ringBand * 0.9 + vColor * glow;
      a = disc * 0.95 + ringBand * 0.75 + glow;
    } else {
      // External package: hollow beacon ring.
      float ring = smoothstep(0.18, 0.0, abs(r - 1.0));
      float dot_ = exp(-r * r * 8.0);
      float pulse = 0.8 + 0.2 * sin(uTime * 2.0 + vSeed * 30.0);
      a = (ring * 0.85 + dot_ * 0.9 + exp(-r * 1.6) * 0.12) * pulse;
    }

    // Hover / selection ring, ~1.5 px wide at any zoom.
    if (vMark > 0.5 && vKind > 0.5) {
      float ringR = vKind < 1.5 ? 1.9 : 1.5;
      float w = 1.5 / max(vPx, 1.0);
      float m = (1.0 - smoothstep(w, w * 2.5, abs(r - ringR))) * (0.75 + 0.25 * sin(uTime * 4.0));
      col += mix(vColor, vec3(1.0), 0.5) * m * 0.5;
      a = max(a, m * 0.4);
    }

    a *= vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export function Bodies({ runtime }: { runtime: UniverseRuntime }) {
  const { model } = runtime;
  const size = useThree((s) => s.size);

  const { geometry, material, posAttr, alphaAttr } = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const posAttr = new THREE.InstancedBufferAttribute(runtime.positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const alphaAttr = new THREE.InstancedBufferAttribute(runtime.nodeAlpha, 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    const kinds = new Float32Array(model.n);
    const seeds = new Float32Array(model.n);
    const index = new Float32Array(model.n);
    for (let i = 0; i < model.n; i++) {
      kinds[i] = model.kind[i];
      seeds[i] = ((i * 2654435761) >>> 0) / 4294967296;
      index[i] = i;
    }
    geometry.setAttribute('iPos', posAttr);
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(model.color, 3));
    geometry.setAttribute('iSize', new THREE.InstancedBufferAttribute(model.size, 1));
    geometry.setAttribute('iKind', new THREE.InstancedBufferAttribute(kinds, 1));
    geometry.setAttribute('iAlpha', alphaAttr);
    geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geometry.setAttribute('iIndex', new THREE.InstancedBufferAttribute(index, 1));
    geometry.instanceCount = model.n;
    // Positions change every frame; skip frustum culling instead of recomputing bounds.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uViewportH: { value: 800 },
        uHovered: { value: -1 },
        uSelected: { value: -1 },
        uRouteA: { value: -1 },
        uRouteB: { value: -1 },
        uIntro: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry, material, posAttr, alphaAttr };
  }, [model, runtime]);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  useEffect(() => {
    material.uniforms.uViewportH.value = size.height;
  }, [material, size.height]);

  const uploaded = useMemo(() => ({ alpha: 0 }), []);
  useFrame((state) => {
    const { hovered, selected, spotlight } = useView.getState();
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uHovered.value = hovered;
    material.uniforms.uSelected.value = selected;
    material.uniforms.uRouteA.value = spotlight.type === 'path' ? spotlight.from : -1;
    material.uniforms.uRouteB.value = spotlight.type === 'path' ? spotlight.to : -1;
    material.uniforms.uIntro.value = Math.min(1, runtime.age / 1.2);
    posAttr.needsUpdate = true;
    if (uploaded.alpha !== runtime.alphaVersion) {
      uploaded.alpha = runtime.alphaVersion;
      alphaAttr.needsUpdate = true;
    }
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}
