// Particle update + deposit compute shader

struct Particle {
  pos: vec2f,
  vel: vec2f,
  life: f32,
  phase: f32,
  _pad: vec2f,
};

struct Params {
  presence: f32,
  time: f32,
  frame: u32,
  particleCount: u32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> deposits: array<atomic<u32>>;
@group(0) @binding(2) var goalTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

const GRID: u32 = 2048u;
const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318530;

// Better hash: pcg-style
fn pcg(n: u32) -> u32 {
  var v = n * 747796405u + 2891336453u;
  let word = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rng(seed: u32, offset: u32) -> f32 {
  return f32(pcg(seed + offset)) / 4294967295.0;
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

// Sample gradient from goalTex at a given mip level
fn sampleGrad(pos: vec2f, mipLevel: u32) -> vec2f {
  let mipSize = f32(2048u >> mipLevel);
  let mipMax = i32(mipSize) - 1;
  let mp = vec2i(clamp(pos * mipSize, vec2f(0.0), vec2f(f32(mipMax))));
  let cL = 1.0 - textureLoad(goalTex, clamp(mp + vec2i(-1, 0), vec2i(0), vec2i(mipMax)), mipLevel).r;
  let cR = 1.0 - textureLoad(goalTex, clamp(mp + vec2i( 1, 0), vec2i(0), vec2i(mipMax)), mipLevel).r;
  let cU = 1.0 - textureLoad(goalTex, clamp(mp + vec2i(0, -1), vec2i(0), vec2i(mipMax)), mipLevel).r;
  let cD = 1.0 - textureLoad(goalTex, clamp(mp + vec2i(0,  1), vec2i(0), vec2i(mipMax)), mipLevel).r;
  return vec2f(cR - cL, cD - cU);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.particleCount) { return; }

  var p = particles[idx];

  // Good random seed per particle per frame
  let seed = pcg(params.frame * 16777259u + idx);
  let r1 = rng(seed, 0u);
  let r2 = rng(seed, 1u);
  let r3 = rng(seed, 2u);
  let r4 = rng(seed, 3u);
  let r5 = rng(seed, 4u);
  let r6 = rng(seed, 5u);

  let pres = params.presence;

  // === RESPAWN dead particles ===
  if (p.life <= 0.0) {
    if (pres > 0.02 && r1 < pres * 0.95) {
      // Emit from all 4 edges, aimed inward
      let edge = u32(r6 * 4.0);
      if (edge == 0u) {
        p.pos = vec2f(r4, 0.96 + r5 * 0.03);
      } else if (edge == 1u) {
        p.pos = vec2f(r4, 0.01 + r5 * 0.03);
      } else if (edge == 2u) {
        p.pos = vec2f(0.01 + r5 * 0.03, r4);
      } else {
        p.pos = vec2f(0.96 + r5 * 0.03, r4);
      }

      // Aim toward center with spread
      let toCenter = vec2f(0.5, 0.5) - p.pos;
      let dir = normalize(toCenter);
      let spd = 0.005 + r3 * 0.005;
      // Add tangential component for swirl
      let perp = vec2f(-dir.y, dir.x);
      p.vel = dir * spd + perp * (r2 - 0.5) * 0.004;

      p.life = 100.0 + r3 * 200.0;
      p.phase = r2 * TAU;
    }
    particles[idx] = p;
    return;
  }

  // === SAMPLE TARGET ===
  let texPos = vec2i(clamp(p.pos * 2048.0, vec2f(0.0), vec2f(2047.0)));
  let targetHere = 1.0 - textureLoad(goalTex, texPos, 0).r;

  // === MULTI-SCALE GRADIENT ===
  // Far field (mip 6 = 16x16): long-range homing
  let farGrad = sampleGrad(p.pos, 6u);
  // Mid field (mip 4 = 64x64): medium range
  let midGrad = sampleGrad(p.pos, 4u);
  // Near field (mip 2 = 256x256): precision
  let nearGrad = sampleGrad(p.pos, 2u);

  // === FORCES ===

  // 1. Blend gradients based on proximity to ink
  let nearInk = clamp(targetHere * 3.0, 0.0, 1.0);
  let grad = mix(farGrad * 3.0 + midGrad * 1.5, nearGrad, nearInk);
  let attractForce = grad * 0.003 * pres;

  // 2. Settle: slam the brakes when on target
  let settleDrag = targetHere * 0.45;

  // 3. Turbulence: swirling noise (suppressed on target to prevent jitter)
  let nx = valueNoise(0x12345678u, p.pos.x * 5.0 + params.time * 0.02, p.pos.y * 5.0 + p.phase);
  let ny = valueNoise(0x87654321u, p.pos.x * 5.0 + p.phase, p.pos.y * 5.0 + params.time * 0.02);
  let turbBase = 0.0002 * (1.0 - targetHere * 0.8);
  let turbDismiss = (1.0 - pres) * 0.001;
  let turbulence = vec2f(nx - 0.5, ny - 0.5) * (turbBase + turbDismiss);

  // 4. Base drag
  let drag = 0.015 + settleDrag;

  // Apply
  p.vel = p.vel * (1.0 - drag) + attractForce + turbulence;

  // Speed limit
  let speed = length(p.vel);
  if (speed > 0.012) {
    p.vel = p.vel / speed * 0.012;
  }

  // Move
  p.pos += p.vel;
  p.pos = clamp(p.pos, vec2f(0.002), vec2f(0.998));

  // === DEPOSIT INK ===
  // Only deposit when nearly stopped AND well inside target (not just edge).
  // targetHere threshold + slowness gating prevents edge-first outlines.
  if (targetHere > 0.3) {
    let slowness = 1.0 - clamp(speed * 500.0, 0.0, 1.0); // need speed < 0.002
    let settled = slowness * slowness * slowness; // cubed — extremely strict
    // Deeper into target = more deposit (prevents edge-only buildup)
    let depthBonus = clamp((targetHere - 0.3) * 2.0, 0.0, 1.0);
    let amount = u32(settled * depthBonus * 20.0 * pres);
    if (amount > 0u) {
      let cx = u32(clamp(p.pos.x * f32(GRID), 0.0, f32(GRID - 1u)));
      let cy = u32(clamp(p.pos.y * f32(GRID), 0.0, f32(GRID - 1u)));
      atomicAdd(&deposits[cy * GRID + cx], amount);
    }
  }

  // Age
  p.life -= 1.0;

  particles[idx] = p;
}
