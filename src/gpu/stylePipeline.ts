import styleSource from "./style.wgsl?raw";

export type StyleParams = {
  stretch: number;
  wave: number;
  pushAmount: number;
  bulge: number;
  transformAmt: number;
  transform3d: number;
  splitter: number;
  tile: number;
  kaleidoscope: number;
  vhs: number;
  super8: number;
  crt: number;
  cga: number;
  lightStreak: number;
  bleach: number;
  watercolor: number;
  grain: number;
  sharpen: number;
  blur: number;
  lumaMesh: number;
  opticalFlow: number;
  asciiFx: number;
  dither: number;
  overlay: number;
  mask: number;
  maskBlocks: number;
  chromaKey: number;
  audioViz: number;
  colorCorrection: number;
  strobe: number;
};

export const DEFAULT_STYLE_PARAMS: StyleParams = {
  stretch: 0,
  wave: 0,
  pushAmount: 0,
  bulge: 0,
  transformAmt: 0,
  transform3d: 0,
  splitter: 0,
  tile: 0,
  kaleidoscope: 0,
  vhs: 0,
  super8: 0,
  crt: 0,
  cga: 0,
  lightStreak: 0,
  bleach: 0,
  watercolor: 0,
  grain: 0,
  sharpen: 0,
  blur: 0,
  lumaMesh: 0,
  opticalFlow: 0,
  asciiFx: 0,
  dither: 0,
  overlay: 0,
  mask: 0,
  maskBlocks: 0,
  chromaKey: 0,
  audioViz: 0,
  colorCorrection: 0,
  strobe: 0,
};

export class StylePipeline {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuf: GPUBuffer;
  private params: StyleParams = { ...DEFAULT_STYLE_PARAMS };

  constructor(device: GPUDevice, format: GPUTextureFormat) {
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
      size: 176,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const module = this.device.createShaderModule({ code: styleSource });
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  setParams(params: Partial<StyleParams>) {
    this.params = { ...this.params, ...params };
  }

  render(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    outputView: GPUTextureView,
    time: number,
    width: number,
    height: number,
  ) {
    const p = this.params;
    const data = new Float32Array(44);
    data[0] = time;
    data[1] = width;
    data[2] = height;
    data[3] = 0;

    data[4] = p.stretch;
    data[5] = p.wave;
    data[6] = p.pushAmount;
    data[7] = p.bulge;

    data[8] = p.transformAmt;
    data[9] = p.transform3d;
    data[10] = p.splitter;
    data[11] = p.tile;

    data[12] = p.kaleidoscope;
    data[13] = p.vhs;
    data[14] = p.super8;
    data[15] = p.crt;

    data[16] = p.cga;
    data[17] = p.lightStreak;
    data[18] = p.bleach;
    data[19] = p.watercolor;

    data[20] = p.grain;
    data[21] = p.sharpen;
    data[22] = p.blur;
    data[23] = p.lumaMesh;

    data[24] = p.opticalFlow;
    data[25] = p.asciiFx;
    data[26] = p.dither;
    data[27] = p.overlay;

    data[28] = p.mask;
    data[29] = p.maskBlocks;
    data[30] = p.chromaKey;
    data[31] = p.audioViz;

    data[32] = p.colorCorrection;
    data[33] = p.strobe;

    this.device.queue.writeBuffer(this.uniformBuf, 0, data);

    const bg = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: sourceView },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }
}
