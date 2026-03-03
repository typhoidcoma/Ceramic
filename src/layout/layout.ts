import { clamp01, type Atom } from "../data/types";

export const TILE_GUTTER_PX = 4;
const PANEL_GAP_PX = 14;
const PANEL_PADDING_PX = 18;
const DAY_MS = 24 * 60 * 60 * 1000;
const GOLDEN_ANGLE = 2.399963229728653;

const TYPE_ORDER: Record<string, number> = {
  task: 0,
  date: 1,
  message: 2,
  email: 3,
  image: 4,
  file: 5,
  event: 6,
  custom: 7,
};

const STATE_ORDER: Record<string, number> = {
  new: 0,
  active: 1,
  snoozed: 2,
  done: 3,
  archived: 4,
};

export type LayoutMode = "growth_tree" | "score" | "due" | "type" | "state" | "constellation";
export type FocusMode = "off" | "selected";

export type PanelLayout = {
  rank: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TreeEdge = {
  parentId: string;
  childId: string;
  strength: number;
};

export type TreeStats = {
  trunkCount: number;
  branchCount: number;
  leafCount: number;
  maxDepth: number;
};

export type GroupLayoutResult = {
  panels: PanelLayout[];
  panelByAtomId: Map<string, number>;
  treeEdges: TreeEdge[];
  treeStats: TreeStats;
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type WeightedAtom = {
  atom: Atom;
  weight: number;
};

const EMPTY_TREE_STATS: TreeStats = {
  trunkCount: 0,
  branchCount: 0,
  leafCount: 0,
  maxDepth: 0,
};

function scoreComparator(a: Atom, b: Atom): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.ts !== a.ts) return b.ts - a.ts;
  return a.stableKey - b.stableKey;
}

function dueBucket(atom: Atom, nowMs: number): number {
  if (!atom.due) return 4;
  const delta = atom.due - nowMs;
  if (delta < 0) return 0;
  if (delta < DAY_MS) return 1;
  if (delta < 7 * DAY_MS) return 2;
  return 3;
}

function groupRank(atom: Atom, mode: LayoutMode, nowMs: number): number {
  if (mode === "type") return TYPE_ORDER[atom.type] ?? 999;
  if (mode === "state") return STATE_ORDER[atom.state] ?? 999;
  if (mode === "due") return dueBucket(atom, nowMs);
  return 0;
}

function modeComparator(a: Atom, b: Atom, mode: LayoutMode, nowMs: number): number {
  if (mode === "constellation" || mode === "growth_tree") {
    if (b.score !== a.score) return b.score - a.score;
    if (b.ts !== a.ts) return b.ts - a.ts;
    return a.stableKey - b.stableKey;
  }
  if (mode === "due") {
    const aDue = a.due ?? Number.POSITIVE_INFINITY;
    const bDue = b.due ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return scoreComparator(a, b);
  }
  if (mode === "type" || mode === "state") {
    if (b.score !== a.score) return b.score - a.score;
    if (a.due !== b.due) return (a.due ?? Number.POSITIVE_INFINITY) - (b.due ?? Number.POSITIVE_INFINITY);
    if (b.ts !== a.ts) return b.ts - a.ts;
    return a.stableKey - b.stableKey;
  }
  return scoreComparator(a, b);
}

function panelLabel(rank: number, mode: LayoutMode): string {
  if (mode === "due") {
    if (rank === 0) return "Overdue";
    if (rank === 1) return "Due <24h";
    if (rank === 2) return "Due <7d";
    if (rank === 3) return "Due later";
    return "No due date";
  }
  if (mode === "type") {
    const labels = ["task", "date", "message", "email", "image", "file", "event", "custom"];
    return labels[rank] ?? "other";
  }
  const labels = ["new", "active", "snoozed", "done", "archived"];
  return labels[rank] ?? "other";
}

