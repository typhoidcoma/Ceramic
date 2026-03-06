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
  size: number; // 0-1 relative size (small splat vs massive crescent)
};

export type TendrilSpec = {
  theta: number;
  rayCount: number;
  lengthFactor: number;
};

export type CurlSpec = {
  theta: number;
  size: number; // 0-1
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
  smallCurls: CurlSpec[];
  tendrils: TendrilSpec[];
  gaps: GapSpec[];
};

const SECTOR_COUNT = 12;
const SECTOR_ARC = (Math.PI * 2) / SECTOR_COUNT;

export function generateGrammar(word: string): LogogramGrammar {
  const seed = hashStringU32(word.toLowerCase().trim());
  const rnd = seeded(seed);

  // Build 12-bit sector activation mask from the word
  // Each character influences multiple sectors for richer variety
  let mask = 0;
  for (let i = 0; i < word.length; i++) {
    const charHash = hashStringU32(word[i] + String(i) + word);
    mask |= 1 << (charHash % SECTOR_COUNT);
    // Secondary influence from character pairs
    if (i < word.length - 1) {
      const pairHash = hashStringU32(word[i] + word[i + 1] + String(i));
      mask |= 1 << (pairHash % SECTOR_COUNT);
    }
  }
  // Ensure at least 9 sectors are active
  while (popcount(mask) < 9) {
    mask |= 1 << (Math.floor(rnd() * SECTOR_COUNT));
  }

  // Ring parameters — varies based on word characteristics
  const wordLen = word.length;
  const ringRadius = 0.30 + rnd() * 0.06 + Math.min(wordLen * 0.003, 0.03);
  const ringBaseWidth = 0.028 + rnd() * 0.016;

  // Build sector specs with more dramatic thickness variation
  const sectors: SectorSpec[] = [];
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const active = (mask & (1 << i)) !== 0;
    // More extreme variation: some sectors are very thin, others very thick
    const baseThickness = active ? 0.30 + rnd() * 0.70 : 0;
    sectors.push({ active, thickness: baseThickness, role: "trunk" });
  }

  // Pick blob count based on word hash — 1 to 4 blobs
  // Short words (1-4 chars) tend to have fewer blobs
  const blobBias = Math.min(wordLen / 6, 1.0);
  const heavyCount = 1 + Math.floor(rnd() * (1.5 + blobBias * 2.0));

  // Find heaviest sectors for blob placement
  const activeSectors = sectors
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.active)
    .sort((a, b) => b.s.thickness - a.s.thickness);

  // Place blobs with minimum angular separation (~90° = 3 sectors)
  // If we can't find well-separated thick sectors, relax and try thinner ones
  const blobSectors: number[] = [];
  let placed = 0;
  const minSep = heavyCount <= 2 ? 3 : 2; // 90° for 1-2 blobs, 60° for 3-4
  for (let h = 0; placed < heavyCount && h < activeSectors.length; h++) {
    const candidate = activeSectors[h].i;
    const tooClose = blobSectors.some(bs => {
      const diff = Math.abs(candidate - bs);
      return Math.min(diff, SECTOR_COUNT - diff) < minSep;
    });
    if (tooClose) continue;
    blobSectors.push(candidate);
    placed++;
    sectors[candidate].role = "blob";
    sectors[candidate].thickness = Math.min(1.0, sectors[candidate].thickness * 1.5);
  }
  // If we couldn't place enough blobs with strict separation, relax to 2
  if (placed < heavyCount) {
    for (let h = 0; placed < heavyCount && h < activeSectors.length; h++) {
      const candidate = activeSectors[h].i;
      if (blobSectors.includes(candidate)) continue;
      const tooClose = blobSectors.some(bs => {
        const diff = Math.abs(candidate - bs);
        return Math.min(diff, SECTOR_COUNT - diff) < 2;
      });
      if (tooClose) continue;
      blobSectors.push(candidate);
      placed++;
      sectors[candidate].role = "blob";
      sectors[candidate].thickness = Math.min(1.0, sectors[candidate].thickness * 1.5);
    }
  }

  // Build blob specs — one dominant mass + smaller secondary blobs
  const blobs: BlobSpec[] = blobSectors.map((si, idx) => {
    const theta = -Math.PI + (si + 0.5) * SECTOR_ARC + (rnd() - 0.5) * SECTOR_ARC * 0.4;
    // First blob is huge (references show one dominant splatter)
    const sizeBase = idx === 0 ? 0.85 + rnd() * 0.15 : 0.25 + rnd() * 0.4;
    return {
      sectorIndex: si,
      theta,
      arcSpan: 0.3 + sizeBase * 0.4 + rnd() * 0.2,
      discCount: Math.floor(8 + sizeBase * 20 + rnd() * 10),
      radialBias: (rnd() - 0.5) * 0.6,
      size: sizeBase,
    };
  });

  // Build tendril specs — moderate radiating spikes from blob
  const tendrils: TendrilSpec[] = blobs.map((b) => ({
    theta: b.theta + (rnd() - 0.5) * 0.15,
    rayCount: Math.floor(6 + b.size * 10 + rnd() * 4),
    lengthFactor: 0.10 + rnd() * 0.10 + b.size * 0.12,
  }));

  // Assign tendril roles to adjacent sectors
  for (const t of tendrils) {
    const si = Math.floor(((t.theta + Math.PI) / (Math.PI * 2)) * SECTOR_COUNT) % SECTOR_COUNT;
    const adjL = (si + SECTOR_COUNT - 1) % SECTOR_COUNT;
    const adjR = (si + 1) % SECTOR_COUNT;
    if (sectors[adjL].role === "trunk") sectors[adjL].role = "tendril";
    if (sectors[adjR].role === "trunk") sectors[adjR].role = "tendril";
  }

  // Build gaps (0-2 small gaps)
  const gaps: GapSpec[] = [];
  const gapCount = rnd() < 0.4 ? 0 : rnd() < 0.8 ? 1 : 2;
  const sortedByThickness = sectors
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.role === "trunk" && x.s.active)
    .sort((a, b) => a.s.thickness - b.s.thickness);

  for (let g = 0; g < gapCount && g < sortedByThickness.length; g++) {
    const si = sortedByThickness[g].i;
    sectors[si].active = false;
    sectors[si].role = "gap";
    gaps.push({ startSector: si, span: 1 });
  }

  // Add noise-based thickness variation — more dramatic
  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (!sectors[i].active) continue;
    const theta = -Math.PI + (i + 0.5) * SECTOR_ARC;
    const noise = fbm2(seed ^ 0x1234abcd, theta * 2.0, i * 1.3, 3, 2.0, 0.5);
    sectors[i].thickness *= 0.5 + 0.5 * (noise * 0.5 + 0.5);
  }

  // Build small curls — 4-8 small shapes on ring exterior, avoiding blob sectors
  const curlCount = 4 + Math.floor(rnd() * 5);
  const smallCurls: CurlSpec[] = [];
  for (let c = 0; c < curlCount; c++) {
    const si = Math.floor(rnd() * SECTOR_COUNT);
    if (!sectors[si].active || sectors[si].role === "blob") continue;
    const theta = -Math.PI + (si + rnd()) * SECTOR_ARC;
    smallCurls.push({ theta, size: 0.1 + rnd() * 0.25 });
  }

  return { seed, ringRadius, ringBaseWidth, sectors, blobs, smallCurls, tendrils, gaps };
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
