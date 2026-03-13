import { type GpuContext } from "./context";
import { GlitchPipeline, type GlitchParams } from "./glitchPipeline";
import { StylePipeline, type StyleParams } from "./stylePipeline";
import sourceShader from "./playgroundSource.wgsl?raw";

export class PlaygroundRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;

  private sourcePipeline: GPURenderPipeline;
  private sourceUniformBuf: GPUBuffer;
  private sourceTex: GPUTexture;
  private glitchTex: GPUTexture;
  private bgSampler: GPUSampler;
  private bgTexture: GPUTexture;
  private bgTextureWidth = 1;
  private bgTextureHeight = 1;
  private bgVideo: HTMLVideoElement | null = null;
  private videoFrameCanvas: HTMLCanvasElement | null = null;
  private videoFrameCtx: CanvasRenderingContext2D | null = null;

  private glitchPipeline: GlitchPipeline;
  private stylePipeline: StylePipeline;
  private hasBackgroundSource = false;

  private startTime = performance.now() / 1000;
  private lastFrameTime = 0;
  private frameHandle = 0;

  constructor(gpu: GpuContext) {
    this.device = gpu.device;
    this.context = gpu.context;
    this.format = gpu.format;

    this.sourceUniformBuf = this.device.createBuffer({
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
    this.bgTexture = this.createFallbackBackgroundTexture();

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

    this.sourceTex = this.createFrameTexture();
    this.glitchTex = this.createFrameTexture();

    const canvas = this.context.canvas as HTMLCanvasElement;
    this.glitchPipeline = new GlitchPipeline(this.device, this.format, canvas.width, canvas.height);
    this.stylePipeline = new StylePipeline(this.device, this.format);
  }

  setGlitchParams(params: Partial<GlitchParams>) {
    this.glitchPipeline.setParams(params);
  }

  setStyleParams(params: Partial<StyleParams>) {
    this.stylePipeline.setParams(params);
  }

  setBackgroundImage(image: ImageBitmap | null) {
    this.bgVideo = null;
    if (!image) {
      this.bgTexture = this.createFallbackBackgroundTexture();
      this.hasBackgroundSource = false;
      this.glitchPipeline.markFeedbackDirty();
      return;
    }

    this.ensureBackgroundTextureSize(image.width, image.height);
    this.device.queue.copyExternalImageToTexture(
      { source: image },
      { texture: this.bgTexture },
      { width: image.width, height: image.height },
    );

    this.hasBackgroundSource = true;
    this.glitchPipeline.markFeedbackDirty();
  }

  setBackgroundVideo(video: HTMLVideoElement | null) {
    this.bgVideo = video;
    if (!video) {
      this.bgTexture = this.createFallbackBackgroundTexture();
      this.hasBackgroundSource = false;
      this.glitchPipeline.markFeedbackDirty();
      return;
    }

    if (video.videoWidth > 0 && video.videoHeight > 0) {
      this.ensureBackgroundTextureSize(video.videoWidth, video.videoHeight);
      this.ensureVideoFrameCanvas(video.videoWidth, video.videoHeight);
    }

    this.hasBackgroundSource = true;
    this.glitchPipeline.markFeedbackDirty();
  }

  resize(width: number, height: number) {
    if (width < 1 || height < 1) return;
    this.sourceTex = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.glitchTex = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.glitchPipeline.resize(width, height);
  }

  start() {
    this.lastFrameTime = performance.now() / 1000;
    const tick = () => {
      this.frameHandle = requestAnimationFrame(tick);
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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createFallbackBackgroundTexture(): GPUTexture {
    this.bgTextureWidth = 1;
    this.bgTextureHeight = 1;
    const tex = this.device.createTexture({
      size: { width: 1, height: 1 },
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.writeTexture(
      { texture: tex },
      new Uint8Array([24, 26, 32, 255]),
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
    if (!this.bgVideo) return;
    if (this.bgVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (this.bgVideo.videoWidth < 1 || this.bgVideo.videoHeight < 1) return;

    this.ensureVideoFrameCanvas(this.bgVideo.videoWidth, this.bgVideo.videoHeight);
    if (!this.videoFrameCanvas || !this.videoFrameCtx) return;

    this.ensureBackgroundTextureSize(this.bgVideo.videoWidth, this.bgVideo.videoHeight);
    this.videoFrameCtx.drawImage(this.bgVideo, 0, 0, this.videoFrameCanvas.width, this.videoFrameCanvas.height);
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

    const sourceData = new Float32Array(4);
    sourceData[0] = this.context.canvas.width;
    sourceData[1] = this.context.canvas.height;
    sourceData[2] = this.hasBackgroundSource ? 1 : 0;
    sourceData[3] = 0;
    this.device.queue.writeBuffer(this.sourceUniformBuf, 0, sourceData);

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
        clearValue: { r: 0.06, g: 0.07, b: 0.08, a: 1 },
      }],
    });
    sourcePass.setPipeline(this.sourcePipeline);
    sourcePass.setBindGroup(0, sourceBG);
    sourcePass.draw(6);
    sourcePass.end();

    const elapsed = now - this.startTime;
    this.glitchPipeline.render(encoder, this.sourceTex.createView(), this.glitchTex.createView(), elapsed);

    this.stylePipeline.render(
      encoder,
      this.glitchTex.createView(),
      this.context.getCurrentTexture().createView(),
      elapsed,
      this.context.canvas.width,
      this.context.canvas.height,
    );

    this.device.queue.submit([encoder.finish()]);
  }
}
