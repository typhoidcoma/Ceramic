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
    let active = true;
    void renderer.start().catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "Unknown renderer error.";
      setRendererError(message);
    });

    return () => {
      active = false;
      renderer.stop();
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
  };
  const isEmpty = phase === "signed_in_ready" && snapshot.visibleCount === 0;

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
