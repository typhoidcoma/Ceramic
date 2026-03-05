import type { Atom, LogogramSolveBreakdown, MatchedLogogram } from "../../data/types";
import { CLUMP_DENSITY_DEFAULT, FRAY_DENSITY_DEFAULT, NOISE_OCTAVES_DEFAULT } from "../sim/constants";
import { angleForSector, buildEnergyInputs, quantizeSolvedState, solveLogogramState } from "./logogramEnergy";
import { mergeStyleWithProfile, resolveMorphologyProfile } from "./morphologyProfiles";

type SectorRole = "trunk" | "modifier" | "gap" | "hook" | "tendril";

export type TextureFieldParams = {
  textureSeed: number;
  noisePhase: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  frayDensity: number;
  clumpDensity: number;
};

export type LogogramGrammar = {
  canonicalKey: string;
  ringContinuity: number;
  sectorRoles: SectorRole[];
  primaryBranches: Array<{ sector: number; length: number; curvature: number; direction: -1 | 1 }>;
  hooks: Array<{ sector: number; size: number; direction: -1 | 1 }>;
  gapPlan: Array<{ startSector: number; span: number; softness: number }>;
  occupiedSectorCount: number;
  targetRadiusNorm: number;
  ringThicknessNorm: number;
  frayLevel: number;
  inkMassBias: number;
  gaps: Array<{ startSector: number; span: number; softness: number }>;
  thicknessProfile: number[];
  sweepSeed: number;
  sectorActivation: number[];
  sectorThickness: number[];
  sectorGapMask: number[];
  ringRadiusNorm: number;
  ringBandWidthNorm: number;
  modifierAnchors: Array<{ sector: number; kind: "tendril" | "hook"; weight: number }>;
  solveMetrics: { energy: number; continuity: number; voidPenalty: number; gapCount: number };
  solveBreakdown: LogogramSolveBreakdown;
  unwrapProfiles: { activationTheta: number[]; thicknessTheta: number[]; spurTheta: number[] };
  constraintViolationCount: number;
  shapeSignature: number[];
  signatureDistanceToCanonical: number;
  textureField: TextureFieldParams;
  procedural: {
    massBias: number;
    clumpCountBias: number;
    clumpSpanBias: number;
    tendrilCountBias: number;
    tendrilLengthBias: number;
    arcDropoutBias: number;
    ringCircleCountBias: number;
    ringCircleThicknessBias: number;
    ringCenterVariationBias: number;
    ringDiskCountBias: number;
    ringDiskRadiusBias: number;
    blobArcExtentBias: number;
    blobDiskCountBias: number;
    blobDiskRadiusBias: number;
    tendrilPrimaryCountBias: number;
    tendrilPrimaryLengthBias: number;
    tendrilWhiskerCountBias: number;
    tendrilNoiseExpBias: number;
    gapCountBias: number;
    gapSpanBias: number;
  };
};

export type LogogramDescriptor = {
  grammar: LogogramGrammar;
  baseRadius: number;
  complexity: number;
};

export type LogogramPoint = {
  x: number;
  y: number;
  thickness: number;
  phase: number;
  channel: "ring" | "blob" | "tendril";
  jitterU: number;
  jitterV: number;
  mass: number;
};

export type ProceduralMaskSpec = {
  ringArcs: Array<{ theta0: number; theta1: number; radius: number; thickness: number; centerJitter: number; sector: number; strength: number; massWeight: number }>;
  microStrokeCount: number;
  blobClusters: Array<{ theta: number; arcSpan: number; radialBias: number; diskCount: number; diskRadiusMin: number; diskRadiusMax: number }>;
  tendrilSpecs: Array<{ theta: number; count: number; lengthMin: number; lengthMax: number; curlMin: number; curlMax: number; noiseExp: number }>;
  seed: number;
};

type MaskSamplePoint = {
  x: number;
  y: number;
  mass: number;
  width: number;
  channel: "ring" | "blob" | "tendril";
  phase: number;
  flowBias: number;
};

export type SampleLogogramOptions = {
  freezeToken?: number;
};

