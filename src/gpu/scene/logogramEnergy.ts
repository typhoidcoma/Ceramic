import type { Atom, LogogramSolveBreakdown, LogogramStyle, MatchedLogogram } from "../../data/types";

const SECTOR_COUNT = 12;
const TWO_PI = Math.PI * 2;
const UNWRAP_SAMPLES = 192;

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

function seeded(seed: number): () => number {
  let v = seed >>> 0;
  return () => {
    v = hashMix(v + 0x9e3779b9);
    return (v & 0xffffffff) / 0x100000000;
  };
}

function styleBias(style: LogogramStyle, key: keyof LogogramStyle, fallback: number): number {
  const value = style[key];
  if (typeof value === "number") return clamp01(value);
  return fallback;
}

export type EnergyWeights = {
  mask: number;
  continuity: number;
  gap: number;
  thickness: number;
  voidPenalty: number;
  radius: number;
  sparsity: number;
};

export type EnergyInputs = {
  seed: number;
  canonicalKey: string;
  segmentMask: number;
  urgency: number;
  importance: number;
  maskTarget: number[];
  style: {
    ringBias: number;
    gapBias: number;
    tendrilBias: number;
    hookBias: number;
    continuityBias: number;
    sweepBias: number;
    frayBias: number;
  };
  weights: EnergyWeights;
  radiusBand: { min: number; target: number; max: number };
  occupiedRange: { min: number; max: number };
  gapRange: { min: number; max: number };
};

export type SolvedState = {
  activation: number[];
  thickness: number[];
  radiusNorm: number;
  ringBandWidthNorm: number;
  energy: number;
  continuity: number;
  voidPenalty: number;
  frayLevel: number;
};

export type DiscreteState = {
  sectorGapMask: number[];
  sectorActivation: number[];
  sectorThickness: number[];
  occupiedSectorCount: number;
  gapCount: number;
  continuityScore: number;
  ringRadiusNorm: number;
  ringBandWidthNorm: number;
  gapPlan: Array<{ startSector: number; span: number; softness: number }>;
  modifierAnchors: Array<{ sector: number; kind: "tendril" | "hook"; weight: number }>;
  frayLevel: number;
  solveMetrics: {
    energy: number;
    continuity: number;
    voidPenalty: number;
    gapCount: number;
  };
  solveBreakdown: LogogramSolveBreakdown;
  unwrapProfiles: { activationTheta: number[]; thicknessTheta: number[]; spurTheta: number[] };
  constraintViolationCount: number;
  shapeSignature: number[];
  canonicalSignature: number[];
  signatureDistanceToCanonical: number;
};

function sectorMaskTarget(segmentMask: number): number[] {
  const values = new Array<number>(SECTOR_COUNT).fill(0);
  for (let i = 0; i < SECTOR_COUNT; i += 1) values[i] = (segmentMask >> i) & 1 ? 1 : 0;
  return values;
}

function buildWeights(style: EnergyInputs["style"], urgency: number, importance: number): EnergyWeights {
  return {
    mask: 1.35 + style.ringBias * 0.7,
    continuity: 1.05 + style.continuityBias * 1.1,
    gap: 1.15 + style.gapBias * 1.1,
    thickness: 0.65 + importance * 0.55,
    voidPenalty: 1.35 + importance * 0.5,
    radius: 1.2 + style.ringBias * 0.65,
    sparsity: 0.55 + style.frayBias * 0.45 + urgency * 0.18,
  };
}

export function buildEnergyInputs(match: MatchedLogogram, atom: Atom): EnergyInputs {
  const seed = hashMix(atom.stableKey ^ hashMix(parseInt(match.messageHash, 16) || 1));
  const rnd = seeded(seed ^ 0x1f2a89c5);
  const style = {
    ringBias: styleBias(match.style, "ring_bias", 0.56 + rnd() * 0.24),
    gapBias: styleBias(match.style, "gap_bias", 0.2 + rnd() * 0.2),
    tendrilBias: styleBias(match.style, "tendril_bias", 0.32 + rnd() * 0.22),
    hookBias: styleBias(match.style, "hook_bias", styleBias(match.style, "hookBias", 0.28 + rnd() * 0.25)),
    continuityBias: styleBias(match.style, "continuity_bias", 0.62 + rnd() * 0.24),
    sweepBias: styleBias(match.style, "sweep_bias", 0.4 + rnd() * 0.45),
    frayBias: styleBias(match.style, "fray_bias", 0.44 + rnd() * 0.2),
  };
  const urgency = clamp01(atom.urgency);
  const importance = clamp01(atom.importance);
  const maskTarget = sectorMaskTarget((match.segmentMask & 0x0fff) || 1);
  return {
    seed,
    canonicalKey: match.canonicalKey,
    segmentMask: (match.segmentMask & 0x0fff) || 1,
    urgency,
    importance,
    maskTarget,
    style,
    weights: buildWeights(style, urgency, importance),
    radiusBand: { min: 0.245, target: 0.29, max: 0.355 },
    occupiedRange: { min: 8, max: 10 },
    gapRange: { min: 2, max: 4 },
  };
}

