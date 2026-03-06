// Multi-pass logogram generation pipeline
// Entry points: genShape, warpTex, maxBlend, inkBlot
//
// Pipeline (texture-based, matching SD graph):
//   genRing → T0, fluidMorph(T0) → S1, maxBlend(accum, S1) → ...
//   genBlobs → T, dotWarp → T, fluidMorph → T, maxBlend(accum, T) → ...
//   genTendrils → T, fluidMorph → T, maxBlend(accum, T) → ...
//   genCurls → T, fluidMorph → T, maxBlend(accum, T) → ...
//   dotWarp(composite) → T, inkBlot(T) → target

struct LogoParams {
  seed: u32,
  ringRadius: f32,
  counts: u32,        // blobCount(8) | curlCount(8) | tendrilCount(8) | gapCount(8)
  sectorActive: u32,  // 12-bit bitmask
  secT0: vec4f,       // sector thickness 0-3
  secT1: vec4f,       // sector thickness 4-7
  secT2: vec4f,       // sector thickness 8-11
  blob0: vec4f,       // (theta, arcSpan, size, radialBias)
  blob1: vec4f,
  blob2: vec4f,
  blob3: vec4f,
  curl01: vec4f,      // (theta0, size0, theta1, size1)
  curl23: vec4f,
  curl45: vec4f,
  curl67: vec4f,
  tend0: vec4f,       // (theta, lengthFactor, 0, 0)
  tend1: vec4f,
  tend2: vec4f,
  tend3: vec4f,
  gaps: vec4f,        // up to 4 gap angles
};

struct OpParams {
  mode: u32,       // gen: 0=ring,1=blobs,2=curls,3=tendrils; warp: 0=fluid,1=dot
  seed: u32,       // warp seed
  strength: f32,   // warp strength
  freq: f32,       // warp frequency
};

// All possible bindings — each entry point uses a different subset.
// With layout:"auto", only referenced bindings appear in each pipeline's layout.
@group(0) @binding(0) var<uniform> p: LogoParams;
@group(0) @binding(1) var<uniform> op: OpParams;
@group(0) @binding(2) var srcSamp: sampler;
@group(0) @binding(3) var srcA: texture_2d<f32>;
@group(0) @binding(4) var srcB: texture_2d<f32>;
@group(0) @binding(5) var dst: texture_storage_2d<rgba8unorm, write>;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318530;
const SECTOR_COUNT: u32 = 12u;

// ============================================================
// NOISE
// ============================================================

