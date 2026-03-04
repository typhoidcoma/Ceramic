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

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var<storage, read> carrierRead : array<f32>;
@group(0) @binding(2) var<storage, read> pigmentRead : array<f32>;

fn dims() -> vec2u {
  return vec2u(u32(max(1.0, globals.simWidth)), u32(max(1.0, globals.simHeight)));
}

fn toIndex(x: u32, y: u32, d: vec2u) -> u32 {
  return y * d.x + x;
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

  let steps = max(8.0, globals.compositeSamples * 0.82);
  for (var i = 0.0; i < steps; i = i + 1.0) {
    let t = i / steps;
    let drift = vec2f(
      sin(globals.nowSec * 0.04 + t * 5.0),
      cos(globals.nowSec * 0.05 + t * 4.0)
    ) * (0.01 + t * 0.02);
    let sampleUv = fract(in.uv + drift);
    carrier += sampleCarrierUv(sampleUv, d) * (0.028 + 0.042 * (1.0 - t));
    pigment += samplePigmentUv(sampleUv, d) * (0.03 + 0.05 * (1.0 - t));
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
