import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ATOM_STATES, ATOM_TYPES, type Atom, type TimelineSortMode } from "../data/types";
import { startDataSync } from "../data/sync";
import { Renderer } from "../gpu/renderer";
import { AuthGate } from "./auth/AuthGate";
import { useAuth } from "./auth/useAuth";
import { AtomStore, buildSeededDemoAtoms } from "./store";

const store = new AtomStore();
type AppPhase = "loading_session" | "signed_out" | "signed_in_syncing" | "signed_in_ready";

function useStoreSnapshot() {
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getViewVersion(),
    () => store.getViewVersion(),
  );
  return useMemo(() => store.getSnapshot(), [version]);
}

function maskText(value: string | undefined, maxDots = 14): string {
  if (!value || value.trim().length === 0) return "-";
  const dots = "•".repeat(Math.max(5, Math.min(maxDots, value.trim().length)));
  return `${dots} (${value.trim().length})`;
}

function urgencyBand(atom: Atom): string {
  if (atom.due && atom.due < Date.now()) return "overdue";
  if (atom.urgency > 0.8) return "high";
  if (atom.urgency > 0.55) return "medium";
  return "low";
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const edgeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const snapshot = useStoreSnapshot();
  const auth = useAuth();
  const [phase, setPhase] = useState<AppPhase>("loading_session");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<TimelineSortMode>("recent");
  const [density, setDensity] = useState<"compact" | "comfortable">("comfortable");
  const [rowLimit, setRowLimit] = useState(600);
  const isSignedInView = phase === "signed_in_syncing" || phase === "signed_in_ready";

  useEffect(() => {
    store.setLayoutMode("growth_tree");
    store.setFocusMode("selected");
  }, []);

  useEffect(() => {
    if (!isSignedInView) {
      setRendererError(null);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new Renderer(canvas, store, edgeCanvasRef.current, "neocortex");
    renderer.setRenderStyle("neocortex");
    renderer.setActivationSource("selection");
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
    rendererRef.current?.setAmbientFocus(snapshot.selectedId);
  }, [snapshot.selectedId]);

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

  const timelineBuckets = useMemo(() => store.getTimelineBuckets(Date.now(), sortMode), [snapshot.visibleCount, snapshot.filters, sortMode]);
  const visibleCount = useMemo(() => timelineBuckets.reduce((acc, bucket) => acc + bucket.items.length, 0), [timelineBuckets]);
  const displayBuckets = useMemo(() => {
    let remaining = rowLimit;
    const next = timelineBuckets
      .map((bucket) => {
        if (remaining <= 0) return { ...bucket, items: [] };
        const items = bucket.items.slice(0, remaining);
        remaining -= items.length;
        return { ...bucket, items };
      })
      .filter((bucket) => bucket.items.length > 0);
    return next;
  }, [timelineBuckets, rowLimit]);
  const renderedCount = useMemo(() => displayBuckets.reduce((acc, bucket) => acc + bucket.items.length, 0), [displayBuckets]);
  const hiddenCount = Math.max(0, visibleCount - renderedCount);
  const flattened = useMemo(
    () =>
      displayBuckets.flatMap((bucket) =>
        bucket.items.map((atom, index) => ({ id: atom.id, bucketKey: bucket.key, index })),
      ),
    [displayBuckets],
  );
  const selected = useMemo(() => store.getSelectedAtom(), [snapshot.selectedId, snapshot.totalCount]);
  const isEmpty = phase === "signed_in_ready" && snapshot.visibleCount === 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target?.tagName !== "INPUT" && target?.tagName !== "TEXTAREA") {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }
      if (event.key === "Escape") {
        store.setGlobalReveal(false);
        if (snapshot.selectedId) store.setAtomRevealed(snapshot.selectedId, false);
      }
      if (event.key === "Enter" && snapshot.selectedId) {
        store.setAtomRevealed(snapshot.selectedId, !store.isAtomRevealed(snapshot.selectedId));
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && flattened.length > 0) {
        event.preventDefault();
        const current = flattened.findIndex((entry) => entry.id === snapshot.selectedId);
        const nextIndex =
          event.key === "ArrowDown"
            ? Math.min(flattened.length - 1, Math.max(0, current) + 1)
            : Math.max(0, (current < 0 ? 0 : current) - 1);
        const next = flattened[nextIndex];
        if (next) store.setSelectedByIndex(next.bucketKey, next.index);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flattened, snapshot.selectedId]);

  const onSignOut = async () => {
    await auth.signOut();
  };

  const onSeedDemo = () => {
    store.clear();
    store.upsertMany(buildSeededDemoAtoms(10000));
    rendererRef.current?.resetView();
    setRowLimit(600);
  };

  const onToggleType = (type: (typeof ATOM_TYPES)[number]) => {
    store.toggleType(type);
  };

  const onToggleState = (state: (typeof ATOM_STATES)[number]) => {
    if (state === "archived") return;
    store.toggleState(state);
  };

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
          <p className="muted">Try Chrome or Edge with WebGPU enabled, then reload.</p>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-shell">
      <canvas ref={canvasRef} className="ambient-canvas" />
      <canvas ref={edgeCanvasRef} className="ambient-veins" />

      <div className="dashboard-top">
        <div className="top-title">
          <h1>Ceramic Cortex</h1>
          <span className="muted">{auth.user?.email ?? "unknown user"}</span>
        </div>
        <div className="top-stats">
          <span className="stat-pill">visible {snapshot.visibleCount.toLocaleString()}</span>
          <span className="stat-pill">total {snapshot.totalCount.toLocaleString()}</span>
          <span className="stat-pill">fps {snapshot.fps.toFixed(0)}</span>
          {phase === "signed_in_syncing" && <span className="stat-pill">syncing</span>}
          {syncError && <span className="stat-pill error">sync error</span>}
        </div>
        <div className="top-actions">
          <button className="tool-btn" onClick={onSeedDemo}>
            Seed demo
          </button>
          <button className="tool-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="workspace">
        <aside className="control-pane">
          <h2>Controls</h2>
          <input
            ref={searchRef}
            className="search"
            placeholder="Search /"
            value={snapshot.filters.query}
            onChange={(event) => store.setQuery(event.target.value)}
          />
          <div className="control-group">
            <label>Sort</label>
            <select className="select" value={sortMode} onChange={(event) => setSortMode(event.target.value as TimelineSortMode)}>
              <option value="recent">Recent</option>
              <option value="due">Due</option>
              <option value="importance">Importance</option>
            </select>
          </div>
          <div className="control-group">
            <label>Density</label>
            <select className="select" value={density} onChange={(event) => setDensity(event.target.value as "compact" | "comfortable")}>
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </div>
          <div className="control-group">
            <label>Privacy</label>
            <div className="chips">
              <button className={`chip ${snapshot.globalReveal ? "active" : ""}`} onClick={() => store.setGlobalReveal(!snapshot.globalReveal)}>
                Reveal all
              </button>
              <button
                className={`chip ${selected && store.isAtomRevealed(selected.id) ? "active" : ""}`}
                onClick={() => {
                  if (!selected) return;
                  store.setAtomRevealed(selected.id, !store.isAtomRevealed(selected.id));
                }}
              >
                Reveal selected
              </button>
            </div>
          </div>
          <div className="control-group">
            <label>Types</label>
            <div className="chips">
              {ATOM_TYPES.map((type) => {
                const active = snapshot.filters.types.has(type);
                return (
                  <button key={type} className={`chip ${active ? "active" : ""}`} onClick={() => onToggleType(type)}>
                    {type}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="control-group">
            <label>States</label>
            <div className="chips">
              {ATOM_STATES.filter((state) => state !== "archived").map((state) => {
                const active = snapshot.filters.states.has(state);
                return (
                  <button key={state} className={`chip ${active ? "active" : ""}`} onClick={() => onToggleState(state)}>
                    {state}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="timeline-pane">
          <div className="timeline-head">
            <h2>Timeline</h2>
            <span className="muted">
              {renderedCount.toLocaleString()} shown{hiddenCount > 0 ? `, ${hiddenCount.toLocaleString()} hidden` : ""}
            </span>
          </div>
          <div className={`timeline-list density-${density}`}>
            {isEmpty && (
              <div className="empty-card">
                <h3>No atoms yet</h3>
                <p className="muted">Seed demo data or sync records into `public.atoms`.</p>
                <button className="tool-btn" onClick={onSeedDemo}>
                  Seed 10k demo atoms
                </button>
              </div>
            )}
            {!isEmpty &&
              displayBuckets.map((bucket) => (
                <div key={bucket.key} className="bucket">
                  <h3>{bucket.label}</h3>
                  {bucket.items.map((atom) => {
                    const selectedRow = snapshot.selectedId === atom.id;
                    const revealed = snapshot.globalReveal || store.isAtomRevealed(atom.id) || selectedRow;
                    return (
                      <button
                        key={atom.id}
                        className={`timeline-row ${selectedRow ? "selected" : ""}`}
                        onClick={() => store.setSelected(atom.id)}
                        onMouseEnter={() => rendererRef.current?.setAmbientHover(atom.id)}
                        onMouseLeave={() => rendererRef.current?.setAmbientHover(null)}
                      >
                        <div className="row-meta">
                          <span className={`band ${urgencyBand(atom)}`}>{urgencyBand(atom)}</span>
                          <span>{atom.type}</span>
                          <span>{atom.state}</span>
                          <span>{new Date(atom.ts).toLocaleString()}</span>
                        </div>
                        <div className={`row-title ${revealed ? "revealed" : "masked"}`}>{revealed ? atom.title ?? "-" : maskText(atom.title)}</div>
                        <div className={`row-preview ${revealed ? "revealed" : "masked"}`}>
                          {revealed ? atom.preview ?? "-" : "Redacted preview"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
            {!isEmpty && hiddenCount > 0 && (
              <div className="load-more-wrap">
                <button className="tool-btn" onClick={() => setRowLimit((prev) => prev + 600)}>
                  Show more ({hiddenCount.toLocaleString()} hidden)
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="inspector-pane">
          <h2>Inspector</h2>
          {!selected && <p className="muted">Select a timeline row.</p>}
          {selected && (
            <>
              <dl>
                <dt>ID</dt>
                <dd>{selected.id}</dd>
                <dt>Type</dt>
                <dd>{selected.type}</dd>
                <dt>State</dt>
                <dd>{selected.state}</dd>
                <dt>Timestamp</dt>
                <dd>{new Date(selected.ts).toLocaleString()}</dd>
                <dt>Due</dt>
                <dd>{selected.due ? new Date(selected.due).toLocaleString() : "-"}</dd>
                <dt>Urgency</dt>
                <dd>{selected.urgency.toFixed(3)}</dd>
                <dt>Importance</dt>
                <dd>{selected.importance.toFixed(3)}</dd>
                <dt>Score</dt>
                <dd>{selected.score.toFixed(3)}</dd>
              </dl>
              <h3>Title</h3>
              <p>{selected.title ?? "-"}</p>
              <h3>Preview</h3>
              <p>{selected.preview ?? "-"}</p>
              <h3>Payload</h3>
              <pre>{JSON.stringify(selected.payload ?? {}, null, 2)}</pre>
            </>
          )}
          <div className="inspector-foot">
            {phase === "signed_in_syncing" && <span className="muted">Syncing...</span>}
            {syncError && <span className="error">Sync error: {syncError}</span>}
            <span className="muted">
              {snapshot.visibleCount.toLocaleString()} visible / {snapshot.totalCount.toLocaleString()} total
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
