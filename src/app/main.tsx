import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { startDataSync } from "../data/sync";
import { generateAndInsertIncomingMessage } from "../data/llm";
import { Renderer } from "../gpu/renderer";
import { AtomStore } from "./store";

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

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const snapshot = useStoreSnapshot();
  const [phase, setPhase] = useState<AppPhase>("syncing");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
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
      if (result.ok && result.atom) {
        store.upsertAndActivateMessage(result.atom, performance.now());
      }
      setLlmStatus(result.ok ? `Inserted ${result.canonicalKey}` : result.error);
    } catch (error: unknown) {
      setLlmStatus(error instanceof Error ? error.message : "Failed to generate message.");
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

      <div className="top-strip">
        <div className="brand">Ceramic Arrival Field</div>
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
          {llmBusy ? "Generating..." : "Generate"}
        </button>
        <button className="chip" onClick={() => rendererRef.current?.resetView()}>Reset View</button>
      </div>

      <div className="diagnostics">
        <span>{phase === "syncing" ? "syncing" : "ready"}</span>
        <span>sse {snapshot.sseStatus}</span>
        <span>fps {snapshot.fps.toFixed(0)}</span>
        <span>points {snapshot.taskPointCount.toLocaleString()}</span>
        <span>zeroPointFrames {snapshot.zeroPointFrames}</span>
        <span>active {snapshot.activeMessageAtomId ? snapshot.activeMessageAtomId.slice(0, 8) : "-"}</span>
        <span>blend {snapshot.activeMessageBlend.toFixed(2)}</span>
        <span>sweep {snapshot.sweepProgress.toFixed(2)}</span>
        <span>continuity {snapshot.ringContinuityScore.toFixed(2)}</span>
        <span>bbox {snapshot.injectorBBoxArea.toFixed(3)}</span>
        <span>coverage {snapshot.ringCoverageRatio.toFixed(2)}</span>
        <span>bandOcc {snapshot.ringBandOccupancyRatio.toFixed(2)}</span>
        <span>void {snapshot.innerVoidRatio.toFixed(2)}</span>
        <span>voidPenalty {snapshot.innerVoidPenalty.toFixed(2)}</span>
        <span>centerMass {snapshot.centerMassRatio.toFixed(2)}</span>
        <span>ch r:{snapshot.logogramChannelCounts.ring} t:{snapshot.logogramChannelCounts.tendril} h:{snapshot.logogramChannelCounts.hook}</span>
        <span>maskPts r:{snapshot.maskPointCountRing} b:{snapshot.maskPointCountBlob} t:{snapshot.maskPointCountTendril}</span>
        <span>maskCont {snapshot.maskContinuityScore.toFixed(2)}</span>
        <span>maskArc [{snapshot.maskArcOccupancy12.join(",")} ]</span>
        <span>sectors(all) [{snapshot.sectorOccupancy.join(",")} ]</span>
        <span>sectors(ring) [{snapshot.ringSectorOccupancy.join(",")} ]</span>
        <span>solveE {snapshot.solveEnergy.toFixed(3)}</span>
        <span>solveParts m:{snapshot.solveBreakdown.eMask.toFixed(3)} c:{snapshot.solveBreakdown.eContinuity.toFixed(3)} g:{snapshot.solveBreakdown.eGap.toFixed(3)} t:{snapshot.solveBreakdown.eThickness.toFixed(3)} v:{snapshot.solveBreakdown.eVoid.toFixed(3)} r:{snapshot.solveBreakdown.eRadius.toFixed(3)} s:{snapshot.solveBreakdown.eSparsity.toFixed(3)}</span>
        <span>gaps {snapshot.gapCountSolved}</span>
        <span>violations {snapshot.constraintViolationCount}</span>
        <span>sigDist {snapshot.signatureDistanceToCanonical.toFixed(3)}</span>
        <span>texEntropy {snapshot.textureEntropy.toFixed(3)}</span>
        <span>radVar {snapshot.radialVariance.toFixed(5)}</span>
        <span>arcVar {snapshot.arcSpacingVariance.toFixed(5)}</span>
        <span>repeat {snapshot.repeatScore.toFixed(3)}</span>
        <span>bench off_by_plan</span>
        <span>fpsMin2s {snapshot.benchmarkFpsWindowMin.toFixed(1)}</span>
        <span>fpsGuard45 {snapshot.fpsGuardrailPass ? "pass" : "fail"}</span>
        <span>sig [{snapshot.shapeSignature.slice(0, 12).map((v) => v.toFixed(2)).join(",")} ]</span>
        <span>key {snapshot.activeMessageCanonicalKey ?? "-"}</span>
        <span>latency {snapshot.promptLatencyMs ?? "-"}ms</span>
        <span>lumaMean {snapshot.frameLumaMeanActual.toFixed(3)}</span>
        <span>lumaMax {snapshot.frameLumaMaxActual.toFixed(3)}</span>
        <span>bright&gt;.92 {(snapshot.brightPixelRatioActual * 100).toFixed(2)}%</span>
        <span>target {(snapshot.sweepProgress < 0.8) ? "warming" : (snapshot.constraintViolationCount === 0 && snapshot.ringCoverageRatio >= 0.72 && snapshot.ringBandOccupancyRatio >= 0.7 && snapshot.innerVoidRatio >= 0.35 && snapshot.centerMassRatio <= 0.22 && snapshot.brightPixelRatioActual <= 0.02) ? "pass" : "tune"}</span>
        {!snapshot.activeMessagePresent && <span className="error">warning: no active message</span>}
        {snapshot.activeMessagePresent && !snapshot.hasTaskPoints && <span className="error">warning: active message but zero points</span>}
        {snapshot.brightPixelRatioActual > 0.02 && <span className="error">warning: blowout risk</span>}
        {snapshot.sweepProgress >= 0.8 && snapshot.ringCoverageRatio < 0.72 && <span className="error">warning: ring coverage low</span>}
        {snapshot.sweepProgress >= 0.8 && snapshot.ringBandOccupancyRatio < 0.7 && <span className="error">warning: ring band occupancy low</span>}
        {snapshot.constraintViolationCount > 0 && <span className="error">warning: solver constraints violated</span>}
        {snapshot.innerVoidRatio < 0.35 && <span className="error">warning: inner void collapsed</span>}
        {snapshot.centerMassRatio > 0.22 && <span className="error">warning: center mass too high</span>}
        {snapshot.repeatScore > 0.24 && <span className="error">warning: texture repetition risk</span>}
        {syncError && <span className="error">sync error: {syncError}</span>}
        {llmStatus && <span>{llmStatus}</span>}
      </div>
    </div>
  );
}
