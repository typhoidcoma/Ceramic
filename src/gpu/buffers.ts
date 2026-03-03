import type { Atom } from "../data/types";
import { TYPE_TO_ID } from "../data/types";
import { sizeFromTier } from "../layout/spatialHash";

const INSTANCE_STRIDE_BYTES = 48;
const GLOBALS_SIZE_BYTES = 48;

const FLAG_SELECTED = 1 << 4;
const FLAG_HOVERED = 1 << 5;
const FLAG_PULSING = 1 << 6;
const FLAG_ARCHIVED = 1 << 7;

export type GpuBuffers = {
  instanceBuffer: GPUBuffer;
  globalsBuffer: GPUBuffer;
  maxInstances: number;
};

export function createBuffers(device: GPUDevice, maxInstances: number): GpuBuffers {
  const instanceBuffer = device.createBuffer({
    label: "instances",
    size: maxInstances * INSTANCE_STRIDE_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const globalsBuffer = device.createBuffer({
    label: "globals",
    size: GLOBALS_SIZE_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  return { instanceBuffer, globalsBuffer, maxInstances };
}

function packRgba8(r: number, g: number, b: number, a = 255): number {
  return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
}

function colorForAtom(atom: Atom): number {
  const palette: Record<string, [number, number, number]> = {
    task: [92, 201, 140],
    date: [72, 175, 240],
    message: [255, 176, 79],
    email: [255, 128, 128],
    image: [181, 146, 245],
    file: [143, 221, 219],
    event: [240, 215, 90],
    custom: [188, 188, 188],
  };
  const [r, g, b] = palette[atom.type] ?? [180, 180, 180];
  return packRgba8(r, g, b, 255);
}

export type InstanceWriteInput = {
  atoms: Atom[];
  hoveredId: string | null;
  selectedId: string | null;
  baseSize: number;
  nowSec: number;
};

export function writeInstances(device: GPUDevice, buffer: GPUBuffer, input: InstanceWriteInput): number {
  const count = input.atoms.length;
  const array = new ArrayBuffer(count * INSTANCE_STRIDE_BYTES);
  const f32 = new Float32Array(array);
  const u32 = new Uint32Array(array);

  for (let i = 0; i < count; i += 1) {
    const atom = input.atoms[i];
    const baseOffset = i * (INSTANCE_STRIDE_BYTES / 4);
    const sizeScale = sizeFromTier(atom.sizeTier);
    const size = input.baseSize * sizeScale;

    let flags = TYPE_TO_ID.get(atom.type) ?? 0;
    if (atom.id === input.selectedId) flags |= FLAG_SELECTED;
    if (atom.id === input.hoveredId) flags |= FLAG_HOVERED;
    if (atom.urgency > 0.82 || (atom.due !== undefined && atom.due < input.nowSec * 1000)) flags |= FLAG_PULSING;
    if (atom.state === "archived") flags |= FLAG_ARCHIVED;

    f32[baseOffset + 0] = atom.x;
    f32[baseOffset + 1] = atom.y;
    f32[baseOffset + 2] = size;
    f32[baseOffset + 3] = atom.urgency;
    u32[baseOffset + 4] = colorForAtom(atom);
    u32[baseOffset + 5] = flags >>> 0;
    f32[baseOffset + 6] = atom.ts / 1000;
    f32[baseOffset + 7] = atom.due ? atom.due / 1000 : -1;
    u32[baseOffset + 8] = atom.stableKey;
    u32[baseOffset + 9] = 0;
    u32[baseOffset + 10] = 0;
    u32[baseOffset + 11] = 0;
  }

  device.queue.writeBuffer(buffer, 0, array);
  return count;
}

export type GlobalsWriteInput = {
  widthPx: number;
  heightPx: number;
  camX: number;
  camY: number;
  zoom: number;
  nowSec: number;
  baseSize: number;
  pixelRatio: number;
  hoveredStableKey: number;
  selectedStableKey: number;
};

export function writeGlobals(device: GPUDevice, buffer: GPUBuffer, input: GlobalsWriteInput): void {
  const array = new ArrayBuffer(GLOBALS_SIZE_BYTES);
  const f32 = new Float32Array(array);
  const u32 = new Uint32Array(array);

  f32[0] = input.widthPx;
  f32[1] = input.heightPx;
  f32[2] = input.camX;
  f32[3] = input.camY;
  f32[4] = input.zoom;
  f32[5] = input.nowSec;
  f32[6] = input.baseSize;
  f32[7] = input.pixelRatio;
  u32[8] = input.hoveredStableKey >>> 0;
  u32[9] = input.selectedStableKey >>> 0;
  u32[10] = 0;
  u32[11] = 0;

  device.queue.writeBuffer(buffer, 0, array);
}
