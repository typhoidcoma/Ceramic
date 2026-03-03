import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ATOM_STATES, ATOM_TYPES } from "../data/types";
import type { LayoutMode } from "../layout/layout";
import { startDataSync } from "../data/sync";
import { Renderer } from "../gpu/renderer";
import { AuthGate } from "./auth/AuthGate";
import { useAuth } from "./auth/useAuth";
import { AtomStore, buildSeededDemoAtoms } from "./store";

const store = new AtomStore();
type AppPhase = "loading_session" | "signed_out" | "signed_in_syncing" | "signed_in_ready";
const LAYOUT_MODES: LayoutMode[] = ["score", "due", "type", "state"];
type OverlayPanel = { key: number; label: string; col: number; row: number };

function dueLabel(rank: number): string {
  if (rank === 0) return "Overdue";
  if (rank === 1) return "Due <24h";
  if (rank === 2) return "Due <7d";
  if (rank === 3) return "Due later";
  return "No due date";
}

function buildOverlayPanels(mode: LayoutMode): OverlayPanel[] {
  if (mode === "score") return [];
  const atoms = store.getVisibleAtoms();
  if (atoms.length === 0) return [];
  const now = Date.now();
  const ranks = new Set<number>();

  for (const atom of atoms) {
    if (mode === "type") {
      const idx = ATOM_TYPES.indexOf(atom.type);
      ranks.add(idx < 0 ? 999 : idx);
      continue;
    }
    if (mode === "state") {
      const order = ["new", "active", "snoozed", "done", "archived"];
      const idx = order.indexOf(atom.state);
      ranks.add(idx < 0 ? 999 : idx);
      continue;
    }
    const delta = (atom.due ?? Number.POSITIVE_INFINITY) - now;
    if (!Number.isFinite(delta)) ranks.add(4);
    else if (delta < 0) ranks.add(0);
    else if (delta < 24 * 60 * 60 * 1000) ranks.add(1);
    else if (delta < 7 * 24 * 60 * 60 * 1000) ranks.add(2);
    else ranks.add(3);
  }

  const sorted = [...ranks].sort((a, b) => a - b);
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  return sorted.map((rank, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const label =
      mode === "type" ? ATOM_TYPES[rank] ?? "other" : mode === "state" ? ["new", "active", "snoozed", "done", "archived"][rank] ?? "other" : dueLabel(rank);
    return { key: rank, label, col, row };
  });
}

