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

fn sampleScalarBilinear(buffer: ptr<storage, array<f32>, read>, pos: vec2f, d: vec2u) -> f32 {
  let px = clamp(pos.x, 0.0, f32(d.x - 1u));
  let py = clamp(pos.y, 0.0, f32(d.y - 1u));
  let x0 = i32(floor(px));
  let y0 = i32(floor(py));
  let x1 = min(i32(d.x) - 1, x0 + 1);
  let y1 = min(i32(d.y) - 1, y0 + 1);
  let tx = px - f32(x0);
  let ty = py - f32(y0);
  let v00 = sampleScalar(buffer, x0, y0, d);
  let v10 = sampleScalar(buffer, x1, y0, d);
  let v01 = sampleScalar(buffer, x0, y1, d);
  let v11 = sampleScalar(buffer, x1, y1, d);
  let vx0 = mix(v00, v10, tx);
  let vx1 = mix(v01, v11, tx);
  return mix(vx0, vx1, ty);
}

fn sampleVelocityBilinear(pos: vec2f, d: vec2u) -> vec2f {
  let px = clamp(pos.x, 0.0, f32(d.x - 1u));
  let py = clamp(pos.y, 0.0, f32(d.y - 1u));
  let x0 = i32(floor(px));
  let y0 = i32(floor(py));
  let x1 = min(i32(d.x) - 1, x0 + 1);
  let y1 = min(i32(d.y) - 1, y0 + 1);
  let tx = px - f32(x0);
  let ty = py - f32(y0);
  let v00 = sampleVelocity(x0, y0, d);
  let v10 = sampleVelocity(x1, y0, d);
  let v01 = sampleVelocity(x0, y1, d);
  let v11 = sampleVelocity(x1, y1, d);
  let vx0 = mix(v00, v10, tx);
  let vx1 = mix(v01, v11, tx);
  return mix(vx0, vx1, ty);
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

    // Ink-first stamp: isotropic core with slight oriented bias for tendrils.
    let along = dot(delta, strokeDir);
    let across = dot(delta, ortho);
    let rIso = max(0.00024, r * (0.54 + 0.08 * (1.0 - anisotropy)));
    let isoKernel = exp(-0.5 * ((dist * dist) / (rIso * rIso)));
    let rShort = max(0.00055, rIso * (0.98 - anisotropy * 0.06));
    let rLong = max(rShort * 1.01, rIso * (1.02 + anisotropy * 0.18));
    let streakKernel = exp(-0.5 * ((along * along) / (rLong * rLong) + (across * across) / (rShort * rShort)));
    let brush = mix(isoKernel, streakKernel, anisotropy * 0.24);

    let radialDir = normalize(delta + vec2f(0.0001, 0.0001));
    let track = abs(dot(radialDir, ortho));
    let directionalGate = mix(1.0, 0.985 + track * 0.015, anisotropy * 0.05);
    let source = brush * (0.11 + injectorStrength * 0.24) * (0.24 + depositionRate * 0.32) * directionalGate;
    var deposit = source * (0.2 + pigmentBias * 0.46) * globals.fogDensity;
    if (count > 0u && deposit > 0.0) {
      deposit = max(deposit, 0.00025);
    }
    pigment = min(4.6, pigment + deposit * 1.12);
    carrier = min(3.0, carrier + deposit * 0.0018 + source * 0.00018);
    if (pigment > 1.2) {
      carrier = min(3.0, carrier + (pigment - 1.2) * 0.00016);
    }

    let push = source * (0.00018 + injectorStrength * 0.0012 + pigmentBias * 0.00045);
    velocity += strokeDir * push;
    velocity += ortho * push * (0.012 + anisotropy * 0.02);
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
  let n = hashNoise(uv * 2.2 + vec2f(globals.nowSec * 0.028, globals.nowSec * 0.019));
  let swirl = vec2f(cos(n * 6.2831), sin(n * 6.2831));
  let l = sampleVelocity(i32(gid.x) - 1, i32(gid.y), d);
  let r = sampleVelocity(i32(gid.x) + 1, i32(gid.y), d);
  let b = sampleVelocity(i32(gid.x), i32(gid.y) - 1, d);
  let t = sampleVelocity(i32(gid.x), i32(gid.y) + 1, d);
  let smoothVel = (l + r + b + t) * 0.25;
  let buoyancy = vec2f(0.0, -pigmentRead[idx] * 0.0016);
  let velocity = mix(velocityRead[idx], smoothVel, 0.18) * 0.992 + swirl * 0.00065 + buoyancy;
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
  let back = pos - vel * globals.dtSec * 30.0;
  carrierWrite[idx] = max(0.0, sampleScalarBilinear(&carrierRead, back, d) * 0.999);
  pigmentWrite[idx] = max(0.0, sampleScalarBilinear(&pigmentRead, back, d) * clamp(globals.inkRetention, 0.9, 0.9999));
  velocityWrite[idx] = sampleVelocityBilinear(back, d) * 0.9982;
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
  let x = i32(gid.x);
  let y = i32(gid.y);
  let cL = sampleScalar(&carrierRead, x - 1, y, d);
  let cR = sampleScalar(&carrierRead, x + 1, y, d);
  let cB = sampleScalar(&carrierRead, x, y - 1, d);
  let cT = sampleScalar(&carrierRead, x, y + 1, d);
  let pL = sampleScalar(&pigmentRead, x - 1, y, d);
  let pR = sampleScalar(&pigmentRead, x + 1, y, d);
  let pB = sampleScalar(&pigmentRead, x, y - 1, d);
  let pT = sampleScalar(&pigmentRead, x, y + 1, d);
  let cN = (cL + cR + cB + cT) * 0.25;
  let pN = (pL + pR + pB + pT) * 0.25;
  carrierWrite[idx] = max(0.0, mix(carrierRead[idx], cN, 0.03) * 0.99925);
  pigmentWrite[idx] = max(0.0, mix(pigmentRead[idx], pN, 0.06) * clamp(globals.inkRetention, 0.9, 0.9999));
  velocityWrite[idx] = velocityRead[idx] * 0.996;
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

  let steps = max(4.0, globals.compositeSamples * 0.42);
  for (var i = 0.0; i < steps; i = i + 1.0) {
    let t = i / steps;
    let drift = vec2f(
      sin(globals.nowSec * 0.04 + t * 5.0),
      cos(globals.nowSec * 0.05 + t * 4.0)
    ) * (0.01 + t * 0.02);
    let sampleUv = fract(in.uv + drift);
    carrier += sampleCarrierUv(sampleUv, d) * (0.008 + 0.012 * (1.0 - t));
    pigment += samplePigmentUv(sampleUv, d) * (0.012 + 0.018 * (1.0 - t));
  }

  carrier = clamp(carrier * globals.fogDensity * 0.8, 0.0, 3.5);
  pigment = clamp(pigment, 0.0, 4.5);

  let absorption = carrier * globals.carrierScattering * 0.82 + pigment * globals.pigmentAbsorption * 2.88;
  let transmittance = exp(-absorption);
  var luminance = clamp(globals.fogBaseLuma * transmittance, 0.0, 1.0);

  luminance = (luminance - globals.fogBaseLuma) * globals.contrast + globals.fogBaseLuma;
  luminance = clamp(luminance, 0.0, 0.91);

  let filmGrain = fbm2(in.uv * vec2f(globals.viewportWidth, globals.viewportHeight) * 0.58 + vec2f(globals.nowSec * 0.35, globals.nowSec * 0.21), 3);
  let grainRaw = filmGrain * globals.grainAmount * 0.6;
  let midWeight = smoothstep(0.08, 0.42, luminance) * (1.0 - smoothstep(0.45, 0.84, luminance));
  luminance = clamp(luminance + grainRaw * midWeight, 0.0, 0.94);

  let vignette = 0.9 + 0.1 * smoothstep(1.05, 0.3, length(in.uv - vec2f(0.5, 0.5)));
  let finalLuma = clamp(luminance * vignette, 0.0, 0.94);
  return vec4f(vec3f(finalLuma), 1.0);
}
