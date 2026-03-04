import { hashStringU32, type Atom } from "../../data/types";
import type { ActiveMessageState } from "../../app/store";
import type { TaskPoint } from "../buffers";
import { BENCH_MAX_ACTIVE_POINTS, BENCH_MAX_PREV_POINTS, MAX_TASK_POINTS, STAMP_JITTER_TIME_SCALE } from "../sim/constants";
import { generateLogogramFromMatch, sampleLogogram } from "./logograms";
import type { BenchmarkMode, LogogramSolveBreakdown } from "../../data/types";
import { matchLogogramFromMessage } from "./logogramMatcher";

type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

type MatchMeta = {
  source: "dictionary" | "unknown" | "none";
  matchedPhrase: string | null;
  canonicalKey: string | null;
};

type TaskFieldStats = {
  channelCounts: { ring: number; tendril: number; hook: number };
  ringContinuityScore: number;
  sweepProgress: number;
  injectorBBoxArea: number;
  ringCoverageRatio: number;
  ringBandOccupancyRatio: number;
  innerVoidRatio: number;
  innerVoidPenalty: number;
  centerMassRatio: number;
  sectorOccupancy: number[];
  ringSectorOccupancy: number[];
  solveEnergy: number;
  solveBreakdown: LogogramSolveBreakdown;
  unwrapProfiles: { activationTheta: number[]; thicknessTheta: number[]; spurTheta: number[] };
  gapCountSolved: number;
  constraintViolationCount: number;
  shapeSignature: number[];
  signatureDistanceToCanonical: number;
  textureEntropy: number;
  radialVariance: number;
  arcSpacingVariance: number;
  repeatScore: number;
  generatedRadialProfile: number[];
  generatedAngularHistogram12: number[];
  generatedGapCount: number;
  generatedFrayDensity: number;
  generatedStrokeWidthMean: number;
  generatedStrokeWidthVar: number;
};

