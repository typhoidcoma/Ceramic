struct SourceUniforms {
  width: f32,
  height: f32,
  sourceMode: f32,
  hasMedia: f32,
  mediaOpacity: f32,
  _pad0: vec3<f32>,
};

@group(0) @binding(0) var<uniform> u: SourceUniforms;
@group(0) @binding(1) var bgSampler: sampler;
@group(0) @binding(2) var bgTex: texture_2d<f32>;

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

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let canvasAspect = u.width / max(1.0, u.height);

  var squareUv = uv;
  if (canvasAspect > 1.0) {
    let w = 1.0 / canvasAspect;
    squareUv.x = (uv.x - (1.0 - w) * 0.5) / w;
  } else {
    let h = canvasAspect;
    squareUv.y = (uv.y - (1.0 - h) * 0.5) / h;
  }

  let inSquare = step(0.0, squareUv.x) * step(squareUv.x, 1.0) * step(0.0, squareUv.y) * step(squareUv.y, 1.0);
  let mode = i32(round(u.sourceMode));

  if (mode == 0) {
    let color = textureSample(bgTex, bgSampler, clamp(squareUv, vec2f(0.001), vec2f(0.999))).rgb;
    return vec4f(color, inSquare * u.mediaOpacity);
  }

  if (u.hasMedia < 0.5) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }

  let texSize = vec2f(textureDimensions(bgTex));
  let imgAspect = texSize.x / max(texSize.y, 1.0);

  var imgUv = squareUv;
  if (imgAspect > 1.0) {
    let h = 1.0 / imgAspect;
    imgUv.y = (squareUv.y - (1.0 - h) * 0.5) / h;
  } else {
    let w = imgAspect;
    imgUv.x = (squareUv.x - (1.0 - w) * 0.5) / w;
  }

  let inImage = step(0.0, imgUv.x) * step(imgUv.x, 1.0) * step(0.0, imgUv.y) * step(imgUv.y, 1.0);
  let color = textureSample(bgTex, bgSampler, clamp(imgUv, vec2f(0.001), vec2f(0.999))).rgb;
  let alpha = inSquare * inImage * u.mediaOpacity;
  return vec4f(color, alpha);
}