export type ProceduralMaskRaster = {
  width: number;
  height: number;
  ringDensity: Float32Array;
  blobDensity: Float32Array;
  tendrilDensity: Float32Array;
  flowX?: Float32Array;
  flowY?: Float32Array;
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function hashMix(value: number): number {
  let x = value >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let v = seed >>> 0;
  return () => {
    v = hashMix(v + 0x9e3779b9);
    return (v & 0xffffffff) / 0x100000000;
  };
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function angularGaussian(theta: number, center: number, width: number): number {
  const d = wrapAngle(theta - center);
  return Math.exp(-(d * d) / Math.max(1e-4, 2 * width * width));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hash2d(seed: number, x: number, y: number): number {
  let h = seed >>> 0;
  h ^= Math.imul(x | 0, 0x9e3779b1);
  h = hashMix(h);
  h ^= Math.imul(y | 0, 0x85ebca6b);
  h = hashMix(h);
  return (h >>> 0) / 0xffffffff;
}

function valueNoise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;
  const sx = smoothstep(0, 1, fx);
  const sy = smoothstep(0, 1, fy);
  const v00 = hash2d(seed, x0, y0);
  const v10 = hash2d(seed, x1, y0);
  const v01 = hash2d(seed, x0, y1);
  const v11 = hash2d(seed, x1, y1);
  const ix0 = v00 + (v10 - v00) * sx;
  const ix1 = v01 + (v11 - v01) * sx;
  return ix0 + (ix1 - ix0) * sy;
}

function fbm2(seed: number, x: number, y: number, octaves: number, lacunarity: number, gain: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  const oct = Math.max(1, Math.floor(octaves));
  for (let i = 0; i < oct; i += 1) {
    const v = valueNoise2(seed + i * 1013904223, x * freq, y * freq) * 2 - 1;
    sum += v * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  if (norm <= 1e-6) return 0;
  return sum / norm;
}

function poissonCount(seedRnd: () => number, lambda: number): number {
  const l = Math.exp(-Math.max(0, lambda));
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= seedRnd();
  } while (p > l && k < 24);
  return Math.max(0, k - 1);
}

function deformRadius(
  theta: number,
  baseR: number,
  minR: number,
  maxR: number,
  tex: TextureFieldParams,
): number {
  const d = fbm2(
    tex.textureSeed ^ 0x1b873593,
    Math.cos(theta) * 1.7 + tex.noisePhase * 0.25,
    Math.sin(theta) * 1.7 + tex.noisePhase * 0.25,
    Math.max(2, tex.octaves - 1),
    tex.lacunarity,
    tex.gain,
  );
  const amp = 0.022;
  return Math.max(minR, Math.min(maxR, baseR * (1 + d * amp)));
}

function buildRoles(
  gapMask: number[],
  modifierAnchors: Array<{ sector: number; kind: "tendril" | "hook"; weight: number }>,
): SectorRole[] {
  const roles: SectorRole[] = Array.from({ length: 12 }, () => "modifier");
  for (let i = 0; i < 12; i += 1) if (gapMask[i] === 1) roles[i] = "gap";
  for (const anchor of modifierAnchors) {
    if (roles[anchor.sector] === "gap") continue;
    roles[anchor.sector] = anchor.kind;
  }
  if (!roles.includes("trunk")) {
    for (let i = 0; i < 12; i += 1) {
      if (roles[i] !== "gap") {
        roles[i] = "trunk";
        break;
      }
    }
  }
  return roles;
}

function buildDescriptor(atom: Atom, match: MatchedLogogram): LogogramDescriptor {
  const profile = resolveMorphologyProfile(match.canonicalKey, match.messageHash);
  const mergedStyle = mergeStyleWithProfile(match.style, profile);
  const profiledMatch: MatchedLogogram = { ...match, style: mergedStyle };
  const inputs = buildEnergyInputs(profiledMatch, atom);
  const solved = solveLogogramState(inputs);
  const discrete = quantizeSolvedState(solved, inputs);
  const seed = hashMix(atom.stableKey ^ hashString(match.canonicalKey) ^ hashMix(parseInt(match.messageHash, 16) || 1));
  const rnd = seeded(seed ^ 0x4421d9e3);
  const roles = buildRoles(discrete.sectorGapMask, discrete.modifierAnchors);
  const branches = discrete.modifierAnchors
    .filter((v) => v.kind === "tendril")
    .map((v) => ({
      sector: v.sector,
      length: 0.3 + v.weight * 0.65,
      curvature: 0.24 + rnd() * 0.56,
      direction: rnd() < 0.5 ? (-1 as const) : (1 as const),
    }));
  const hooks = discrete.modifierAnchors
    .filter((v) => v.kind === "hook")
    .map((v) => ({
      sector: v.sector,
      size: 0.2 + v.weight * 0.45,
      direction: rnd() < 0.5 ? (-1 as const) : (1 as const),
    }));
  const complexity = clamp01(0.2 + atom.urgency * 0.38 + atom.importance * 0.42);
  const ringContinuity = clamp01(discrete.continuityScore);
  const ringThicknessNorm = clamp01(0.024 + atom.importance * 0.022 + (1 - discrete.solveMetrics.voidPenalty) * 0.008);
  const inkMassBias = clamp01(0.45 + atom.importance * 0.16 + (1 - discrete.solveMetrics.voidPenalty) * 0.14);
  const styleFray = typeof profiledMatch.style.fray_bias === "number" ? clamp01(profiledMatch.style.fray_bias) : FRAY_DENSITY_DEFAULT;
  const styleClump = typeof profiledMatch.style.tendril_bias === "number" ? clamp01(profiledMatch.style.tendril_bias) : CLUMP_DENSITY_DEFAULT;
  const massBias = typeof profiledMatch.style.mass_bias === "number" ? clamp01(profiledMatch.style.mass_bias) : 0.58;
  const clumpCountBias = typeof profiledMatch.style.clump_count_bias === "number" ? clamp01(profiledMatch.style.clump_count_bias) : 0.5;
  const clumpSpanBias = typeof profiledMatch.style.clump_span_bias === "number" ? clamp01(profiledMatch.style.clump_span_bias) : 0.56;
  const tendrilCountBias = typeof profiledMatch.style.tendril_count_bias === "number" ? clamp01(profiledMatch.style.tendril_count_bias) : 0.52;
  const tendrilLengthBias = typeof profiledMatch.style.tendril_length_bias === "number" ? clamp01(profiledMatch.style.tendril_length_bias) : 0.54;
  const arcDropoutBias = typeof profiledMatch.style.arc_dropout_bias === "number" ? clamp01(profiledMatch.style.arc_dropout_bias) : 0.48;
  const ringCircleCountBias = typeof profiledMatch.style.ring_circle_count_bias === "number" ? clamp01(profiledMatch.style.ring_circle_count_bias) : 0.72;
  const ringCircleThicknessBias = typeof profiledMatch.style.ring_circle_thickness_bias === "number" ? clamp01(profiledMatch.style.ring_circle_thickness_bias) : 0.64;
  const ringCenterVariationBias = typeof profiledMatch.style.ring_center_variation_bias === "number" ? clamp01(profiledMatch.style.ring_center_variation_bias) : 0.45;
  const ringDiskCountBias = typeof profiledMatch.style.ring_disk_count_bias === "number" ? clamp01(profiledMatch.style.ring_disk_count_bias) : 0.58;
  const ringDiskRadiusBias = typeof profiledMatch.style.ring_disk_radius_bias === "number" ? clamp01(profiledMatch.style.ring_disk_radius_bias) : 0.56;
  const blobArcExtentBias = typeof profiledMatch.style.blob_arc_extent_bias === "number" ? clamp01(profiledMatch.style.blob_arc_extent_bias) : 0.54;
  const blobDiskCountBias = typeof profiledMatch.style.blob_disk_count_bias === "number" ? clamp01(profiledMatch.style.blob_disk_count_bias) : 0.66;
  const blobDiskRadiusBias = typeof profiledMatch.style.blob_disk_radius_bias === "number" ? clamp01(profiledMatch.style.blob_disk_radius_bias) : 0.68;
  const tendrilPrimaryCountBias = typeof profiledMatch.style.tendril_primary_count_bias === "number" ? clamp01(profiledMatch.style.tendril_primary_count_bias) : 0.45;
  const tendrilPrimaryLengthBias = typeof profiledMatch.style.tendril_primary_length_bias === "number" ? clamp01(profiledMatch.style.tendril_primary_length_bias) : 0.66;
  const tendrilWhiskerCountBias = typeof profiledMatch.style.tendril_whisker_count_bias === "number" ? clamp01(profiledMatch.style.tendril_whisker_count_bias) : 0.28;
  const tendrilNoiseExpBias = typeof profiledMatch.style.tendril_noise_exp_bias === "number" ? clamp01(profiledMatch.style.tendril_noise_exp_bias) : 0.5;
  const gapCountBias = typeof profiledMatch.style.gap_count_bias === "number" ? clamp01(profiledMatch.style.gap_count_bias) : 0.56;
  const gapSpanBias = typeof profiledMatch.style.gap_span_bias === "number" ? clamp01(profiledMatch.style.gap_span_bias) : 0.44;
  return {
    grammar: {
      canonicalKey: match.canonicalKey,
      ringContinuity,
      sectorRoles: roles,
      primaryBranches: branches,
      hooks,
      gapPlan: discrete.gapPlan,
      occupiedSectorCount: discrete.occupiedSectorCount,
      targetRadiusNorm: discrete.ringRadiusNorm,
      ringThicknessNorm,
      frayLevel: discrete.frayLevel,
      inkMassBias,
      gaps: discrete.gapPlan,
      thicknessProfile: discrete.sectorThickness,
      sweepSeed: seed,
      sectorActivation: discrete.sectorActivation,
      sectorThickness: discrete.sectorThickness,
      sectorGapMask: discrete.sectorGapMask,
      ringRadiusNorm: discrete.ringRadiusNorm,
      ringBandWidthNorm: discrete.ringBandWidthNorm,
      modifierAnchors: discrete.modifierAnchors,
      solveMetrics: discrete.solveMetrics,
      solveBreakdown: discrete.solveBreakdown,
      unwrapProfiles: discrete.unwrapProfiles,
      constraintViolationCount: discrete.constraintViolationCount,
      shapeSignature: discrete.shapeSignature,
      signatureDistanceToCanonical: discrete.signatureDistanceToCanonical,
      textureField: {
        textureSeed: seed ^ 0x6ac1e74d,
        noisePhase: rnd() * Math.PI * 2,
        octaves: NOISE_OCTAVES_DEFAULT,
        lacunarity: 1.95,
        gain: 0.56,
        frayDensity: clamp01(0.32 + styleFray * 0.6),
        clumpDensity: clamp01(0.28 + styleClump * 0.64),
      },
      procedural: {
        massBias,
        clumpCountBias,
        clumpSpanBias,
        tendrilCountBias,
        tendrilLengthBias,
        arcDropoutBias,
        ringCircleCountBias,
        ringCircleThicknessBias,
        ringCenterVariationBias,
        ringDiskCountBias,
        ringDiskRadiusBias,
        blobArcExtentBias,
        blobDiskCountBias,
        blobDiskRadiusBias,
        tendrilPrimaryCountBias,
        tendrilPrimaryLengthBias,
        tendrilWhiskerCountBias,
        tendrilNoiseExpBias,
        gapCountBias,
        gapSpanBias,
      },
    },
    baseRadius: 1,
    complexity,
  };
}

export function generateLogogram(atom: Atom): LogogramDescriptor {
  const fallbackMatch: MatchedLogogram = {
    source: "unknown",
    canonicalKey: `unknown:${atom.id.slice(0, 8)}`,
    messageHash: atom.stableKey.toString(16),
    segmentMask: 0x0fff,
    style: {},
  };
  return buildDescriptor(atom, fallbackMatch);
}

export function generateLogogramFromMatch(atom: Atom, match: MatchedLogogram): LogogramDescriptor {
  return buildDescriptor(atom, match);
}

function ringPresenceAtSector(grammar: LogogramGrammar, sector: number): number {
  if (grammar.sectorGapMask[sector % 12] === 1) return 0;
  const role = grammar.sectorRoles[sector % 12];
  const base = grammar.sectorActivation[sector % 12] ?? 0.7;
  if (role === "trunk") return clamp01(base * 1.06);
  if (role === "modifier") return clamp01(base * 0.93);
  if (role === "tendril" || role === "hook") return clamp01(base * 0.8);
  return base;
}

function pushPoint(points: LogogramPoint[], point: MaskSamplePoint, jitterU: number, jitterV: number): void {
  points.push({
    x: point.x,
    y: point.y,
    thickness: clamp01(point.width),
    phase: clamp01(point.phase),
    channel: point.channel,
    jitterU,
    jitterV,
    mass: clamp01(point.mass),
  });
}

function pickHeavySectors(grammar: LogogramGrammar, rnd: () => number): number[] {
  const scored: Array<{ sector: number; score: number }> = [];
  for (let i = 0; i < 12; i += 1) {
    if (grammar.sectorGapMask[i] === 1) continue;
    const score = ringPresenceAtSector(grammar, i) * (0.75 + 0.25 * (grammar.sectorThickness[i] ?? 0.5));
    scored.push({ sector: i, score });
  }
  if (scored.length === 0) return [0];
  scored.sort((a, b) => b.score - a.score);
  const anchor = scored[0].sector;
  const localSpan = Math.max(1, Math.min(3, Math.round(1 + grammar.procedural.clumpSpanBias * 2)));
  const heavy = new Set<number>([anchor]);
  for (let i = 1; i <= localSpan; i += 1) {
    const plus = (anchor + i) % 12;
    const minus = (anchor + 12 - i) % 12;
    if (grammar.sectorGapMask[plus] === 0 && rnd() < 0.88) heavy.add(plus);
    if (grammar.sectorGapMask[minus] === 0 && rnd() < 0.58) heavy.add(minus);
  }
  const allowSecondary = grammar.procedural.clumpCountBias > 0.62 && scored.length > heavy.size + 1;
  if (allowSecondary && rnd() < 0.45) {
    for (const candidate of scored.slice(1)) {
      const d = Math.min(Math.abs(candidate.sector - anchor), 12 - Math.abs(candidate.sector - anchor));
      if (d < 3) continue;
      heavy.add(candidate.sector);
      break;
    }
  }
  return [...heavy];
}

function buildProceduralMaskSpec(logogram: LogogramDescriptor, sampleBudget: number, options: SampleLogogramOptions): ProceduralMaskSpec {
  const grammar = logogram.grammar;
  const seedBase = (grammar.sweepSeed ^ 0x6f4f2b91 ^ ((options.freezeToken ?? 0) >>> 0)) >>> 0;
  const rnd = seeded(seedBase);
  const ringArcs: ProceduralMaskSpec["ringArcs"] = [];
  const heavySectors = pickHeavySectors(grammar, rnd);
  const heavySet = new Set<number>(heavySectors);
  const supportSectors: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    if (grammar.sectorGapMask[i] === 1 || heavySet.has(i)) continue;
    supportSectors.push(i);
  }
  supportSectors.sort((a, b) => (ringPresenceAtSector(grammar, b) - ringPresenceAtSector(grammar, a)));
  const supportPicked = supportSectors.slice(0, Math.min(3, supportSectors.length));
  const ringBase = grammar.ringRadiusNorm;
  const ringBand = Math.max(0.014, grammar.ringBandWidthNorm);

  for (let sector = 0; sector < 12; sector += 1) {
    if (grammar.sectorGapMask[sector] === 1) continue;
    const presence = Math.max(0.12, ringPresenceAtSector(grammar, sector));
    const theta0 = angleForSector(sector) + (rnd() - 0.5) * (0.03 + grammar.procedural.ringCenterVariationBias * 0.03);
    const theta1 = angleForSector(sector + 1) + (rnd() - 0.5) * (0.03 + grammar.procedural.ringCenterVariationBias * 0.03);
    const sectorNoise = fbm2(seedBase ^ 0x7f4a7c15, sector * 0.73, 1.27, 2, 1.9, 0.57);
    const sectorStrength = clamp01(0.16 + 0.48 * presence + sectorNoise * 0.26);
    const massWeight = heavySet.has(sector)
      ? 1.25 + grammar.procedural.massBias * 0.42 + rnd() * 0.36
      : 0.42 + (1 - grammar.procedural.massBias) * 0.28 + rnd() * 0.14;
    ringArcs.push({
      theta0,
      theta1,
      radius: ringBase + (rnd() - 0.5) * ringBand * 0.35,
      thickness: clamp01((grammar.sectorThickness[sector] ?? 0.5) * (0.36 + 0.52 * presence) * (0.72 + grammar.procedural.ringCircleThicknessBias * 0.42) * (heavySet.has(sector) ? 1.06 : 0.92)),
      centerJitter: ringBand * (0.08 + 0.12 * rnd()),
      sector,
      strength: sectorStrength,
      massWeight,
    });
  }

  const primaryClusterCount = Math.max(1, Math.min(2, Math.round(1 + grammar.procedural.clumpCountBias * 0.8)));
  const primaryHeavySectors = heavySectors.slice(0, primaryClusterCount);
  const blobClusters: ProceduralMaskSpec["blobClusters"] = primaryHeavySectors.map((sector) => ({
    theta: angleForSector(sector) + (Math.PI / 12) * (0.25 + rnd() * 0.5),
    arcSpan: 0.08 + grammar.procedural.blobArcExtentBias * 0.28 + rnd() * 0.12,
    radialBias: -0.12 + rnd() * 0.34,
    diskCount: 4 + Math.floor(grammar.procedural.blobDiskCountBias * 10) + Math.floor(rnd() * 5),
    diskRadiusMin: 0.004 + rnd() * (0.003 + grammar.procedural.blobDiskRadiusBias * 0.006),
    diskRadiusMax: 0.009 + grammar.procedural.blobDiskRadiusBias * 0.026 + rnd() * 0.012,
  }));
  for (const sector of supportPicked) {
    if (blobClusters.length >= 2 || rnd() > 0.45) continue;
    blobClusters.push({
      theta: angleForSector(sector) + (Math.PI / 12) * (0.2 + rnd() * 0.6),
      arcSpan: 0.06 + grammar.procedural.blobArcExtentBias * 0.14 + rnd() * 0.08,
      radialBias: -0.08 + rnd() * 0.22,
      diskCount: 2 + Math.floor(grammar.procedural.blobDiskCountBias * 6) + Math.floor(rnd() * 4),
      diskRadiusMin: 0.004 + rnd() * 0.004,
      diskRadiusMax: 0.008 + grammar.procedural.massBias * 0.014 + rnd() * 0.008,
    });
  }

  const tendrilAnchorCount = Math.max(1, Math.min(2, Math.round(0.7 + grammar.procedural.tendrilPrimaryCountBias * 0.9)));
  const tendrilAnchors = primaryHeavySectors.slice(0, tendrilAnchorCount);
  if (supportPicked.length > 0 && tendrilAnchors.length < 2 && rnd() < 0.35) {
    tendrilAnchors.push(supportPicked[0]);
  }
  const tendrilSpecs: ProceduralMaskSpec["tendrilSpecs"] = tendrilAnchors.map((sector) => ({
    theta: angleForSector(sector) + (Math.PI / 12) * (0.2 + rnd() * 0.6),
    count: 1 + (grammar.procedural.tendrilWhiskerCountBias > 0.62 && rnd() < 0.28 ? 1 : 0),
    lengthMin: 16 + Math.floor(grammar.procedural.tendrilPrimaryLengthBias * 16) + Math.floor(rnd() * 6),
    lengthMax: 28 + Math.floor(grammar.procedural.tendrilPrimaryLengthBias * 22) + Math.floor(rnd() * 10),
    curlMin: 0.03 + rnd() * 0.05,
    curlMax: 0.08 + rnd() * 0.13,
    noiseExp: 0.8 + grammar.procedural.tendrilNoiseExpBias * 1.6 + rnd() * 0.4,
  }));

  return {
    ringArcs,
    microStrokeCount: Math.max(220, Math.floor(sampleBudget * (0.62 + grammar.procedural.ringCircleCountBias * 0.5 - grammar.procedural.massBias * 0.08))),
    blobClusters,
    tendrilSpecs,
    seed: seedBase,
  };
}

function blueNoiseCompact(points: LogogramPoint[], budget: number): LogogramPoint[] {
  if (points.length <= budget) return points;
  const target = Math.max(1, budget);
  const score = (p: LogogramPoint) => p.mass * 0.7 + p.thickness * 0.3;
  const compactChannel = (input: LogogramPoint[], targetCount: number, cellDensity = 1): LogogramPoint[] => {
    if (input.length <= targetCount) return [...input];
    const side = Math.max(8, Math.floor(Math.sqrt(Math.max(1, targetCount)) * 1.25 * cellDensity));
    const cells = new Map<number, LogogramPoint>();
    for (let i = 0; i < input.length; i += 1) {
      const p = input[i];
      const cx = Math.max(0, Math.min(side - 1, Math.floor((p.x * 0.5 + 0.5) * side)));
      const cy = Math.max(0, Math.min(side - 1, Math.floor((p.y * 0.5 + 0.5) * side)));
      const key = cy * side + cx;
      const prev = cells.get(key);
      if (!prev || score(p) > score(prev)) cells.set(key, p);
    }
    const compact = [...cells.values()];
    if (compact.length >= targetCount) {
      compact.sort((a, b) => score(b) - score(a));
      return compact.slice(0, targetCount);
    }
    const baseLen = compact.length;
    const fillCount = targetCount - baseLen;
    const used = new Set<number>();
    for (let i = 0; i < compact.length; i += 1) {
      const idx = input.indexOf(compact[i]);
      if (idx >= 0) used.add(idx);
    }
    for (let i = 0; i < fillCount; i += 1) {
      // Golden-ratio walk with deterministic jitter prevents regular stride cadence.
      const g = 0.61803398875;
      const base = (i + 1) * g + (i * 0.113);
      const frac = base - Math.floor(base);
      let idx = Math.floor(frac * input.length);
      if (used.has(idx)) {
        idx = (idx + Math.floor(input.length * 0.37) + i) % input.length;
      }
      used.add(idx);
      compact.push(input[idx]);
    }
    return compact;
  };

  const ring = points.filter((p) => p.channel === "ring");
  const blob = points.filter((p) => p.channel === "blob");
  const tendril = points.filter((p) => p.channel === "tendril");

  const blobTarget = blob.length > 0 ? Math.max(14, Math.floor(target * 0.12)) : 0;
  const tendrilTarget = tendril.length > 0 ? Math.max(8, Math.floor(target * 0.08)) : 0;
  const ringTarget = Math.max(1, target - blobTarget - tendrilTarget);

  const picked = [
    // Keep finer ring detail than blobs/tendrils to avoid dotted, under-connected arcs.
    ...compactChannel(ring, ringTarget, 1.55),
    ...compactChannel(blob, blobTarget, 1.05),
    ...compactChannel(tendril, tendrilTarget, 1.0),
  ];
  if (picked.length <= target) return picked;
  picked.sort((a, b) => score(b) - score(a));
  return picked.slice(0, target);
}

function rasterizeProceduralPoints(points: LogogramPoint[], size = 192): ProceduralMaskRaster {
  const width = size;
  const height = size;
  const count = width * height;
  const ringDensity = new Float32Array(count);
  const blobDensity = new Float32Array(count);
  const tendrilDensity = new Float32Array(count);
  const flowX = new Float32Array(count);
  const flowY = new Float32Array(count);

  const deposit = (arr: Float32Array, x: number, y: number, r: number, value: number): void => {
    const minX = Math.max(0, Math.floor(x - r));
    const maxX = Math.min(width - 1, Math.ceil(x + r));
    const minY = Math.max(0, Math.floor(y - r));
    const maxY = Math.min(height - 1, Math.ceil(y + r));
    const invR2 = 1 / Math.max(1, r * r);
    for (let yy = minY; yy <= maxY; yy += 1) {
      for (let xx = minX; xx <= maxX; xx += 1) {
        const dx = xx - x;
        const dy = yy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const w = Math.exp(-d2 * invR2 * 1.2) * value;
        arr[yy * width + xx] += w;
      }
    }
  };

  // Thick line segment deposit — fills gaps between consecutive points
  const depositLine = (arr: Float32Array, x0: number, y0: number, r0: number, v0: number,
                       x1: number, y1: number, r1: number, v1: number): void => {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.5) return;
    const steps = Math.max(2, Math.ceil(dist * 0.8));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = x0 + dx * t;
      const y = y0 + dy * t;
      const r = r0 + (r1 - r0) * t;
      const v = v0 + (v1 - v0) * t;
      deposit(arr, x, y, r, v);
    }
  };

  // Scale splat radius with raster resolution — use sqrt scaling to avoid over-fattening at high res
  const resScale = Math.sqrt(size / 192);

  // Separate ring points for connected-stroke drawing
  const ringPts: Array<{ x: number; y: number; r: number; v: number; phase: number }> = [];

  for (const p of points) {
    const x = (p.x * 0.5 + 0.5) * (width - 1);
    const y = (p.y * 0.5 + 0.5) * (height - 1);
    const radiusPx = (0.6 + p.thickness * 3.4) * resScale;
    const strength = p.mass * (0.45 + p.thickness * 0.55);
    if (p.channel === "ring") {
      deposit(ringDensity, x, y, radiusPx, strength);
      ringPts.push({ x, y, r: radiusPx, v: strength, phase: p.phase });
    } else if (p.channel === "blob") {
      deposit(blobDensity, x, y, radiusPx * 1.15, strength * 1.06);
    } else {
      deposit(tendrilDensity, x, y, radiusPx * 0.9, strength * 0.84);
    }
  }

  // Draw thick line segments between nearby ring points to form continuous strokes
  ringPts.sort((a, b) => a.phase - b.phase);
  for (let i = 1; i < ringPts.length; i++) {
    const a = ringPts[i - 1], b = ringPts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Connect points that are close enough (within ~3x avg radius)
    if (dist < (a.r + b.r) * 3) {
      depositLine(ringDensity, a.x, a.y, a.r, a.v, b.x, b.y, b.r, b.v);
    }
  }

  // --- Morphological post-processing: Dilation → Blur → Binarize ---
  // Matches the Wolfram/Mathematica Arrival approach: Binarize[GaussianFilter[Dilation[img, r], σ], t]
  const dilateR = Math.max(1, Math.round(size / 512));  // ~2px at 1024 — gentle expansion
  const blurR = Math.max(1, Math.round(size / 384));   // ~3px at 1024 — smooth edges

  // Separable max-filter dilation (horizontal then vertical)
  const dilate = (src: Float32Array, w: number, h: number, r: number): Float32Array => {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    // Horizontal pass
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mx = 0;
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        for (let xx = x0; xx <= x1; xx++) mx = Math.max(mx, src[y * w + xx]);
        tmp[y * w + x] = mx;
      }
    }
    // Vertical pass
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let mx = 0;
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        for (let yy = y0; yy <= y1; yy++) mx = Math.max(mx, tmp[yy * w + x]);
        out[y * w + x] = mx;
      }
    }
    return out;
  };

  // Separable box blur
  const blur = (src: Float32Array, w: number, h: number, r: number): Float32Array => {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    // Horizontal
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = 0; x < Math.min(r, w); x++) sum += src[y * w + x];
      for (let x = 0; x < w; x++) {
        if (x + r < w) sum += src[y * w + x + r];
        if (x - r - 1 >= 0) sum -= src[y * w + x - r - 1];
        const cnt = Math.min(x + r, w - 1) - Math.max(x - r, 0) + 1;
        tmp[y * w + x] = sum / cnt;
      }
    }
    // Vertical
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = 0; y < Math.min(r, h); y++) sum += tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        if (y + r < h) sum += tmp[(y + r) * w + x];
        if (y - r - 1 >= 0) sum -= tmp[(y - r - 1) * w + x];
        const cnt = Math.min(y + r, h - 1) - Math.max(y - r, 0) + 1;
        out[y * w + x] = sum / cnt;
      }
    }
    return out;
  };

  // Smoothstep binarize
  const binarize = (src: Float32Array, thresh: number, soft: number): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const t = (src[i] - thresh + soft) / (2 * soft);
      out[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    }
    return out;
  };

  const processChannel = (src: Float32Array, dR: number, bR: number, thresh: number, soft: number): Float32Array => {
    return binarize(blur(dilate(src, width, height, dR), width, height, bR), thresh, soft);
  };

  let ringOut = processChannel(ringDensity, dilateR, blurR, 0.18, 0.06);
  let blobOut = processChannel(blobDensity, dilateR + 1, blurR, 0.14, 0.06);
  let tendrilOut = processChannel(tendrilDensity, dilateR, Math.max(1, blurR - 1), 0.10, 0.04);

  // Copy processed results back
  ringDensity.set(ringOut);
  blobDensity.set(blobOut);
  tendrilDensity.set(tendrilOut);

  // Approximate flow by density gradients for downstream channel-aware injection.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const dL = ringDensity[i - 1] + blobDensity[i - 1] + tendrilDensity[i - 1];
      const dR2 = ringDensity[i + 1] + blobDensity[i + 1] + tendrilDensity[i + 1];
      const dB = ringDensity[i - width] + blobDensity[i - width] + tendrilDensity[i - width];
      const dT = ringDensity[i + width] + blobDensity[i + width] + tendrilDensity[i + width];
      flowX[i] = dR2 - dL;
      flowY[i] = dT - dB;
    }
  }

  return { width, height, ringDensity, blobDensity, tendrilDensity, flowX, flowY };
}