function spanFromTier(tier: 0 | 1 | 2): number {
  if (tier === 2) return 3;
  if (tier === 1) return 2;
  return 1;
}

export function tileSizeForTier(baseSize: number, tier: 0 | 1 | 2): number {
  const span = spanFromTier(tier);
  return baseSize * span + TILE_GUTTER_PX * (span - 1);
}

function computeBounds(atoms: Atom[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const atom of atoms) {
    const size = atom.renderSize > 0 ? atom.renderSize : tileSizeForTier(22, atom.sizeTier);
    const half = size * 0.5;
    minX = Math.min(minX, atom.targetX - half);
    maxX = Math.max(maxX, atom.targetX + half);
    minY = Math.min(minY, atom.targetY - half);
    maxY = Math.max(maxY, atom.targetY + half);
  }
  return { minX, maxX, minY, maxY };
}

function applyInitialPosition(atom: Atom): void {
  if (atom.x === 0 && atom.y === 0 && atom.z === 0) {
    atom.x = atom.targetX;
    atom.y = atom.targetY;
    atom.z = atom.targetZ;
  }
}

function normalizeScoreTargets(atoms: Atom[], viewportWorldWidth: number, viewportWorldHeight: number): void {
  if (atoms.length === 0) return;
  const bounds = computeBounds(atoms);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;
  const fitScale = Math.min((viewportWorldWidth * 0.92) / width, (viewportWorldHeight * 0.86) / height);
  const scale = Math.max(0.35, Math.min(1.8, fitScale));

  for (const atom of atoms) {
    atom.targetX = (atom.targetX - cx) * scale;
    atom.targetY = (atom.targetY - cy) * scale;
    atom.targetZ = 0;
    atom.renderSize = Math.max(8, atom.renderSize * scale);
    atom.treeRole = "leaf";
    atom.treeDepth = 0;
    atom.growthPhase = 1;
    atom.parentId = undefined;
    atom.descendantCount = 0;
    applyInitialPosition(atom);
  }
}

function layoutScoreMode(atoms: Atom[], viewportWorldWidth: number, viewportWorldHeight: number, baseSize: number): void {
  const slot = baseSize + TILE_GUTTER_PX;
  const cols = Math.max(1, Math.floor(viewportWorldWidth / slot));
  const skyline = new Int32Array(cols);

  for (const atom of atoms) {
    const span = Math.min(cols, spanFromTier(atom.sizeTier));
    let bestX = 0;
    let bestY = Number.POSITIVE_INFINITY;

    for (let x = 0; x <= cols - span; x += 1) {
      let y = 0;
      for (let i = 0; i < span; i += 1) y = Math.max(y, skyline[x + i]);
      if (y < bestY) {
        bestY = y;
        bestX = x;
      }
    }

    const placedY = Number.isFinite(bestY) ? bestY : 0;
    const newHeight = placedY + span;
    for (let i = 0; i < span; i += 1) skyline[bestX + i] = newHeight;

    atom.targetX = (bestX + (span - 1) * 0.5 - cols * 0.5) * slot;
    atom.targetY = -(placedY + (span - 1) * 0.5) * slot;
    atom.targetZ = 0;
    atom.renderSize = tileSizeForTier(baseSize, atom.sizeTier);
    atom.treeRole = "leaf";
    atom.treeDepth = 0;
    atom.growthPhase = 1;
    atom.parentId = undefined;
    atom.descendantCount = 0;
    applyInitialPosition(atom);
  }

  normalizeScoreTargets(atoms, viewportWorldWidth, viewportWorldHeight);
}

function randomStable01(seed: number): number {
  const value = (Math.sin(seed * 12.9898) * 43758.5453123) % 1;
  return value < 0 ? value + 1 : value;
}

