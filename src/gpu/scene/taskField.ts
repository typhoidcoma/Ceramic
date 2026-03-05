import { type Atom } from "../../data/types";
import type { ActiveMessageState } from "../../app/store";
import type { TaskPoint } from "../buffers";
import { BENCH_MAX_ACTIVE_POINTS, BENCH_MAX_PREV_POINTS, MAX_TASK_POINTS } from "../sim/constants";
import { generateLogogramFromMatch, sampleLogogram, rasterizeLogogram, type ProceduralMaskRaster } from "./logograms";
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
  maskPointCountRing: number;
  maskPointCountBlob: number;
  maskPointCountTendril: number;
  maskContinuityScore: number;
  maskArcOccupancy12: number[];
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
  ringContinuityRuns: number;
  largestBlobArcRatio: number;
  dripCount: number;
  dripLengthMean: number;
  whiskerCount: number;
  bgDarkDriftRate: number;
  generatedRadialProfile: number[];
  generatedAngularHistogram12: number[];
  generatedGapCount: number;
  generatedFrayDensity: number;
  generatedStrokeWidthMean: number;
  generatedStrokeWidthVar: number;
};

let lastMatchMeta: MatchMeta = { source: "none", matchedPhrase: null, canonicalKey: null };
let lastLogogramRaster: ProceduralMaskRaster | null = null;
let lastLogogramRasterKey: string | null = null;
let lastStats: TaskFieldStats = {
  channelCounts: { ring: 0, tendril: 0, hook: 0 },
  maskPointCountRing: 0,
  maskPointCountBlob: 0,
  maskPointCountTendril: 0,
  maskContinuityScore: 0,
  maskArcOccupancy12: Array.from({ length: 12 }, () => 0),
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
  ringContinuityRuns: 0,
  largestBlobArcRatio: 0,
  dripCount: 0,
  dripLengthMean: 0,
  whiskerCount: 0,
  bgDarkDriftRate: 0,
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
let frameBlobSectorCounts = Array.from({ length: 12 }, () => 0);
let frameDripCount = 0;
let frameWhiskerCount = 0;
let frameDripLengthAccum = 0;
let frameDripLengthCount = 0;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && !Number.isNaN(value);
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

const ACTIVE_SAMPLE_BUDGET = Math.min(3200, BENCH_MAX_ACTIVE_POINTS);
const PREV_SAMPLE_BUDGET = Math.min(1600, BENCH_MAX_PREV_POINTS);
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
  const baseRadius = (0.0048 + 0.0068 * (0.45 * urgency + 0.55 * importance)) * (0.6 + 0.4 * weight);
  const emphasis = selected ? 1.28 : hovered ? 1.14 : 1;
  const dictionaryBoost = match.source === "dictionary" ? 1.18 : 0.82;
  const impulseBoost = 1 + transitionImpulse * 0.18;

  const remaining = MAX_TASK_POINTS - points.length;
  // Keep point density high even during blends so the logogram stays structured, not sparse.
  const densityFloor = 0.76;
  const effectiveSampleWeight = densityFloor + (1 - densityFloor) * weight;
  const minSamples = Math.min(budget, 220);
  const targetSamples = Math.min(remaining, Math.max(minSamples, Math.floor(budget * effectiveSampleWeight)));
  const descriptor = generateLogogramFromMatch(atom, match);
  // Generate/cache density raster for target-field injection
  const rasterKey = `${match.canonicalKey}:${match.messageHash}:${benchmarkMode}:${freezeToken ?? "live"}`;
  if (useAsPrimaryMeta && rasterKey !== lastLogogramRasterKey) {
    lastLogogramRaster = rasterizeLogogram(descriptor, 4096);
    lastLogogramRasterKey = rasterKey;
  }
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
      const oy = Math.sin(a) * radial;
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
    if (!isFiniteNumber(sp.x) || !isFiniteNumber(sp.y) || !isFiniteNumber(sp.thickness) || !isFiniteNumber(sp.mass) || !isFiniteNumber(sp.phase)) {
      continue;
    }
    if (!useAsPrimaryMeta && sp.channel !== "ring") continue;
    const isRing = sp.channel === "ring";
    const isBlob = sp.channel === "blob";
    const isTendril = sp.channel === "tendril";
    const prev = symbolPoints[Math.max(0, s - 1)];
    const next = symbolPoints[Math.min(symbolPoints.length - 1, s + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    if (prev.channel !== sp.channel || next.channel !== sp.channel) {
      if (isRing) {
        tx = -sp.y;
        ty = sp.x;
      } else if (isTendril) {
        tx = (sp.jitterU ?? 0) * 0.4;
        ty = 1 + (sp.jitterV ?? 0) * 0.2;
      } else {
        tx = next.x - sp.x;
        ty = next.y - sp.y;
      }
    }
    const tLen = Math.hypot(tx, ty) || 1;
    const perceivedSweep = clamp01(sweepProgress + (1 - sweepProgress) * 0.48);
    const phaseLead = isRing ? 0.24 : isBlob ? 0.28 : 0.08;
    const reveal = clamp01((perceivedSweep - (sp.phase - phaseLead) + 0.38) / 0.38);
    if (reveal <= 0) continue;
    const revealEased = reveal * reveal * (3 - 2 * reveal);
    const injectorStrength = injectorStrengthBase * (0.72 + 0.28 * revealEased);
    const depositionRate = depositionRateBase * (0.62 + 0.38 * revealEased);
    const channelScale = isRing ? 1.38 : isBlob ? 0.62 : 0.58;
    const anisotropy = isRing
      ? clamp01(0.52 + 0.14 * sp.mass)
      : isBlob
        ? clamp01(0.04 + 0.06 * sp.mass)
        : clamp01(0.48 + 0.18 * sp.mass);
    const pigmentBias = clamp01((0.34 + 0.66 * (sp.thickness / 1.3)) * dictionaryBoost * impulseBoost * channelScale);
    const radiusScale = isRing ? 0.94 : isBlob ? 0.52 : 0.38;
    const ox = sp.x * glyphScale;
    const oy = sp.y * glyphScale;
    const radial = Math.hypot(ox, oy);
    if (isRing && (radial < ringBandMinRadiusNorm || radial > ringBandMaxRadiusNorm)) continue;
    if (radial > ringBandMaxRadiusNorm * 1.24) continue;
    const centerPenalty = radial < CENTER_VOID_RADIUS_NORM ? (CENTER_VOID_RADIUS_NORM - radial) / CENTER_VOID_RADIUS_NORM : 0;
    if (centerPenalty > 0.84) continue;
    const px = centerX + ox;
    const py = centerY + oy;
    const sectorAngle = (Math.atan2(oy, ox) + Math.PI * 2) % (Math.PI * 2);
    const sector = Math.floor((sectorAngle / (Math.PI * 2)) * 12) % 12;
    const tangentJitter = (sp.jitterU ?? 0) * 1.6;
    const normalJitter = (sp.jitterV ?? 0) * 1.6;
    const tangentX = tx / tLen;
    const tangentY = ty / tLen;
    const normalX = -tangentY;
    const normalY = tangentX;
    const flowBoost = reveal < 0.92 ? (1 - revealEased) * 1.8 : 0;
    const flowX = tangentX * (1 + flowBoost) + normalX * flowBoost * 0.15;
    const flowY = tangentY * (1 + flowBoost) + normalY * flowBoost * 0.15;
    const flowLen = Math.hypot(flowX, flowY) || 1;
    const dirX = flowX / flowLen;
    const dirY = flowY / flowLen;
    const jitteredNx = clamp01(px + tangentX * tangentJitter + normalX * normalJitter);
    const jitteredNy = clamp01(py + tangentY * tangentJitter + normalY * normalJitter);
    lastStats.sectorOccupancy[sector] += 1;
    if (isRing) lastStats.ringSectorOccupancy[sector] += 1;
    if (isRing) {
      lastStats.channelCounts.ring += 1;
      lastStats.maskPointCountRing += 1;
      lastStats.maskArcOccupancy12[sector] += 1;
    } else if (isBlob) {
      // Keep legacy `hook` counter populated for existing diagnostics compatibility.
      lastStats.channelCounts.hook += 1;
      lastStats.maskPointCountBlob += 1;
      frameBlobSectorCounts[sector] += 1;
    } else if (isTendril) {
      lastStats.channelCounts.tendril += 1;
      lastStats.maskPointCountTendril += 1;
      if (sp.thickness >= 0.22) frameDripCount += 1;
      else frameWhiskerCount += 1;
    }
    const basePoint: TaskPoint = {
      nx: jitteredNx,
      ny: jitteredNy,
      nz: clamp01(centerZ + sp.y * 0.02),
      radius: baseRadius * (0.26 + sp.thickness * (0.22 + sp.mass * 0.13)) * emphasis * radiusScale * (0.75 + revealEased * 0.25),
      urgency: injectorStrength,
      importance: depositionRate * (isBlob ? 0.88 : isTendril ? 0.64 : 1.22) * (centerClamp ? 0.9 : 1),
      selected,
      hovered,
      dirX,
      dirY,
      coherence: isRing ? clamp01(0.62 + 0.18 * sp.mass) : clamp01(anisotropy * (0.62 + 0.22 * sp.mass)),
      ink:
        pigmentBias *
        (isBlob ? 0.48 + sp.mass * 0.22 : isTendril ? 0.3 + sp.mass * 0.14 : 0.88 + sp.mass * 0.38) *
        (0.7 + 0.3 * revealEased) *
        (1 - centerPenalty * 0.5),
    };
    if (
      !isFiniteNumber(basePoint.nx) ||
      !isFiniteNumber(basePoint.ny) ||
      !isFiniteNumber(basePoint.nz) ||
      !isFiniteNumber(basePoint.radius) ||
      !isFiniteNumber(basePoint.urgency) ||
      !isFiniteNumber(basePoint.importance) ||
      !isFiniteNumber(basePoint.dirX) ||
      !isFiniteNumber(basePoint.dirY) ||
      !isFiniteNumber(basePoint.coherence) ||
      !isFiniteNumber(basePoint.ink)
    ) {
      continue;
    }
    if (basePoint.ink < 0.05 || basePoint.coherence < 0.05) continue;
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
      if (isTendril && prevSp.channel === "tendril" && sp.thickness >= 0.22) {
        frameDripLengthAccum += gap;
        frameDripLengthCount += 1;
      }
    }
    if (radial >= ringBandMinRadiusNorm && radial <= ringBandMaxRadiusNorm) frameRingBandCount += 1;
    if (radial < CENTER_VOID_RADIUS_NORM) frameCenterMassCount += 1;

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
    maskPointCountRing: 0,
    maskPointCountBlob: 0,
    maskPointCountTendril: 0,
    maskContinuityScore: 0,
    maskArcOccupancy12: Array.from({ length: 12 }, () => 0),
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
    ringContinuityRuns: 0,
    largestBlobArcRatio: 0,
    dripCount: 0,
    dripLengthMean: 0,
    whiskerCount: 0,
    bgDarkDriftRate: 0,
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
  frameBlobSectorCounts = Array.from({ length: 12 }, () => 0);
  frameDripCount = 0;
  frameWhiskerCount = 0;
  frameDripLengthAccum = 0;
  frameDripLengthCount = 0;
  const points: TaskPoint[] = [];
  if (atoms.length === 0) return points;

  const bounds = computeBounds(atoms);
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  let active = activeState.activeMessageAtomId ? byId.get(activeState.activeMessageAtomId) : undefined;
  let prev = activeState.activeMessagePrevAtomId ? byId.get(activeState.activeMessagePrevAtomId) : undefined;
  if (!active && !prev) {
    // Fallback: derive active source directly from atoms when state is briefly out of sync.
    const newestMessage = atoms
      .filter((a) => a.type === "message")
      .sort((a, b) => b.ts - a.ts)[0];
    if (newestMessage) {
      active = newestMessage;
    } else {
      return points;
    }
  }

  const blend = clamp01(activeState.activeMessageBlend);
  const sweepProgress = clamp01(Math.pow(blend, 0.68) * 1.02);
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
    let finitePointCount = 0;
    for (const p of points) {
      if (!isFiniteNumber(p.nx) || !isFiniteNumber(p.ny)) continue;
      finitePointCount += 1;
      minX = Math.min(minX, p.nx);
      maxX = Math.max(maxX, p.nx);
      minY = Math.min(minY, p.ny);
      maxY = Math.max(maxY, p.ny);
    }
    lastStats.injectorBBoxArea = finitePointCount > 0 ? Math.max(0, (maxX - minX) * (maxY - minY)) : 0;
    const occupiedSectors = lastStats.ringSectorOccupancy.filter((v) => v >= 2).length;
    const expectedActiveSectors = Math.max(4, 12 - Math.max(0, Math.min(8, lastStats.gapCountSolved)));
    lastStats.ringCoverageRatio = clamp01(occupiedSectors / expectedActiveSectors);
    lastStats.maskContinuityScore = clamp01(occupiedSectors / 12);
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
    const occupancyNorm = clamp01(occupiedSectors / Math.max(1, expectedActiveSectors));
    const entropyPenalty = clamp01((0.86 - Math.min(1, lastStats.textureEntropy)) / 0.44);
    const radialPenalty = clamp01((0.000032 - lastStats.radialVariance) / 0.000032);
    const arcPenalty = clamp01((0.00022 - lastStats.arcSpacingVariance) / 0.00022);
    const continuityRelief = clamp01((lastStats.ringContinuityScore - 0.66) / 0.3);
    const frayDensityNow = clamp01((lastStats.channelCounts.tendril + lastStats.channelCounts.hook) / Math.max(1, lastStats.channelCounts.ring));
    lastStats.repeatScore = clamp01(
      0.34 * entropyPenalty +
      0.12 * radialPenalty +
      0.2 * arcPenalty +
      0.22 * (1 - occupancyNorm) +
      0.12 * (1 - clamp01(frayDensityNow / 0.42)) -
      0.14 * continuityRelief,
    );
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
    lastStats.generatedFrayDensity = frayDensityNow;
    let runs = 0;
    for (let i = 0; i < 12; i += 1) {
      const cur = lastStats.ringSectorOccupancy[i] > 1 ? 1 : 0;
      const prev = lastStats.ringSectorOccupancy[(i + 11) % 12] > 1 ? 1 : 0;
      if (cur === 1 && prev === 0) runs += 1;
    }
    if (runs === 0 && occupiedSectors > 0) runs = 1;
    lastStats.ringContinuityRuns = runs;
    const blobTotal = frameBlobSectorCounts.reduce((acc, v) => acc + v, 0);
    const blobMax = frameBlobSectorCounts.reduce((acc, v) => Math.max(acc, v), 0);
    lastStats.largestBlobArcRatio = blobTotal > 0 ? clamp01(blobMax / blobTotal) : 0;
    lastStats.dripCount = frameDripCount;
    lastStats.whiskerCount = frameWhiskerCount;
    lastStats.dripLengthMean = frameDripLengthCount > 0 ? frameDripLengthAccum / frameDripLengthCount : 0;
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

export function getLastLogogramRaster(): ProceduralMaskRaster | null {
  return lastLogogramRaster;
}
