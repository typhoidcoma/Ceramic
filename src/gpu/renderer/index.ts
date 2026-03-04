import type { Atom } from "../../data/types";
import type { AtomStore } from "../../app/store";
import { createTaskBuffer, createUniformBuffer, writeTaskPoints, writeUniforms, type RendererConfig } from "../buffers";
import { initWebGpu } from "../gpu";
import { createPipelineBundle } from "../pipeline";
import { BASE_TILE_SIZE, QUALITY_PRESETS, type QualityTier } from "../sim/constants";
import { createSimulationSystem, drawVolume, runSimulationStep, type SimulationSystem } from "../sim/system";
import { buildTaskFieldPointsSingleActive, getLastTaskFieldMatchMeta } from "../scene/taskField";
import { createCamera3D, projectAtomToScreen, tickCamera, type Camera3DState } from "../scene/camera3d";

const DEFAULT_CONFIG: RendererConfig = {
  qualityTier: "auto",
  simResolutionScale: QUALITY_PRESETS.balanced.simResolutionScale,
  pressureIterations: QUALITY_PRESETS.balanced.pressureIterations,
  haloStrength: 0.95,
  fogDensity: 0.94,
  contrast: 1.16,
  grainAmount: 0.06,
};

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
    if (!this.started || !this.gpu || !this.pipelines || !this.uniformBuffer || !this.taskBuffer || !this.simulation) return;

    const t = performance.now();
    const dtSec = Math.min(0.1, (t - this.now) / 1000);
    this.now = t;

    const resized = this.resize();
    if (resized) this.rebuildSimulation();
    if (!this.simulation) return;

    if (this.store.needsLayout()) {
      this.store.recalcLayout(this.canvas.width, this.canvas.height, BASE_TILE_SIZE);
    }

    this.store.tickPositions(dtSec);
    const activeState = this.store.syncActiveMessageBlend(t);
    tickCamera(this.camera, dtSec);

    const snapshot = this.store.getSnapshot();
    const atoms = this.store.getVisibleAtoms();
    const points = buildTaskFieldPointsSingleActive(atoms, activeState, snapshot.selectedId, snapshot.hoveredId, t);
    const taskCount = writeTaskPoints(this.gpu.device, this.taskBuffer, points);
    this.store.setTaskPointCount(taskCount);
    const matchMeta = getLastTaskFieldMatchMeta();
    this.store.setActiveMessageMatchMeta(matchMeta.source, matchMeta.matchedPhrase, matchMeta.canonicalKey);

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
      haloStrength: this.config.haloStrength,
      contrast: this.config.contrast,
      grainAmount: this.config.grainAmount,
      taskCount,
      selectedX: selectedNorm.x,
      selectedY: selectedNorm.y,
      hoveredX: hoveredNorm.x,
      hoveredY: hoveredNorm.y,
      compositeSamples: preset.compositeSamples,
    });

    const encoder = this.gpu.device.createCommandEncoder();
    runSimulationStep(encoder, this.simulation, this.pipelines, pressureIterations);
    drawVolume(encoder, this.gpu.context.getCurrentTexture().createView(), this.simulation, this.pipelines);
    this.gpu.device.queue.submit([encoder.finish()]);

    this.updateHoverFromPointer(atoms);

    this.frameCount += 1;
    const elapsed = t - this.fpsWindowStart;
    if (elapsed >= 500) {
      const fps = (this.frameCount * 1000) / elapsed;
      this.store.setFps(fps);
      this.adjustQuality(fps, snapshot.qualityTierOverride);
      this.frameCount = 0;
      this.fpsWindowStart = t;
    }

    this.raf = requestAnimationFrame(this.frame);
  };

  private adjustQuality(fps: number, override: "auto" | "safe" | "balanced" | "high"): void {
    if (override !== "auto") return;
    const rank = (tier: QualityTier) => (tier === "safe" ? 1 : tier === "balanced" ? 2 : 3);
    const fromRank = rank(this.activeTier);
    const down = fps < 52;
    const up = fps > 58;

    if (down) {
      this.qualityDownTicks += 1;
      this.qualityUpTicks = 0;
      if (this.qualityDownTicks >= 4 && fromRank > 1) {
        this.activeTier = fromRank === 3 ? "balanced" : "safe";
        this.qualityDownTicks = 0;
        this.rebuildSimulation();
      }
      return;
    }

    if (up) {
      this.qualityUpTicks += 1;
      this.qualityDownTicks = 0;
      if (this.qualityUpTicks >= 8 && fromRank < 3) {
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
