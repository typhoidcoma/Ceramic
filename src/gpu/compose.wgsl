struct ComposeUniforms {
  color: vec4f,
};

@group(0) @binding(0) var<uniform> u: ComposeUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var fgTex: texture_2d<f32>;

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
  let fg = textureSample(fgTex, samp, in.uv);
  let bg = u.color.rgb * clamp(u.color.a, 0.0, 1.0);
  let outRgb = fg.rgb * fg.a + bg * (1.0 - fg.a);
  return vec4f(outRgb, 1.0);
}

