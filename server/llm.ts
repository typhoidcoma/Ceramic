import { z } from "zod";

const OPENAI_URL = "https://api.openai.com/v1/responses";

export type GeneratedLogogramMessage = {
  messageText: string;
  canonicalKey: string;
  matchedPhrase?: string;
  source: "dictionary" | "unknown";
  latencyMs: number;
};

type DictEntry = {
  canonical_key: string;
  phrase: string;
};

const OutputSchema = z.object({
  message_text: z.string().min(1),
  canonical_key: z.string().min(1),
});

function hashString(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizePrompt(input: string): string {
  return input.toLowerCase().normalize("NFKC").replace(/[^a-z0-9'\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function unknownKey(prompt: string): string {
  return `unknown:${hashString(prompt || "empty").toString(16).padStart(8, "0")}`;
}

function extractOutputText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const rec = json as Record<string, unknown>;
  if (typeof rec.output_text === "string") return rec.output_text;
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

export async function generateMessageFromPrompt(userPrompt: string, dictionary: DictEntry[]): Promise<GeneratedLogogramMessage> {
  const started = Date.now();
  const prompt = userPrompt.trim();
  const promptNorm = normalizePrompt(prompt);
  const key = process.env.OPENAI_API_KEY?.trim();

  if (!key || dictionary.length === 0) {
    return {
      messageText: prompt.split(/\s+/).slice(0, 12).join(" ") || "unknown incoming signal",
      canonicalKey: unknownKey(promptNorm),
      source: "unknown",
      latencyMs: Date.now() - started,
    };
  }

  const optionsText = dictionary.map((row) => `- ${row.canonical_key}: ${row.phrase}`).join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: "Map prompt to one canonical key from allowed list and write one short incoming phrase. Return JSON only.",
          },
          {
            role: "user",
            content: `Prompt: ${prompt}\n\nAllowed canonical keys:\n${optionsText}`,
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

    if (!response.ok) {
      const fallback = prompt.split(/\s+/).slice(0, 12).join(" ") || "unknown incoming signal";
      return {
        messageText: fallback,
        canonicalKey: unknownKey(promptNorm),
        source: "unknown",
        latencyMs: Date.now() - started,
      };
    }

    const json = (await response.json()) as unknown;
    const text = extractOutputText(json);
    let parsed = OutputSchema.safeParse({ message_text: "", canonical_key: "" });
    if (text) {
      try {
        parsed = OutputSchema.safeParse(JSON.parse(text));
      } catch {
        parsed = OutputSchema.safeParse({ message_text: "", canonical_key: "" });
      }
    }

    if (!parsed.success) {
      const fallback = prompt.split(/\s+/).slice(0, 12).join(" ") || "unknown incoming signal";
      return {
        messageText: fallback,
        canonicalKey: unknownKey(promptNorm),
        source: "unknown",
        latencyMs: Date.now() - started,
      };
    }

    const canonicalKey = parsed.data.canonical_key.trim();
    const dictMatch = dictionary.find((row) => row.canonical_key === canonicalKey);
    if (!dictMatch) {
      return {
        messageText: parsed.data.message_text.split(/\s+/).slice(0, 12).join(" "),
        canonicalKey: unknownKey(promptNorm),
        source: "unknown",
        latencyMs: Date.now() - started,
      };
    }

    return {
      messageText: parsed.data.message_text.trim().split(/\s+/).slice(0, 12).join(" "),
      canonicalKey,
      matchedPhrase: dictMatch.phrase,
      source: "dictionary",
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}
