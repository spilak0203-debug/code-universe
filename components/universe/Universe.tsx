'use client';

import { Stars } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { useEffect } from 'react';
import * as THREE from 'three';
import { useView } from '@/lib/store';
import { computeEmphasis } from '@/lib/viz/emphasis';
import type { UniverseRuntime } from '@/lib/viz/runtime';
import { Bodies } from './Bodies';
import { CameraRig } from './CameraRig';
import { Edges } from './Edges';
import { GalaxyDisk } from './GalaxyDisk';
import { Picker } from './Picker';
import { RouteComet } from './RouteComet';
import { ViewOffset } from './ViewOffset';

/** Advances the shared runtime before anything else renders this frame. */
function RuntimeDriver({ runtime }: { runtime: UniverseRuntime }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useFrame((_, dt) => {
    runtime.camera = camera;
    runtime.viewport.width = size.width;
    runtime.viewport.height = size.height;
    runtime.step(Math.min(dt, 0.1), useView.getState().settings.orbits);
  }, -10);
  return null;
}

/** Runs DOM overlay updaters after camera controls have moved the camera. */
function FrameListeners({ runtime }: { runtime: UniverseRuntime }) {
  useFrame(() => {
    for (const listener of runtime.frameListeners) listener();
  });
  return null;
}

/** Recompute highlight targets whenever selection, spotlight or filters change. */
function useEmphasisSync(runtime: UniverseRuntime) {
  useEffect(() => {
    const apply = () => {
      const s = useView.getState();
      const emphasis = computeEmphasis(runtime.model, {
        selected: s.selected,
        spotlight: s.spotlight,
        hiddenGroups: s.hiddenGroups,
        settings: s.settings,
      });
      runtime.setEmphasis(emphasis);
      s.setFocusNodes(emphasis.focusNodes);
    };
    apply();
    return useView.subscribe((s, p) => {
      if (s.selected !== p.selected || s.spotlight !== p.spotlight || s.hiddenGroups !== p.hiddenGroups || s.settings !== p.settings) {
        apply();
      }
    });
  }, [runtime]);
}

function Effects() {
  const bloom = useView((s) => s.settings.bloom);
  if (!bloom) return null;
  return (
    <EffectComposer multisampling={4}>
      <Bloom mipmapBlur intensity={0.8} luminanceThreshold={0.5} luminanceSmoothing={0.3} radius={0.72} />
      <Vignette offset={0.28} darkness={0.72} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}

export default function Universe({ runtime }: { runtime: UniverseRuntime }) {
  useEmphasisSync(runtime);
  const R = runtime.model.galaxyRadius;
  return (
    <Canvas
      className="universe-canvas"
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{ fov: 50, near: 0.5, far: R * 40, position: [0, R * 2.6, R * 4.2] }}
      onCreated={({ gl }) => gl.setClearColor('#03040b')}
    >
      <RuntimeDriver runtime={runtime} />
      <ViewOffset />
      <Stars radius={R * 8} depth={R * 4} count={7000} factor={R / 14} saturation={0.15} fade speed={0.4} />
      <GalaxyDisk runtime={runtime} />
      <Edges runtime={runtime} />
      <Bodies runtime={runtime} />
      <RouteComet runtime={runtime} />
      <Picker runtime={runtime} />
      <CameraRig runtime={runtime} />
      <FrameListeners runtime={runtime} />
      <Effects />
    </Canvas>
  );
}
