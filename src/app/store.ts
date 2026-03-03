import { ATOM_TYPES, type Atom, type AtomPatch, type AtomState, type AtomType, enrichAtom } from "../data/types";
import { assignGridTargets, type LayoutMode } from "../layout/layout";

export type Filters = {
  types: Set<AtomType>;
  states: Set<AtomState>;
  query: string;
};

type Snapshot = {
  selectedId: string | null;
  hoveredId: string | null;
  totalCount: number;
  visibleCount: number;
  fps: number;
  filters: Filters;
  layoutMode: LayoutMode;
};

type Listener = () => void;

export class AtomStore {
  private atomMap = new Map<string, Atom>();
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private listeners = new Set<Listener>();
  private viewListeners = new Set<Listener>();
  private visibleAtomsCache: Atom[] = [];
  private visibleDirty = true;
  private layoutDirty = true;
  private fps = 0;
  private viewVersion = 0;
  private layoutMode: LayoutMode = "score";
  private filters: Filters = {
    types: new Set(ATOM_TYPES),
    states: new Set(["new", "active", "snoozed", "done"]),
    query: "",
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeView(listener: Listener): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  getSnapshot(): Snapshot {
    return {
      selectedId: this.selectedId,
      hoveredId: this.hoveredId,
      totalCount: this.atomMap.size,
      visibleCount: this.getVisibleAtoms().length,
      fps: this.fps,
      filters: this.filters,
      layoutMode: this.layoutMode,
    };
  }

  getViewVersion(): number {
    return this.viewVersion;
  }

  setFps(fps: number): void {
    this.fps = fps;
    this.emitView();
  }

  getAtoms(): Atom[] {
    return [...this.atomMap.values()];
  }

  getAtomById(id: string | null): Atom | null {
    if (!id) return null;
    return this.atomMap.get(id) ?? null;
  }

  getSelectedAtom(): Atom | null {
    return this.getAtomById(this.selectedId);
  }

  getHoveredAtom(): Atom | null {
    return this.getAtomById(this.hoveredId);
  }

  setHover(id: string | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.emitView();
  }

  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit();
  }

