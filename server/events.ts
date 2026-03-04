import type { Response } from "express";

type Client = {
  id: number;
  res: Response;
};

let nextId = 1;
const clients = new Map<number, Client>();

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function attachSseClient(res: Response): () => void {
  const id = nextId;
  nextId += 1;
  clients.set(id, { id, res });
  writeSse(res, "connected", { ok: true, id, ts: Date.now() });

  return () => {
    clients.delete(id);
  };
}

export function broadcastEvent(event: string, data: unknown): void {
  for (const client of clients.values()) {
    try {
      writeSse(client.res, event, data);
    } catch {
      clients.delete(client.id);
    }
  }
}

export function startHeartbeat(intervalMs = 15000): () => void {
  const interval = setInterval(() => {
    broadcastEvent("heartbeat", { ts: Date.now() });
  }, intervalMs);
  return () => clearInterval(interval);
}
