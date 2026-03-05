import { randomUUID } from "node:crypto";
import type { Database } from "sqlite";

function hashString(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const intents = [
  "we offer",
  "we remember",
  "we request",
  "we witness",
  "we become",
  "we align",
  "we return",
  "we protect",
  "we reveal",
  "we exchange",
];

const nouns = [
  "safe passage",
  "shared memory",
  "open hands",
  "quiet orbit",
  "clear signal",
  "mutual trust",
  "time accord",
  "calm approach",
  "deep listening",
  "common language",
];

function buildPhrases(): string[] {
  const phrases: string[] = [];
  for (const intent of intents) {
    for (const noun of nouns) {
      phrases.push(`${intent} ${noun}`);
    }
  }
  return phrases.slice(0, 100);
}

type ConceptSeed = {
  phrase: string;
  canonicalKey: string;
  segmentMask: number;
  style: Record<string, number>;
};

const conceptSeeds: ConceptSeed[] = [
  {
    phrase: "heptapod",
    canonicalKey: "concept:heptapod",
    segmentMask: 0b111010111011,
    style: {
      ring_bias: 0.64,
      gap_bias: 0.3,
      tendril_bias: 0.7,
      hook_bias: 0.56,
      continuity_bias: 0.62,
      sweep_bias: 0.64,
      fray_bias: 0.6,
      mass_bias: 0.78,
      clump_count_bias: 0.48,
      clump_span_bias: 0.64,
      tendril_count_bias: 0.66,
      tendril_length_bias: 0.62,
      arc_dropout_bias: 0.44,
      curvatureBias: 0.64,
      thicknessBias: 0.74,
      hookBias: 0.56,
    },
  },
  {
    phrase: "human",
    canonicalKey: "concept:human",
    segmentMask: 0b111011101101,
    style: {
      ring_bias: 0.62,
      gap_bias: 0.32,
      tendril_bias: 0.68,
      hook_bias: 0.55,
      continuity_bias: 0.6,
      sweep_bias: 0.62,
      fray_bias: 0.58,
      mass_bias: 0.76,
      clump_count_bias: 0.44,
      clump_span_bias: 0.62,
      tendril_count_bias: 0.64,
      tendril_length_bias: 0.6,
      arc_dropout_bias: 0.46,
      curvatureBias: 0.64,
      thicknessBias: 0.72,
      hookBias: 0.55,
    },
  },
  {
    phrase: "time",
    canonicalKey: "concept:time",
    segmentMask: 0b111101110111,
    style: {
      ring_bias: 0.58,
      gap_bias: 0.4,
      tendril_bias: 0.74,
      hook_bias: 0.56,
      continuity_bias: 0.52,
      sweep_bias: 0.66,
      fray_bias: 0.62,
      mass_bias: 0.82,
      clump_count_bias: 0.56,
      clump_span_bias: 0.72,
      tendril_count_bias: 0.72,
      tendril_length_bias: 0.72,
      arc_dropout_bias: 0.52,
      curvatureBias: 0.62,
      thicknessBias: 0.8,
      hookBias: 0.56,
    },
  },
  {
    phrase: "weapon",
    canonicalKey: "concept:weapon",
    segmentMask: 0b110111011101,
    style: {
      ring_bias: 0.6,
      gap_bias: 0.36,
      tendril_bias: 0.66,
      hook_bias: 0.62,
      continuity_bias: 0.58,
      sweep_bias: 0.58,
      fray_bias: 0.56,
      mass_bias: 0.72,
      clump_count_bias: 0.42,
      clump_span_bias: 0.58,
      tendril_count_bias: 0.56,
      tendril_length_bias: 0.62,
      arc_dropout_bias: 0.44,
      curvatureBias: 0.6,
      thicknessBias: 0.74,
      hookBias: 0.62,
    },
  },
  {
    phrase: "earth",
    canonicalKey: "concept:earth",
    segmentMask: 0b111110101101,
    style: {
      ring_bias: 0.57,
      gap_bias: 0.42,
      tendril_bias: 0.58,
      hook_bias: 0.48,
      continuity_bias: 0.56,
      sweep_bias: 0.54,
      fray_bias: 0.52,
      mass_bias: 0.68,
      clump_count_bias: 0.46,
      clump_span_bias: 0.54,
      tendril_count_bias: 0.5,
      tendril_length_bias: 0.5,
      arc_dropout_bias: 0.5,
      curvatureBias: 0.54,
      thicknessBias: 0.66,
      hookBias: 0.48,
    },
  },
  {
    phrase: "language",
    canonicalKey: "concept:language",
    segmentMask: 0b101111011110,
    style: {
      ring_bias: 0.63,
      gap_bias: 0.28,
      tendril_bias: 0.72,
      hook_bias: 0.54,
      continuity_bias: 0.65,
      sweep_bias: 0.66,
      fray_bias: 0.6,
      mass_bias: 0.74,
      clump_count_bias: 0.52,
      clump_span_bias: 0.66,
      tendril_count_bias: 0.72,
      tendril_length_bias: 0.68,
      arc_dropout_bias: 0.45,
      curvatureBias: 0.64,
      thicknessBias: 0.7,
      hookBias: 0.54,
    },
  },
  {
    phrase: "memory",
    canonicalKey: "concept:memory",
    segmentMask: 0b111001111011,
    style: {
      ring_bias: 0.55,
      gap_bias: 0.44,
      tendril_bias: 0.62,
      hook_bias: 0.52,
      continuity_bias: 0.54,
      sweep_bias: 0.58,
      fray_bias: 0.56,
      mass_bias: 0.72,
      clump_count_bias: 0.5,
      clump_span_bias: 0.62,
      tendril_count_bias: 0.58,
      tendril_length_bias: 0.66,
      arc_dropout_bias: 0.54,
      curvatureBias: 0.56,
      thicknessBias: 0.72,
      hookBias: 0.52,
    },
  },
  {
    phrase: "future",
    canonicalKey: "concept:future",
    segmentMask: 0b110111101110,
    style: {
      ring_bias: 0.6,
      gap_bias: 0.38,
      tendril_bias: 0.74,
      hook_bias: 0.58,
      continuity_bias: 0.56,
      sweep_bias: 0.68,
      fray_bias: 0.62,
      mass_bias: 0.8,
      clump_count_bias: 0.54,
      clump_span_bias: 0.74,
      tendril_count_bias: 0.74,
      tendril_length_bias: 0.76,
      arc_dropout_bias: 0.5,
      curvatureBias: 0.62,
      thicknessBias: 0.78,
      hookBias: 0.58,
    },
  },
  {
    phrase: "life",
    canonicalKey: "concept:life",
    segmentMask: 0b111101011011,
    style: {
      ring_bias: 0.62,
      gap_bias: 0.34,
      tendril_bias: 0.64,
      hook_bias: 0.5,
      continuity_bias: 0.6,
      sweep_bias: 0.58,
      fray_bias: 0.54,
      mass_bias: 0.7,
      clump_count_bias: 0.48,
      clump_span_bias: 0.58,
      tendril_count_bias: 0.56,
      tendril_length_bias: 0.58,
      arc_dropout_bias: 0.46,
      curvatureBias: 0.6,
      thicknessBias: 0.68,
      hookBias: 0.5,
    },
  },
];

function canonicalFromPhrase(phrase: string, index: number): string {
  const normalized = phrase.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${normalized}_${String(index + 1).padStart(3, "0")}`;
}

export async function seedDictionary(db: Database): Promise<void> {
  const phrases = buildPhrases();
  for (const concept of conceptSeeds) {
    await db.run(
      `INSERT OR IGNORE INTO logogram_dictionary (id, phrase, canonical_key, segment_mask, style, language, is_active)
       VALUES (?, ?, ?, ?, ?, 'heptapod_b_v1', 1)`,
      [randomUUID(), concept.phrase, concept.canonicalKey, concept.segmentMask, JSON.stringify(concept.style)],
    );
  }

  for (let i = 0; i < phrases.length; i += 1) {
    const phrase = phrases[i];
    const canonicalKey = canonicalFromPhrase(phrase, i);
    const hash = hashString(canonicalKey);
    const segmentMask = ((hash ^ (hash >>> 8)) & 0x0fff) || 1;
    const style = {
      ring_bias: (((hash >>> 1) & 0xff) / 255) * 0.8 + 0.1,
      gap_bias: (((hash >>> 5) & 0xff) / 255) * 0.6,
      tendril_bias: (((hash >>> 9) & 0xff) / 255) * 0.7,
      hook_bias: (((hash >>> 13) & 0xff) / 255) * 0.7,
      continuity_bias: (((hash >>> 17) & 0xff) / 255) * 0.8 + 0.1,
      sweep_bias: (((hash >>> 21) & 0xff) / 255) * 0.8 + 0.1,
      fray_bias: (((hash >>> 25) & 0x7f) / 127) * 0.8 + 0.1,
      // legacy compatibility fields
      curvatureBias: (((hash >>> 4) & 0xff) / 255) * 0.8 + 0.1,
      thicknessBias: (((hash >>> 12) & 0xff) / 255) * 0.8 + 0.1,
      hookBias: (((hash >>> 20) & 0xff) / 255) * 0.7,
    };

    await db.run(
      `INSERT OR IGNORE INTO logogram_dictionary (id, phrase, canonical_key, segment_mask, style, language, is_active)
       VALUES (?, ?, ?, ?, ?, 'heptapod_b_v1', 1)`,
      [randomUUID(), phrase, canonicalKey, segmentMask, JSON.stringify(style)],
    );
  }
}
