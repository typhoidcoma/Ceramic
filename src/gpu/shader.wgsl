struct Uniforms {
  time: f32,
  viewportW: f32,
  viewportH: f32,
  presence: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var simTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vid: u32) -> VsOut {
  var positions = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1),
  );
  let p = positions[vid];
  var out: VsOut;
  out.pos = vec4f(p, 0, 1);
  out.uv = p * 0.5 + 0.5;
  out.uv.y = 1.0 - out.uv.y;
  return out;
}

fn hashU(n: u32) -> u32 {
  var x = n;
  x ^= x << 13u;
  x ^= x >> 17u;
  x ^= x << 5u;
  return x;
}

fn hash2d(seed: u32, ix: i32, iy: i32) -> f32 {
  var h = seed;
  h ^= u32(ix) * 0x9e3779b1u;
  h = hashU(h);
  h ^= u32(iy) * 0x85ebca6bu;
  h = hashU(h);
  return f32(h) / 4294967295.0;
}

fn sstep(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / max(1e-6, b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn valueNoise(seed: u32, x: f32, y: f32) -> f32 {
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let fx = sstep(0.0, 1.0, x - floor(x));
  let fy = sstep(0.0, 1.0, y - floor(y));
  return mix(
    mix(hash2d(seed, x0, y0), hash2d(seed, x0+1, y0), fx),
    mix(hash2d(seed, x0, y0+1), hash2d(seed, x0+1, y0+1), fx),
    fy
  );
}

fn fbm(seed: u32, x: f32, y: f32, octaves: i32) -> f32 {
  var amp = 1.0; var freq = 1.0; var sum = 0.0; var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += (valueNoise(seed + u32(i) * 1013904223u, x * freq, y * freq) * 2.0 - 1.0) * amp;
    norm += amp;
    freq *= 2.05;
    amp *= 0.52;
  }
  return sum / max(norm, 1e-6);
}

fn hashScreen(p: vec2f, t: f32) -> f32 {
  let n = u32(p.x * 1237.0 + p.y * 3571.0 + t * 7919.0);
  return f32(hashU(n)) / 4294967295.0;
}

// Multi-scale ink sampling: sharp core + medium spread + wide smoke halo
fn sampleInkMultiscale(uv: vec2f) -> vec3f {
  let tx = 1.0 / 2048.0;

  // Sharp core: tight 5-tap
  let c0 = textureSample(simTex, samp, uv).r;
  let c1 = textureSample(simTex, samp, uv + vec2f(tx * 2.0, 0.0)).r;
  let c2 = textureSample(simTex, samp, uv + vec2f(-tx * 2.0, 0.0)).r;
  let c3 = textureSample(simTex, samp, uv + vec2f(0.0, tx * 2.0)).r;
  let c4 = textureSample(simTex, samp, uv + vec2f(0.0, -tx * 2.0)).r;
  let sharp = c0 * 0.4 + (c1 + c2 + c3 + c4) * 0.15;

  // Medium smoke: 8-tap at ~30 texel radius
  let mr = tx * 30.0;
  var med = 0.0;
  med += textureSample(simTex, samp, uv + vec2f(mr, 0.0)).r;
  med += textureSample(simTex, samp, uv + vec2f(-mr, 0.0)).r;
  med += textureSample(simTex, samp, uv + vec2f(0.0, mr)).r;
  med += textureSample(simTex, samp, uv + vec2f(0.0, -mr)).r;
  med += textureSample(simTex, samp, uv + vec2f(mr * 0.707, mr * 0.707)).r;
  med += textureSample(simTex, samp, uv + vec2f(-mr * 0.707, mr * 0.707)).r;
  med += textureSample(simTex, samp, uv + vec2f(mr * 0.707, -mr * 0.707)).r;
  med += textureSample(simTex, samp, uv + vec2f(-mr * 0.707, -mr * 0.707)).r;
  med = med / 8.0;

  // Wide smoke halo: 8-tap at ~80 texel radius (~4% of texture)
  let wr = tx * 80.0;
  var wide = 0.0;
  wide += textureSample(simTex, samp, uv + vec2f(wr, 0.0)).r;
  wide += textureSample(simTex, samp, uv + vec2f(-wr, 0.0)).r;
  wide += textureSample(simTex, samp, uv + vec2f(0.0, wr)).r;
  wide += textureSample(simTex, samp, uv + vec2f(0.0, -wr)).r;
  wide += textureSample(simTex, samp, uv + vec2f(wr * 0.707, wr * 0.707)).r;
  wide += textureSample(simTex, samp, uv + vec2f(-wr * 0.707, wr * 0.707)).r;
  wide += textureSample(simTex, samp, uv + vec2f(wr * 0.707, -wr * 0.707)).r;
  wide += textureSample(simTex, samp, uv + vec2f(-wr * 0.707, -wr * 0.707)).r;
  wide = wide / 8.0;

  return vec3f(sharp, med, wide);
}

@fragment fn fs(input: VsOut) -> @location(0) vec4f {
  let rawUv = input.uv;
  let time = u.time;
  let viewport = vec2f(u.viewportW, u.viewportH);

  // Aspect-correct UV: map to centered square region
  let aspect = viewport.x / viewport.y;
  var uv = rawUv;
  if (aspect > 1.0) {
    uv.x = (rawUv.x - 0.5) * aspect + 0.5;
  } else {
    uv.y = (rawUv.y - 0.5) / aspect + 0.5;
  }
  let center = vec2f(0.5, 0.5);

  // Always sample (WGSL requires uniform control flow for textureSample)
  // Clamp UV so sampling is valid, then zero out if outside sim area
  let clampedUv = clamp(uv, vec2f(0.001), vec2f(0.999));
  let ink = sampleInkMultiscale(clampedUv);
  let insideMask = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  let sharpInk = ink.x * insideMask;
  let medInk = ink.y * insideMask;
  let wideInk = ink.z * insideMask;

  // Core ink: visible once density is moderate
  let coreInk = sstep(0.05, 0.45, sharpInk);
  // Smoke: faint density becomes visible smoke
  let smoke = sstep(0.02, 0.30, medInk);
  // Vapor halo: even faintest traces darken the fog
  let vapor = sstep(0.01, 0.20, wideInk);

  // Solid ink amount (for color/luminance mapping)
  let solidInk = sstep(0.0, 0.8, coreInk);

  // === ATMOSPHERIC FOG — heavy, moody, dark ===
  // Slow-drifting volumetric cloud layers
  let fog1 = fbm(0xa10ad001u, uv.x * 2.5 + time * 0.008, uv.y * 2.5 - time * 0.006, 5);
  let fog2 = fbm(0xa10ad002u, uv.x * 1.5 - time * 0.005, uv.y * 2.0 + time * 0.007, 4);
  let fog3 = fbm(0xa10ad003u, uv.x * 4.0 + time * 0.012, uv.y * 3.5 - time * 0.009, 3);
  let fogBase = mix(fog1, fog2, 0.4) * 0.5 + 0.5;
  let fogDetail = fog3 * 0.5 + 0.5;

  // Dark moody base: 0.28 - 0.48 range (like the movie screenshot)
  let bgLuma = 0.28 + fogBase * 0.16 + fogDetail * 0.04;

  // === VAPOR DARKENING — huge soft halo around ink ===
  // Wide vapor darkens the fog around the logogram
  let vaporDarken = vapor * 0.20 + smoke * 0.15;

  // === SMOKE LAYER — mid-range dark cloud around ink ===
  // Noise-modulated smoke for organic wisps
  let smokeNoise = fbm(0xbeef0001u, uv.x * 6.0 + time * 0.015, uv.y * 6.0 - time * 0.01, 3) * 0.5 + 0.5;
  let smokeDarken = smoke * (0.25 + smokeNoise * 0.12);

  // === CORE INK — deep black ===
  // Ink luminance: smoky gray wisps → deep black solid
  let inkLuma = mix(0.30, 0.06, solidInk);

  // === COMPOSE LAYERS ===
  // Start with foggy background
  var luma = bgLuma;
  // Darken with vapor halo
  luma = luma - vaporDarken;
  // Darken with smoke
  luma = luma - smokeDarken;
  // Blend in solid ink
  luma = mix(luma, inkLuma, coreInk);

  // === FILM GRAIN (subtle) ===
  let grain = (hashScreen(rawUv * viewport, time) - 0.5) * 0.015;

  // === VIGNETTE — stronger for moody look (screen-space, not aspect-corrected) ===
  let d = length(rawUv - vec2f(0.5, 0.5)) * 1.2;
  let vignette = 1.0 - d * d * 0.35;

  luma = clamp(luma * vignette + grain, 0.04, 0.52);

  // === COLOR: cool blue-gray fog, warm-black ink ===
  let fogColor = vec3f(0.42, 0.44, 0.48);   // cool blue-gray
  let smokeColor = vec3f(0.28, 0.29, 0.32);  // darker blue-gray smoke
  let inkColor = vec3f(0.06, 0.05, 0.05);    // near-black with slight warmth

  // Blend color layers
  let totalInk = max(coreInk, smoke * 0.5);
  var color = mix(fogColor, smokeColor, clamp(vapor + smoke * 0.5, 0.0, 1.0));
  color = mix(color, inkColor, coreInk);

  // Apply luminance
  let colorLuma = dot(color, vec3f(0.299, 0.587, 0.114));
  let finalColor = color * (luma / max(colorLuma, 0.01));

  return vec4f(clamp(finalColor, vec3f(0.03), vec3f(0.52)), 1.0);
}
