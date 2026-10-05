'use client';

import { useEffect, useRef } from 'react';
import { useView, type ViewSettings } from '@/lib/store';
import { EDGE_LABEL } from '@/lib/viz/describe';
import { EDGE_COLOR_CSS } from '@/lib/viz/palette';
import type { UniverseModel } from '@/lib/viz/model';

const EDGE_ORDER = [1, 2, 3, 4] as const;

const VIEW_TOGGLES: { key: keyof ViewSettings; label: string; title: string }[] = [
  { key: 'showMethods', label: 'Moons', title: 'Show class methods orbiting their classes' },
  { key: 'showExternals', label: 'Packages', title: 'Show npm / node packages on the outer ring' },
  { key: 'showNebulae', label: 'Nebulae', title: 'Show directory nebulae' },
  { key: 'bundle', label: 'Bundle', title: 'Curve edges through their common directory (hierarchical edge bundling)' },
  { key: 'orbits', label: 'Orbits', title: 'Animate planetary orbits' },
  { key: 'labels', label: 'Labels', title: 'Show labels' },
  { key: 'bloom', label: 'Bloom', title: 'Glow post-processing (disable on slow GPUs)' },
  { key: 'autoRotate', label: 'Drift', title: 'Slowly rotate the camera when idle' },
];

export function Toolbar({ model }: { model: UniverseModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const settings = useView((s) => s.settings);
  // The toolbar wraps on narrower screens; panels below it read its bottom edge from a CSS variable.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      document.documentElement.style.setProperty('--toolbar-bottom', `${Math.round(el.getBoundingClientRect().bottom)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const toggleEdgeKind = useView((s) => s.toggleEdgeKind);
  const updateSettings = useView((s) => s.updateSettings);
  const stats = model.graph.stats;
  const counts = [0, stats.importEdges, stats.callEdges, stats.renderEdges, stats.inheritEdges];

  return (
    <div className="toolbar glass" ref={ref}>
      {EDGE_ORDER.map((k) =>
        counts[k] === 0 && k > 2 ? null : (
          <button
            key={k}
            className={`toggle ${settings.edgeKinds[k] ? 'on' : 'off'}`}
            style={{ color: settings.edgeKinds[k] ? undefined : 'var(--muted)' }}
            onClick={() => toggleEdgeKind(k)}
            title={`${EDGE_LABEL[k]} edges (${counts[k]})`}
          >
            <span className="swatch" style={{ color: EDGE_COLOR_CSS[k] }} />
            {EDGE_LABEL[k]}
          </button>
        ),
      )}
      <span className="divider" />
      {VIEW_TOGGLES.map((t) => (
        <button
          key={t.key}
          className={`toggle ${settings[t.key] ? 'on' : 'off'}`}
          onClick={() => updateSettings({ [t.key]: !settings[t.key] })}
          title={t.title}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
