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
  sweepProgress : f32,
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
  let texel = vec2f(1.0 / f32(d.x), 1.0 / f32(d.y));

  // Sample pigment with neighbor blur
  let p0 = samplePigmentUv(uv, d);
  let px1 = samplePigmentUv(uv + vec2f(texel.x, 0.0), d);
  let px2 = samplePigmentUv(uv - vec2f(texel.x, 0.0), d);
  let py1 = samplePigmentUv(uv + vec2f(0.0, texel.y), d);
  let py2 = samplePigmentUv(uv - vec2f(0.0, texel.y), d);
  let step2 = texel * 2.0;
  let pd1 = samplePigmentUv(uv + vec2f(step2.x, step2.y), d);
  let pd2 = samplePigmentUv(uv + vec2f(-step2.x, step2.y), d);
  let pd3 = samplePigmentUv(uv + vec2f(step2.x, -step2.y), d);
  let pd4 = samplePigmentUv(uv + vec2f(-step2.x, -step2.y), d);
  let pWide = p0 * 0.3 + (px1 + px2 + py1 + py2) * 0.12 + (pd1 + pd2 + pd3 + pd4) * 0.05;
  var pigment = clamp(pWide, 0.0, 2.5);

  // === Atmospheric mist layer ===
  // Slow-drifting cloud noise that gives the background depth and mood
  let mistDrift = vec2f(globals.nowSec * 0.006, -globals.nowSec * 0.004);
  let mistCoord1 = rot2((uv - vec2f(0.5, 0.48)) * vec2f(1.2, 0.9), 0.35) * 2.8 + mistDrift;
  let mistCoord2 = rot2((uv - vec2f(0.52, 0.5)) * vec2f(0.7, 1.1), -0.22) * 1.6 + mistDrift * 0.7;
  let mist1 = fbm2(mistCoord1, 5) * 0.5 + 0.5; // 0..1
  let mist2 = fbm2(mistCoord2, 4) * 0.5 + 0.5;
  let mistLayer = mist1 * 0.6 + mist2 * 0.4;

  // Radial darkening toward edges (like looking through foggy glass)
  let centerDist = length(uv - vec2f(0.5, 0.5));
  let radialDarken = smoothstep(0.15, 0.72, centerDist);

  // Background luminance: moody gray with cloud variation
  // Base ~0.68 with mist bringing it between 0.58..0.78, edges darker
  let bgBase = 0.68;
  let bgMist = bgBase + (mistLayer - 0.5) * 0.14;
  let bgLuma = bgMist - radialDarken * 0.18;

  // === Ink threshold ===
  // Edge noise for organic variation
  let edgeDrift = vec2f(globals.nowSec * 0.011, -globals.nowSec * 0.008);
  let q0 = rot2((uv - vec2f(0.5, 0.5)) * vec2f(1.4, 1.1), 0.62) + edgeDrift;
  let edgeNoise = fbm2(q0, 3) * 0.05;

  let inkDensity = pigment;
  let threshold = 0.18 + edgeNoise;
  let edgeWidth = 0.16;
  let inkMask = smoothstep(threshold - edgeWidth * 0.5, threshold + edgeWidth * 0.5, inkDensity);

  // Ink luminance: near-black at full ink, background at zero
  let inkLuma = 0.04;
  var luminance = mix(bgLuma, inkLuma, inkMask);

  // Subtle ink bleed halo: darken background slightly near ink edges
  let haloStrength = smoothstep(0.0, 0.12, pigment) * (1.0 - inkMask) * 0.08;
  luminance -= haloStrength;

  // Film grain — subtle, biased toward transition zone
  let filmCoord = rot2(uv * vec2f(181.0, 177.0) + vec2f(globals.nowSec * 0.31, globals.nowSec * 0.27), 0.41);
  let filmGrain = fbm2(filmCoord + vec2f(0.23, 0.41), 3);
  let grainRaw = filmGrain * 0.012;
  let transitionWeight = smoothstep(0.05, 0.3, inkMask) * (1.0 - smoothstep(0.7, 0.95, inkMask));
  let bgGrainWeight = (1.0 - inkMask) * 0.4; // subtle grain in background too
  luminance += grainRaw * (transitionWeight + bgGrainWeight);

  // Vignette: darken edges substantially for moody look
  let vignette = smoothstep(0.85, 0.25, centerDist) * 0.2 + 0.8;
  luminance *= vignette;
  luminance = clamp(luminance, 0.02, 0.88);

  // Color: warm ink on cool misty background
  let warmInk = vec3f(0.05, 0.04, 0.03);
  let coolMist = vec3f(0.72, 0.73, 0.76); // blue-gray mist
  var color = mix(coolMist, warmInk, inkMask);

  // Apply luminance to color
  let colorLuma = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  color = color * (luminance / max(0.01, colorLuma));
  color = clamp(color, vec3f(0.02), vec3f(0.88));

  return vec4f(color, 1.0);
}
