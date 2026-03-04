import type { Atom } from "../../data/types";
import type { MatchedLogogram } from "../../data/types";

export type LogogramSegmentKind = "empty" | "arc" | "branch" | "hook" | "break";

export type LogogramSegment = {
  kind: LogogramSegmentKind;
  curvature: number;
  length: number;
  thickness: number;
  direction: -1 | 1;
};

export type LogogramDescriptor = {
  segments: LogogramSegment[];
  baseRadius: number;
  complexity: number;
};

export type LogogramPoint = {
  x: number;
  y: number;
  thickness: number;
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

function seeded(seed: number): () => number {
  let v = seed >>> 0;
  return () => {
    v = hashMix(v + 0x9e3779b9);
    return (v & 0xffffffff) / 0x100000000;
  };
}

function typeSeed(type: Atom["type"]): number {
  const map: Record<Atom["type"], number> = {
    task: 1,
    date: 2,
    message: 3,
    email: 4,
    image: 5,
    file: 6,
    event: 7,
    custom: 8,
  };
  return map[type] ?? 9;
}

function stateSeed(state: Atom["state"]): number {
  const map: Record<Atom["state"], number> = {
    new: 11,
    active: 13,
    snoozed: 17,
    done: 19,
    archived: 23,
  };
  return map[state] ?? 29;
}

function generateFromSeed(
  seed: number,
  urgencyIn: number,
  importanceIn: number,
  style: Record<string, unknown>,
  segmentMask?: number,
  doneBias = 0,
): LogogramDescriptor {
  const styleCurvature = typeof style.curvatureBias === "number" ? clamp01(style.curvatureBias) : 0.5;
  const styleThickness = typeof style.thicknessBias === "number" ? clamp01(style.thicknessBias) : 0.5;
  const styleHook = typeof style.hookBias === "number" ? clamp01(style.hookBias) : 0.3;
  const urgency = clamp01(urgencyIn);
  const importance = clamp01(importanceIn);
  const complexity = clamp01(0.2 + urgency * 0.45 + importance * 0.35);
  const rnd = seeded(seed);

  const segments: LogogramSegment[] = [];
  for (let i = 0; i < 12; i += 1) {
    const segmentEnabled = segmentMask === undefined ? true : ((segmentMask >> i) & 1) === 1;
    if (!segmentEnabled) {
      segments.push({
        kind: "empty",
        curvature: 0,
        length: 0,
        thickness: 0,
        direction: 1,
      });
      continue;
    }
    const roll = rnd();
    const direction: -1 | 1 = rnd() < 0.5 ? -1 : 1;
    const arcBias = 0.45 + importance * 0.2;
    const branchBias = 0.2 + complexity * 0.15;
    const hookBias = 0.08 + urgency * 0.15 + styleHook * 0.12;
    const breakBias = 0.08 + doneBias;
    let kind: LogogramSegmentKind = "empty";
    if (roll < arcBias) kind = "arc";
    else if (roll < arcBias + branchBias) kind = "branch";
    else if (roll < arcBias + branchBias + hookBias) kind = "hook";
    else if (roll < arcBias + branchBias + hookBias + breakBias) kind = "break";

    segments.push({
      kind,
      curvature: clamp01(0.1 + rnd() * 0.8 + (styleCurvature - 0.5) * 0.3),
      length: 0.35 + rnd() * 0.65,
      thickness: clamp01(0.2 + complexity * 0.65 + rnd() * 0.25 + (styleThickness - 0.5) * 0.25),
      direction,
    });
  }

  return {
    segments,
    baseRadius: 0.62 + importance * 0.26,
    complexity,
  };
}

export function generateLogogram(atom: Atom): LogogramDescriptor {
  const seed = hashMix(atom.stableKey ^ (typeSeed(atom.type) * 2654435761) ^ (stateSeed(atom.state) * 40503));
  return generateFromSeed(seed, atom.urgency, atom.importance, {}, undefined, atom.state === "done" ? 0.1 : 0);
}

export function generateLogogramFromMatch(atom: Atom, match: MatchedLogogram): LogogramDescriptor {
  const seed = hashMix(atom.stableKey ^ hashMix(Number.parseInt(match.messageHash, 16) || atom.stableKey) ^ hashMix(hashString(match.canonicalKey)));
  return generateFromSeed(seed, atom.urgency, atom.importance, match.style, match.segmentMask, atom.state === "done" ? 0.1 : 0);
}

function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function sampleLogogram(logogram: LogogramDescriptor, sampleBudget: number): LogogramPoint[] {
  const points: LogogramPoint[] = [];
  if (sampleBudget <= 0) return points;
  const active = logogram.segments.filter((segment) => segment.kind !== "empty");
  if (active.length === 0) return points;

  const perSegment = Math.max(1, Math.floor(sampleBudget / active.length));
  const angleStep = (Math.PI * 2) / 12;

  for (let i = 0; i < logogram.segments.length; i += 1) {
    const segment = logogram.segments[i];
    if (segment.kind === "empty") continue;
    const baseAngle = i * angleStep;
    const span = angleStep * (0.45 + 0.35 * segment.length);
    const localSteps = segment.kind === "hook" ? perSegment + 1 : perSegment;

    for (let s = 0; s < localSteps; s += 1) {
      const t = localSteps === 1 ? 0.5 : s / (localSteps - 1);
      const bend = segment.direction * (segment.curvature - 0.5) * 0.34;
      let angle = baseAngle - span * 0.5 + span * t + bend * Math.sin(t * Math.PI);
      let radius = logogram.baseRadius * (0.85 + 0.25 * Math.sin((t + segment.curvature) * Math.PI));

      if (segment.kind === "branch") {
        radius *= 0.76;
        angle += segment.direction * 0.28 * t;
      } else if (segment.kind === "hook") {
        angle += segment.direction * 0.72 * t * t;
        radius *= 0.72 + 0.32 * (1 - t);
      } else if (segment.kind === "break") {
        if (t > 0.4 && t < 0.65) continue;
      }

      points.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        thickness: segment.thickness,
      });
    }
  }

  return points;
}
