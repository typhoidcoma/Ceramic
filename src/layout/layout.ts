import type { Atom } from "../data/types";

export const TILE_GUTTER_PX = 4;
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
const DAY_MS = 24 * 60 * 60 * 1000;

export type LayoutMode = "score" | "due" | "type" | "state";

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

export function spanFromTier(tier: 0 | 1 | 2): number {
  if (tier === 2) return 3;
  if (tier === 1) return 2;
  return 1;
}

export function tileSizeForTier(baseSize: number, tier: 0 | 1 | 2): number {
  const span = spanFromTier(tier);
  return baseSize * span + TILE_GUTTER_PX * (span - 1);
}

function computeBounds(atoms: Atom[], baseSize: number): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const atom of atoms) {
    const half = tileSizeForTier(baseSize, atom.sizeTier) * 0.5;
    minX = Math.min(minX, atom.targetX - half);
    maxX = Math.max(maxX, atom.targetX + half);
    minY = Math.min(minY, atom.targetY - half);
    maxY = Math.max(maxY, atom.targetY + half);
  }
  return { minX, maxX, minY, maxY };
}

function normalizeTargetsToViewport(atoms: Atom[], baseSize: number, viewportWorldWidth: number, viewportWorldHeight: number): void {
  if (atoms.length === 0) return;
  const bounds = computeBounds(atoms, baseSize);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;

  const fitScale = Math.min((viewportWorldWidth * 0.92) / width, (viewportWorldHeight * 0.86) / height);
  const scale = Math.max(1, Math.min(1.8, fitScale));
  for (const atom of atoms) {
    atom.targetX = (atom.targetX - cx) * scale;
    atom.targetY = (atom.targetY - cy) * scale;
  }
}

function applyInitialPosition(atom: Atom): void {
  if (atom.x === 0 && atom.y === 0) {
    atom.x = atom.targetX;
    atom.y = atom.targetY;
  }
}

function packGroup(atoms: Atom[], cols: number, slotSpacing: number): void {
  const skyline = new Int32Array(cols);
  for (const atom of atoms) {
    const span = Math.min(cols, spanFromTier(atom.sizeTier));
    let bestX = 0;
    let bestY = Number.POSITIVE_INFINITY;

    for (let x = 0; x <= cols - span; x += 1) {
      let y = 0;
      for (let i = 0; i < span; i += 1) {
        y = Math.max(y, skyline[x + i]);
      }
      if (y < bestY) {
        bestY = y;
        bestX = x;
      }
    }

    const placedY = Number.isFinite(bestY) ? bestY : 0;
    const newHeight = placedY + span;
    for (let i = 0; i < span; i += 1) {
      skyline[bestX + i] = newHeight;
    }

    const centerX = bestX + (span - 1) * 0.5;
    const centerY = placedY + (span - 1) * 0.5;
    atom.targetX = (centerX - cols / 2) * slotSpacing;
    atom.targetY = -centerY * slotSpacing;
    applyInitialPosition(atom);
  }
}

function fitAndTranslateGroup(
  atoms: Atom[],
  baseSize: number,
  panelWidth: number,
  panelHeight: number,
  panelCenterX: number,
  panelCenterY: number,
): void {
  if (atoms.length === 0) return;
  const bounds = computeBounds(atoms, baseSize);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;
  const fitScale = Math.min((panelWidth * 0.9) / width, (panelHeight * 0.82) / height);
  const scale = Math.max(0.35, Math.min(1.8, fitScale));

  for (const atom of atoms) {
    atom.targetX = (atom.targetX - cx) * scale + panelCenterX;
    atom.targetY = (atom.targetY - cy) * scale + panelCenterY;
    applyInitialPosition(atom);
  }
}

export function assignGridTargets(
  atoms: Atom[],
  viewportWorldWidth: number,
  viewportWorldHeight: number,
  baseSize: number,
  mode: LayoutMode,
): void {
  if (atoms.length === 0) return;
  const nowMs = Date.now();
  const slotSpacing = baseSize + TILE_GUTTER_PX;
  const groups = new Map<number, Atom[]>();

  for (const atom of atoms) {
    const rank = groupRank(atom, mode, nowMs);
    const bucket = groups.get(rank);
    if (bucket) {
      bucket.push(atom);
    } else {
      groups.set(rank, [atom]);
    }
  }

  const orderedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  if (mode === "score" || orderedGroups.length <= 1) {
    const cols = Math.max(1, Math.floor(viewportWorldWidth / slotSpacing));
    const merged = orderedGroups.flatMap((entry) => entry[1]);
    merged.sort((a, b) => modeComparator(a, b, mode, nowMs));
    packGroup(merged, cols, slotSpacing);
    normalizeTargetsToViewport(atoms, baseSize, viewportWorldWidth, viewportWorldHeight);
    return;
  }

  const panelCols = Math.max(1, Math.ceil(Math.sqrt(orderedGroups.length)));
  const panelRows = Math.max(1, Math.ceil(orderedGroups.length / panelCols));
  const panelWidth = viewportWorldWidth / panelCols;
  const panelHeight = viewportWorldHeight / panelRows;

  for (let i = 0; i < orderedGroups.length; i += 1) {
    const items = orderedGroups[i][1];
    items.sort((a, b) => modeComparator(a, b, mode, nowMs));
    const col = i % panelCols;
    const row = Math.floor(i / panelCols);
    const localCols = Math.max(1, Math.floor((panelWidth * 0.88) / slotSpacing));
    packGroup(items, localCols, slotSpacing);

    const panelCenterX = (col - (panelCols - 1) * 0.5) * panelWidth;
    const panelCenterY = ((panelRows - 1) * 0.5 - row) * panelHeight;
    fitAndTranslateGroup(items, baseSize, panelWidth, panelHeight, panelCenterX, panelCenterY);
  }
}
export function easePosition(atoms: Atom[], dtSec: number, k = 14): void {
  if (atoms.length === 0) return;
  const alpha = 1 - Math.exp(-dtSec * k);
  for (const atom of atoms) {
    atom.x += (atom.targetX - atom.x) * alpha;
    atom.y += (atom.targetY - atom.y) * alpha;
  }
}
