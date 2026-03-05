export type AtomType =
  | "task"
  | "date"
  | "message"
  | "email"
  | "image"
  | "file"
  | "event"
  | "custom";

export type AtomState = "new" | "active" | "snoozed" | "done" | "archived";

export type Atom = {
  id: string;
  type: AtomType;
  ts: number;
  due?: number;
  urgency: number;
  importance: number;
  state: AtomState;
  title?: string;
  preview?: string;
  payload?: unknown;
  sensitivity?: "low" | "medium" | "high";
  visibility?: "masked" | "revealed";
  labels?: string[];
  score: number;
  stableKey: number;
  sizeTier: 0 | 1 | 2;
  targetX: number;
  targetY: number;
  targetZ: number;
  x: number;
  y: number;
  z: number;
  renderSize: number;
  treeDepth: number;
  treeRole: "trunk" | "branch" | "leaf";
  growthPhase: number;
  parentId?: string;
  descendantCount: number;
};

export type AtomPatch = Partial<Omit<Atom, "id" | "stableKey" | "score" | "sizeTier">> & {
  id: string;
};

export type DictionaryEntry = {
  id: string;
  phrase: string;
  canonicalKey: string;
  segmentMask: number;
  style: LogogramStyle;
  language: string;
};

export type LogogramStyle = {
  ring_bias?: number;
  gap_bias?: number;
  tendril_bias?: number;
  hook_bias?: number;
  continuity_bias?: number;
  sweep_bias?: number;
  fray_bias?: number;
  mass_bias?: number;
  clump_count_bias?: number;
  clump_span_bias?: number;
  tendril_count_bias?: number;
  tendril_length_bias?: number;
  arc_dropout_bias?: number;
  curvatureBias?: number;
  thicknessBias?: number;
  hookBias?: number;
};

export type MatchedLogogram = {
  source: "dictionary" | "unknown";
  canonicalKey: string;
  entryId?: string;
  matchedPhrase?: string;
  messageHash: string;
  segmentMask: number;
  style: LogogramStyle;
};

export type LogogramSolveBreakdown = {
  eMask: number;
  eContinuity: number;
  eGap: number;
  eThickness: number;
  eVoid: number;
  eRadius: number;
  eSparsity: number;
  total: number;
};

export type BenchmarkMode = "live" | "frozen_eval" | "disabled_by_plan";

export type ReferenceMaskStats = {
  ringCoverage: number;
  gapCount: number;
  radialProfile: number[];
  angularHistogram12: number[];
  frayDensity: number;
  strokeWidthMean: number;
  strokeWidthVar: number;
};

export type ReferenceLogogramSample = {
  id: string;
  sourcePath: string;
  label: string;
  tags?: string[];
  aliases?: string[];
  maskStats: ReferenceMaskStats;
};

export type ReferenceBenchmarkDistance = {
  radial: number;
  angular: number;
  gaps: number;
  fray: number;
  width: number;
  total: number;
};

export type ReferenceBenchmarkResult = {
  canonicalKey: string;
  sampleId: string;
  candidateSetId: string;
  distance: ReferenceBenchmarkDistance;
  pass: boolean;
  stabilityStdDev: number;
  fpsWindowMin: number;
  overallPass: boolean;
};

export type TimelineBucket = {
  key: string;
  label: string;
  items: Atom[];
};

export type TimelineSortMode = "recent" | "due" | "importance";

export const ATOM_TYPES: AtomType[] = [
  "task",
  "date",
  "message",
  "email",
  "image",
  "file",
  "event",
  "custom",
];

export const ATOM_STATES: AtomState[] = ["new", "active", "snoozed", "done", "archived"];

export const TYPE_TO_ID = new Map<AtomType, number>(ATOM_TYPES.map((type, i) => [type, i]));

export const HALF_LIFE_MS = 1000 * 60 * 60 * 24 * 7;

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function hashStringU32(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function computeScore(ts: number, urgency: number, importance: number, now: number): number {
  const age = Math.max(0, now - ts);
  const recency = Math.exp(-age / HALF_LIFE_MS);
  return 0.55 * clamp01(urgency) + 0.35 * clamp01(importance) + 0.1 * recency;
}

export function scoreToSizeTier(score: number): 0 | 1 | 2 {
  if (score > 0.85) return 2;
  if (score > 0.65) return 1;
  return 0;
}

export function enrichAtom(
  atom: Omit<
    Atom,
    | "stableKey"
    | "score"
    | "sizeTier"
    | "targetX"
    | "targetY"
    | "targetZ"
    | "x"
    | "y"
    | "z"
    | "renderSize"
    | "treeDepth"
    | "treeRole"
    | "growthPhase"
    | "descendantCount"
  > &
    Partial<Pick<Atom, "targetX" | "targetY" | "targetZ" | "x" | "y" | "z" | "renderSize" | "treeDepth" | "treeRole" | "growthPhase" | "parentId" | "descendantCount">>,
  now: number,
): Atom {
  const score = computeScore(atom.ts, atom.urgency, atom.importance, now);
  const stableKey = hashStringU32(atom.id);
  return {
    ...atom,
    score,
    stableKey,
    sizeTier: scoreToSizeTier(score),
    targetX: atom.targetX ?? 0,
    targetY: atom.targetY ?? 0,
    targetZ: atom.targetZ ?? 0,
    x: atom.x ?? 0,
    y: atom.y ?? 0,
    z: atom.z ?? 0,
    renderSize: atom.renderSize ?? 0,
    treeDepth: atom.treeDepth ?? 0,
    treeRole: atom.treeRole ?? "leaf",
    growthPhase: atom.growthPhase ?? 1,
    parentId: atom.parentId,
    descendantCount: atom.descendantCount ?? 0,
  };
}
