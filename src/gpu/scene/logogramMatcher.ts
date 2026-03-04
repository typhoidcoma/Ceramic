import type { Atom } from "../../data/types";
import type { MatchedLogogram } from "../../data/types";
import { getDictionaryByCanonical, getDictionaryEntries, normalizeDictionaryPhrase } from "../../data/logogramDictionary";
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

function hashToHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

const warned = new Set<string>();

function warnOnce(reason: "invalid_key" | "dictionary_unavailable", detail: Record<string, unknown>): void {
  const key = `${reason}:${JSON.stringify(detail)}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[logogram-matcher]", { reason, ...detail });
}

function buildUnknownMatch(message: string, atomId: string): MatchedLogogram {
  const seed = hashStringU32(`${message}|${atomId}`);
  return {
    source: "unknown",
    canonicalKey: `unknown:${hashToHex8(seed)}`,
    messageHash: hashToHex8(seed),
    segmentMask: (seed ^ (seed >>> 7)) & 0x0fff,
    style: {
      curvatureBias: (((seed >>> 3) & 0xff) / 255) * 0.8 + 0.1,
      thicknessBias: (((seed >>> 11) & 0xff) / 255) * 0.8 + 0.1,
      hookBias: (((seed >>> 19) & 0xff) / 255) * 0.6,
    },
  };
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

  const entries = getDictionaryEntries();
  if (entries.length === 0) {
    warnOnce("dictionary_unavailable", { atomId: atom.id });
    return buildUnknownMatch(normalized, atom.id);
  }
  let best:
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
    if (!phrase || !normalized.includes(phrase)) continue;
    if (!best) {
      best = {
        phrase,
        canonicalKey: entry.canonicalKey,
        id: entry.id,
        segmentMask: entry.segmentMask,
        style: entry.style,
      };
      continue;
    }
    if (phrase.length > best.phrase.length || (phrase.length === best.phrase.length && entry.canonicalKey < best.canonicalKey)) {
      best = {
        phrase,
        canonicalKey: entry.canonicalKey,
        id: entry.id,
        segmentMask: entry.segmentMask,
        style: entry.style,
      };
    }
  }

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
