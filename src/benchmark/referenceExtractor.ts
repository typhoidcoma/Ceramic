import type { ReferenceLogogramSample, ReferenceMaskStats } from "../data/types";

export type GrayImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeHistogram(values: number[]): number[] {
  const sum = values.reduce((acc, v) => acc + v, 0);
  if (sum <= 1e-6) return values.map(() => 0);
  return values.map((v) => v / sum);
}

export function deriveLabelFromFilename(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function computeMaskStats(image: GrayImage): ReferenceMaskStats {
  const { width, height, data } = image;
  const total = width * height;
  if (total === 0) {
    return {
      ringCoverage: 0,
      gapCount: 0,
      radialProfile: Array.from({ length: 24 }, () => 0),
      angularHistogram12: Array.from({ length: 12 }, () => 0),
      frayDensity: 0,
      strokeWidthMean: 0,
      strokeWidthVar: 0,
    };
  }

  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const mean = sum / data.length;
  const threshold = Math.max(24, Math.min(180, mean * 0.72));

  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const rMax = Math.max(1, Math.min(width, height) * 0.5);
  const radialBins = Array.from({ length: 24 }, () => 0);
  const angularBins = Array.from({ length: 12 }, () => 0);
  const sectorPresence = Array.from({ length: 12 }, () => 0);
  let darkCount = 0;
  let frayCount = 0;
  let ringBandDark = 0;
  let widthSum = 0;
  let widthSumSq = 0;
  let widthCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const v = data[idx];
      if (v > threshold) continue;
      darkCount += 1;
      const dx = x - cx;
      const dy = y - cy;
      const rNorm = clamp01(Math.hypot(dx, dy) / rMax);
      const rb = Math.min(radialBins.length - 1, Math.floor(rNorm * radialBins.length));
      radialBins[rb] += 1;
      const a = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
      const sb = Math.min(11, Math.floor((a / (Math.PI * 2)) * 12));
      angularBins[sb] += 1;
      sectorPresence[sb] += 1;
      if (rNorm >= 0.45 && rNorm <= 0.95) ringBandDark += 1;
      if (rNorm < 0.35 || rNorm > 0.96) frayCount += 1;

      let local = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (data[nIdx] <= threshold) local += 1;
        }
      }
      const widthLike = 9 - local;
      widthSum += widthLike;
      widthSumSq += widthLike * widthLike;
      widthCount += 1;
    }
  }

  const angularNorm = normalizeHistogram(angularBins);
  const radialNorm = normalizeHistogram(radialBins);
  let gapCount = 0;
  for (let i = 0; i < 12; i += 1) {
    const cur = sectorPresence[i] > 4 ? 1 : 0;
    const prev = sectorPresence[(i + 11) % 12] > 4 ? 1 : 0;
    if (cur === 0 && prev === 1) gapCount += 1;
  }

  const strokeWidthMean = widthCount > 0 ? widthSum / widthCount : 0;
  const strokeWidthVar = widthCount > 0 ? Math.max(0, widthSumSq / widthCount - strokeWidthMean * strokeWidthMean) : 0;

  return {
    ringCoverage: darkCount > 0 ? clamp01(ringBandDark / darkCount) : 0,
    gapCount,
    radialProfile: radialNorm,
    angularHistogram12: angularNorm,
    frayDensity: darkCount > 0 ? clamp01(frayCount / darkCount) : 0,
    strokeWidthMean,
    strokeWidthVar,
  };
}

export function normalizeReferenceSamples(entries: ReferenceLogogramSample[]): ReferenceLogogramSample[] {
  return entries.map((entry) => ({
    ...entry,
    maskStats: {
      ...entry.maskStats,
      ringCoverage: clamp01(entry.maskStats.ringCoverage),
      gapCount: Math.max(0, Math.floor(entry.maskStats.gapCount)),
      radialProfile: normalizeHistogram(entry.maskStats.radialProfile),
      angularHistogram12: normalizeHistogram(entry.maskStats.angularHistogram12),
      frayDensity: clamp01(entry.maskStats.frayDensity),
      strokeWidthMean: Math.max(0, entry.maskStats.strokeWidthMean),
      strokeWidthVar: Math.max(0, entry.maskStats.strokeWidthVar),
    },
  }));
}