function layoutConstellationMode(atoms: Atom[], viewportWorldWidth: number, viewportWorldHeight: number, baseSize: number): void {
  if (atoms.length === 0) return;
  const now = Date.now();
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const atom of atoms) {
    minTs = Math.min(minTs, atom.ts);
    maxTs = Math.max(maxTs, atom.ts);
  }
  const tsSpan = Math.max(1, maxTs - minTs);
  const radiusLimit = Math.min(viewportWorldWidth, viewportWorldHeight) * 0.46;
  const depthRange = Math.min(viewportWorldWidth, viewportWorldHeight) * 0.3;

  for (const atom of atoms) {
    const ageNorm = (atom.ts - minTs) / tsSpan;
    const freshness = Math.max(0, Math.min(1, 1 - (now - atom.ts) / (1000 * 60 * 60 * 24 * 28)));
    const typeSector = (TYPE_ORDER[atom.type] ?? 0) / Math.max(1, Object.keys(TYPE_ORDER).length);
    const stateOffset = (STATE_ORDER[atom.state] ?? 0) * 0.18;
    const jitterA = randomStable01(atom.stableKey);
    const jitterB = randomStable01(atom.stableKey ^ 0x9e3779b9);
    const angle = typeSector * Math.PI * 2 + ageNorm * Math.PI * 5.2 + stateOffset + jitterA * 0.65;
    const radialBias = 0.18 + (1 - atom.score) * 0.82;
    const radius = radialBias * radiusLimit * (0.7 + jitterB * 0.42);
    atom.targetX = Math.cos(angle) * radius;
    atom.targetY = Math.sin(angle) * radius * (0.8 + atom.importance * 0.45);
    atom.targetZ = (freshness * 2 - 1) * depthRange + (jitterA - 0.5) * depthRange * 0.45;
    atom.renderSize = tileSizeForTier(baseSize, atom.sizeTier);
    atom.treeRole = "leaf";
    atom.treeDepth = clamp01(ageNorm);
    atom.growthPhase = 1;
    atom.parentId = undefined;
    atom.descendantCount = 0;
    applyInitialPosition(atom);
  }
}

function similarity(a: Atom, b: Atom): number {
  const urgency = 1 - Math.abs(a.urgency - b.urgency);
  const importance = 1 - Math.abs(a.importance - b.importance);
  const type = a.type === b.type ? 1 : 0;
  const state = a.state === b.state ? 1 : 0;
  return 0.48 * urgency + 0.3 * importance + 0.14 * type + 0.08 * state;
}

function roleForDepth(depth: number, childCount: number): "trunk" | "branch" | "leaf" {
  if (depth <= 0.15 || childCount >= 6) return "trunk";
  if (depth >= 0.72 || childCount === 0) return "leaf";
  return "branch";
}

