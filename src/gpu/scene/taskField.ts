import type { Atom } from "../../data/types";
import type { ActiveMessageState } from "../../app/store";
import type { TaskPoint } from "../buffers";
import { MAX_TASK_POINTS } from "../sim/constants";
import { generateLogogramFromMatch, sampleLogogram } from "./logograms";
import { matchLogogramFromMessage } from "./logogramMatcher";

type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

type MatchMeta = {
  source: "dictionary" | "unknown" | "none";
  matchedPhrase: string | null;
  canonicalKey: string | null;
};

let lastMatchMeta: MatchMeta = { source: "none", matchedPhrase: null, canonicalKey: null };

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

const ACTIVE_SAMPLE_BUDGET = 96;
const PREV_SAMPLE_BUDGET = 64;
const MAX_LOGOGRAM_CACHE = 256;
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
  const baseRadius = (0.006 + 0.024 * (0.4 * urgency + 0.6 * importance)) * (0.35 + 0.65 * weight);
  const emphasis = selected ? 2.5 : hovered ? 1.8 : 1;

  points.push({
    nx: centerX,
    ny: centerY,
    nz: centerZ,
    radius: baseRadius * emphasis,
    urgency,
    importance,
    selected,
    hovered,
    dirX: 0,
    dirY: 0,
    coherence: (0.55 + 0.35 * importance) * (0.55 + 0.45 * weight) * (match.source === "dictionary" ? 1.12 : 1),
    ink: (0.45 + 0.4 * importance) * (0.5 + 0.5 * weight),
  });
  if (points.length >= MAX_TASK_POINTS) return;

  const remaining = MAX_TASK_POINTS - points.length;
  const targetSamples = Math.min(remaining, Math.max(1, Math.floor(budget * weight)));
  const descriptor = generateLogogramFromMatch(atom, match);
  const symbolPoints = getCachedSymbolPoints(`${match.canonicalKey}:${match.messageHash}`, descriptor, targetSamples);
  const glyphScale = baseRadius * (1.7 + clamp01(atom.importance) * 1.35);

  for (let s = 0; s < symbolPoints.length; s += 1) {
    if (points.length >= MAX_TASK_POINTS) break;
    const sp = symbolPoints[s];
    const prev = symbolPoints[Math.max(0, s - 1)];
    const next = symbolPoints[Math.min(symbolPoints.length - 1, s + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tLen = Math.hypot(tx, ty) || 1;
    points.push({
      nx: clamp01(centerX + sp.x * glyphScale),
      ny: clamp01(centerY + sp.y * glyphScale * 0.88),
      nz: clamp01(centerZ + sp.y * 0.02),
      radius: baseRadius * (0.32 + sp.thickness * 0.26) * emphasis,
      urgency,
      importance,
      selected,
      hovered,
      dirX: tx / tLen,
      dirY: ty / tLen,
      coherence: (0.42 + 0.42 * clamp01(atom.importance)) * (0.55 + 0.45 * weight) * (match.source === "dictionary" ? 1.12 : 1),
      ink: (0.3 + 0.6 * (sp.thickness / 1.4)) * (0.5 + 0.5 * weight),
    });
  }
}

export function buildTaskFieldPointsSingleActive(
  atoms: Atom[],
  activeState: ActiveMessageState,
  selectedId: string | null,
  hoveredId: string | null,
  _nowMs: number,
): TaskPoint[] {
  lastMatchMeta = { source: "none", matchedPhrase: null, canonicalKey: null };
  const points: TaskPoint[] = [];
  if (atoms.length === 0) return points;

  const bounds = computeBounds(atoms);
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const active = activeState.activeMessageAtomId ? byId.get(activeState.activeMessageAtomId) : undefined;
  const prev = activeState.activeMessagePrevAtomId ? byId.get(activeState.activeMessagePrevAtomId) : undefined;
  if (!active && !prev) return points;

  const blend = clamp01(activeState.activeMessageBlend);
  const wNew = prev ? blend : 1;
  const wPrev = prev ? 1 - blend : 0;
  if (prev && prev.id !== active?.id) {
    pushAtomPoints(points, prev, bounds, selectedId, hoveredId, PREV_SAMPLE_BUDGET, wPrev, false);
  }
  if (active) {
    pushAtomPoints(points, active, bounds, selectedId, hoveredId, ACTIVE_SAMPLE_BUDGET, wNew, true);
  }

  return points;
}

export function getLastTaskFieldMatchMeta(): MatchMeta {
  return lastMatchMeta;
}
