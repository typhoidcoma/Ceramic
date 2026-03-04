import { createClient } from "npm:@supabase/supabase-js@2";

type DictionaryRow = {
  canonical_key: string;
  phrase: string;
};

type LlmStructured = {
  message_text: string;
  canonical_key: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_LANGUAGE = "heptapod_b_v1";
const TIMEOUT_MS = 8000;
const RATE_LIMIT_MS = 1000;
const recentByIdentity = new Map<string, number>();

function normalizePrompt(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function unknownKeyForPrompt(prompt: string): string {
  return `unknown:${fnv1a(prompt || "empty").toString(16).padStart(8, "0")}`;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function extractOutputText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const rec = json as Record<string, unknown>;
  const outputText = rec.output_text;
  if (typeof outputText === "string") return outputText;
  const output = rec.output;
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const text = (c as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const openAiKey = Deno.env.get("OPENAI_API_KEY") ?? "";

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse(500, { error: "Supabase env missing in function runtime." });
  }
  if (!openAiKey) {
    return jsonResponse(500, { error: "OPENAI_API_KEY is not configured." });
  }

  let body: { userPrompt?: string; language?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body." });
  }

  const userPrompt = typeof body.userPrompt === "string" ? body.userPrompt.trim() : "";
  const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : DEFAULT_LANGUAGE;
  if (!userPrompt) return jsonResponse(400, { error: "userPrompt is required." });

  const authHeader = req.headers.get("Authorization") ?? "";
  const identity = authHeader || req.headers.get("x-forwarded-for") || "anonymous";
  const now = Date.now();
  const lastSeen = recentByIdentity.get(identity) ?? 0;
  if (now - lastSeen < RATE_LIMIT_MS) {
    return jsonResponse(429, { error: "Too many requests. Please retry shortly." });
  }
  recentByIdentity.set(identity, now);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data: dictRows, error: dictError } = await supabase
    .from("logogram_dictionary")
    .select("canonical_key, phrase")
    .eq("language", language)
    .eq("is_active", true)
    .limit(200);

  const rows = (dictRows ?? []) as DictionaryRow[];
  if (dictError || rows.length === 0) {
    console.warn("[logogram-function]", {
      reason: "dictionary_unavailable",
      error: dictError?.message ?? null,
      language,
    });
    const fallbackMessage = userPrompt.split(/\s+/).slice(0, 12).join(" ") || "unknown incoming signal";
    return jsonResponse(200, {
      messageText: fallbackMessage,
      canonicalKey: unknownKeyForPrompt(normalizePrompt(userPrompt)),
      source: "unknown",
    });
  }

  const optionsText = rows
    .map((row) => `- ${row.canonical_key}: ${row.phrase}`)
    .join("\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let parsed: LlmStructured | null = null;
  try {
    const openAiResponse = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content:
              "You map prompts to one provided canonical_key and craft one short incoming heptapod-like message. Output JSON only.",
          },
          {
            role: "user",
            content: `User prompt: ${userPrompt}\n\nAllowed canonical keys:\n${optionsText}`,
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "logogram_message",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                message_text: { type: "string" },
                canonical_key: { type: "string" },
              },
              required: ["message_text", "canonical_key"],
            },
          },
        },
        temperature: 0.5,
        max_output_tokens: 140,
      }),
    });

    if (!openAiResponse.ok) {
      const errText = await openAiResponse.text();
      console.warn("[logogram-function]", { reason: "openai_http_error", status: openAiResponse.status, body: errText.slice(0, 300) });
    } else {
      const raw = await openAiResponse.json();
      const text = extractOutputText(raw);
      if (text) {
        try {
          parsed = JSON.parse(text) as LlmStructured;
        } catch {
          console.warn("[logogram-function]", { reason: "empty_output" });
        }
      }
    }
  } catch {
    console.warn("[logogram-function]", { reason: "openai_timeout_or_network" });
  } finally {
    clearTimeout(timeoutId);
  }

  const normalizedPrompt = normalizePrompt(userPrompt);
  const selectedKey = parsed?.canonical_key?.trim();
  const selectedMessage = parsed?.message_text?.trim();

  const byKey = new Map(rows.map((row) => [row.canonical_key, row]));
  if (!selectedKey || !byKey.has(selectedKey)) {
    if (selectedKey) {
      console.warn("[logogram-function]", { reason: "invalid_key", canonicalKey: selectedKey });
    }
    return jsonResponse(200, {
      messageText: selectedMessage && selectedMessage.length > 0 ? selectedMessage.split(/\s+/).slice(0, 12).join(" ") : userPrompt.split(/\s+/).slice(0, 12).join(" "),
      canonicalKey: unknownKeyForPrompt(normalizedPrompt),
      source: "unknown",
    });
  }

  const row = byKey.get(selectedKey)!;
  const finalMessage = selectedMessage && selectedMessage.length > 0 ? selectedMessage.split(/\s+/).slice(0, 12).join(" ") : row.phrase;

  return jsonResponse(200, {
    messageText: finalMessage,
    canonicalKey: selectedKey,
    matchedPhrase: row.phrase,
    source: "dictionary",
  });
});
