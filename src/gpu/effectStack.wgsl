struct Params {
  time: f32,
  width: f32,
  height: f32,
  seed: f32,
  effectId: f32,
  amount: f32,
  blend: f32,
  _pad0: f32,
  p0: f32,
  p1: f32,
  p2: f32,
  p3: f32,
  p4: f32,
  p5: f32,
  p6: f32,
  p7: f32,
};

@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var srcTex: texture_2d<f32>;
@group(0) @binding(3) var prevTex: texture_2d<f32>;

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

fn hash12(v: vec2f) -> f32 {
  return fract(sin(dot(v, vec2f(127.1, 311.7))) * 43758.5453);
}

fn hash22(v: vec2f) -> vec2f {
  return vec2f(hash12(v), hash12(v + vec2f(19.19, 73.41))) * 2.0 - vec2f(1.0);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn rotate2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn cgaPalette(i: i32) -> vec3f {
  switch i {
    case 0: { return vec3f(0.0, 0.0, 0.0); }
    case 1: { return vec3f(0.0, 0.66, 0.66); }
    case 2: { return vec3f(0.66, 0.0, 0.66); }
    default: { return vec3f(0.83, 0.83, 0.83); }
  }
}

fn glyphRow(id: i32, y: i32) -> u32 {
  switch id {
    case 0: { return 0u; }
    case 1: { if (y == 2) { return 4u; } return 0u; }
    case 2: { if (y == 1 || y == 3) { return 4u; } return 0u; }
    case 3: { if (y == 2) { return 31u; } return 4u; }
    case 4: {
      switch y {
        case 0: { return 21u; }
        case 1: { return 14u; }
        case 2: { return 31u; }
        case 3: { return 14u; }
        default: { return 21u; }
      }
    }
    case 5: { if (y == 1 || y == 3) { return 31u; } return 10u; }
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

fn sampleTex(uv: vec2f) -> vec4f {
  return textureSample(srcTex, samp, clamp(uv, vec2f(0.001), vec2f(0.999)));
}

fn samplePrev(uv: vec2f) -> vec4f {
  return textureSample(prevTex, samp, clamp(uv, vec2f(0.001), vec2f(0.999)));
}

fn hueColor(h: f32) -> vec3f {
  let r = abs(h * 6.0 - 3.0) - 1.0;
  let g = 2.0 - abs(h * 6.0 - 2.0);
  let b = 2.0 - abs(h * 6.0 - 4.0);
  return clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0));
}

fn applyEffect(base: vec4f, uvIn: vec2f) -> vec4f {
  let eid = i32(round(u.effectId));
  let amount = clamp(u.amount, 0.0, 1.0);
  let t = u.time;
  let center = vec2f(0.5, 0.5);
  let px = vec2f(1.0 / max(u.width, 1.0), 1.0 / max(u.height, 1.0));

  if (eid == 1) {
    var uv = uvIn;
    let stretchAmt = max(0.0, u.p1);
    uv.x = mix(uv.x, (uv.x - 0.5) * (1.0 + amount * 2.0 * stretchAmt) + 0.5, amount * (0.5 + abs(u.p0) * 0.5));
    uv.y = mix(uv.y, (uv.y - 0.5) * (1.0 + amount * 2.0 * stretchAmt) + 0.5, amount * (0.5 + max(0.0, -u.p0) * 0.5));
    return sampleTex(uv);
  }

  if (eid == 2) {
    let freq = max(0.1, u.p0);
    let speed = u.p1;
    let amp = max(0.0, u.p2);
    let uv = uvIn + vec2f(0.0, sin(uvIn.x * freq + t * speed) * amp * amount);
    return sampleTex(uv);
  }

  if (eid == 3) {
    let d = uvIn - center;
    let radial = max(0.0, u.p0);
    let twist = u.p1;
    let pull = normalize(d + vec2f(1e-4)) * length(d) * 0.25 * amount * radial;
    let spun = rotate2(d, twist * amount * 0.5) + center;
    return sampleTex(mix(uvIn + pull, spun, abs(twist) * amount * 0.5));
  }

  if (eid == 4) {
    let d = uvIn - center;
    let r = length(d);
    let radius = max(0.01, u.p0);
    let pinch = u.p1;
    let inside = smoothstep(radius, 0.0, r);
    let dir = normalize(d + vec2f(1e-5));
    return sampleTex(uvIn + dir * inside * pinch * 0.25 * amount);
  }

  if (eid == 5) {
    let rot = u.p0 * amount;
    let zoom = max(0.2, u.p1);
    let q = rotate2((uvIn - center) / zoom, rot) + center;
    return sampleTex(q);
  }

  if (eid == 6) {
    var q = uvIn - center;
    let persp = u.p0;
    let yaw = u.p1;
    q.y *= 1.0 - amount * persp * 0.55;
    q.x *= 1.0 + amount * persp * 0.25;
    q = rotate2(q, yaw * amount * 0.7);
    return sampleTex(q + center);
  }

  if (eid == 7) {
    let bands = max(2.0, floor(u.p0));
    let b = floor(uvIn.y * bands);
    let off = (fract(b * 0.37 + t * 0.5) - 0.5) * u.p1 * amount;
    return sampleTex(uvIn + vec2f(off, 0.0));
  }

  if (eid == 8) {
    let count = max(1.0, floor(u.p0));
    let tiled = fract(uvIn * mix(1.0, count, amount));
    return sampleTex(tiled);
  }

  if (eid == 9) {
    var k = uvIn - center;
    let r = length(k);
    var a = atan2(k.y, k.x);
    let seg = max(2.0, floor(u.p0));
    let spin = u.p1;
    let span = 6.2831853 / seg;
    a += spin * t * 0.4;
    a = abs(fract(a / span) * 2.0 - 1.0) * span;
    k = vec2f(cos(a), sin(a)) * r;
    return sampleTex(mix(uvIn, k + center, amount));
  }

  if (eid == 10) {
    let line = floor(uvIn.y * u.height);
    let jitter = (hash12(vec2f(line, floor(t * 20.0))) - 0.5) * u.p0 * amount;
    let bleed = max(0.0, u.p1) * 8.0 * px.x;
    let noiseAmt = max(0.0, u.p2);
    var c = sampleTex(uvIn);
    c.r = sampleTex(uvIn + vec2f(jitter + bleed, 0.0)).r;
    c.b = sampleTex(uvIn - vec2f(jitter + bleed, 0.0)).b;
    let n = (hash12(uvIn * vec2f(u.width, u.height) + vec2f(t * 31.0, -t * 19.0)) - 0.5) * noiseAmt * amount;
    return vec4f(c.rgb + n, c.a);
  }

  if (eid == 11) {
    let c = sampleTex(uvIn).rgb;
    let sepiaAmt = clamp(u.p0, 0.0, 2.0);
    let vignette = max(0.0, u.p1);
    let flicker = max(0.0, u.p2);
    let sepia = vec3f(
      dot(c, vec3f(0.393, 0.769, 0.189)),
      dot(c, vec3f(0.349, 0.686, 0.168)),
      dot(c, vec3f(0.272, 0.534, 0.131))
    );
    let d = length(uvIn - center);
    let vig = 1.0 - smoothstep(0.2, 0.9, d) * vignette * amount;
    let fl = 1.0 + (sin(t * 18.0) * 0.5 + 0.5) * flicker * 0.35 * amount;
    let col = mix(c, sepia, amount * 0.85 * sepiaAmt) * vig * fl;
    return vec4f(col, base.a);
  }

  if (eid == 12) {
    let c = sampleTex(uvIn).rgb;
    let line = 0.5 + 0.5 * sin(uvIn.y * u.height * 1.2);
    let strength = clamp(u.p0 * amount, 0.0, 1.0);
    let curvature = clamp(u.p1, 0.0, 1.0) * amount;
    let d = uvIn - center;
    let curve = 1.0 - dot(d, d) * curvature * 1.2;
    let darken = mix(1.0, 1.0 - line * 0.55, strength) * curve;
    return vec4f(c * darken, base.a);
  }

  if (eid == 13) {
    let c = sampleTex(uvIn).rgb;
    let paletteMix = clamp(u.p0, 0.0, 1.0);
    let levels = max(2.0, floor(u.p1));
    let post = floor(c * levels) / levels;
    let idx = i32(clamp(round(luma(post) * 3.0), 0.0, 3.0));
    return vec4f(mix(c, mix(post, cgaPalette(idx), paletteMix), amount), base.a);
  }

  if (eid == 14) {
    let distance = max(1.0, u.p0);
    let intensity = max(0.0, u.p1);
    let c = sampleTex(uvIn).rgb;
    let streak = (sampleTex(uvIn + vec2f(px.x * distance, 0.0)).rgb + sampleTex(uvIn - vec2f(px.x * distance, 0.0)).rgb) * 0.5;
    return vec4f(c + streak * amount * 0.25 * intensity, base.a);
  }

  if (eid == 15) {
    let c = sampleTex(uvIn).rgb;
    let lum = luma(c);
    let cutoff = clamp(u.p0, 0.0, 1.0);
    let strength = max(0.0, u.p1);
    let bleached = vec3f(clamp((lum - cutoff) * 1.9 + 0.5, 0.0, 1.0));
    return vec4f(mix(c, bleached, amount * strength), base.a);
  }

  if (eid == 16) {
    let levels = max(2.0, floor(u.p0));
    let bleed = max(0.0, u.p1);
    let c = sampleTex(uvIn).rgb;
    let blur = (sampleTex(uvIn + vec2f(px.x * bleed, 0.0)).rgb + sampleTex(uvIn - vec2f(px.x * bleed, 0.0)).rgb + sampleTex(uvIn + vec2f(0.0, px.y * bleed)).rgb + sampleTex(uvIn - vec2f(0.0, px.y * bleed)).rgb) * 0.25;
    let wc = floor(blur * levels) / levels;
    return vec4f(mix(c, wc, amount), base.a);
  }

  if (eid == 17) {
    let c = sampleTex(uvIn).rgb;
    let speed = max(0.0, u.p0);
    let size = max(0.2, u.p1);
    let intensity = max(0.0, u.p2);
    let n = hash12(uvIn * vec2f(u.width, u.height) / size + vec2f(t * speed, t * 0.5)) - 0.5;
    return vec4f(c + n * 0.18 * amount * intensity, base.a);
  }

  if (eid == 18) {
    let strength = max(0.0, u.p0);
    let radius = max(0.5, u.p1);
    let c = sampleTex(uvIn).rgb;
    let blur = (sampleTex(uvIn + vec2f(px.x * radius, 0.0)).rgb + sampleTex(uvIn - vec2f(px.x * radius, 0.0)).rgb + sampleTex(uvIn + vec2f(0.0, px.y * radius)).rgb + sampleTex(uvIn - vec2f(0.0, px.y * radius)).rgb) * 0.25;
    return vec4f(mix(c, c * (1.0 + strength) - blur * strength, amount), base.a);
  }

  if (eid == 19) {
    let radius = max(0.5, u.p0);
    let mixAmt = clamp(u.p1, 0.0, 1.0);
    let c = sampleTex(uvIn).rgb;
    let blur = (sampleTex(uvIn + vec2f(px.x * radius, 0.0)).rgb + sampleTex(uvIn - vec2f(px.x * radius, 0.0)).rgb + sampleTex(uvIn + vec2f(0.0, px.y * radius)).rgb + sampleTex(uvIn - vec2f(0.0, px.y * radius)).rgb) * 0.25;
    return vec4f(mix(c, blur, amount * mixAmt), base.a);
  }

  if (eid == 20) {
    let c = sampleTex(uvIn).rgb;
    let phase = u.p1;
    let shift = (luma(c) - 0.5) * u.p0 * amount + sin((uvIn.y + t) * 12.0 + phase) * 0.003 * amount;
    return sampleTex(uvIn + vec2f(shift, -shift));
  }

  if (eid == 21) {
    let curr = sampleTex(uvIn);
    let prev = samplePrev(uvIn);
    let currLum = luma(curr.rgb);
    let prevLum = luma(prev.rgb);

    let gx = (luma(sampleTex(uvIn + vec2f(px.x, 0.0)).rgb) - luma(sampleTex(uvIn - vec2f(px.x, 0.0)).rgb)) * 0.5;
    let gy = (luma(sampleTex(uvIn + vec2f(0.0, px.y)).rgb) - luma(sampleTex(uvIn - vec2f(0.0, px.y)).rgb)) * 0.5;
    let grad = vec2f(gx, gy);
    let it = currLum - prevLum;

    // Single-step Lucas-Kanade style flow estimate.
    let lambda = 0.003 + abs(u.p1) * 0.04;
    let denom = dot(grad, grad) + lambda;
    var flow = grad * (-it / denom);

    let mag = length(flow);
    if (mag > 2.5) {
      flow = flow * (2.5 / mag);
    }

    let conf = smoothstep(0.0004, 0.02, dot(grad, grad));
    let scale = max(0.0, u.p0);
    let warped = sampleTex(uvIn + flow * scale * 1.6);
    let mixAmt = amount * conf;
    return vec4f(mix(curr.rgb, warped.rgb, mixAmt), base.a);
  }

  if (eid == 22) {
    let cells = max(4.0, floor(u.p0));
    let contrast = max(0.2, u.p1);
    let cellId = floor(uvIn * cells);
    let localUv = fract(uvIn * cells);
    let centerUv = (cellId + vec2f(0.5)) / cells;
    let src = sampleTex(centerUv).rgb;
    let lv = clamp((luma(src) - 0.5) * contrast + 0.5, 0.0, 1.0);
    let glyphId = i32(clamp(floor(lv * 8.0), 0.0, 7.0));
    let g = sampleGlyph(glyphId, localUv);
    let bg = vec3f(lv * 0.12);
    let fg = vec3f(0.15 + lv * 0.9);
    let asciiColor = mix(bg, fg, g);
    return vec4f(mix(sampleTex(uvIn).rgb, asciiColor, amount), base.a);
  }

  if (eid == 23) {
    let levels = max(2.0, floor(u.p0));
    let spread = clamp(u.p1, 0.0, 1.0);
    let bayer = fract((floor(uvIn.x * u.width) + floor(uvIn.y * u.height) * 2.0) * 0.25);
    let c = sampleTex(uvIn).rgb;
    let d = floor(c * levels + bayer * spread) / levels;
    return vec4f(mix(c, d, amount), base.a);
  }

  if (eid == 24) {
    let c = sampleTex(uvIn).rgb;
    let intensity = max(0.0, u.p1);
    let tint = hueColor(fract(u.p0 + t * 0.03));
    let over = clamp(c + tint * 0.5 * intensity, vec3f(0.0), vec3f(1.0));
    return vec4f(mix(c, over, amount), base.a);
  }

  if (eid == 25) {
    let c = sampleTex(uvIn);
    let lum = luma(c.rgb);
    let edge0 = max(0.0, u.p0 - u.p1 * 0.5);
    let edge1 = min(1.0, u.p0 + u.p1 * 0.5 + 1e-4);
    var m = smoothstep(edge0, edge1, lum);
    if (u.p2 > 0.5) { m = 1.0 - m; }
    return vec4f(c.rgb, mix(1.0, m, amount));
  }

  if (eid == 26) {
    let c = sampleTex(uvIn);
    let size = max(2.0, u.p1);
    let block = floor(uvIn * size);
    let mode = i32(round(u.p0));
    let jitter = hash22(block + vec2f(floor(t * max(0.0, u.p4 + 0.001)), 1.0)) * u.p4;
    var sampleUv = uvIn;
    if (mode == 0) {
      sampleUv = (block + vec2f(0.5)) / size;
    } else if (mode == 1) {
      sampleUv = (block + vec2f(0.5) + jitter * 0.5) / size;
    } else {
      let cell = floor((uvIn + jitter * 0.02) * (size * 0.75));
      sampleUv = (cell + vec2f(0.5)) / (size * 0.75);
    }
    let mSrc = sampleTex(sampleUv).rgb;
    let l = luma(mSrc);
    let chroma = max(mSrc.g - max(mSrc.r, mSrc.b), 0.0);
    let srcVal = mix(l, chroma, step(0.5, u.p7));
    let edge0 = max(0.0, u.p2 - u.p3 * 0.5);
    let edge1 = min(1.0, u.p2 + u.p3 * 0.5 + 1e-4);
    var m = smoothstep(edge0, edge1, srcVal);
    if (u.p5 > 0.5) { m = 1.0 - m; }
    let alpha = mix(1.0, m, amount);
    let glow = vec3f(u.p6 * amount * (1.0 - abs(m - 0.5) * 2.0));
    return vec4f(c.rgb + glow, alpha);
  }

  if (eid == 27) {
    let c = sampleTex(uvIn);
    let hueTarget = u.p0;
    let keyColor = hueColor(hueTarget);
    let dist = distance(c.rgb, keyColor);
    let th = u.p1;
    let soft = max(0.001, u.p2);
    let spill = clamp(u.p3, 0.0, 1.0);
    let m = smoothstep(th - soft, th + soft, dist);
    let despill = mix(c.rgb, vec3f(c.r, max(c.g - spill * 0.35, 0.0), c.b), amount);
    return vec4f(despill, mix(1.0, m, amount));
  }

  if (eid == 28) {
    let c = sampleTex(uvIn).rgb;
    let lum = luma(c);
    let sat = u.p0;
    let con = u.p1;
    let brightness = u.p2;
    let hueShift = u.p3;
    var cc = mix(vec3f(lum), c, sat);
    cc = (cc - 0.5) * con + 0.5 + vec3f(brightness);
    let yiq = mat3x3<f32>(
      vec3f(0.299, 0.587, 0.114),
      vec3f(0.596, -0.274, -0.322),
      vec3f(0.211, -0.523, 0.312)
    ) * cc;
    let h = atan2(yiq.z, yiq.y) + hueShift * 3.1415926;
    let chroma = length(vec2f(yiq.y, yiq.z));
    let shifted = vec3f(yiq.x, chroma * cos(h), chroma * sin(h));
    let rgb = mat3x3<f32>(
      vec3f(1.0, 0.956, 0.621),
      vec3f(1.0, -0.272, -0.647),
      vec3f(1.0, -1.106, 1.703)
    ) * shifted;
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), base.a);
  }

  if (eid == 29) {
    let c = sampleTex(uvIn).rgb;
    let rate = max(0.1, u.p0);
    let duty = clamp(u.p1, 0.05, 0.95);
    let intensity = max(0.0, u.p2);
    let phase = fract(t * rate);
    let pulse = step(phase, duty);
    let st = c * (0.25 + pulse * intensity);
    return vec4f(mix(c, st, amount), base.a);
  }

  return base;
}

