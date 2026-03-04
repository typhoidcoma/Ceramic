import { easePosition, TILE_GUTTER_PX, type LayoutMode, type PanelLayout, type TreeEdge } from "../layout/layout";
import { SpatialHash } from "../layout/spatialHash";
import type { AtomStore } from "../app/store";
import type { Atom } from "../data/types";
import { createBuffers, writeGlobals, writeInstances } from "./buffers";
import { initWebGpu } from "./gpu";
import { createPipeline } from "./pipeline";

const MAX_INSTANCES = 50000;
const BASE_TILE_SIZE = 22;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
const MIN_PANEL_SCALE = 0.85;
const MAX_PANEL_SCALE = 2.4;
const MAX_TREE_EDGES_DRAWN = 12000;
type RenderMode = "ambient_leaf" | "neocortex";
type ActivationSource = "selection" | "manual";
type CortexQualityTier = "ultra" | "high" | "balanced" | "safe";
type ActivationEvent = { sourceId: string; t0: number; seed: number };

export class Renderer {
  private canvas: HTMLCanvasElement;
  private edgeCanvas: HTMLCanvasElement | null;
  private edgeCtx: CanvasRenderingContext2D | null = null;
  private store: AtomStore;
  private started = false;
  private raf = 0;
  private now = performance.now();
  private frameCounter = 0;
  private fpsWindowStart = performance.now();
  private globalCamX = 0;
  private globalCamY = 0;
  private globalZoom = 1;
  private orbitTarget = { x: 0, y: 120, z: 0 };
  private orbitYaw = 0.25;
  private orbitPitch = 0.28;
  private orbitDistance = 760;
  private renderMode: RenderMode = "neocortex";
  private activationSource: ActivationSource = "selection";
  private qualityTier: CortexQualityTier = "ultra";
  private qualitySwitchUpCount = 0;
  private qualitySwitchDownCount = 0;
  private activationEvent: ActivationEvent | null = null;
  private activationIntensities = new Map<string, number>();
  private spatialHash = new SpatialHash();
  private hoveredLastRebuild = -1;
  private projectedById = new Map<string, { x: number; y: number; z: number; scale: number; screenX: number; screenY: number; radius: number }>();
  private growthRenderOrder: string[] = [];
  private ambientFocusId: string | null = null;
  private ambientHoverId: string | null = null;
  private cachedBackdrop: HTMLCanvasElement | null = null;
  private cachedBackdropW = 0;
  private cachedBackdropH = 0;
  private cachedEdgesRef: TreeEdge[] | null = null;
  private cachedSortedEdges: TreeEdge[] = [];
  private cachedAdjacencyRef: TreeEdge[] | null = null;
  private cachedAdjacency = new Map<string, string[]>();
  private lastContextFocusId: string | null = null;
  private lastContextHoverId: string | null = null;
  private dragState: {
    active: boolean;
    mode: "none" | "pan2d" | "orbit" | "pan3d" | "panel";
    downX: number;
    downY: number;
    x: number;
    y: number;
  } = {
    active: false,
    mode: "none",
    downX: 0,
    downY: 0,
    x: 0,
    y: 0,
  };

  private gpu: Awaited<ReturnType<typeof initWebGpu>> | null = null;
  private pipeline: ReturnType<typeof createPipeline> | null = null;
  private buffers: ReturnType<typeof createBuffers> | null = null;
  private globalsBindGroup: GPUBindGroup | null = null;
  private instancesBindGroup: GPUBindGroup | null = null;

  constructor(canvas: HTMLCanvasElement, store: AtomStore, edgeCanvas?: HTMLCanvasElement | null, renderMode: RenderMode = "ambient_leaf") {
    this.canvas = canvas;
    this.edgeCanvas = edgeCanvas ?? null;
    this.store = store;
    this.edgeCtx = this.edgeCanvas?.getContext("2d") ?? null;
    this.renderMode = renderMode;
  }

  setAmbientFocus(atomId: string | null): void {
    const changed = this.ambientFocusId !== atomId;
    this.ambientFocusId = atomId;
    if (changed && atomId && this.activationSource === "selection") {
      this.activationEvent = { sourceId: atomId, t0: performance.now(), seed: hashFast(atomId) };
    }
  }

  setAmbientHover(atomId: string | null): void {
    this.ambientHoverId = atomId;
  }

  setActivationSource(source: ActivationSource): void {
    this.activationSource = source;
  }