function layoutGrowthTreeMode(
  atoms: Atom[],
  viewportWorldWidth: number,
  viewportWorldHeight: number,
  baseSize: number,
): { edges: TreeEdge[]; stats: TreeStats } {
  if (atoms.length === 0) return { edges: [], stats: EMPTY_TREE_STATS };

  const ordered = [...atoms].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.stableKey - b.stableKey;
  });

  const n = ordered.length;
  const rootCount = Math.max(2, Math.min(12, Math.floor(Math.sqrt(n) * 0.18)));
  const childCountById = new Map<string, number>();
  const edges: TreeEdge[] = [];
  const indexById = new Map<string, number>();
  for (let i = 0; i < ordered.length; i += 1) indexById.set(ordered[i].id, i);

  const maxHeight = Math.max(360, Math.min(760, viewportWorldHeight * 0.78));
  const baseRadius = Math.max(24, Math.min(58, baseSize * 2.2));
  const canopyRadius = Math.max(180, Math.min(560, viewportWorldWidth * 0.34));

  const parentById = new Map<string, Atom | undefined>();
  for (let i = 0; i < ordered.length; i += 1) {
    const atom = ordered[i];
    const depth = n <= 1 ? 0 : i / (n - 1);
    atom.treeDepth = depth;
    atom.growthPhase = 1;
    atom.descendantCount = 0;

    if (i < rootCount) {
      parentById.set(atom.id, undefined);
      continue;
    }

    const lowerDepthFloor = Math.max(0, depth - 0.18);
    let bestParent: Atom | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const start = Math.max(0, i - 260);
    for (let c = start; c < i; c += 1) {
      const candidate = ordered[c];
      if (candidate.treeDepth < lowerDepthFloor) continue;
      const dtDays = Math.abs(atom.ts - candidate.ts) / DAY_MS;
      const timeScore = 1 - clamp01(dtDays / 21);
      const likeScore = similarity(atom, candidate);
      const continuityPenalty = (childCountById.get(candidate.id) ?? 0) * 0.07;
      const score = timeScore * 0.45 + likeScore * 0.55 - continuityPenalty;
      if (score > bestScore || (Math.abs(score - bestScore) < 0.00001 && candidate.stableKey < (bestParent?.stableKey ?? Number.MAX_SAFE_INTEGER))) {
        bestScore = score;
        bestParent = candidate;
      }
    }

    parentById.set(atom.id, bestParent ?? ordered[Math.max(0, i - 1)]);
    const parent = parentById.get(atom.id);
    if (parent) childCountById.set(parent.id, (childCountById.get(parent.id) ?? 0) + 1);
  }

  const descendantsById = new Map<string, number>();
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const atom = ordered[i];
    const parent = parentById.get(atom.id);
    const ownDescendants = descendantsById.get(atom.id) ?? 0;
    if (parent) descendantsById.set(parent.id, (descendantsById.get(parent.id) ?? 0) + ownDescendants + 1);
  }

  for (let i = 0; i < ordered.length; i += 1) {
    const atom = ordered[i];
    const parent = parentById.get(atom.id);
    atom.parentId = parent?.id;
    atom.descendantCount = descendantsById.get(atom.id) ?? 0;
    const childCount = childCountById.get(atom.id) ?? 0;
    atom.treeRole = roleForDepth(atom.treeDepth, childCount);

    if (!parent) {
      const rootAngle = i * (Math.PI * 2 / rootCount);
      atom.targetX = Math.cos(rootAngle) * baseRadius * 0.72;
      atom.targetY = maxHeight * 0.02 + (i % 3) * 8;
      atom.targetZ = Math.sin(rootAngle) * baseRadius * 0.72;
      atom.renderSize = tileSizeForTier(baseSize, atom.sizeTier) * 0.86;
      applyInitialPosition(atom);
      continue;
    }

    const pDepth = parent.treeDepth;
    const depthDelta = Math.max(0.02, atom.treeDepth - pDepth);
    const typeSector = (TYPE_ORDER[atom.type] ?? 0) / 8;
    const h0 = randomStable01(atom.stableKey);
    const h1 = randomStable01(atom.stableKey ^ parent.stableKey);
    const localAngle = GOLDEN_ANGLE * (indexById.get(atom.id) ?? i) + typeSector * Math.PI * 2 + h0 * 0.4;
    const radial = baseRadius + canopyRadius * Math.pow(atom.treeDepth, 1.18);
    const step = 14 + 36 * depthDelta + 16 * h1;
    const branchLift = 12 + Math.pow(depthDelta + 0.04, 0.7) * maxHeight * 0.32;

    atom.targetX = parent.targetX * (0.56 + atom.treeDepth * 0.42) + Math.cos(localAngle) * (step + radial * 0.23);
    atom.targetZ = parent.targetZ * (0.56 + atom.treeDepth * 0.42) + Math.sin(localAngle) * (step + radial * 0.23);
    atom.targetY = Math.min(maxHeight, parent.targetY + branchLift);

    let size = tileSizeForTier(baseSize, atom.sizeTier);
    if (atom.treeRole === "trunk") size *= 1.18;
    else if (atom.treeRole === "branch") size *= 0.96;
    else size *= 0.74 + atom.score * 0.5;
    atom.renderSize = Math.max(7, size);
    applyInitialPosition(atom);
    edges.push({
      parentId: parent.id,
      childId: atom.id,
      strength: clamp01(0.25 + 0.55 * similarity(atom, parent) + 0.2 * (1 - atom.treeDepth)),
    });
  }

  let trunkCount = 0;
  let branchCount = 0;
  let leafCount = 0;
  for (const atom of ordered) {
    if (atom.treeRole === "trunk") trunkCount += 1;
    else if (atom.treeRole === "branch") branchCount += 1;
    else leafCount += 1;
  }

  return {
    edges,
    stats: {
      trunkCount,
      branchCount,
      leafCount,
      maxDepth: maxHeight,
    },
  };
}

