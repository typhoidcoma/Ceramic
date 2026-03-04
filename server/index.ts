import "dotenv/config";
import express from "express";
import cors from "cors";
import { initializeDatabase, getDb } from "./db";
import { seedDictionary } from "./seed";
import { atomsRouter } from "./routes/atoms";
import { dictionaryRouter } from "./routes/dictionary";
import { messagesRouter } from "./routes/messages";
import { eventsRouter } from "./routes/events";
import { startHeartbeat } from "./events";

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use("/api/atoms", atomsRouter);
app.use("/api/dictionary", dictionaryRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/events", eventsRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Server error";
  res.status(500).json({ error: message });
});

async function bootstrap(): Promise<void> {
  await initializeDatabase();
  const db = await getDb();
  await seedDictionary(db);

  startHeartbeat();
  app.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
  });
}

void bootstrap().catch((error) => {
  console.error("[server] failed to start", error);
  process.exit(1);
});
