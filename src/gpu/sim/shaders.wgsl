struct Globals {
  simWidth : f32,
  simHeight : f32,
  viewportWidth : f32,
  viewportHeight : f32,
  nowSec : f32,
  dtSec : f32,
  fogDensity : f32,
  contrast : f32,
  grainAmount : f32,
  taskCount : f32,
  selectedX : f32,
  selectedY : f32,
  hoveredX : f32,
  hoveredY : f32,
  compositeSamples : f32,
  fogBaseLuma : f32,
  pigmentAbsorption : f32,
  carrierScattering : f32,
  inkRetention : f32,
  pad0 : f32,
}

struct TaskPoint {
  pos : vec4f,
  attrs : vec4f,
  flow : vec4f,
}

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var<storage, read> carrierRead : array<f32>;
@group(0) @binding(2) var<storage, read_write> carrierWrite : array<f32>;
@group(0) @binding(3) var<storage, read> pigmentRead : array<f32>;
@group(0) @binding(4) var<storage, read_write> pigmentWrite : array<f32>;
@group(0) @binding(5) var<storage, read> velocityRead : array<vec2f>;
@group(0) @binding(6) var<storage, read_write> velocityWrite : array<vec2f>;
@group(0) @binding(7) var<storage, read> pressureRead : array<f32>;
@group(0) @binding(8) var<storage, read_write> pressureWrite : array<f32>;
@group(0) @binding(9) var<storage, read_write> divergence : array<f32>;
@group(0) @binding(10) var<storage, read> tasks : array<TaskPoint>;

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

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hashNoise(i);
  let b = hashNoise(i + vec2f(1.0, 0.0));
  let c = hashNoise(i + vec2f(0.0, 1.0));
  let d = hashNoise(i + vec2f(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p: vec2f, octaves: i32) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var f = 1.0;
  for (var i = 0; i < octaves; i = i + 1) {
    v += (valueNoise(p * f) * 2.0 - 1.0) * a;
    f *= 1.95;
    a *= 0.55;
  }
  return v;
}

@compute @workgroup_size(8, 8, 1)
fn inject_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  let uv = vec2f((f32(gid.x) + 0.5) / f32(d.x), (f32(gid.y) + 0.5) / f32(d.y));

  var carrier = carrierWrite[idx] * 0.9985;
  var pigment = pigmentWrite[idx] * clamp(globals.inkRetention, 0.9, 0.9999);
  var velocity = velocityWrite[idx] * 0.992;

  let count = u32(globals.taskCount);
  for (var i = 0u; i < count; i = i + 1u) {
    let tp = tasks[i];
    let p = tp.pos.xy;
    let r = max(0.0008, tp.pos.w);
    let delta = uv - p;
    let dist = length(delta);
    let falloff = exp(-(dist * dist) / (2.0 * r * r));

    let injectorStrength = clamp(tp.attrs.x, 0.0, 1.0);
    let depositionRate = clamp(tp.attrs.y, 0.0, 1.0);
    let anisotropy = clamp(tp.flow.z, 0.0, 1.0);
    let pigmentBias = clamp(tp.flow.w, 0.0, 1.0);

    let strokeDirRaw = tp.flow.xy;
    let strokeLen = max(0.0001, length(strokeDirRaw));
    let strokeDir = strokeDirRaw / strokeLen;
    let ortho = vec2f(-strokeDir.y, strokeDir.x);

    // Blend capsule and streak kernels per-point to avoid repeated ellipse stamps.
    let along = dot(delta, strokeDir);
    let across = dot(delta, ortho);
    let rShort = max(0.0006, r * (0.42 + 0.12 * (1.0 - anisotropy)));
    let rLong = max(rShort * 1.25, r * (1.15 + anisotropy * 1.9));
    let ellipse = exp(-0.5 * ((along * along) / (rLong * rLong) + (across * across) / (rShort * rShort)));
    let streakLong = max(rLong * 1.55, r * 2.8);
    let streakShort = max(rShort * 0.55, r * 0.22);
    let streak = exp(-0.5 * ((along * along) / (streakLong * streakLong) + (across * across) / (streakShort * streakShort)));
    let brushMix = clamp(0.18 + anisotropy * 0.7 + pigmentBias * 0.15, 0.0, 1.0);
    let brush = mix(ellipse, streak, brushMix);

    let radialDir = normalize(delta + vec2f(0.0001, 0.0001));
    let track = abs(dot(radialDir, ortho));
    let directionalGate = mix(0.9, 0.32 + track * 0.68, anisotropy);

    let edgeNoise = hashNoise(vec2f(along * 1600.0 + globals.nowSec * 0.11, across * 1600.0 + f32(i) * 0.37)) * 2.0 - 1.0;
    let softnessNoise = hashNoise(vec2f(along * 711.0 + f32(i) * 0.13, across * 977.0 + globals.nowSec * 0.09));
    let softness = mix(0.78, 1.26, softnessNoise);
    let flowNoise = hashNoise(uv * vec2f(1403.0, 977.0) + vec2f(globals.nowSec * 0.17, globals.nowSec * 0.13)) * 2.0 - 1.0;
    let edgeGate = clamp(1.0 + edgeNoise * 0.22, 0.72, 1.28);
    let source = brush * edgeGate * softness * (0.1 + injectorStrength * 0.36) * (0.24 + depositionRate * 0.34) * directionalGate * (0.9 + flowNoise * 0.14);
    var deposit = source * (0.15 + pigmentBias * 0.42) * globals.fogDensity;
    if (count > 0u && deposit > 0.0) {
      deposit = max(deposit, 0.00012);
    }
    pigment = min(4.2, pigment + deposit * 0.78);
    carrier = min(3.2, carrier + deposit * 0.02 + source * 0.0012);

    let push = source * (0.004 + injectorStrength * 0.021 + pigmentBias * 0.007);
    velocity += strokeDir * push;
    velocity += ortho * push * (0.15 + anisotropy * 0.25);
  }

  let vLen = length(velocity);
  if (vLen > 0.12) {
    velocity = velocity * (0.12 / vLen);
  }

  carrierWrite[idx] = carrier;
  pigmentWrite[idx] = pigment;
  velocityWrite[idx] = velocity;
}