function splitWeighted(items: WeightedAtom[], rect: Rect, out: Array<{ atom: Atom; rect: Rect }>): void {
  if (items.length === 0) return;
  if (items.length === 1) {
    out.push({ atom: items[0].atom, rect });
    return;
  }

  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let leftWeight = 0;
  let splitIndex = 0;
  const half = total * 0.5;
  while (splitIndex < items.length - 1 && leftWeight + items[splitIndex].weight < half) {
    leftWeight += items[splitIndex].weight;
    splitIndex += 1;
  }
  splitIndex = Math.max(1, Math.min(items.length - 1, splitIndex + 1));
  const left = items.slice(0, splitIndex);
  const right = items.slice(splitIndex);
  const leftTotal = left.reduce((sum, item) => sum + item.weight, 0);
  const ratio = total > 0 ? leftTotal / total : 0.5;

  if (rect.width >= rect.height) {
    const leftWidth = rect.width * ratio;
    splitWeighted(left, { x: rect.x, y: rect.y, width: leftWidth, height: rect.height }, out);
    splitWeighted(right, { x: rect.x + leftWidth, y: rect.y, width: rect.width - leftWidth, height: rect.height }, out);
    return;
  }

  const topHeight = rect.height * ratio;
  splitWeighted(left, { x: rect.x, y: rect.y, width: rect.width, height: topHeight }, out);
  splitWeighted(right, { x: rect.x, y: rect.y + topHeight, width: rect.width, height: rect.height - topHeight }, out);
}

function insetRect(rect: Rect, inset: number): Rect {
  const width = Math.max(1, rect.width - inset * 2);
  const height = Math.max(1, rect.height - inset * 2);
  return { x: rect.x + inset, y: rect.y + inset, width, height };
}

function computePanelRects(count: number, viewportWorldWidth: number, viewportWorldHeight: number): Rect[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const totalGapX = PANEL_GAP_PX * (cols - 1);
  const totalGapY = PANEL_GAP_PX * (rows - 1);
  const panelWidth = (viewportWorldWidth - totalGapX) / cols;
  const panelHeight = (viewportWorldHeight - totalGapY) / rows;
  const originX = -viewportWorldWidth * 0.5;
  const originY = -viewportWorldHeight * 0.5;

  const rects: Rect[] = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = originX + col * (panelWidth + PANEL_GAP_PX);
    const y = originY + row * (panelHeight + PANEL_GAP_PX);
    rects.push({ x, y, width: panelWidth, height: panelHeight });
  }
  return rects;
}

