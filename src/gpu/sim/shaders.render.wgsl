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

fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
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
  let uv = in.uv;
  let center = vec2f(0.5, 0.53);
  let p = uv - center;
  let radial = length(p);
  let texel = vec2f(1.0 / f32(d.x), 1.0 / f32(d.y));
  let c0 = sampleCarrierUv(uv, d);
  let p0 = samplePigmentUv(uv, d);
  let cx1 = sampleCarrierUv(uv + vec2f(texel.x, 0.0), d);
  let cx2 = sampleCarrierUv(uv - vec2f(texel.x, 0.0), d);
  let cy1 = sampleCarrierUv(uv + vec2f(0.0, texel.y), d);
  let cy2 = sampleCarrierUv(uv - vec2f(0.0, texel.y), d);
  let px1 = samplePigmentUv(uv + vec2f(texel.x, 0.0), d);
  let px2 = samplePigmentUv(uv - vec2f(texel.x, 0.0), d);
  let py1 = samplePigmentUv(uv + vec2f(0.0, texel.y), d);
  let py2 = samplePigmentUv(uv - vec2f(0.0, texel.y), d);
  let cNeighbor = (cx1 + cx2 + cy1 + cy2) * 0.25;
  let pNeighbor = (px1 + px2 + py1 + py2) * 0.25;
  let pGrad = abs(px1 - px2) + abs(py1 - py2);
  let edgeKeep = smoothstep(0.2, 0.018, pGrad);
  var carrier = c0 * 0.994 + cNeighbor * 0.00045;
  var pigment = mix(p0 * 0.972 + pNeighbor * 0.009, p0 * 0.9985 + pNeighbor * 0.0015, edgeKeep);

  carrier = clamp(carrier * globals.fogDensity * 0.8, 0.0, 3.5);
  pigment = clamp(pigment, 0.0, 4.5);

  // Cinematic wispy background fog: multi-directional plume layers to avoid visible banding.
  let drift = vec2f(globals.nowSec * 0.011, -globals.nowSec * 0.008);
  let q0 = rot2((uv - vec2f(0.5, 0.5)) * vec2f(1.4, 1.1), 0.62) + drift;
  let q1 = rot2((uv - vec2f(0.46, 0.55)) * vec2f(2.7, 2.0), -0.91) - drift * 0.7;
  let q2 = rot2((uv - vec2f(0.54, 0.48)) * vec2f(4.9, 3.8), 1.17) + drift * 0.45;
  let n0 = fbm2(q0, 4);
  let warp = vec2f(n0 * 0.038, -n0 * 0.031);
  let n1 = fbm2(q1 + warp, 3);
  let n2 = fbm2(q2 - warp * 0.6, 2);
  let plumeField = n0 * 0.53 + n1 * 0.31 + n2 * 0.16;
  let wispy = smoothstep(-0.18, 0.42, plumeField);
  let smokeAbsorb = wispy * (0.006 + 0.02 * smoothstep(0.6, 0.1, radial));
  let atmosphericLift = (wispy - 0.5) * 0.044;
  let depthLift = smoothstep(0.9, 0.22, radial) * 0.032;

  let absorption = carrier * globals.carrierScattering * 0.18 + pigment * globals.pigmentAbsorption * 3.35 + smokeAbsorb;
  let transmittance = exp(-absorption);
  let fogBase = globals.fogBaseLuma + depthLift + atmosphericLift;
  let pigmentMask = smoothstep(0.05, 0.22, pigment);
  let floorLift = fogBase * 0.2 * (1.0 - pigmentMask);
  var luminance = clamp(max(floorLift, fogBase * transmittance), 0.0, 1.0);

  luminance = (luminance - globals.fogBaseLuma) * globals.contrast + globals.fogBaseLuma;
  luminance = clamp(luminance, 0.0, 0.94);

  let filmCoord = rot2(uv * vec2f(181.0, 177.0) + vec2f(globals.nowSec * 0.31, globals.nowSec * 0.27), 0.41);
  let filmGrain = fbm2(filmCoord + vec2f(0.23, 0.41), 3);
  let grainRaw = filmGrain * globals.grainAmount * 0.6;
  let midWeight = smoothstep(0.08, 0.42, luminance) * (1.0 - smoothstep(0.45, 0.84, luminance));
  luminance = clamp(luminance + grainRaw * midWeight, 0.0, 0.94);

  let vignette = 0.982 + 0.018 * smoothstep(1.08, 0.22, length(uv - vec2f(0.5, 0.5)));
  let finalLuma = clamp(luminance * vignette, 0.0, 0.94);
  return vec4f(vec3f(finalLuma), 1.0);
}