let lastMatchMeta: MatchMeta = { source: "none", matchedPhrase: null, canonicalKey: null };
let lastStats: TaskFieldStats = {
  channelCounts: { ring: 0, tendril: 0, hook: 0 },
  ringContinuityScore: 0,
  sweepProgress: 0,
  injectorBBoxArea: 0,
  ringCoverageRatio: 0,
  ringBandOccupancyRatio: 0,
  innerVoidRatio: 1,
  innerVoidPenalty: 0,
  centerMassRatio: 0,
  sectorOccupancy: Array.from({ length: 12 }, () => 0),
  ringSectorOccupancy: Array.from({ length: 12 }, () => 0),
  solveEnergy: 0,
  solveBreakdown: { eMask: 0, eContinuity: 0, eGap: 0, eThickness: 0, eVoid: 0, eRadius: 0, eSparsity: 0, total: 0 },
  unwrapProfiles: { activationTheta: Array.from({ length: 192 }, () => 0), thicknessTheta: Array.from({ length: 192 }, () => 0), spurTheta: Array.from({ length: 192 }, () => 0) },
  gapCountSolved: 0,
  constraintViolationCount: 0,
  shapeSignature: Array.from({ length: 24 }, () => 0),
  signatureDistanceToCanonical: 0,
  textureEntropy: 0,
  radialVariance: 0,
  arcSpacingVariance: 0,
  repeatScore: 0,
  generatedRadialProfile: Array.from({ length: 24 }, () => 0),
  generatedAngularHistogram12: Array.from({ length: 12 }, () => 0),
  generatedGapCount: 0,
  generatedFrayDensity: 0,
  generatedStrokeWidthMean: 0,
  generatedStrokeWidthVar: 0,
};
let frameCenterMassCount = 0;
let frameTotalMassCount = 0;
let frameRingBandCount = 0;
let frameRadialSum = 0;
let frameRadialSumSq = 0;
let frameArcGapSum = 0;
let frameArcGapSumSq = 0;
let frameArcGapCount = 0;
let frameEntropyAccum = 0;
let frameEntropyCount = 0;
let frameRadialBins = Array.from({ length: 24 }, () => 0);
let frameStrokeWidthSum = 0;
let frameStrokeWidthSumSq = 0;
let frameStrokeWidthCount = 0;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function computeBounds(atoms: Atom[]): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const atom of atoms) {
    minX = Math.min(minX, atom.x);
    maxX = Math.max(maxX, atom.x);
    minY = Math.min(minY, atom.y);
    maxY = Math.max(maxY, atom.y);
    minZ = Math.min(minZ, atom.z);
    maxZ = Math.max(maxZ, atom.z);
  }
  if (!Number.isFinite(minX)) {
    return { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 };
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

const ACTIVE_SAMPLE_BUDGET = Math.min(1300, BENCH_MAX_ACTIVE_POINTS);
const PREV_SAMPLE_BUDGET = Math.min(700, BENCH_MAX_PREV_POINTS);
const MAX_LOGOGRAM_CACHE = 256;
const RING_BAND_MIN_RADIUS_NORM = 0.18;
const RING_BAND_MAX_RADIUS_NORM = 0.38;
const CENTER_VOID_RADIUS_NORM = 0.135;
const MAX_CENTER_MASS_RATIO = 0.22;
const sampledLogogramCache = new Map<string, ReturnType<typeof sampleLogogram>>();

function norm(value: number, min: number, max: number): number {
  const span = Math.max(1e-3, max - min);
  return clamp01((value - min) / span);
}

function getCachedSymbolPoints(cacheKey: string, descriptor: ReturnType<typeof generateLogogramFromMatch>, budget: number): ReturnType<typeof sampleLogogram> {
  const key = `${cacheKey}|${budget}`;
  const cached = sampledLogogramCache.get(key);
  if (cached) {
    sampledLogogramCache.delete(key);
    sampledLogogramCache.set(key, cached);
    return cached;
  }
  const sampled = sampleLogogram(descriptor, budget);
  sampledLogogramCache.set(key, sampled);
  while (sampledLogogramCache.size > MAX_LOGOGRAM_CACHE) {
    const firstKey = sampledLogogramCache.keys().next().value;
    if (!firstKey) break;
    sampledLogogramCache.delete(firstKey);
  }
  return sampled;
}

function stableNoise01(seed: number): number {
  let x = seed >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 0xffffffff;
}

function poissonCount(seed: number, lambda: number): number {
  const l = Math.exp(-Math.max(0, lambda));
  let k = 0;
  let p = 1;
  let s = seed >>> 0;
  do {
    s = (s * 1664525 + 1013904223) >>> 0;
    p *= (s & 0xffffffff) / 0x100000000;
    k += 1;
  } while (p > l && k < 24);
  return Math.max(0, k - 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function stochastic01(seed: number, frameBucket: number, timeBlend: number): number {
  const a = stableNoise01((seed ^ (frameBucket * 2654435761)) >>> 0);
  const b = stableNoise01((seed ^ ((frameBucket + 1) * 2654435761)) >>> 0);
  return lerp(a, b, timeBlend);
}

function pushAtomPoints(
  points: TaskPoint[],
  atom: Atom,
  bounds: Bounds,
  selectedId: string | null,
  hoveredId: string | null,
  budget: number,
  weight: number,
  useAsPrimaryMeta: boolean,
  transitionImpulse: number,
  sweepProgress: number,
  nowMs: number,
  benchmarkMode: BenchmarkMode,
  freezeToken: number | null,
): void {
  if (points.length >= MAX_TASK_POINTS || weight <= 0.001) return;
  const match = matchLogogramFromMessage(atom);
  const canonicalSeed = hashStringU32(match.canonicalKey);
  const noiseClockMs = benchmarkMode === "frozen_eval" && freezeToken !== null ? freezeToken : nowMs;
  const frameF = noiseClockMs * 0.001 * STAMP_JITTER_TIME_SCALE;
  const frameBucket = Math.floor(frameF);
  const timeBlend = frameF - frameBucket;
  if (useAsPrimaryMeta) {
    lastMatchMeta = {
      source: match.source,
      matchedPhrase: match.matchedPhrase ?? match.canonicalKey,
      canonicalKey: match.canonicalKey,
    };
  }

  const urgency = clamp01(atom.urgency);
  const importance = clamp01(atom.importance);
  const centerX = norm(atom.x, bounds.minX, bounds.maxX);
  const centerY = norm(atom.y, bounds.minY, bounds.maxY);
  const centerZ = norm(atom.z, bounds.minZ, bounds.maxZ);
  const selected = atom.id === selectedId ? 1 : 0;
  const hovered = atom.id === hoveredId ? 1 : 0;
  const baseRadius = (0.0052 + 0.0074 * (0.45 * urgency + 0.55 * importance)) * (0.58 + 0.42 * weight);
  const emphasis = selected ? 1.28 : hovered ? 1.14 : 1;
  const dictionaryBoost = match.source === "dictionary" ? 1.18 : 0.82;
  const impulseBoost = 1 + transitionImpulse * 0.18;

  const remaining = MAX_TASK_POINTS - points.length;
  // Keep point density high even during blends so the logogram stays structured, not sparse.
  const densityFloor = 0.58;
  const effectiveSampleWeight = densityFloor + (1 - densityFloor) * weight;
  const minSamples = Math.min(budget, 120);
  const targetSamples = Math.min(remaining, Math.max(minSamples, Math.floor(budget * effectiveSampleWeight)));
  const descriptor = generateLogogramFromMatch(atom, match);
  const symbolPoints = getCachedSymbolPoints(
    `${match.canonicalKey}:${match.messageHash}:${benchmarkMode}:${freezeToken ?? "live"}`,
    descriptor,
    targetSamples,
  );
  const glyphScale = 0.98 + clamp01(atom.importance) * 0.2;
  const targetRadius = descriptor.grammar.targetRadiusNorm;
  const ringBandMinRadiusNorm = Math.max(RING_BAND_MIN_RADIUS_NORM, targetRadius * 0.62);
  const ringBandMaxRadiusNorm = Math.min(RING_BAND_MAX_RADIUS_NORM, targetRadius * 1.32);
  const injectorStrengthBase = clamp01((0.56 + 0.44 * urgency) * (0.62 + 0.38 * weight) * dictionaryBoost * impulseBoost);
  const depositionRateBase = clamp01((0.5 + 0.5 * importance) * (0.58 + 0.42 * weight) * dictionaryBoost * impulseBoost);
  const centerMassRatio = frameTotalMassCount > 0 ? frameCenterMassCount / frameTotalMassCount : 0;
  const centerClamp = centerMassRatio > MAX_CENTER_MASS_RATIO;
  lastStats.ringContinuityScore = Math.max(lastStats.ringContinuityScore, descriptor.grammar.ringContinuity);
  lastStats.solveEnergy = Math.max(lastStats.solveEnergy, descriptor.grammar.solveMetrics.energy);
  lastStats.solveBreakdown = descriptor.grammar.solveBreakdown;
  lastStats.unwrapProfiles = descriptor.grammar.unwrapProfiles;
  lastStats.gapCountSolved = Math.max(lastStats.gapCountSolved, descriptor.grammar.solveMetrics.gapCount);
  lastStats.innerVoidPenalty = Math.max(lastStats.innerVoidPenalty, descriptor.grammar.solveMetrics.voidPenalty);
  lastStats.constraintViolationCount = Math.max(lastStats.constraintViolationCount, descriptor.grammar.constraintViolationCount);
  if (descriptor.grammar.shapeSignature.length > 0) lastStats.shapeSignature = descriptor.grammar.shapeSignature;
  lastStats.signatureDistanceToCanonical = Math.max(lastStats.signatureDistanceToCanonical, descriptor.grammar.signatureDistanceToCanonical);

  if (symbolPoints.length === 0) {
    const fallbackCount = Math.min(8, Math.max(4, targetSamples));
    for (let i = 0; i < fallbackCount; i += 1) {
      if (points.length >= MAX_TASK_POINTS) break;
      const t = i / Math.max(1, fallbackCount - 1);
      const a = t * Math.PI * 2;
      const radial = ringBandMinRadiusNorm + (ringBandMaxRadiusNorm - ringBandMinRadiusNorm) * t;
      const ox = Math.cos(a) * radial;
      const oy = Math.sin(a) * radial * 0.96;
      const px = centerX + ox;
      const py = centerY + oy;
      points.push({
        nx: clamp01(px),
        ny: clamp01(py),
        nz: centerZ,
        radius: baseRadius * (0.4 - 0.14 * t) * emphasis,
        urgency: injectorStrengthBase,
        importance: depositionRateBase,
        selected,
        hovered,
        dirX: Math.cos(a + Math.PI * 0.5),
        dirY: Math.sin(a + Math.PI * 0.5),
        coherence: 0.58 + 0.24 * t,
        ink: clamp01((0.45 + 0.15 * (1 - t)) * dictionaryBoost * impulseBoost),
      });
      frameTotalMassCount += 1;
    }
    return;
  }

  for (let s = 0; s < symbolPoints.length; s += 1) {
    if (points.length >= MAX_TASK_POINTS) break;
    const sp = symbolPoints[s];
    const prev = symbolPoints[Math.max(0, s - 1)];
    const next = symbolPoints[Math.min(symbolPoints.length - 1, s + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tLen = Math.hypot(tx, ty) || 1;
    if (sp.phase > sweepProgress) continue;
    const injectorStrength = injectorStrengthBase;
    const depositionRate = depositionRateBase;
    const channelScale = sp.channel === "ring" ? 0.98 : sp.channel === "tendril" ? 0.74 : 0.66;
    const anisotropy =
      sp.channel === "tendril"
        ? clamp01((0.7 + 0.28 * (sp.thickness / 1.2)) * (0.58 + 0.42 * clamp01(atom.importance)))
        : clamp01((0.48 + 0.4 * (sp.thickness / 1.4)) * (0.5 + 0.5 * clamp01(atom.importance)));
    const pigmentBias = clamp01((0.34 + 0.66 * (sp.thickness / 1.3)) * dictionaryBoost * impulseBoost * channelScale);
    const radiusScale = sp.channel === "ring" ? 0.54 : sp.channel === "tendril" ? 0.34 : 0.3;
    const ox = sp.x * glyphScale;
    const oy = sp.y * glyphScale * 0.96;
    const radial = Math.hypot(ox, oy);
    if (sp.channel === "ring" && (radial < ringBandMinRadiusNorm || radial > ringBandMaxRadiusNorm)) continue;
    if (radial > ringBandMaxRadiusNorm * 1.24) continue;
    const centerPenalty = radial < CENTER_VOID_RADIUS_NORM ? (CENTER_VOID_RADIUS_NORM - radial) / CENTER_VOID_RADIUS_NORM : 0;
    if (centerPenalty > 0.84) continue;
    const px = centerX + ox;
    const py = centerY + oy;
    const sectorAngle = (Math.atan2(oy, ox) + Math.PI * 2) % (Math.PI * 2);
    const sector = Math.floor((sectorAngle / (Math.PI * 2)) * 12) % 12;
    const arcBin = Math.floor(sp.phase * 64);
    const jitterSeed = (canonicalSeed ^ (sector * 73856093) ^ (arcBin * 19349663) ^ atom.stableKey) >>> 0;
    const jitterT = stochastic01(jitterSeed, frameBucket, timeBlend);
    const jitterN = stochastic01(jitterSeed ^ 0x9e3779b9, frameBucket, timeBlend);
    const tangentJitter = (jitterT - 0.5) * (0.0016 + Math.abs(sp.jitterU) * 1.8);
    const normalJitter = (jitterN - 0.5) * (0.0009 + Math.abs(sp.jitterV) * 1.6);
    const tangentX = tx / tLen;
    const tangentY = ty / tLen;
    const normalX = -tangentY;
    const normalY = tangentX;
    const dirWarp = (stochastic01(jitterSeed ^ 0x7f4a7c15, frameBucket, timeBlend) - 0.5) * (sp.channel === "ring" ? 0.95 : 0.55);
    const flowX = tangentX + normalX * dirWarp;
    const flowY = tangentY + normalY * dirWarp;
    const flowLen = Math.hypot(flowX, flowY) || 1;
    const dirX = flowX / flowLen;
    const dirY = flowY / flowLen;
    const jitteredNx = clamp01(px + tangentX * tangentJitter + normalX * normalJitter);
    const jitteredNy = clamp01(py + tangentY * tangentJitter + normalY * normalJitter);
    lastStats.sectorOccupancy[sector] += 1;
    if (sp.channel === "ring") lastStats.ringSectorOccupancy[sector] += 1;
    lastStats.channelCounts[sp.channel] += 1;
    const basePoint: TaskPoint = {
      nx: jitteredNx,
      ny: jitteredNy,
      nz: clamp01(centerZ + sp.y * 0.02),
      radius: baseRadius * (0.25 + sp.thickness * (0.2 + sp.mass * 0.16)) * emphasis * radiusScale,
      urgency: injectorStrength,
      importance: depositionRate * (centerClamp ? 0.9 : 1),
      selected,
      hovered,
      dirX,
      dirY,
      coherence: clamp01(anisotropy * (0.62 + 0.22 * sp.mass)),
      ink: pigmentBias * (0.6 + sp.mass * 0.4) * (1 - centerPenalty * 0.5),
    };
    if (basePoint.ink < 0.1 || basePoint.coherence < 0.12) continue;
    points.push(basePoint);
    frameTotalMassCount += 1;
    frameEntropyAccum += Math.max(1e-4, sp.mass);
    frameEntropyCount += 1;
    const rTrack = Math.hypot(basePoint.nx - centerX, basePoint.ny - centerY);
    frameRadialSum += rTrack;
    frameRadialSumSq += rTrack * rTrack;
    const rBin = Math.max(0, Math.min(23, Math.floor(rTrack * 24)));
    frameRadialBins[rBin] += 1;
    frameStrokeWidthSum += basePoint.radius;
    frameStrokeWidthSumSq += basePoint.radius * basePoint.radius;
    frameStrokeWidthCount += 1;
    if (s > 0) {
      const prevSp = symbolPoints[s - 1];
      const gap = Math.hypot(sp.x - prevSp.x, sp.y - prevSp.y);
      frameArcGapSum += gap;
      frameArcGapSumSq += gap * gap;
      frameArcGapCount += 1;
    }
    if (radial >= ringBandMinRadiusNorm && radial <= ringBandMaxRadiusNorm) frameRingBandCount += 1;
    if (radial < CENTER_VOID_RADIUS_NORM) frameCenterMassCount += 1;

    // Multi-scale micro-clusters to build brushy structure like reference atlases.
    if (points.length >= MAX_TASK_POINTS) continue;
    const clusterLambda = sp.channel === "ring" ? 1.9 : sp.channel === "tendril" ? 1.0 : 0.35;
    const clusterCount = poissonCount(jitterSeed ^ 0x6d2b79f5, clusterLambda);
    for (let c = 0; c < clusterCount; c += 1) {
      if (points.length >= MAX_TASK_POINTS) break;
      const clusterSeed0 = (jitterSeed ^ (c * 2971215073)) >>> 0;
      const clusterSeed1 = (jitterSeed ^ (c * 1431655765)) >>> 0;
      const n0 = stochastic01(clusterSeed0, frameBucket, timeBlend);
      const n1 = stochastic01(clusterSeed1, frameBucket, timeBlend);
      const jitterScale = sp.channel === "ring" ? 0.0032 : 0.0028;
      const jx = (n0 - 0.5) * jitterScale;
      const jy = (n1 - 0.5) * jitterScale;
      const sizeScale = sp.channel === "ring" ? 0.68 + n1 * 1.05 : 0.58 + n1 * 0.95;
      const subPoint: TaskPoint = {
        nx: clamp01(basePoint.nx + jx),
        ny: clamp01(basePoint.ny + jy),
        nz: basePoint.nz,
        radius: basePoint.radius * sizeScale,
        urgency: basePoint.urgency,
        importance: basePoint.importance,
        selected: basePoint.selected,
        hovered: basePoint.hovered,
        dirX: basePoint.dirX,
        dirY: basePoint.dirY,
        coherence: clamp01(basePoint.coherence * (0.9 + n0 * 0.22)),
        ink: clamp01(basePoint.ink * (0.92 + n1 * 0.38)),
      };
      if (subPoint.ink < 0.12 || subPoint.radius < 0.00035) continue;
      points.push(subPoint);
      frameTotalMassCount += 1;
    }
  }
}

export function buildTaskFieldPointsSingleActive(
  atoms: Atom[],
  activeState: ActiveMessageState,
  selectedId: string | null,
  hoveredId: string | null,
  nowMs: number,
  benchmarkMode: BenchmarkMode = "frozen_eval",
  freezeToken: number | null = null,
): TaskPoint[] {
  lastMatchMeta = { source: "none", matchedPhrase: null, canonicalKey: null };
  lastStats = {
    channelCounts: { ring: 0, tendril: 0, hook: 0 },
    ringContinuityScore: 0,
    sweepProgress: 0,
    injectorBBoxArea: 0,
    ringCoverageRatio: 0,
    ringBandOccupancyRatio: 0,
    innerVoidRatio: 1,
    innerVoidPenalty: 0,
    centerMassRatio: 0,
    sectorOccupancy: Array.from({ length: 12 }, () => 0),
    ringSectorOccupancy: Array.from({ length: 12 }, () => 0),
    solveEnergy: 0,
    solveBreakdown: { eMask: 0, eContinuity: 0, eGap: 0, eThickness: 0, eVoid: 0, eRadius: 0, eSparsity: 0, total: 0 },
    unwrapProfiles: { activationTheta: Array.from({ length: 192 }, () => 0), thicknessTheta: Array.from({ length: 192 }, () => 0), spurTheta: Array.from({ length: 192 }, () => 0) },
    gapCountSolved: 0,
    constraintViolationCount: 0,
    shapeSignature: Array.from({ length: 24 }, () => 0),
    signatureDistanceToCanonical: 0,
    textureEntropy: 0,
    radialVariance: 0,
    arcSpacingVariance: 0,
    repeatScore: 0,
    generatedRadialProfile: Array.from({ length: 24 }, () => 0),
    generatedAngularHistogram12: Array.from({ length: 12 }, () => 0),
    generatedGapCount: 0,
    generatedFrayDensity: 0,
    generatedStrokeWidthMean: 0,
    generatedStrokeWidthVar: 0,
  };
  frameCenterMassCount = 0;
  frameTotalMassCount = 0;
  frameRingBandCount = 0;
  frameRadialSum = 0;
  frameRadialSumSq = 0;
  frameArcGapSum = 0;
  frameArcGapSumSq = 0;
  frameArcGapCount = 0;
  frameEntropyAccum = 0;
  frameEntropyCount = 0;
  frameRadialBins = Array.from({ length: 24 }, () => 0);
  frameStrokeWidthSum = 0;
  frameStrokeWidthSumSq = 0;
  frameStrokeWidthCount = 0;
  const points: TaskPoint[] = [];
  if (atoms.length === 0) return points;

  const bounds = computeBounds(atoms);
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const active = activeState.activeMessageAtomId ? byId.get(activeState.activeMessageAtomId) : undefined;
  const prev = activeState.activeMessagePrevAtomId ? byId.get(activeState.activeMessagePrevAtomId) : undefined;
  if (!active && !prev) return points;

  const blend = clamp01(activeState.activeMessageBlend);
  const sweepProgress = clamp01(blend * 1.05);
  lastStats.sweepProgress = sweepProgress;
  const wNew = prev ? blend : 1;
  const wPrev = prev ? 1 - blend : 0;
  const transitionImpulse = prev ? Math.exp(-blend * 8.0) : 0;
  if (prev && prev.id !== active?.id) {
    pushAtomPoints(points, prev, bounds, selectedId, hoveredId, PREV_SAMPLE_BUDGET, wPrev, false, 0, 1, nowMs, benchmarkMode, freezeToken);
  }
  if (active) {
    pushAtomPoints(points, active, bounds, selectedId, hoveredId, ACTIVE_SAMPLE_BUDGET, wNew, true, transitionImpulse, sweepProgress, nowMs, benchmarkMode, freezeToken);
  }

  if (points.length > 0) {
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    for (const p of points) {
      minX = Math.min(minX, p.nx);
      maxX = Math.max(maxX, p.nx);
      minY = Math.min(minY, p.ny);
      maxY = Math.max(maxY, p.ny);
    }
    lastStats.injectorBBoxArea = Math.max(0, (maxX - minX) * (maxY - minY));
    const occupiedSectors = lastStats.ringSectorOccupancy.filter((v) => v >= 2).length;
    const expectedActiveSectors = Math.max(4, Math.round(12 * Math.max(0.35, lastStats.sweepProgress)));
    lastStats.ringCoverageRatio = clamp01(occupiedSectors / expectedActiveSectors);
    lastStats.ringBandOccupancyRatio = frameTotalMassCount > 0 ? clamp01(frameRingBandCount / frameTotalMassCount) : 0;
    lastStats.centerMassRatio = frameTotalMassCount > 0 ? frameCenterMassCount / frameTotalMassCount : 0;
    lastStats.innerVoidRatio = 1 - clamp01(lastStats.centerMassRatio / Math.max(1e-3, MAX_CENTER_MASS_RATIO));
    if (frameTotalMassCount > 0) {
      const rMean = frameRadialSum / frameTotalMassCount;
      lastStats.radialVariance = Math.max(0, frameRadialSumSq / frameTotalMassCount - rMean * rMean);
    }
    if (frameArcGapCount > 0) {
      const gMean = frameArcGapSum / frameArcGapCount;
      lastStats.arcSpacingVariance = Math.max(0, frameArcGapSumSq / frameArcGapCount - gMean * gMean);
    }
    if (frameEntropyCount > 0) {
      const m = frameEntropyAccum / frameEntropyCount;
      lastStats.textureEntropy = -m * Math.log2(Math.max(1e-6, m)) - (1 - m) * Math.log2(Math.max(1e-6, 1 - m));
    }
    lastStats.repeatScore = clamp01(0.55 * (1 - Math.min(1, lastStats.textureEntropy)) + 0.25 * Math.exp(-lastStats.radialVariance * 1200) + 0.2 * Math.exp(-lastStats.arcSpacingVariance * 1800));
    const radialTotal = frameRadialBins.reduce((acc, v) => acc + v, 0);
    lastStats.generatedRadialProfile = radialTotal > 0 ? frameRadialBins.map((v) => v / radialTotal) : Array.from({ length: 24 }, () => 0);
    const sectorTotal = lastStats.ringSectorOccupancy.reduce((acc, v) => acc + v, 0);
    lastStats.generatedAngularHistogram12 =
      sectorTotal > 0 ? lastStats.ringSectorOccupancy.map((v) => v / sectorTotal) : Array.from({ length: 12 }, () => 0);
    let gapCount = 0;
    for (let i = 0; i < 12; i += 1) {
      const cur = (lastStats.generatedAngularHistogram12[i] ?? 0) > 0.02 ? 1 : 0;
      const prev = (lastStats.generatedAngularHistogram12[(i + 11) % 12] ?? 0) > 0.02 ? 1 : 0;
      if (cur === 0 && prev === 1) gapCount += 1;
    }
    lastStats.generatedGapCount = gapCount;
    lastStats.generatedFrayDensity = clamp01((lastStats.channelCounts.tendril + lastStats.channelCounts.hook) / Math.max(1, lastStats.channelCounts.ring));
    if (frameStrokeWidthCount > 0) {
      const wMean = frameStrokeWidthSum / frameStrokeWidthCount;
      lastStats.generatedStrokeWidthMean = wMean;
      lastStats.generatedStrokeWidthVar = Math.max(0, frameStrokeWidthSumSq / frameStrokeWidthCount - wMean * wMean);
    }
  }

  return points;
}

export function getLastTaskFieldMatchMeta(): MatchMeta {
  return lastMatchMeta;
}

export function getLastTaskFieldStats(): TaskFieldStats {
  return lastStats;
}
