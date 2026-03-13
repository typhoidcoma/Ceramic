export type EffectCategory =
  | "Datamosh"
  | "Distortion"
  | "Retro"
  | "Stylization"
  | "Procedural"
  | "Image"
  | "Composition"
  | "Utility";

export type DatamoshEffectId =
  | "dataMosh"
  | "feedback"
  | "softGlitch"
  | "hardGlitch"
  | "pixelSort"
  | "decimate";

export type StyleEffectId =
  | "stretch"
  | "wave"
  | "push"
  | "bulge"
  | "transform"
  | "transform3d"
  | "splitter"
  | "tile"
  | "kaleidoscope"
  | "vhs"
  | "super8"
  | "crt"
  | "cga"
  | "lightStreak"
  | "bleach"
  | "watercolor"
  | "grain"
  | "sharpen"
  | "blur"
  | "lumaMesh"
  | "opticalFlow"
  | "ascii"
  | "dither"
  | "overlay"
  | "mask"
  | "maskBlocks"
  | "chromaKey"
  | "colorCorrection"
  | "strobe";

export type EffectId = DatamoshEffectId | StyleEffectId;
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "add" | "difference" | "softLight";

export const BLEND_MODES: ReadonlyArray<{ id: BlendMode; label: string }> = [
  { id: "normal", label: "Normal" },
  { id: "multiply", label: "Multiply" },
  { id: "screen", label: "Screen" },
  { id: "overlay", label: "Overlay" },
  { id: "add", label: "Add" },
  { id: "difference", label: "Difference" },
  { id: "softLight", label: "Soft Light" },
];

export type EffectParamDef = {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  neutral: number;
};

export type EffectRegistryEntry = {
  id: EffectId;
  label: string;
  category: EffectCategory;
  defaultAmount: number;
  neutralParams: Record<string, number>;
  paramDefs: EffectParamDef[];
  shaderFn: string;
  supportsMask: boolean;
  supportsBlend: boolean;
  isDatamoshCore: boolean;
};

export type EffectLayer = {
  layerId: string;
  effectId: EffectId;
  enabled: boolean;
  amount: number;
  blend: number;
  blendMode: BlendMode;
  params: Record<string, number>;
};

export type BackgroundSource = {
  mode: "solidColor" | "image" | "video";
  underlayColor: [number, number, number];
  underlayOpacity: number;
  image?: ImageBitmap | null;
  video?: HTMLVideoElement | null;
};

export type GlobalOptions = {
  quality: number;
  pause: boolean;
  seed: number;
};

function makeNeutral(defs: EffectParamDef[]): Record<string, number> {
  const params: Record<string, number> = {};
  for (const def of defs) params[def.id] = def.neutral;
  return params;
}

function effect(
  id: EffectId,
  label: string,
  category: EffectCategory,
  paramDefs: EffectParamDef[],
  options: Partial<Omit<EffectRegistryEntry, "id" | "label" | "category" | "paramDefs" | "neutralParams">> = {},
): EffectRegistryEntry {
  return {
    id,
    label,
    category,
    defaultAmount: options.defaultAmount ?? 0,
    neutralParams: makeNeutral(paramDefs),
    paramDefs,
    shaderFn: options.shaderFn ?? id,
    supportsMask: options.supportsMask ?? false,
    supportsBlend: options.supportsBlend ?? true,
    isDatamoshCore: options.isDatamoshCore ?? false,
  };
}

