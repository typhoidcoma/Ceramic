import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ATOM_STATES, ATOM_TYPES, type TimelineSortMode } from "../data/types";
import { startDataSync } from "../data/sync";
import { generateAndInsertIncomingMessage } from "../data/llm";
import { Renderer } from "../gpu/renderer";
import { AtomStore, buildSeededDemoAtoms, type QualityTierOverride } from "./store";

const store = new AtomStore();
type AppPhase = "syncing" | "ready";

function useStoreSnapshot() {
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getViewVersion(),
    () => store.getViewVersion(),
  );
  return useMemo(() => store.getSnapshot(), [version]);
}

function urgencyBand(atomUrgency: number, due?: number): string {
  if (due && due < Date.now()) return "overdue";
  if (atomUrgency > 0.8) return "high";
  if (atomUrgency > 0.55) return "medium";
  return "low";
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const snapshot = useStoreSnapshot();
  const [phase, setPhase] = useState<AppPhase>("syncing");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<TimelineSortMode>("recent");
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmStatus, setLlmStatus] = useState<string | null>(null);
  const [incomingPrompt, setIncomingPrompt] = useState("Summarize intent: we arrive with open hands.");

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | null = null;

    setPhase("syncing");
    setSyncError(null);

    void (async () => {
      const result = await startDataSync(store);
      if (!active) {
        result.cleanup();
        return;
      }
      cleanup = result.cleanup;
      setPhase("ready");
      if (result.state === "error") setSyncError(result.error ?? "Local sync failed.");
    })();

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target?.tagName !== "INPUT" && target?.tagName !== "TEXTAREA") {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && snapshot.visibleCount > 0) {
        const buckets = store.getTimelineBuckets(Date.now(), sortMode);
        const flattened = buckets.flatMap((bucket) => bucket.items.map((atom, index) => ({ id: atom.id, bucketKey: bucket.key, index })));
        const current = flattened.findIndex((entry) => entry.id === snapshot.selectedId);
        const nextIndex = event.key === "ArrowDown" ? Math.min(flattened.length - 1, Math.max(0, current) + 1) : Math.max(0, (current < 0 ? 0 : current) - 1);
        const next = flattened[nextIndex];
        if (next) {
          event.preventDefault();
          store.setSelectedByIndex(next.bucketKey, next.index);
        }
      }
      if (event.key === "Escape") {
        store.setSelected(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [snapshot.selectedId, snapshot.visibleCount, sortMode]);

  const timelineBuckets = useMemo(() => store.getTimelineBuckets(Date.now(), sortMode), [snapshot.visibleCount, snapshot.filters, sortMode]);
  const selected = useMemo(() => store.getSelectedAtom(), [snapshot.selectedId, snapshot.totalCount]);

  const onSeedDemo = () => {
    store.clear();
    store.upsertMany(buildSeededDemoAtoms(10000));
    rendererRef.current?.resetView();
  };

  const onGenerateLlmMessage = async () => {
    if (llmBusy) return;
    const prompt = incomingPrompt.trim();
    if (!prompt) {
      setLlmStatus("Enter a prompt first.");
      return;
    }
    setLlmBusy(true);
    setLlmStatus(null);
    try {
      const result = await generateAndInsertIncomingMessage(prompt);
      store.setPromptLatencyMs(result.latencyMs);
      if (result.ok) {
        setLlmStatus(`Inserted ${result.canonicalKey}: ${result.text}`);
      } else {
        setLlmStatus(result.error);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to generate message.";
      setLlmStatus(message);
    } finally {
      setLlmBusy(false);
    }
  };

  if (rendererError) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <h1>Renderer Error</h1>
          <p className="error">{rendererError}</p>
          <p className="muted">Try Chrome or Edge with WebGPU enabled, then reload.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="smoke-shell">
      <canvas ref={canvasRef} className="smoke-canvas" />

      <div className={`top-strip ${snapshot.overlayMinimized ? "min" : ""}`}>
        <div className="brand">Ceramic Arrival Field</div>
        {!snapshot.overlayMinimized && (
          <>
            <input
              ref={searchRef}
              className="search"
              placeholder="Search /"
              value={snapshot.filters.query}
              onChange={(event) => store.setQuery(event.target.value)}
            />
            <select className="select" value={sortMode} onChange={(event) => setSortMode(event.target.value as TimelineSortMode)}>
              <option value="recent">Recent</option>
              <option value="due">Due</option>
              <option value="importance">Importance</option>
            </select>
            <select
              className="select"
              value={snapshot.qualityTierOverride}
              onChange={(event) => store.setQualityTierOverride(event.target.value as QualityTierOverride)}
            >
              <option value="auto">Quality Auto</option>
              <option value="safe">Quality Safe</option>
              <option value="balanced">Quality Balanced</option>
              <option value="high">Quality High</option>
            </select>
            <button className="chip" onClick={onSeedDemo}>Seed demo</button>
            <button className="chip" onClick={() => store.setInspectorOpen(!snapshot.inspectorOpen)}>{snapshot.inspectorOpen ? "Hide inspector" : "Show inspector"}</button>
            <button className="chip" onClick={() => store.setShowDiagnostics(!snapshot.showDiagnostics)}>{snapshot.showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}</button>
            <input
              className="search"
              placeholder="Incoming Prompt"
              value={incomingPrompt}
              onChange={(event) => setIncomingPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void onGenerateLlmMessage();
                }
              }}
            />
            <button className="chip" disabled={llmBusy} onClick={onGenerateLlmMessage}>
              {llmBusy ? "Generating..." : "LLM message"}
            </button>
          </>
        )}
        <button className="chip" onClick={() => store.setOverlayMinimized(!snapshot.overlayMinimized)}>{snapshot.overlayMinimized ? "Expand" : "Minimize"}</button>
      </div>

      {!snapshot.overlayMinimized && (
        <div className="filter-strip">
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
            {ATOM_STATES.filter((state) => state !== "archived").map((state) => {
              const active = snapshot.filters.states.has(state);
              return (
                <button key={state} className={`chip ${active ? "active" : ""}`} onClick={() => store.toggleState(state)}>
                  {state}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {snapshot.inspectorOpen && (
        <aside className="inspector-drawer">
          <h2>Inspector</h2>
          {!selected && <p className="muted">Select a task halo from the field.</p>}
          {selected && (
            <>
              <div className="meta-grid">
                <span>ID</span><strong>{selected.id}</strong>
                <span>Type</span><strong>{selected.type}</strong>
                <span>State</span><strong>{selected.state}</strong>
                <span>Urgency</span><strong>{selected.urgency.toFixed(3)}</strong>
                <span>Importance</span><strong>{selected.importance.toFixed(3)}</strong>
                <span>Score</span><strong>{selected.score.toFixed(3)}</strong>
              </div>
              <h3>{selected.title ?? "Untitled"}</h3>
              <p className="muted">{selected.preview ?? "No preview"}</p>
              <pre>{JSON.stringify(selected.payload ?? {}, null, 2)}</pre>
            </>
          )}
          <div className="timeline-mini">
            {timelineBuckets.slice(0, 3).map((bucket) => (
              <div key={bucket.key} className="bucket">
                <h4>{bucket.label}</h4>
                {bucket.items.slice(0, 8).map((atom) => (
                  <button key={atom.id} className={`row ${snapshot.selectedId === atom.id ? "selected" : ""}`} onClick={() => store.setSelected(atom.id)}>
                    <span className={`band ${urgencyBand(atom.urgency, atom.due)}`}>{urgencyBand(atom.urgency, atom.due)}</span>
                    <span>{atom.title ?? atom.id}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>
      )}

      {snapshot.showDiagnostics && (
        <div className="diagnostics">
          <span>visible {snapshot.visibleCount.toLocaleString()}</span>
          <span>total {snapshot.totalCount.toLocaleString()}</span>
          <span>fps {snapshot.fps.toFixed(0)}</span>
          <span>points {snapshot.taskPointCount.toLocaleString()}</span>
          <span>
            active {snapshot.activeMessageAtomId ? snapshot.activeMessageAtomId.slice(0, 8) : "-"}
          </span>
          <span>blend {snapshot.activeMessageBlend.toFixed(2)}</span>
          <span>match {snapshot.activeMessageMatchSource}</span>
          <span>key {snapshot.activeMessageCanonicalKey ?? "-"}</span>
          <span>phrase {snapshot.activeMessageMatchedPhrase ?? "-"}</span>
          <span>latency {snapshot.promptLatencyMs ?? "-"}ms</span>
          <span>quality {snapshot.qualityTierOverride}</span>
          {phase === "syncing" && <span>syncing</span>}
          {syncError && <span className="error">sync error: {syncError}</span>}
          {llmStatus && <span>{llmStatus}</span>}
        </div>
      )}
    </div>
  );
}
