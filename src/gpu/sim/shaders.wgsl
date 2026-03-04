struct Globals {
  simWidth : f32,
  simHeight : f32,
  viewportWidth : f32,
  viewportHeight : f32,
  nowSec : f32,
  dtSec : f32,
  fogDensity : f32,
  haloStrength : f32,
  contrast : f32,
  grainAmount : f32,
  taskCount : f32,
  selectedX : f32,
  selectedY : f32,
  hoveredX : f32,
  hoveredY : f32,
  compositeSamples : f32,
}

struct TaskPoint {
  pos : vec4f,
  attrs : vec4f,
  flow : vec4f,
}

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var<storage, read> densityRead : array<f32>;
@group(0) @binding(2) var<storage, read_write> densityWrite : array<f32>;
@group(0) @binding(3) var<storage, read> velocityRead : array<vec2f>;
@group(0) @binding(4) var<storage, read_write> velocityWrite : array<vec2f>;
@group(0) @binding(5) var<storage, read> pressureRead : array<f32>;
@group(0) @binding(6) var<storage, read_write> pressureWrite : array<f32>;
@group(0) @binding(7) var<storage, read_write> divergence : array<f32>;
@group(0) @binding(8) var<storage, read> tasks : array<TaskPoint>;

fn dims() -> vec2u {
  return vec2u(u32(max(1.0, globals.simWidth)), u32(max(1.0, globals.simHeight)));
}

fn toIndex(x: u32, y: u32, d: vec2u) -> u32 {
  return y * d.x + x;
}

fn clampCoord(x: i32, y: i32, d: vec2u) -> vec2u {
  let cx = u32(clamp(x, 0, i32(d.x) - 1));
  let cy = u32(clamp(y, 0, i32(d.y) - 1));
  return vec2u(cx, cy);
}

fn sampleScalar(buffer: ptr<storage, array<f32>, read>, x: i32, y: i32, d: vec2u) -> f32 {
  let c = clampCoord(x, y, d);
  return (*buffer)[toIndex(c.x, c.y, d)];
}

fn sampleVelocity(x: i32, y: i32, d: vec2u) -> vec2f {
  let c = clampCoord(x, y, d);
  return velocityRead[toIndex(c.x, c.y, d)];
}

fn hashNoise(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

@compute @workgroup_size(8, 8, 1)
fn inject_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  let uv = vec2f((f32(gid.x) + 0.5) / f32(d.x), (f32(gid.y) + 0.5) / f32(d.y));

  var density = densityRead[idx] * 0.994;
  var velocity = velocityRead[idx] * 0.992;

  let count = u32(globals.taskCount);
  for (var i = 0u; i < count; i = i + 1u) {
    let tp = tasks[i];
    let p = tp.pos.xy;
    let r = max(0.0008, tp.pos.w);
    let delta = uv - p;
    let dist = length(delta);
    let falloff = exp(-(dist * dist) / (2.0 * r * r));
    let selectedBoost = 1.0 + tp.attrs.z * 0.9;
    let hoveredBoost = 1.0 + tp.attrs.w * 0.55;
    let energy = falloff * (0.16 + tp.attrs.x * 0.65 + tp.attrs.y * 0.45) * selectedBoost * hoveredBoost;
    let strokeDirRaw = tp.flow.xy;
    let strokeLen = max(0.0001, length(strokeDirRaw));
    let strokeDir = strokeDirRaw / strokeLen;
    let radialDir = normalize(delta + vec2f(0.0001, 0.0001));
    let ortho = vec2f(-strokeDir.y, strokeDir.x);
    let track = abs(dot(radialDir, ortho));
    let coherence = clamp(tp.flow.z, 0.0, 1.0);
    let ink = clamp(tp.flow.w, 0.0, 1.0);
    let anisotropic = mix(1.0, 0.45 + track * 0.55, coherence);
    density = min(3.0, density + energy * anisotropic * (0.58 + 0.52 * ink) * globals.fogDensity);

    let swirl = normalize(vec2f(-delta.y, delta.x) + vec2f(0.0001, 0.0002));
    let guided = normalize(mix(swirl, strokeDir, coherence));
    let push = energy * (0.006 + tp.attrs.x * 0.04 + ink * 0.012);
    velocity += guided * push;
    velocity += radialDir * push * 0.15 * (1.0 - coherence);
  }

  densityWrite[idx] = density;
  velocityWrite[idx] = velocity;
}

@compute @workgroup_size(8, 8, 1)
fn velocity_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  let uv = vec2f(f32(gid.x) / f32(d.x), f32(gid.y) / f32(d.y));
  let n = hashNoise(uv * 7.0 + vec2f(globals.nowSec * 0.07, globals.nowSec * 0.11));
  let swirl = vec2f(cos(n * 6.2831), sin(n * 6.2831));
  let buoyancy = vec2f(0.0, -densityRead[idx] * 0.0036);
  let velocity = velocityRead[idx] * 0.986 + swirl * 0.0018 + buoyancy;
  velocityWrite[idx] = velocity;
  densityWrite[idx] = densityRead[idx];
}

