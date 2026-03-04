import { getSupabaseClient } from "./supabase";
import { hashStringU32 } from "./types";

type GenerateFunctionResponse = {
  messageText: string;
  canonicalKey: string;
  matchedPhrase?: string;
  source: "dictionary" | "unknown";
  message?: string;
};

type GenerateResult =
  | { ok: true; messageText: string; canonicalKey: string; matchedPhrase?: string; source: "dictionary" | "unknown"; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

function getFunctionName(): string {
  const fromEnv = import.meta.env.VITE_SUPABASE_LLM_FUNCTION_NAME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return "super-service";
}

function getFunctionCandidates(): string[] {
  return [getFunctionName()];
}

function unknownKeyFromPrompt(prompt: string): string {
  return `unknown:${hashStringU32(prompt).toString(16).padStart(8, "0")}`;
}

function formatFunctionInvokeError(error: unknown): string {
  if (!error || typeof error !== "object") return "Edge Function request failed.";
  const e = error as Record<string, unknown>;
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "Edge Function request failed.";
  const context = (e.context ?? null) as { status?: number; response?: { status?: number; statusText?: string } } | null;
  const status = context?.status ?? context?.response?.status;
  const statusText = context?.response?.statusText;

  if (name === "FunctionsFetchError") {
    return "Cannot reach Supabase Edge Functions. Check project URL/network and that function is deployed.";
  }
  if (name === "FunctionsRelayError") {
    return `Supabase relay error${status ? ` (${status})` : ""}. ${message}`;
  }
  if (name === "FunctionsHttpError") {
    return `Edge Function HTTP error${status ? ` ${status}` : ""}${statusText ? ` ${statusText}` : ""}.`;
  }
  if (status) {
    return `Edge Function request failed (${status}${statusText ? ` ${statusText}` : ""}).`;
  }
  return message;
}

export async function generateLlmMessageText(userPrompt: string, language = "heptapod_b_v1"): Promise<GenerateResult> {
  const supabase = getSupabaseClient();
  const started = performance.now();
  const prompt = userPrompt.trim();
  if (!prompt) {
    return { ok: false, error: "Prompt is required.", latencyMs: Math.round(performance.now() - started) };
  }
  const timeoutMs = 10000;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("LLM request timed out.")), timeoutMs);
  });

  try {
    let lastError: unknown = null;
    let data: GenerateFunctionResponse | null = null;
    let error: { message: string } | null = null;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      const latencyMs = Math.round(performance.now() - started);
      return { ok: false, error: "Not authenticated. Sign in again and retry.", latencyMs };
    }

    for (const fnName of getFunctionCandidates()) {
      try {
        const call = supabase.functions.invoke<GenerateFunctionResponse>(fnName, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          body: { userPrompt: prompt, language, name: prompt },
        });
        const result = await Promise.race([call, timeout]);
        data = result.data ?? null;
        error = result.error ?? null;
        if (!error) break;
        lastError = error;
      } catch (e) {
        lastError = e;
      }
    }
    const latencyMs = Math.round(performance.now() - started);
    if (error || !data) {
      if (lastError) return { ok: false, error: formatFunctionInvokeError(lastError), latencyMs };
      return { ok: false, error: error?.message ?? "Function call failed.", latencyMs };
    }
    if (data.messageText && data.canonicalKey && data.source) {
      return {
        ok: true,
        messageText: data.messageText.trim(),
        canonicalKey: data.canonicalKey,
        matchedPhrase: data.matchedPhrase,
        source: data.source,
        latencyMs,
      };
    }

    // Compatibility fallback for legacy/simpler function payloads like { message: "Hello ..." }.
    if (data.message && typeof data.message === "string") {
      return {
        ok: true,
        messageText: data.message.trim().slice(0, 180),
        canonicalKey: unknownKeyFromPrompt(prompt),
        source: "unknown",
        latencyMs,
      };
    }
    return { ok: false, error: "Function returned invalid payload.", latencyMs };
  } catch (error: unknown) {
    const latencyMs = Math.round(performance.now() - started);
    const message = formatFunctionInvokeError(error);
    return { ok: false, error: message, latencyMs };
  }
}

export async function insertIncomingMessageAtom(
  userId: string,
  prompt: string,
  generated: { messageText: string; canonicalKey: string; matchedPhrase?: string; source: "dictionary" | "unknown" },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const insertRow = {
    user_id: userId,
    type: "message",
    state: "active",
    ts: nowIso,
    urgency: 0.72,
    importance: 0.74,
    title: "LLM Incoming Message",
    preview: generated.messageText,
    payload: {
      message: generated.messageText,
      prompt: prompt.trim().slice(0, 512),
      logogramCanonicalKey: generated.canonicalKey,
      logogramSource: generated.source,
      ...(generated.matchedPhrase ? { logogramPhrase: generated.matchedPhrase } : {}),
      source: "openai_llm",
    },
    source: "openai",
  };
  const { error } = await (supabase.from("atoms") as unknown as { insert: (values: unknown) => Promise<{ error: { message: string } | null }> }).insert(
    insertRow,
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function generateAndInsertIncomingMessage(
  userId: string,
  userPrompt: string,
): Promise<{ ok: true; text: string; canonicalKey: string; source: "dictionary" | "unknown"; latencyMs: number } | { ok: false; error: string; latencyMs: number }> {
  const generated = await generateLlmMessageText(userPrompt);
  if (!generated.ok) return generated;
  const inserted = await insertIncomingMessageAtom(userId, userPrompt, generated);
  if (!inserted.ok) return { ok: false, error: inserted.error, latencyMs: generated.latencyMs };
  return { ok: true, text: generated.messageText, canonicalKey: generated.canonicalKey, source: generated.source, latencyMs: generated.latencyMs };
}
