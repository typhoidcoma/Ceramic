import { type LogogramGrammar } from "./grammar";
import { seeded, fbm2, valueNoise2 } from "../utils/noise";

const SIZE = 2048;
const SECTOR_COUNT = 12;
const PI = Math.PI;
const TAU = PI * 2;

export function rasterizeLogogram(grammar: LogogramGrammar): ImageData {
  const rnd = seeded(grammar.seed);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const R = grammar.ringRadius * SIZE;
  const seed = grammar.seed;

  // Gap helper
  const gapAngles: number[] = [];
  for (const gap of grammar.gaps) {
    gapAngles.push(-PI + (gap.startSector + 0.5) * (TAU / SECTOR_COUNT));
  }
  function isInGap(angle: number): boolean {
    for (const ga of gapAngles) {
      const diff = Math.abs(((angle - ga + PI * 3) % TAU) - PI);
      if (diff < 0.25) return true;
    }
    return false;
  }

  // Sector thickness interpolation
  function sectorWidth(angle: number): number {
    const norm = ((angle + PI) / TAU) * SECTOR_COUNT;
    const i0 = Math.floor(norm) % SECTOR_COUNT;
    const i1 = (i0 + 1) % SECTOR_COUNT;
    const frac = norm - Math.floor(norm);
    const t0 = grammar.sectors[i0]?.thickness ?? 0.5;
    const t1 = grammar.sectors[i1]?.thickness ?? 0.5;
    const t = frac * frac * (3 - 2 * frac);
    return t0 + (t1 - t0) * t;
  }

  // ============================================================
  // STEP A: Render 4 component layers
  // ============================================================

  // A1: Ring Base — complex sub-network matching SD graph:
  //   Circle shape → noise-modulated thickness → edge roughening → multiple passes
  const ringLayer = renderLayer((ctx) => {
    const STEPS = 720;
    const baseW = R * 0.05;

    // Multiple overlapping ring passes with noise variation (like SD's noise + blend nodes)
    for (let pass = 0; pass < 3; pass++) {
      const rJitter = (rnd() - 0.5) * R * 0.005;
      const wMult = 0.85 + rnd() * 0.3;
      const noiseSeed = seed ^ (0xa1a900 + pass);

      ctx.fillStyle = "#000";
      ctx.beginPath();
      // Outer contour with noise modulation
      for (let i = 0; i <= STEPS; i++) {
        const angle = -PI + (i / STEPS) * TAU;
        if (isInGap(angle)) continue;
        const sw = sectorWidth(angle);
        const w = baseW * (0.5 + sw * 0.8) * wMult;
        // Edge noise for organic quality
        const edgeNoise = fbm2(noiseSeed, angle * 8.0, pass * 3.7, 3, 2.0, 0.5) * R * 0.008;
        const r = R + rJitter + w / 2 + edgeNoise;
        const px = cx + Math.cos(angle) * r;
        const py = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      // Inner contour
      for (let i = STEPS; i >= 0; i--) {
        const angle = -PI + (i / STEPS) * TAU;
        if (isInGap(angle)) continue;
        const sw = sectorWidth(angle);
        const w = baseW * (0.5 + sw * 0.8) * wMult;
        const edgeNoise = fbm2(noiseSeed ^ 0xff, angle * 8.0, pass * 2.3, 3, 2.0, 0.5) * R * 0.008;
        const r = R + rJitter - w / 2 + edgeNoise;
        const px = cx + Math.cos(angle) * r;
        const py = cy + Math.sin(angle) * r;
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  });

  // A2: Large Blob Gen — noise-modulated blob shapes (not clean arcs)
  const blobLayer = renderLayer((ctx) => {
    ctx.fillStyle = "#000";
    for (let bi = 0; bi < grammar.blobs.length; bi++) {
      const blob = grammar.blobs[bi];
      const sz = blob.size ?? 0.5;

      // Generate blob as a noise-modulated radial shape (like SD's shape + noise blend)
      const BSTEPS = 180;
      const count = 3 + Math.floor(sz * 4);
      for (let pass = 0; pass < count; pass++) {
        const rJitter = (rnd() - 0.5) * R * 0.01;
        const sMult = 0.8 + rnd() * 0.4;
        ctx.beginPath();
        for (let i = 0; i <= BSTEPS; i++) {
          const t = i / BSTEPS;
          const angle = blob.theta + (t - 0.5) * blob.arcSpan * sMult;

          // Radial extent: thick at center, tapers at edges — smoothstep profile
          const edgeDist = Math.abs(t - 0.5) * 2; // 0 at center, 1 at edges
          const profile = 1.0 - edgeDist * edgeDist;
          const thickness = R * (0.04 + sz * 0.12) * profile;

          // Noise modulation on the radial extent
          const nv = fbm2(seed ^ (0xb10b00 + bi * 7 + pass), angle * 12.0, pass * 2.1, 3, 2.0, 0.5);
          const noiseR = nv * R * 0.02 * sz;

          const rBias = blob.radialBias * R * 0.05;
          const rOuter = R + rBias + rJitter + thickness + noiseR;
          const rInner = R + rBias + rJitter - thickness * 0.6 + noiseR;

          const px = cx + Math.cos(angle) * rOuter;
          const py = cy + Math.sin(angle) * rOuter;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        // Return along inner edge
        for (let i = BSTEPS; i >= 0; i--) {
          const t = i / BSTEPS;
          const angle = blob.theta + (t - 0.5) * blob.arcSpan * sMult;
          const edgeDist = Math.abs(t - 0.5) * 2;
          const profile = 1.0 - edgeDist * edgeDist;
          const thickness = R * (0.04 + sz * 0.12) * profile;
          const nv = fbm2(seed ^ (0xb10b80 + bi * 7 + pass), angle * 12.0, pass * 1.7, 3, 2.0, 0.5);
          const noiseR = nv * R * 0.02 * sz;
          const rBias = blob.radialBias * R * 0.05;
          const rInner = R + rBias + rJitter - thickness * 0.6 + noiseR;
          const px = cx + Math.cos(angle) * rInner;
          const py = cy + Math.sin(angle) * rInner;
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  });

  // A3: Small Curls — small noise-modulated shapes on ring exterior
  const curlLayer = renderLayer((ctx) => {
    ctx.fillStyle = "#000";
    for (let ci = 0; ci < grammar.smallCurls.length; ci++) {
      const curl = grammar.smallCurls[ci];
      const CSTEPS = 60;
      const passes = 2 + Math.floor(curl.size * 3);
      for (let pass = 0; pass < passes; pass++) {
        const sMult = 0.7 + rnd() * 0.6;
        const span = (0.06 + curl.size * 0.10) * sMult;
        ctx.beginPath();
        for (let i = 0; i <= CSTEPS; i++) {
          const t = i / CSTEPS;
          const angle = curl.theta + (t - 0.5) * span;
          const edgeDist = Math.abs(t - 0.5) * 2;
          const profile = 1.0 - edgeDist * edgeDist;
          const thickness = R * (0.02 + curl.size * 0.05) * profile;
          const nv = fbm2(seed ^ (0xc0210 + ci * 5 + pass), angle * 16.0, pass * 3.1, 2, 2.0, 0.5);
          // Exterior bias
          const rOuter = R + R * 0.02 + thickness + nv * R * 0.01;
          const px = cx + Math.cos(angle) * rOuter;
          const py = cy + Math.sin(angle) * rOuter;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        for (let i = CSTEPS; i >= 0; i--) {
          const t = i / CSTEPS;
          const angle = curl.theta + (t - 0.5) * span;
          const edgeDist = Math.abs(t - 0.5) * 2;
          const profile = 1.0 - edgeDist * edgeDist;
          const thickness = R * (0.02 + curl.size * 0.05) * profile;
          const nv = fbm2(seed ^ (0xc0280 + ci * 5 + pass), angle * 16.0, pass * 2.5, 2, 2.0, 0.5);
          const rInner = R + R * 0.01 - thickness * 0.3 + nv * R * 0.01;
          const px = cx + Math.cos(angle) * rInner;
          const py = cy + Math.sin(angle) * rInner;
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  });

  // A4: Tendrils — tapered strokes extending outward
  const tendrilLayer = renderLayer((ctx) => {
    ctx.strokeStyle = "#000";
    ctx.lineCap = "round";
    for (const tendril of grammar.tendrils) {
      for (let t = 0; t < tendril.rayCount; t++) {
        const startAngle = tendril.theta + (rnd() - 0.5) * 1.2;
        if (isInGap(startAngle)) continue;
        const startR = R + R * 0.04 + rnd() * R * 0.02;
        const sx = cx + Math.cos(startAngle) * startR;
        const sy = cy + Math.sin(startAngle) * startR;

        const outAngle = startAngle + (rnd() - 0.5) * 0.5;
        const rayLen = R * tendril.lengthFactor * (0.7 + rnd() * 0.6);
        const baseWidth = R * (0.008 + rnd() * 0.014);

        let px = sx, py = sy;
        let angle = outAngle;
        const segs = 2 + Math.floor(rnd() * 2);
        for (let s = 0; s < segs; s++) {
          const frac = s / segs;
          const taper = 1.0 - frac;
          const w = baseWidth * taper * taper;
          if (w < 0.5) break;
          angle += (rnd() - 0.5) * 0.3;
          const segLen = (rayLen / segs) * (0.8 + rnd() * 0.4);
          const nx = px + Math.cos(angle) * segLen;
          const ny = py + Math.sin(angle) * segLen;
          ctx.lineWidth = Math.max(1, w);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(nx, ny);
          ctx.stroke();
          px = nx;
          py = ny;
        }
      }
    }
  });

  // ============================================================
  // STEP B: Warp each layer — matching SD graph connections
  //
  //   Large Blob Gen → Dot Warp → Fluid Morph Blobs
  //   Small Curls → Fluid Morph Small Curls
  //   Tendrils → Fluid Morph Tendrils
  //   Ring Base (already has internal noise)
  // ============================================================

  // Ring Base: light fluid morph for organic wobble
  const warpedRing = fluidMorph(ringLayer, SIZE, SIZE, seed ^ 0xa1b2c3d4, 18, 0.003);

  // Large Blobs: Dot Warp first (gradient displacement), then Fluid Morph (curl swirl)
  const blobDotWarped = dotWarp(blobLayer, SIZE, SIZE, seed ^ 0x1f2e3d4c, 25, 0.005);
  const warpedBlobs = fluidMorph(blobDotWarped, SIZE, SIZE, seed ^ 0xd4c3b2a1, 35, 0.004);

  // Small Curls: Fluid Morph only (strong, for curvy shapes)
  const warpedCurls = fluidMorph(curlLayer, SIZE, SIZE, seed ^ 0x5a6b7c8d, 45, 0.005);

  // Tendrils: Fluid Morph only (medium, wispy)
  const warpedTendrils = fluidMorph(tendrilLayer, SIZE, SIZE, seed ^ 0x8d7c6b5a, 28, 0.003);

  // ============================================================
  // STEP C: Composite — Ring → Add Large Blobs → Add Tendrils → Add Curls
  // ============================================================
  const N = SIZE * SIZE;
  const composite = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = warpedRing[i];
    v = Math.max(v, warpedBlobs[i]);    // Add Large Blobs
    v = Math.max(v, warpedTendrils[i]); // Add Tendrils
    v = Math.max(v, warpedCurls[i]);    // Add Curls
    composite[i] = v;
  }

  // ============================================================
  // STEP D: Dot Warp (final coherence) — matches SD "Dot Warp" after compositing
  // ============================================================
  const finalWarped = dotWarp(composite, SIZE, SIZE, seed ^ 0xe5f6a7b8, 16, 0.002);

  // ============================================================
  // STEP E: Ink Blot Filter — blur + histogram scan (binarize)
  // ============================================================
  const mono = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    mono[i] = Math.min(255, Math.max(0, Math.round(finalWarped[i] * 255)));
  }

  let blurred = separableBoxBlur(mono, SIZE, SIZE, 3);
  blurred = separableBoxBlur(blurred, SIZE, SIZE, 2);

  const threshold = 100;
  const imageData = new ImageData(SIZE, SIZE);
  const pixels = imageData.data;
  for (let i = 0; i < N; i++) {
    const v = blurred[i] > threshold ? 0 : 255;
    pixels[i * 4] = v;
    pixels[i * 4 + 1] = v;
    pixels[i * 4 + 2] = v;
    pixels[i * 4 + 3] = 255;
  }

  return imageData;
}

// ============================================================
// Render a component layer to a Float32Array via OffscreenCanvas
// ============================================================
function renderLayer(draw: (ctx: OffscreenCanvasRenderingContext2D) => void): Float32Array {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  draw(ctx);
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    out[i] = 1.0 - data[i * 4] / 255;
  }
  return out;
}

// ============================================================
// Fluid Morph: curl-based displacement (divergence-free swirling flow)
// SD "Fluid Morph" — computes curl of a scalar noise field to get
// a rotation-only vector field, creating ink-swirl distortion.
// curl(f) = (df/dy, -df/dx)
// ============================================================
function fluidMorph(
  src: Float32Array, w: number, h: number,
  seed: number, strength: number, scale: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const eps = 1.0; // finite difference epsilon in pixels
  const epsS = eps * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x * scale;
      const ny = y * scale;
      // Scalar noise field
      const nRight = fbm2(seed, nx + epsS, ny, 4, 2.0, 0.5);
      const nLeft  = fbm2(seed, nx - epsS, ny, 4, 2.0, 0.5);
      const nUp    = fbm2(seed, nx, ny - epsS, 4, 2.0, 0.5);
      const nDown  = fbm2(seed, nx, ny + epsS, 4, 2.0, 0.5);
      // Curl: (df/dy, -df/dx) — creates rotational flow
      const dfdx = (nRight - nLeft) / (2 * epsS);
      const dfdy = (nDown - nUp) / (2 * epsS);
      const dx = dfdy * strength;   // curl x = df/dy
      const dy = -dfdx * strength;  // curl y = -df/dx
      out[y * w + x] = bilinearSample(src, w, h, x - dx, y - dy);
    }
  }
  return out;
}

// ============================================================
// Dot Warp: gradient-based displacement (expanding/contracting)
// SD "Dot Warp" — uses gradient of a noise height field to push
// pixels outward from bright areas and inward toward dark areas.
// Displacement direction = gradient of noise = (df/dx, df/dy)
// ============================================================
function dotWarp(
  src: Float32Array, w: number, h: number,
  seed: number, strength: number, scale: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const eps = 1.0;
  const epsS = eps * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x * scale;
      const ny = y * scale;
      const nRight = fbm2(seed, nx + epsS, ny, 3, 2.0, 0.5);
      const nLeft  = fbm2(seed, nx - epsS, ny, 3, 2.0, 0.5);
      const nUp    = fbm2(seed, nx, ny - epsS, 3, 2.0, 0.5);
      const nDown  = fbm2(seed, nx, ny + epsS, 3, 2.0, 0.5);
      // Gradient: (df/dx, df/dy) — pushes along slope
      const dx = (nRight - nLeft) / (2 * epsS) * strength;
      const dy = (nDown - nUp) / (2 * epsS) * strength;
      out[y * w + x] = bilinearSample(src, w, h, x - dx, y - dy);
    }
  }
  return out;
}

// ============================================================
// Bilinear sampling with boundary clamping
// ============================================================
function bilinearSample(src: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;

  const s00 = safeRead(src, w, h, x0, y0);
  const s10 = safeRead(src, w, h, x1, y0);
  const s01 = safeRead(src, w, h, x0, y1);
  const s11 = safeRead(src, w, h, x1, y1);

  return (
    s00 * (1 - fx) * (1 - fy) +
    s10 * fx * (1 - fy) +
    s01 * (1 - fx) * fy +
    s11 * fx * fy
  );
}

function safeRead(src: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || x >= w || y < 0 || y >= h) return 0;
  return src[y * w + x];
}

// ============================================================
// Separable box blur
// ============================================================
function separableBoxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) sum += src[y * w + xx];
      tmp[y * w + x] = Math.round(sum / (x1 - x0 + 1));
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) sum += tmp[yy * w + x];
      out[y * w + x] = Math.round(sum / (y1 - y0 + 1));
    }
  }
  return out;
}
