import type { Atom } from "../data/types";

export type AtomConnection = {
  a: string;
  b: string;
  strength: number;
  kind: "time" | "likeness";
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function similarity(a: Atom, b: Atom): number {
  const urgencyDelta = Math.abs(a.urgency - b.urgency);
  const importanceDelta = Math.abs(a.importance - b.importance);
  const stateMatch = a.state === b.state ? 0.2 : 0;
  const typeMatch = a.type === b.type ? 0.25 : 0;
  return clamp01(1 - 0.45 * urgencyDelta - 0.35 * importanceDelta + stateMatch + typeMatch);
}

export function buildConstellationConnections(atoms: Atom[], maxEdges = 9000): AtomConnection[] {
  if (atoms.length < 2) return [];
  const edgeMap = new Map<string, AtomConnection>();
  const byTime = [...atoms].sort((a, b) => a.ts - b.ts);

  const addEdge = (a: Atom, b: Atom, strength: number, kind: "time" | "likeness"): void => {
    if (a.id === b.id) return;
    const left = a.id < b.id ? a.id : b.id;
    const right = left === a.id ? b.id : a.id;
    const key = `${left}|${right}`;
    const existing = edgeMap.get(key);
    if (!existing || strength > existing.strength) {
      edgeMap.set(key, { a: left, b: right, strength: clamp01(strength), kind });
    }
  };

  for (let i = 0; i < byTime.length; i += 1) {
    const atom = byTime[i];
    for (let step = 1; step <= 2; step += 1) {
      const prev = byTime[i - step];
      const next = byTime[i + step];
      if (prev) {
        const dtDays = Math.abs(atom.ts - prev.ts) / (1000 * 60 * 60 * 24);
        addEdge(atom, prev, 1 - clamp01(dtDays / 14), "time");
      }
      if (next) {
        const dtDays = Math.abs(atom.ts - next.ts) / (1000 * 60 * 60 * 24);
        addEdge(atom, next, 1 - clamp01(dtDays / 14), "time");
      }
    }
  }

  const byType = new Map<string, Atom[]>();
  for (const atom of atoms) {
    const bucket = byType.get(atom.type);
    if (bucket) bucket.push(atom);
    else byType.set(atom.type, [atom]);
  }

  for (const bucket of byType.values()) {
    bucket.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.stableKey - b.stableKey;
    });
    for (let i = 0; i < bucket.length; i += 1) {
      const atom = bucket[i];
      for (let step = 1; step <= 3; step += 1) {
        const neighbor = bucket[i + step];
        if (!neighbor) break;
        addEdge(atom, neighbor, similarity(atom, neighbor), "likeness");
      }
    }
  }

  return [...edgeMap.values()]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxEdges)
    .filter((edge) => edge.strength >= 0.12);
}