export const EFFECT_REGISTRY: EffectRegistryEntry[] = [
  effect("dataMosh", "Data-Mosh", "Datamosh", [
    { id: "feedback", label: "Feedback", min: 0, max: 1.5, step: 0.01, neutral: 0.78 },
    { id: "decay", label: "Decay", min: 0, max: 0.6, step: 0.005, neutral: 0.05 },
    { id: "cleanBlend", label: "Blend To Clean", min: 0, max: 1, step: 0.01, neutral: 0.06 },
  ], { isDatamoshCore: true }),
  effect("feedback", "Feedback", "Datamosh", [
    { id: "displace", label: "Displace", min: 0, max: 0.45, step: 0.002, neutral: 0.12 },
  ], { isDatamoshCore: true }),
  effect("softGlitch", "Soft Glitch", "Datamosh", [
    { id: "warp", label: "Warp", min: 0, max: 3, step: 0.01, neutral: 0.9 },
  ], { isDatamoshCore: true }),
  effect("hardGlitch", "Hard Glitch", "Datamosh", [
    { id: "burst", label: "Burst", min: 0, max: 4, step: 0.01, neutral: 1.3 },
    { id: "rgb", label: "RGB Split", min: 0, max: 64, step: 0.5, neutral: 12 },
  ], { isDatamoshCore: true }),
  effect("pixelSort", "Pixel Sort", "Datamosh", [
    { id: "direction", label: "Direction", min: -1, max: 1, step: 0.01, neutral: 1 },
  ], { isDatamoshCore: true }),
  effect("decimate", "Decimate", "Datamosh", [
    { id: "blockSize", label: "Block Size", min: 1, max: 128, step: 1, neutral: 36 },
    { id: "randomSize", label: "Random Size", min: 0, max: 1, step: 0.01, neutral: 0.7 },
    { id: "stretch", label: "Stretch", min: 0.15, max: 6, step: 0.01, neutral: 1.8 },
  ], { isDatamoshCore: true }),

  effect("stretch", "Stretch", "Distortion", [
    { id: "axis", label: "Axis Bias", min: -1, max: 1, step: 0.01, neutral: 0 },
    { id: "strength", label: "Strength", min: 0, max: 3, step: 0.01, neutral: 1.1 },
  ]),
  effect("wave", "Wave", "Distortion", [
    { id: "frequency", label: "Frequency", min: 0.1, max: 120, step: 0.1, neutral: 10 },
    { id: "speed", label: "Speed", min: -20, max: 20, step: 0.1, neutral: 3 },
    { id: "amplitude", label: "Amplitude", min: 0, max: 0.5, step: 0.005, neutral: 0.12 },
  ]),
  effect("push", "Push", "Distortion", [
    { id: "radial", label: "Radial", min: 0, max: 2, step: 0.01, neutral: 1.1 },
    { id: "twist", label: "Twist", min: -1, max: 1, step: 0.01, neutral: 0 },
  ]),
  effect("bulge", "Bulge", "Distortion", [
    { id: "radius", label: "Radius", min: 0.02, max: 1, step: 0.01, neutral: 0.45 },
    { id: "pinch", label: "Pinch(-)/Bulge(+)", min: -2, max: 2, step: 0.01, neutral: 0.65 },
  ]),
  effect("transform", "Transform", "Distortion", [
    { id: "rotate", label: "Rotate", min: -6.2832, max: 6.2832, step: 0.01, neutral: 1.4 },
    { id: "zoom", label: "Zoom", min: 0.2, max: 3, step: 0.01, neutral: 1 },
  ]),
  effect("transform3d", "3D Transform", "Distortion", [
    { id: "perspective", label: "Perspective", min: -2, max: 2, step: 0.01, neutral: 0.8 },
    { id: "yaw", label: "Yaw", min: -1, max: 1, step: 0.01, neutral: 0 },
  ]),
  effect("splitter", "Splitter", "Distortion", [
    { id: "bands", label: "Bands", min: 2, max: 96, step: 1, neutral: 12 },
    { id: "offset", label: "Offset", min: 0, max: 1, step: 0.005, neutral: 0.2 },
  ]),
  effect("tile", "Tile", "Distortion", [
    { id: "count", label: "Count", min: 1, max: 40, step: 1, neutral: 3 },
  ]),
  effect("kaleidoscope", "Kaleidoscope", "Distortion", [
    { id: "segments", label: "Segments", min: 2, max: 32, step: 1, neutral: 7 },
    { id: "spin", label: "Spin", min: -4, max: 4, step: 0.01, neutral: 0.4 },
  ]),

  effect("vhs", "VHS", "Retro", [
    { id: "jitter", label: "Line Jitter", min: 0, max: 0.2, step: 0.001, neutral: 0.04 },
    { id: "bleed", label: "Color Bleed", min: 0, max: 1, step: 0.01, neutral: 0.2 },
    { id: "noise", label: "Noise", min: 0, max: 1, step: 0.01, neutral: 0.25 },
  ]),
  effect("super8", "Super 8", "Retro", [
    { id: "sepia", label: "Sepia", min: 0, max: 2, step: 0.01, neutral: 1 },
    { id: "vignette", label: "Vignette", min: 0, max: 1.5, step: 0.01, neutral: 0.55 },
    { id: "flicker", label: "Flicker", min: 0, max: 1, step: 0.01, neutral: 0.2 },
  ]),
  effect("crt", "CRT", "Retro", [
    { id: "scanline", label: "Scanline", min: 0, max: 1, step: 0.005, neutral: 0.25 },
    { id: "curvature", label: "Curvature", min: 0, max: 1, step: 0.01, neutral: 0.2 },
  ]),
  effect("cga", "8-Bit CGA", "Retro", [
    { id: "paletteMix", label: "Palette Mix", min: 0, max: 1, step: 0.01, neutral: 0.85 },
    { id: "posterize", label: "Posterize", min: 2, max: 12, step: 1, neutral: 4 },
  ]),

  effect("lightStreak", "Light Streak", "Stylization", [
    { id: "distance", label: "Distance", min: 1, max: 80, step: 1, neutral: 10 },
    { id: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01, neutral: 0.8 },
  ]),
  effect("bleach", "Bleach", "Stylization", [
    { id: "cutoff", label: "Cutoff", min: 0, max: 1, step: 0.01, neutral: 0.42 },
    { id: "strength", label: "Strength", min: 0, max: 2, step: 0.01, neutral: 1 },
  ]),
  effect("watercolor", "Watercolor", "Stylization", [
    { id: "levels", label: "Levels", min: 2, max: 40, step: 1, neutral: 10 },
    { id: "bleed", label: "Bleed", min: 0, max: 2, step: 0.01, neutral: 0.8 },
  ]),
  effect("grain", "Grain", "Stylization", [
    { id: "speed", label: "Speed", min: 0, max: 40, step: 0.1, neutral: 8 },
    { id: "size", label: "Size", min: 0.2, max: 4, step: 0.01, neutral: 1 },
    { id: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01, neutral: 0.8 },
  ]),
  effect("sharpen", "Sharpen", "Stylization", [
    { id: "strength", label: "Strength", min: 0, max: 3, step: 0.01, neutral: 1.2 },
    { id: "radius", label: "Radius", min: 0.5, max: 4, step: 0.01, neutral: 1 },
  ]),
  effect("blur", "Blur", "Stylization", [
    { id: "radius", label: "Radius", min: 0.5, max: 12, step: 0.01, neutral: 1.6 },
    { id: "mix", label: "Mix", min: 0, max: 1, step: 0.01, neutral: 1 },
  ]),

  effect("lumaMesh", "Luma-Mesh", "Procedural", [
    { id: "scale", label: "Scale", min: 0, max: 0.3, step: 0.001, neutral: 0.06 },
    { id: "phase", label: "Phase", min: -2, max: 2, step: 0.01, neutral: 0 },
  ]),
  effect("opticalFlow", "Optical-Flow", "Procedural", [
    { id: "scale", label: "Flow Scale", min: 0, max: 8, step: 0.05, neutral: 2.2 },
    { id: "smoothness", label: "Smoothness", min: 0, max: 1.5, step: 0.01, neutral: 0.25 },
  ]),

  effect("ascii", "Ascii", "Image", [
    { id: "cells", label: "Cell Count", min: 4, max: 220, step: 1, neutral: 32 },
    { id: "contrast", label: "Contrast", min: 0.2, max: 3, step: 0.01, neutral: 1.2 },
  ]),
  effect("dither", "Dither", "Image", [
    { id: "levels", label: "Levels", min: 2, max: 16, step: 1, neutral: 6 },
    { id: "spread", label: "Spread", min: 0, max: 1, step: 0.01, neutral: 0.5 },
  ]),

  effect("overlay", "Overlay", "Composition", [
    { id: "hue", label: "Hue", min: 0, max: 1, step: 0.01, neutral: 0.55 },
    { id: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01, neutral: 0.8 },
  ]),
  effect("mask", "Mask", "Composition", [
    { id: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, neutral: 0.5 },
    { id: "softness", label: "Softness", min: 0, max: 1, step: 0.01, neutral: 0.2 },
    { id: "invert", label: "Invert", min: 0, max: 1, step: 1, neutral: 0 },
  ], { supportsMask: true }),
  effect("maskBlocks", "Mask Blocks", "Composition", [
    { id: "mode", label: "Mode (0 grid,1 noisy,2 cell)", min: 0, max: 2, step: 1, neutral: 0 },
    { id: "size", label: "Block Size", min: 2, max: 160, step: 1, neutral: 28 },
    { id: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, neutral: 0.5 },
    { id: "softness", label: "Softness", min: 0, max: 1, step: 0.01, neutral: 0.2 },
    { id: "invert", label: "Invert", min: 0, max: 1, step: 1, neutral: 0 },
    { id: "jitter", label: "Jitter", min: 0, max: 1, step: 0.01, neutral: 0.3 },
    { id: "invert", label: "Invert", min: 0, max: 1, step: 1, neutral: 0 },
    { id: "edgeGlow", label: "Edge Glow", min: 0, max: 2, step: 0.01, neutral: 0.3 },
    { id: "source", label: "Source (0 luma,1 chroma)", min: 0, max: 1, step: 1, neutral: 0 },
  ], { supportsMask: true }),
  effect("chromaKey", "Chroma Key", "Composition", [
    { id: "keyHue", label: "Key Hue", min: 0, max: 1, step: 0.01, neutral: 0.33 },
    { id: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, neutral: 0.45 },
    { id: "softness", label: "Softness", min: 0, max: 1, step: 0.01, neutral: 0.35 },
    { id: "spill", label: "Spill", min: 0, max: 1, step: 0.01, neutral: 0.2 },
  ], { supportsMask: true }),

  effect("colorCorrection", "Color Correction", "Utility", [
    { id: "saturation", label: "Saturation", min: 0, max: 4, step: 0.01, neutral: 1.4 },
    { id: "contrast", label: "Contrast", min: 0, max: 4, step: 0.01, neutral: 1.25 },
    { id: "brightness", label: "Brightness", min: -1, max: 1, step: 0.01, neutral: 0 },
    { id: "hueShift", label: "Hue Shift", min: -1, max: 1, step: 0.01, neutral: 0 },
  ]),
  effect("strobe", "Strobe", "Utility", [
    { id: "rate", label: "Rate", min: 0.2, max: 60, step: 0.1, neutral: 8 },
    { id: "duty", label: "Duty", min: 0.05, max: 0.95, step: 0.01, neutral: 0.35 },
    { id: "intensity", label: "Intensity", min: 0, max: 3, step: 0.01, neutral: 1.3 },
  ]),
];

export const EFFECT_BY_ID: Record<EffectId, EffectRegistryEntry> = Object.fromEntries(
  EFFECT_REGISTRY.map((entry) => [entry.id, entry]),
) as Record<EffectId, EffectRegistryEntry>;

export function createLayer(effectId: EffectId, layerId: string): EffectLayer {
  const def = EFFECT_BY_ID[effectId];
  return {
    layerId,
    effectId,
    enabled: true,
    amount: 1,
    blend: 1,
    blendMode: "normal",
    params: { ...def.neutralParams },
  };
}















