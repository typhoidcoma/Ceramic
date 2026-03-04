import { apiUrl } from "./api";

type GenerateResponse = {
  atom?: unknown;
  messageText?: string;
  canonicalKey?: string;
  matchedPhrase?: string;
  source?: "dictionary" | "unknown";
  latencyMs?: number;
  error?: string;
};

export async function generateAndInsertIncomingMessage(
  userPrompt: string,
): Promise<{ ok: true; text: string; canonicalKey: string; source: "dictionary" | "unknown"; latencyMs: number } | { ok: false; error: string; latencyMs: number }> {
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

    return {
      ok: true,
      text: data.messageText,
      canonicalKey: data.canonicalKey,
      source: data.source,
      latencyMs: typeof data.latencyMs === "number" ? Math.max(0, Math.floor(data.latencyMs)) : latencyMs,
    };
  } catch (error: unknown) {
    const latencyMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : "Failed to contact local backend.";
    return { ok: false, error: message, latencyMs };
  }
}
