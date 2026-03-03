import type { Atom } from "../data/types";
import { TYPE_TO_ID } from "../data/types";
import { tileSizeForTier } from "../layout/layout";

const INSTANCE_STRIDE_BYTES = 48;
const GLOBALS_SIZE_BYTES = 48;

const FLAG_SELECTED = 1 << 4;
const FLAG_HOVERED = 1 << 5;
const FLAG_PULSING = 1 << 6;
const FLAG_ARCHIVED = 1 << 7;
const FLAG_DIMMED = 1 << 8;

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

function clamp(value: number, min: number, max: number): number {
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

export type InstanceWriteInput = {
  atoms: Atom[];
  hoveredId: string | null;
  selectedId: string | null;
  baseSize: number;
  nowSec: number;
  growthTime: number;
  focusSet: Set<string>;
  mode: "growth_tree" | "legacy";
  projectedById?: Map<string, { x: number; y: number; z: number; scale: number }>;
};

export function writeInstances(device: GPUDevice, buffer: GPUBuffer, input: InstanceWriteInput): number {
  const count = input.atoms.length;
  const array = new ArrayBuffer(count * INSTANCE_STRIDE_BYTES);
  const f32 = new Float32Array(array);
  const u32 = new Uint32Array(array);

  for (let i = 0; i < count; i += 1) {
    const atom = input.atoms[i];
    const baseOffset = i * (INSTANCE_STRIDE_BYTES / 4);
    const projected = input.projectedById?.get(atom.id);
    const baseAtomSize = atom.renderSize > 0 ? atom.renderSize : tileSizeForTier(input.baseSize, atom.sizeTier);
    const depthNorm = clamp((projected?.z ?? atom.z) / 420, -1, 1);
    const growth = clamp01((input.growthTime - atom.treeDepth) * 4.5);
    const scale = projected?.scale ?? 1;
    const roleScale = atom.treeRole === "trunk" ? 1.12 : atom.treeRole === "branch" ? 0.92 : 0.8 + atom.score * 0.4;
    const size = Math.max(3, baseAtomSize * (1 + depthNorm * 0.25) * roleScale * scale * (0.24 + growth * 0.76));

    let flags = TYPE_TO_ID.get(atom.type) ?? 0;
    if (atom.id === input.selectedId) flags |= FLAG_SELECTED;
    if (atom.id === input.hoveredId) flags |= FLAG_HOVERED;
    if (atom.urgency > 0.82 || (atom.due !== undefined && atom.due < input.nowSec * 1000)) flags |= FLAG_PULSING;
    if (atom.state === "archived") flags |= FLAG_ARCHIVED;
    if (input.focusSet.size > 0 && !input.focusSet.has(atom.id)) flags |= FLAG_DIMMED;

    f32[baseOffset + 0] = projected?.x ?? atom.x;
    f32[baseOffset + 1] = projected?.y ?? atom.y;
    f32[baseOffset + 2] = size;
    f32[baseOffset + 3] = depthNorm;
    u32[baseOffset + 4] = colorForAtom(atom);
    u32[baseOffset + 5] = flags >>> 0;
    f32[baseOffset + 6] = atom.ts / 1000;
    f32[baseOffset + 7] = atom.due ? atom.due / 1000 : -1;
    u32[baseOffset + 8] = atom.stableKey;
    f32[baseOffset + 9] = growth;
    u32[baseOffset + 10] = atom.treeRole === "trunk" ? 0 : atom.treeRole === "branch" ? 1 : 2;
    u32[baseOffset + 11] = 0;
  }

  device.queue.writeBuffer(buffer, 0, array);
  return count;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
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
