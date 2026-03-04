import type { Atom, LogogramSolveBreakdown, MatchedLogogram } from "../../data/types";
import { CLUMP_DENSITY_DEFAULT, FRAY_DENSITY_DEFAULT, NOISE_OCTAVES_DEFAULT } from "../sim/constants";
import { angleForSector, buildEnergyInputs, quantizeSolvedState, solveLogogramState } from "./logogramEnergy";

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
  channel: "ring" | "tendril" | "hook";
  jitterU: number;
  jitterV: number;
  mass: number;
};

export type SampleLogogramOptions = {
  freezeToken?: number;
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
  const inputs = buildEnergyInputs(match, atom);
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
  const styleFray = typeof match.style.fray_bias === "number" ? clamp01(match.style.fray_bias) : FRAY_DENSITY_DEFAULT;
  const styleClump = typeof match.style.tendril_bias === "number" ? clamp01(match.style.tendril_bias) : CLUMP_DENSITY_DEFAULT;
  return {
    grammar: {
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
  if (role === "trunk") return clamp01(base * 1.05);
  if (role === "modifier") return clamp01(base * 0.9);
  if (role === "tendril" || role === "hook") return clamp01(base * 0.78);
  return base;
}

function pushRingPoint(
  points: LogogramPoint[],
  x: number,
  y: number,
  thickness: number,
  phase: number,
  channel: "ring" | "tendril" | "hook",
  jitterU: number,
  jitterV: number,
  mass: number,
): void {
  points.push({ x, y, thickness: clamp01(thickness), phase: clamp01(phase), channel, jitterU, jitterV, mass: clamp01(mass) });
}

function blueNoiseCompact(points: LogogramPoint[], budget: number): LogogramPoint[] {
  if (points.length <= budget) return points;
  const target = Math.max(1, budget);
  const side = Math.max(12, Math.floor(Math.sqrt(target) * 1.35));
  const cells = new Map<number, LogogramPoint>();
  const score = (p: LogogramPoint) => p.mass * 0.7 + p.thickness * 0.3;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const cx = Math.max(0, Math.min(side - 1, Math.floor((p.x * 0.5 + 0.5) * side)));
    const cy = Math.max(0, Math.min(side - 1, Math.floor((p.y * 0.5 + 0.5) * side)));
    const key = cy * side + cx;
    const prev = cells.get(key);
    if (!prev || score(p) > score(prev)) cells.set(key, p);
  }
  const compact = [...cells.values()];
  if (compact.length <= target) {
    const stride = points.length / target;
    for (let i = compact.length; i < target; i += 1) compact.push(points[Math.floor(i * stride)]);
    return compact;
  }
  compact.sort((a, b) => score(b) - score(a));
  return compact.slice(0, target);
}

export function sampleLogogram(logogram: LogogramDescriptor, sampleBudget: number, options: SampleLogogramOptions = {}): LogogramPoint[] {
  const points: LogogramPoint[] = [];
  if (sampleBudget <= 0) return points;
  const grammar = logogram.grammar;
  const ringBudget = Math.max(20, Math.floor(sampleBudget * 0.62));
  const tendrilBudget = Math.max(10, Math.floor(sampleBudget * 0.26));
  const hookBudget = Math.max(3, sampleBudget - ringBudget - tendrilBudget);
  const baseR = grammar.ringRadiusNorm;
  const ringHalfWidth = Math.max(0.0165, grammar.ringBandWidthNorm);
  const occupied = Math.max(1, grammar.occupiedSectorCount);
  const sweepOffset = (grammar.sweepSeed % 1024) / 1024;
  const seedBase = (grammar.sweepSeed ^ 0x7a4c2db1 ^ ((options.freezeToken ?? 0) >>> 0)) >>> 0;
  const rnd = seeded(seedBase);

  const lobeA = rnd() * Math.PI * 2;
  const lobeB = wrapAngle(lobeA + (0.85 + rnd() * 0.75));
  const cutA = wrapAngle(lobeA + Math.PI - 0.15 + (rnd() - 0.5) * 0.35);
  const cutB = wrapAngle(cutA + 0.8 + rnd() * 0.45);

  const tex = grammar.textureField;
  const ringScale = 7.5 + logogram.complexity * 3.2;
  const radialAmp = 0.0035 + 0.0018 * grammar.frayLevel;
  const tangentialAmp = 0.0026 + 0.0014 * grammar.frayLevel;

  for (let sector = 0; sector < 12; sector += 1) {
    if (grammar.sectorGapMask[sector] === 1) continue;
    const presence = ringPresenceAtSector(grammar, sector);
    const start = angleForSector(sector);
    const end = angleForSector(sector + 1);
    const sectorThickness = grammar.sectorThickness[sector] ?? 0.55;
    const midA = (start + end) * 0.5;
    const lobeWeight =
      0.34 +
      0.72 * angularGaussian(midA, lobeA, 0.54) +
      0.48 * angularGaussian(midA, lobeB, 0.68) -
      0.78 * angularGaussian(midA, cutA, 0.4) -
      0.52 * angularGaussian(midA, cutB, 0.3);
    const sectorMass = clamp01(presence * clamp01(lobeWeight));
    if (sectorMass < 0.12) continue;

    const lambda = Math.max(2.5, (ringBudget / occupied) * (0.42 + sectorMass * 0.95));
    const ringSteps = Math.max(3, poissonCount(rnd, lambda));
    for (let i = 0; i < ringSteps; i += 1) {
      const u = rnd();
      const a0 = start + (end - start) * u;
      const nR = fbm2(tex.textureSeed, sector * 0.83 + u * ringScale + tex.noisePhase, 0.71 + u * 0.95, tex.octaves, tex.lacunarity, tex.gain);
      const nT = fbm2(tex.textureSeed ^ 0x9e3779b9, sector * 1.13 + u * (ringScale * 0.8), 1.9 + u * 1.1 + tex.noisePhase, tex.octaves, tex.lacunarity, tex.gain);

      const jitterU = nT * tangentialAmp;
      const jitterV = nR * radialAmp;
      const a = a0 + jitterU;
      const radius = deformRadius(a, baseR + jitterV, baseR - ringHalfWidth * 1.2, baseR + ringHalfWidth * 1.5, tex);
      const x = Math.cos(a) * radius;
      const y = Math.sin(a) * radius;

      const thicknessNoise = clamp01(0.5 + 0.5 * fbm2(tex.textureSeed ^ 0x85ebca6b, sector + u * 5.4, tex.noisePhase * 0.3 + u * 3.1, 3, 2, 0.5));
      const thickness = clamp01(sectorThickness * (0.5 + 0.36 * sectorMass) * (0.8 + 0.35 * thicknessNoise));
      const phase = ((sector / 12) * 0.45 + u * 0.06 + sweepOffset) % 1;
      const mass = clamp01(0.35 + 0.65 * sectorMass * (0.65 + 0.35 * thicknessNoise));

      const keepP = clamp01(0.28 + sectorMass * 0.56);
      if (rnd() > keepP) continue;

      pushRingPoint(points, x, y, thickness, phase, "ring", jitterU, jitterV, mass);

      const frayP = clamp01(tex.frayDensity * sectorMass * (0.22 + 0.5 * thicknessNoise));
      if (rnd() < frayP) {
        const nx = Math.cos(a);
        const ny = Math.sin(a);
        const frayLen = ringHalfWidth * (0.35 + grammar.frayLevel * 0.8 + sectorMass * 0.2) * (0.45 + 0.55 * u);
        pushRingPoint(
          points,
          x + nx * frayLen,
          y + ny * frayLen,
          thickness * (0.26 + 0.22 * sectorMass),
          0.28 + phase * 0.44,
          "tendril",
          jitterU * 1.2,
          jitterV * 1.4,
          mass * 0.62,
        );
      }
    }

    if (sectorMass > 0.52) {
      const clumpCount = Math.max(1, poissonCount(rnd, 0.85 + sectorMass * (1.8 + tex.clumpDensity * 2.5)));
      for (let c = 0; c < clumpCount; c += 1) {
        const u = rnd();
        const a = start + (end - start) * u + (rnd() - 0.5) * 0.09;
        const spread = ringHalfWidth * (0.55 + rnd() * 0.85);
        const rBase = baseR + (rnd() - 0.32) * ringHalfWidth * (0.8 + sectorMass * 0.52);
        const r = deformRadius(a, rBase, baseR - ringHalfWidth * 1.25, baseR + ringHalfWidth * 1.6, tex);
        const nx = Math.cos(a);
        const ny = Math.sin(a);
        const phase = clamp01(0.16 + (sector / 12) * 0.46 + rnd() * 0.08);
        const mass = clamp01(0.62 + 0.38 * sectorMass);
        pushRingPoint(
          points,
          Math.cos(a) * r + nx * spread,
          Math.sin(a) * r + ny * spread,
          (0.32 + sectorMass * 0.34) * (0.74 + rnd() * 0.36),
          phase,
          "tendril",
          (rnd() - 0.5) * tangentialAmp * 2,
          (rnd() - 0.5) * radialAmp * 2,
          mass,
        );
      }
    }
  }

  const tendrilAnchors = grammar.modifierAnchors.filter((v) => v.kind === "tendril");
  const branchCount = Math.max(1, tendrilAnchors.length || grammar.primaryBranches.length || 1);
  const stepsPerBranch = Math.max(3, Math.floor(tendrilBudget / branchCount));
  const branches = tendrilAnchors.length
    ? tendrilAnchors.map((v, i) => ({
        sector: v.sector,
        length: 0.32 + v.weight * 0.62,
        curvature: 0.3 + rnd() * 0.5,
        direction: ((grammar.sweepSeed + i) & 1) === 0 ? (1 as const) : (-1 as const),
      }))
    : grammar.primaryBranches;

  for (const branch of branches) {
    const baseA = angleForSector(branch.sector);
    for (let i = 0; i < stepsPerBranch; i += 1) {
      const u = i / Math.max(1, stepsPerBranch - 1);
      const bend = branch.direction * (branch.curvature - 0.5) * (0.42 + grammar.frayLevel * 0.38);
      const a = baseA + bend * u;
      const r = deformRadius(
        a,
        baseR + ringHalfWidth * 0.78 + branch.length * u * 0.14,
        baseR - ringHalfWidth * 1.4,
        baseR + ringHalfWidth * 2.4,
        tex,
      );
      const j = fbm2(tex.textureSeed ^ 0xc2b2ae35, branch.sector + u * 3.5, tex.noisePhase + u * 2.7, 3, 2, 0.5);
      const mass = clamp01(0.4 + 0.4 * (1 - u));
      pushRingPoint(
        points,
        Math.cos(a) * (r + j * 0.004),
        Math.sin(a) * (r + j * 0.004),
        (grammar.sectorThickness[branch.sector] ?? 0.5) * (0.58 - u * 0.28),
        0.36 + u * 0.4,
        "tendril",
        j * 0.002,
        j * 0.003,
        mass,
      );
    }
  }

  const hookAnchors = grammar.modifierAnchors.filter((v) => v.kind === "hook");
  const hooks = hookAnchors.length
    ? hookAnchors.map((v, i) => ({
        sector: v.sector,
        size: 0.24 + v.weight * 0.5,
        direction: ((grammar.sweepSeed + i * 7) % 3 === 0 ? -1 : 1) as -1 | 1,
      }))
    : grammar.hooks;

  const stepsPerHook = Math.max(2, Math.floor(hookBudget / Math.max(1, hooks.length || 1)));
  for (const hook of hooks) {
    const baseA = angleForSector(hook.sector);
    for (let i = 0; i < stepsPerHook; i += 1) {
      const u = i / Math.max(1, stepsPerHook - 1);
      const curl = hook.direction * (0.34 + hook.size * 0.66) * u * u;
      const a = baseA + curl;
      const r = deformRadius(
        a,
        baseR + ringHalfWidth * 0.35 + hook.size * (1 - u) * 0.07,
        baseR - ringHalfWidth * 1.5,
        baseR + ringHalfWidth * 2.5,
        tex,
      );
      if (u > 0.66 && hook.size < 0.36) continue;
      const mass = clamp01(0.42 + 0.44 * (1 - u));
      pushRingPoint(
        points,
        Math.cos(a) * r,
        Math.sin(a) * r,
        (grammar.sectorThickness[hook.sector] ?? 0.5) * (0.55 + (1 - u) * 0.2),
        0.68 + u * 0.28,
        "hook",
        (rnd() - 0.5) * 0.002,
        (rnd() - 0.5) * 0.0025,
        mass,
      );
    }
  }

  return blueNoiseCompact(points, sampleBudget);
}