  setRenderStyle(style: RenderMode): void {
    if (this.renderMode === style) return;
    this.renderMode = style;
    this.cachedBackdrop = null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.gpu = await initWebGpu(this.canvas);
    this.pipeline = createPipeline(this.gpu.device, this.gpu.format);
    this.buffers = createBuffers(this.gpu.device, MAX_INSTANCES);

    this.globalsBindGroup = this.gpu.device.createBindGroup({
      layout: this.pipeline.globalsBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.buffers.globalsBuffer } }],
    });
    this.instancesBindGroup = this.gpu.device.createBindGroup({
      layout: this.pipeline.instancesBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.buffers.instanceBuffer } }],
    });

    this.attachInputHandlers();
    this.resize();
    this.now = performance.now();
    this.frame();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    cancelAnimationFrame(this.raf);
  }

  resetView(): void {
    const mode = this.store.getSnapshot().layoutMode;
    if (mode === "growth_tree") {
      this.orbitTarget = { x: 0, y: 120, z: 0 };
      this.orbitYaw = 0.25;
      this.orbitPitch = 0.28;
      this.orbitDistance = 760;
      this.store.restartGrowth();
    } else if (mode === "score" || mode === "constellation") {
      this.globalCamX = 0;
      this.globalCamY = 0;
      this.globalZoom = 1;
    } else {
      const active = this.store.getActivePanel();
      if (active) this.store.resetPanelScale(active.rank);
    }
    this.store.markLayoutDirty();
  }

  private frame = (): void => {
    if (!this.started || !this.gpu || !this.pipeline || !this.buffers || !this.globalsBindGroup || !this.instancesBindGroup) return;

    const t = performance.now();
    const dtSec = Math.min(0.1, (t - this.now) / 1000);
    this.now = t;
    this.resize();

    const snapshot = this.store.getSnapshot();
    const layoutMode = snapshot.layoutMode;
    const groupedMode = layoutMode !== "score" && layoutMode !== "constellation" && layoutMode !== "growth_tree";
    const viewportWorldWidth = groupedMode ? this.canvas.width : this.canvas.width / this.globalZoom;
    const viewportWorldHeight = groupedMode ? this.canvas.height : this.canvas.height / this.globalZoom;
    if (this.store.needsLayout()) {
      this.store.recalcLayout(viewportWorldWidth, viewportWorldHeight, BASE_TILE_SIZE);
    }

    if (layoutMode === "growth_tree") {
      this.store.tickGrowth(dtSec);
      if (this.renderMode === "ambient_leaf" || this.renderMode === "neocortex") {
        this.orbitYaw += dtSec * 0.045;
        this.orbitPitch = 0.24 + Math.sin(t * 0.00016) * 0.06;
      }
    }

    const visible = this.store.getVisibleAtoms();
    this.updateQualityTier(snapshot.fps);
    easePosition(visible, dtSec);
    this.updateProjectedCache(layoutMode, visible);
    const tierParams = this.getTierParams(visible.length);
    const contextStride = tierParams.contextStride;
    const contextFocus = this.ambientFocusId ?? snapshot.selectedId;
    const contextHover = this.ambientHoverId ?? snapshot.hoveredId;
    const forceContext =
      contextFocus !== this.lastContextFocusId || contextHover !== this.lastContextHoverId || this.frameCounter < 2;
    if (forceContext || this.frameCounter % contextStride === 0) {
      this.drawContextLayers(layoutMode, visible);
      this.lastContextFocusId = contextFocus;
      this.lastContextHoverId = contextHover;
    }

    const rebuildEvery = 4;
    if (layoutMode !== "growth_tree" && (this.frameCounter % rebuildEvery === 0 || this.hoveredLastRebuild !== visible.length)) {
      this.spatialHash.rebuild(visible, BASE_TILE_SIZE + TILE_GUTTER_PX, BASE_TILE_SIZE, TILE_GUTTER_PX);
      this.hoveredLastRebuild = visible.length;
    }

    const hoveredKey = this.store.getHoveredAtom()?.stableKey ?? 0;
    const selectedKey = this.store.getSelectedAtom()?.stableKey ?? 0;
    const nowSec = t / 1000;

    const focusSet = snapshot.focusMode === "selected" ? this.store.getFocusSet() : new Set<string>();
    const projectedById =
      layoutMode === "growth_tree"
        ? new Map(
            [...this.projectedById.entries()].map(([id, v]) => [id, { x: v.x, y: v.y, z: v.z, scale: v.scale }]),
          )
        : undefined;

    const renderAtoms = this.getRenderAtoms(layoutMode, visible).slice(0, MAX_INSTANCES);
    this.growthRenderOrder = layoutMode === "growth_tree" ? renderAtoms.map((atom) => atom.id) : [];
    const instanceCount = writeInstances(this.gpu.device, this.buffers.instanceBuffer, {
      atoms: renderAtoms,
      hoveredId: snapshot.hoveredId,
      selectedId: snapshot.selectedId,
      baseSize: BASE_TILE_SIZE,
      nowSec,
      growthTime: snapshot.growthTime,
      focusSet,
      mode: layoutMode === "growth_tree" ? "growth_tree" : "legacy",
      projectedById,
    });

    writeGlobals(this.gpu.device, this.buffers.globalsBuffer, {
      widthPx: this.canvas.width,
      heightPx: this.canvas.height,
      camX: groupedMode || layoutMode === "growth_tree" ? 0 : this.globalCamX,
      camY: groupedMode || layoutMode === "growth_tree" ? 0 : this.globalCamY,
      zoom: groupedMode || layoutMode === "growth_tree" ? 1 : this.globalZoom,
      nowSec,
      baseSize: BASE_TILE_SIZE,
      pixelRatio: window.devicePixelRatio || 1,
      hoveredStableKey: hoveredKey,
      selectedStableKey: selectedKey,
    });

    const encoder = this.gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.gpu.context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0.014, g: 0.025, b: 0.054, a: 1 },
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline.pipeline);
    pass.setBindGroup(0, this.globalsBindGroup);
    pass.setBindGroup(1, this.instancesBindGroup);
    if (instanceCount > 0) pass.draw(6, instanceCount, 0, 0);
    pass.end();
    this.gpu.device.queue.submit([encoder.finish()]);

    this.frameCounter += 1;
    const fpsElapsed = t - this.fpsWindowStart;
    if (fpsElapsed >= 500) {
      const fps = (this.frameCounter * 1000) / fpsElapsed;
      this.store.setFps(fps);
      this.frameCounter = 0;
      this.fpsWindowStart = t;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.store.markLayoutDirty();
    }
    if (this.edgeCanvas && (this.edgeCanvas.width !== width || this.edgeCanvas.height !== height)) {
      this.edgeCanvas.width = width;
      this.edgeCanvas.height = height;
    }
  }

  private attachInputHandlers(): void {
    window.addEventListener("resize", () => this.store.markLayoutDirty());
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    this.canvas.addEventListener("pointerdown", (event) => {
      if ((event.buttons & (1 | 2 | 4)) === 0) return;
      const mode = this.store.getSnapshot().layoutMode;
      let dragMode: "none" | "pan2d" | "orbit" | "pan3d" | "panel" = "none";
      if (mode === "growth_tree") {
        dragMode = event.button === 2 || event.shiftKey ? "pan3d" : "orbit";
      } else if (mode === "score" || mode === "constellation") {
        dragMode = "pan2d";
      } else {
        dragMode = "panel";
      }
      this.dragState = {
        active: true,
        mode: dragMode,
        downX: event.clientX,
        downY: event.clientY,
        x: event.clientX,
        y: event.clientY,
      };
      this.canvas.style.cursor = dragMode === "orbit" || dragMode === "pan2d" || dragMode === "pan3d" ? "grabbing" : "default";
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointerup", (event) => {
      this.canvas.style.cursor = "default";
      if (this.dragState.active) {
        const dx = Math.abs(event.clientX - this.dragState.downX);
        const dy = Math.abs(event.clientY - this.dragState.downY);
        if (event.button === 0 && dx < 3 && dy < 3) {
          const mode = this.store.getSnapshot().layoutMode;
          const hit =
            mode === "growth_tree"
              ? this.pickGrowthAt(event.offsetX, event.offsetY)
              : (() => {
                  const w = this.screenToWorld(event.offsetX, event.offsetY);
                  return this.pickWithPanelScope(w.x, w.y);
                })();
          if (hit) {
            if (mode === "growth_tree" && this.store.getSnapshot().focusMode === "selected") {
              this.store.setFocusId(hit.id);
            }
            if (mode !== "score" && mode !== "constellation" && mode !== "growth_tree") {
              const rank = this.store.getAtomPanelRank(hit.id);
              if (rank !== null) this.store.setActivePanel(rank);
            }
            this.store.setSelected(hit.id);
          } else {
            this.store.setSelected(null);
          }
        }
      }
      this.dragState.active = false;
      this.canvas.releasePointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointercancel", (event) => {
      this.canvas.style.cursor = "default";
      this.dragState.active = false;
      this.store.setHover(null);
      this.canvas.releasePointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointerleave", () => {
      if (!this.dragState.active) this.store.setHover(null);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      const mode = this.store.getSnapshot().layoutMode;
      if (this.dragState.active && (event.buttons & (1 | 2 | 4)) !== 0) {
        const dx = event.clientX - this.dragState.x;
        const dy = event.clientY - this.dragState.y;
        this.dragState.x = event.clientX;
        this.dragState.y = event.clientY;
        if (this.dragState.mode === "pan2d") {
          this.globalCamX -= dx / this.globalZoom;
          this.globalCamY += dy / this.globalZoom;
          return;
        }
        if (this.dragState.mode === "orbit") {
          this.orbitYaw -= dx * 0.0044;
          this.orbitPitch = Math.max(-1.22, Math.min(1.22, this.orbitPitch - dy * 0.0036));
          return;
        }
        if (this.dragState.mode === "pan3d") {
          const basis = this.getOrbitBasis();
          const panScale = Math.max(0.25, this.orbitDistance * 0.0014);
          this.orbitTarget.x += (-dx * basis.right.x + dy * basis.up.x) * panScale;
          this.orbitTarget.y += (-dx * basis.right.y + dy * basis.up.y) * panScale;
          this.orbitTarget.z += (-dx * basis.right.z + dy * basis.up.z) * panScale;
          return;
        }
      }
      const hit =
        mode === "growth_tree"
          ? this.pickGrowthAt(event.offsetX, event.offsetY)
          : (() => {
              const w = this.screenToWorld(event.offsetX, event.offsetY);
              return this.pickWithPanelScope(w.x, w.y);
            })();
      this.store.setHover(hit?.id ?? null);
    });

    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const mode = this.store.getSnapshot().layoutMode;
        if (mode === "growth_tree") {
          const factor = Math.exp(event.deltaY * 0.00115);
          this.orbitDistance = Math.max(180, Math.min(2400, this.orbitDistance * factor));
          return;
        }
        if (mode !== "score" && mode !== "constellation") {
          const world = this.screenToWorld(event.offsetX, event.offsetY);
          const panel = this.findPanelAt(world.x, world.y);
          if (!panel) return;
          this.store.setActivePanel(panel.rank);
          const current = this.store.getPanelScale(panel.rank);
          const factor = Math.exp(-event.deltaY * 0.001);
          const next = Math.max(MIN_PANEL_SCALE, Math.min(MAX_PANEL_SCALE, current * factor));
          this.store.setPanelScale(panel.rank, next);
          this.store.markLayoutDirty();
          return;
        }
        const before = this.screenToWorld(event.offsetX, event.offsetY);
        const zoomFactor = Math.exp(-event.deltaY * 0.001);
        this.globalZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.globalZoom * zoomFactor));
        const after = this.screenToWorld(event.offsetX, event.offsetY);
        this.globalCamX += before.x - after.x;
        this.globalCamY += before.y - after.y;
        this.store.markLayoutDirty();
      },
      { passive: false },
    );

    this.canvas.addEventListener("dblclick", () => {
      this.resetView();
    });
  }

  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const xCentered = screenX * (window.devicePixelRatio || 1) - this.canvas.width * 0.5;
    const yCentered = screenY * (window.devicePixelRatio || 1) - this.canvas.height * 0.5;
    return {
      x: xCentered / this.globalZoom + this.globalCamX,
      y: -yCentered / this.globalZoom + this.globalCamY,
    };
  }

  private worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const x = (worldX - this.globalCamX) * this.globalZoom + this.canvas.width * 0.5;
    const y = this.canvas.height * 0.5 - (worldY - this.globalCamY) * this.globalZoom;
    return { x, y };
  }

  private getOrbitBasis() {
    const forward = {
      x: Math.cos(this.orbitPitch) * Math.sin(this.orbitYaw),
      y: Math.sin(this.orbitPitch),
      z: Math.cos(this.orbitPitch) * Math.cos(this.orbitYaw),
    };
    const upW = { x: 0, y: 1, z: 0 };
    const right = normalize(cross(forward, upW));
    const up = normalize(cross(right, forward));
    const camPos = {
      x: this.orbitTarget.x - forward.x * this.orbitDistance,
      y: this.orbitTarget.y - forward.y * this.orbitDistance,
      z: this.orbitTarget.z - forward.z * this.orbitDistance,
    };
    return { forward, right, up, camPos };
  }

  private updateProjectedCache(mode: LayoutMode, visible: Atom[]): void {
    this.projectedById.clear();
    if (mode !== "growth_tree") return;
    const basis = this.getOrbitBasis();
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const f = 1 / Math.tan(54 * (Math.PI / 180) * 0.5);
    for (const atom of visible) {
      const rel = {
        x: atom.x - basis.camPos.x,
        y: atom.y - basis.camPos.y,
        z: atom.z - basis.camPos.z,
      };
      const camX = dot(rel, basis.right);
      const camY = dot(rel, basis.up);
      const camZ = dot(rel, basis.forward);
      if (camZ <= 8) continue;
      const ndcX = (camX * f) / (camZ * aspect);
      const ndcY = (camY * f) / camZ;
      const px = ndcX * (this.canvas.width * 0.5);
      const py = ndcY * (this.canvas.height * 0.5);
      const scale = Math.max(0.22, Math.min(2.6, this.orbitDistance / camZ));
      const radius = Math.max(4, atom.renderSize * scale * 0.42);
      this.projectedById.set(atom.id, {
        x: px,
        y: py,
        z: camZ,
        scale,
        screenX: px + this.canvas.width * 0.5,
        screenY: this.canvas.height * 0.5 - py,
        radius,
      });
    }
  }

  private drawContextLayers(layoutMode: LayoutMode, visible: Atom[]): void {
    if (!this.edgeCtx || !this.edgeCanvas) return;
    const ctx = this.edgeCtx;
    ctx.clearRect(0, 0, this.edgeCanvas.width, this.edgeCanvas.height);
    if (layoutMode === "growth_tree") {
      this.drawLeafBackdrop(ctx);
      this.drawTreeEdges(ctx, visible);
      return;
    }
    if (layoutMode === "constellation") {
      this.drawConstellationConnections(ctx, visible);
    }
  }

  private getRenderAtoms(layoutMode: LayoutMode, visible: Atom[]): Atom[] {
    if (layoutMode === "growth_tree") {
      return visible
        .filter((atom) => this.projectedById.has(atom.id))
        .sort((a, b) => {
          const az = this.projectedById.get(a.id)?.z ?? Number.POSITIVE_INFINITY;
          const bz = this.projectedById.get(b.id)?.z ?? Number.POSITIVE_INFINITY;
          if (bz !== az) return bz - az; // far -> near for alpha blending
          return a.stableKey - b.stableKey;
        });
    }
    return visible;
  }

  private drawLeafBackdrop(ctx: CanvasRenderingContext2D): void {
    if (!this.cachedBackdrop || this.cachedBackdropW !== this.canvas.width || this.cachedBackdropH !== this.canvas.height) {
      const buffer = document.createElement("canvas");
      buffer.width = this.canvas.width;
      buffer.height = this.canvas.height;
      const bctx = buffer.getContext("2d");
      if (!bctx) return;
      this.drawLeafBackdropInto(bctx, buffer.width, buffer.height);
      this.cachedBackdrop = buffer;
      this.cachedBackdropW = buffer.width;
      this.cachedBackdropH = buffer.height;
    }
    ctx.drawImage(this.cachedBackdrop, 0, 0);
  }

  private drawLeafBackdropInto(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.renderMode === "neocortex") {
      this.drawNeocortexBackdropInto(ctx, width, height);
      return;
    }
    ctx.save();
    const cy = height * 0.5;
    const leftX = width * 0.06;
    const rightX = width * 0.94;
    const length = rightX - leftX;
    const halfH = Math.min(height * 0.36, 290);

    const grad = ctx.createLinearGradient(leftX, cy, rightX, cy);
    grad.addColorStop(0, "rgba(56,118,77,0.10)");
    grad.addColorStop(0.45, "rgba(78,154,98,0.18)");
    grad.addColorStop(1, "rgba(36,86,56,0.08)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(leftX, cy);
    ctx.bezierCurveTo(leftX + length * 0.06, cy - halfH * 0.1, leftX + length * 0.44, cy - halfH, rightX - length * 0.04, cy - halfH * 0.07);
    ctx.bezierCurveTo(rightX, cy - halfH * 0.02, rightX, cy + halfH * 0.02, rightX - length * 0.04, cy + halfH * 0.07);
    ctx.bezierCurveTo(leftX + length * 0.44, cy + halfH, leftX + length * 0.06, cy + halfH * 0.1, leftX, cy);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(112,201,132,0.20)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(leftX + 2, cy);
    ctx.quadraticCurveTo(leftX + length * 0.32, cy + halfH * 0.02, rightX - 2, cy);
    ctx.stroke();

    const leftEdge: Array<{ x: number; y: number }> = [];
    const rightEdge: Array<{ x: number; y: number }> = [];
    const edgeSteps = 70;
    for (let i = 0; i <= edgeSteps; i += 1) {
      const t = i / edgeSteps;
      const x = leftX + t * length * 0.985;
      const wing = halfH * Math.pow(Math.sin(Math.PI * t), 0.84);
      const tooth = Math.sin(t * Math.PI * 30 + Math.sin(t * 8) * 0.7) * (3 + 7 * (1 - Math.abs(t - 0.5) * 1.7));
      leftEdge.push({ x, y: cy - wing - tooth });
      rightEdge.push({ x, y: cy + wing + tooth });
    }

    ctx.strokeStyle = "rgba(144,226,160,0.24)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < leftEdge.length; i += 1) {
      const p = leftEdge[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    for (let i = rightEdge.length - 1; i >= 0; i -= 1) {
      const p = rightEdge[i];
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();

    for (let i = 0; i < 7; i += 1) {
      const t = (i + 1) / 8;
      const x = leftX + t * length * 0.9;
      const wing = halfH * Math.pow(Math.sin(Math.PI * t), 0.84);
      const bend = (0.35 + t * 0.5) * wing;

      ctx.strokeStyle = "rgba(102,186,122,0.11)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.quadraticCurveTo(x - 10 - t * 20, cy - bend * 0.52, x - 16, cy - wing * 0.92);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.quadraticCurveTo(x - 10 - t * 20, cy + bend * 0.52, x - 16, cy + wing * 0.92);
      ctx.stroke();
    }

    for (let i = 0; i < 16; i += 1) {
      const t = 0.08 + (i / 15) * 0.82;
      const x = leftX + t * length;
      const wing = halfH * Math.pow(Math.sin(Math.PI * t), 0.84);
      const fanLength = wing * (0.52 + ((i % 4) * 0.09));
      const lift = 6 + t * 18;

      ctx.strokeStyle = "rgba(118,198,136,0.09)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.quadraticCurveTo(x - lift, cy - fanLength * 0.5, x - lift * 1.3, cy - fanLength);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.quadraticCurveTo(x - lift, cy + fanLength * 0.5, x - lift * 1.3, cy + fanLength);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawNeocortexBackdropInto(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.save();
    const cy = height * 0.5;
    const leftX = width * 0.05;
    const rightX = width * 0.95;
    const length = rightX - leftX;
    const halfH = Math.min(height * 0.38, 320);
    const grad = ctx.createLinearGradient(leftX, cy, rightX, cy);
    grad.addColorStop(0, "rgba(24,48,78,0.22)");
    grad.addColorStop(0.35, "rgba(42,78,122,0.20)");
    grad.addColorStop(0.75, "rgba(26,66,104,0.18)");
    grad.addColorStop(1, "rgba(18,40,70,0.14)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(leftX, cy);
    ctx.bezierCurveTo(leftX + length * 0.12, cy - halfH * 0.18, leftX + length * 0.40, cy - halfH, rightX - length * 0.06, cy - halfH * 0.15);
    ctx.bezierCurveTo(rightX + 8, cy - halfH * 0.05, rightX + 8, cy + halfH * 0.05, rightX - length * 0.06, cy + halfH * 0.15);
    ctx.bezierCurveTo(leftX + length * 0.40, cy + halfH, leftX + length * 0.12, cy + halfH * 0.18, leftX, cy);
    ctx.closePath();
    ctx.fill();

    // Sulci/gyri contour bands
    for (let i = 0; i < 22; i += 1) {
      const t = i / 21;
      const x = leftX + length * (0.09 + t * 0.84);
      const wing = halfH * Math.pow(Math.sin(Math.PI * t), 0.82);
      const phase = t * 9.3;
      ctx.strokeStyle = `rgba(132,192,255,${0.028 + (1 - Math.abs(t - 0.5) * 1.4) * 0.05})`;
      ctx.lineWidth = 0.8 + (1 - Math.abs(t - 0.5) * 1.6) * 0.7;
      ctx.beginPath();
      ctx.moveTo(x - 14, cy - wing * 0.92);
      for (let s = 0; s <= 10; s += 1) {
        const p = s / 10;
        const sx = x + (p - 0.5) * 28 + Math.sin(phase + p * 10) * (2 + wing * 0.02);
        const sy = cy - wing + p * wing * 2 + Math.sin(phase * 1.8 + p * 18) * 3;
        ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }

    // Midline hint
    ctx.strokeStyle = "rgba(176,224,255,0.18)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(leftX + 6, cy);
    ctx.quadraticCurveTo(leftX + length * 0.42, cy + 8, rightX - 10, cy - 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawTreeEdges(ctx: CanvasRenderingContext2D, visible: Atom[]): void {
    const atomsById = new Map(visible.map((atom) => [atom.id, atom]));
    const snapshot = this.store.getSnapshot();
    const focusId = this.ambientFocusId ?? snapshot.selectedId;
    const hoverId = this.ambientHoverId ?? snapshot.hoveredId;
    const focusedThread = this.threadOf(focusId, atomsById);
    const focusSet = this.store.getSnapshot().focusMode === "selected" ? this.store.getFocusSet() : new Set<string>();
    const edgeRef = this.store.getTreeEdges();
    if (this.cachedEdgesRef !== edgeRef) {
      this.cachedEdgesRef = edgeRef;
      this.cachedSortedEdges = [...edgeRef].sort((a, b) => b.strength - a.strength);
    }
    this.ensureAdjacency(edgeRef);
    const tierParams = this.getTierParams(visible.length);
    const budget = Math.min(tierParams.maxEdges, MAX_TREE_EDGES_DRAWN);
    const edges = this.cachedSortedEdges.slice(0, budget);
    this.activationIntensities = this.computeActivationIntensities(
      focusId,
      focusedThread,
      atomsById,
      tierParams.maxCortexNodes,
      performance.now(),
    );
    this.drawCortexCloud(ctx, this.activationIntensities, atomsById, tierParams);

    const edgesByIntensity = [...edges].sort((a, b) => {
      const ai = Math.max(this.activationIntensities.get(a.parentId) ?? 0, this.activationIntensities.get(a.childId) ?? 0) * a.strength;
      const bi = Math.max(this.activationIntensities.get(b.parentId) ?? 0, this.activationIntensities.get(b.childId) ?? 0) * b.strength;
      return ai - bi;
    });

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    for (const edge of edgesByIntensity) {
      const aProj = this.projectedById.get(edge.parentId);
      const bProj = this.projectedById.get(edge.childId);
      if (!aProj || !bProj) continue;
      const a = atomsById.get(edge.parentId);
      const b = atomsById.get(edge.childId);
      if (!a || !b) continue;
      const focusEdge = focusId === edge.parentId || focusId === edge.childId;
      const hoverEdge = hoverId === edge.parentId || hoverId === edge.childId;
      const edgeThread = this.threadOf(edge.parentId, atomsById);
      const inFocusThread = focusedThread && edgeThread && focusedThread === edgeThread;

      const focused = focusSet.size === 0 || (focusSet.has(edge.parentId) && focusSet.has(edge.childId));
      const baseAlpha = focused ? 0.095 : 0.025;
      const depth = Math.max(0, Math.min(1, 1 - Math.min(aProj.z, bProj.z) / 1200));
      const ai = this.activationIntensities.get(edge.parentId) ?? 0;
      const bi = this.activationIntensities.get(edge.childId) ?? 0;
      const wave = Math.max(ai, bi) * edge.strength;
      const pulse = 0.86 + 0.14 * (0.5 + 0.5 * Math.sin(performance.now() * 0.003 + (a.stableKey % 97)));
      const emphasis = focusEdge ? 1.34 : hoverEdge ? 1.14 : inFocusThread ? 1.12 : 1;
      const alpha = (baseAlpha + edge.strength * 0.16 * depth + wave * 0.6) * emphasis * pulse;
      const width = (a.treeRole === "trunk" || b.treeRole === "trunk" ? 2.2 : 1.0) * (0.42 + depth) * (1 + wave * 0.55) * emphasis;
      const t = performance.now() * 0.0024 + (a.stableKey ^ b.stableKey) * 0.00011;
      const heat = Math.min(1, Math.max(0, wave * 0.95 + 0.12 * (0.5 + 0.5 * Math.sin(t))));
      ctx.strokeStyle = this.fmriColor(heat, Math.min(0.98, alpha));
      ctx.lineWidth = width;

      const midX0 = (aProj.screenX + bProj.screenX) * 0.5;
      const midY0 = (aProj.screenY + bProj.screenY) * 0.5;
      const toMidribY = this.canvas.height * 0.5 - midY0;
      const midX = midX0 - 6 - Math.abs(toMidribY) * 0.03 - Math.abs(aProj.screenX - bProj.screenX) * 0.14;
      const midY = midY0 + toMidribY * 0.24;
      ctx.beginPath();
      ctx.moveTo(aProj.screenX, aProj.screenY);
      ctx.quadraticCurveTo(midX, midY, bProj.screenX, bProj.screenY);
      ctx.stroke();
    }
    ctx.restore();
    this.drawAmbientPulse(ctx, focusId, atomsById, "rgba(198,255,156,0.30)");
    this.drawAmbientPulse(ctx, hoverId, atomsById, "rgba(146,232,255,0.22)");
  }

  private drawCortexCloud(
    ctx: CanvasRenderingContext2D,
    intensities: Map<string, number>,
    atomsById: Map<string, Atom>,
    tierParams: { glowPasses: number },
  ): void {
    if (intensities.size === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const [id, intensity] of intensities) {
      if (intensity < 0.03) continue;
      const atom = atomsById.get(id);
      const proj = atom ? this.projectedById.get(id) : undefined;
      if (!atom || !proj) continue;
      const t = performance.now() * 0.0036 + (atom.stableKey % 131) * 0.02;
      const pulse = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t));
      const heat = Math.min(1, Math.max(0, intensity * 0.92 + 0.1 * (0.5 + 0.5 * Math.sin(t * 0.7))));
      const radiusBase = Math.max(14, proj.radius * (1.8 + intensity * 3.4 + pulse * 0.9));
      for (let pass = 0; pass < tierParams.glowPasses; pass += 1) {
        const radius = radiusBase * (1 + pass * 0.38);
        const gradient = ctx.createRadialGradient(proj.screenX, proj.screenY, 0, proj.screenX, proj.screenY, radius);
        gradient.addColorStop(0, this.fmriColor(heat, 0.20 - pass * 0.05));
        gradient.addColorStop(0.5, this.fmriColor(Math.max(0, heat - 0.1), 0.09 - pass * 0.02));
        gradient.addColorStop(1, "rgba(28,52,78,0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(proj.screenX, proj.screenY, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private computeActivationIntensities(
    focusId: string | null,
    focusedThread: string | null,
    atomsById: Map<string, Atom>,
    maxNodes: number,
    nowMs: number,
  ): Map<string, number> {
    const out = new Map<string, number>();
    const event = this.activationEvent;
    if (!focusId && !event) return out;
    const sourceId = focusId ?? event?.sourceId ?? null;
    if (!sourceId) return out;
    if (!event || event.sourceId !== sourceId) {
      this.activationEvent = { sourceId, t0: nowMs, seed: hashFast(sourceId) };
    }
    const active = this.activationEvent;
    if (!active) return out;
    const dt = Math.max(0, nowMs - active.t0);
    const tau = 2200;
    const waveSpeed = 0.0038; // hops per ms
    const waveFront = Math.min(22, dt * waveSpeed);
    const sigma = 2.4;
    const decay = Math.exp(-dt / tau);

    const visited = new Set<string>([active.sourceId]);
    const queue: Array<{ id: string; hop: number }> = [{ id: active.sourceId, hop: 0 }];
    while (queue.length > 0 && out.size < maxNodes) {
      const current = queue.shift();
      if (!current) break;
      const hopDist = Math.abs(current.hop - waveFront);
      const ring = Math.exp(-(hopDist * hopDist) / (2 * sigma * sigma));
      const threadBoost = focusedThread && this.threadOf(current.id, atomsById) === focusedThread ? 1.2 : 1;
      const jitter = 0.85 + 0.15 * (0.5 + 0.5 * Math.sin(dt * 0.005 + ((hashFast(current.id) ^ active.seed) % 251) * 0.07));
      const intensity = Math.min(1, ring * decay * threadBoost * jitter);
      if (intensity > 0.015) out.set(current.id, intensity);
      const neighbors = this.cachedAdjacency.get(current.id) ?? [];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push({ id: neighbor, hop: current.hop + 1 });
      }
    }

    // faint global baseline so wave has a whole-network feel without overpowering
    if (focusedThread) {
      for (const atom of atomsById.values()) {
        if (out.size >= maxNodes) break;
        if (this.threadOf(atom.id, atomsById) === focusedThread && !out.has(atom.id)) {
          out.set(atom.id, 0.06 * decay);
        }
      }
    }
    return out;
  }

  private ensureAdjacency(edges: TreeEdge[]): void {
    if (this.cachedAdjacencyRef === edges) return;
    this.cachedAdjacencyRef = edges;
    this.cachedAdjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const a = this.cachedAdjacency.get(edge.parentId);
      if (a) a.push(edge.childId);
      else this.cachedAdjacency.set(edge.parentId, [edge.childId]);
      const b = this.cachedAdjacency.get(edge.childId);
      if (b) b.push(edge.parentId);
      else this.cachedAdjacency.set(edge.childId, [edge.parentId]);
    }
  }

  private fmriColor(heat01: number, alpha: number): string {
    const h = Math.max(0, Math.min(1, heat01));
    const r =
      h < 0.33 ? Math.floor(54 + h * 3 * 46) : h < 0.66 ? Math.floor(100 + (h - 0.33) * 3 * 155) : Math.floor(255);
    const g =
      h < 0.33 ? Math.floor(120 + h * 3 * 95) : h < 0.66 ? Math.floor(215 - (h - 0.33) * 3 * 50) : Math.floor(165 - (h - 0.66) * 3 * 58);
    const b =
      h < 0.33 ? Math.floor(255 - h * 3 * 35) : h < 0.66 ? Math.floor(220 - (h - 0.33) * 3 * 170) : Math.floor(65 - (h - 0.66) * 3 * 22);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
  }

  private updateQualityTier(fps: number): void {
    const next: CortexQualityTier = fps >= 58 ? "ultra" : fps >= 52 ? "high" : fps >= 45 ? "balanced" : "safe";
    if (next === this.qualityTier) {
      this.qualitySwitchDownCount = 0;
      this.qualitySwitchUpCount = 0;
      return;
    }
    const isDowngrade = this.tierRank(next) < this.tierRank(this.qualityTier);
    if (isDowngrade) {
      this.qualitySwitchDownCount += 1;
      this.qualitySwitchUpCount = 0;
      if (this.qualitySwitchDownCount >= 3) {
        this.qualityTier = next;
        this.qualitySwitchDownCount = 0;
      }
      return;
    }
    this.qualitySwitchUpCount += 1;
    this.qualitySwitchDownCount = 0;
    if (this.qualitySwitchUpCount >= 4) {
      this.qualityTier = next;
      this.qualitySwitchUpCount = 0;
    }
  }

  private tierRank(tier: CortexQualityTier): number {
    if (tier === "ultra") return 4;
    if (tier === "high") return 3;
    if (tier === "balanced") return 2;
    return 1;
  }

  private getTierParams(visibleCount: number): { contextStride: number; maxEdges: number; maxCortexNodes: number; glowPasses: number } {
    const byTier =
      this.qualityTier === "ultra"
        ? { contextStride: 1, maxEdges: 9000, maxCortexNodes: 260, glowPasses: 3 }
        : this.qualityTier === "high"
          ? { contextStride: 2, maxEdges: 6500, maxCortexNodes: 180, glowPasses: 2 }
          : this.qualityTier === "balanced"
            ? { contextStride: 3, maxEdges: 4200, maxCortexNodes: 120, glowPasses: 2 }
            : { contextStride: 4, maxEdges: 2500, maxCortexNodes: 70, glowPasses: 1 };
    if (visibleCount > 9000) return { ...byTier, contextStride: Math.max(byTier.contextStride, 3), maxEdges: Math.min(byTier.maxEdges, 4200) };
    if (visibleCount > 5000) return { ...byTier, contextStride: Math.max(byTier.contextStride, 2), maxEdges: Math.min(byTier.maxEdges, 7000) };
    return byTier;
  }

  private drawAmbientPulse(ctx: CanvasRenderingContext2D, atomId: string | null, atomsById: Map<string, Atom>, color: string): void {
    if (!atomId) return;
    const atom = atomsById.get(atomId);
    const proj = atom ? this.projectedById.get(atom.id) : undefined;
    if (!atom || !proj) return;
    const t = performance.now() * 0.005;
    const pulse = 1 + (0.5 + 0.5 * Math.sin(t + (atom.stableKey % 71) * 0.03)) * 0.95;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.arc(proj.screenX, proj.screenY, Math.max(8, proj.radius * pulse), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private threadOf(atomId: string | null, atomsById: Map<string, Atom>): string | null {
    if (!atomId) return null;
    const atom = atomsById.get(atomId);
    if (!atom || typeof atom.payload !== "object" || !atom.payload) return null;
    const payload = atom.payload as Record<string, unknown>;
    return typeof payload.threadId === "string" ? payload.threadId : null;
  }

  private drawConstellationConnections(ctx: CanvasRenderingContext2D, visible: Atom[]): void {
    const edges = this.store.getConnections();
    if (edges.length === 0 || visible.length === 0) return;
    const atomById = new Map(visible.map((atom) => [atom.id, atom]));
    ctx.save();
    for (const edge of edges) {
      const a = atomById.get(edge.a);
      const b = atomById.get(edge.b);
      if (!a || !b) continue;
      const p0 = this.worldToScreen(a.x, a.y);
      const p1 = this.worldToScreen(b.x, b.y);
      const depth = Math.max(-1, Math.min(1, (a.z + b.z) / 840));
      const alpha = 0.02 + edge.strength * 0.12 + depth * 0.04;
      const lineWidth = Math.max(0.5, 0.7 + edge.strength * 1.1 + depth * 0.3);
      ctx.strokeStyle = edge.kind === "time" ? `rgba(135,199,255,${Math.max(0.02, alpha)})` : `rgba(255,204,132,${Math.max(0.02, alpha)})`;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private pickGrowthAt(offsetX: number, offsetY: number): Atom | null {
    const dpr = window.devicePixelRatio || 1;
    const pointerX = offsetX * dpr;
    const pointerY = offsetY * dpr;
    const atoms = this.store.getVisibleAtoms();
    const byId = new Map(atoms.map((atom) => [atom.id, atom]));
    for (let i = this.growthRenderOrder.length - 1; i >= 0; i -= 1) {
      const id = this.growthRenderOrder[i];
      const p = this.projectedById.get(id);
      if (!p) continue;
      const atom = byId.get(id);
      if (!atom) continue;
      const dx = pointerX - p.screenX;
      const dy = pointerY - p.screenY;
      const r = Math.max(6, p.radius);
      const distSq = dx * dx + dy * dy;
      if (distSq <= r * r) return atom;
    }
    return null;
  }

  private findPanelAt(worldX: number, worldY: number): PanelLayout | null {
    const panels = this.store.getPanelLayouts();
    for (const panel of panels) {
      const halfW = panel.width * 0.5;
      const halfH = panel.height * 0.5;
      if (worldX >= panel.x - halfW && worldX <= panel.x + halfW && worldY >= panel.y - halfH && worldY <= panel.y + halfH) {
        return panel;
      }
    }
    return null;
  }

  private pickWithPanelScope(worldX: number, worldY: number) {
    const hit = this.spatialHash.pick(worldX, worldY);
    const mode = this.store.getSnapshot().layoutMode;
    if (mode === "score" || mode === "constellation") return hit;
    const active = this.store.getActivePanel();
    if (!active) return hit;
    const panel = this.findPanelAt(worldX, worldY);
    if (!panel || panel.rank !== active.rank) return null;
    if (!hit) return null;
    const hitPanelRank = this.store.getAtomPanelRank(hit.id);
    if (hitPanelRank !== active.rank) return null;
    return hit;
  }
}

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(v: { x: number; y: number; z: number }) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function hashFast(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
