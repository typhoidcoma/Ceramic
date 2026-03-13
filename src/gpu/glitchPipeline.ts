import glitchSource from "./glitch.wgsl?raw";

export type GlitchParams = {
  warpStrength: number;
  blockSize: number;
  feedbackAmount: number;
  feedbackDisplace: number;
  rgbSplit: number;
  glitchBurst: number;
  decay: number;
  blendToClean: number;
  pixelSort: number;
};

export const DEFAULT_GLITCH_PARAMS: GlitchParams = {
  warpStrength: 0.8,
  blockSize: 18,
  feedbackAmount: 0.86,
  feedbackDisplace: 0.045,
  rgbSplit: 7,
  glitchBurst: 0.7,
  decay: 0.04,
  blendToClean: 0.15,
  pixelSort: 0.0,
};

export class GlitchPipeline {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  private sampler: GPUSampler;
  private uniformBuf: GPUBuffer;

  private warpPipeline: GPURenderPipeline;
  private blockPipeline: GPURenderPipeline;
  private feedbackPipeline: GPURenderPipeline;
  private rgbPipeline: GPURenderPipeline;
  private copyPipeline: GPURenderPipeline;

  private width = 1;
  private height = 1;

  private warpTex!: GPUTexture;
  private blockTex!: GPUTexture;
  private postTex!: GPUTexture;
  private feedbackA!: GPUTexture;
  private feedbackB!: GPUTexture;
  private feedbackParity = 0;
  private needsFeedbackSeed = true;

  private params: GlitchParams = { ...DEFAULT_GLITCH_PARAMS };

  constructor(device: GPUDevice, format: GPUTextureFormat, width: number, height: number) {
    this.device = device;
    this.format = format;

    this.sampler = this.device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.uniformBuf = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const module = this.device.createShaderModule({ code: glitchSource });
    this.warpPipeline = this.createPipeline(module, "fsWarp");
    this.blockPipeline = this.createPipeline(module, "fsBlock");
    this.feedbackPipeline = this.createPipeline(module, "fsFeedback");
    this.rgbPipeline = this.createPipeline(module, "fsRgb");
    this.copyPipeline = this.createPipeline(module, "fsCopy");

    this.resize(width, height);
  }

  setParams(params: Partial<GlitchParams>) {
    this.params = { ...this.params, ...params };
  }

  markFeedbackDirty() {
    this.needsFeedbackSeed = true;
  }

  getParams(): GlitchParams {
    return { ...this.params };
  }

  resize(width: number, height: number) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;

    this.warpTex = this.createRenderTexture();
    this.blockTex = this.createRenderTexture();
    this.postTex = this.createRenderTexture();
    this.feedbackA = this.createRenderTexture();
    this.feedbackB = this.createRenderTexture();
    this.feedbackParity = 0;
    this.needsFeedbackSeed = true;

    this.clearTexture(this.feedbackA);
    this.clearTexture(this.feedbackB);
  }

  render(encoder: GPUCommandEncoder, sourceView: GPUTextureView, outputView: GPUTextureView, time: number) {
    this.writeUniforms(time);

    if (this.needsFeedbackSeed) {
      this.runPass(encoder, this.copyPipeline, sourceView, sourceView, this.feedbackA.createView());
      this.runPass(encoder, this.copyPipeline, sourceView, sourceView, this.feedbackB.createView());
      this.needsFeedbackSeed = false;
    }

    const warpView = this.warpTex.createView();
    const blockView = this.blockTex.createView();
    const postView = this.postTex.createView();

    const feedbackRead = this.feedbackParity === 0 ? this.feedbackA.createView() : this.feedbackB.createView();
    const feedbackWriteTex = this.feedbackParity === 0 ? this.feedbackB : this.feedbackA;
    const feedbackWrite = feedbackWriteTex.createView();

    this.runPass(encoder, this.warpPipeline, sourceView, sourceView, warpView);
    this.runPass(encoder, this.blockPipeline, warpView, warpView, blockView);
    this.runPass(encoder, this.feedbackPipeline, blockView, feedbackRead, feedbackWrite);
    this.runPass(encoder, this.rgbPipeline, feedbackWrite, sourceView, postView);
    this.runPass(encoder, this.copyPipeline, postView, postView, outputView);

    this.feedbackParity = 1 - this.feedbackParity;
  }

  private writeUniforms(time: number) {
    const p = this.params;
    const data = new Float32Array(12);
    data[0] = time;
    data[1] = this.width;
    data[2] = this.height;
    data[3] = p.warpStrength;
    data[4] = p.blockSize;
    data[5] = p.feedbackAmount;
    data[6] = p.feedbackDisplace;
    data[7] = p.rgbSplit;
    data[8] = p.glitchBurst;
    data[9] = p.decay;
    data[10] = p.blendToClean;
    data[11] = p.pixelSort;
    this.device.queue.writeBuffer(this.uniformBuf, 0, data);
  }

  private createPipeline(module: GPUShaderModule, fragmentEntry: string): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: fragmentEntry,
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private createRenderTexture(): GPUTexture {
    return this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private runPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    srcView: GPUTextureView,
    auxView: GPUTextureView,
    dstView: GPUTextureView,
  ) {
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: srcView },
        { binding: 3, resource: auxView },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  private clearTexture(texture: GPUTexture) {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}



