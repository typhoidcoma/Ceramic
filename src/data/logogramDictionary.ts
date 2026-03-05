import { apiUrl } from "./api";
import type { DictionaryEntry } from "./types";

type DictionaryRow = {
  id: string;
  phrase: string;
  canonical_key: string;
  segment_mask: number;
  style: Record<string, unknown> | null;
  language: string;
};

let loadedLanguage = "";
let phraseMap = new Map<string, DictionaryEntry>();
let canonicalMap = new Map<string, DictionaryEntry>();

function normalizePhrase(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadDictionary(language = "heptapod_b_v1"): Promise<void> {
  if (loadedLanguage === language && phraseMap.size > 0) return;
  loadedLanguage = language;
  phraseMap = new Map();
  canonicalMap = new Map();

  const response = await fetch(apiUrl(`/api/dictionary?language=${encodeURIComponent(language)}&limit=1000`));
  if (!response.ok) return;
  const data = (await response.json()) as { entries?: DictionaryRow[] };
  const rows = Array.isArray(data.entries) ? data.entries : [];

  for (const row of rows) {
    const entry: DictionaryEntry = {
      id: row.id,
      phrase: row.phrase,
      canonicalKey: row.canonical_key,
      segmentMask: row.segment_mask,
      style: row.style ?? {},
      language: row.language,
    };
    phraseMap.set(normalizePhrase(entry.phrase), entry);
    canonicalMap.set(entry.canonicalKey, entry);
  }
}

export function getDictionaryEntries(): DictionaryEntry[] {
  return [...phraseMap.values()];
}

export function getDictionaryByPhrase(): Map<string, DictionaryEntry> {
  return phraseMap;
}

export function getDictionaryByCanonical(): Map<string, DictionaryEntry> {
  return canonicalMap;
}

export function normalizeDictionaryPhrase(input: string): string {
  return normalizePhrase(input);
}
