import type { Atom } from "../../data/types";
import type { MatchedLogogram } from "../../data/types";
import { getDictionaryByCanonical, getDictionaryByPhrase, getDictionaryEntries, normalizeDictionaryPhrase } from "../../data/logogramDictionary";
import { hashStringU32 } from "../../data/types";

function normalizeMessage(input: string): string {
  return normalizeDictionaryPhrase(input);
}

function extractPayloadMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  return typeof rec.message === "string" ? rec.message : null;
}

function extractPayloadCanonicalKey(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  const key = rec.logogramCanonicalKey;
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isUnknownCanonicalKey(key: string): boolean {
  return key.startsWith("unknown:");
}

function hashToHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

const warned = new Set<string>();

function warnOnce(reason: "invalid_key", detail: Record<string, unknown>): void {
  const key = `${reason}:${JSON.stringify(detail)}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[logogram-matcher]", { reason, ...detail });
}

function buildUnknownMatch(message: string, atomId: string): MatchedLogogram {
  const seed = hashStringU32(`${message}|${atomId}`);
  return buildUnknownMatchFromSeed(seed);
}

function buildUnknownMatchFromSeed(seed: number, canonicalOverride?: string): MatchedLogogram {
  const ringBias = 0.58 + (((seed >>> 2) & 0xff) / 255) * 0.34;
  const gapBias = 0.14 + (((seed >>> 7) & 0xff) / 255) * 0.2;
  const tendrilBias = 0.28 + (((seed >>> 12) & 0xff) / 255) * 0.38;
  const hookBias = 0.2 + (((seed >>> 17) & 0xff) / 255) * 0.32;
  const continuityBias = 0.62 + (((seed >>> 22) & 0xff) / 255) * 0.26;
  const sweepBias = 0.4 + (((seed >>> 27) & 0x1f) / 31) * 0.5;
  const frayBias = 0.42 + (((seed >>> 5) & 0xff) / 255) * 0.26;
  return {
    source: "unknown",
    canonicalKey: canonicalOverride ?? `unknown:${hashToHex8(seed)}`,
    messageHash: hashToHex8(seed),
    segmentMask: (seed ^ (seed >>> 7)) & 0x0fff,
    style: {
      ring_bias: ringBias,
      gap_bias: gapBias,
      tendril_bias: tendrilBias,
      hook_bias: hookBias,
      continuity_bias: continuityBias,
      sweep_bias: sweepBias,
      fray_bias: frayBias,
      curvatureBias: (((seed >>> 3) & 0xff) / 255) * 0.8 + 0.1,
      thicknessBias: (((seed >>> 11) & 0xff) / 255) * 0.8 + 0.1,
      hookBias: hookBias,
    },
  };
}

function buildUnknownMatchFromCanonicalKey(canonicalKey: string, atomId: string): MatchedLogogram {
  const suffix = canonicalKey.slice("unknown:".length);
  const parsed = /^[0-9a-f]{8}$/i.test(suffix) ? Number.parseInt(suffix, 16) >>> 0 : hashStringU32(`${canonicalKey}|${atomId}`);
  return buildUnknownMatchFromSeed(parsed, canonicalKey);
}

export function extractMessageText(atom: Atom): string {
  return extractPayloadMessage(atom.payload) ?? "";
}

export function matchLogogramFromMessage(atom: Atom): MatchedLogogram {
  const raw = extractMessageText(atom);
  const normalized = normalizeMessage(raw);
  const canonicalMap = getDictionaryByCanonical();
  const payloadKey = extractPayloadCanonicalKey(atom.payload);
  if (payloadKey) {
    if (isUnknownCanonicalKey(payloadKey)) {
      return buildUnknownMatchFromCanonicalKey(payloadKey, atom.id);
    }
    const entry = canonicalMap.get(payloadKey);
    if (entry) {
      const hash = hashToHex8(hashStringU32(normalized || atom.id));
      return {
        source: "dictionary",
        canonicalKey: entry.canonicalKey,
        entryId: entry.id,
        matchedPhrase: entry.phrase,
        messageHash: hash,
        segmentMask: entry.segmentMask & 0x0fff,
        style: entry.style,
      };
    }
    warnOnce("invalid_key", { atomId: atom.id, canonicalKey: payloadKey });
    return buildUnknownMatch(normalized || atom.id, atom.id);
  }
  if (!normalized) return buildUnknownMatch("", atom.id);

  const phraseMap = getDictionaryByPhrase();
  const phraseExact = phraseMap.get(normalized);
  if (phraseExact) {
    const hash = hashToHex8(hashStringU32(normalized));
    return {
      source: "dictionary",
      canonicalKey: phraseExact.canonicalKey,
      entryId: phraseExact.id,
      matchedPhrase: phraseExact.phrase,
      messageHash: hash,
      segmentMask: phraseExact.segmentMask & 0x0fff,
      style: phraseExact.style,
    };
  }

  const entries = getDictionaryEntries();
  if (entries.length === 0) return buildUnknownMatch(normalized, atom.id);
  let bestSubstring:
    | {
        phrase: string;
        canonicalKey: string;
        id: string;
        segmentMask: number;
        style: Record<string, unknown>;
      }
    | undefined;

  for (const entry of entries) {
    const phrase = normalizeMessage(entry.phrase);
    if (!phrase) continue;
    if (phrase === normalized) continue;
    if (!normalized.includes(phrase)) continue;
    if (!bestSubstring) {
      bestSubstring = {
        phrase,
        canonicalKey: entry.canonicalKey,
        id: entry.id,
        segmentMask: entry.segmentMask,
        style: entry.style,
      };
      continue;
    }
    if (
      phrase.length > bestSubstring.phrase.length ||
      (phrase.length === bestSubstring.phrase.length && entry.canonicalKey < bestSubstring.canonicalKey)
    ) {
      bestSubstring = {
        phrase,
        canonicalKey: entry.canonicalKey,
        id: entry.id,
        segmentMask: entry.segmentMask,
        style: entry.style,
      };
    }
  }

  const best = bestSubstring;
  if (!best) return buildUnknownMatch(normalized, atom.id);
  const hash = hashToHex8(hashStringU32(normalized));
  return {
    source: "dictionary",
    canonicalKey: best.canonicalKey,
    entryId: best.id,
    matchedPhrase: best.phrase,
    messageHash: hash,
    segmentMask: best.segmentMask & 0x0fff,
    style: best.style,
  };
}
