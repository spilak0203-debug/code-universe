import { create } from 'zustand';
import type { UniverseModel } from './viz/model';
import { findPath, type PathResult } from './viz/paths';

export type Spotlight =
  | { type: 'none' }
  | { type: 'cycle'; index: number }
  | { type: 'darkMatter' }
  | { type: 'group'; group: number }
  /** A traced route between two bodies; `path` is null when they aren't connected. */
  | { type: 'path'; from: number; to: number; path: PathResult | null };

export interface ViewSettings {
  /** Indexed by EDGE_INDEX: contains, import, call, render, inherit. */
  edgeKinds: [boolean, boolean, boolean, boolean, boolean];
  showMethods: boolean;
  showExternals: boolean;
  showNebulae: boolean;
  orbits: boolean;
  bloom: boolean;
  labels: boolean;
  autoRotate: boolean;
  /** Bend edges through their common ancestor directory (hierarchical edge bundling). */
  bundle: boolean;
}

export interface FocusRequest {
  /** Node to fly to, or -1 when framing a set of nodes (`ids`). */
  id: number;
  ids?: number[];
  /** Minimum camera elevation (y of the view direction) when framing `ids`. */
  elevation?: number;
  /** Monotonic counter so focusing the same node twice still triggers a flight. */
  seq: number;
}

interface ViewState {
  model: UniverseModel | null;
  hovered: number;
  selected: number;
  history: number[];
  focus: FocusRequest | null;
  spotlight: Spotlight;
  hiddenGroups: ReadonlySet<number>;
  settings: ViewSettings;
  layoutDone: boolean;
  /** Nodes highlighted by the current selection/spotlight (most relevant first). */
  focusNodes: number[];
  /** Start of a route being picked: the next selected body becomes its destination. -1 = not picking. */
  routeFrom: number;

  setModel(model: UniverseModel | null): void;
  setHovered(id: number): void;
  select(id: number, opts?: { fly?: boolean }): void;
  back(): void;
  flyTo(id: number): void;
  /** Clear the selection and frame every file star. */
  home(): void;
  setSpotlight(s: Spotlight): void;
  toggleGroup(group: number): void;
  soloGroup(group: number): void;
  showAllGroups(): void;
  updateSettings(patch: Partial<ViewSettings>): void;
  toggleEdgeKind(index: number): void;
  setLayoutDone(done: boolean): void;
  setFocusNodes(ids: number[]): void;
  startRoute(from: number): void;
  cancelRoute(): void;
  showRoute(from: number, to: number): void;
}

export const DEFAULT_SETTINGS: ViewSettings = {
  edgeKinds: [false, true, true, true, true],
  showMethods: true,
  showExternals: true,
  showNebulae: true,
  orbits: true,
  bloom: true,
  labels: true,
  autoRotate: false,
  bundle: true,
};

let focusSeq = 0;

export const useView = create<ViewState>((set, get) => ({
  model: null,
  hovered: -1,
  selected: -1,
  history: [],
  focus: null,
  spotlight: { type: 'none' },
  hiddenGroups: new Set(),
  settings: DEFAULT_SETTINGS,
  layoutDone: false,
  focusNodes: [],
  routeFrom: -1,

  setModel: (model) =>
    set({
      model,
      hovered: -1,
      selected: -1,
      history: [],
      focus: null,
      spotlight: { type: 'none' },
      hiddenGroups: new Set(),
      layoutDone: false,
      focusNodes: [],
      routeFrom: -1,
    }),
  setHovered: (hovered) => {
    if (get().hovered !== hovered) set({ hovered });
  },
  select: (id, opts) => {
    const { selected, history, routeFrom } = get();
    // While picking a route destination, the next body picked (click or search) completes it.
    if (routeFrom >= 0) {
      if (id >= 0 && id !== routeFrom) return get().showRoute(routeFrom, id);
      if (id < 0) set({ routeFrom: -1 });
    }
    if (id === selected && !opts?.fly) return;
    set({
      selected: id,
      history: selected >= 0 && id >= 0 && id !== selected ? [...history.slice(-30), selected] : id < 0 ? [] : history,
      spotlight: id >= 0 ? { type: 'none' } : get().spotlight,
      focus: opts?.fly && id >= 0 ? { id, seq: ++focusSeq } : get().focus,
    });
  },
  back: () => {
    const history = get().history;
    if (!history.length) return;
    const id = history[history.length - 1];
    set({ selected: id, history: history.slice(0, -1), focus: { id, seq: ++focusSeq } });
  },
  flyTo: (id) => set({ focus: { id, seq: ++focusSeq } }),
  home: () => {
    const model = get().model;
    if (!model) return;
    const ids = model.graph.nodes.filter((n) => n.kind === 'file').map((n) => n.id);
    set({ selected: -1, spotlight: { type: 'none' }, focus: { id: -1, ids, elevation: 0.55, seq: ++focusSeq } });
  },
  setSpotlight: (spotlight) => {
    const model = get().model;
    let ids: number[] | undefined;
    if (model && spotlight.type === 'cycle') ids = model.graph.cycles[spotlight.index];
    else if (model && spotlight.type === 'group') ids = model.graph.nodes.filter((n) => n.kind === 'file' && n.group === spotlight.group).map((n) => n.id);
    set({ spotlight, selected: -1, routeFrom: -1, focus: ids?.length ? { id: -1, ids, seq: ++focusSeq } : get().focus });
  },
  toggleGroup: (group) => {
    const next = new Set(get().hiddenGroups);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    set({ hiddenGroups: next });
  },
  soloGroup: (group) => {
    const model = get().model;
    if (!model) return;
    const hidden = get().hiddenGroups;
    const alreadySolo = !hidden.has(group) && hidden.size === model.graph.groups.length - 1;
    set({
      hiddenGroups: alreadySolo ? new Set() : new Set(model.graph.groups.map((_, i) => i).filter((i) => i !== group)),
    });
  },
  showAllGroups: () => set({ hiddenGroups: new Set() }),
  updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),
  toggleEdgeKind: (index) => {
    const edgeKinds = [...get().settings.edgeKinds] as ViewSettings['edgeKinds'];
    edgeKinds[index] = !edgeKinds[index];
    set({ settings: { ...get().settings, edgeKinds } });
  },
  setLayoutDone: (layoutDone) => set({ layoutDone }),
  setFocusNodes: (focusNodes) => set({ focusNodes }),
  startRoute: (from) => set({ routeFrom: from }),
  cancelRoute: () => set({ routeFrom: -1 }),
  showRoute: (from, to) => {
    const model = get().model;
    if (!model || from < 0 || to < 0 || from === to) return;
    const path = findPath(model, from, to);
    set({
      routeFrom: -1,
      selected: -1,
      spotlight: { type: 'path', from, to, path },
      focus: { id: -1, ids: path ? path.nodes : [from, to], seq: ++focusSeq },
    });
  },
}));
