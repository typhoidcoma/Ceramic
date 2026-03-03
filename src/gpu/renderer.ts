import { easePosition, TILE_GUTTER_PX, type LayoutMode, type PanelLayout } from "../layout/layout";
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
const MAX_TREE_EDGES_DRAWN = 30000;

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
  private spatialHash = new SpatialHash();
  private hoveredLastRebuild = -1;
  private projectedById = new Map<string, { x: number; y: number; z: number; scale: number; screenX: number; screenY: number; radius: number }>();
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

  constructor(canvas: HTMLCanvasElement, store: AtomStore, edgeCanvas?: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.edgeCanvas = edgeCanvas ?? null;
    this.store = store;
    this.edgeCtx = this.edgeCanvas?.getContext("2d") ?? null;
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
    }

    const visible = this.store.getVisibleAtoms();
    easePosition(visible, dtSec);
    this.updateProjectedCache(layoutMode, visible);
    this.drawContextLayers(layoutMode, visible);

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

    const instanceCount = writeInstances(this.gpu.device, this.buffers.instanceBuffer, {
      atoms: visible.slice(0, MAX_INSTANCES),
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
      this.drawGround(ctx);
      this.drawTreeEdges(ctx, visible);
      return;
    }
    if (layoutMode === "constellation") {
      this.drawConstellationConnections(ctx, visible);
    }
  }

  private drawGround(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    const cx = this.canvas.width * 0.5;
    const cy = this.canvas.height * 0.86;
    const rx = Math.min(this.canvas.width * 0.42, 460);
    const ry = rx * 0.28;
    const grad = ctx.createRadialGradient(cx, cy - ry * 0.2, 6, cx, cy, rx);
    grad.addColorStop(0, "rgba(96,188,255,0.20)");
    grad.addColorStop(1, "rgba(30,88,138,0.00)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(126,198,255,0.22)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i += 1) {
      const t = i / 5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * (0.28 + t * 0.72), ry * (0.28 + t * 0.72), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTreeEdges(ctx: CanvasRenderingContext2D, visible: Atom[]): void {
    const atomsById = new Map(visible.map((atom) => [atom.id, atom]));
    const focusSet = this.store.getSnapshot().focusMode === "selected" ? this.store.getFocusSet() : new Set<string>();
    const edges = this.store
      .getTreeEdges()
      .slice(0, MAX_TREE_EDGES_DRAWN)
      .sort((a, b) => b.strength - a.strength);

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    for (const edge of edges) {
      const aProj = this.projectedById.get(edge.parentId);
      const bProj = this.projectedById.get(edge.childId);
      if (!aProj || !bProj) continue;
      const a = atomsById.get(edge.parentId);
      const b = atomsById.get(edge.childId);
      if (!a || !b) continue;

      const focused = focusSet.size === 0 || (focusSet.has(edge.parentId) && focusSet.has(edge.childId));
      const baseAlpha = focused ? 0.08 : 0.018;
      const depth = Math.max(0, Math.min(1, 1 - Math.min(aProj.z, bProj.z) / 1200));
      const alpha = baseAlpha + edge.strength * 0.17 * depth;
      const width = (a.treeRole === "trunk" || b.treeRole === "trunk" ? 1.8 : 0.9) * (0.45 + depth);
      ctx.strokeStyle = a.treeRole === "trunk" || b.treeRole === "trunk" ? `rgba(178,136,92,${alpha})` : `rgba(106,206,168,${alpha})`;
      ctx.lineWidth = width;

      const midX = (aProj.screenX + bProj.screenX) * 0.5;
      const midY = (aProj.screenY + bProj.screenY) * 0.5 - 10 - Math.abs(aProj.screenX - bProj.screenX) * 0.03;
      ctx.beginPath();
      ctx.moveTo(aProj.screenX, aProj.screenY);
      ctx.quadraticCurveTo(midX, midY, bProj.screenX, bProj.screenY);
      ctx.stroke();
    }
    ctx.restore();
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
    let best: Atom | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    const atoms = this.store.getVisibleAtoms();
    const byId = new Map(atoms.map((atom) => [atom.id, atom]));
    for (const [id, p] of this.projectedById) {
      const atom = byId.get(id);
      if (!atom) continue;
      const dx = offsetX - p.screenX;
      const dy = offsetY - p.screenY;
      const r = Math.max(6, p.radius);
      const distSq = dx * dx + dy * dy;
      if (distSq > r * r) continue;
      if (distSq < bestDist) {
        best = atom;
        bestDist = distSq;
      }
    }
    return best;
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