function sampleFromRaster(raster: ProceduralMaskRaster, budget: number, seed: number): LogogramPoint[] {
  const rnd = seeded(seed ^ 0x93d765dd);
  const out: LogogramPoint[] = [];
  const { width, height } = raster;
  const total = width * height;
  const ringCandidates: Array<{ i: number; w: number; channel: "ring" }> = [];
  const blobCandidates: Array<{ i: number; w: number; channel: "blob" }> = [];
  const tendrilCandidates: Array<{ i: number; w: number; channel: "tendril" }> = [];
  for (let i = 0; i < total; i += 1) {
    const r = raster.ringDensity[i];
    const b = raster.blobDensity[i];
    const t = raster.tendrilDensity[i];
    if (r > 0.006) ringCandidates.push({ i, w: r * 1.3, channel: "ring" });
    if (b > 0.03) blobCandidates.push({ i, w: b * 0.28, channel: "blob" });
    if (t > 0.052) tendrilCandidates.push({ i, w: t * 0.42, channel: "tendril" });
  }
  ringCandidates.sort((a, b) => b.w - a.w);
  blobCandidates.sort((a, b) => b.w - a.w);
  tendrilCandidates.sort((a, b) => b.w - a.w);

  const ringTake = Math.min(Math.floor(budget * 0.86), ringCandidates.length);
  const blobTake = Math.min(Math.floor(budget * 0.1), blobCandidates.length);
  const tendrilBudget = Math.max(2, Math.floor(budget * 0.015));
  const tendrilTake = Math.min(tendrilBudget, tendrilCandidates.length);
  const picked: Array<{ i: number; w: number; channel: "ring" | "blob" | "tendril" }> = [];

  // Ring continuity: stratify by angle so lower-density arcs still receive samples.
  const ringBuckets = Array.from({ length: 96 }, () => [] as Array<{ i: number; w: number; channel: "ring" }>);
  for (const c of ringCandidates) {
    const x = c.i % width;
    const y = Math.floor(c.i / width);
    const nx = x / Math.max(1, width - 1) * 2 - 1;
    const ny = y / Math.max(1, height - 1) * 2 - 1;
    const a = Math.atan2(ny, nx);
    const bucket = Math.max(0, Math.min(95, Math.floor(((a + Math.PI) / (Math.PI * 2)) * 96)));
    ringBuckets[bucket].push(c);
  }
  for (const bucket of ringBuckets) bucket.sort((a, b) => b.w - a.w);
  const ringPicked: Array<{ i: number; w: number; channel: "ring" }> = [];
  let cursor = 0;
  while (ringPicked.length < ringTake) {
    let progressed = false;
    for (let b = 0; b < ringBuckets.length && ringPicked.length < ringTake; b += 1) {
      const bucket = ringBuckets[b];
      if (cursor < bucket.length) {
        ringPicked.push(bucket[cursor]);
        progressed = true;
      }
    }
    if (!progressed) break;
    cursor += 1;
  }

  picked.push(...ringPicked, ...blobCandidates.slice(0, blobTake), ...tendrilCandidates.slice(0, tendrilTake));
  picked.sort((a, b) => b.w - a.w);
  const take = Math.min(budget, picked.length);
  for (let n = 0; n < take; n += 1) {
    const c = picked[n];
    const x = c.i % width;
    const y = Math.floor(c.i / width);
    const nx = x / Math.max(1, width - 1) * 2 - 1;
    const ny = y / Math.max(1, height - 1) * 2 - 1;
    const fx = raster.flowX?.[c.i] ?? 0;
    const fy = raster.flowY?.[c.i] ?? 0;
    const flowMag = Math.hypot(fx, fy);
    const thickness = clamp01((c.channel === "ring" ? 0.16 : c.channel === "blob" ? 0.2 : 0.22) + c.w * 0.4);
    out.push({
      x: nx + (rnd() - 0.5) * (c.channel === "ring" ? 0.0028 : 0.0055),
      y: ny + (rnd() - 0.5) * (c.channel === "ring" ? 0.0028 : 0.0055),
      thickness,
      phase: clamp01(0.08 + n / Math.max(1, take - 1) * 0.84),
      channel: c.channel,
      jitterU: flowMag > 1e-4 ? fx / flowMag * 0.01 : (rnd() - 0.5) * 0.01,
      jitterV: flowMag > 1e-4 ? fy / flowMag * 0.01 : (rnd() - 0.5) * 0.01,
      mass: clamp01(0.14 + c.w * 0.5),
    });
  }
  const ring = out.filter((p) => p.channel === "ring");
  const blob = out.filter((p) => p.channel === "blob");
  const tendril = out.filter((p) => p.channel === "tendril");

  // Preserve circular stroke continuity by ordering ring samples around theta.
  ring.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  const ringWithBridges: LogogramPoint[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const cur = ring[i];
    const next = ring[(i + 1) % ring.length];
    ringWithBridges.push(cur);
    if (!next) continue;
    const d = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (d < 0.022 || d > 0.18) continue;
    const bridgeCount = Math.min(2, Math.max(1, Math.floor(d / 0.038)));
    for (let b = 0; b < bridgeCount; b += 1) {
      const t = (b + 1) / (bridgeCount + 1);
      ringWithBridges.push({
        x: cur.x + (next.x - cur.x) * t + (rnd() - 0.5) * 0.004,
        y: cur.y + (next.y - cur.y) * t + (rnd() - 0.5) * 0.004,
        thickness: clamp01(cur.thickness * (1 - t) + next.thickness * t),
        phase: clamp01(cur.phase * (1 - t) + next.phase * t),
        channel: "ring",
        jitterU: (cur.jitterU + next.jitterU) * 0.5,
        jitterV: (cur.jitterV + next.jitterV) * 0.5,
        mass: clamp01((cur.mass + next.mass) * 0.5 * 0.85),
      });
    }
  }

  const ordered = [...ringWithBridges, ...blob, ...tendril];
  return ordered.slice(0, budget);
}

