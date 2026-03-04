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

function canonicalFromPhrase(phrase: string, index: number): string {
  const normalized = phrase.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${normalized}_${String(index + 1).padStart(3, "0")}`;
}

export async function seedDictionary(db: Database): Promise<void> {
  const row = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM logogram_dictionary WHERE language = ?", ["heptapod_b_v1"]);
  if ((row?.count ?? 0) >= 100) return;

  const phrases = buildPhrases();
  for (let i = 0; i < phrases.length; i += 1) {
    const phrase = phrases[i];
    const canonicalKey = canonicalFromPhrase(phrase, i);
    const hash = hashString(canonicalKey);
    const segmentMask = ((hash ^ (hash >>> 8)) & 0x0fff) || 1;
    const style = {
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
