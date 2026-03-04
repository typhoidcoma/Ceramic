import type { RealtimeChannel } from "@supabase/supabase-js";
import type { AtomStore } from "../app/store";
import type { AtomPatch, AtomState, AtomType } from "./types";
import { loadDictionary } from "./logogramDictionary";
import { getSupabaseClient, hasSupabaseConfig } from "./supabase";

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
    payload: row.payload,
  };
}

export type SyncState = "signed_in" | "signed_out" | "error";

export type SyncStartResult = {
  state: SyncState;
  cleanup: () => void;
  error?: string;
};

export async function startDataSync(store: AtomStore): Promise<SyncStartResult> {
  if (!hasSupabaseConfig()) {
    return {
      state: "error",
      cleanup: () => {},
      error: "Missing Supabase environment values.",
    };
  }

  const supabase = getSupabaseClient();
  await loadDictionary("heptapod_b_v1");
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    return {
      state: "error",
      cleanup: () => {},
      error: userError.message,
    };
  }
  if (!user) {
    return {
      state: "signed_out",
      cleanup: () => {},
    };
  }

  const { data, error } = await supabase
    .from("atoms")
    .select("id, type, state, ts, due, urgency, importance, title, preview, payload")
    .neq("state", "archived")
    .order("ts", { ascending: false })
    .limit(5000);

  if (error) {
    return {
      state: "error",
      cleanup: () => {},
      error: error.message,
    };
  }
  if (data) {
    const rows = data as AtomRow[];
    store.upsertMany(rows.map(rowToAtom));
    store.initializeActiveMessageFromData(performance.now());
  }

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

  const channel: RealtimeChannel = supabase
    .channel("atoms-realtime")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "atoms",
        filter: `user_id=eq.${user.id}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          const oldRow = payload.old as { id: string };
          removeQueue.add(oldRow.id);
          scheduleFlush();
          return;
        }
        if (payload.eventType === "INSERT") {
          const row = payload.new as AtomRow;
          store.upsertMany([rowToAtom(row)]);
          if (row.type === "message") {
            store.activateIncomingMessage(row.id, performance.now());
          }
          return;
        }
        if (payload.eventType === "UPDATE") {
          const row = payload.new as AtomRow;
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
        }
      },
    )
    .subscribe();

  return {
    state: "signed_in",
    cleanup: () => {
      void supabase.removeChannel(channel);
    },
  };
}
