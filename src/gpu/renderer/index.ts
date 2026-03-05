import type { Atom } from "../../data/types";
import type { AtomStore } from "../../app/store";
import { createTaskBuffer, createUniformBuffer, writeTaskPoints, writeUniforms, type RendererConfig, type TaskPoint } from "../buffers";
import { initWebGpu } from "../gpu";
import { createPipelineBundle } from "../pipeline";
import { BASE_TILE_SIZE, INK_FLUID_PROFILE, QUALITY_PRESETS, type QualityTier } from "../sim/constants";
import { createSimulationSystem, drawVolume, runSimulationStep, type SimulationSystem } from "../sim/system";
import { buildTaskFieldPointsSingleActive, getLastTaskFieldMatchMeta, getLastTaskFieldStats } from "../scene/taskField";
import { createCamera3D, projectAtomToScreen, tickCamera, type Camera3DState } from "../scene/camera3d";
import { LumaReadback } from "../sim/passes/lumaReadback";
import { BenchmarkRuntime } from "../../benchmark/runtime";
import { BENCH_TARGET_FPS } from "../sim/constants";
import type { BenchmarkMode } from "../../data/types";

const LOGOGRAM_V2_MASK_PIPELINE = (import.meta.env.VITE_LOGOGRAM_V2_MASK_PIPELINE ?? "1") !== "0";

const DEFAULT_CONFIG: RendererConfig = {
  qualityTier: "auto",
  simResolutionScale: QUALITY_PRESETS.balanced.simResolutionScale,
  pressureIterations: QUALITY_PRESETS.balanced.pressureIterations,
  fogDensity: INK_FLUID_PROFILE.fogDensity,
  contrast: INK_FLUID_PROFILE.contrast,
  grainAmount: INK_FLUID_PROFILE.grainAmount,
  fogBaseLuma: INK_FLUID_PROFILE.fogBaseLuma,
  pigmentAbsorption: INK_FLUID_PROFILE.pigmentAbsorption,
  carrierScattering: INK_FLUID_PROFILE.carrierScattering,
  inkRetention: INK_FLUID_PROFILE.inkRetention,
  compositeMode: INK_FLUID_PROFILE.compositeMode,
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function estimateLumaMetrics(points: TaskPoint[], config: RendererConfig): { inkFieldMean: number; inkFieldMax: number; brightPixelRatio: number; lumaHistogram: number[] } {
  if (points.length === 0) return { inkFieldMean: 0, inkFieldMax: 0, brightPixelRatio: 0, lumaHistogram: [0, 0, 0, 0, 0, 0, 0, 0] };
  let sumInk = 0;
  let maxInk = 0;
  let bright = 0;
  const hist = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const energy = clamp01((p.ink * 0.62 + p.coherence * 0.38) * (0.55 + p.radius * 12));
    sumInk += energy;
    maxInk = Math.max(maxInk, energy);
    const l = clamp01(config.fogBaseLuma * Math.exp(-energy * config.pigmentAbsorption));
    const bucket = Math.min(hist.length - 1, Math.floor(l * hist.length));
    hist[bucket] += 1;
    if (l > 0.92) bright += 1;
  }
  const count = points.length;
  return {
    inkFieldMean: sumInk / count,
    inkFieldMax: maxInk,
    brightPixelRatio: bright / count,
    lumaHistogram: hist.map((v) => v / count),
  };
}

