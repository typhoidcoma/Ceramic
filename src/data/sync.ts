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

type EventPayloadDelete = { id: string };

function payloadDigest(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? null);
  } catch {
    return String(payload);
  }
}

function rowFingerprint(row: AtomRow): string {
  return [
    row.id,
    row.type,
    row.state,
    row.ts,
    row.due ?? "",
    Number(row.urgency ?? 0).toFixed(6),
    Number(row.importance ?? 0).toFixed(6),
    row.title ?? "",
    row.preview ?? "",
    payloadDigest(row.payload),
  ].join("|");
}

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

async function fetchAtoms(limit = 5000): Promise<AtomRow[]> {
  const response = await fetch(apiUrl(`/api/atoms?limit=${limit}`));
  if (!response.ok) {
    throw new Error(`Failed to load local atoms (${response.status}).`);
  }
  const data = (await response.json()) as { atoms?: AtomRow[] };
  return Array.isArray(data.atoms) ? data.atoms : [];
}

export async function startDataSync(store: AtomStore): Promise<SyncStartResult> {
  try {
    await loadDictionary("heptapod_b_v1");
  } catch {
    // dictionary fallback handled in matcher unknown mode
  }

  let rows: AtomRow[];
  try {
    rows = await fetchAtoms(5000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Local backend is unreachable.";
    return { state: "error", cleanup: () => {}, error: message };
  }

  store.upsertMany(rows.map(rowToAtom));
  store.initializeActiveMessageFromData(performance.now());

  const fingerprints = new Map<string, string>();
  for (const row of rows) fingerprints.set(row.id, rowFingerprint(row));

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

  let disposed = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let watchdogTimer: number | null = null;
  let currentEvents: EventSource | null = null;
  let lastEventAtMs = Date.now();
  store.setSseStatus("connecting");
  store.setLastEventAtMs(lastEventAtMs);

  const markEvent = () => {
    lastEventAtMs = Date.now();
    store.setLastEventAtMs(lastEventAtMs);
  };

  const backfill = async () => {
    try {
      const latest = await fetchAtoms(5000);
      store.upsertMany(latest.map(rowToAtom));
      const active = store.getActiveMessageState().activeMessageAtomId;
      if (!active) store.initializeActiveMessageFromData(performance.now());
      for (const row of latest) fingerprints.set(row.id, rowFingerprint(row));
    } catch {
      // ignore transient backfill errors
    }
  };

  const openSse = () => {
    if (disposed) return;
    if (currentEvents) {
      currentEvents.close();
      currentEvents = null;
    }
    store.setSseStatus("connecting");
    const events = new EventSource(apiUrl("/api/events"));
    currentEvents = events;

    events.onopen = () => {
      reconnectAttempt = 0;
      store.setSseStatus("open");
      markEvent();
    };

    const onInsert = (event: MessageEvent<string>) => {
      try {
        const row = JSON.parse(event.data) as AtomRow;
        const nextFingerprint = rowFingerprint(row);
        const prevFingerprint = fingerprints.get(row.id);
        markEvent();
        if (prevFingerprint === nextFingerprint) return;
        const atom = rowToAtom(row);
        if (!prevFingerprint) {
          store.upsertMany([atom]);
          if (row.type === "message") store.activateIncomingMessage(row.id, performance.now());
        } else {
          patchQueue.set(row.id, {
            id: atom.id,
            type: atom.type,
            state: atom.state,
            ts: atom.ts,
            due: atom.due,
            urgency: atom.urgency,
            importance: atom.importance,
            title: atom.title,
            preview: atom.preview,
            payload: atom.payload,
          });
          scheduleFlush();
        }
        fingerprints.set(row.id, nextFingerprint);
      } catch {
        // ignore malformed payloads
      }
    };

    const onUpdate = (event: MessageEvent<string>) => {
      try {
        const row = JSON.parse(event.data) as AtomRow;
        const nextFingerprint = rowFingerprint(row);
        if (fingerprints.get(row.id) === nextFingerprint) return;
        const atom = rowToAtom(row);
        patchQueue.set(row.id, {
          id: atom.id,
          type: atom.type,
          state: atom.state,
          ts: atom.ts,
          due: atom.due,
          urgency: atom.urgency,
          importance: atom.importance,
          title: atom.title,
          preview: atom.preview,
          payload: atom.payload,
        });
        fingerprints.set(row.id, nextFingerprint);
        markEvent();
        scheduleFlush();
      } catch {
        // ignore malformed payloads
      }
    };

    const onDelete = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as EventPayloadDelete;
        if (payload.id) {
          removeQueue.add(payload.id);
          fingerprints.delete(payload.id);
          markEvent();
          scheduleFlush();
        }
      } catch {
        // ignore malformed payloads
      }
    };

    const onHeartbeat = () => {
      markEvent();
    };

    events.addEventListener("atom_insert", onInsert as EventListener);
    events.addEventListener("atom_update", onUpdate as EventListener);
    events.addEventListener("atom_delete", onDelete as EventListener);
    events.addEventListener("heartbeat", onHeartbeat as EventListener);

    events.onerror = () => {
      if (disposed) return;
      store.setSseStatus("stale");
      events.close();
      currentEvents = null;
      const delay = Math.min(10000, 1000 * Math.pow(2, reconnectAttempt));
      reconnectAttempt += 1;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void backfill().then(() => openSse());
      }, delay);
    };
  };

  openSse();

  watchdogTimer = window.setInterval(() => {
    if (disposed) return;
    const age = Date.now() - lastEventAtMs;
    if (age > 20000) {
      store.setSseStatus("stale");
      void backfill();
    }
  }, 5000);

  return {
    state: "ready",
    cleanup: () => {
      disposed = true;
      store.setSseStatus("closed");
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (watchdogTimer !== null) window.clearInterval(watchdogTimer);
      currentEvents?.close();
      currentEvents = null;
    },
  };
}
