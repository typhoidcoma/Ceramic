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

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type TimeProfile = {
  startDaysAgo: number;
  spanDays: number;
  weight: number;
  dueLeadMinDays: number;
  dueLeadMaxDays: number;
  noDueChance: number;
  urgencyBias: number;
  importanceBias: number;
};

function weightedIndex(random: () => number, profiles: TimeProfile[]): number {
  const totalWeight = profiles.reduce((acc, profile) => acc + profile.weight, 0);
  let value = random() * totalWeight;
  for (let i = 0; i < profiles.length; i += 1) {
    value -= profiles[i].weight;
    if (value <= 0) return i;
  }
  return profiles.length - 1;
}

function sampleWorklikeTimestamp(random: () => number, now: number, startDaysAgo: number, spanDays: number): number {
  const dayOffset = startDaysAgo + random() * spanDays;
  const dayBase = now - dayOffset * DAY_MS;
  const primaryHour = 7 + Math.floor(random() * 12); // 07:00-18:59
  const offHour = Math.floor(random() * 24);
  const hour = random() < 0.82 ? primaryHour : offHour;
  const minute = Math.floor(random() * 60);
  return dayBase - (dayBase % DAY_MS) + hour * HOUR_MS + minute * MINUTE_MS + Math.floor(random() * 10 * MINUTE_MS);
}

function computeStateForTiming(random: () => number, due: number | undefined, now: number): AtomState {
  const roll = random();
  if (due === undefined) {
    if (roll < 0.12) return "new";
    if (roll < 0.7) return "active";
    if (roll < 0.85) return "snoozed";
    return "done";
  }
  const dueDeltaDays = (due - now) / DAY_MS;
  if (dueDeltaDays < -3) {
    if (roll < 0.62) return "done";
    if (roll < 0.84) return "active";
    return "snoozed";
  }
  if (dueDeltaDays < 0) {
    if (roll < 0.64) return "active";
    if (roll < 0.9) return "done";
    return "new";
  }
  if (dueDeltaDays < 2) {
    if (roll < 0.58) return "active";
    if (roll < 0.82) return "new";
    return "snoozed";
  }
  if (roll < 0.22) return "new";
  if (roll < 0.68) return "active";
  if (roll < 0.88) return "snoozed";
  return "done";
}

const DEMO_PEOPLE = [
  "Maya Patel",
  "Liam Chen",
  "Ava Nguyen",
  "Noah Kim",
  "Sofia Rivera",
  "Ethan Brooks",
  "Isla Morgan",
  "Lucas Bennett",
  "Zoe Harper",
  "Mason Diaz",
  "Nora Shah",
  "Owen Clark",
];

const DEMO_PROJECTS = [
  "Q2 Revenue Forecast",
  "Mobile Checkout Refresh",
  "Onboarding Funnel Audit",
  "Enterprise Contract Renewal",
  "Warehouse SLA Review",
  "Customer Health Dashboard",
  "Fraud Rules Tuning",
  "Billing Migration",
  "Roadmap Prioritization",
  "Support Deflection Pilot",
];

const DEMO_DATASETS = [
  "pipeline.csv",
  "forecast-v4.xlsx",
  "experiment-results.parquet",
  "crm-export.json",
  "weekly-kpis.csv",
  "cohort-retention.xlsx",
  "latency-report.csv",
  "support-volume.json",
];