function neighborAverage(values: number[], idx: number): number {
  const left = values[(idx + SECTOR_COUNT - 1) % SECTOR_COUNT];
  const right = values[(idx + 1) % SECTOR_COUNT];
  return (left + right) * 0.5;
}

function continuityMetric(values: number[]): number {
  let sum = 0;
  for (let i = 0; i < SECTOR_COUNT; i += 1) {
    const d = values[i] - values[(i + 1) % SECTOR_COUNT];
    sum += d * d;
  }
  return sum / SECTOR_COUNT;
}

function sampleToSector(values: number[]): number[] {
  const out = new Array<number>(SECTOR_COUNT).fill(0);
  for (let i = 0; i < SECTOR_COUNT; i += 1) {
    const center = ((i + 0.5) / SECTOR_COUNT) * UNWRAP_SAMPLES;
    const c0 = Math.floor(center) % UNWRAP_SAMPLES;
    const c1 = (c0 + 1) % UNWRAP_SAMPLES;
    const t = center - Math.floor(center);
    out[i] = values[c0] * (1 - t) + values[c1] * t;
  }
  return out;
}

function buildCanonicalSignature(inputs: EnergyInputs): number[] {
  const signature: number[] = [];
  for (let i = 0; i < SECTOR_COUNT; i += 1) signature.push(inputs.maskTarget[i]);
  for (let i = 0; i < SECTOR_COUNT; i += 1) {
    const thick = 0.45 + inputs.maskTarget[i] * 0.35 + inputs.style.ringBias * 0.08;
    signature.push(clamp01(thick));
  }
  return signature;
}

function buildShapeSignature(sectorActivation: number[], sectorThickness: number[]): number[] {
  const signature: number[] = [];
  for (let i = 0; i < SECTOR_COUNT; i += 1) signature.push(clamp01(sectorActivation[i]));
  for (let i = 0; i < SECTOR_COUNT; i += 1) signature.push(clamp01(sectorThickness[i]));
  return signature;
}

function signatureDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const d = a[i] - b[i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

function estimateVoidPenalty(values: number[]): number {
  const mean = values.reduce((acc, v) => acc + v, 0) / Math.max(1, values.length);
  return clamp01(1 - mean);
}

function estimateEnergy(values: number[], thickness: number[], inputs: EnergyInputs, radiusNorm: number): LogogramSolveBreakdown {
  let maskError = 0;
  let thickSmooth = 0;
  for (let i = 0; i < SECTOR_COUNT; i += 1) {
    const dMask = values[i] - inputs.maskTarget[i];
    maskError += dMask * dMask;
    const dThick = thickness[i] - thickness[(i + 1) % SECTOR_COUNT];
    thickSmooth += dThick * dThick;
  }
  const continuity = continuityMetric(values);
  const mean = values.reduce((acc, v) => acc + v, 0) / SECTOR_COUNT;
  const desiredMean = 0.75;
  const sparsityErr = (mean - desiredMean) * (mean - desiredMean);
  const radiusErr = (radiusNorm - inputs.radiusBand.target) * (radiusNorm - inputs.radiusBand.target);
  const voidPenalty = estimateVoidPenalty(values);
  const w = inputs.weights;
  const eMask = w.mask * (maskError / SECTOR_COUNT);
  const eContinuity = w.continuity * continuity;
  const eThickness = w.thickness * (thickSmooth / SECTOR_COUNT);
  const eSparsity = w.sparsity * sparsityErr;
  const eRadius = w.radius * radiusErr;
  const eVoid = w.voidPenalty * voidPenalty;
  return {
    eMask,
    eContinuity,
    eGap: 0,
    eThickness,
    eVoid,
    eRadius,
    eSparsity,
    total: eMask + eContinuity + eThickness + eVoid + eRadius + eSparsity,
  };
}

export function solveLogogramState(inputs: EnergyInputs): SolvedState {
  const rnd = seeded(inputs.seed ^ 0x777b1a3d);
  const aTheta = new Array<number>(UNWRAP_SAMPLES).fill(0);
  const tTheta = new Array<number>(UNWRAP_SAMPLES).fill(0);
  const sTheta = new Array<number>(UNWRAP_SAMPLES).fill(0);
  for (let k = 0; k < UNWRAP_SAMPLES; k += 1) {
    const theta = (k / UNWRAP_SAMPLES) * TWO_PI;
    const sectorF = (theta / TWO_PI) * SECTOR_COUNT;
    const i0 = Math.floor(sectorF) % SECTOR_COUNT;
    const i1 = (i0 + 1) % SECTOR_COUNT;
    const t = sectorF - Math.floor(sectorF);
    const mask = inputs.maskTarget[i0] * (1 - t) + inputs.maskTarget[i1] * t;
    const baseA = mask > 0.5 ? 0.76 : 0.32;
    aTheta[k] = clamp01(baseA + (rnd() - 0.5) * 0.06);
    tTheta[k] = clamp01(0.46 + inputs.importance * 0.3 + (rnd() - 0.5) * 0.12);
    sTheta[k] = clamp01(0.25 + inputs.style.tendrilBias * 0.45 + (rnd() - 0.5) * 0.14);
  }

  let radiusNorm = clamp01(
    inputs.radiusBand.target + (inputs.style.ringBias - 0.5) * 0.02 + (inputs.importance - 0.5) * 0.02,
  );
  radiusNorm = Math.max(inputs.radiusBand.min, Math.min(inputs.radiusBand.max, radiusNorm));
  const ringBandWidthNorm = 0.028 + inputs.style.ringBias * 0.012 + inputs.importance * 0.007;

  for (let iter = 0; iter < 20; iter += 1) {
    for (let k = 0; k < UNWRAP_SAMPLES; k += 1) {
      const km1 = (k + UNWRAP_SAMPLES - 1) % UNWRAP_SAMPLES;
      const kp1 = (k + 1) % UNWRAP_SAMPLES;
      const sectorF = (k / UNWRAP_SAMPLES) * SECTOR_COUNT;
      const i0 = Math.floor(sectorF) % SECTOR_COUNT;
      const i1 = (i0 + 1) % SECTOR_COUNT;
      const tt = sectorF - Math.floor(sectorF);
      const target = inputs.maskTarget[i0] * (1 - tt) + inputs.maskTarget[i1] * tt;
      const neighA = 0.5 * (aTheta[km1] + aTheta[kp1]);
      const neighT = 0.5 * (tTheta[km1] + tTheta[kp1]);
      const neighS = 0.5 * (sTheta[km1] + sTheta[kp1]);
      const pullMask = (target - aTheta[k]) * 0.18 * inputs.weights.mask;
      const pullCont = (neighA - aTheta[k]) * 0.16 * inputs.weights.continuity;
      const gapPreference = target > 0.5 ? 0.035 : -0.045;
      aTheta[k] = clamp01(aTheta[k] + pullMask + pullCont + gapPreference * inputs.weights.gap * 0.18);

      const tTarget = 0.48 + aTheta[k] * 0.34 + inputs.style.ringBias * 0.06;
      tTheta[k] = clamp01(tTheta[k] + (tTarget - tTheta[k]) * 0.18 + (neighT - tTheta[k]) * 0.1);

      const sTarget = clamp01((1 - target) * 0.15 + inputs.style.tendrilBias * 0.45 + (1 - aTheta[k]) * 0.25);
      sTheta[k] = clamp01(sTheta[k] + (sTarget - sTheta[k]) * 0.2 + (neighS - sTheta[k]) * 0.09);
    }
    const aSector = sampleToSector(aTheta);
    const mean = aSector.reduce((acc, v) => acc + v, 0) / SECTOR_COUNT;
    const meanErr = (0.75 - mean) * 0.05;
    for (let k = 0; k < UNWRAP_SAMPLES; k += 1) aTheta[k] = clamp01(aTheta[k] + meanErr);
  }

  const activation = sampleToSector(aTheta);
  const thickness = sampleToSector(tTheta);
  const continuity = clamp01(1 - continuityMetric(activation));
  const voidPenalty = estimateVoidPenalty(activation);
  const frayLevel = clamp01(0.34 + inputs.style.frayBias * 0.34 + (1 - continuity) * 0.1);
  const breakdown = estimateEnergy(activation, thickness, inputs, radiusNorm);
  return {
    activation,
    thickness,
    radiusNorm,
    ringBandWidthNorm,
    energy: breakdown.total,
    continuity,
    voidPenalty,
    frayLevel,
  };
}

function areAdjacent(a: number, b: number): boolean {
  const d = Math.abs(a - b);
  return d === 1 || d === SECTOR_COUNT - 1;
}

function buildGapPlan(mask: number[], seed: number): Array<{ startSector: number; span: number; softness: number }> {
  const rnd = seeded(seed ^ 0x2b77a5ef);
  const gaps: Array<{ startSector: number; span: number; softness: number }> = [];
  for (let i = 0; i < SECTOR_COUNT; i += 1) {
    if (mask[i] !== 1) continue;
    const prev = (i + SECTOR_COUNT - 1) % SECTOR_COUNT;
    if (mask[prev] === 1) continue;
    let span = 1;
    while (span < SECTOR_COUNT && mask[(i + span) % SECTOR_COUNT] === 1) span += 1;
    gaps.push({ startSector: i, span, softness: 0.28 + rnd() * 0.46 });
  }
  return gaps;
}

export function quantizeSolvedState(solved: SolvedState, inputs: EnergyInputs): DiscreteState {
  const scores = solved.activation.map((v, idx) => ({
    idx,
    score: v + inputs.maskTarget[idx] * 0.34 + neighborAverage(solved.activation, idx) * 0.22,
  }));
  scores.sort((a, b) => b.score - a.score);

  const occupiedTarget = Math.max(
    inputs.occupiedRange.min,
    Math.min(inputs.occupiedRange.max, Math.round(8 + inputs.style.ringBias * 2 + inputs.importance * 0.5)),
  );
  const occupiedSet = new Set<number>();
  for (let i = 0; i < occupiedTarget; i += 1) occupiedSet.add(scores[i].idx);

  const sectorGapMask = new Array<number>(SECTOR_COUNT).fill(1);
  for (const idx of occupiedSet) sectorGapMask[idx] = 0;

  // Enforce non-adjacent preference for gaps where feasible.
  let gapCount = sectorGapMask.reduce((acc, g) => acc + g, 0);
  let projectionAdjustments = 0;
  if (gapCount > inputs.gapRange.max) {
    const gapScores = scores
      .filter((s) => sectorGapMask[s.idx] === 1)
      .sort((a, b) => b.score - a.score);
    for (const item of gapScores) {
      if (gapCount <= inputs.gapRange.max) break;
      sectorGapMask[item.idx] = 0;
      gapCount -= 1;
      projectionAdjustments += 1;
    }
  }
  if (gapCount < inputs.gapRange.min) {
    const nonGapScores = scores
      .filter((s) => sectorGapMask[s.idx] === 0)
      .sort((a, b) => a.score - b.score);
    for (const item of nonGapScores) {
      if (gapCount >= inputs.gapRange.min) break;
      const adjGap = sectorGapMask.some((g, idx) => g === 1 && areAdjacent(idx, item.idx));
      if (adjGap && gapCount + 1 <= inputs.gapRange.max) continue;
      sectorGapMask[item.idx] = 1;
      gapCount += 1;
      projectionAdjustments += 1;
    }
  }

  const sectorActivation = solved.activation.map((v, i) => (sectorGapMask[i] === 1 ? 0 : clamp01(v)));
  const sectorThickness = solved.thickness.map((v, i) => (sectorGapMask[i] === 1 ? clamp01(v * 0.5) : clamp01(v)));
  const occupiedSectorCount = sectorGapMask.reduce((acc, v) => acc + (v === 0 ? 1 : 0), 0);
  const gapPlan = buildGapPlan(sectorGapMask, inputs.seed);
  const modifierAnchors: Array<{ sector: number; kind: "tendril" | "hook"; weight: number }> = [];
  const modifierQuota = Math.max(2, Math.min(5, Math.round(2 + inputs.style.tendrilBias * 2 + inputs.style.hookBias)));
  const candidates = scores.filter((s) => sectorGapMask[s.idx] === 0);
  for (let i = 0; i < Math.min(modifierQuota, candidates.length); i += 1) {
    const c = candidates[i];
    const kind = i % 3 === 0 ? "hook" : "tendril";
    modifierAnchors.push({ sector: c.idx, kind, weight: clamp01(c.score) });
  }

  const continuityScore = solved.continuity;
  let violationCount = 0;
  if (occupiedSectorCount < inputs.occupiedRange.min || occupiedSectorCount > inputs.occupiedRange.max) violationCount += 1;
  if (gapCount < inputs.gapRange.min || gapCount > inputs.gapRange.max) violationCount += 1;
  if (solved.radiusNorm < inputs.radiusBand.min || solved.radiusNorm > inputs.radiusBand.max) violationCount += 1;
  if (solved.voidPenalty > 0.75) violationCount += 1;
  const shapeSignature = buildShapeSignature(sectorActivation, sectorThickness);
  const canonicalSignature = buildCanonicalSignature(inputs);
  const signatureDistanceToCanonical = signatureDistance(shapeSignature, canonicalSignature);
  const gapMid = 0.5 * (inputs.gapRange.min + inputs.gapRange.max);
  const gapNorm = Math.abs(gapCount - gapMid) / Math.max(1, inputs.gapRange.max - inputs.gapRange.min);
  const solveBreakdown: LogogramSolveBreakdown = {
    eMask: (1 - continuityScore) * 0.35,
    eContinuity: (1 - continuityScore) * inputs.weights.continuity * 0.65,
    eGap: gapNorm * inputs.weights.gap,
    eThickness:
      sectorThickness.reduce((acc, v, i) => {
        const d = v - sectorThickness[(i + 1) % SECTOR_COUNT];
        return acc + d * d;
      }, 0) /
      SECTOR_COUNT,
    eVoid: solved.voidPenalty * inputs.weights.voidPenalty,
    eRadius: Math.abs(solved.radiusNorm - inputs.radiusBand.target) * inputs.weights.radius,
    eSparsity: projectionAdjustments * 0.05,
    total: 0,
  };
  solveBreakdown.total =
    solveBreakdown.eMask +
    solveBreakdown.eContinuity +
    solveBreakdown.eGap +
    solveBreakdown.eThickness +
    solveBreakdown.eVoid +
    solveBreakdown.eRadius +
    solveBreakdown.eSparsity;
  const unwrapProfiles = {
    activationTheta: Array.from({ length: UNWRAP_SAMPLES }, (_, k) => {
      const sectorF = (k / UNWRAP_SAMPLES) * SECTOR_COUNT;
      const i0 = Math.floor(sectorF) % SECTOR_COUNT;
      const i1 = (i0 + 1) % SECTOR_COUNT;
      const t = sectorF - Math.floor(sectorF);
      return clamp01(sectorActivation[i0] * (1 - t) + sectorActivation[i1] * t);
    }),
    thicknessTheta: Array.from({ length: UNWRAP_SAMPLES }, (_, k) => {
      const sectorF = (k / UNWRAP_SAMPLES) * SECTOR_COUNT;
      const i0 = Math.floor(sectorF) % SECTOR_COUNT;
      const i1 = (i0 + 1) % SECTOR_COUNT;
      const t = sectorF - Math.floor(sectorF);
      return clamp01(sectorThickness[i0] * (1 - t) + sectorThickness[i1] * t);
    }),
    spurTheta: Array.from({ length: UNWRAP_SAMPLES }, (_, k) => {
      const sector = Math.floor((k / UNWRAP_SAMPLES) * SECTOR_COUNT) % SECTOR_COUNT;
      const anchor = modifierAnchors.find((m) => m.sector === sector);
      return anchor ? clamp01(anchor.weight) : 0;
    }),
  };

  return {
    sectorGapMask,
    sectorActivation,
    sectorThickness,
    occupiedSectorCount,
    gapCount,
    continuityScore,
    ringRadiusNorm: solved.radiusNorm,
    ringBandWidthNorm: solved.ringBandWidthNorm,
    gapPlan,
    modifierAnchors,
    frayLevel: solved.frayLevel,
    solveMetrics: {
      energy: solveBreakdown.total,
      continuity: solved.continuity,
      voidPenalty: solved.voidPenalty,
      gapCount,
    },
    solveBreakdown,
    unwrapProfiles,
    constraintViolationCount: violationCount,
    shapeSignature,
    canonicalSignature,
    signatureDistanceToCanonical,
  };
}

export function angleForSector(sector: number): number {
  return ((sector % SECTOR_COUNT) / SECTOR_COUNT) * TWO_PI;
}
