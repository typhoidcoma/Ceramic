import { ATOM_TYPES, type Atom, type AtomPatch, type AtomState, type AtomType, type TimelineBucket, type TimelineSortMode, enrichAtom } from "../data/types";
import { assignSmokeTargets, easePosition, type LayoutMode } from "../layout/layout";

export type Filters = {
  types: Set<AtomType>;
  states: Set<AtomState>;
  query: string;
};

export type QualityTierOverride = "auto" | "safe" | "balanced" | "high";

export type ActiveMessageState = {
  activeMessageAtomId: string | null;
  activeMessagePrevAtomId: string | null;
  activeMessageBlend: number;
  activeMessageUpdatedAt: number;
  activeMessageMatchSource: "dictionary" | "unknown" | "none";
  activeMessageMatchedPhrase: string | null;
  activeMessageCanonicalKey: string | null;
};

type Snapshot = {
  selectedId: string | null;
  hoveredId: string | null;
  totalCount: number;
  visibleCount: number;
  fps: number;
  filters: Filters;
  layoutMode: LayoutMode;
  overlayMinimized: boolean;
  inspectorOpen: boolean;
  qualityTierOverride: QualityTierOverride;
  showDiagnostics: boolean;
  activeMessageAtomId: string | null;
  activeMessagePrevAtomId: string | null;
  activeMessageBlend: number;
  activeMessageUpdatedAt: number;
  activeMessageMatchSource: "dictionary" | "unknown" | "none";
  activeMessageMatchedPhrase: string | null;
  activeMessageCanonicalKey: string | null;
  taskPointCount: number;
  promptLatencyMs: number | null;
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
  private layoutMode: LayoutMode = "smoke_field";
  private overlayMinimized = false;
  private inspectorOpen = true;
  private qualityTierOverride: QualityTierOverride = "auto";
  private showDiagnostics = true;
  private activeMessageAtomId: string | null = null;
  private activeMessagePrevAtomId: string | null = null;
  private activeMessageStartAt = 0;
  private activeMessageBlend = 1;
  private activeMessageUpdatedAt = 0;
  private readonly activeMessageDurationMs = 800;
  private activeMessageMatchSource: "dictionary" | "unknown" | "none" = "none";
  private activeMessageMatchedPhrase: string | null = null;
  private activeMessageCanonicalKey: string | null = null;
  private taskPointCount = 0;
  private promptLatencyMs: number | null = null;
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
      overlayMinimized: this.overlayMinimized,
      inspectorOpen: this.inspectorOpen,
      qualityTierOverride: this.qualityTierOverride,
      showDiagnostics: this.showDiagnostics,
      activeMessageAtomId: this.activeMessageAtomId,
      activeMessagePrevAtomId: this.activeMessagePrevAtomId,
      activeMessageBlend: this.activeMessageBlend,
      activeMessageUpdatedAt: this.activeMessageUpdatedAt,
      activeMessageMatchSource: this.activeMessageMatchSource,
      activeMessageMatchedPhrase: this.activeMessageMatchedPhrase,
      activeMessageCanonicalKey: this.activeMessageCanonicalKey,
      taskPointCount: this.taskPointCount,
      promptLatencyMs: this.promptLatencyMs,
    };
  }

  getViewVersion(): number {
    return this.viewVersion;
  }

  setFps(fps: number): void {
    this.fps = fps;
    this.emitView();
  }

  setTaskPointCount(count: number): void {
    const next = Math.max(0, Math.floor(count));
    if (this.taskPointCount === next) return;
    this.taskPointCount = next;
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

  getActiveMessageState(): ActiveMessageState {
    return {
      activeMessageAtomId: this.activeMessageAtomId,
      activeMessagePrevAtomId: this.activeMessagePrevAtomId,
      activeMessageBlend: this.activeMessageBlend,
      activeMessageUpdatedAt: this.activeMessageUpdatedAt,
      activeMessageMatchSource: this.activeMessageMatchSource,
      activeMessageMatchedPhrase: this.activeMessageMatchedPhrase,
      activeMessageCanonicalKey: this.activeMessageCanonicalKey,
    };
  }

  setActiveMessageMatchMeta(source: "dictionary" | "unknown" | "none", matchedPhrase: string | null, canonicalKey: string | null): void {
    if (this.activeMessageMatchSource === source && this.activeMessageMatchedPhrase === matchedPhrase && this.activeMessageCanonicalKey === canonicalKey) return;
    this.activeMessageMatchSource = source;
    this.activeMessageMatchedPhrase = matchedPhrase;
    this.activeMessageCanonicalKey = canonicalKey;
    this.emitView();
  }

  setPromptLatencyMs(value: number | null): void {
    const next = value === null ? null : Math.max(0, Math.floor(value));
    if (this.promptLatencyMs === next) return;
    this.promptLatencyMs = next;
    this.emitView();
  }

  activateIncomingMessage(atomId: string | null, nowMs: number): ActiveMessageState {
    if (!atomId || !this.atomMap.has(atomId)) {
      this.activeMessagePrevAtomId = this.activeMessageAtomId;
      this.activeMessageAtomId = null;
      this.activeMessageBlend = 1;
      this.activeMessageUpdatedAt = nowMs;
      this.activeMessageMatchSource = "none";
      this.activeMessageMatchedPhrase = null;
      this.activeMessageCanonicalKey = null;
      return this.getActiveMessageState();
    }
    if (atomId !== this.activeMessageAtomId) {
      this.activeMessagePrevAtomId = this.activeMessageAtomId;
      this.activeMessageAtomId = atomId;
      this.activeMessageStartAt = nowMs;
      this.activeMessageBlend = this.activeMessagePrevAtomId ? 0 : 1;
      this.activeMessageUpdatedAt = nowMs;
    }
    return this.getActiveMessageState();
  }

  syncActiveMessageBlend(nowMs: number): ActiveMessageState {
    if (this.activeMessagePrevAtomId && !this.atomMap.has(this.activeMessagePrevAtomId)) {
      this.activeMessagePrevAtomId = null;
    }
    if (this.activeMessageAtomId && !this.atomMap.has(this.activeMessageAtomId)) {
      this.activeMessageAtomId = this.pickNewestMessageAtomId();
      this.activeMessagePrevAtomId = null;
      this.activeMessageBlend = 1;
      if (!this.activeMessageAtomId) {
        this.activeMessageMatchSource = "none";
        this.activeMessageMatchedPhrase = null;
        this.activeMessageCanonicalKey = null;
      }
    }
    if (!this.activeMessageAtomId) {
      this.activeMessageBlend = 1;
      this.activeMessageUpdatedAt = nowMs;
      return this.getActiveMessageState();
    }
    if (this.activeMessagePrevAtomId) {
      const t = clamp01((nowMs - this.activeMessageStartAt) / this.activeMessageDurationMs);
      this.activeMessageBlend = t;
      if (t >= 1) this.activeMessagePrevAtomId = null;
    } else {
      this.activeMessageBlend = 1;
    }
    this.activeMessageUpdatedAt = nowMs;
    return this.getActiveMessageState();
  }

  initializeActiveMessageFromData(nowMs: number): void {
    const newest = this.pickNewestMessageAtomId();
    this.activeMessageAtomId = newest;
    this.activeMessagePrevAtomId = null;
    this.activeMessageBlend = 1;
    this.activeMessageUpdatedAt = nowMs;
    this.activeMessageCanonicalKey = null;
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

  setOverlayMinimized(next: boolean): void {
    if (this.overlayMinimized === next) return;
    this.overlayMinimized = next;
    this.emitView();
  }

  setInspectorOpen(next: boolean): void {
    if (this.inspectorOpen === next) return;
    this.inspectorOpen = next;
    this.emitView();
  }

  setQualityTierOverride(next: QualityTierOverride): void {
    if (this.qualityTierOverride === next) return;
    this.qualityTierOverride = next;
    this.emitView();
  }

  setShowDiagnostics(next: boolean): void {
    if (this.showDiagnostics === next) return;
    this.showDiagnostics = next;
    this.emitView();
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
    this.emit();
  }

  removeOne(id: string): void {
    if (!this.atomMap.has(id)) return;
    this.atomMap.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.hoveredId === id) this.hoveredId = null;
    if (this.activeMessageAtomId === id) {
      this.activeMessageAtomId = this.pickNewestMessageAtomId();
      this.activeMessagePrevAtomId = null;
      this.activeMessageBlend = 1;
      this.activeMessageUpdatedAt = Date.now();
    }
    if (this.activeMessagePrevAtomId === id) this.activeMessagePrevAtomId = null;
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  clear(): void {
    if (this.atomMap.size === 0 && this.selectedId === null && this.hoveredId === null) return;
    this.atomMap.clear();
    this.selectedId = null;
    this.hoveredId = null;
    this.activeMessageAtomId = null;
    this.activeMessagePrevAtomId = null;
    this.activeMessageBlend = 1;
    this.activeMessageUpdatedAt = Date.now();
    this.activeMessageMatchSource = "none";
    this.activeMessageMatchedPhrase = null;
    this.activeMessageCanonicalKey = null;
    this.taskPointCount = 0;
    this.promptLatencyMs = null;
    this.visibleAtomsCache = [];
    this.visibleDirty = true;
    this.layoutDirty = true;
    this.emit();
  }

  getTimelineBuckets(now: number, mode: TimelineSortMode): TimelineBucket[] {
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const visible = [...this.getVisibleAtoms()];
    const sorted = visible.sort((a, b) => {
      if (mode === "importance") {
        if (b.importance !== a.importance) return b.importance - a.importance;
        if (b.score !== a.score) return b.score - a.score;
        return b.ts - a.ts;
      }
      if (mode === "due") {
        const aDue = a.due ?? Number.POSITIVE_INFINITY;
        const bDue = b.due ?? Number.POSITIVE_INFINITY;
        if (aDue !== bDue) return aDue - bDue;
        return b.ts - a.ts;
      }
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.stableKey - b.stableKey;
    });

    const buckets = new Map<string, TimelineBucket>([
      ["today", { key: "today", label: "Today", items: [] }],
      ["yesterday", { key: "yesterday", label: "Yesterday", items: [] }],
      ["last7", { key: "last7", label: "Last 7 Days", items: [] }],
      ["last30", { key: "last30", label: "Last 30 Days", items: [] }],
      ["older", { key: "older", label: "Older", items: [] }],
    ]);

    for (const atom of sorted) {
      const age = todayMs - atom.ts;
      const key =
        age < dayMs ? "today" : age < 2 * dayMs ? "yesterday" : age < 7 * dayMs ? "last7" : age < 30 * dayMs ? "last30" : "older";
      const bucket = buckets.get(key);
      if (bucket) bucket.items.push(atom);
    }

    return [...buckets.values()].filter((bucket) => bucket.items.length > 0);
  }

  setSelectedByIndex(bucketKey: string, itemIndex: number): void {
    const buckets = this.getTimelineBuckets(Date.now(), "recent");
    const bucket = buckets.find((entry) => entry.key === bucketKey);
    if (!bucket) return;
    const next = bucket.items[itemIndex];
    this.setSelected(next?.id ?? null);
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
      this.layoutDirty = false;
      this.emitView();
      return;
    }
    assignSmokeTargets(visible, viewportWorldWidth, viewportWorldHeight, baseSize);
    this.layoutDirty = false;
    this.emitView();
  }

  tickPositions(dtSec: number): void {
    easePosition(this.getVisibleAtoms(), dtSec);
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

  private pickNewestMessageAtomId(): string | null {
    let best: Atom | null = null;
    for (const atom of this.atomMap.values()) {
      if (atom.type !== "message") continue;
      if (!best || atom.ts > best.ts || (atom.ts === best.ts && atom.stableKey < best.stableKey)) best = atom;
    }
    return best?.id ?? null;
  }
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function randomChoice<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function randomId(): string {
  return crypto.randomUUID();
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
  let t = seed >>> 0;
  const rand = () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const ts = now - Math.floor(rand() * 120 * DAY_MS);
    const dueChance = rand();
    const due = dueChance > 0.26 ? ts + Math.floor((rand() * 18 - 4) * DAY_MS) : undefined;
    const urgency = Math.max(0, Math.min(1, 0.25 + rand() * 0.75 + (due && due < now ? 0.2 : 0)));
    const importance = Math.max(0, Math.min(1, 0.2 + rand() * 0.8));
    const state: AtomState = due && due < now ? (rand() < 0.7 ? "active" : "done") : rand() < 0.15 ? "new" : rand() < 0.72 ? "active" : "snoozed";
    const type = randomChoice(ATOM_TYPES);
    const payload = type === "message" ? { message: `message payload ${i + 1}` } : { index: i, source: "demo-seed" };
    return {
      id: randomId(),
      type,
      state,
      ts,
      due,
      urgency,
      importance,
      title: `${type.toUpperCase()} signal ${i + 1}`,
      preview: `Synthetic record ${i + 1} for smoke-field testing.`,
      payload,
      labels: urgency > 0.8 ? ["high_attention"] : ["ambient"],
      visibility: "masked",
      sensitivity: type === "email" || type === "message" ? "high" : type === "file" ? "medium" : "low",
    };
  });
}
