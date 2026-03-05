import { type GpuContext } from "./context";
import shaderSource from "./shader.wgsl?raw";

const TEX_SIZE = 1024;
const MIP_LEVELS = Math.floor(Math.log2(TEX_SIZE)) + 1; // 11 levels for 1024

export class Renderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private bindGroupLayout: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private textureA: GPUTexture;
  private textureB: GPUTexture;
  private bindGroup: GPUBindGroup;

  private startTime = performance.now() / 1000;
  private sweepProgress = 0;
  private sweepTarget = 1;
  private sweepSpeed = 0.5; // full reveal in ~2s
  private transitionBlend = 0;
  private transitionTarget = 0;
  private transitionSpeed = 0.7;
  private animFrame = 0;

  constructor(gpu: GpuContext) {
    this.device = gpu.device;
    this.context = gpu.context;

    // Uniform buffer (32 bytes: time, sweep, transition, pad, viewport, pad)
    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Sampler with mipmapping
    this.sampler = this.device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Create textures
    this.textureA = this.createInkTexture();
    this.textureB = this.createInkTexture();

    // Bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    // Pipeline
    const shaderModule = this.device.createShaderModule({ code: shaderSource });
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [{ format: gpu.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroup = this.createBindGroup();
  }

  private createInkTexture(): GPUTexture {
    return this.device.createTexture({
      size: { width: TEX_SIZE, height: TEX_SIZE },
      mipLevelCount: MIP_LEVELS,
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private createBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.textureA.createView() },
        { binding: 2, resource: this.textureB.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  uploadLogogram(imageData: ImageData, slot: "A" | "B") {
    const tex = slot === "A" ? this.textureA : this.textureB;

    // Upload base level
    this.device.queue.writeTexture(
      { texture: tex, mipLevel: 0 },
      imageData.data,
      { bytesPerRow: TEX_SIZE * 4 },
      { width: TEX_SIZE, height: TEX_SIZE },
    );

    // Generate mipmaps
    this.generateMipmaps(tex);

    // Rebuild bind group
    this.bindGroup = this.createBindGroup();
  }

  private generateMipmaps(texture: GPUTexture) {
    // Simple mipmap generation using render passes
    if (!this.mipmapPipeline) {
      this.initMipmapPipeline();
    }

    const encoder = this.device.createCommandEncoder();
    let srcView = texture.createView({ baseMipLevel: 0, mipLevelCount: 1 });

    for (let level = 1; level < MIP_LEVELS; level++) {
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });

      const bindGroup = this.device.createBindGroup({
        layout: this.mipmapPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: srcView },
        ],
      });

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: dstView,
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 1, g: 1, b: 1, a: 1 },
          },
        ],
      });
      pass.setPipeline(this.mipmapPipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();

      srcView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
    }

    this.device.queue.submit([encoder.finish()]);
  }

  private mipmapPipeline: GPURenderPipeline | null = null;

  private initMipmapPipeline() {
    const code = `
      @group(0) @binding(0) var samp: sampler;
      @group(0) @binding(1) var tex: texture_2d<f32>;

      struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

      @vertex fn vs(@builtin(vertex_index) vid: u32) -> VsOut {
        var positions = array<vec2f, 6>(
          vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
          vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1),
        );
        let p = positions[vid];
        var out: VsOut;
        out.pos = vec4f(p, 0, 1);
        out.uv = p * 0.5 + 0.5;
        out.uv.y = 1.0 - out.uv.y;
        return out;
      }

      @fragment fn fs(input: VsOut) -> @location(0) vec4f {
        return textureSample(tex, samp, input.uv);
      }
    `;
    const module = this.device.createShaderModule({ code });
    this.mipmapPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  startReveal() {
    this.sweepProgress = 0;
    this.sweepTarget = 1;
  }

  startTransition() {
    this.transitionBlend = 0;
    this.transitionTarget = 1;
  }

  swapTextures() {
    const tmp = this.textureA;
    this.textureA = this.textureB;
    this.textureB = tmp;
    this.bindGroup = this.createBindGroup();
    this.transitionBlend = 0;
    this.transitionTarget = 0;
  }

  start() {
    const frame = () => {
      this.animFrame = requestAnimationFrame(frame);
      this.renderFrame();
    };
    this.animFrame = requestAnimationFrame(frame);
  }

  stop() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
  }

  private renderFrame() {
    const now = performance.now() / 1000;
    const time = now - this.startTime;
    const dt = 1 / 60; // approximate

    // Animate sweep
    if (this.sweepProgress < this.sweepTarget) {
      this.sweepProgress = Math.min(this.sweepTarget, this.sweepProgress + dt * this.sweepSpeed);
    }

    // Animate transition
    if (this.transitionBlend < this.transitionTarget) {
      this.transitionBlend = Math.min(
        this.transitionTarget,
        this.transitionBlend + dt * this.transitionSpeed,
      );
      // When transition completes, swap textures
      if (this.transitionBlend >= 1) {
        this.swapTextures();
      }
    }

    // Update uniforms
    const uniforms = new Float32Array([
      time,
      this.sweepProgress,
      this.transitionBlend,
      0, // pad
      this.context.canvas.width,
      this.context.canvas.height,
      0,
      0, // pad
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    // Render
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.91, g: 0.92, b: 0.93, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
