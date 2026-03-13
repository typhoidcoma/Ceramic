import effectStackSource from "./effectStack.wgsl?raw";
import type { BlendMode, EffectId, EffectLayer, GlobalOptions } from "./effectsRegistry";

const EFFECT_ID_TO_INDEX: Record<EffectId, number> = {
  stretch: 1,
  wave: 2,
  push: 3,
  bulge: 4,
  transform: 5,
  transform3d: 6,
  splitter: 7,
  tile: 8,
  kaleidoscope: 9,
  vhs: 10,
  super8: 11,
  crt: 12,
  cga: 13,
  lightStreak: 14,
  bleach: 15,
  watercolor: 16,
  grain: 17,
  sharpen: 18,
  blur: 19,
  lumaMesh: 20,
  opticalFlow: 21,
  ascii: 22,
  dither: 23,
  overlay: 24,
  mask: 25,
  maskBlocks: 26,
  chromaKey: 27,
  colorCorrection: 28,
  strobe: 29,
  dataMosh: 0,
  feedback: 0,
  softGlitch: 0,
  hardGlitch: 0,
  pixelSort: 0,
  decimate: 0,
};

const BLEND_MODE_TO_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  add: 4,
  difference: 5,
  softLight: 6,
};

export class EffectStackPipeline {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuf: GPUBuffer;
  private width = 1;
  private height = 1;
  private pingA!: GPUTexture;
  private pingB!: GPUTexture;
  private historyTex!: GPUTexture;
  private hasHistory = false;
  private globals: GlobalOptions = { quality: 1, pause: false, seed: 1 };

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
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const module = this.device.createShaderModule({ code: effectStackSource });
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });

    this.resize(width, height);
  }

  setGlobalOptions(options: GlobalOptions) {
    this.globals = options;
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.pingA = this.createRenderTexture();
    this.pingB = this.createRenderTexture();
    this.historyTex = this.createHistoryTexture();
    this.hasHistory = false;
  }

  render(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    outputTexture: GPUTexture,
    layers: EffectLayer[],
    time: number,
  ) {
    const outputView = outputTexture.createView();
    const active = layers.filter((layer) => layer.enabled && EFFECT_ID_TO_INDEX[layer.effectId] > 0);
    const ordered = [...active].reverse();
    const prevView = this.hasHistory ? this.historyTex.createView() : sourceView;

    if (active.length === 0) {
      this.blit(encoder, sourceView, outputView, 0, 0, 1, 0, [], 0, prevView);
      encoder.copyTextureToTexture(
        { texture: outputTexture },
        { texture: this.historyTex },
        { width: this.width, height: this.height, depthOrArrayLayers: 1 },
      );
      this.hasHistory = true;
      return;
    }

    let readView = sourceView;

    for (let i = 0; i < ordered.length; i += 1) {
      const layer = ordered[i];
      const isLast = i === ordered.length - 1;
      const writeView = isLast ? outputView : (i % 2 === 0 ? this.pingA.createView() : this.pingB.createView());
      const params = Object.values(layer.params);

      this.blit(
        encoder,
        readView,
        writeView,
        EFFECT_ID_TO_INDEX[layer.effectId],
        layer.amount,
        layer.blend,
        BLEND_MODE_TO_INDEX[layer.blendMode ?? "normal"],
        params,
        time,
        prevView,
      );

      if (!isLast) {
        readView = writeView;
      }
    }

    encoder.copyTextureToTexture(
      { texture: outputTexture },
      { texture: this.historyTex },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );
    this.hasHistory = true;
  }

  private blit(
    encoder: GPUCommandEncoder,
    srcView: GPUTextureView,
    dstView: GPUTextureView,
    effectId: number,
    amount: number,
    blend: number,
    blendMode: number,
    params: number[],
    time = 0,
    prevView: GPUTextureView,
  ) {
    const data = new Float32Array(16);
    data[0] = time;
    data[1] = this.width;
    data[2] = this.height;
    data[3] = this.globals.seed;
    data[4] = effectId;
    data[5] = amount;
    data[6] = blend;
    data[7] = blendMode;
    for (let i = 0; i < 8; i += 1) {
      data[8 + i] = params[i] ?? 0;
    }
    this.device.queue.writeBuffer(this.uniformBuf, 0, data);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: srcView },
        { binding: 3, resource: prevView },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  private createRenderTexture(): GPUTexture {
    return this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createHistoryTexture(): GPUTexture {
    return this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }
}
