import type { Atom } from "../data/types";
import { tileSizeForTier } from "./layout";

type Cell = {
  indices: number[];
};

export class SpatialHash {
  private cellSize = 64;
  private baseSize = 22;
  private map = new Map<string, Cell>();
  private atoms: Atom[] = [];

  rebuild(atoms: Atom[], cellSize: number, baseSize: number): void {
    this.map.clear();
    this.atoms = atoms;
    this.cellSize = Math.max(1, cellSize);
    this.baseSize = baseSize;

    for (let i = 0; i < atoms.length; i += 1) {
      const atom = atoms[i];
      const cx = Math.floor(atom.x / this.cellSize);
      const cy = Math.floor(atom.y / this.cellSize);
      const key = this.key(cx, cy);
      const bucket = this.map.get(key);
      if (bucket) {
        bucket.indices.push(i);
      } else {
        this.map.set(key, { indices: [i] });
      }
    }
  }

  pick(worldX: number, worldY: number): Atom | null {
    const cx = Math.floor(worldX / this.cellSize);
    const cy = Math.floor(worldY / this.cellSize);
    const bucket = this.map.get(this.key(cx, cy));
    if (!bucket) return null;

    for (const index of bucket.indices) {
      const atom = this.atoms[index];
      const size = tileSizeForTier(this.baseSize, atom.sizeTier);
      const half = size * 0.5;
      if (worldX >= atom.x - half && worldX <= atom.x + half && worldY >= atom.y - half && worldY <= atom.y + half) {
        return atom;
      }
    }
    return null;
  }

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }
}
