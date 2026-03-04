import { MAX_TASK_POINTS } from "./sim/constants";

export const SIM_UNIFORMS_FLOATS = 16;
export const TASK_POINT_FLOATS = 12;

export type RendererConfig = {
  qualityTier: "auto" | "safe" | "balanced" | "high";
  simResolutionScale: number;
  pressureIterations: number;
  haloStrength: number;
  fogDensity: number;
  contrast: number;
  grainAmount: number;
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
  haloStrength: number;
  contrast: number;
  grainAmount: number;
  taskCount: number;
  selectedX: number;
  selectedY: number;
  hoveredX: number;
  hoveredY: number;
  compositeSamples: number;
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
  values[7] = input.haloStrength;
  values[8] = input.contrast;
  values[9] = input.grainAmount;
  values[10] = input.taskCount;
  values[11] = input.selectedX;
  values[12] = input.selectedY;
  values[13] = input.hoveredX;
  values[14] = input.hoveredY;
  values[15] = input.compositeSamples;
  device.queue.writeBuffer(buffer, 0, values.buffer);
}

export function writeTaskPoints(device: GPUDevice, buffer: GPUBuffer, points: TaskPoint[]): number {
  const count = Math.min(MAX_TASK_POINTS, points.length);
  const values = new Float32Array(MAX_TASK_POINTS * TASK_POINT_FLOATS);
  for (let i = 0; i < count; i += 1) {
    const p = points[i];
    const base = i * TASK_POINT_FLOATS;
    values[base + 0] = p.nx;
    values[base + 1] = p.ny;
    values[base + 2] = p.nz;
    values[base + 3] = p.radius;
    values[base + 4] = p.urgency;
    values[base + 5] = p.importance;
    values[base + 6] = p.selected;
    values[base + 7] = p.hovered;
    values[base + 8] = p.dirX;
    values[base + 9] = p.dirY;
    values[base + 10] = p.coherence;
    values[base + 11] = p.ink;
  }
  device.queue.writeBuffer(buffer, 0, values.buffer);
  return count;
}