export function sampleLogogram(logogram: LogogramDescriptor, sampleBudget: number, options: SampleLogogramOptions = {}): LogogramPoint[] {
  const points: LogogramPoint[] = [];
  if (sampleBudget <= 0) return points;
  const grammar = logogram.grammar;
  const ringHalfWidth = Math.max(0.014, grammar.ringBandWidthNorm);
  const spec = buildProceduralMaskSpec(logogram, sampleBudget, options);
  const rnd = seeded(spec.seed);
  const ringBandMin = grammar.ringRadiusNorm - ringHalfWidth * 1.25;
  const ringBandMax = grammar.ringRadiusNorm + ringHalfWidth * 1.35;

  const ringArcCount = Math.max(1, spec.ringArcs.length);
  const ringMassTotal = Math.max(1e-4, spec.ringArcs.reduce((acc, arc) => acc + Math.max(0.05, arc.massWeight), 0));
  const ringStrokesPerArcBase = Math.max(8, Math.floor(spec.microStrokeCount / ringArcCount));
  for (const arc of spec.ringArcs) {
    const sectorFocus =
      0.55 +
      0.45 *
        clamp01(
          0.5 +
            0.5 *
              fbm2(
                spec.seed ^ 0xa24baed3,
                Math.cos((arc.theta0 + arc.theta1) * 0.5) * 2.1,
                Math.sin((arc.theta0 + arc.theta1) * 0.5) * 2.1,
                3,
                2.0,
                0.55,
              ),
        );
    const clumpBoost = spec.blobClusters.some((c) => Math.abs(wrapAngle(c.theta - (arc.theta0 + arc.theta1) * 0.5)) < c.arcSpan * 0.78) ? 1.82 : 0.84;
    const massShare = Math.max(0.05, arc.massWeight) / ringMassTotal;
    const ringStrokesPerArc = Math.max(
      6,
      Math.floor(
        ringStrokesPerArcBase *
        (0.16 + arc.thickness * 0.3) *
        sectorFocus *
        (0.5 + arc.strength * 0.35) *
        clumpBoost *
        (0.36 + massShare * ringArcCount * 1.2),
      ),
    );
    const underpaintCount = Math.max(3, Math.floor(ringStrokesPerArc * 0.2));
    for (let i = 0; i < underpaintCount; i += 1) {
      const u = clamp01((i + 0.5 + rnd() * 0.4) / Math.max(1, underpaintCount));
      const theta = arc.theta0 + (arc.theta1 - arc.theta0) * u;
      const r = Math.max(ringBandMin, Math.min(ringBandMax, arc.radius + (rnd() - 0.5) * arc.centerJitter * 0.6));
      const a = theta + (rnd() - 0.5) * 0.01;
      pushPoint(
        points,
        {
          x: Math.cos(a) * r,
          y: Math.sin(a) * r,
          mass: clamp01(0.12 + rnd() * 0.08),
          width: clamp01(0.16 + rnd() * 0.1),
          channel: "ring",
          phase: clamp01((u * 0.46) + ((a + Math.PI) / (2 * Math.PI)) * 0.12),
          flowBias: 0.18 + rnd() * 0.08,
        },
        (rnd() - 0.5) * 0.004,
        (rnd() - 0.5) * 0.004,
      );
    }
    for (let i = 0; i < ringStrokesPerArc; i += 1) {
      let u = clamp01((i + rnd()) / ringStrokesPerArc);
      let warp = fbm2(spec.seed ^ 0x9e3779b9, u * 6.7 + arc.sector * 0.31, arc.strength * 3.2, 2, 1.95, 0.58);
      u = clamp01(u + warp * 0.085);
      const dropoutNoise = fbm2(spec.seed ^ 0x45d9f3b, u * 9.0, (arc.theta0 + arc.theta1) * 0.7, 2, 1.9, 0.58);
      const edgeGapBias = (i < 2 || i > ringStrokesPerArc - 3) ? 0.2 : 0;
      const dropout =
        0.2 +
        (1 - arc.thickness) * 0.33 +
        (1 - arc.strength) * 0.22 +
        grammar.procedural.arcDropoutBias * 0.24 +
        edgeGapBias +
        (arc.massWeight < 0.9 ? -0.02 : -0.08);
      if (dropoutNoise < -0.12 && rnd() < dropout) continue;
      const theta = arc.theta0 + (arc.theta1 - arc.theta0) * u;
      const radialNoise = fbm2(spec.seed ^ 0x7f4a7c15, theta * 1.7, u * 6.2, 3, 2.0, 0.52);
      const tangentNoise = fbm2(spec.seed ^ 0x5bd1e995, theta * 2.1, u * 4.5, 3, 1.95, 0.56);
      const jitterR = radialNoise * arc.centerJitter;
      const jitterT = tangentNoise * arc.centerJitter * 0.45;
      const r = Math.max(ringBandMin, Math.min(ringBandMax, arc.radius + jitterR));
      const a = theta + jitterT / Math.max(1e-3, r);
      const clumpBias = smoothstep(0.54, 0.98, arc.strength);
      const width = clamp01(arc.thickness * (0.24 + rnd() * (0.2 + clumpBias * 0.18)));
      const mass = clamp01(0.2 + width * (0.28 + clumpBias * 0.22) + rnd() * 0.08);
      const phase = clamp01((u * 0.42) + ((a + Math.PI) / (2 * Math.PI)) * 0.12);
      const p: MaskSamplePoint = {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        mass,
        width,
        channel: "ring",
        phase,
        flowBias: 0.25 + 0.35 * width,
      };
      pushPoint(points, p, jitterT, jitterR);

      // Short tangent trails connect neighboring dabs into brush-like segments.
      if (rnd() < 0.65) {
        const tangentSign = rnd() < 0.5 ? -1 : 1;
        const trailCount = 1 + Math.floor(rnd() * 3);
        for (let ti = 0; ti < trailCount; ti += 1) {
          const step = (ti + 1) * (0.008 + rnd() * 0.014) * tangentSign;
          const trailA = a + step;
          const trailR = r + (rnd() - 0.5) * ringHalfWidth * 0.16;
          const trailFade = 1 - (ti + 1) / (trailCount + 1);
          pushPoint(
            points,
            {
              x: Math.cos(trailA) * trailR,
              y: Math.sin(trailA) * trailR,
              mass: clamp01(mass * (0.7 + trailFade * 0.2)),
              width: clamp01(width * (0.72 + trailFade * 0.2)),
              channel: "ring",
              phase: clamp01(phase + (ti + 1) * 0.008),
              flowBias: p.flowBias,
            },
            jitterT * 0.45,
            jitterR * 0.45,
          );
        }
      }

      // Add tiny companion dabs to mimic circular brush accumulation.
      if (rnd() < 0.05 + arc.thickness * 0.09 + (arc.massWeight > 1.2 ? 0.05 : 0)) {
        const companionA = a + (rnd() - 0.5) * 0.032;
        const companionR = r + (rnd() - 0.5) * ringHalfWidth * 0.26;
        pushPoint(
          points,
          {
            x: Math.cos(companionA) * companionR,
            y: Math.sin(companionA) * companionR,
            mass: clamp01(mass * (0.64 + rnd() * 0.26)),
            width: clamp01(width * (0.68 + rnd() * 0.2)),
            channel: "ring",
            phase: clamp01(phase + rnd() * 0.02),
            flowBias: p.flowBias,
          },
          jitterT * 0.6,
          jitterR * 0.6,
        );
      }
    }
  }

  for (const cluster of spec.blobClusters) {
    for (let i = 0; i < cluster.diskCount; i += 1) {
      const u = rnd();
      const theta = cluster.theta + (u - 0.5) * cluster.arcSpan;
      const localBand = ringHalfWidth * (0.85 + rnd() * 0.75);
      const radius = Math.max(ringBandMin, Math.min(ringBandMax, grammar.ringRadiusNorm + cluster.radialBias * localBand + (rnd() - 0.5) * localBand * 0.8));
      const diskR = cluster.diskRadiusMin + (cluster.diskRadiusMax - cluster.diskRadiusMin) * rnd();
      const dabCount = 3 + Math.floor(rnd() * 4);
      for (let d = 0; d < dabCount; d += 1) {
        const phi = rnd() * Math.PI * 2;
        const rr = diskR * Math.sqrt(rnd());
        const x = Math.cos(theta) * radius + Math.cos(phi) * rr;
        const y = Math.sin(theta) * radius + Math.sin(phi) * rr;
        pushPoint(
          points,
          {
            x,
            y,
            mass: clamp01(0.52 + rnd() * 0.2),
            width: clamp01(0.42 + rnd() * 0.2),
            channel: "blob",
            phase: clamp01(0.1 + rnd() * 0.36),
            flowBias: 0.1 + rnd() * 0.12,
          },
          (rnd() - 0.5) * 0.006,
          (rnd() - 0.5) * 0.006,
        );
      }

      // Sparse low-mass bridge specks between heavy clumps to avoid uniform fill.
      if (rnd() < 0.16) {
        const bridgeTheta = theta + (rnd() - 0.5) * (cluster.arcSpan * 1.5);
        const bridgeR = grammar.ringRadiusNorm + (rnd() - 0.5) * ringHalfWidth * 1.8;
        pushPoint(
          points,
          {
            x: Math.cos(bridgeTheta) * bridgeR,
            y: Math.sin(bridgeTheta) * bridgeR,
            mass: clamp01(0.1 + rnd() * 0.14),
            width: clamp01(0.08 + rnd() * 0.12),
            channel: "blob",
            phase: clamp01(0.18 + rnd() * 0.4),
            flowBias: 0.08 + rnd() * 0.1,
          },
          (rnd() - 0.5) * 0.004,
          (rnd() - 0.5) * 0.004,
        );
      }
    }
  }

  for (const tendril of spec.tendrilSpecs) {
    for (let t = 0; t < tendril.count; t += 1) {
      const isPrimary = t === 0;
      const steps = tendril.lengthMin + Math.floor(rnd() * Math.max(1, tendril.lengthMax - tendril.lengthMin + 1));
      const dirSign = rnd() < 0.5 ? -1 : 1;
      let theta = tendril.theta + (rnd() - 0.5) * 0.22;
      const anchorRadius = grammar.ringRadiusNorm + (rnd() - 0.5) * ringHalfWidth * 0.55;
      let cx = Math.cos(theta) * anchorRadius;
      let cy = Math.sin(theta) * anchorRadius;
      let dirX = Math.cos(theta + dirSign * 0.5);
      let dirY = Math.sin(theta + dirSign * 0.5);
      let drift = 0;
      for (let s = 0; s < steps; s += 1) {
        const u = s / Math.max(1, steps - 1);
        const n = fbm2(spec.seed ^ 0x27d4eb2d, t * 0.9 + u * 3.5, theta * tendril.noiseExp, 3, 1.95, 0.58);
        const curl = dirSign * (tendril.curlMin + (tendril.curlMax - tendril.curlMin) * (0.5 + 0.5 * n));
        drift += curl * (isPrimary ? 0.72 : 0.44);
        theta += drift * 0.04;
        dirX += Math.cos(theta + Math.PI * 0.5) * curl * 0.18;
        dirY += Math.sin(theta + Math.PI * 0.5) * curl * 0.18;
        // Gentle radial outward nudge — tendrils mostly follow curl/tangent
        const radialMix = isPrimary ? (0.12 + u * 0.1) : (0.06 + u * 0.06);
        const rLen = Math.hypot(cx, cy) || 1;
        const radialX = cx / rLen;
        const radialY = cy / rLen;
        dirX = dirX * (1 - radialMix) + radialX * radialMix;
        dirY = dirY * (1 - radialMix) + radialY * radialMix;
        const len = Math.hypot(dirX, dirY) || 1;
        dirX /= len;
        dirY /= len;
        const stepLen = ringHalfWidth * (isPrimary ? (0.10 + u * 0.16) : (0.06 + u * 0.10));
        cx += dirX * stepLen + (rnd() - 0.5) * ringHalfWidth * 0.03;
        cy += dirY * stepLen + (rnd() - 0.5) * ringHalfWidth * 0.03;
        const radius = Math.hypot(cx, cy);
        if (radius < ringBandMin * 0.72 || radius > ringBandMax * 2.6) break;
        pushPoint(
          points,
          {
            x: cx,
            y: cy,
            mass: clamp01((isPrimary ? 0.38 : 0.16) + (1 - u) * (isPrimary ? 0.26 : 0.1) + rnd() * 0.08),
            width: clamp01((isPrimary ? 0.36 : 0.14) + (1 - u) * (isPrimary ? 0.24 : 0.1)),
            channel: "tendril",
            phase: clamp01(0.28 + u * 0.52),
            flowBias: isPrimary ? (0.62 + 0.24 * (1 - u)) : (0.34 + 0.18 * (1 - u)),
          },
          (rnd() - 0.5) * 0.01,
          (rnd() - 0.5) * 0.01,
        );
      }
    }
  }

  const compact = blueNoiseCompact(points, Math.max(sampleBudget, 2200));
  const raster = rasterizeProceduralPoints(compact, 192);
  const sampled = sampleFromRaster(raster, sampleBudget, spec.seed ^ 0xa5f4123b);
  return sampled;
}

