'use client';

import { useEffect } from 'react';
import { useView } from '@/lib/store';
import { KIND, type UniverseModel } from '@/lib/viz/model';

/** Stable, human-readable key for a node: `path`, `path/`, `path#Class.method`, `pkg:react`. */
export function nodeKey(model: UniverseModel, id: number): string {
  const node = model.graph.nodes[id];
  switch (model.kind[id]) {
    case KIND.file:
      return node.path;
    case KIND.dir:
      return `${node.path}/`;
    case KIND.external:
      return `pkg:${node.name}`;
    default:
      return `${node.path}#${model.displayName[id]}`;
  }
}

/**
 * Keep the URL in sync with what's on screen — `?focus=` for a selected body,
 * `?from=…&to=…` for a traced path — and restore it once the galaxy has formed.
 */
export function useDeepLink(model: UniverseModel) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = { focus: params.get('focus'), from: params.get('from'), to: params.get('to') };
    let restored = !wanted.focus && !(wanted.from && wanted.to);
    const lookup = (key: string | null) => {
      if (!key) return -1;
      for (let i = 0; i < model.n; i++) if (nodeKey(model, i) === key) return i;
      return -1;
    };
    const restore = () => {
      if (restored) return;
      restored = true;
      const from = lookup(wanted.from);
      const to = lookup(wanted.to);
      if (from >= 0 && to >= 0) useView.getState().showRoute(from, to);
      else {
        const id = lookup(wanted.focus);
        if (id >= 0) useView.getState().select(id, { fly: true });
      }
    };
    // Fly once the layout has settled enough for positions to mean something.
    const timer = setTimeout(restore, 1800);
    const unsubscribe = useView.subscribe((s, prev) => {
      if (s.layoutDone && !prev.layoutDone) restore();
      if (s.selected === prev.selected && s.spotlight === prev.spotlight) return;
      const url = new URL(window.location.href);
      if (s.selected >= 0) url.searchParams.set('focus', nodeKey(model, s.selected));
      else url.searchParams.delete('focus');
      if (s.spotlight.type === 'path') {
        url.searchParams.set('from', nodeKey(model, s.spotlight.from));
        url.searchParams.set('to', nodeKey(model, s.spotlight.to));
      } else {
        url.searchParams.delete('from');
        url.searchParams.delete('to');
      }
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [model]);
}
