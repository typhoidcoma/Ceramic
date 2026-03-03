import type { Atom } from "../data/types";
import { tileSizeForTier } from "./layout";

type Cell = {
  indices: number[];
};

export class SpatialHash {
  private cellSize = 64;
  private baseSize = 22;
  private gutterPx = 0;
  private map = new Map<string, Cell>();
  private atoms: Atom[] = [];

  rebuild(atoms: Atom[], cellSize: number, baseSize: number, gutterPx = 0): void {
    this.map.clear();
    this.atoms = atoms;
    this.cellSize = Math.max(1, cellSize);
    this.baseSize = baseSize;
    this.gutterPx = Math.max(0, gutterPx);

    for (let i = 0; i < atoms.length; i += 1) {
      const atom = atoms[i];
      const baseSizePx = atom.renderSize > 0 ? atom.renderSize : tileSizeForTier(this.baseSize, atom.sizeTier);
      const depthNorm = Math.max(-1, Math.min(1, atom.z / 420));
      const size = baseSizePx * (1 + depthNorm * 0.35);
      const half = size * 0.5 + this.gutterPx * 0.5;
      const minCx = Math.floor((atom.x - half) / this.cellSize);
      const maxCx = Math.floor((atom.x + half) / this.cellSize);
      const minCy = Math.floor((atom.y - half) / this.cellSize);
      const maxCy = Math.floor((atom.y + half) / this.cellSize);
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        for (let cy = minCy; cy <= maxCy; cy += 1) {
          const key = this.key(cx, cy);
          const bucket = this.map.get(key);
          if (bucket) {
            bucket.indices.push(i);
          } else {
            this.map.set(key, { indices: [i] });
          }
        }
      }
    }
  }

  pick(worldX: number, worldY: number): Atom | null {
    const cx = Math.floor(worldX / this.cellSize);
    const cy = Math.floor(worldY / this.cellSize);
    const bucket = this.map.get(this.key(cx, cy));
    if (!bucket) return null;

    let best: Atom | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (const index of bucket.indices) {
      const atom = this.atoms[index];
      const baseSizePx = atom.renderSize > 0 ? atom.renderSize : tileSizeForTier(this.baseSize, atom.sizeTier);
      const depthNorm = Math.max(-1, Math.min(1, atom.z / 420));
      const size = baseSizePx * (1 + depthNorm * 0.35);
      const half = size * 0.5 + this.gutterPx * 0.5;
      if (worldX >= atom.x - half && worldX <= atom.x + half && worldY >= atom.y - half && worldY <= atom.y + half) {
        const dx = worldX - atom.x;
        const dy = worldY - atom.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
          best = atom;
          bestDistSq = distSq;
        }
      }
    }
    return best;
  }

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }
}
