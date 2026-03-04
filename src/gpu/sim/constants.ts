export type QualityTier = "safe" | "balanced" | "high";

export type QualityPreset = {
  simResolutionScale: number;
  pressureIterations: number;
  compositeSamples: number;
};

export const MAX_TASK_POINTS = 8192;
export const BASE_TILE_SIZE = 20;

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  safe: {
    simResolutionScale: 0.4,
    pressureIterations: 8,
    compositeSamples: 12,
  },
  balanced: {
    simResolutionScale: 0.5,
    pressureIterations: 14,
    compositeSamples: 18,
  },
  high: {
    simResolutionScale: 0.65,
    pressureIterations: 20,
    compositeSamples: 24,
  },
};

export const WORKGROUP_SIZE = 8;