export function assignGroupedTreemapTargets(
  atoms: Atom[],
  viewportWorldWidth: number,
  viewportWorldHeight: number,
  mode: Exclude<LayoutMode, "score" | "constellation" | "growth_tree">,
  panelScaleByRank: Map<number, number> = new Map(),
): GroupLayoutResult {
  const nowMs = Date.now();
  const groups = new Map<number, Atom[]>();
  for (const atom of atoms) {
    const rank = groupRank(atom, mode, nowMs);
    const bucket = groups.get(rank);
    if (bucket) bucket.push(atom);
    else groups.set(rank, [atom]);
  }

  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  const panelRects = computePanelRects(ordered.length, viewportWorldWidth, viewportWorldHeight);
  const panels: PanelLayout[] = [];
  const panelByAtomId = new Map<string, number>();

  for (let i = 0; i < ordered.length; i += 1) {
    const [rank, items] = ordered[i];
    const panelRect = panelRects[i];
    const panelInset = insetRect(panelRect, PANEL_PADDING_PX);
    const scale = Math.max(0.85, Math.min(2.4, panelScaleByRank.get(rank) ?? 1));

    items.sort((a, b) => modeComparator(a, b, mode, nowMs));
    const weighted: WeightedAtom[] = items.map((atom) => ({
      atom,
      weight: (atom.sizeTier + 1) * (0.65 + atom.score * 0.75),
    }));
    const results: Array<{ atom: Atom; rect: Rect }> = [];
    splitWeighted(weighted, panelInset, results);

    for (const entry of results) {
      const r = insetRect(entry.rect, TILE_GUTTER_PX * 0.5);
      entry.atom.targetX = r.x + r.width * 0.5;
      entry.atom.targetY = -(r.y + r.height * 0.5);
      entry.atom.targetZ = 0;
      entry.atom.renderSize = Math.max(10, Math.min(r.width, r.height) * scale);
      entry.atom.treeRole = "leaf";
      entry.atom.treeDepth = 0;
      entry.atom.growthPhase = 1;
      entry.atom.parentId = undefined;
      entry.atom.descendantCount = 0;
      panelByAtomId.set(entry.atom.id, rank);
      applyInitialPosition(entry.atom);
    }

    panels.push({
      rank,
      label: panelLabel(rank, mode),
      x: panelRect.x + panelRect.width * 0.5,
      y: -(panelRect.y + panelRect.height * 0.5),
      width: panelRect.width,
      height: panelRect.height,
    });
  }

  return { panels, panelByAtomId, treeEdges: [], treeStats: EMPTY_TREE_STATS };
}

export function assignGridTargets(
  atoms: Atom[],
  viewportWorldWidth: number,
  viewportWorldHeight: number,
  baseSize: number,
  mode: LayoutMode,
  panelScaleByRank: Map<number, number> = new Map(),
): GroupLayoutResult {
  if (atoms.length === 0) {
    return { panels: [], panelByAtomId: new Map(), treeEdges: [], treeStats: EMPTY_TREE_STATS };
  }

  const nowMs = Date.now();
  atoms.sort((a, b) => modeComparator(a, b, mode, nowMs));
  if (mode === "score") {
    layoutScoreMode(atoms, viewportWorldWidth, viewportWorldHeight, baseSize);
    return { panels: [], panelByAtomId: new Map(), treeEdges: [], treeStats: EMPTY_TREE_STATS };
  }
  if (mode === "constellation") {
    layoutConstellationMode(atoms, viewportWorldWidth, viewportWorldHeight, baseSize);
    return { panels: [], panelByAtomId: new Map(), treeEdges: [], treeStats: EMPTY_TREE_STATS };
  }
  if (mode === "growth_tree") {
    const result = layoutGrowthTreeMode(atoms, viewportWorldWidth, viewportWorldHeight, baseSize);
    return { panels: [], panelByAtomId: new Map(), treeEdges: result.edges, treeStats: result.stats };
  }

  return assignGroupedTreemapTargets(atoms, viewportWorldWidth, viewportWorldHeight, mode, panelScaleByRank);
}

export function easePosition(atoms: Atom[], dtSec: number, k = 14): void {
  if (atoms.length === 0) return;
  const alpha = 1 - Math.exp(-dtSec * k);
  for (const atom of atoms) {
    atom.x += (atom.targetX - atom.x) * alpha;
    atom.y += (atom.targetY - atom.y) * alpha;
    atom.z += (atom.targetZ - atom.z) * alpha;
  }
}
