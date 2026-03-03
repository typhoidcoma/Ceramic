import { ATOM_TYPES, type Atom, type AtomPatch, type AtomState, type AtomType, enrichAtom } from "../data/types";
import { buildConstellationConnections, type AtomConnection } from "../layout/connections";
import { assignGridTargets, type FocusMode, type LayoutMode, type PanelLayout, type TreeEdge, type TreeStats } from "../layout/layout";

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
  panelLayouts: PanelLayout[];
  activePanelRank: number | null;
  connectionCount: number;
  treeStats: TreeStats;
  growthTime: number;
  growthPlaying: boolean;
  growthSpeed: "slow" | "normal" | "fast";
  focusMode: FocusMode;
  focusId: string | null;
};

type Listener = () => void;

const EMPTY_TREE_STATS: TreeStats = {
  trunkCount: 0,
  branchCount: 0,
  leafCount: 0,
  maxDepth: 0,
};

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
  private layoutMode: LayoutMode = "growth_tree";
  private panelLayouts: PanelLayout[] = [];
  private panelByAtomId = new Map<string, number>();
  private constellationConnections: AtomConnection[] = [];
  private treeEdges: TreeEdge[] = [];
  private treeStats: TreeStats = { ...EMPTY_TREE_STATS };
  private activePanelRank: number | null = null;
  private panelScaleByRank = new Map<number, number>();
  private growthTime = 0;
  private growthPlaying = true;
  private growthSpeed: "slow" | "normal" | "fast" = "normal";
  private focusMode: FocusMode = "selected";
  private focusId: string | null = null;
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
      panelLayouts: this.panelLayouts,
      activePanelRank: this.activePanelRank,
      connectionCount: this.constellationConnections.length,
      treeStats: this.treeStats,
      growthTime: this.growthTime,
      growthPlaying: this.growthPlaying,
      growthSpeed: this.growthSpeed,
      focusMode: this.focusMode,
      focusId: this.focusId,
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
    if (this.layoutMode === "growth_tree" && this.focusMode === "selected") {
      this.focusId = id;
    }
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
    if (types.has(type)) types.delete(type);
    else types.add(type);
    if (types.size === 0) types.add(type);
    this.filters = { ...this.filters, types };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  toggleState(state: AtomState): void {
    const states = new Set(this.filters.states);
    if (states.has(state)) states.delete(state);
    else states.add(state);
    if (states.size === 0) states.add(state);
    this.filters = { ...this.filters, states };
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  setLayoutMode(layoutMode: LayoutMode): void {
    if (this.layoutMode === layoutMode) return;
    this.layoutMode = layoutMode;
    if (layoutMode === "score" || layoutMode === "constellation" || layoutMode === "growth_tree") {
      this.activePanelRank = null;
    } else if (this.panelLayouts.length > 0) {
      this.activePanelRank = this.panelLayouts[0].rank;
    }
    if (layoutMode === "growth_tree") {
      this.growthTime = 0;
      this.growthPlaying = true;
      if (this.focusMode === "selected") this.focusId = this.selectedId;
    }
    this.layoutDirty = true;
    this.emit();
  }

  getPanelLayouts(): PanelLayout[] {
    return this.panelLayouts;
  }

  setPanelLayouts(layouts: PanelLayout[]): void {
    this.panelLayouts = layouts;
    if (this.layoutMode === "score" || this.layoutMode === "constellation" || this.layoutMode === "growth_tree") {
      this.activePanelRank = null;
      return;
    }
    if (layouts.length === 0) {
      this.activePanelRank = null;
      return;
    }
    if (this.activePanelRank === null || !layouts.some((panel) => panel.rank === this.activePanelRank)) {
      this.activePanelRank = layouts[0].rank;
    }
  }

  setActivePanel(rank: number | null): void {
    if (this.layoutMode === "score" || this.layoutMode === "constellation" || this.layoutMode === "growth_tree") return;
    if (rank !== null && !this.panelLayouts.some((panel) => panel.rank === rank)) return;
    if (this.activePanelRank === rank) return;
    this.activePanelRank = rank;
    this.emitView();
  }

  getActivePanel(): PanelLayout | null {
    if (this.activePanelRank === null) return null;
    return this.panelLayouts.find((panel) => panel.rank === this.activePanelRank) ?? null;
  }

  getAtomPanelRank(id: string | null): number | null {
    if (!id) return null;
    return this.panelByAtomId.get(id) ?? null;
  }

  getPanelScale(rank: number): number {
    return this.panelScaleByRank.get(rank) ?? 1;
  }

  setPanelScale(rank: number, scale: number): void {
    const clamped = Math.max(0.85, Math.min(2.4, scale));
    const prev = this.panelScaleByRank.get(rank) ?? 1;
    if (Math.abs(prev - clamped) < 0.001) return;
    this.panelScaleByRank.set(rank, clamped);
    this.layoutDirty = true;
    this.emitView();
  }

  resetPanelScale(rank: number): void {
    if (!this.panelScaleByRank.has(rank) || Math.abs((this.panelScaleByRank.get(rank) ?? 1) - 1) < 0.001) return;
    this.panelScaleByRank.set(rank, 1);
    this.layoutDirty = true;
    this.emitView();
  }

  setGrowthPlaying(next: boolean): void {
    if (this.growthPlaying === next) return;
    this.growthPlaying = next;
    this.emitView();
  }

  toggleGrowthPlaying(): void {
    this.setGrowthPlaying(!this.growthPlaying);
  }

  restartGrowth(): void {
    this.growthTime = 0;
    this.growthPlaying = true;
    this.emitView();
  }

  setGrowthSpeed(speed: "slow" | "normal" | "fast"): void {
    if (this.growthSpeed === speed) return;
    this.growthSpeed = speed;
    this.emitView();
  }

  setFocusMode(mode: FocusMode): void {
    if (this.focusMode === mode) return;
    this.focusMode = mode;
    if (mode === "off") this.focusId = null;
    else this.focusId = this.selectedId;
    this.emitView();
  }

  setFocusId(id: string | null): void {
    if (this.focusId === id) return;
    this.focusId = id;
    this.emitView();
  }

  tickGrowth(dtSec: number): void {
    if (this.layoutMode !== "growth_tree") return;
    if (!this.growthPlaying) return;
    const speed = this.growthSpeed === "slow" ? 0.12 : this.growthSpeed === "fast" ? 0.55 : 0.26;
    const next = Math.min(1, this.growthTime + dtSec * speed);
    if (Math.abs(next - this.growthTime) < 0.00001) return;
    this.growthTime = next;
    if (next >= 1) this.growthPlaying = false;
    this.emitView();
  }

  getFocusSet(maxDistance = 2): Set<string> {
    if (this.layoutMode !== "growth_tree" || this.focusMode === "off" || !this.focusId) return new Set();
    const adjacency = new Map<string, string[]>();
    for (const edge of this.treeEdges) {
      const a = adjacency.get(edge.parentId);
      if (a) a.push(edge.childId);
      else adjacency.set(edge.parentId, [edge.childId]);
      const b = adjacency.get(edge.childId);
      if (b) b.push(edge.parentId);
      else adjacency.set(edge.childId, [edge.parentId]);
    }
    const visited = new Set<string>([this.focusId]);
    let frontier = [this.focusId];
    for (let depth = 0; depth < maxDistance; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const neighbors = adjacency.get(id) ?? [];
        for (const neighbor of neighbors) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return visited;
  }

  upsertMany(
    input: Array<
      Omit<
        Atom,
        | "stableKey"
        | "score"
        | "sizeTier"
        | "targetX"
        | "targetY"
        | "targetZ"
        | "x"
        | "y"
        | "z"
        | "renderSize"
        | "treeDepth"
        | "treeRole"
        | "growthPhase"
        | "parentId"
        | "descendantCount"
      >
    >,
  ): void {
    const now = Date.now();
    for (const item of input) {
      const existing = this.atomMap.get(item.id);
      const enriched = enrichAtom(
        {
          ...item,
          x: existing?.x,
          y: existing?.y,
          z: existing?.z,
          targetX: existing?.targetX,
          targetY: existing?.targetY,
          targetZ: existing?.targetZ,
          treeDepth: existing?.treeDepth,
          treeRole: existing?.treeRole,
          growthPhase: existing?.growthPhase,
          parentId: existing?.parentId,
          descendantCount: existing?.descendantCount,
          ...(existing?.renderSize !== undefined ? { renderSize: existing.renderSize } : {}),
        },
        now,
      );
      this.atomMap.set(item.id, enriched);
    }
    this.visibleDirty = true;
    this.layoutDirty = true;
    if (this.layoutMode === "growth_tree") {
      this.growthTime = 0;
      this.growthPlaying = true;
    }
    this.emit();
  }

  patchOne(patch: AtomPatch): void {
    const existing = this.atomMap.get(patch.id);
    if (!existing) return;
    const merged = { ...existing, ...patch };
    const enriched = enrichAtom(merged, Date.now());
    this.atomMap.set(patch.id, enriched);
    this.visibleDirty = true;
    this.layoutDirty = true;
    if (this.layoutMode === "growth_tree") {
      this.growthTime = 0;
      this.growthPlaying = true;
    }
    this.emit();
  }

  removeOne(id: string): void {
    if (!this.atomMap.has(id)) return;
    this.atomMap.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.hoveredId === id) this.hoveredId = null;
    if (this.focusId === id) this.focusId = null;
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  clear(): void {
    if (this.atomMap.size === 0 && this.selectedId === null && this.hoveredId === null) return;
    this.atomMap.clear();
    this.selectedId = null;
    this.hoveredId = null;
    this.focusId = null;
    this.visibleAtomsCache = [];
    this.panelLayouts = [];
    this.panelByAtomId.clear();
    this.constellationConnections = [];
    this.treeEdges = [];
    this.treeStats = { ...EMPTY_TREE_STATS };
    this.activePanelRank = null;
    this.panelScaleByRank.clear();
    this.growthTime = 0;
    this.growthPlaying = true;
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

  recalcLayout(viewportWorldWidth: number, viewportWorldHeight: number, baseSize: number): void {
    const visible = this.getVisibleAtoms();
    if (visible.length === 0) {
      this.panelLayouts = [];
      this.panelByAtomId.clear();
      this.constellationConnections = [];
      this.treeEdges = [];
      this.treeStats = { ...EMPTY_TREE_STATS };
      this.activePanelRank = null;
      this.layoutDirty = false;
      this.emitView();
      return;
    }
    const grouped = assignGridTargets(visible, viewportWorldWidth, viewportWorldHeight, baseSize, this.layoutMode, this.panelScaleByRank);
    this.panelByAtomId = grouped.panelByAtomId;
    this.constellationConnections = this.layoutMode === "constellation" ? buildConstellationConnections(visible) : [];
    this.treeEdges = this.layoutMode === "growth_tree" ? grouped.treeEdges : [];
    this.treeStats = this.layoutMode === "growth_tree" ? grouped.treeStats : { ...EMPTY_TREE_STATS };
    this.setPanelLayouts(grouped.panels);
    if (this.layoutMode === "growth_tree") {
      this.growthTime = 0;
      this.growthPlaying = true;
      if (this.focusMode === "selected") this.focusId = this.selectedId;
    }
    this.layoutDirty = false;
    this.emitView();
  }

  getConnections(): AtomConnection[] {
    return this.constellationConnections;
  }

  getTreeEdges(): TreeEdge[] {
    return this.treeEdges;
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

export function buildMockAtoms(
  count = 20000,
): Array<
  Omit<
    Atom,
    | "stableKey"
    | "score"
    | "sizeTier"
    | "targetX"
    | "targetY"
    | "targetZ"
    | "x"
    | "y"
    | "z"
    | "renderSize"
    | "treeDepth"
    | "treeRole"
    | "growthPhase"
    | "parentId"
    | "descendantCount"
  >
> {
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
): Array<
  Omit<
    Atom,
    | "stableKey"
    | "score"
    | "sizeTier"
    | "targetX"
    | "targetY"
    | "targetZ"
    | "x"
    | "y"
    | "z"
    | "renderSize"
    | "treeDepth"
    | "treeRole"
    | "growthPhase"
    | "parentId"
    | "descendantCount"
  >
> {
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
