import { type GpuContext } from "./context";
import { type LogogramGrammar } from "../logogram/grammar";
import shaderSource from "./shader.wgsl?raw";
import particleSource from "./sim.wgsl?raw";
import densitySource from "./density.wgsl?raw";
import logogramSource from "./logogram.wgsl?raw";

const TEX_SIZE = 2048;
const MIP_LEVELS = Math.floor(Math.log2(TEX_SIZE)) + 1;
const PARTICLE_COUNT = 150_000;
const PARTICLE_STRIDE = 32; // bytes per particle
const WG_SIZE = 8;
const LOGO_PARAMS_SIZE = 272; // bytes for LogoParams uniform
const OP_PARAMS_SIZE = 16;   // bytes for OpParams uniform

export class Renderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;

  // Pipelines
  private particlePipeline: GPUComputePipeline;
  private densityPipeline: GPUComputePipeline;
  private renderPipeline: GPURenderPipeline;
  // Logogram multi-pass pipelines
  private genPipeline: GPUComputePipeline;
  private warpPipeline: GPUComputePipeline;
  private blendPipeline: GPUComputePipeline;
  private threshPipeline: GPUComputePipeline;

  // Buffers
  private particleBuf: GPUBuffer;
  private depositBuf: GPUBuffer;
  private paramsBuf: GPUBuffer;
  private renderUniformBuf: GPUBuffer;
  private logoParamsBuf: GPUBuffer;
  private opParamsBuf: GPUBuffer;

  // Textures
  private textureA: GPUTexture; // current target logogram
  private textureB: GPUTexture; // staging for next logogram
  private simTex0: GPUTexture;  // density ping
  private simTex1: GPUTexture;  // density pong
  private scratchTex0: GPUTexture; // logogram gen scratch
  private scratchTex1: GPUTexture; // logogram gen scratch
  private sampler: GPUSampler;

  // Ping-pong state
  private simParity = 0;

  // Bind groups (rebuilt when target changes)
  private particleBG!: GPUBindGroup;
  private densityBG0!: GPUBindGroup;
  private densityBG1!: GPUBindGroup;
  private renderBG0!: GPUBindGroup;
  private renderBG1!: GPUBindGroup;

  // Animation
  private presence = 0;
  private presenceTarget = 0;
  private revealSpeed = 1 / 5.0;
  private dismissSpeed = 1 / 2.5;
  private frameIndex = 0;
  private startTime = performance.now() / 1000;
  private lastFrameTime = 0;
  private animFrame = 0;

  // Transition
  private pendingSwap = false;
  private dismissedAt = 0;

  constructor(gpu: GpuContext) {
    this.device = gpu.device;
    this.context = gpu.context;

    // --- Sampler ---
    this.sampler = this.device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // --- Buffers ---
    this.particleBuf = this.device.createBuffer({
      size: PARTICLE_COUNT * PARTICLE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.depositBuf = this.device.createBuffer({
      size: TEX_SIZE * TEX_SIZE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.paramsBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.renderUniformBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.logoParamsBuf = this.device.createBuffer({
      size: LOGO_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.opParamsBuf = this.device.createBuffer({
      size: OP_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Clear buffers
    this.device.queue.writeBuffer(this.particleBuf, 0, new Uint8Array(PARTICLE_COUNT * PARTICLE_STRIDE));
    this.device.queue.writeBuffer(this.depositBuf, 0, new Uint8Array(TEX_SIZE * TEX_SIZE * 4));

    // --- Textures ---
    this.textureA = this.createTargetTexture();
    this.textureB = this.createTargetTexture();
    this.simTex0 = this.createSimTexture();
    this.simTex1 = this.createSimTexture();
    this.scratchTex0 = this.createSimTexture();
    this.scratchTex1 = this.createSimTexture();
    this.clearSimTextures();

    // --- Pipelines ---
    const particleModule = this.device.createShaderModule({ code: particleSource });
    this.particlePipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: particleModule, entryPoint: "main" },
    });

    const densityModule = this.device.createShaderModule({ code: densitySource });
    this.densityPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: densityModule, entryPoint: "main" },
    });

    const renderModule = this.device.createShaderModule({ code: shaderSource });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: renderModule, entryPoint: "vs" },
      fragment: {
        module: renderModule,
        entryPoint: "fs",
        targets: [{ format: gpu.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    // Logogram multi-pass pipelines (4 entry points, same shader module)
    const logoModule = this.device.createShaderModule({ code: logogramSource });
    this.genPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: logoModule, entryPoint: "genShape" },
    });
    this.warpPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: logoModule, entryPoint: "warpTex" },
    });
    this.blendPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: logoModule, entryPoint: "maxBlend" },
    });
    this.threshPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: logoModule, entryPoint: "inkBlot" },
    });

    this.initMipmapPipeline();
    this.rebuildBindGroups();
  }

  private createTargetTexture(): GPUTexture {
    return this.device.createTexture({
      size: { width: TEX_SIZE, height: TEX_SIZE },
      mipLevelCount: MIP_LEVELS,
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING,
    });
  }

  private createSimTexture(): GPUTexture {
    return this.device.createTexture({
      size: { width: TEX_SIZE, height: TEX_SIZE },
      mipLevelCount: 1,
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST,
    });
  }

  private clearSimTextures() {
    const zeros = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
    for (const tex of [this.simTex0, this.simTex1]) {
      this.device.queue.writeTexture(
        { texture: tex },
        zeros,
        { bytesPerRow: TEX_SIZE * 4 },
        { width: TEX_SIZE, height: TEX_SIZE },
      );
    }
  }

  private clearTexture(tex: GPUTexture) {
    const zeros = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
    this.device.queue.writeTexture(
      { texture: tex, mipLevel: 0 },
      zeros,
      { bytesPerRow: TEX_SIZE * 4 },
      { width: TEX_SIZE, height: TEX_SIZE },
    );
  }

  private rebuildBindGroups() {
    const pLayout = this.particlePipeline.getBindGroupLayout(0);
    const dLayout = this.densityPipeline.getBindGroupLayout(0);
    const rLayout = this.renderPipeline.getBindGroupLayout(0);

    this.particleBG = this.device.createBindGroup({
      layout: pLayout,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuf } },
        { binding: 1, resource: { buffer: this.depositBuf } },
        { binding: 2, resource: this.textureA.createView() },
        { binding: 3, resource: { buffer: this.paramsBuf } },
      ],
    });

    this.densityBG0 = this.device.createBindGroup({
      layout: dLayout,
      entries: [
        { binding: 0, resource: this.simTex0.createView() },
        { binding: 1, resource: this.simTex1.createView() },
        { binding: 2, resource: { buffer: this.depositBuf } },
        { binding: 3, resource: this.textureA.createView() },
        { binding: 4, resource: { buffer: this.paramsBuf } },
      ],
    });

    this.densityBG1 = this.device.createBindGroup({
      layout: dLayout,
      entries: [
        { binding: 0, resource: this.simTex1.createView() },
        { binding: 1, resource: this.simTex0.createView() },
        { binding: 2, resource: { buffer: this.depositBuf } },
        { binding: 3, resource: this.textureA.createView() },
        { binding: 4, resource: { buffer: this.paramsBuf } },
      ],
    });

    this.renderBG0 = this.device.createBindGroup({
      layout: rLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuf } },
        { binding: 1, resource: this.simTex1.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });

    this.renderBG1 = this.device.createBindGroup({
      layout: rLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuf } },
        { binding: 1, resource: this.simTex0.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  // ============================================================
  // LOGOGRAM MULTI-PASS GENERATION
  // ============================================================

  private writeOpParams(mode: number, seed: number, strength: number, freq: number) {
    const buf = new ArrayBuffer(OP_PARAMS_SIZE);
    new Uint32Array(buf, 0, 2).set([mode, seed >>> 0]);
    new Float32Array(buf, 8, 2).set([strength, freq]);
    this.device.queue.writeBuffer(this.opParamsBuf, 0, buf);
  }

  private dispatchGen(mode: number, output: GPUTexture) {
    this.writeOpParams(mode, 0, 0, 0);
    const bg = this.device.createBindGroup({
      layout: this.genPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.logoParamsBuf } },
        { binding: 1, resource: { buffer: this.opParamsBuf } },
        { binding: 5, resource: output.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.genPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(TEX_SIZE / WG_SIZE, TEX_SIZE / WG_SIZE);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private dispatchWarp(
    warpMode: number, seed: number, strength: number, freq: number,
    input: GPUTexture, output: GPUTexture,
  ) {
    this.writeOpParams(warpMode, seed, strength, freq);
    const bg = this.device.createBindGroup({
      layout: this.warpPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: this.opParamsBuf } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: input.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 5, resource: output.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.warpPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(TEX_SIZE / WG_SIZE, TEX_SIZE / WG_SIZE);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private dispatchBlend(a: GPUTexture, b: GPUTexture, output: GPUTexture) {
    const bg = this.device.createBindGroup({
      layout: this.blendPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 3, resource: a.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 4, resource: b.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 5, resource: output.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.blendPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(TEX_SIZE / WG_SIZE, TEX_SIZE / WG_SIZE);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private dispatchInkBlot(input: GPUTexture, output: GPUTexture) {
    const bg = this.device.createBindGroup({
      layout: this.threshPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: input.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 5, resource: output.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.threshPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(TEX_SIZE / WG_SIZE, TEX_SIZE / WG_SIZE);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  generateLogogram(grammar: LogogramGrammar, slot: "A" | "B") {
    const data = packLogoParams(grammar);
    this.device.queue.writeBuffer(this.logoParamsBuf, 0, data);

    const target = slot === "A" ? this.textureA : this.textureB;
    const S0 = this.scratchTex0;
    const S1 = this.scratchTex1;
    const seed = grammar.seed;

    // Clear target (accumulator starts at 0)
    this.clearTexture(target);

    // --- Ring: gen → S0, fluidMorph(S0) → S1, blend(target, S1) → S0 ---
    this.dispatchGen(0, S0);
    this.dispatchWarp(0, seed ^ 0xa1b2c3d4, 0.025, 4.0, S0, S1);
    this.dispatchBlend(target, S1, S0);
    // accum = S0

    // --- Blobs: gen → S1, dotWarp(S1) → target, fluidMorph(target) → S1, blend(S0, S1) → target ---
    // Double-warped per SD graph: dot warp first, then fluid morph
    this.dispatchGen(1, S1);
    this.dispatchWarp(1, seed ^ 0x1f2e3d4c, 0.03, 5.0, S1, target);
    this.dispatchWarp(0, seed ^ 0xd4c3b2a1, 0.04, 4.0, target, S1);
    this.dispatchBlend(S0, S1, target);
    // accum = target

    // --- Tendrils: gen → S1, fluidMorph(S1) → S0, blend(target, S0) → S1 ---
    this.dispatchGen(3, S1);
    this.dispatchWarp(0, seed ^ 0x8d7c6b5a, 0.02, 3.5, S1, S0);
    this.dispatchBlend(target, S0, S1);
    // accum = S1

    // --- Curls: gen → S0, fluidMorph(S0) → target, blend(S1, target) → S0 ---
    this.dispatchGen(2, S0);
    this.dispatchWarp(0, seed ^ 0x5a6b7c8d, 0.035, 5.0, S0, target);
    this.dispatchBlend(S1, target, S0);
    // accum = S0

    // --- Final: dotWarp(S0) → S1, inkBlot(S1) → target ---
    this.dispatchWarp(1, seed ^ 0xe5f6a7b8, 0.018, 3.0, S0, S1);
    this.dispatchInkBlot(S1, target);

    this.generateMipmaps(target);
    if (slot === "A") this.rebuildBindGroups();
  }

  revealA() {
    this.clearSimTextures();
    this.device.queue.writeBuffer(this.particleBuf, 0, new Uint8Array(PARTICLE_COUNT * PARTICLE_STRIDE));
    this.device.queue.writeBuffer(this.depositBuf, 0, new Uint8Array(TEX_SIZE * TEX_SIZE * 4));
    this.presence = 0;
    this.presenceTarget = 1;
  }

  transitionToB() {
    this.presenceTarget = 0;
    this.pendingSwap = true;
    this.dismissedAt = 0;
  }

  private swapAndReveal() {
    const tmp = this.textureA;
    this.textureA = this.textureB;
    this.textureB = tmp;

    this.clearSimTextures();
    this.device.queue.writeBuffer(this.particleBuf, 0, new Uint8Array(PARTICLE_COUNT * PARTICLE_STRIDE));
    this.device.queue.writeBuffer(this.depositBuf, 0, new Uint8Array(TEX_SIZE * TEX_SIZE * 4));

    this.rebuildBindGroups();
    this.presence = 0;
    this.presenceTarget = 1;
    this.pendingSwap = false;
    this.dismissedAt = 0;
  }

  start() {
    this.lastFrameTime = performance.now() / 1000;
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
    const dt = Math.min(0.05, now - this.lastFrameTime);
    this.lastFrameTime = now;
    const time = now - this.startTime;

    if (this.presence < this.presenceTarget) {
      this.presence = Math.min(this.presenceTarget, this.presence + dt * this.revealSpeed);
    } else if (this.presence > this.presenceTarget) {
      this.presence = Math.max(this.presenceTarget, this.presence - dt * this.dismissSpeed);
    }

    if (this.pendingSwap && this.presence <= 0.01) {
      if (this.dismissedAt === 0) this.dismissedAt = now;
      if (now - this.dismissedAt > 0.8) this.swapAndReveal();
    }

    const paramsData = new ArrayBuffer(16);
    new Float32Array(paramsData, 0, 2).set([this.presence, time]);
    new Uint32Array(paramsData, 8, 2).set([this.frameIndex, PARTICLE_COUNT]);
    this.device.queue.writeBuffer(this.paramsBuf, 0, paramsData);

    this.device.queue.writeBuffer(this.renderUniformBuf, 0, new Float32Array([
      time,
      this.context.canvas.width,
      this.context.canvas.height,
      this.presence,
    ]));

    const encoder = this.device.createCommandEncoder();

    const particlePass = encoder.beginComputePass();
    particlePass.setPipeline(this.particlePipeline);
    particlePass.setBindGroup(0, this.particleBG);
    particlePass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
    particlePass.end();

    const densityBG = this.simParity === 0 ? this.densityBG0 : this.densityBG1;
    const densityPass = encoder.beginComputePass();
    densityPass.setPipeline(this.densityPipeline);
    densityPass.setBindGroup(0, densityBG);
    densityPass.dispatchWorkgroups(TEX_SIZE / WG_SIZE, TEX_SIZE / WG_SIZE);
    densityPass.end();

    const renderBG = this.simParity === 0 ? this.renderBG0 : this.renderBG1;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: "clear", storeOp: "store",
        clearValue: { r: 0.28, g: 0.30, b: 0.33, a: 1 },
      }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, renderBG);
    pass.draw(6);
    pass.end();

    this.device.queue.submit([encoder.finish()]);

    this.simParity = 1 - this.simParity;
    this.frameIndex++;
  }

  // --- Mipmap generation ---
  private mipmapPipeline!: GPURenderPipeline;
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
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  private generateMipmaps(texture: GPUTexture) {
    const encoder = this.device.createCommandEncoder();
    let srcView = texture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    for (let level = 1; level < MIP_LEVELS; level++) {
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bg = this.device.createBindGroup({
        layout: this.mipmapPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: srcView },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: dstView, loadOp: "clear", storeOp: "store",
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
        }],
      });
      pass.setPipeline(this.mipmapPipeline);
      pass.setBindGroup(0, bg);
      pass.draw(6);
      pass.end();
      srcView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
    }
    this.device.queue.submit([encoder.finish()]);
  }
}

// Pack LogogramGrammar into the 272-byte uniform buffer matching LogoParams struct
function packLogoParams(g: LogogramGrammar): ArrayBuffer {
  const buf = new ArrayBuffer(LOGO_PARAMS_SIZE);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);

  const PI = Math.PI;
  const TAU = PI * 2;
  const SECTOR_COUNT = 12;

  // Header: offset 0-15 (indices 0-3)
  u32[0] = g.seed;
  f32[1] = g.ringRadius;
  const blobCount = Math.min(g.blobs.length, 4);
  const curlCount = Math.min(g.smallCurls.length, 8);
  const tendrilCount = Math.min(g.tendrils.length, 4);
  const gapCount = Math.min(g.gaps.length, 4);
  u32[2] = blobCount | (curlCount << 8) | (tendrilCount << 16) | (gapCount << 24);

  let sectorActive = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (g.sectors[i]?.active) sectorActive |= 1 << i;
  }
  u32[3] = sectorActive;

  // Sector thickness: offset 16-63 (indices 4-15)
  for (let i = 0; i < 12; i++) {
    f32[4 + i] = g.sectors[i]?.thickness ?? 0;
  }

  // Blobs: offset 64-127 (indices 16-31), each vec4f(theta, arcSpan, size, radialBias)
  for (let i = 0; i < 4; i++) {
    const base = 16 + i * 4;
    const b = g.blobs[i];
    f32[base] = b?.theta ?? 0;
    f32[base + 1] = b?.arcSpan ?? 0;
    f32[base + 2] = b?.size ?? 0;
    f32[base + 3] = b?.radialBias ?? 0;
  }

  // Curls: offset 128-191 (indices 32-47), packed vec4f(theta0, size0, theta1, size1)
  for (let i = 0; i < 8; i++) {
    const base = 32 + i * 2;
    const c = g.smallCurls[i];
    f32[base] = c?.theta ?? 0;
    f32[base + 1] = c?.size ?? 0;
  }

  // Tendrils: offset 192-255 (indices 48-63), each vec4f(theta, lengthFactor, 0, 0)
  for (let i = 0; i < 4; i++) {
    const base = 48 + i * 4;
    const t = g.tendrils[i];
    f32[base] = t?.theta ?? 0;
    f32[base + 1] = t?.lengthFactor ?? 0;
    f32[base + 2] = 0;
    f32[base + 3] = 0;
  }

  // Gaps: offset 256-271 (indices 64-67), gap angles
  for (let i = 0; i < 4; i++) {
    const gap = g.gaps[i];
    if (gap) {
      f32[64 + i] = -PI + (gap.startSector + 0.5) * (TAU / SECTOR_COUNT);
    } else {
      f32[64 + i] = 0;
    }
  }

  return buf;
}
