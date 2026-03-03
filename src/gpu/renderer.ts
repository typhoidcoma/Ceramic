import { easePosition, TILE_GUTTER_PX } from "../layout/layout";
import { SpatialHash } from "../layout/spatialHash";
import type { AtomStore } from "../app/store";
import { createBuffers, writeGlobals, writeInstances } from "./buffers";
import { initWebGpu } from "./gpu";
import { createPipeline } from "./pipeline";

const MAX_INSTANCES = 50000;
const BASE_TILE_SIZE = 22;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;

export class Renderer {
  private canvas: HTMLCanvasElement;
  private store: AtomStore;
  private started = false;
  private raf = 0;
  private now = performance.now();
  private frameCounter = 0;
  private fpsWindowStart = performance.now();
  private camX = 0;
  private camY = 0;
  private zoom = 1;
  private spatialHash = new SpatialHash();
  private hoveredLastRebuild = -1;
  private dragState: { active: boolean; x: number; y: number } = { active: false, x: 0, y: 0 };

  private gpu: Awaited<ReturnType<typeof initWebGpu>> | null = null;
  private pipeline: ReturnType<typeof createPipeline> | null = null;
  private buffers: ReturnType<typeof createBuffers> | null = null;
  private globalsBindGroup: GPUBindGroup | null = null;
  private instancesBindGroup: GPUBindGroup | null = null;

  constructor(canvas: HTMLCanvasElement, store: AtomStore) {
    this.canvas = canvas;
    this.store = store;
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
    this.camX = 0;
    this.camY = 0;
    this.zoom = 1;
    this.store.markLayoutDirty();
  }

  private frame = (): void => {
    if (!this.started || !this.gpu || !this.pipeline || !this.buffers || !this.globalsBindGroup || !this.instancesBindGroup) return;

    const t = performance.now();
    const dtSec = Math.min(0.1, (t - this.now) / 1000);
    this.now = t;

    this.resize();
    const viewportWorldWidth = this.canvas.width / this.zoom;
    const viewportWorldHeight = this.canvas.height / this.zoom;
    if (this.store.needsLayout()) {
      this.store.recalcLayout(viewportWorldWidth, viewportWorldHeight, BASE_TILE_SIZE);
    }

    const visible = this.store.getVisibleAtoms();
    easePosition(visible, dtSec);

    const rebuildEvery = 4;
    if (this.frameCounter % rebuildEvery === 0 || this.hoveredLastRebuild !== visible.length) {
      this.spatialHash.rebuild(visible, BASE_TILE_SIZE + TILE_GUTTER_PX, BASE_TILE_SIZE);
      this.hoveredLastRebuild = visible.length;
    }

    const hoveredKey = this.store.getHoveredAtom()?.stableKey ?? 0;
    const selectedKey = this.store.getSelectedAtom()?.stableKey ?? 0;
    const nowSec = t / 1000;

    const instanceCount = writeInstances(this.gpu.device, this.buffers.instanceBuffer, {
      atoms: visible.slice(0, MAX_INSTANCES),
      hoveredId: this.store.getSnapshot().hoveredId,
      selectedId: this.store.getSnapshot().selectedId,
      baseSize: BASE_TILE_SIZE,
      nowSec,
    });

    writeGlobals(this.gpu.device, this.buffers.globalsBuffer, {
      widthPx: this.canvas.width,
      heightPx: this.canvas.height,
      camX: this.camX,
      camY: this.camY,
      zoom: this.zoom,
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
          clearValue: { r: 0.05, g: 0.06, b: 0.075, a: 1 },
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline.pipeline);
    pass.setBindGroup(0, this.globalsBindGroup);
    pass.setBindGroup(1, this.instancesBindGroup);
    if (instanceCount > 0) {
      pass.draw(6, instanceCount, 0, 0);
    }
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
  }

  private attachInputHandlers(): void {
    window.addEventListener("resize", () => this.store.markLayoutDirty());
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    this.canvas.addEventListener("pointerdown", (event) => {
      if ((event.buttons & (1 | 2 | 4)) === 0) return;
      this.dragState = { active: true, x: event.clientX, y: event.clientY };
      this.canvas.style.cursor = "grabbing";
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointerup", (event) => {
      this.canvas.style.cursor = "default";
      if (this.dragState.active) {
        const dx = Math.abs(event.clientX - this.dragState.x);
        const dy = Math.abs(event.clientY - this.dragState.y);
        if (event.button === 0 && dx < 3 && dy < 3) {
          const world = this.screenToWorld(event.offsetX, event.offsetY);
          const hit = this.spatialHash.pick(world.x, world.y);
          this.store.setSelected(hit?.id ?? null);
        }
      }
      this.dragState.active = false;
      this.canvas.releasePointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (this.dragState.active && (event.buttons & (1 | 2 | 4)) !== 0) {
        const dx = event.clientX - this.dragState.x;
        const dy = event.clientY - this.dragState.y;
        this.dragState.x = event.clientX;
        this.dragState.y = event.clientY;
        this.camX += dx / this.zoom;
        this.camY -= dy / this.zoom;
        return;
      }
      const world = this.screenToWorld(event.offsetX, event.offsetY);
      const hit = this.spatialHash.pick(world.x, world.y);
      this.store.setHover(hit?.id ?? null);
    });

    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (event.shiftKey) {
          this.camX += event.deltaY / this.zoom;
          this.store.markLayoutDirty();
          return;
        }
        const before = this.screenToWorld(event.offsetX, event.offsetY);
        const zoomFactor = Math.exp(-event.deltaY * 0.001);
        this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * zoomFactor));
        const after = this.screenToWorld(event.offsetX, event.offsetY);
        this.camX += before.x - after.x;
        this.camY += before.y - after.y;
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
      x: xCentered / this.zoom + this.camX,
      y: yCentered / this.zoom + this.camY,
    };
  }
}
