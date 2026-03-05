import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db";

const QuerySchema = z.object({
  language: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const dictionaryRouter = Router();

dictionaryRouter.get("/", async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  const language = parsed.success && parsed.data.language ? parsed.data.language : "heptapod_b_v1";
  const limit = parsed.success ? parsed.data.limit ?? 200 : 200;
  const db = await getDb();
  const rows = await db.all<Array<{ id: string; phrase: string; canonical_key: string; segment_mask: number; style: string; language: string }>>(
    `SELECT id, phrase, canonical_key, segment_mask, style, language
     FROM logogram_dictionary
     WHERE language = ? AND is_active = 1
     ORDER BY phrase ASC
     LIMIT ?`,
    [language, limit],
  );

  res.json({
    entries: rows.map((row) => ({
      id: row.id,
      phrase: row.phrase,
      canonical_key: row.canonical_key,
      segment_mask: row.segment_mask,
      style: JSON.parse(row.style || "{}") as Record<string, unknown>,
      language: row.language,
    })),
  });
});
