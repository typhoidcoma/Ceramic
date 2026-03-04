import { apiUrl } from "./api";
import type { AtomState, AtomType } from "./types";

export type AtomLike = {
  id: string;
  type: AtomType;
  state: AtomState;
  ts: number;
  due?: number;
  urgency: number;
  importance: number;
  title?: string;
  preview?: string;
  payload?: unknown;
};

type GenerateResponse = {
  atom?: {
    id: string;
    type: AtomType;
    state: AtomState;
    ts: string;
    due: string | null;
    urgency: number;
    importance: number;
    title: string | null;
    preview: string | null;
    payload: unknown;
  };
  messageText?: string;
  canonicalKey?: string;
  matchedPhrase?: string;
  source?: "dictionary" | "unknown";
  latencyMs?: number;
  error?: string;
};

export async function generateAndInsertIncomingMessage(
  userPrompt: string,
): Promise<
  | { ok: true; text: string; canonicalKey: string; source: "dictionary" | "unknown"; latencyMs: number; atom?: AtomLike }
  | { ok: false; error: string; latencyMs: number }
> {
  const started = performance.now();
  const prompt = userPrompt.trim();
  if (!prompt) return { ok: false, error: "Prompt is required.", latencyMs: 0 };

  try {
    const response = await fetch(apiUrl("/api/messages/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userPrompt: prompt, language: "heptapod_b_v1" }),
    });
    const latencyMs = Math.round(performance.now() - started);
    const data = (await response.json()) as GenerateResponse;

    if (!response.ok) {
      return { ok: false, error: data.error ?? `Request failed (${response.status}).`, latencyMs };
    }
    if (!data.messageText || !data.canonicalKey || !data.source) {
      return { ok: false, error: "Invalid response from local backend.", latencyMs };
    }

    const atom =
      data.atom && data.atom.id
        ? {
            id: data.atom.id,
            type: data.atom.type,
            state: data.atom.state,
            ts: new Date(data.atom.ts).getTime(),
            due: data.atom.due ? new Date(data.atom.due).getTime() : undefined,
            urgency: data.atom.urgency ?? 0,
            importance: data.atom.importance ?? 0,
            title: data.atom.title ?? undefined,
            preview: data.atom.preview ?? undefined,
            payload: data.atom.payload,
          }
        : undefined;

    return {
      ok: true,
      text: data.messageText,
      canonicalKey: data.canonicalKey,
      source: data.source,
      latencyMs: typeof data.latencyMs === "number" ? Math.max(0, Math.floor(data.latencyMs)) : latencyMs,
      atom,
    };
  } catch (error: unknown) {
    const latencyMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : "Failed to contact local backend.";
    return { ok: false, error: message, latencyMs };
  }
}
