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
export const NOISE_OCTAVES_DEFAULT = 3;
export const FRAY_DENSITY_DEFAULT = 0.5;
export const CLUMP_DENSITY_DEFAULT = 0.5;
export const STAMP_JITTER_TIME_SCALE = 0.32;
export const BENCH_TARGET_FPS = 45;
export const BENCH_MIN_FPS_WINDOW_MS = 2000;
export const BENCH_MAX_ACTIVE_POINTS = 1800;
export const BENCH_MAX_PREV_POINTS = 900;

export const INK_FLUID_PROFILE = {
  fogDensity: 0.9,
  contrast: 1.08,
  grainAmount: 0.012,
  fogBaseLuma: 0.68,
  pigmentAbsorption: 2.28,
  carrierScattering: 0.22,
  inkRetention: 0.989,
  compositeMode: "subtractive_ink_v2",
} as const;
