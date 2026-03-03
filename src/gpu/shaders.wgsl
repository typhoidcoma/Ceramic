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
  growth : f32,
  role : u32,
  _pad2 : u32,
};

struct VsOut {
  @builtin(position) position : vec4f,
  @location(0) uv : vec2f,
  @location(1) color : vec4f,
  @interpolate(flat)
  @location(2) flags : u32,
  @location(3) age : f32,
  @location(4) dueDelta : f32,
  @location(5) urgency : f32,
  @location(7) growth : f32,
  @interpolate(flat)
  @location(6) atomId : u32,
  @interpolate(flat)
  @location(8) role : u32,
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
  out.growth = item.growth;
  out.atomId = item.atomId;
  out.role = item.role;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  let isSelected = (in.flags & (1u << 4u)) != 0u;
  let isHovered = (in.flags & (1u << 5u)) != 0u;
  let pulsing = (in.flags & (1u << 6u)) != 0u;
  let archived = (in.flags & (1u << 7u)) != 0u;
  let dimmed = (in.flags & (1u << 8u)) != 0u;

  var color = in.color;
  let ageBrightness = exp(-in.age / 604800.0);
  color = vec4f(color.rgb * mix(0.22, 1.0, ageBrightness), color.a);

  if (archived) {
    color = vec4f(color.rgb * 0.4, color.a);
  }
  if (dimmed) {
    color = vec4f(color.rgb * 0.35, color.a * 0.55);
  }

  if (pulsing) {
    let atomPhase = f32(in.atomId % 4096u) * 0.017;
    let pulse = 0.9 + 0.1 * (0.5 + 0.5 * sin(globals.now * 4.0 + atomPhase));
    color = vec4f(color.rgb * pulse, color.a);
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

  let baseRadius = select(0.14, 0.24, in.role == 2u);
  let cornerRadius = select(baseRadius, 0.08, in.role == 0u);
  let p = abs(in.uv - vec2f(0.5, 0.5)) - vec2f(0.5 - cornerRadius, 0.5 - cornerRadius);
  let roundedDist = length(max(p, vec2f(0.0, 0.0))) + min(max(p.x, p.y), 0.0) - cornerRadius;
  let fillMask = 1.0 - smoothstep(0.0, 0.01, roundedDist);

  let atomPhase = f32(in.atomId % 4096u) * 0.013;
  let hoverPulse = 0.82 + 0.18 * (0.5 + 0.5 * sin(globals.now * 2.1 + atomPhase));
  let selectedPulse = 0.9 + 0.1 * (0.5 + 0.5 * sin(globals.now * 1.7 + atomPhase * 0.73));
  let hoverStrength = select(0.0, hoverPulse, isHovered);
  let selectedStrength = select(0.0, selectedPulse, isSelected);

  let baseBorder = 1.0 - smoothstep(-0.02, 0.02, abs(roundedDist));
  let ringInner = 1.0 - smoothstep(-0.012, -0.002, roundedDist);
  let ringOuter = 1.0 - smoothstep(0.004, 0.014, roundedDist);
  let ringMask = max(0.0, ringInner - ringOuter);
  let hoverRing = ringMask * hoverStrength * 0.55;
  let selectedRing = ringMask * selectedStrength;
  let hoverGlow = smoothstep(-0.05, 0.0, -roundedDist) * hoverStrength * 0.05;
  let selectedLift = smoothstep(-0.45, -0.06, -roundedDist) * selectedStrength * 0.08;

  var roleAccent = vec3f(0.0, 0.0, 0.0);
  if (in.role == 0u) {
    roleAccent = vec3f(0.43, 0.30, 0.18);
  } else if (in.role == 1u) {
    roleAccent = vec3f(0.22, 0.50, 0.34);
  } else {
    roleAccent = vec3f(0.58, 0.92, 0.78);
  }

  let growthLift = smoothstep(0.0, 1.0, in.growth);
  color = vec4f(mix(color.rgb, roleAccent, 0.2 + 0.35 * growthLift), color.a);
  color = vec4f(mix(color.rgb, vec3f(0.08, 0.10, 0.14), baseBorder * 0.6), color.a);
  color = vec4f(mix(color.rgb, dueAccent, baseBorder * dueAccentStrength), color.a);
  color = vec4f(mix(color.rgb, vec3f(0.70, 0.84, 1.0), hoverRing), color.a);
  color = vec4f(mix(color.rgb, vec3f(1.0, 0.90, 0.42), selectedRing), color.a);
  color = vec4f(color.rgb + vec3f(hoverGlow + selectedLift), color.a);
  let growthMask = smoothstep(-0.35, 0.0, in.growth - roundedDist * 2.4);
  color = vec4f(color.rgb, color.a * fillMask * growthMask);

  return color;
}
