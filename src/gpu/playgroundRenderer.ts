import { type GpuContext } from "./context";
import { EffectStackPipeline } from "./effectStackPipeline";
import type { BackgroundSource, EffectLayer, GlobalOptions } from "./effectsRegistry";
import { GlitchPipeline, type GlitchParams } from "./glitchPipeline";
import sourceShader from "./playgroundSource.wgsl?raw";
import composeShader from "./compose.wgsl?raw";

export class PlaygroundRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;

  private sourcePipeline: GPURenderPipeline;
  private composePipeline: GPURenderPipeline;
  private sourceUniformBuf: GPUBuffer;
  private composeUniformBuf: GPUBuffer;

  private sourceTex: GPUTexture;
  private glitchTex: GPUTexture;
  private stackedTex: GPUTexture;

  private bgSampler: GPUSampler;
  private composeSampler: GPUSampler;
  private bgTexture: GPUTexture;
  private bgTextureWidth = 1;
  private bgTextureHeight = 1;

  private glitchPipeline: GlitchPipeline;
  private effectStackPipeline: EffectStackPipeline;

  private hasBackgroundSource = false;
  private sourceMode = 0;

  private layers: EffectLayer[] = [];
  private background: BackgroundSource = {
    mode: "solidColor",
    underlayColor: [0.08, 0.1, 0.13],
    underlayOpacity: 1,
  };
  private globals: GlobalOptions = { quality: 1, pause: false, seed: 1 };

  private startTime = performance.now() / 1000;
  private lastFrameTime = 0;
  private frameHandle = 0;

  private videoFrameCanvas: HTMLCanvasElement | null = null;
  private videoFrameCtx: CanvasRenderingContext2D | null = null;

  constructor(gpu: GpuContext) {
    this.device = gpu.device;
    this.context = gpu.context;
    this.format = gpu.format;

    this.sourceUniformBuf = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.composeUniformBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bgSampler = this.device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.composeSampler = this.device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.bgTexture = this.createSolidColorTexture(20, 25, 34, 255);

    const sourceModule = this.device.createShaderModule({ code: sourceShader });
    this.sourcePipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: sourceModule, entryPoint: "vs" },
      fragment: {
        module: sourceModule,
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    const composeModule = this.device.createShaderModule({ code: composeShader });
    this.composePipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: composeModule, entryPoint: "vs" },
      fragment: {
        module: composeModule,
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.sourceTex = this.createFrameTexture();
    this.glitchTex = this.createFrameTexture();
    this.stackedTex = this.createFrameTexture();

    const canvas = this.context.canvas as HTMLCanvasElement;
    this.glitchPipeline = new GlitchPipeline(this.device, this.format, canvas.width, canvas.height);
    this.effectStackPipeline = new EffectStackPipeline(this.device, this.format, canvas.width, canvas.height);
  }

  setGlitchParams(params: Partial<GlitchParams>) {
    this.glitchPipeline.setParams(params);
  }

  setBackgroundSource(background: BackgroundSource) {
    this.background = background;

    if (background.mode === "solidColor") {
      this.sourceMode = 0;
      this.hasBackgroundSource = true;
      const [r, g, b] = background.underlayColor;
      this.bgTexture = this.createSolidColorTexture(
        Math.round(r * 255),
        Math.round(g * 255),
        Math.round(b * 255),
        255,
      );
      this.glitchPipeline.markFeedbackDirty();
      return;
    }

    if (background.mode === "image" && background.image) {
      this.sourceMode = 1;
      this.ensureBackgroundTextureSize(background.image.width, background.image.height);
      this.device.queue.copyExternalImageToTexture(
        { source: background.image },
        { texture: this.bgTexture },
        { width: background.image.width, height: background.image.height },
      );
      this.hasBackgroundSource = true;
      this.glitchPipeline.markFeedbackDirty();
      return;
    }

    if (background.mode === "video" && background.video) {
      this.sourceMode = 2;
      if (background.video.videoWidth > 0 && background.video.videoHeight > 0) {
        this.ensureBackgroundTextureSize(background.video.videoWidth, background.video.videoHeight);
        this.ensureVideoFrameCanvas(background.video.videoWidth, background.video.videoHeight);
      }
      this.hasBackgroundSource = true;
      this.glitchPipeline.markFeedbackDirty();
      return;
    }

    this.hasBackgroundSource = false;
    this.sourceMode = 1;
    this.bgTexture = this.createSolidColorTexture(20, 25, 34, 255);
    this.glitchPipeline.markFeedbackDirty();
  }

  setEffectStack(layers: EffectLayer[]) {
    this.layers = layers;
  }

  setGlobalOptions(options: GlobalOptions) {
    this.globals = options;
    this.effectStackPipeline.setGlobalOptions(options);
  }

  resize(width: number, height: number) {
    if (width < 1 || height < 1) return;
    this.sourceTex = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.glitchTex = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.stackedTex = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.glitchPipeline.resize(width, height);
    this.effectStackPipeline.resize(width, height);
  }

  start() {
    this.lastFrameTime = performance.now() / 1000;
    const tick = () => {
      this.frameHandle = requestAnimationFrame(tick);
      if (this.globals.pause) return;
      this.renderFrame();
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop() {
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
    }
  }

  private createFrameTexture(): GPUTexture {
    const canvas = this.context.canvas as HTMLCanvasElement;
    return this.device.createTexture({
      size: { width: Math.max(1, canvas.width), height: Math.max(1, canvas.height) },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
  }

  private createSolidColorTexture(r: number, g: number, b: number, a: number): GPUTexture {
    this.bgTextureWidth = 1;
    this.bgTextureHeight = 1;
    const tex = this.device.createTexture({
      size: { width: 1, height: 1 },
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.writeTexture(
      { texture: tex },
      new Uint8Array([r, g, b, a]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    return tex;
  }

  private ensureBackgroundTextureSize(width: number, height: number) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.bgTextureWidth && h === this.bgTextureHeight) {
      return;
    }

    this.bgTextureWidth = w;
    this.bgTextureHeight = h;
    this.bgTexture = this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private ensureVideoFrameCanvas(width: number, height: number) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));

    if (!this.videoFrameCanvas) {
      this.videoFrameCanvas = document.createElement("canvas");
      this.videoFrameCtx = this.videoFrameCanvas.getContext("2d");
    }

    if (!this.videoFrameCanvas || !this.videoFrameCtx) return;
    if (this.videoFrameCanvas.width !== w || this.videoFrameCanvas.height !== h) {
      this.videoFrameCanvas.width = w;
      this.videoFrameCanvas.height = h;
    }
  }

  private copyVideoFrame() {
    if (this.background.mode !== "video" || !this.background.video) return;
    const video = this.background.video;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (video.videoWidth < 1 || video.videoHeight < 1) return;

    this.ensureVideoFrameCanvas(video.videoWidth, video.videoHeight);
    if (!this.videoFrameCanvas || !this.videoFrameCtx) return;

    this.ensureBackgroundTextureSize(video.videoWidth, video.videoHeight);
    this.videoFrameCtx.drawImage(video, 0, 0, this.videoFrameCanvas.width, this.videoFrameCanvas.height);
    this.device.queue.copyExternalImageToTexture(
      { source: this.videoFrameCanvas },
      { texture: this.bgTexture },
      { width: this.videoFrameCanvas.width, height: this.videoFrameCanvas.height },
    );
  }

  private renderFrame() {
    const now = performance.now() / 1000;
    this.lastFrameTime = now;
    this.copyVideoFrame();

    const sourceData = new Float32Array(8);
    sourceData[0] = this.context.canvas.width;
    sourceData[1] = this.context.canvas.height;
    sourceData[2] = this.sourceMode;
    sourceData[3] = this.hasBackgroundSource ? 1 : 0;
    sourceData[4] = 1;
    this.device.queue.writeBuffer(this.sourceUniformBuf, 0, sourceData);

    const [r, g, b] = this.background.underlayColor;
    const composeData = new Float32Array([r, g, b, this.background.underlayOpacity]);
    this.device.queue.writeBuffer(this.composeUniformBuf, 0, composeData);

    const encoder = this.device.createCommandEncoder();

    const sourceBG = this.device.createBindGroup({
      layout: this.sourcePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sourceUniformBuf } },
        { binding: 1, resource: this.bgSampler },
        { binding: 2, resource: this.bgTexture.createView() },
      ],
    });

    const sourcePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceTex.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    sourcePass.setPipeline(this.sourcePipeline);
    sourcePass.setBindGroup(0, sourceBG);
    sourcePass.draw(6);
    sourcePass.end();

    const elapsed = now - this.startTime;
    this.glitchPipeline.render(encoder, this.sourceTex.createView(), this.glitchTex.createView(), elapsed);
    this.effectStackPipeline.render(
      encoder,
      this.glitchTex.createView(),
      this.stackedTex,
      this.layers,
      elapsed,
    );

    const composeBG = this.device.createBindGroup({
      layout: this.composePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.composeUniformBuf } },
        { binding: 1, resource: this.composeSampler },
        { binding: 2, resource: this.stackedTex.createView() },
      ],
    });

    const composePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r, g, b, a: 1 },
      }],
    });
    composePass.setPipeline(this.composePipeline);
    composePass.setBindGroup(0, composeBG);
    composePass.draw(6);
    composePass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}


