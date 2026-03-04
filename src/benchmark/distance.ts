import type { ReferenceBenchmarkDistance, ReferenceMaskStats } from "../data/types";

function l2(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function computeMorphologyDistance(generated: ReferenceMaskStats, reference: ReferenceMaskStats): ReferenceBenchmarkDistance {
  const radial = l2(generated.radialProfile, reference.radialProfile);
  const angular = l2(generated.angularHistogram12, reference.angularHistogram12);
  const gaps = clamp01(Math.abs(generated.gapCount - reference.gapCount) / 4);
  const fray = clamp01(Math.abs(generated.frayDensity - reference.frayDensity));
  const width =
    clamp01(Math.abs(generated.strokeWidthMean - reference.strokeWidthMean) / Math.max(1e-3, reference.strokeWidthMean + 0.2)) * 0.7 +
    clamp01(Math.abs(generated.strokeWidthVar - reference.strokeWidthVar) / Math.max(1e-3, reference.strokeWidthVar + 0.2)) * 0.3;
  const total = radial * 0.3 + angular * 0.3 + gaps * 0.15 + fray * 0.15 + width * 0.1;
  return { radial, angular, gaps, fray, width, total };
}
