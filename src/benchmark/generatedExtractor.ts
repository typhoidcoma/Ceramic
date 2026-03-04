import type { ReferenceMaskStats } from "../data/types";

type TaskFieldLike = {
  ringCoverageRatio: number;
  ringSectorOccupancy: number[];
  sectorOccupancy: number[];
  ringBandOccupancyRatio: number;
  innerVoidPenalty: number;
  logogramChannelCounts: { ring: number; tendril: number; hook: number };
  generatedRadialProfile?: number[];
  generatedAngularHistogram12?: number[];
  generatedGapCount?: number;
  generatedFrayDensity?: number;
  generatedStrokeWidthMean?: number;
  generatedStrokeWidthVar?: number;
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalize(values: number[], n: number): number[] {
  const out = Array.from({ length: n }, (_, i) => Math.max(0, values[i] ?? 0));
  const sum = out.reduce((a, b) => a + b, 0);
  if (sum <= 1e-6) return out.map(() => 0);
  return out.map((v) => v / sum);
}

function inferGapCount(ringBins: number[]): number {
  let gaps = 0;
  for (let i = 0; i < 12; i += 1) {
    const cur = ringBins[i] > 0.02 ? 1 : 0;
    const prev = ringBins[(i + 11) % 12] > 0.02 ? 1 : 0;
    if (cur === 0 && prev === 1) gaps += 1;
  }
  return gaps;
}

export function extractGeneratedMaskStats(input: TaskFieldLike): ReferenceMaskStats {
  const angular = normalize(input.generatedAngularHistogram12 ?? input.ringSectorOccupancy, 12);
  const radialRaw = input.generatedRadialProfile ?? [];
  const radial = normalize(radialRaw.length > 0 ? radialRaw : Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return Math.max(0, 1 - Math.abs(t - 0.72) * 3.2);
  }), 24);
  const inferredGaps = inferGapCount(angular);
  const generatedFray =
    input.generatedFrayDensity ??
    clamp01((input.logogramChannelCounts.tendril + input.logogramChannelCounts.hook) / Math.max(1, input.logogramChannelCounts.ring));
  return {
    ringCoverage: clamp01(input.ringCoverageRatio),
    gapCount: input.generatedGapCount ?? inferredGaps,
    radialProfile: radial,
    angularHistogram12: angular,
    frayDensity: generatedFray,
    strokeWidthMean: Math.max(0, input.generatedStrokeWidthMean ?? (0.2 + input.ringBandOccupancyRatio * 0.6)),
    strokeWidthVar: Math.max(0, input.generatedStrokeWidthVar ?? (0.08 + input.innerVoidPenalty * 0.2)),
  };
}
