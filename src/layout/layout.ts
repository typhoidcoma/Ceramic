import type { Atom } from "../data/types";

const GUTTER_MULTIPLIER = 1.15;
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

export function assignGridTargets(atoms: Atom[], viewportWorldWidth: number, baseSize: number, mode: LayoutMode): void {
  if (atoms.length === 0) return;
  const nowMs = Date.now();
  const slotSpacing = baseSize * GUTTER_MULTIPLIER;
  const cols = Math.max(1, Math.floor(viewportWorldWidth / slotSpacing));
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
  let rowOffset = 0;
  for (let g = 0; g < orderedGroups.length; g += 1) {
    const items = orderedGroups[g][1];
    items.sort((a, b) => modeComparator(a, b, mode, nowMs));
    for (let i = 0; i < items.length; i += 1) {
      const sx = i % cols;
      const sy = Math.floor(i / cols) + rowOffset;
      const atom = items[i];
      atom.targetX = (sx - cols / 2) * slotSpacing;
      atom.targetY = -sy * slotSpacing;
      if (atom.x === 0 && atom.y === 0) {
        atom.x = atom.targetX;
        atom.y = atom.targetY;
      }
    }
    rowOffset += Math.ceil(items.length / cols) + (orderedGroups.length > 1 ? 1 : 0);
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
