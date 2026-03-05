struct Uniforms {
  time: f32,
  sweepProgress: f32,
  transitionBlend: f32,
  _pad0: f32,
  viewportSize: vec2f,
  _pad1: vec2f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var inkTexA: texture_2d<f32>;
@group(0) @binding(2) var inkTexB: texture_2d<f32>;
@group(0) @binding(3) var inkSampler: sampler;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vid: u32) -> VsOut {
  // Fullscreen triangle pair
  var positions = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1),
  );
  let p = positions[vid];
  var out: VsOut;
  out.pos = vec4f(p, 0, 1);
  out.uv = p * 0.5 + 0.5;
  out.uv.y = 1.0 - out.uv.y; // flip Y for texture coords
  return out;
}

// --- Noise functions (GPU-side) ---

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

fn smoothstepCustom(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / max(1e-6, b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn valueNoise(seed: u32, x: f32, y: f32) -> f32 {
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let fx = smoothstepCustom(0.0, 1.0, x - floor(x));
  let fy = smoothstepCustom(0.0, 1.0, y - floor(y));
  let v00 = hash2d(seed, x0, y0);
  let v10 = hash2d(seed, x0 + 1, y0);
  let v01 = hash2d(seed, x0, y0 + 1);
  let v11 = hash2d(seed, x0 + 1, y0 + 1);
  let ix0 = v00 + (v10 - v00) * fx;
  let ix1 = v01 + (v11 - v01) * fx;
  return ix0 + (ix1 - ix0) * fy;
}

fn fbm(seed: u32, x: f32, y: f32, octaves: i32) -> f32 {
  var amp = 1.0;
  var freq = 1.0;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    let v = valueNoise(seed + u32(i) * 1013904223u, x * freq, y * freq) * 2.0 - 1.0;
    sum += v * amp;
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

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

@fragment fn fs(input: VsOut) -> @location(0) vec4f {
  let uv = input.uv;
  let center = vec2f(0.5, 0.5);
  let time = u.time;

  // --- 1. Sample ink textures ---
  let inkA = 1.0 - textureSample(inkTexA, inkSampler, uv).r;  // 0=paper, 1=ink (textures store white=paper)
  let inkB = 1.0 - textureSample(inkTexB, inkSampler, uv).r;

  // --- 2. Transition dissolve ---
  let dissolveNoise = fbm(0xfade1234u, uv.x * 6.0 + time * 0.3, uv.y * 6.0 - time * 0.2, 3) * 0.5 + 0.5;
  let dissolveMask = smoothstepCustom(u.transitionBlend - 0.1, u.transitionBlend + 0.1, dissolveNoise);
  let ink = mix(inkA, inkB, dissolveMask);

  // --- 3. Animated reveal (angular sweep) ---
  let toCenter = uv - center;
  let angle = atan2(toCenter.y, toCenter.x);
  let normAngle = (angle + PI) / TAU; // [0..1]
  let sweepNoise = fbm(0xbeef0001u, uv.x * 8.0 + time * 0.05, uv.y * 8.0 - time * 0.03, 3) * 0.06;
  let sweepDist = normAngle - u.sweepProgress + sweepNoise;
  // Wrap-around handling
  let wrappedDist = min(abs(sweepDist), abs(sweepDist + 1.0));
  let reveal = smoothstepCustom(0.04, 0.0, sweepDist) + smoothstepCustom(0.04, 0.0, sweepDist + 1.0);
  let revealClamped = clamp(reveal, 0.0, 1.0);

  let inkMask = ink * revealClamped;

  // --- 4. Atmospheric mist ---
  let mist1 = fbm(0xc10ud001u, uv.x * 3.0 + time * 0.006, uv.y * 3.0 + time * -0.004, 4);
  let mist2 = fbm(0xc10ud002u, uv.x * 2.0 + time * -0.003, uv.y * 2.5 + time * 0.005, 3);
  let mist = mix(mist1, mist2, 0.5) * 0.5 + 0.5;
  let bgLuma = 0.91 + mist * 0.06;

  // --- 5. Edge halo (sample blurred mip) ---
  let inkBlurA = 1.0 - textureSampleLevel(inkTexA, inkSampler, uv, 4.0).r;
  let inkBlurB = 1.0 - textureSampleLevel(inkTexB, inkSampler, uv, 4.0).r;
  let inkBlur = mix(inkBlurA, inkBlurB, dissolveMask);
  let halo = inkBlur * revealClamped * 0.07;

  // --- 6. Composite ---
  let inkColor = 0.04;
  let luma = mix(bgLuma - halo, inkColor, inkMask);

  // --- 7. Film grain ---
  let grain = (hashScreen(uv * u.viewportSize, time) - 0.5) * 0.015;

  // --- 8. Vignette ---
  let d = length(uv - center) * 1.3;
  let vignette = 1.0 - d * d * 0.18;

  let finalLuma = clamp(luma * vignette + grain, 0.02, 0.96);

  // --- 9. Color tinting ---
  let warmInk = vec3f(0.05, 0.04, 0.035);
  let coolMist = vec3f(0.90, 0.91, 0.925);
  let color = mix(coolMist, warmInk, inkMask);

  // Scale color by luminance
  let refLuma = mix(0.905, 0.043, inkMask);
  let colorScaled = color * (finalLuma / max(refLuma, 0.01));

  return vec4f(clamp(colorScaled, vec3f(0.02), vec3f(0.96)), 1.0);
}
