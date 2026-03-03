import type { Atom } from "../data/types";

const GUTTER_MULTIPLIER = 1.15;

export function assignGridTargets(atoms: Atom[], viewportWorldWidth: number, baseSize: number): void {
  if (atoms.length === 0) return;
  const slotSpacing = baseSize * GUTTER_MULTIPLIER;
  const cols = Math.max(1, Math.floor(viewportWorldWidth / slotSpacing));

  atoms.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.ts !== a.ts) return b.ts - a.ts;
    return a.stableKey - b.stableKey;
  });

  for (let i = 0; i < atoms.length; i += 1) {
    const sx = i % cols;
    const sy = Math.floor(i / cols);
    const atom = atoms[i];
    atom.targetX = (sx - cols / 2) * slotSpacing;
    atom.targetY = -sy * slotSpacing;
    if (atom.x === 0 && atom.y === 0) {
      atom.x = atom.targetX;
      atom.y = atom.targetY;
    }
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
