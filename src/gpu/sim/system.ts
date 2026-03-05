import { copyBuffer, createSimulationResources, type SimulationResources } from "./resources";
import { QUALITY_PRESETS, type QualityTier } from "./constants";
import { runInjectionPass } from "./passes/injection";
import { runVelocityPass } from "./passes/velocity";
import { runAdvectionPass } from "./passes/advection";
import { runDivergencePass } from "./passes/divergence";
import { runPressurePass } from "./passes/pressure";
import { runProjectionPass } from "./passes/projection";
import { runDampPass } from "./passes/damp";
import type { PipelineBundle } from "../pipeline";

export type SimulationSystem = {
  resources: SimulationResources;
  computeBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
  qualityTier: QualityTier;
  simResolutionScale: number;
  pressureIterations: number;
  compositeSamples: number;
};

export function createSimulationSystem(
  device: GPUDevice,
  pipelines: PipelineBundle,
  uniformBuffer: GPUBuffer,
  viewportWidth: number,
  viewportHeight: number,
  qualityTier: QualityTier,
  simResolutionScale: number,
): SimulationSystem {
  const preset = QUALITY_PRESETS[qualityTier];
  const effectiveScale = Math.max(0.22, Math.min(0.85, simResolutionScale));
  const simWidth = Math.max(64, Math.floor(viewportWidth * effectiveScale));
  const simHeight = Math.max(64, Math.floor(viewportHeight * effectiveScale));
  const resources = createSimulationResources(device, simWidth, simHeight);

  const computeBindGroup = device.createBindGroup({
    layout: pipelines.computeBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: resources.carrierRead } },
      { binding: 2, resource: { buffer: resources.carrierWrite } },
      { binding: 3, resource: { buffer: resources.pigmentRead } },
      { binding: 4, resource: { buffer: resources.pigmentWrite } },
      { binding: 5, resource: { buffer: resources.velocityRead } },
      { binding: 6, resource: { buffer: resources.velocityWrite } },
      { binding: 7, resource: { buffer: resources.pressureRead } },
      { binding: 8, resource: { buffer: resources.pressureWrite } },
      { binding: 9, resource: { buffer: resources.divergence } },
      { binding: 10, resource: { buffer: resources.targetDensity } },
    ],
  });

  const renderBindGroup = device.createBindGroup({
    layout: pipelines.renderBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: resources.carrierRead } },
      { binding: 2, resource: { buffer: resources.pigmentRead } },
    ],
  });

  return {
    resources,
    computeBindGroup,
    renderBindGroup,
    qualityTier,
    simResolutionScale: effectiveScale,
    pressureIterations: preset.pressureIterations,
    compositeSamples: preset.compositeSamples,
  };
}

function dispatchAll(
  pass: GPUComputePassEncoder,
  system: SimulationSystem,
  pipelines: PipelineBundle,
  pressureIterations: number,
): void {
  const ctx = {
    pass,
    bindGroup: system.computeBindGroup,
    width: system.resources.simWidth,
    height: system.resources.simHeight,
  };
  runVelocityPass(ctx, pipelines.velocity);
  runAdvectionPass(ctx, pipelines.advection);
  runDivergencePass(ctx, pipelines.divergence);
  for (let i = 0; i < pressureIterations; i += 1) {
    runPressurePass(ctx, pipelines.pressure);
  }
  runProjectionPass(ctx, pipelines.projection);
  runDampPass(ctx, pipelines.damp);
  runInjectionPass(ctx, pipelines.injection);
}

export function runSimulationStep(
  encoder: GPUCommandEncoder,
  system: SimulationSystem,
  pipelines: PipelineBundle,
  pressureIterations: number,
): void {
  const pass = encoder.beginComputePass();
  dispatchAll(pass, system, pipelines, pressureIterations);
  pass.end();

  const scalarBytes = system.resources.cellCount * 4;
  const vec2Bytes = system.resources.cellCount * 8;
  copyBuffer(encoder, system.resources.carrierWrite, system.resources.carrierRead, scalarBytes);
  copyBuffer(encoder, system.resources.pigmentWrite, system.resources.pigmentRead, scalarBytes);
  copyBuffer(encoder, system.resources.velocityWrite, system.resources.velocityRead, vec2Bytes);
  copyBuffer(encoder, system.resources.pressureWrite, system.resources.pressureRead, scalarBytes);
}

export function drawVolume(
  encoder: GPUCommandEncoder,
  target: GPUTextureView,
  system: SimulationSystem,
  pipelines: PipelineBundle,
): void {
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: target,
        loadOp: "clear",
        clearValue: { r: 0.68, g: 0.69, b: 0.72, a: 1 },
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipelines.render);
  pass.setBindGroup(0, system.renderBindGroup);
  pass.draw(6, 1, 0, 0);
  pass.end();
}
