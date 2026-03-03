struct Globals {
  viewport : vec2f,
  cam : vec2f,
  zoom : f32,
  now : f32,
  baseSize : f32,
  pixelRatio : f32,
  hoveredId : u32,
  selectedId : u32,
  _pad0 : u32,
  _pad1 : u32,
};

struct Instance {
  pos : vec2f,
  size : f32,
  z : f32,
  color : u32,
  flags : u32,
  t0 : f32,
  due : f32,
  atomId : u32,
  _pad0 : u32,
  _pad1 : u32,
  _pad2 : u32,
};

struct VsOut {
  @builtin(position) position : vec4f,
  @location(0) uv : vec2f,
  @location(1) color : vec4f,
  @location(2) flags : u32,
  @location(3) age : f32,
  @location(4) dueDelta : f32,
  @location(5) urgency : f32,
};

@group(0) @binding(0) var<uniform> globals : Globals;
@group(1) @binding(0) var<storage, read> instances : array<Instance>;

fn decode_color(rgba : u32) -> vec4f {
  let r : f32 = f32(rgba & 0xFFu) / 255.0;
  let g : f32 = f32((rgba >> 8u) & 0xFFu) / 255.0;
  let b : f32 = f32((rgba >> 16u) & 0xFFu) / 255.0;
  let a : f32 = f32((rgba >> 24u) & 0xFFu) / 255.0;
  return vec4f(r, g, b, a);
}

@vertex
fn vs_main(@builtin(vertex_index) vtx : u32, @builtin(instance_index) inst : u32) -> VsOut {
  let quad = array<vec2f, 6>(
    vec2f(-0.5, -0.5),
    vec2f(0.5, -0.5),
    vec2f(0.5, 0.5),
    vec2f(-0.5, -0.5),
    vec2f(0.5, 0.5),
    vec2f(-0.5, 0.5),
  );

  let item = instances[inst];
  let local = quad[vtx] * item.size;
  let world = item.pos + local;
  let centered = (world - globals.cam) * globals.zoom;
  let clip = vec2f(centered.x / (globals.viewport.x * 0.5), centered.y / (globals.viewport.y * 0.5));

  var out : VsOut;
  out.position = vec4f(clip, item.z * 0.002, 1.0);
  out.uv = quad[vtx] + vec2f(0.5, 0.5);
  out.color = decode_color(item.color);
  out.flags = item.flags;
  out.age = max(0.0, globals.now - item.t0);
  out.dueDelta = select(1e9, item.due - globals.now, item.due >= 0.0);
  out.urgency = item.z;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  let isSelected = (in.flags & (1u << 4u)) != 0u;
  let isHovered = (in.flags & (1u << 5u)) != 0u;
  let pulsing = (in.flags & (1u << 6u)) != 0u;
  let archived = (in.flags & (1u << 7u)) != 0u;

  var color = in.color;
  let decay = exp(-in.age / 1209600.0);
  color.rgb *= mix(0.45, 1.0, decay);

  if (archived) {
    color.rgb *= 0.4;
  }

  let urgencyBoost = smoothstep(0.55, 1.0, in.urgency);
  color.rgb = mix(color.rgb, color.rgb * 1.25 + vec3f(0.05, 0.02, 0.0), urgencyBoost * 0.35);

  if (pulsing) {
    let pulse = 0.9 + 0.1 * (0.5 + 0.5 * sin(globals.now * 4.0));
    color.rgb *= pulse;
  }

  var dueAccent = vec3f(0.0, 0.0, 0.0);
  var dueAccentStrength = 0.0;
  if (in.dueDelta < 0.0) {
    dueAccent = vec3f(1.0, 0.3, 0.22);
    dueAccentStrength = 0.95;
  } else if (in.dueDelta < 86400.0) {
    dueAccent = vec3f(1.0, 0.72, 0.3);
    dueAccentStrength = 0.7;
  } else if (in.dueDelta < 3.0 * 86400.0) {
    dueAccent = vec3f(0.95, 0.83, 0.46);
    dueAccentStrength = 0.45;
  }

  let edgeDist = min(min(in.uv.x, in.uv.y), min(1.0 - in.uv.x, 1.0 - in.uv.y));
  let edge = smoothstep(0.02, 0.06, edgeDist);
  let shadow = smoothstep(0.0, 0.08, in.uv.y) * 0.08;
  color.rgb -= shadow;

  var outline = vec3f(0.0, 0.0, 0.0);
  var outlineStrength = 0.0;
  if (isSelected) {
    outline = vec3f(1.0, 0.92, 0.35);
    outlineStrength = 1.0;
  } else if (isHovered) {
    outline = vec3f(0.85, 0.9, 1.0);
    outlineStrength = 0.8;
  }

  let border = 1.0 - smoothstep(0.03, 0.06, edgeDist);
  color.rgb = mix(color.rgb, dueAccent, border * dueAccentStrength);
  color.rgb = mix(color.rgb, outline, border * outlineStrength);
  color.rgb *= edge;

  return vec4f(color.rgb, 1.0);
}