@compute @workgroup_size(8, 8, 1)
fn velocity_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  let uv = vec2f(f32(gid.x) / f32(d.x), f32(gid.y) / f32(d.y));
  let n = hashNoise(uv * 2.5 + vec2f(globals.nowSec * 0.031, globals.nowSec * 0.021));
  let swirl = vec2f(cos(n * 6.2831), sin(n * 6.2831));
  let buoyancy = vec2f(0.0, -pigmentRead[idx] * 0.0012);
  let velocity = velocityRead[idx] * 0.994 + swirl * 0.00055 + buoyancy;
  let vLen = length(velocity);
  velocityWrite[idx] = select(velocity, velocity * (0.11 / vLen), vLen > 0.11);
  carrierWrite[idx] = carrierRead[idx];
  pigmentWrite[idx] = pigmentRead[idx];
}

@compute @workgroup_size(8, 8, 1)
fn advect_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  let pos = vec2f(f32(gid.x), f32(gid.y));
  let vel = velocityRead[idx];
  let back = pos - vel * globals.dtSec * 34.0;
  let bx = i32(round(back.x));
  let by = i32(round(back.y));
  let b = clampCoord(bx, by, d);
  let bIdx = toIndex(b.x, b.y, d);
  carrierWrite[idx] = max(0.0, carrierRead[bIdx] * 0.999);
  pigmentWrite[idx] = max(0.0, pigmentRead[bIdx] * clamp(globals.inkRetention, 0.9, 0.9999));
  velocityWrite[idx] = velocityRead[bIdx] * 0.9985;
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
  carrierWrite[idx] = carrierRead[idx];
  pigmentWrite[idx] = pigmentRead[idx];
}

@compute @workgroup_size(8, 8, 1)
fn damp_main(@builtin(global_invocation_id) gid: vec3u) {
  let d = dims();
  if (gid.x >= d.x || gid.y >= d.y) { return; }
  let idx = toIndex(gid.x, gid.y, d);
  carrierWrite[idx] = max(0.0, carrierRead[idx] * 0.9989);
  pigmentWrite[idx] = max(0.0, pigmentRead[idx] * clamp(globals.inkRetention, 0.9, 0.9999));
  velocityWrite[idx] = velocityRead[idx] * 0.995;
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

fn sampleCarrierUv(uv: vec2f, d: vec2u) -> f32 {
  let x = u32(clamp(i32(uv.x * f32(d.x)), 0, i32(d.x) - 1));
  let y = u32(clamp(i32(uv.y * f32(d.y)), 0, i32(d.y) - 1));
  return carrierRead[toIndex(x, y, d)];
}

fn samplePigmentUv(uv: vec2f, d: vec2u) -> f32 {
  let x = u32(clamp(i32(uv.x * f32(d.x)), 0, i32(d.x) - 1));
  let y = u32(clamp(i32(uv.y * f32(d.y)), 0, i32(d.y) - 1));
  return pigmentRead[toIndex(x, y, d)];
}

@fragment
fn fs_volume(in: VsOut) -> @location(0) vec4f {
  let d = dims();
  var carrier = sampleCarrierUv(in.uv, d);
  var pigment = samplePigmentUv(in.uv, d);

  let steps = max(6.0, globals.compositeSamples * 0.55);
  for (var i = 0.0; i < steps; i = i + 1.0) {
    let t = i / steps;
    let drift = vec2f(
      sin(globals.nowSec * 0.04 + t * 5.0),
      cos(globals.nowSec * 0.05 + t * 4.0)
    ) * (0.01 + t * 0.02);
    let sampleUv = fract(in.uv + drift);
    carrier += sampleCarrierUv(sampleUv, d) * (0.015 + 0.02 * (1.0 - t));
    pigment += samplePigmentUv(sampleUv, d) * (0.02 + 0.028 * (1.0 - t));
  }

  carrier = clamp(carrier * globals.fogDensity * 0.8, 0.0, 3.5);
  pigment = clamp(pigment, 0.0, 4.5);

  let absorption = carrier * globals.carrierScattering * 1.05 + pigment * globals.pigmentAbsorption * 2.35;
  let transmittance = exp(-absorption);
  var luminance = clamp(globals.fogBaseLuma * transmittance, 0.0, 1.0);

  luminance = (luminance - globals.fogBaseLuma) * globals.contrast + globals.fogBaseLuma;
  luminance = clamp(luminance, 0.0, 0.94);

  let filmGrain = fbm2(in.uv * vec2f(globals.viewportWidth, globals.viewportHeight) * 0.58 + vec2f(globals.nowSec * 0.35, globals.nowSec * 0.21), 3);
  let grainRaw = filmGrain * globals.grainAmount * 0.6;
  let midWeight = smoothstep(0.08, 0.42, luminance) * (1.0 - smoothstep(0.45, 0.84, luminance));
  luminance = clamp(luminance + grainRaw * midWeight, 0.0, 0.94);

  let vignette = 0.9 + 0.1 * smoothstep(1.05, 0.3, length(in.uv - vec2f(0.5, 0.5)));
  let finalLuma = clamp(luminance * vignette, 0.0, 0.94);
  return vec4f(vec3f(finalLuma), 1.0);
}