fn pcg(n: u32) -> u32 {
  var v = n * 747796405u + 2891336453u;
  let word = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash2d(seed: u32, ix: i32, iy: i32) -> f32 {
  var h = seed;
  h = pcg(h + u32(ix) * 0x9e3779b1u);
  h = pcg(h + u32(iy) * 0x85ebca6bu);
  return f32(h) / 4294967295.0;
}

fn valueNoise(seed: u32, x: f32, y: f32) -> f32 {
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let fx = fract(x);
  let fy = fract(y);
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  return mix(
    mix(hash2d(seed, x0, y0), hash2d(seed, x0 + 1, y0), sx),
    mix(hash2d(seed, x0, y0 + 1), hash2d(seed, x0 + 1, y0 + 1), sx),
    sy
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

// ============================================================
// WARP OPERATIONS (used by warpTex entry point)
// ============================================================

fn fluidMorph(pos: vec2f, warpSeed: u32, strength: f32, freq_: f32) -> vec2f {
  let h = 0.5 / freq_;
  let nR = fbm(warpSeed, (pos.x + h) * freq_, pos.y * freq_, 4);
  let nL = fbm(warpSeed, (pos.x - h) * freq_, pos.y * freq_, 4);
  let nU = fbm(warpSeed, pos.x * freq_, (pos.y - h) * freq_, 4);
  let nD = fbm(warpSeed, pos.x * freq_, (pos.y + h) * freq_, 4);
  let dx = nR - nL;
  let dy = nD - nU;
  return pos - vec2f(dy, -dx) * strength;
}

fn dotWarp(pos: vec2f, warpSeed: u32, strength: f32, freq_: f32) -> vec2f {
  let h = 0.5 / freq_;
  let nR = fbm(warpSeed, (pos.x + h) * freq_, pos.y * freq_, 3);
  let nL = fbm(warpSeed, (pos.x - h) * freq_, pos.y * freq_, 3);
  let nU = fbm(warpSeed, pos.x * freq_, (pos.y - h) * freq_, 3);
  let nD = fbm(warpSeed, pos.x * freq_, (pos.y + h) * freq_, 3);
  let dx = nR - nL;
  let dy = nD - nU;
  return pos - vec2f(dx, dy) * strength;
}

// ============================================================
// HELPERS (used by shape gen)
// ============================================================

fn getSectorThickness(i: u32) -> f32 {
  let group = i / 4u;
  let idx = i % 4u;
  var v: vec4f;
  if (group == 0u) { v = p.secT0; }
  else if (group == 1u) { v = p.secT1; }
  else { v = p.secT2; }
  return v[idx];
}

fn sectorWidth(angle: f32) -> f32 {
  // Sample 3 sectors and blend for smoother transitions (less angular faceting)
  let norm = ((angle + PI) / TAU) * f32(SECTOR_COUNT);
  let i0 = u32(floor(norm)) % SECTOR_COUNT;
  let i1 = (i0 + 1u) % SECTOR_COUNT;
  let i2 = (i0 + 2u) % SECTOR_COUNT;
  let iPrev = (i0 + SECTOR_COUNT - 1u) % SECTOR_COUNT;
  let frac_ = norm - floor(norm);
  let tPrev = getSectorThickness(iPrev);
  let t0 = getSectorThickness(i0);
  let t1 = getSectorThickness(i1);
  let t2 = getSectorThickness(i2);
  // Catmull-Rom-like smooth interpolation
  let t = frac_ * frac_ * (3.0 - 2.0 * frac_);
  let base = t0 + (t1 - t0) * t;
  // Blend with neighbors for extra smoothing
  let avg4 = (tPrev + t0 * 2.0 + t1 * 2.0 + t2) / 6.0;
  return clamp(mix(base, avg4, 0.4), 0.0, 1.0);
}

fn fmod(a: f32, b: f32) -> f32 {
  return a - floor(a / b) * b;
}

fn wrapAngle(a: f32) -> f32 {
  return fmod(a + PI * 3.0, TAU) - PI;
}

fn isInGap(angle: f32) -> bool {
  let gapCount = (p.counts >> 24u) & 0xffu;
  for (var i = 0u; i < gapCount; i++) {
    let ga = p.gaps[i];
    let diff = abs(wrapAngle(angle - ga));
    if (diff < 0.25) { return true; }
  }
  return false;
}

fn getBlob(i: u32) -> vec4f {
  if (i == 0u) { return p.blob0; }
  else if (i == 1u) { return p.blob1; }
  else if (i == 2u) { return p.blob2; }
  return p.blob3;
}

fn getCurl(i: u32) -> vec2f {
  let pair = i / 2u;
  let sub = i % 2u;
  var v: vec4f;
  if (pair == 0u) { v = p.curl01; }
  else if (pair == 1u) { v = p.curl23; }
  else if (pair == 2u) { v = p.curl45; }
  else { v = p.curl67; }
  if (sub == 0u) { return v.xy; }
  return v.zw;
}

fn getTendril(i: u32) -> vec4f {
  if (i == 0u) { return p.tend0; }
  else if (i == 1u) { return p.tend1; }
  else if (i == 2u) { return p.tend2; }
  return p.tend3;
}

fn distToSegment(pt: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let ap = pt - a;
  let t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  return length(ap - ab * t);
}

fn alongSegment(pt: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let ap = pt - a;
  return clamp(dot(ap, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
}

// ============================================================
// SHAPE GENERATION — soft, fat shapes for warp to sculpt
// ============================================================

// Gaussian-ish falloff: 1 at center, 0 at edge
fn softFalloff(d: f32, radius: f32) -> f32 {
  let t = clamp(d / radius, 0.0, 1.0);
  return (1.0 - t * t) * (1.0 - t * t); // quartic falloff — fat center, soft edges
}

// Soft gap — gradual fade instead of hard cut
fn gapFade(angle: f32) -> f32 {
  let gapCount = (p.counts >> 24u) & 0xffu;
  var fade = 1.0;
  for (var i = 0u; i < gapCount; i++) {
    let ga = p.gaps[i];
    let diff = abs(wrapAngle(angle - ga));
    fade = min(fade, smoothstep(0.08, 0.35, diff));
  }
  return fade;
}

fn genRingAt(uv: vec2f) -> f32 {
  let center = vec2f(0.5, 0.5);
  let toP = uv - center;
  let dist = length(toP);
  let angle = atan2(toP.y, toP.x);

  let R = p.ringRadius;
  let sw = sectorWidth(angle);

  // Brush stroke ring — thick enough to survive warp without splitting
  // Minimal sector variation to avoid angular facets
  let halfW = R * 0.028 * (0.85 + sw * 0.25);
  let ringDist = abs(dist - R);
  let ink = softFalloff(ringDist, halfW);

  return ink * gapFade(angle);
}

fn genBlobsAt(uv: vec2f) -> f32 {
  let center = vec2f(0.5, 0.5);
  let R = p.ringRadius;
  let blobCount = p.counts & 0xffu;

  var ink = 0.0;
  for (var i = 0u; i < blobCount; i++) {
    let blob = getBlob(i);
    let bTheta = blob.x;
    let bSize = blob.z;
    let bBias = blob.w;

    // Large ink mass centered on the ring — much bigger than before
    let blobCenter = center + vec2f(cos(bTheta), sin(bTheta)) * (R + bBias * R * 0.08);
    let blobRadius = R * (0.12 + bSize * 0.18);
    let d = length(uv - blobCenter);
    ink = max(ink, softFalloff(d, blobRadius));

    // Scatter 5-10 overlapping splats for irregular organic mass
    let splatCount = 5u + u32(bSize * 6.0);
    for (var s = 0u; s < splatCount; s++) {
      let sSeed = pcg(p.seed * 7u + i * 100u + s * 37u);
      let sa = bTheta + (f32(pcg(sSeed)) / 4294967295.0 - 0.5) * 0.8;
      let sr = R + (f32(pcg(sSeed + 1u)) / 4294967295.0 - 0.5) * R * 0.15;
      let sCenter = center + vec2f(cos(sa), sin(sa)) * sr;
      let sRadius = blobRadius * (0.3 + f32(pcg(sSeed + 2u)) / 4294967295.0 * 0.6);
      let sd = length(uv - sCenter);
      ink = max(ink, softFalloff(sd, sRadius));
    }
  }

  return ink;
}

fn genCurlsAt(uv: vec2f) -> f32 {
  let center = vec2f(0.5, 0.5);
  let R = p.ringRadius;
  let curlCount = (p.counts >> 8u) & 0xffu;

  var ink = 0.0;
  for (var i = 0u; i < curlCount; i++) {
    let curl = getCurl(i);
    let cTheta = curl.x;
    let cSize = curl.y;

    // Curl as a splat sitting right on the ring — connected, not floating
    let curlCenter = center + vec2f(cos(cTheta), sin(cTheta)) * R;
    let curlRadius = R * (0.03 + cSize * 0.05);
    let d = length(uv - curlCenter);
    ink = max(ink, softFalloff(d, curlRadius));

    // 2-3 companion dots for organic cluster
    let companionCount = 2u + u32(cSize * 2.0);
    for (var s = 0u; s < companionCount; s++) {
      let sSeed = pcg(p.seed * 13u + i * 71u + s * 53u);
      let sa = cTheta + (f32(pcg(sSeed)) / 4294967295.0 - 0.5) * 0.4;
      let sr = R + R * (-0.01 + f32(pcg(sSeed + 1u)) / 4294967295.0 * 0.05);
      let sCenter = center + vec2f(cos(sa), sin(sa)) * sr;
      let sRadius = curlRadius * (0.4 + f32(pcg(sSeed + 2u)) / 4294967295.0 * 0.4);
      let sd = length(uv - sCenter);
      ink = max(ink, softFalloff(sd, sRadius));
    }
  }

  return ink;
}

fn genTendrilsAt(uv: vec2f) -> f32 {
  let center = vec2f(0.5, 0.5);
  let R = p.ringRadius;
  let tendrilCount = (p.counts >> 16u) & 0xffu;

  var ink = 0.0;
  for (var ti = 0u; ti < tendrilCount; ti++) {
    let tend = getTendril(ti);
    let tTheta = tend.x;
    let lenFactor = tend.y;

    // Radiating rays — clustered around blob direction
    let rayCount = min(5u + u32(lenFactor * 6.0), 12u);

    for (var ri = 0u; ri < rayCount; ri++) {
      let raySeed = pcg(p.seed * 31u + ti * 1000u + ri * 137u);
      let rn1 = f32(pcg(raySeed)) / 4294967295.0;
      let rn2 = f32(pcg(raySeed + 1u)) / 4294967295.0;
      let rn3 = f32(pcg(raySeed + 2u)) / 4294967295.0;
      // Moderate angular spread — clustered, not sprayed everywhere
      let rayAngle = tTheta + (rn1 - 0.5) * 0.9;
      let outAngle = rayAngle + (rn2 - 0.5) * 0.25;

      // Start from the ring surface
      let startR = R + R * 0.01;
      let startPos = center + vec2f(cos(rayAngle), sin(rayAngle)) * startR;
      let rayDir = vec2f(cos(outAngle), sin(outAngle));
      let rayLen = R * lenFactor * (0.5 + rn3 * 0.5);
      let endPos = startPos + rayDir * rayLen;

      let d = distToSegment(uv, startPos, endPos);
      let along = alongSegment(uv, startPos, endPos);
      // Smooth taper: thick at base, fine at tip
      let taper = (1.0 - along) * (1.0 - along * 0.5);
      let baseWidth = R * 0.015 * taper;
      ink = max(ink, softFalloff(d, max(baseWidth, 0.001)));
    }
  }

  return ink;
}

// ============================================================
// ENTRY POINTS
// ============================================================

// Generate shape layer to texture (mode selects shape type)
// Uses: p (binding 0), op (binding 1), dst (binding 5)
@compute @workgroup_size(8, 8)
fn genShape(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(size.x), f32(size.y));

  var v = 0.0;
  switch op.mode {
    case 0u { v = genRingAt(uv); }
    case 1u { v = genBlobsAt(uv); }
    case 2u { v = genCurlsAt(uv); }
    case 3u { v = genTendrilsAt(uv); }
    default {}
  }

  textureStore(dst, gid.xy, vec4f(v, v, v, 1.0));
}

// Warp texture (mode: 0=fluidMorph, 1=dotWarp)
// Uses: op (binding 1), srcSamp (binding 2), srcA (binding 3), dst (binding 5)
@compute @workgroup_size(8, 8)
fn warpTex(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(size.x), f32(size.y));

  var warped: vec2f;
  if (op.mode == 0u) {
    warped = fluidMorph(uv, op.seed, op.strength, op.freq);
  } else {
    warped = dotWarp(uv, op.seed, op.strength, op.freq);
  }

  // Kill edge artifacts from clamp-to-edge sampling during warp
  let borderFade = smoothstep(0.0, 0.015, warped.x) * smoothstep(1.0, 0.985, warped.x)
                 * smoothstep(0.0, 0.015, warped.y) * smoothstep(1.0, 0.985, warped.y);
  let v = textureSampleLevel(srcA, srcSamp, warped, 0.0).r * borderFade;
  textureStore(dst, gid.xy, vec4f(v, v, v, 1.0));
}

// Max-blend two textures
// Uses: srcA (binding 3), srcB (binding 4), dst (binding 5)
@compute @workgroup_size(8, 8)
fn maxBlend(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }

  let a = textureLoad(srcA, gid.xy, 0).r;
  let b = textureLoad(srcB, gid.xy, 0).r;
  let v = max(a, b);
  textureStore(dst, gid.xy, vec4f(v, v, v, 1.0));
}

// Ink blot filter: blur + threshold
// Uses: srcSamp (binding 2), srcA (binding 3), dst (binding 5)
@compute @workgroup_size(8, 8)
fn inkBlot(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(size.x), f32(size.y));
  let tx = 1.0 / f32(size.x);

  // Multi-ring gaussian blur (effective radius ~12px at 2048)
  // Heavily weighted center + 4 rings at increasing radii
  var sum = textureSampleLevel(srcA, srcSamp, uv, 0.0).r * 5.0;
  var weight = 5.0;

  // Ring 1: radius 2px, 8 taps, weight 3
  let r1 = tx * 2.0;
  for (var i = 0u; i < 8u; i++) {
    let a = f32(i) * 0.7854;
    sum += textureSampleLevel(srcA, srcSamp, uv + vec2f(cos(a), sin(a)) * r1, 0.0).r * 3.0;
    weight += 3.0;
  }
  // Ring 2: radius 5px, 8 taps, weight 2
  let r2 = tx * 5.0;
  for (var i = 0u; i < 8u; i++) {
    let a = f32(i) * 0.7854 + 0.3927;
    sum += textureSampleLevel(srcA, srcSamp, uv + vec2f(cos(a), sin(a)) * r2, 0.0).r * 2.0;
    weight += 2.0;
  }
  // Ring 3: radius 9px, 8 taps, weight 1
  let r3 = tx * 9.0;
  for (var i = 0u; i < 8u; i++) {
    let a = f32(i) * 0.7854;
    sum += textureSampleLevel(srcA, srcSamp, uv + vec2f(cos(a), sin(a)) * r3, 0.0).r * 1.0;
    weight += 1.0;
  }
  // Ring 4: radius 14px, 12 taps, weight 0.4
  let r4 = tx * 14.0;
  for (var i = 0u; i < 12u; i++) {
    let a = f32(i) * 0.5236; // PI/6
    sum += textureSampleLevel(srcA, srcSamp, uv + vec2f(cos(a), sin(a)) * r4, 0.0).r * 0.4;
    weight += 0.4;
  }
  sum /= weight;

  // Sharp threshold — the blur already provides the soft edge
  let ink = smoothstep(0.15, 0.35, sum);

  // White background, black ink
  let v = 1.0 - ink;
  textureStore(dst, gid.xy, vec4f(v, v, v, 1.0));
}
