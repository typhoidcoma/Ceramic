import { Router } from "express";
import { z } from "zod";
import { getDb, type AtomRow } from "../db";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50000).optional(),
});

export const atomsRouter = Router();

atomsRouter.get("/", async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit ?? 5000 : 5000;
  const db = await getDb();
  const rows = await db.all<AtomRow[]>(
    `SELECT id, type, state, ts, due, urgency, importance, title, preview, payload
     FROM atoms
     WHERE state <> 'archived'
     ORDER BY ts DESC
     LIMIT ?`,
    [limit],
  );
  res.json({
    atoms: rows.map((row) => ({
      ...row,
      payload:
        typeof row.payload === "string"
          ? (() => {
              try {
                return JSON.parse(row.payload) as unknown;
              } catch {
                return null;
              }
            })()
          : row.payload,
    })),
  });
});
