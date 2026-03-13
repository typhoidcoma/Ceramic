struct Params {
  time: f32,
  width: f32,
  height: f32,
  _pad0: f32,

  stretch: f32,
  wave: f32,
  pushAmount: f32,
  bulge: f32,

  transformAmt: f32,
  transform3d: f32,
  splitter: f32,
  tile: f32,

  kaleidoscope: f32,
  vhs: f32,
  super8: f32,
  crt: f32,

  cga: f32,
  lightStreak: f32,
  bleach: f32,
  watercolor: f32,

  grain: f32,
  sharpen: f32,
  blur: f32,
  lumaMesh: f32,

  opticalFlow: f32,
  asciiFx: f32,
  dither: f32,
  overlay: f32,

  mask: f32,
  maskBlocks: f32,
  chromaKey: f32,
  audioViz: f32,

  colorCorrection: f32,
  strobe: f32,
  _pad1: vec2<f32>,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

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
  let pt = positions[vid];
  var out: VsOut;
  out.pos = vec4f(pt, 0.0, 1.0);
  out.uv = vec2f(pt.x * 0.5 + 0.5, 1.0 - (pt.y * 0.5 + 0.5));
  return out;
}

fn hash12(v: vec2f) -> f32 {
  return fract(sin(dot(v, vec2f(127.1, 311.7))) * 43758.5453);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn rotate2(uv: vec2f, angle: f32) -> vec2f {
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
}

fn cgaPalette(i: i32) -> vec3f {
  switch i {
    case 0: { return vec3f(0.0, 0.0, 0.0); }
    case 1: { return vec3f(0.0, 0.66, 0.66); }
    case 2: { return vec3f(0.66, 0.0, 0.66); }
    case 3: { return vec3f(0.83, 0.83, 0.83); }
    default: { return vec3f(0.0); }
  }
}

fn glyphRow(id: i32, y: i32) -> u32 {
  switch id {
    case 0: { return 0u; } // space
    case 1: {
      if (y == 2) { return 4u; }
      return 0u;
    }
    case 2: {
      if (y == 1 || y == 3) { return 4u; }
      return 0u;
    }
    case 3: {
      if (y == 2) { return 31u; }
      return 4u;
    }
    case 4: {
      switch y {
        case 0: { return 21u; }
        case 1: { return 14u; }
        case 2: { return 31u; }
        case 3: { return 14u; }
        default: { return 21u; }
      }
    }
    case 5: {
      if (y == 1 || y == 3) { return 31u; }
      return 10u;
    }
    case 6: {
      switch y {
        case 0: { return 14u; }
        case 1: { return 17u; }
        case 2: { return 31u; }
        case 3: { return 17u; }
        default: { return 17u; }
      }
    }
    default: {
      switch y {
        case 0: { return 17u; }
        case 1: { return 27u; }
        case 2: { return 21u; }
        case 3: { return 17u; }
        default: { return 17u; }
      }
    }
  }
}

fn sampleGlyph(id: i32, localUv: vec2f) -> f32 {
  let x = i32(floor(clamp(localUv.x, 0.0, 0.999) * 5.0));
  let y = i32(floor(clamp(1.0 - localUv.y, 0.0, 0.999) * 5.0));
  let row = glyphRow(id, y);
  let bit = (row >> u32(4 - x)) & 1u;
  return f32(bit);
}
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let t = p.time;
  var uv = in.uv;
  let center = vec2f(0.5, 0.5);
  let px = vec2f(1.0 / max(1.0, p.width), 1.0 / max(1.0, p.height));

  // Distortion / spatial
  uv.x = mix(uv.x, (uv.x - 0.5) * (1.0 + p.stretch * 1.8) + 0.5, p.stretch);
  uv.y += sin(uv.x * 24.0 + t * 3.5) * 0.03 * p.wave;
  let dir = normalize((uv - center) + vec2f(1e-4));
  uv += dir * (p.pushAmount * 0.08);

  let d = distance(uv, center);
  uv += normalize((uv - center) + vec2f(1e-4)) * d * (p.bulge * 0.15);

  var q = uv - center;
  q = rotate2(q, p.transformAmt * 1.5);
  q.y *= mix(1.0, 0.65 + 0.35 * cos(q.x * 3.1415 + t * 1.2), p.transform3d);
  uv = q + center;

  if (p.splitter > 0.001) {
    let splitBands = 1.0 + floor(p.splitter * 10.0);
    let band = floor(uv.y * splitBands);
    uv.x += (fract(band * 0.37 + t * 0.2) - 0.5) * 0.12 * p.splitter;
  }

  let tileCount = 1.0 + floor(p.tile * 8.0);
  uv = mix(uv, fract(uv * tileCount), p.tile);

  if (p.kaleidoscope > 0.001) {
    var k = uv - center;
    let r = length(k);
    var a = atan2(k.y, k.x);
    let seg = 3.0 + floor(p.kaleidoscope * 9.0);
    let span = 6.2831853 / seg;
    a = abs(fract(a / span) * 2.0 - 1.0) * span;
    k = vec2f(cos(a), sin(a)) * r;
    uv = k + center;
  }

  uv = clamp(uv, vec2f(0.001), vec2f(0.999));
  var color = textureSample(srcTex, samp, uv).rgb;

  // Retro/analog
  let line = floor(in.uv.y * p.height);
  let lineJitter = (hash12(vec2f(line, floor(t * 20.0))) - 0.5) * 0.03 * p.vhs;
  color.r = textureSample(srcTex, samp, clamp(uv + vec2f(lineJitter, 0.0), vec2f(0.001), vec2f(0.999))).r;

  let sepia = vec3f(
    dot(color, vec3f(0.393, 0.769, 0.189)),
    dot(color, vec3f(0.349, 0.686, 0.168)),
    dot(color, vec3f(0.272, 0.534, 0.131))
  );
  color = mix(color, sepia, p.super8 * 0.8);

  let scan = sin(in.uv.y * p.height * 1.2) * 0.08 * p.crt;
  color *= 1.0 - scan;

  if (p.cga > 0.001) {
    let idx = i32(clamp(round(luma(color) * 3.0), 0.0, 3.0));
    color = mix(color, cgaPalette(idx), p.cga);
  }

  // Stylization
  let blurCol = (
    textureSample(srcTex, samp, uv + vec2f(px.x, 0.0)).rgb +
    textureSample(srcTex, samp, uv - vec2f(px.x, 0.0)).rgb +
    textureSample(srcTex, samp, uv + vec2f(0.0, px.y)).rgb +
    textureSample(srcTex, samp, uv - vec2f(0.0, px.y)).rgb
  ) * 0.25;

  let streak = (
    textureSample(srcTex, samp, uv + vec2f(px.x * 6.0, 0.0)).rgb +
    textureSample(srcTex, samp, uv - vec2f(px.x * 6.0, 0.0)).rgb
  ) * 0.5;
  color += streak * (p.lightStreak * 0.25);

  let sharp = color * 1.8 - blurCol * 0.8;
  color = mix(color, sharp, p.sharpen);
  color = mix(color, blurCol, p.blur * 0.9);

  let wc = floor((blurCol * (5.0 + p.watercolor * 12.0))) / (5.0 + p.watercolor * 12.0);
  color = mix(color, wc, p.watercolor);

  let lum = luma(color);
  color = mix(color, vec3f(clamp((lum - 0.42) * 1.9 + 0.5, 0.0, 1.0)), p.bleach);

  let n = hash12(in.uv * vec2f(p.width, p.height) + vec2f(t * 7.0, t * 3.0)) - 0.5;
  color += n * 0.16 * p.grain;

  // Procedural experimental
  let meshShift = (lum - 0.5) * 0.05 * p.lumaMesh;
  let meshCol = textureSample(srcTex, samp, clamp(uv + vec2f(meshShift, -meshShift), vec2f(0.001), vec2f(0.999))).rgb;
  color = mix(color, meshCol, p.lumaMesh);

  let flow = vec2f(dpdx(luma(color)), dpdy(luma(color))) * 2.5 * p.opticalFlow;
  color = textureSample(srcTex, samp, clamp(uv + flow, vec2f(0.001), vec2f(0.999))).rgb * p.opticalFlow + color * (1.0 - p.opticalFlow);

      // Image processing
  if (p.asciiFx > 0.001) {
    let cells = 14.0 + floor(p.asciiFx * 80.0);
    let cellId = floor(in.uv * cells);
    let localUv = fract(in.uv * cells);
    let cellCenter = (cellId + vec2f(0.5, 0.5)) / cells;

    let src = textureSample(srcTex, samp, clamp(cellCenter, vec2f(0.001), vec2f(0.999))).rgb;
    let l = luma(src);
    let glyphId = i32(clamp(floor(l * 8.0), 0.0, 7.0));
    let g = sampleGlyph(glyphId, localUv);

    let bg = vec3f(l * 0.12);
    let fg = vec3f(0.15 + l * 0.9);
    let asciiColor = mix(bg, fg, g);
    color = mix(color, asciiColor, p.asciiFx);
  }

  if (p.dither > 0.001) {
    let bayer = fract((floor(in.uv.x * p.width) + floor(in.uv.y * p.height) * 2.0) * 0.25);
    color = floor(color * 4.0 + bayer) / 4.0;
    color = mix(textureSample(srcTex, samp, uv).rgb, color, p.dither);
  }

  // Composition/masking
  let overlayTint = vec3f(0.15, 0.35, 0.55) * (sin(t * 1.3) * 0.5 + 0.5);
  color = mix(color, clamp(color + overlayTint, vec3f(0.0), vec3f(1.0)), p.overlay * 0.45);

  let m = smoothstep(0.25, 0.85, luma(color));
  color *= mix(1.0, m, p.mask);

  let block = floor(in.uv * (6.0 + p.maskBlocks * 32.0));
  let blockMask = step(0.35, hash12(block + vec2f(floor(t * 2.0), 1.0)));
  color *= mix(1.0, blockMask, p.maskBlocks);

  let green = smoothstep(0.25, 0.8, color.g - max(color.r, color.b));
  color = mix(color, color * (1.0 - green), p.chromaKey);

  // Utility
  let bars = step(0.96 - p.audioViz * 0.2, abs(sin(in.uv.x * 40.0 + t * 4.0)));
  color = mix(color, color + vec3f(0.0, bars * 0.35, bars * 0.45), p.audioViz * 0.6);

  let ccLum = luma(color);
  let sat = 1.0 + p.colorCorrection * 0.8;
  color = mix(vec3f(ccLum), color, sat);
  color = (color - 0.5) * (1.0 + p.colorCorrection * 0.5) + 0.5;

  let st = step(0.7, fract(t * (2.0 + p.strobe * 18.0)));
  color = mix(color, color * (0.25 + st * 1.5), p.strobe);

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}