function useStoreSnapshot() {
  const viewVersion = useSyncExternalStore(
    (cb) => store.subscribeView(cb),
    () => store.getViewVersion(),
    () => store.getViewVersion(),
  );
  return useMemo(() => store.getSnapshot(), [viewVersion]);
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const snapshot = useStoreSnapshot();
  const auth = useAuth();
  const [phase, setPhase] = useState<AppPhase>("loading_session");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const isSignedInView = phase === "signed_in_syncing" || phase === "signed_in_ready";

  useEffect(() => {
    if (!isSignedInView) {
      setRendererError(null);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new Renderer(canvas, store);
    rendererRef.current = renderer;
    let active = true;
    void renderer.start().catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "Unknown renderer error.";
      setRendererError(message);
    });

    return () => {
      active = false;
      renderer.stop();
      rendererRef.current = null;
    };
  }, [isSignedInView]);

  useEffect(() => {
    if (auth.loading) {
      setPhase("loading_session");
      return;
    }
    if (!auth.user) {
      setPhase("signed_out");
      setSyncError(null);
      store.clear();
      return;
    }

    setPhase("signed_in_syncing");
    setSyncError(null);
    let active = true;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const result = await startDataSync(store);
      if (!active) {
        result.cleanup();
        return;
      }
      cleanup = result.cleanup;
      if (result.state === "signed_in") {
        setPhase("signed_in_ready");
        return;
      }
      if (result.state === "signed_out") {
        setPhase("signed_out");
        store.clear();
        return;
      }
      setPhase("signed_in_ready");
      setSyncError(result.error ?? "Sync failed.");
    })();

    return () => {
      active = false;
      cleanup?.();
    };
  }, [auth.loading, auth.user?.id]);

  const selected = useMemo(() => store.getSelectedAtom(), [snapshot.selectedId, snapshot.totalCount]);
  const onSignOut = async () => {
    await auth.signOut();
  };
  const onSeedDemo = () => {
    store.clear();
    store.upsertMany(buildSeededDemoAtoms(10000));
    rendererRef.current?.resetView();
  };
  const onRecenter = () => {
    rendererRef.current?.resetView();
  };
  const isEmpty = phase === "signed_in_ready" && snapshot.visibleCount === 0;
  const overlayPanels = buildOverlayPanels(snapshot.layoutMode);
  const overlayCols = Math.max(1, Math.ceil(Math.sqrt(overlayPanels.length)));

  useEffect(() => {
    if (snapshot.layoutMode !== "score") {
      rendererRef.current?.resetView();
    }
  }, [snapshot.layoutMode]);

  if (phase === "loading_session") {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <h1>Ceramic</h1>
          <p className="muted">Loading session...</p>
        </div>
      </div>
    );
  }

  if (phase === "signed_out") {
    return <AuthGate auth={auth} />;
  }

  if (rendererError) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <h1>Renderer Error</h1>
          <p className="error">{rendererError}</p>
          <p className="muted">
            Try Chrome or Edge with WebGPU enabled, then reload. You can also sign out and retry the session.
          </p>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="top-bar">
        <div className="session">
          <span>{auth.user?.email ?? "unknown user"}</span>
          <button className="chip" onClick={onSignOut}>
            Sign out
          </button>
          <button className="chip" onClick={onSeedDemo}>
            Seed 10k demo
          </button>
          <button className="chip" onClick={onRecenter}>
            Recenter
          </button>
        </div>
        <div className="chips">
          {LAYOUT_MODES.map((mode) => {
            const active = snapshot.layoutMode === mode;
            return (
              <button key={mode} className={`chip ${active ? "active" : ""}`} onClick={() => store.setLayoutMode(mode)}>
                {mode}
              </button>
            );
          })}
        </div>
        <div className="chips">
          {ATOM_TYPES.map((type) => {
            const active = snapshot.filters.types.has(type);
            return (
              <button key={type} className={`chip ${active ? "active" : ""}`} onClick={() => store.toggleType(type)}>
                {type}
              </button>
            );
          })}
        </div>
        <div className="chips">
          {ATOM_STATES
            .filter((state) => state !== "archived")
            .map((state) => {
              const active = snapshot.filters.states.has(state);
              return (
                <button key={state} className={`chip ${active ? "active" : ""}`} onClick={() => store.toggleState(state)}>
                  {state}
                </button>
              );
            })}
        </div>
        <input
          className="search"
          placeholder="Search title, preview, id"
          value={snapshot.filters.query}
          onChange={(event) => store.setQuery(event.target.value)}
        />
        {phase === "signed_in_syncing" && <span className="status">Syncing...</span>}
        {syncError && <span className="status error">Sync error: {syncError}</span>}
        <span className="status">phase: {phase}</span>
      </div>

      <canvas ref={canvasRef} className="grid-canvas" />
      {overlayPanels.length > 1 && (
        <div className="group-overlay" style={{ gridTemplateColumns: `repeat(${overlayCols}, 1fr)` }}>
          {overlayPanels.map((panel) => (
            <div key={panel.key} className="group-panel">
              <span className="group-tag">{panel.label}</span>
            </div>
          ))}
        </div>
      )}
      {isEmpty && (
        <div className="empty-state">
          <h2>No atoms yet</h2>
          <p className="muted">
            Your sync is active, but there is no visible data. Seed demo atoms or insert rows into `public.atoms`.
          </p>
          <button className="chip" onClick={onSeedDemo}>
            Seed 10k demo
          </button>
        </div>
      )}

      <aside className="inspector">
        <h2>Inspector</h2>
        {!selected && <p className="muted">Select a tile.</p>}
        {selected && (
          <>
            <dl>
              <dt>ID</dt>
              <dd>{selected.id}</dd>
              <dt>Type</dt>
              <dd>{selected.type}</dd>
              <dt>State</dt>
              <dd>{selected.state}</dd>
              <dt>Urgency</dt>
              <dd>{selected.urgency.toFixed(3)}</dd>
              <dt>Importance</dt>
              <dd>{selected.importance.toFixed(3)}</dd>
              <dt>Score</dt>
              <dd>{selected.score.toFixed(3)}</dd>
              <dt>Timestamp</dt>
              <dd>{new Date(selected.ts).toLocaleString()}</dd>
              <dt>Due</dt>
              <dd>{selected.due ? new Date(selected.due).toLocaleString() : "-"}</dd>
            </dl>
            <h3>Title</h3>
            <p>{selected.title ?? "-"}</p>
            <h3>Preview</h3>
            <p>{selected.preview ?? "-"}</p>
          </>
        )}
      </aside>

      <div className="debug">
        <div>fps: {snapshot.fps.toFixed(1)}</div>
        <div>tiles: {snapshot.visibleCount.toLocaleString()} / {snapshot.totalCount.toLocaleString()}</div>
        <div>hovered: {snapshot.hoveredId ?? "-"}</div>
      </div>
    </div>
  );
}
