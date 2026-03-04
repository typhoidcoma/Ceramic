import type { Atom } from "../../data/types";

export type Camera3DState = {
  yaw: number;
  pitch: number;
  distance: number;
  targetX: number;
  targetY: number;
  targetZ: number;
};

export function createCamera3D(): Camera3DState {
  return {
    yaw: 0.2,
    pitch: 0.24,
    distance: 680,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
  };
}

export function tickCamera(camera: Camera3DState, dtSec: number): void {
  camera.yaw += dtSec * 0.07;
  camera.pitch = 0.24 + Math.sin(performance.now() * 0.00021) * 0.05;
}

export function projectAtomToScreen(atom: Atom, width: number, height: number, camera: Camera3DState): { x: number; y: number; r: number } | null {
  const forward = {
    x: Math.cos(camera.pitch) * Math.sin(camera.yaw),
    y: Math.sin(camera.pitch),
    z: Math.cos(camera.pitch) * Math.cos(camera.yaw),
  };
  const upWorld = { x: 0, y: 1, z: 0 };
  const right = normalize(cross(forward, upWorld));
  const up = normalize(cross(right, forward));
  const cam = {
    x: camera.targetX - forward.x * camera.distance,
    y: camera.targetY - forward.y * camera.distance,
    z: camera.targetZ - forward.z * camera.distance,
  };

  const rel = { x: atom.x - cam.x, y: atom.y - cam.y, z: atom.z - cam.z };
  const cx = dot(rel, right);
  const cy = dot(rel, up);
  const cz = dot(rel, forward);
  if (cz <= 6) return null;

  const aspect = width / Math.max(1, height);
  const f = 1 / Math.tan((52 * Math.PI) / 180 / 2);
  const ndcX = (cx * f) / (cz * aspect);
  const ndcY = (cy * f) / cz;
  const sx = (ndcX * 0.5 + 0.5) * width;
  const sy = (0.5 - ndcY * 0.5) * height;
  const r = Math.max(4, atom.renderSize * (camera.distance / cz) * 0.15);
  return { x: sx, y: sy, r };
}

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(v: { x: number; y: number; z: number }) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