fn blendSoftLight(base: vec3f, blend: vec3f) -> vec3f {
  let low = base - (vec3f(1.0) - 2.0 * blend) * base * (vec3f(1.0) - base);
  let high = base + (2.0 * blend - vec3f(1.0)) * (sqrt(max(base, vec3f(0.0))) - base);
  return mix(low, high, step(vec3f(0.5), blend));
}

fn applyBlendMode(base: vec3f, effected: vec3f, mode: i32) -> vec3f {
  if (mode == 1) {
    return base * effected;
  }
  if (mode == 2) {
    return vec3f(1.0) - (vec3f(1.0) - base) * (vec3f(1.0) - effected);
  }
  if (mode == 3) {
    let low = 2.0 * base * effected;
    let high = vec3f(1.0) - 2.0 * (vec3f(1.0) - base) * (vec3f(1.0) - effected);
    return mix(low, high, step(vec3f(0.5), base));
  }
  if (mode == 4) {
    return clamp(base + effected, vec3f(0.0), vec3f(1.0));
  }
  if (mode == 5) {
    return abs(base - effected);
  }
  if (mode == 6) {
    return blendSoftLight(base, effected);
  }
  return effected;
}
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let base = sampleTex(in.uv);
  let effected = applyEffect(base, in.uv);
  let layerMix = clamp(u.blend, 0.0, 1.0);
  let blendMode = i32(round(u._pad0));
  let eid = i32(round(u.effectId));

  let srcRgb = clamp(effected.rgb, vec3f(0.0), vec3f(1.0));
  let modeRgb = clamp(applyBlendMode(base.rgb, srcRgb, blendMode), vec3f(0.0), vec3f(1.0));
  let outRgb = mix(base.rgb, modeRgb, layerMix);

  let baseA = clamp(base.a, 0.0, 1.0);
  let fxA = clamp(effected.a, 0.0, 1.0);
  let isAlphaFx = (eid == 25 || eid == 26 || eid == 27);
  let alphaTarget = select(baseA, baseA * fxA, isAlphaFx);
  let outA = mix(baseA, alphaTarget, layerMix);

  return vec4f(outRgb, outA);
}