const DEMO_TASK_ACTIONS = [
  "Review",
  "Prepare",
  "Finalize",
  "Validate",
  "Draft",
  "Update",
  "Escalate",
  "Confirm",
];

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
  const random = () => Math.random();
  const profiles: TimeProfile[] = [
    { startDaysAgo: 0, spanDays: 2, weight: 20, dueLeadMinDays: -1.5, dueLeadMaxDays: 3, noDueChance: 0.18, urgencyBias: 0.7, importanceBias: 0.58 },
    { startDaysAgo: 3, spanDays: 6, weight: 24, dueLeadMinDays: -4, dueLeadMaxDays: 8, noDueChance: 0.24, urgencyBias: 0.56, importanceBias: 0.52 },
    { startDaysAgo: 10, spanDays: 12, weight: 22, dueLeadMinDays: -8, dueLeadMaxDays: 14, noDueChance: 0.3, urgencyBias: 0.48, importanceBias: 0.5 },
    { startDaysAgo: 24, spanDays: 24, weight: 18, dueLeadMinDays: -12, dueLeadMaxDays: 18, noDueChance: 0.34, urgencyBias: 0.38, importanceBias: 0.45 },
    { startDaysAgo: 50, spanDays: 70, weight: 10, dueLeadMinDays: -22, dueLeadMaxDays: 24, noDueChance: 0.44, urgencyBias: 0.31, importanceBias: 0.42 },
    { startDaysAgo: 130, spanDays: 210, weight: 6, dueLeadMinDays: -45, dueLeadMaxDays: 30, noDueChance: 0.52, urgencyBias: 0.26, importanceBias: 0.37 },
  ];

  return Array.from({ length: count }, (_, i) => {
    const profile = profiles[weightedIndex(random, profiles)];
    const ts = sampleWorklikeTimestamp(random, now, profile.startDaysAgo, profile.spanDays);
    let due: number | undefined;
    if (random() >= profile.noDueChance) {
      const dueLeadDays = profile.dueLeadMinDays + random() * (profile.dueLeadMaxDays - profile.dueLeadMinDays);
      due = ts + dueLeadDays * DAY_MS + Math.floor((random() - 0.5) * 8 * HOUR_MS);
    }

    const dueDeltaDays = due === undefined ? undefined : (due - now) / DAY_MS;
    let urgency = profile.urgencyBias + (random() - 0.5) * 0.34;
    if (dueDeltaDays !== undefined) {
      if (dueDeltaDays < 0) urgency += 0.26;
      else if (dueDeltaDays < 1) urgency += 0.18;
      else if (dueDeltaDays < 7) urgency += 0.08;
    }
    let importance = profile.importanceBias + (random() - 0.5) * 0.36;
    if (dueDeltaDays !== undefined && dueDeltaDays < -10) importance -= 0.07;

    urgency = Math.max(0, Math.min(1, urgency));
    importance = Math.max(0, Math.min(1, importance));
    const state = computeStateForTiming(random, due, now);
    return {
      id: randomId(),
      type: randomChoice(ATOM_TYPES),
      state,
      ts,
      due,
      urgency,
      importance,
      title: `Atom ${i + 1}`,
      preview: `Synthetic atom ${i + 1} for GPU load testing.`,
      payload: { index: i, source: "mock", timeProfileStartDaysAgo: profile.startDaysAgo },
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
  type DemoSeedAtom = Omit<
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
  >;
  const clusterCount = 16;
  const profiles: TimeProfile[] = [
    { startDaysAgo: 0, spanDays: 1.6, weight: 14, dueLeadMinDays: -0.9, dueLeadMaxDays: 2.5, noDueChance: 0.14, urgencyBias: 0.78, importanceBias: 0.64 },
    { startDaysAgo: 2, spanDays: 3.5, weight: 16, dueLeadMinDays: -2.5, dueLeadMaxDays: 5.5, noDueChance: 0.18, urgencyBias: 0.67, importanceBias: 0.59 },
    { startDaysAgo: 6, spanDays: 6.5, weight: 15, dueLeadMinDays: -4.5, dueLeadMaxDays: 8, noDueChance: 0.23, urgencyBias: 0.59, importanceBias: 0.56 },
    { startDaysAgo: 13, spanDays: 10, weight: 14, dueLeadMinDays: -7, dueLeadMaxDays: 11, noDueChance: 0.28, urgencyBias: 0.52, importanceBias: 0.54 },
    { startDaysAgo: 24, spanDays: 16, weight: 13, dueLeadMinDays: -10, dueLeadMaxDays: 16, noDueChance: 0.34, urgencyBias: 0.44, importanceBias: 0.49 },
    { startDaysAgo: 42, spanDays: 24, weight: 12, dueLeadMinDays: -15, dueLeadMaxDays: 20, noDueChance: 0.38, urgencyBias: 0.36, importanceBias: 0.44 },
    { startDaysAgo: 72, spanDays: 42, weight: 9, dueLeadMinDays: -22, dueLeadMaxDays: 28, noDueChance: 0.45, urgencyBias: 0.31, importanceBias: 0.41 },
    { startDaysAgo: 130, spanDays: 120, weight: 7, dueLeadMinDays: -35, dueLeadMaxDays: 35, noDueChance: 0.53, urgencyBias: 0.24, importanceBias: 0.35 },
  ];
  const atoms: DemoSeedAtom[] = [];
  let nextId = 0;
  let threadOrdinal = 0;
  const makeId = (): string => `demo-${seed}-${nextId++}`;

  const pushAtom = (atom: DemoSeedAtom): void => {
    if (atoms.length < count) atoms.push(atom);
  };

  while (atoms.length < count) {
    const cluster = threadOrdinal % clusterCount;
    const profile = profiles[weightedIndex(random, profiles)];
    const project = DEMO_PROJECTS[Math.floor(random() * DEMO_PROJECTS.length)];
    const person = DEMO_PEOPLE[Math.floor(random() * DEMO_PEOPLE.length)];
    const dataset = DEMO_DATASETS[Math.floor(random() * DEMO_DATASETS.length)];
    const action = DEMO_TASK_ACTIONS[Math.floor(random() * DEMO_TASK_ACTIONS.length)];
    const threadId = `thread-${seed}-${threadOrdinal}`;
    const projectId = `project-${project.replace(/\s+/g, "-").toLowerCase()}`;
    const personId = `person-${person.replace(/\s+/g, "-").toLowerCase()}`;
    const baseTs = sampleWorklikeTimestamp(random, now, profile.startDaysAgo, profile.spanDays);

    const dueLeadDays = profile.dueLeadMinDays + random() * (profile.dueLeadMaxDays - profile.dueLeadMinDays);
    const taskDue = random() < profile.noDueChance * 0.55 ? undefined : baseTs + dueLeadDays * DAY_MS + Math.floor((random() - 0.5) * 7 * HOUR_MS);
    const taskDeltaDays = taskDue === undefined ? undefined : (taskDue - now) / DAY_MS;
    let taskUrgency = profile.urgencyBias + 0.08 + (random() - 0.5) * 0.22;
    let taskImportance = profile.importanceBias + 0.1 + (random() - 0.5) * 0.18;
    if (taskDeltaDays !== undefined) {
      if (taskDeltaDays < 0) taskUrgency += 0.2;
      else if (taskDeltaDays < 2) taskUrgency += 0.14;
    }
    taskUrgency = Math.max(0, Math.min(1, taskUrgency));
    taskImportance = Math.max(0, Math.min(1, taskImportance));

    const taskId = makeId();
    pushAtom({
      id: taskId,
      type: "task",
      state: computeStateForTiming(random, taskDue, now),
      ts: baseTs,
      due: taskDue,
      urgency: taskUrgency,
      importance: taskImportance,
      title: `${action} ${project}`,
      preview: `Coordinate with ${person} and update ${dataset}.`,
      payload: {
        source: "demo-seed",
        seed,
        index: atoms.length,
        cluster,
        timeProfileStartDaysAgo: profile.startDaysAgo,
        threadId,
        projectId,
        personId,
        phase: 0,
        kind: "task",
      },
    });

    if (atoms.length >= count) break;

    const personTs = baseTs + Math.floor((0.25 + random() * 0.5) * HOUR_MS);
    const personIdAtom = makeId();
    pushAtom({
      id: personIdAtom,
      type: "custom",
      state: "active",
      ts: personTs,
      due: undefined,
      urgency: Math.max(0, Math.min(1, profile.urgencyBias - 0.05 + (random() - 0.5) * 0.14)),
      importance: Math.max(0, Math.min(1, profile.importanceBias + 0.14 + (random() - 0.5) * 0.12)),
      title: person,
      preview: `Primary contact for ${project}.`,
      payload: {
        source: "demo-seed",
        seed,
        index: atoms.length,
        cluster,
        threadId,
        projectId,
        personId,
        phase: 1,
        kind: "person",
        relatesTo: taskId,
      },
    });

    if (atoms.length >= count) break;

    const emailCount = 1 + Math.floor(random() * 3);
    let previousId = taskId;
    let lastEmailTs = baseTs;
    for (let e = 0; e < emailCount && atoms.length < count; e += 1) {
      const emailTs = baseTs + Math.floor((0.8 + e * 0.45 + random() * 0.9) * HOUR_MS);
      lastEmailTs = Math.max(lastEmailTs, emailTs);
      const emailId = makeId();
      const emailDue = random() < 0.6 ? undefined : emailTs + Math.floor((0.3 + random() * 2.2) * DAY_MS);
      pushAtom({
        id: emailId,
        type: "email",
        state: computeStateForTiming(random, emailDue, now),
        ts: emailTs,
        due: emailDue,
        urgency: Math.max(0, Math.min(1, profile.urgencyBias + 0.05 + (random() - 0.5) * 0.24)),
        importance: Math.max(0, Math.min(1, profile.importanceBias + (random() - 0.5) * 0.2)),
        title: `Email ${e + 1}: ${project}`,
        preview: `To ${person}: status and next step for ${project}.`,
        payload: {
          source: "demo-seed",
          seed,
          index: atoms.length,
          cluster,
          threadId,
          projectId,
          personId,
          phase: 2 + e,
          kind: "email",
          relatesTo: previousId,
        },
      });
      previousId = emailId;
    }

    if (atoms.length >= count) break;

    const fileId = makeId();
    const fileTs = lastEmailTs + Math.floor((0.5 + random() * 1.8) * HOUR_MS);
    const fileDue = random() < 0.45 ? fileTs + Math.floor((1 + random() * 5) * DAY_MS) : undefined;
    pushAtom({
      id: fileId,
      type: "file",
      state: computeStateForTiming(random, fileDue, now),
      ts: fileTs,
      due: fileDue,
      urgency: Math.max(0, Math.min(1, profile.urgencyBias - 0.02 + (random() - 0.5) * 0.2)),
      importance: Math.max(0, Math.min(1, profile.importanceBias + 0.12 + (random() - 0.5) * 0.2)),
      title: dataset,
      preview: `Data artifact attached to ${project}.`,
      payload: {
        source: "demo-seed",
        seed,
        index: atoms.length,
        cluster,
        threadId,
        projectId,
        personId,
        phase: 7,
        kind: "data",
        relatesTo: previousId,
      },
    });

    if (atoms.length >= count) break;

    const eventTs = fileTs + Math.floor((0.4 + random() * 2.4) * HOUR_MS);
    const eventDue = eventTs + Math.floor((1 + random() * 7) * DAY_MS);
    const eventId = makeId();
    pushAtom({
      id: eventId,
      type: "event",
      state: computeStateForTiming(random, eventDue, now),
      ts: eventTs,
      due: eventDue,
      urgency: Math.max(0, Math.min(1, profile.urgencyBias + (random() - 0.5) * 0.24)),
      importance: Math.max(0, Math.min(1, profile.importanceBias + 0.08 + (random() - 0.5) * 0.22)),
      title: `${project} sync`,
      preview: `Review outcomes with ${person}.`,
      payload: {
        source: "demo-seed",
        seed,
        index: atoms.length,
        cluster,
        threadId,
        projectId,
        personId,
        phase: 8,
        kind: "event",
        relatesTo: fileId,
      },
    });

    if (atoms.length >= count) break;

    if (random() < 0.55 && atoms.length < count) {
      const noteTs = eventTs + Math.floor((0.2 + random()) * HOUR_MS);
      pushAtom({
        id: makeId(),
        type: "message",
        state: "new",
        ts: noteTs,
        due: noteTs + Math.floor((0.8 + random() * 2.4) * DAY_MS),
        urgency: Math.max(0, Math.min(1, profile.urgencyBias + 0.06 + (random() - 0.5) * 0.18)),
        importance: Math.max(0, Math.min(1, profile.importanceBias + (random() - 0.5) * 0.14)),
        title: `Follow-up note: ${project}`,
        preview: `Capture action items after sync with ${person}.`,
        payload: {
          source: "demo-seed",
          seed,
          index: atoms.length,
          cluster,
          threadId,
          projectId,
          personId,
          phase: 9,
          kind: "note",
          relatesTo: eventId,
        },
      });
    }

    threadOrdinal += 1;
  }

  return atoms;
}