@compute @workgroup_size(8, 8, 1)
fn advect_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  let pos = vec2f(f32(gid.x), f32(gid.y));
  let vel = velocityRead[idx];
  let back = pos - vel * globals.dtSec * 60.0;
  let bx = i32(round(back.x));
  let by = i32(round(back.y));
  let b = clampCoord(bx, by, d);
  let bIdx = toIndex(b.x, b.y, d);
  densityWrite[idx] = max(0.0, densityRead[bIdx] * 0.997);
  velocityWrite[idx] = velocityRead[bIdx] * 0.998;
}

@compute @workgroup_size(8, 8, 1)
fn divergence_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let idx = toIndex(gid.x, gid.y, d);
  let l = sampleVelocity(x - 1, y, d).x;
  let r = sampleVelocity(x + 1, y, d).x;
  let b = sampleVelocity(x, y - 1, d).y;
  let t = sampleVelocity(x, y + 1, d).y;
  divergence[idx] = 0.5 * ((r - l) + (t - b));
}

@compute @workgroup_size(8, 8, 1)
fn pressure_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let idx = toIndex(gid.x, gid.y, d);
  let l = sampleScalar(&pressureRead, x - 1, y, d);
  let r = sampleScalar(&pressureRead, x + 1, y, d);
  let b = sampleScalar(&pressureRead, x, y - 1, d);
  let t = sampleScalar(&pressureRead, x, y + 1, d);
  pressureWrite[idx] = (l + r + b + t - divergence[idx]) * 0.25;
}

@compute @workgroup_size(8, 8, 1)
fn projection_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let idx = toIndex(gid.x, gid.y, d);
  let l = sampleScalar(&pressureRead, x - 1, y, d);
  let r = sampleScalar(&pressureRead, x + 1, y, d);
  let b = sampleScalar(&pressureRead, x, y - 1, d);
  let t = sampleScalar(&pressureRead, x, y + 1, d);
  let grad = vec2f(r - l, t - b) * 0.5;
  velocityWrite[idx] = velocityRead[idx] - grad;
  densityWrite[idx] = densityRead[idx];
}

@compute @workgroup_size(8, 8, 1)
fn damp_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  let focus = vec2f(globals.selectedX, globals.selectedY);
  let uv = vec2f((f32(gid.x) + 0.5) / f32(d.x), (f32(gid.y) + 0.5) / f32(d.y));
  let dist = length(uv - focus);
  let localLift = exp(-dist * 16.0) * 0.05;
  densityWrite[idx] = max(0.0, densityRead[idx] * 0.997 + localLift);
  velocityWrite[idx] = velocityRead[idx] * 0.993;
}

struct VsOut {
  @builtin(position) position : vec4f,
  @location(0) uv : vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) i: u32) -> VsOut {
  var out: VsOut;
  let pos = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0),
    vec2f(1.0, 1.0),
    vec2f(-1.0, 1.0)
  );
  let p = pos[i];
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = p * 0.5 + vec2f(0.5, 0.5);
  return out;
}

fn sampleDensityUv(uv: vec2f, d: vec2u) -> f32 {
  let x = u32(clamp(i32(uv.x * f32(d.x)), 0, i32(d.x) - 1));
  let y = u32(clamp(i32(uv.y * f32(d.y)), 0, i32(d.y) - 1));
  return densityRead[toIndex(x, y, d)];
}

@fragment
fn fs_volume(in: VsOut) -> @location(0) vec4f {
  let d = dims();
  var fog = sampleDensityUv(in.uv, d);

  let steps = max(8.0, globals.compositeSamples);
  for (var i = 0.0; i < steps; i = i + 1.0) {
    let t = i / steps;
    let drift = vec2f(sin(globals.nowSec * 0.07 + t * 6.0), cos(globals.nowSec * 0.08 + t * 5.0)) * (0.012 + t * 0.025);
    fog += sampleDensityUv(fract(in.uv + drift), d) * (0.06 + 0.09 * (1.0 - t));
  }

  let count = u32(globals.taskCount);
  var halo = 0.0;
  for (var i = 0u; i < count; i = i + 1u) {
    let tp = tasks[i];
    let delta = in.uv - tp.pos.xy;
    let r = max(0.001, tp.pos.w * 1.5);
    let dist = length(delta);
    let edge = smoothstep(r * 1.3, r * 0.55, dist);
    let ring = smoothstep(r * 0.9, r * 0.7, dist) - smoothstep(r * 0.62, r * 0.45, dist);
    let boost = 1.0 + tp.attrs.z * 0.8 + tp.attrs.w * 0.45;
    let coherenceBoost = 0.8 + clamp(tp.flow.z, 0.0, 1.0) * 0.4;
    halo += (edge * 0.08 + ring * 0.3) * tp.attrs.y * boost * coherenceBoost;
  }

  let grain = (hashNoise(in.uv * globals.viewportWidth + vec2f(globals.nowSec * 8.7, globals.nowSec * 5.1)) - 0.5) * globals.grainAmount;
  var luminance = pow(clamp(fog * globals.fogDensity * 0.14 + halo * globals.haloStrength + 0.05 + grain, 0.0, 1.0), max(0.3, 1.45 - globals.contrast));
  luminance = clamp(luminance, 0.0, 1.0);
  let vignette = smoothstep(1.18, 0.34, length(in.uv - vec2f(0.5, 0.5)));
  let finalLuma = clamp(luminance * vignette, 0.0, 1.0);
  return vec4f(vec3f(finalLuma), 1.0);
}
