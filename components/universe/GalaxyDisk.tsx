'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { UniverseRuntime } from '@/lib/viz/runtime';

/** Decorative interstellar dust: faint spiral arms and a warm core under the disk. */
const vertexShader = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uIntro;
  uniform float uRadius;
  varying vec2 vP;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  void main() {
    vec2 p = vP / uRadius;
    float r = length(p);
    float th = atan(p.y, p.x);
    float swirl = 2.0 * th - 7.5 * log(r + 0.06) + uTime * 0.025;
    float arms = pow(0.5 + 0.5 * cos(swirl), 3.0);
    float n = noise(p * 9.0 + vec2(uTime * 0.01, 0.0)) * 0.6 + noise(p * 23.0) * 0.4;
    float falloff = exp(-r * 2.6) * smoothstep(1.0, 0.55, r);
    float dust = (0.2 + 0.8 * arms) * falloff * (0.55 + 0.45 * n);
    float core = exp(-r * r * 90.0);
    vec3 col = mix(vec3(0.32, 0.4, 0.95), vec3(1.0, 0.78, 0.55), exp(-r * 5.0));
    gl_FragColor = vec4(col, (dust * 0.075 + core * 0.22) * uIntro);
  }
`;

export function GalaxyDisk({ runtime }: { runtime: UniverseRuntime }) {
  const mesh = useRef<THREE.Mesh>(null);
  const radius = useRef(runtime.extent * 1.45);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        // The disk is a unit circle scaled to the live galaxy extent each frame.
        uniforms: { uTime: { value: 0 }, uIntro: { value: 0 }, uRadius: { value: 1 } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useFrame((state, dt) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uIntro.value = Math.min(1, runtime.age / 3);
    radius.current += (runtime.extent * 1.45 - radius.current) * Math.min(1, dt * 2);
    mesh.current?.scale.setScalar(radius.current);
  });
  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2} material={material} renderOrder={0} frustumCulled={false}>
      <circleGeometry args={[1, 96]} />
    </mesh>
  );
}