  setQuery(query: string): void {
    this.filters = { ...this.filters, query: query.trim().toLowerCase() };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  toggleType(type: AtomType): void {
    const types = new Set(this.filters.types);
    if (types.has(type)) {
      types.delete(type);
    } else {
      types.add(type);
    }
    if (types.size === 0) {
      types.add(type);
    }
    this.filters = { ...this.filters, types };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  toggleState(state: AtomState): void {
    const states = new Set(this.filters.states);
    if (states.has(state)) {
      states.delete(state);
    } else {
      states.add(state);
    }
    if (states.size === 0) {
      states.add(state);
    }
    this.filters = { ...this.filters, states };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  setLayoutMode(layoutMode: LayoutMode): void {
    if (this.layoutMode === layoutMode) return;
    this.layoutMode = layoutMode;
    this.layoutDirty = true;
    this.emit();
  }

  upsertMany(input: Array<Omit<Atom, "stableKey" | "score" | "sizeTier" | "targetX" | "targetY" | "x" | "y">>): void {
    const now = Date.now();
    for (const item of input) {
      const existing = this.atomMap.get(item.id);
      const enriched = enrichAtom({ ...item, x: existing?.x, y: existing?.y, targetX: existing?.targetX, targetY: existing?.targetY }, now);
      this.atomMap.set(item.id, enriched);
    }
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  patchOne(patch: AtomPatch): void {
    const existing = this.atomMap.get(patch.id);
    if (!existing) return;
    const merged = {
      ...existing,
      ...patch,
    };
    const enriched = enrichAtom(merged, Date.now());
    this.atomMap.set(patch.id, enriched);
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  removeOne(id: string): void {
    if (!this.atomMap.has(id)) return;
    this.atomMap.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.hoveredId === id) this.hoveredId = null;
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  clear(): void {
    if (this.atomMap.size === 0 && this.selectedId === null && this.hoveredId === null) return;
    this.atomMap.clear();
    this.selectedId = null;
    this.hoveredId = null;
    this.visibleAtomsCache = [];
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  getVisibleAtoms(): Atom[] {
    if (!this.visibleDirty) return this.visibleAtomsCache;
    const query = this.filters.query;
    this.visibleAtomsCache = [...this.atomMap.values()].filter((atom) => {
      if (!this.filters.types.has(atom.type)) return false;
      if (!this.filters.states.has(atom.state)) return false;
      if (!query) return true;
      const title = atom.title?.toLowerCase() ?? "";
      const preview = atom.preview?.toLowerCase() ?? "";
      return title.includes(query) || preview.includes(query) || atom.id.includes(query);
    });
    this.visibleDirty = false;
    return this.visibleAtomsCache;
  }

  recalcLayout(viewportWorldWidth: number, baseSize: number): void {
    const visible = this.getVisibleAtoms();
    if (visible.length === 0) {
      this.layoutDirty = false;
      return;
    }
    assignGridTargets(visible, viewportWorldWidth, baseSize, this.layoutMode);
    this.layoutDirty = false;
  }

  needsLayout(): boolean {
    return this.layoutDirty;
  }

  markLayoutDirty(): void {
    this.layoutDirty = true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
    this.emitView();
  }

  private emitView(): void {
    this.viewVersion += 1;
    for (const listener of this.viewListeners) listener();
  }
}

function randomChoice<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function randomId(): string {
  return crypto.randomUUID();
}

export function buildMockAtoms(count = 20000): Array<Omit<Atom, "stableKey" | "score" | "sizeTier" | "targetX" | "targetY" | "x" | "y">> {
  const now = Date.now();
  const states: AtomState[] = ["new", "active", "snoozed", "done"];
  return Array.from({ length: count }, (_, i) => {
    const ts = now - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 30);
    const due = Math.random() > 0.7 ? now + Math.floor((Math.random() - 0.5) * 1000 * 60 * 60 * 24 * 14) : undefined;
    return {
      id: randomId(),
      type: randomChoice(ATOM_TYPES),
      state: randomChoice(states),
      ts,
      due,
      urgency: Math.random(),
      importance: Math.random(),
      title: `Atom ${i + 1}`,
      preview: `Synthetic atom ${i + 1} for GPU load testing.`,
      payload: { index: i, source: "mock" },
    };
  });
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSeededDemoAtoms(
  count = 10000,
  seed = 1337,
): Array<Omit<Atom, "stableKey" | "score" | "sizeTier" | "targetX" | "targetY" | "x" | "y">> {
  const now = Date.now();
  const random = mulberry32(seed);
  const states: AtomState[] = ["new", "active", "snoozed", "done"];
  const clusterCount = 12;
  const clusters = Array.from({ length: clusterCount }, (_, i) => ({
    centerDaysAgo: i * 2,
    urgencyBias: 0.2 + (i % 4) * 0.18,
    importanceBias: 0.25 + ((i + 2) % 5) * 0.14,
  }));

  return Array.from({ length: count }, (_, i) => {
    const cluster = clusters[i % clusters.length];
    const ts = now - Math.floor((cluster.centerDaysAgo + random() * 5) * 24 * 60 * 60 * 1000);
    const dueChance = random();
    let due: number | undefined;
    if (dueChance < 0.2) due = now - Math.floor(random() * 3 * 24 * 60 * 60 * 1000);
    else if (dueChance < 0.72) due = now + Math.floor(random() * 8 * 24 * 60 * 60 * 1000);

    const urgency = Math.max(0, Math.min(1, cluster.urgencyBias + (random() - 0.5) * 0.4));
    const importance = Math.max(0, Math.min(1, cluster.importanceBias + (random() - 0.5) * 0.45));
    return {
      id: `demo-${seed}-${i}`,
      type: ATOM_TYPES[Math.floor(random() * ATOM_TYPES.length)],
      state: states[Math.floor(random() * states.length)],
      ts,
      due,
      urgency,
      importance,
      title: `Demo Atom ${i + 1}`,
      preview: `Cluster ${i % clusterCount} with urgency ${urgency.toFixed(2)} and importance ${importance.toFixed(2)}.`,
      payload: {
        source: "demo-seed",
        seed,
        index: i,
        cluster: i % clusterCount,
      },
    };
  });
}