function buildSimMaskFields(points: TaskPoint[], simWidth: number, simHeight: number): { ring: Float32Array; blob: Float32Array; tendril: Float32Array; flow: Float32Array } {
  const cellCount = Math.max(1, simWidth * simHeight);
  const ring = new Float32Array(cellCount);
  const blob = new Float32Array(cellCount);
  const tendril = new Float32Array(cellCount);
  const flow = new Float32Array(cellCount * 2);
  for (const p of points) {
    const x = Math.max(0, Math.min(simWidth - 1, Math.floor(p.nx * simWidth)));
    const y = Math.max(0, Math.min(simHeight - 1, Math.floor(p.ny * simHeight)));
    const i = y * simWidth + x;
    const coherence = clamp01(p.coherence);
    const ink = clamp01(p.ink);
    const ringW = coherence * (0.55 + 0.45 * ink);
    const blobW = Math.max(0, ink - coherence * 0.55);
    const tendrilW = Math.max(0, coherence * 0.8 - ink * 0.35);
    ring[i] += ringW;
    blob[i] += blobW;
    tendril[i] += tendrilW;
    flow[i * 2] += p.dirX * (0.4 + ink * 0.6);
    flow[i * 2 + 1] += p.dirY * (0.4 + ink * 0.6);
  }
  return { ring, blob, tendril, flow };
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private store: AtomStore;
  private started = false;
  private raf = 0;
  private now = performance.now();
  private frameCount = 0;
  private fpsWindowStart = performance.now();
  private gpu: Awaited<ReturnType<typeof initWebGpu>> | null = null;
  private pipelines: ReturnType<typeof createPipelineBundle> | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private taskBuffer: GPUBuffer | null = null;
  private simulation: SimulationSystem | null = null;
  private camera: Camera3DState = createCamera3D();
  private config: RendererConfig = { ...DEFAULT_CONFIG };
  private activeTier: QualityTier = "balanced";
  private qualityDownTicks = 0;
  private qualityUpTicks = 0;
  private pointer = { x: 0, y: 0 };
  private lumaReadback: LumaReadback | null = null;
  private lumaReadbackCounter = 0;
  private benchmarkRuntime = new BenchmarkRuntime();
  private benchmarkCounter = 0;
  private benchmarkMode: BenchmarkMode = "disabled_by_plan";
  private freezeToken: number | null = null;
  private freezeForAtomId: string | null = null;
  private maskPipelineEnabled = LOGOGRAM_V2_MASK_PIPELINE;
  private lastFrameLumaMeanActual: number | null = null;
  private bgDarkDriftRate = 0;

  constructor(canvas: HTMLCanvasElement, store: AtomStore, initial?: Partial<RendererConfig>) {
    this.canvas = canvas;
    this.store = store;
    if (initial) this.config = { ...this.config, ...initial };
  }

  setConfig(partial: Partial<RendererConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.gpu = await initWebGpu(this.canvas);
    this.pipelines = createPipelineBundle(this.gpu.device, this.gpu.format);
    this.uniformBuffer = createUniformBuffer(this.gpu.device);
    this.taskBuffer = createTaskBuffer(this.gpu.device);
    this.lumaReadback = new LumaReadback(this.gpu.device);
    this.resize();
    this.rebuildSimulation();
    this.attachInputHandlers();
    this.now = performance.now();
    this.frame();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    cancelAnimationFrame(this.raf);
  }

  resetView(): void {
    this.camera = createCamera3D();
    this.store.markLayoutDirty();
  }

  setMaskPipelineEnabled(next: boolean): void {
    this.maskPipelineEnabled = !!next;
  }

  getMaskPipelineEnabled(): boolean {
    return this.maskPipelineEnabled;
  }

  private rebuildSimulation(): void {
    if (!this.gpu || !this.pipelines || !this.uniformBuffer || !this.taskBuffer) return;
    this.simulation = createSimulationSystem(
      this.gpu.device,
      this.pipelines,
      this.uniformBuffer,
      this.taskBuffer,
      this.canvas.width,
      this.canvas.height,
      this.activeTier,
      this.config.simResolutionScale,
    );
  }

  private frame = (): void => {
    if (!this.started) return;
    if (!this.gpu || !this.pipelines || !this.uniformBuffer || !this.taskBuffer) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    if (!this.simulation) {
      this.rebuildSimulation();
      this.raf = requestAnimationFrame(this.frame);
      return;
    }

    try {
      const t = performance.now();
      const dtSec = Math.min(0.1, (t - this.now) / 1000);
      this.now = t;

      const resized = this.resize();
      if (resized) this.rebuildSimulation();
      if (!this.simulation) {
        this.raf = requestAnimationFrame(this.frame);
        return;
      }

    if (this.store.needsLayout()) {
      this.store.recalcLayout(this.canvas.width, this.canvas.height, BASE_TILE_SIZE);
    }

    this.store.tickPositions(dtSec);
    const activeState = this.store.syncActiveMessageBlend(t);
    tickCamera(this.camera, dtSec);

    const snapshot = this.store.getSnapshot();
    const allAtoms = this.store.getAtoms();
    const visibleAtoms = this.store.getVisibleAtoms();
    if (this.benchmarkMode === "frozen_eval") {
      if (this.freezeForAtomId !== activeState.activeMessageAtomId) {
        this.freezeForAtomId = activeState.activeMessageAtomId;
        this.freezeToken = Math.floor(t);
      }
    } else {
      this.freezeForAtomId = null;
      this.freezeToken = null;
    }
    const points = buildTaskFieldPointsSingleActive(
      allAtoms,
      activeState,
      snapshot.selectedId,
      snapshot.hoveredId,
      t,
      this.benchmarkMode,
      this.freezeToken,
    );
    const taskCount = writeTaskPoints(this.gpu.device, this.taskBuffer, points);
    this.store.setTaskPointCount(taskCount);
    if (this.maskPipelineEnabled) {
      const masks = buildSimMaskFields(points, this.simulation.resources.simWidth, this.simulation.resources.simHeight);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskRing, 0, masks.ring.buffer);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskBlob, 0, masks.blob.buffer);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskTendril, 0, masks.tendril.buffer);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskFlow, 0, masks.flow.buffer);
    } else {
      const zerosScalar = new Float32Array(this.simulation.resources.cellCount);
      const zerosVec2 = new Float32Array(this.simulation.resources.cellCount * 2);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskRing, 0, zerosScalar.buffer);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskBlob, 0, zerosScalar.buffer);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskTendril, 0, zerosScalar.buffer);
      this.gpu.device.queue.writeBuffer(this.simulation.resources.maskFlow, 0, zerosVec2.buffer);
    }
    const estimatedLuma = estimateLumaMetrics(points, this.config);
    this.store.setLumaMetrics(estimatedLuma);
    const frameLumaMeanActual = estimatedLuma.inkFieldMean > 0 ? Math.max(0, Math.min(1, this.config.fogBaseLuma * Math.exp(-estimatedLuma.inkFieldMean * this.config.pigmentAbsorption * 0.8))) : this.config.fogBaseLuma;
    if (this.lastFrameLumaMeanActual !== null) {
      const darkDelta = this.lastFrameLumaMeanActual - frameLumaMeanActual;
      this.bgDarkDriftRate = this.bgDarkDriftRate * 0.9 + darkDelta * 0.1;
    }
    this.lastFrameLumaMeanActual = frameLumaMeanActual;
    this.store.setLumaMetricsActual({
      frameLumaMeanActual,
      frameLumaMaxActual: estimatedLuma.inkFieldMax > 0 ? Math.max(0, Math.min(1, this.config.fogBaseLuma * Math.exp(-estimatedLuma.inkFieldMax * this.config.pigmentAbsorption * 0.75))) : this.config.fogBaseLuma,
      brightPixelRatioActual: estimatedLuma.brightPixelRatio,
      frameLumaHistogramActual: estimatedLuma.lumaHistogram,
    });
    const matchMeta = getLastTaskFieldMatchMeta();
    this.store.setActiveMessageMatchMeta(matchMeta.source, matchMeta.matchedPhrase, matchMeta.canonicalKey);
    const taskStats = getLastTaskFieldStats();
    this.store.setLogogramDiagnostics({ ...taskStats, bgDarkDriftRate: this.bgDarkDriftRate });
    if (this.benchmarkCounter % 10 === 0) {
      void this.benchmarkRuntime
        .tick({
          nowMs: t,
          benchmarkMode: this.benchmarkMode,
          freezeToken: this.freezeToken,
          canonicalKey: matchMeta.canonicalKey,
          sweepProgress: taskStats.sweepProgress,
          fps: dtSec > 0 ? 1 / dtSec : 0,
          taskStats: {
            ringCoverageRatio: taskStats.ringCoverageRatio,
            ringSectorOccupancy: taskStats.ringSectorOccupancy,
            sectorOccupancy: taskStats.sectorOccupancy,
            ringBandOccupancyRatio: taskStats.ringBandOccupancyRatio,
            innerVoidPenalty: taskStats.innerVoidPenalty,
            logogramChannelCounts: taskStats.channelCounts,
            generatedRadialProfile: taskStats.generatedRadialProfile,
            generatedAngularHistogram12: taskStats.generatedAngularHistogram12,
            generatedGapCount: taskStats.generatedGapCount,
            generatedFrayDensity: taskStats.generatedFrayDensity,
            generatedStrokeWidthMean: taskStats.generatedStrokeWidthMean,
            generatedStrokeWidthVar: taskStats.generatedStrokeWidthVar,
          },
        })
        .then((bench) => {
          this.store.setBenchmarkDiagnostics({
            enabled: bench.enabled,
            mode: this.benchmarkMode,
            sampleId: bench.result?.sampleId ?? null,
            candidateSetId: bench.result?.candidateSetId ?? bench.candidateSetId,
            scoreTotal: bench.result?.distance.total ?? 0,
            scoreStdDev: bench.result?.stabilityStdDev ?? bench.stabilityStdDev,
            pass: bench.result?.pass ?? false,
            overallPass: bench.result?.overallPass ?? bench.overallPass,
            fpsWindowMin: bench.result?.fpsWindowMin ?? bench.fpsWindowMin,
            distance: bench.result?.distance ?? { radial: 0, angular: 0, gaps: 0, fray: 0, width: 0, total: 0 },
            fpsGuardrailPass: bench.fpsGuardrailPass,
          });
        });
    }
    this.benchmarkCounter += 1;

    const selected = this.store.getSelectedAtom();
    const hovered = this.store.getHoveredAtom();

    const selectedNorm = selected ? this.projectNorm(selected) : { x: 0.5, y: 0.5 };
    const hoveredNorm = hovered ? this.projectNorm(hovered) : { x: 0.5, y: 0.5 };

    const override = snapshot.qualityTierOverride;
    const targetTier: QualityTier = override === "auto" ? this.activeTier : override;
    const preset = QUALITY_PRESETS[targetTier];
    const pressureIterations = this.config.qualityTier === "auto" ? this.simulation.pressureIterations : this.config.pressureIterations;

    writeUniforms(this.gpu.device, this.uniformBuffer, {
      simWidth: this.simulation.resources.simWidth,
      simHeight: this.simulation.resources.simHeight,
      viewportWidth: this.canvas.width,
      viewportHeight: this.canvas.height,
      nowSec: t / 1000,
      dtSec,
      fogDensity: this.config.fogDensity,
      contrast: this.config.contrast,
      grainAmount: this.config.grainAmount,
      taskCount,
      selectedX: selectedNorm.x,
      selectedY: selectedNorm.y,
      hoveredX: hoveredNorm.x,
      hoveredY: hoveredNorm.y,
      compositeSamples: preset.compositeSamples,
      fogBaseLuma: this.config.fogBaseLuma,
      pigmentAbsorption: this.config.pigmentAbsorption,
      carrierScattering: this.config.carrierScattering,
      inkRetention: this.config.inkRetention,
    });

    const encoder = this.gpu.device.createCommandEncoder();
    runSimulationStep(encoder, this.simulation, this.pipelines, pressureIterations);
    const currentTexture = this.gpu.context.getCurrentTexture();
    drawVolume(encoder, currentTexture.createView(), this.simulation, this.pipelines);
    const shouldReadLuma = this.lumaReadbackCounter % 10 === 0;
    if (shouldReadLuma && this.lumaReadback) {
      this.lumaReadback.enqueueCopy(encoder, currentTexture, this.canvas.width, this.canvas.height);
    }
    this.gpu.device.queue.submit([encoder.finish()]);
    if (shouldReadLuma && this.lumaReadback) {
      void this.lumaReadback.readMetrics().then((metrics) => {
        if (!metrics) return;
        this.store.setLumaMetricsActual(metrics);
      });
    }
    this.lumaReadbackCounter += 1;

    this.updateHoverFromPointer(visibleAtoms);

    const instantFps = dtSec > 0 ? 1 / dtSec : 0;
    if (Number.isFinite(instantFps) && instantFps > 0) {
      this.store.setFps(instantFps);
    }

    this.frameCount += 1;
    const elapsed = t - this.fpsWindowStart;
    if (elapsed >= 500) {
      const fps = (this.frameCount * 1000) / elapsed;
      this.store.setFps(fps);
      this.adjustQuality(fps, snapshot.qualityTierOverride);
      this.frameCount = 0;
      this.fpsWindowStart = t;
    }

    } catch (error) {
      console.error("[renderer-frame] unrecovered frame error", error);
    }

    this.raf = requestAnimationFrame(this.frame);
  };

  private adjustQuality(fps: number, override: "auto" | "safe" | "balanced" | "high"): void {
    if (override !== "auto") return;
    const rank = (tier: QualityTier) => (tier === "safe" ? 1 : tier === "balanced" ? 2 : 3);
    const fromRank = rank(this.activeTier);
    const down = fps < BENCH_TARGET_FPS;
    const up = fps > BENCH_TARGET_FPS + 2;

    if (down) {
      this.qualityDownTicks += 1;
      this.qualityUpTicks = 0;
      if (this.qualityDownTicks >= 2 && fromRank > 1) {
        this.activeTier = fromRank === 3 ? "balanced" : "safe";
        this.qualityDownTicks = 0;
        this.rebuildSimulation();
      }
      return;
    }

    if (up) {
      this.qualityUpTicks += 1;
      this.qualityDownTicks = 0;
      if (this.qualityUpTicks >= 10 && fromRank < 3) {
        this.activeTier = fromRank === 1 ? "balanced" : "high";
        this.qualityUpTicks = 0;
        this.rebuildSimulation();
      }
      return;
    }

    this.qualityDownTicks = 0;
    this.qualityUpTicks = 0;
  }

  private projectNorm(atom: Atom): { x: number; y: number } {
    const projected = projectAtomToScreen(atom, this.canvas.width, this.canvas.height, this.camera);
    if (!projected) return { x: 0.5, y: 0.5 };
    return {
      x: Math.max(0, Math.min(1, projected.x / this.canvas.width)),
      y: Math.max(0, Math.min(1, projected.y / this.canvas.height)),
    };
  }

  private updateHoverFromPointer(atoms: Atom[]): void {
    let best: Atom | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (const atom of atoms) {
      const p = projectAtomToScreen(atom, this.canvas.width, this.canvas.height, this.camera);
      if (!p) continue;
      const dx = this.pointer.x - p.x;
      const dy = this.pointer.y - p.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= p.r * p.r && distSq < bestDistSq) {
        best = atom;
        bestDistSq = distSq;
      }
    }
    this.store.setHover(best?.id ?? null);
  }

  private resize(): boolean {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    const changed = this.canvas.width !== width || this.canvas.height !== height;
    if (changed) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.store.markLayoutDirty();
    }
    return changed;
  }

  private attachInputHandlers(): void {
    window.addEventListener("resize", () => this.store.markLayoutDirty());
    this.canvas.addEventListener("pointermove", (event) => {
      this.pointer.x = event.offsetX * (window.devicePixelRatio || 1);
      this.pointer.y = event.offsetY * (window.devicePixelRatio || 1);
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.store.setHover(null);
    });
    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const atoms = this.store.getVisibleAtoms();
      let selected: Atom | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const atom of atoms) {
        const p = projectAtomToScreen(atom, this.canvas.width, this.canvas.height, this.camera);
        if (!p) continue;
        const dx = this.pointer.x - p.x;
        const dy = this.pointer.y - p.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= p.r * p.r && distSq < best) {
          selected = atom;
          best = distSq;
        }
      }
      this.store.setSelected(selected?.id ?? null);
    });
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const factor = Math.exp(event.deltaY * 0.0011);
        this.camera.distance = Math.max(180, Math.min(2200, this.camera.distance * factor));
      },
      { passive: false },
    );
    this.canvas.addEventListener("dblclick", () => this.resetView());
  }
}
