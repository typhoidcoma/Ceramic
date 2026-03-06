// Density field update: combine particle deposits + diffusion + attraction + decay

struct Params {
  presence: f32,
  time: f32,
  frame: u32,
  _pad: u32,
};

@group(0) @binding(0) var simIn: texture_2d<f32>;
@group(0) @binding(1) var simOut: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read_write> deposits: array<atomic<u32>>;
@group(0) @binding(3) var goalTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> params: Params;

const GRID: i32 = 2048;
const DEPOSIT_SCALE: f32 = 0.001; // convert deposit units to 0-1 density

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u32(GRID) || gid.y >= u32(GRID)) { return; }

  let pos = vec2i(gid.xy);
  let maxC = vec2i(GRID - 1);
  let idx = gid.y * u32(GRID) + gid.x;

  // Previous density
  let current = textureLoad(simIn, pos, 0).r;

  // Read and clear particle deposits
  let rawDeposit = atomicLoad(&deposits[idx]);
  atomicStore(&deposits[idx], 0u);
  let deposit = f32(rawDeposit) * DEPOSIT_SCALE;

  // Neighbor densities for diffusion
  let nU = textureLoad(simIn, clamp(pos + vec2i(0, -1), vec2i(0), maxC), 0).r;
  let nD = textureLoad(simIn, clamp(pos + vec2i(0,  1), vec2i(0), maxC), 0).r;
  let nL = textureLoad(simIn, clamp(pos + vec2i(-1, 0), vec2i(0), maxC), 0).r;
  let nR = textureLoad(simIn, clamp(pos + vec2i( 1, 0), vec2i(0), maxC), 0).r;
  let nAvg = (nU + nD + nL + nR) * 0.25;

  // Target ink
  let targetInk = 1.0 - textureLoad(goalTex, pos, 0).r;

  let pres = params.presence;
  let absence = 1.0 - pres;

  // === DIFFUSION ===
  // Strong diffusion so deposited ink spreads inward from landing spots,
  // filling the shape organically rather than staying as edge outlines.
  // During dismiss, dissolve even more aggressively.
  let freshness = 1.0 - current * 0.4;
  let baseDiff = 0.28 * freshness;
  let dismissDiff = absence * absence * 0.25;
  let diffused = mix(current, nAvg, baseDiff + dismissDiff);

  // === ATTRACTION ===
  // Pull density toward target shape, but ONLY where significant ink already exists.
  // High threshold prevents the target outline from being revealed before particles arrive.
  let hasInk = clamp((current - 0.25) * 2.5, 0.0, 1.0); // kicks in at 0.25, full at 0.65
  let attract = (targetInk - diffused) * pres * 0.004 * hasInk * hasInk;

  // === DECAY ===
  // Slight steady fade + aggressive dissolve during dismiss
  let decay = 0.0005 + absence * absence * 0.015;

  // === COMBINE ===
  let result = clamp(diffused + deposit + attract - decay, 0.0, 1.0);

  textureStore(simOut, gid.xy, vec4f(result, result, result, 1.0));
}
