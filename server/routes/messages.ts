import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db";
import { broadcastEvent } from "../events";
import { generateMessageFromPrompt } from "../llm";

const BodySchema = z.object({
  userPrompt: z.string().min(1),
  language: z.string().default("heptapod_b_v1"),
});

export const messagesRouter = Router();

messagesRouter.post("/generate", async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }

  const db = await getDb();
  const dictionary = await db.all<Array<{ canonical_key: string; phrase: string }>>(
    `SELECT canonical_key, phrase FROM logogram_dictionary WHERE language = ? AND is_active = 1 LIMIT 200`,
    [parsed.data.language],
  );

  const generated = await generateMessageFromPrompt(parsed.data.userPrompt, dictionary);

  const atom = {
    id: randomUUID(),
    type: "message",
    state: "active",
    ts: new Date().toISOString(),
    due: null,
    urgency: 0.72,
    importance: 0.74,
    title: "LLM Incoming Message",
    preview: generated.messageText,
    payload: {
      message: generated.messageText,
      prompt: parsed.data.userPrompt.trim().slice(0, 512),
      logogramCanonicalKey: generated.canonicalKey,
      logogramSource: generated.source,
      ...(generated.matchedPhrase ? { logogramPhrase: generated.matchedPhrase } : {}),
      source: "openai_local",
    },
  } as const;

  await db.run(
    `INSERT INTO atoms (id, type, state, ts, due, urgency, importance, title, preview, payload, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      atom.id,
      atom.type,
      atom.state,
      atom.ts,
      atom.due,
      atom.urgency,
      atom.importance,
      atom.title,
      atom.preview,
      JSON.stringify(atom.payload),
      "local",
    ],
  );

  const eventPayload = {
    ...atom,
    payload: atom.payload,
  };

  broadcastEvent("atom_insert", eventPayload);

  res.json({
    atom: eventPayload,
    messageText: generated.messageText,
    canonicalKey: generated.canonicalKey,
    matchedPhrase: generated.matchedPhrase,
    source: generated.source,
    latencyMs: generated.latencyMs,
  });
});
