struct Uniforms {
  time: f32,
  width: f32,
  height: f32,
  warpStrength: f32,
  blockSize: f32,
  feedbackAmount: f32,
  feedbackDisplace: f32,
  rgbSplit: f32,
  glitchBurst: f32,
  decay: f32,
  blendToClean: f32,
  pixelSort: f32,
  blockRandom: f32,
  blockStretch: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;
@group(0) @binding(3) var auxTex: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VsOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let p = positions[vid];
  var out: VsOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
  return out;
}

fn hash12(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn hash22(p: vec2f) -> vec2f {
  return vec2f(hash12(p), hash12(p + vec2f(19.19, 73.41))) * 2.0 - vec2f(1.0);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fsWarp(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let t = u.time;
  let _keep = textureSample(auxTex, samp, uv).r * 0.0 + u.time * 0.0;
  let scan = sin((uv.y * 250.0) + t * 11.0) * 0.5 + 0.5;
  let burst = step(0.72, hash12(vec2f(floor(t * 4.0), floor(uv.y * 120.0))));
  let n = hash22(uv * 36.0 + vec2f(t * 0.6, -t * 0.45));
  let drift = vec2f(n.x * 0.008, n.y * 0.006) * u.warpStrength;
  let lineKick = vec2f((scan * burst - 0.25) * 0.02 * u.glitchBurst, 0.0);
  let uv2 = clamp(uv + drift + lineKick, vec2f(0.001), vec2f(0.999));
  return textureSample(srcTex, samp, uv2) + vec4f(_keep);
}

@fragment
fn fsBlock(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let _keep = textureSample(auxTex, samp, uv).r * 0.0 + u.time * 0.0;
  let size = max(1.0, u.blockSize);
  let stretch = max(0.25, u.blockStretch);

  // Stretch skews block aspect ratio, randomSize varies block dimensions per cell.
  let baseCell = vec2f(size * stretch, size / stretch);
  let coarseGrid = vec2f(u.width, u.height) / max(baseCell, vec2f(1.0));
  let coarseId = floor(uv * coarseGrid);
  let rand = hash12(coarseId + vec2f(floor(u.time * 2.0), floor(u.time * 3.0)));
  let randScale = mix(1.0, 0.35 + rand * 1.65, clamp(u.blockRandom, 0.0, 1.0));
  let cell = max(baseCell * randScale, vec2f(1.0));

  let grid = vec2f(u.width, u.height) / cell;
  let blockUv = floor(uv * grid) / grid;
  let jitter = (hash22(blockUv * 40.0 + vec2f(u.time * 0.7, u.time * 0.3)) * 0.0015) * u.glitchBurst;

  let baseUv = clamp(blockUv + jitter, vec2f(0.001), vec2f(0.999));
  let baseSample = textureSample(srcTex, samp, baseUv);
  let baseColor = baseSample.rgb;
  let lum = luma(baseColor);
  let rowId = floor(baseUv.y * u.height / size);
  let baseDir = select(-1.0, 1.0, fract(rowId * 0.618 + floor(u.time * 2.0) * 0.13) > 0.5);
  let controlDir = select(1.0, sign(u.pixelSort), abs(u.pixelSort) > 1e-5);
  let dir = baseDir * controlDir;
  let sortShift = (lum - 0.5) * 0.18 * abs(u.pixelSort) * dir;
  let sortedUv = clamp(baseUv + vec2f(sortShift, 0.0), vec2f(0.001), vec2f(0.999));
  let sortedSample = textureSample(srcTex, samp, sortedUv);
  let sortedColor = sortedSample.rgb;
  let outColor = mix(baseColor, sortedColor, u.pixelSort);
  return vec4f(outColor, baseSample.a) + vec4f(_keep);
}

@fragment
fn fsFeedback(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let px = vec2f(1.0 / max(u.width, 1.0), 1.0 / max(u.height, 1.0));

  let curr = textureSample(srcTex, samp, uv);
  let cL = luma(textureSample(srcTex, samp, uv - vec2f(px.x, 0.0)).rgb);
  let cR = luma(textureSample(srcTex, samp, uv + vec2f(px.x, 0.0)).rgb);
  let cU = luma(textureSample(srcTex, samp, uv - vec2f(0.0, px.y)).rgb);
  let cD = luma(textureSample(srcTex, samp, uv + vec2f(0.0, px.y)).rgb);

  let grad = vec2f(cR - cL, cD - cU);
  let noiseVec = hash22(uv * 64.0 + vec2f(u.time * 0.4, -u.time * 0.2)) * 0.25;
  let motion = (grad + noiseVec) * u.feedbackDisplace;

  let prevUv = clamp(uv - motion, vec2f(0.001), vec2f(0.999));
  let prev = textureSample(auxTex, samp, prevUv);

  let carry = mix(curr, prev, clamp(u.feedbackAmount, 0.0, 0.99));
  let decay = 1.0 - clamp(u.decay, 0.0, 0.5);
  return vec4f(carry.rgb * decay, carry.a);
}

@fragment
fn fsRgb(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let t = u.time;
  let line = floor(uv.y * 420.0);
  let burst = step(0.8, hash12(vec2f(line, floor(t * 6.0))));
  let split = (u.rgbSplit + burst * u.glitchBurst * 1.5) / max(u.width, 1.0);

  let xJitter = (hash12(vec2f(line, floor(t * 20.0))) - 0.5) * (0.02 * u.glitchBurst);
  let baseUv = clamp(uv + vec2f(xJitter, 0.0), vec2f(0.001), vec2f(0.999));

  let r = textureSample(srcTex, samp, clamp(baseUv + vec2f(split, 0.0), vec2f(0.001), vec2f(0.999))).r;
  let g = textureSample(srcTex, samp, baseUv).g;
  let b = textureSample(srcTex, samp, clamp(baseUv - vec2f(split, 0.0), vec2f(0.001), vec2f(0.999))).b;

  let cleanSample = textureSample(auxTex, samp, uv);
  let clean = cleanSample.rgb;
  let damaged = vec3f(r, g, b);
  let outColor = mix(damaged, clean, clamp(u.blendToClean, 0.0, 1.0));
  return vec4f(outColor, cleanSample.a);
}

@fragment
fn fsCopy(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let _keep = textureSample(auxTex, samp, uv).r * 0.0 + u.time * 0.0;
  return textureSample(srcTex, samp, uv) + vec4f(_keep);
}










