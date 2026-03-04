import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";

export const benchmarkRouter = Router();

benchmarkRouter.get("/references", async (_req, res) => {
  const manifestPath = path.resolve(process.cwd(), "data/reference/manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    res.json({ entries });
  } catch {
    res.json({ entries: [] });
  }
});
