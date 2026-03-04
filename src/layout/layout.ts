export type LayoutMode = "smoke_field";

import type { Atom } from "../data/types";

export const TILE_GUTTER_PX = 4;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function scoreComparator(a: Atom, b: Atom): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.ts !== a.ts) return b.ts - a.ts;
  return a.stableKey - b.stableKey;
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

export function assignSmokeTargets(atoms: Atom[], viewportWorldWidth: number, viewportWorldHeight: number, baseSize: number): void {
  if (atoms.length === 0) return;
  atoms.sort(scoreComparator);
  const n = atoms.length;
  const ringStep = Math.max(baseSize * 1.1, Math.min(viewportWorldWidth, viewportWorldHeight) * 0.013);
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < n; i += 1) {
    const atom = atoms[i];
    const radius = Math.sqrt(i + 1) * ringStep;
    const theta = i * golden + atom.stableKey * 0.00031;
    const lane = (atom.stableKey % 7) - 3;
    const swirl = Math.sin(theta * 1.7 + atom.importance * 5) * 0.12;

    atom.targetX = Math.cos(theta + swirl) * radius + lane * 2;
    atom.targetY = Math.sin(theta * 0.94 + swirl) * radius * 0.58;
    atom.targetZ = (atom.urgency * 2 - 1) * 120 + Math.sin(theta * 0.37) * 18;
    atom.renderSize = tileSizeForTier(baseSize, atom.sizeTier);
    atom.treeDepth = clamp01(i / Math.max(1, n - 1));
    atom.treeRole = "leaf";
    atom.growthPhase = 1;
    atom.parentId = undefined;
    atom.descendantCount = 0;

    if (atom.x === 0 && atom.y === 0 && atom.z === 0) {
      atom.x = atom.targetX;
      atom.y = atom.targetY;
      atom.z = atom.targetZ;
    }
  }

  const maxExtent = Math.max(...atoms.map((a) => Math.max(Math.abs(a.targetX), Math.abs(a.targetY)))) || 1;
  const fitX = (viewportWorldWidth * 0.42) / maxExtent;
  const fitY = (viewportWorldHeight * 0.35) / maxExtent;
  const scale = Math.max(0.35, Math.min(1.35, Math.min(fitX, fitY)));
  for (const atom of atoms) {
    atom.targetX *= scale;
    atom.targetY *= scale;
    atom.targetZ *= scale;
    atom.renderSize = Math.max(8, atom.renderSize * (0.72 + atom.importance * 0.42));
  }
}

export function easePosition(atoms: Atom[], dtSec: number, k = 10): void {
  if (atoms.length === 0) return;
  const alpha = 1 - Math.exp(-dtSec * k);
  for (const atom of atoms) {
    atom.x += (atom.targetX - atom.x) * alpha;
    atom.y += (atom.targetY - atom.y) * alpha;
    atom.z += (atom.targetZ - atom.z) * alpha;
  }
}