export function rasterizeLogogram(logogram: LogogramDescriptor, size: number): ProceduralMaskRaster {
  const spec = buildProceduralMaskSpec(logogram, 3200, {});
  const rnd = seeded(spec.seed);
  const grammar = logogram.grammar;
  const ringHalfWidth = Math.max(0.014, grammar.ringBandWidthNorm);
  const count = size * size;
  const ringDensity = new Float32Array(count);
  const blobDensity = new Float32Array(count);
  const tendrilDensity = new Float32Array(count);

  // Convert normalized [-1,1] coords to pixel coords
  const toPixel = (v: number) => (v * 0.5 + 0.5) * (size - 1);
  const pixScale = (size - 1) * 0.5; // pixels per normalized unit

  // Fill a circle on a density array
  const fillCircle = (arr: Float32Array, cx: number, cy: number, r: number, value: number) => {
    const rPx = r * pixScale;
    const pxC = toPixel(cx), pyC = toPixel(cy);
    const x0 = Math.max(0, Math.floor(pxC - rPx));
    const x1 = Math.min(size - 1, Math.ceil(pxC + rPx));
    const y0 = Math.max(0, Math.floor(pyC - rPx));
    const y1 = Math.min(size - 1, Math.ceil(pyC + rPx));
    const rPx2 = rPx * rPx;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - pxC, dy = y - pyC;
        if (dx * dx + dy * dy <= rPx2) arr[y * size + x] = Math.max(arr[y * size + x], value);
      }
    }
  };

  // Fill a thick line segment (capsule shape)
  const fillCapsule = (arr: Float32Array, ax: number, ay: number, bx: number, by: number, halfW: number, value: number) => {
    const hw = halfW * pixScale;
    const pax = toPixel(ax), pay = toPixel(ay);
    const pbx = toPixel(bx), pby = toPixel(by);
    const minPx = Math.max(0, Math.floor(Math.min(pax, pbx) - hw));
    const maxPx = Math.min(size - 1, Math.ceil(Math.max(pax, pbx) + hw));
    const minPy = Math.max(0, Math.floor(Math.min(pay, pby) - hw));
    const maxPy = Math.min(size - 1, Math.ceil(Math.max(pay, pby) + hw));
    const segDx = pbx - pax, segDy = pby - pay;
    const segLen2 = segDx * segDx + segDy * segDy;
    const hw2 = hw * hw;
    for (let y = minPy; y <= maxPy; y++) {
      for (let x = minPx; x <= maxPx; x++) {
        const px = x - pax, py = y - pay;
        let t = segLen2 > 0.001 ? (px * segDx + py * segDy) / segLen2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const closestX = segDx * t, closestY = segDy * t;
        const dx = px - closestX, dy = py - closestY;
        if (dx * dx + dy * dy <= hw2) arr[y * size + x] = Math.max(arr[y * size + x], value);
      }
    }
  };

  // === 1. RING — draw as continuous thick curve with varying width ===
  // Build a ring profile: at each angle, the center radius and stroke half-width
  const RING_STEPS = 720;
  const ringProfile: Array<{ theta: number; radius: number; halfWidth: number; active: boolean }> = [];
  for (let i = 0; i < RING_STEPS; i++) {
    const theta = (i / RING_STEPS) * Math.PI * 2 - Math.PI;
    // Find which arc covers this angle
    let bestArc = null;
    let bestStrength = 0;
    for (const arc of spec.ringArcs) {
      const inArc = (theta >= arc.theta0 && theta <= arc.theta1) ||
                    (arc.theta0 > arc.theta1 && (theta >= arc.theta0 || theta <= arc.theta1));
      if (inArc && arc.strength > bestStrength) {
        bestArc = arc;
        bestStrength = arc.strength;
      }
    }
    if (bestArc) {
      // Noise-driven variation in radius and width
      const noiseR = fbm2(spec.seed ^ 0x7f4a7c15, theta * 1.7, bestArc.sector * 2.1, 3, 2.0, 0.52);
      const noiseW = fbm2(spec.seed ^ 0x5bd1e995, theta * 2.3, bestArc.sector * 1.4, 2, 1.95, 0.56);
      const radius = bestArc.radius + noiseR * bestArc.centerJitter * 0.8;
      const hw = ringHalfWidth * bestArc.thickness * (0.5 + 0.5 * bestArc.strength) * (0.7 + 0.3 * (0.5 + 0.5 * noiseW));
      ringProfile.push({ theta, radius, halfWidth: Math.max(0.004, hw), active: true });
    } else {
      ringProfile.push({ theta, radius: grammar.ringRadiusNorm, halfWidth: 0, active: false });
    }
  }

  // Draw ring as chain of capsules
  for (let i = 0; i < ringProfile.length; i++) {
    const a = ringProfile[i];
    const b = ringProfile[(i + 1) % ringProfile.length];
    if (!a.active || !b.active) continue;
    const ax = Math.cos(a.theta) * a.radius, ay = Math.sin(a.theta) * a.radius;
    const bx = Math.cos(b.theta) * b.radius, by = Math.sin(b.theta) * b.radius;
    const hw = (a.halfWidth + b.halfWidth) * 0.5;
    fillCapsule(ringDensity, ax, ay, bx, by, hw, 1.0);
  }

  // === 2. BLOBS — filled irregular disc clusters that merge with ring ===
  for (const cluster of spec.blobClusters) {
    for (let i = 0; i < cluster.diskCount; i++) {
      const theta = cluster.theta + (rnd() - 0.5) * cluster.arcSpan;
      const localBand = ringHalfWidth * (0.85 + rnd() * 0.75);
      const radius = grammar.ringRadiusNorm + cluster.radialBias * localBand + (rnd() - 0.5) * localBand * 0.5;
      const diskR = cluster.diskRadiusMin + (cluster.diskRadiusMax - cluster.diskRadiusMin) * rnd();
      const cx = Math.cos(theta) * radius;
      const cy = Math.sin(theta) * radius;
      // Main disc
      fillCircle(blobDensity, cx, cy, diskR * 1.5, 1.0);
      // A few smaller overlapping discs for organic shape
      const dabCount = 2 + Math.floor(rnd() * 3);
      for (let d = 0; d < dabCount; d++) {
        const phi = rnd() * Math.PI * 2;
        const rr = diskR * (0.5 + rnd() * 0.8);
        fillCircle(blobDensity, cx + Math.cos(phi) * rr, cy + Math.sin(phi) * rr, diskR * (0.6 + rnd() * 0.6), 1.0);
      }
    }
  }

  // === 3. TENDRILS — short tapered ink splatter rays from blob/thick areas ===
  for (const tendril of spec.tendrilSpecs) {
    const anchorTheta = tendril.theta + (rnd() - 0.5) * 0.15;
    const anchorR = grammar.ringRadiusNorm + (rnd() - 0.5) * ringHalfWidth * 0.4;
    const anchorX = Math.cos(anchorTheta) * anchorR;
    const anchorY = Math.sin(anchorTheta) * anchorR;
    const outLen = Math.hypot(anchorX, anchorY) || 1;
    const outX = anchorX / outLen, outY = anchorY / outLen;

    const rayCount = 3 + Math.floor(rnd() * 6);
    for (let r = 0; r < rayCount; r++) {
      const spreadAngle = (rnd() - 0.5) * 1.4;
      const rayDirX = outX * Math.cos(spreadAngle) - outY * Math.sin(spreadAngle);
      const rayDirY = outX * Math.sin(spreadAngle) + outY * Math.cos(spreadAngle);
      const rayLen = grammar.ringRadiusNorm * (0.06 + rnd() * 0.16);
      const baseWidth = ringHalfWidth * (0.4 + rnd() * 0.6);
      const curlRate = (rnd() - 0.5) * 0.5;
      // Draw ray as chain of tapered capsules
      const segments = 6 + Math.floor(rnd() * 4);
      for (let s = 0; s < segments; s++) {
        const u0 = s / segments, u1 = (s + 1) / segments;
        const curl0 = curlRate * u0, curl1 = curlRate * u1;
        const d0x = rayDirX * Math.cos(curl0) - rayDirY * Math.sin(curl0);
        const d0y = rayDirX * Math.sin(curl0) + rayDirY * Math.cos(curl0);
        const d1x = rayDirX * Math.cos(curl1) - rayDirY * Math.sin(curl1);
        const d1y = rayDirX * Math.sin(curl1) + rayDirY * Math.cos(curl1);
        const ax = anchorX + d0x * rayLen * u0;
        const ay = anchorY + d0y * rayLen * u0;
        const bx = anchorX + d1x * rayLen * u1;
        const by = anchorY + d1y * rayLen * u1;
        const taper = 1 - ((u0 + u1) * 0.5) * ((u0 + u1) * 0.5);
        const hw = baseWidth * taper * 0.5;
        if (hw > 0.001) fillCapsule(tendrilDensity, ax, ay, bx, by, hw, 1.0);
      }
      // Branch
      if (rnd() < 0.35) {
        const branchU = 0.3 + rnd() * 0.3;
        const branchAngle = (rnd() - 0.5) * 1.0;
        const bDirX = rayDirX * Math.cos(branchAngle) - rayDirY * Math.sin(branchAngle);
        const bDirY = rayDirX * Math.sin(branchAngle) + rayDirY * Math.cos(branchAngle);
        const bLen = rayLen * (0.25 + rnd() * 0.3);
        const bx0 = anchorX + rayDirX * rayLen * branchU;
        const by0 = anchorY + rayDirY * rayLen * branchU;
        const bSegs = 3 + Math.floor(rnd() * 2);
        for (let bs = 0; bs < bSegs; bs++) {
          const bu0 = bs / bSegs, bu1 = (bs + 1) / bSegs;
          const bax = bx0 + bDirX * bLen * bu0;
          const bay = by0 + bDirY * bLen * bu0;
          const bbx = bx0 + bDirX * bLen * bu1;
          const bby = by0 + bDirY * bLen * bu1;
          const taper = 1 - ((bu0 + bu1) * 0.5);
          const hw = baseWidth * taper * 0.3;
          if (hw > 0.001) fillCapsule(tendrilDensity, bax, bay, bbx, bby, hw, 1.0);
        }
      }
    }
  }

  // === 4. Edge roughness — erode edges with noise for calligraphic texture ===
  // Generate noise at reduced resolution to save memory/time, then lookup
  const noiseSize = Math.min(512, size);
  const noiseScale = noiseSize / size;
  const edgeNoise = new Float32Array(noiseSize * noiseSize);
  for (let y = 0; y < noiseSize; y++) {
    for (let x = 0; x < noiseSize; x++) {
      const nx = (x / (noiseSize - 1)) * 12.0;
      const ny = (y / (noiseSize - 1)) * 12.0;
      edgeNoise[y * noiseSize + x] = fbm2(spec.seed ^ 0xbead5678, nx, ny, 4, 2.1, 0.55) * 0.5 + 0.5;
    }
  }
  const sampleNoise = (px: number, py: number) => {
    const nx = Math.min(noiseSize - 1, Math.max(0, Math.floor(px * noiseScale)));
    const ny = Math.min(noiseSize - 1, Math.max(0, Math.floor(py * noiseScale)));
    return edgeNoise[ny * noiseSize + nx];
  };

  // Edge detection via 4-neighbor check (no blur needed — fast O(n))
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const c = Math.max(ringDensity[i], blobDensity[i], tendrilDensity[i]);
      if (c < 0.5) continue;
      // Check if any neighbor is empty → this is an edge pixel
      const hasEmpty =
        Math.max(ringDensity[i - 1], blobDensity[i - 1], tendrilDensity[i - 1]) < 0.5 ||
        Math.max(ringDensity[i + 1], blobDensity[i + 1], tendrilDensity[i + 1]) < 0.5 ||
        Math.max(ringDensity[i - size], blobDensity[i - size], tendrilDensity[i - size]) < 0.5 ||
        Math.max(ringDensity[i + size], blobDensity[i + size], tendrilDensity[i + size]) < 0.5;
      if (!hasEmpty) continue;
      // Also check 2-pixel-away neighbors for wider erosion zone
      const has2Empty =
        Math.max(ringDensity[i - 2] ?? 0, blobDensity[i - 2] ?? 0, tendrilDensity[i - 2] ?? 0) < 0.5 ||
        Math.max(ringDensity[i + 2] ?? 0, blobDensity[i + 2] ?? 0, tendrilDensity[i + 2] ?? 0) < 0.5;
      const erosionThresh = hasEmpty ? 0.42 : (has2Empty ? 0.3 : 1.0);
      if (sampleNoise(x, y) < erosionThresh) {
        ringDensity[i] = 0;
        blobDensity[i] = 0;
        tendrilDensity[i] = 0;
      }
    }
  }

  return { width: size, height: size, ringDensity, blobDensity, tendrilDensity };
}
