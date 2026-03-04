import type { AtomStore } from "../app/store";
import { apiUrl } from "./api";
import { loadDictionary } from "./logogramDictionary";
import type { AtomPatch, AtomState, AtomType } from "./types";

type AtomRow = {
  id: string;
  type: AtomType;
  state: AtomState;
  ts: string;
  due: string | null;
  urgency: number;
  importance: number;
  title: string | null;
  preview: string | null;
  payload: unknown;
};

function rowToAtom(row: AtomRow) {
  const payload =
    typeof row.payload === "string"
      ? (() => {
          try {
            return JSON.parse(row.payload) as unknown;
          } catch {
            return undefined;
          }
        })()
      : row.payload;
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    ts: new Date(row.ts).getTime(),
    due: row.due ? new Date(row.due).getTime() : undefined,
    urgency: row.urgency ?? 0,
    importance: row.importance ?? 0,
    title: row.title ?? undefined,
    preview: row.preview ?? undefined,
    payload,
  };
}

export type SyncState = "ready" | "error";

export type SyncStartResult = {
  state: SyncState;
  cleanup: () => void;
  error?: string;
};

export async function startDataSync(store: AtomStore): Promise<SyncStartResult> {
  try {
    await loadDictionary("heptapod_b_v1");
  } catch {
    // dictionary fallback handled in matcher unknown mode
  }

  let response: Response;
  try {
    response = await fetch(apiUrl("/api/atoms?limit=5000"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Local backend is unreachable.";
    return {
      state: "error",
      cleanup: () => {},
      error: message,
    };
  }

  if (!response.ok) {
    return {
      state: "error",
      cleanup: () => {},
      error: `Failed to load local atoms (${response.status}).`,
    };
  }

  const data = (await response.json()) as { atoms?: AtomRow[] };
  const rows = Array.isArray(data.atoms) ? data.atoms : [];
  store.upsertMany(rows.map(rowToAtom));
  store.initializeActiveMessageFromData(performance.now());

  let scheduled = false;
  const patchQueue = new Map<string, AtomPatch>();
  const removeQueue = new Set<string>();

  const flush = (): void => {
    scheduled = false;
    if (removeQueue.size) {
      for (const id of removeQueue) store.removeOne(id);
      removeQueue.clear();
    }
    if (patchQueue.size) {
      for (const patch of patchQueue.values()) store.patchOne(patch);
      patchQueue.clear();
    }
  };

  const scheduleFlush = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  };

  const events = new EventSource(apiUrl("/api/events"));
  const onInsert = (event: MessageEvent<string>) => {
    try {
      const row = JSON.parse(event.data) as AtomRow;
      store.upsertMany([rowToAtom(row)]);
      if (row.type === "message") {
        store.activateIncomingMessage(row.id, performance.now());
      }
    } catch {
      // ignore malformed payloads
    }
  };

  const onUpdate = (event: MessageEvent<string>) => {
    try {
      const row = JSON.parse(event.data) as AtomRow;
      patchQueue.set(row.id, {
        id: row.id,
        type: row.type,
        state: row.state,
        ts: new Date(row.ts).getTime(),
        due: row.due ? new Date(row.due).getTime() : undefined,
        urgency: row.urgency,
        importance: row.importance,
        title: row.title ?? undefined,
        preview: row.preview ?? undefined,
        payload: row.payload,
      });
      scheduleFlush();
    } catch {
      // ignore malformed payloads
    }
  };

  const onDelete = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { id: string };
      if (payload.id) {
        removeQueue.add(payload.id);
        scheduleFlush();
      }
    } catch {
      // ignore malformed payloads
    }
  };

  events.addEventListener("atom_insert", onInsert as EventListener);
  events.addEventListener("atom_update", onUpdate as EventListener);
  events.addEventListener("atom_delete", onDelete as EventListener);

  return {
    state: "ready",
    cleanup: () => {
      events.removeEventListener("atom_insert", onInsert as EventListener);
      events.removeEventListener("atom_update", onUpdate as EventListener);
      events.removeEventListener("atom_delete", onDelete as EventListener);
      events.close();
    },
  };
}
