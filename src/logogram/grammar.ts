import { hashStringU32, seeded, fbm2 } from "../utils/noise";

export type SectorSpec = {
  active: boolean;
  thickness: number;
  role: "trunk" | "blob" | "gap" | "tendril";
};

export type BlobSpec = {
  sectorIndex: number;
  theta: number;
  arcSpan: number;
  discCount: number;
  radialBias: number;
};

export type TendrilSpec = {
  theta: number;
  rayCount: number;
  lengthFactor: number;
};

export type GapSpec = {
  startSector: number;
  span: number;
};

export type LogogramGrammar = {
  seed: number;
  ringRadius: number;
  ringBaseWidth: number;
  sectors: SectorSpec[];
  blobs: BlobSpec[];
  tendrils: TendrilSpec[];
  gaps: GapSpec[];
};

const SECTOR_COUNT = 12;
const SECTOR_ARC = (Math.PI * 2) / SECTOR_COUNT;

export function generateGrammar(word: string): LogogramGrammar {
  const seed = hashStringU32(word.toLowerCase().trim());
  const rnd = seeded(seed);

  // Build 12-bit sector activation mask from the word
  let mask = 0;
  for (let i = 0; i < word.length; i++) {
    const charHash = hashStringU32(word[i] + String(i) + word);
    mask |= 1 << (charHash % SECTOR_COUNT);
  }
  // Ensure at least 6 sectors are active for visual presence
  while (popcount(mask) < 6) {
    mask |= 1 << (Math.floor(rnd() * SECTOR_COUNT));
  }

  // Ring parameters
  const ringRadius = 0.30 + rnd() * 0.06;
  const ringBaseWidth = 0.018 + rnd() * 0.014;

  // Build sector specs
  const sectors: SectorSpec[] = [];
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const active = (mask & (1 << i)) !== 0;
    const thickness = active ? 0.4 + rnd() * 0.6 : 0;
    sectors.push({ active, thickness, role: "trunk" });
  }

  // Pick 1-3 heavy sectors for blobs
  const heavyCount = 1 + Math.floor(rnd() * 2.5);
  const activeSectors = sectors
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.active)
    .sort((a, b) => b.s.thickness - a.s.thickness);

  const blobSectors: number[] = [];
  for (let h = 0; h < heavyCount && h < activeSectors.length; h++) {
    blobSectors.push(activeSectors[h].i);
    sectors[activeSectors[h].i].role = "blob";
    sectors[activeSectors[h].i].thickness = Math.min(1.0, sectors[activeSectors[h].i].thickness * 1.4);
  }

  // Build blob specs
  const blobs: BlobSpec[] = blobSectors.map((si) => {
    const theta = -Math.PI + (si + 0.5) * SECTOR_ARC + (rnd() - 0.5) * SECTOR_ARC * 0.4;
    return {
      sectorIndex: si,
      theta,
      arcSpan: 0.15 + rnd() * 0.25,
      discCount: 5 + Math.floor(rnd() * 8),
      radialBias: (rnd() - 0.5) * 0.6,
    };
  });

  // Build tendril specs (one per blob)
  const tendrils: TendrilSpec[] = blobs.map((b) => ({
    theta: b.theta + (rnd() - 0.5) * 0.2,
    rayCount: 3 + Math.floor(rnd() * 5),
    lengthFactor: 0.08 + rnd() * 0.14,
  }));

  // Assign tendril roles
  for (const t of tendrils) {
    const si = Math.floor(((t.theta + Math.PI) / (Math.PI * 2)) * SECTOR_COUNT) % SECTOR_COUNT;
    const adjL = (si + SECTOR_COUNT - 1) % SECTOR_COUNT;
    const adjR = (si + 1) % SECTOR_COUNT;
    if (sectors[adjL].role === "trunk") sectors[adjL].role = "tendril";
    if (sectors[adjR].role === "trunk") sectors[adjR].role = "tendril";
  }

  // Build gaps (0-2, at weakest sectors)
  const gaps: GapSpec[] = [];
  const gapCount = Math.floor(rnd() * 2.5);
  const sortedByThickness = sectors
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.role === "trunk" && x.s.active)
    .sort((a, b) => a.s.thickness - b.s.thickness);

  for (let g = 0; g < gapCount && g < sortedByThickness.length; g++) {
    const si = sortedByThickness[g].i;
    sectors[si].active = false;
    sectors[si].role = "gap";
    gaps.push({ startSector: si, span: 1 + (rnd() < 0.3 ? 1 : 0) });
    // Deactivate adjacent if span > 1
    if (gaps[gaps.length - 1].span > 1) {
      const adj = (si + 1) % SECTOR_COUNT;
      if (sectors[adj].role === "trunk") {
        sectors[adj].active = false;
        sectors[adj].role = "gap";
      }
    }
  }

  // Add noise-based thickness variation
  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (!sectors[i].active) continue;
    const theta = -Math.PI + (i + 0.5) * SECTOR_ARC;
    const noise = fbm2(seed ^ 0x1234abcd, theta * 2.0, i * 1.3, 2, 2.0, 0.5);
    sectors[i].thickness *= 0.7 + 0.3 * (noise * 0.5 + 0.5);
  }

  return { seed, ringRadius, ringBaseWidth, sectors, blobs, tendrils, gaps };
}

function popcount(n: number): number {
  let count = 0;
  let v = n;
  while (v) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}
