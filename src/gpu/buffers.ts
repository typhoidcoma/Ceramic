import { MAX_TASK_POINTS } from "./sim/constants";

export const SIM_UNIFORMS_FLOATS = 20;
export const TASK_POINT_FLOATS = 12;

export type RendererConfig = {
  qualityTier: "auto" | "safe" | "balanced" | "high";
  simResolutionScale: number;
  pressureIterations: number;
  fogDensity: number;
  contrast: number;
  grainAmount: number;
  fogBaseLuma: number;
  pigmentAbsorption: number;
  carrierScattering: number;
  inkRetention: number;
  compositeMode: "subtractive_ink_v2";
};

export type TaskPoint = {
  nx: number;
  ny: number;
  nz: number;
  radius: number;
  urgency: number;
  importance: number;
  selected: number;
  hovered: number;
  dirX: number;
  dirY: number;
  coherence: number;
  ink: number;
};

export function createUniformBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({
    label: "sim-uniforms",
    size: SIM_UNIFORMS_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export function createTaskBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({
    label: "task-points",
    size: MAX_TASK_POINTS * TASK_POINT_FLOATS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

export type UniformWriteInput = {
  simWidth: number;
  simHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  nowSec: number;
  dtSec: number;
  fogDensity: number;
  contrast: number;
  grainAmount: number;
  taskCount: number;
  selectedX: number;
  selectedY: number;
  hoveredX: number;
  hoveredY: number;
  compositeSamples: number;
  fogBaseLuma: number;
  pigmentAbsorption: number;
  carrierScattering: number;
  inkRetention: number;
};

export function writeUniforms(device: GPUDevice, buffer: GPUBuffer, input: UniformWriteInput): void {
  const values = new Float32Array(SIM_UNIFORMS_FLOATS);
  values[0] = input.simWidth;
  values[1] = input.simHeight;
  values[2] = input.viewportWidth;
  values[3] = input.viewportHeight;
  values[4] = input.nowSec;
  values[5] = input.dtSec;
  values[6] = input.fogDensity;
  values[7] = input.contrast;
  values[8] = input.grainAmount;
  values[9] = input.taskCount;
  values[10] = input.selectedX;
  values[11] = input.selectedY;
  values[12] = input.hoveredX;
  values[13] = input.hoveredY;
  values[14] = input.compositeSamples;
  values[15] = input.fogBaseLuma;
  values[16] = input.pigmentAbsorption;
  values[17] = input.carrierScattering;
  values[18] = input.inkRetention;
  values[19] = 0;
  device.queue.writeBuffer(buffer, 0, values.buffer);
}

export function writeTaskPoints(device: GPUDevice, buffer: GPUBuffer, points: TaskPoint[]): number {
  const count = Math.min(MAX_TASK_POINTS, points.length);
  const values = new Float32Array(MAX_TASK_POINTS * TASK_POINT_FLOATS);
  const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) && !Number.isNaN(v) ? v : fallback);
  const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
  for (let i = 0; i < count; i += 1) {
    const p = points[i];
    const base = i * TASK_POINT_FLOATS;
    values[base + 0] = clamp01(finiteOr(p.nx, 0.5));
    values[base + 1] = clamp01(finiteOr(p.ny, 0.5));
    values[base + 2] = clamp01(finiteOr(p.nz, 0.5));
    values[base + 3] = Math.max(0, finiteOr(p.radius, 0.001));
    values[base + 4] = clamp01(finiteOr(p.urgency, 0));
    values[base + 5] = clamp01(finiteOr(p.importance, 0));
    values[base + 6] = clamp01(finiteOr(p.selected, 0));
    values[base + 7] = clamp01(finiteOr(p.hovered, 0));
    values[base + 8] = finiteOr(p.dirX, 0);
    values[base + 9] = finiteOr(p.dirY, 0);
    values[base + 10] = clamp01(finiteOr(p.coherence, 0));
    values[base + 11] = clamp01(finiteOr(p.ink, 0));
  }
  device.queue.writeBuffer(buffer, 0, values.buffer);
  return count;
}
