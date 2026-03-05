import { type LogogramGrammar } from "./grammar";
import { seeded, fbm2, clamp01 } from "../utils/noise";

const SIZE = 1024;
const SECTOR_COUNT = 12;
const SECTOR_ARC = (Math.PI * 2) / SECTOR_COUNT;

export function rasterizeLogogram(grammar: LogogramGrammar): ImageData {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d")!;
  const rnd = seeded(grammar.seed);

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const rPx = grammar.ringRadius * SIZE; // ring radius in pixels
  const baseW = grammar.ringBaseWidth * SIZE; // base stroke width in pixels

  // Clear to white
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Draw in black
  ctx.fillStyle = "#000000";
  ctx.strokeStyle = "#000000";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // === 1. RING — thick arc segments with varying width ===
  const RING_SEGMENTS = 72; // 5 degrees each
  const segArc = (Math.PI * 2) / RING_SEGMENTS;

  for (let i = 0; i < RING_SEGMENTS; i++) {
    const theta = -Math.PI + i * segArc;
    const thetaMid = theta + segArc * 0.5;

    // Which sector does this segment belong to?
    const sectorIdx = Math.floor(((theta + Math.PI) / (Math.PI * 2)) * SECTOR_COUNT) % SECTOR_COUNT;
    const sector = grammar.sectors[sectorIdx];
    if (!sector.active) continue;

    // Check if this segment falls in a gap
    let inGap = false;
    for (const gap of grammar.gaps) {
      const gapStart = gap.startSector;
      const gapEnd = (gapStart + gap.span) % SECTOR_COUNT;
      if (gap.span === 1 && sectorIdx === gapStart) inGap = true;
      if (gap.span > 1) {
        for (let g = 0; g < gap.span; g++) {
          if ((gapStart + g) % SECTOR_COUNT === sectorIdx) inGap = true;
        }
      }
    }
    if (inGap) continue;

    // Noise-modulated radius and width
    const noiseR = fbm2(grammar.seed ^ 0x7f4a7c15, thetaMid * 1.8, i * 0.3, 3, 2.0, 0.52);
    const noiseW = fbm2(grammar.seed ^ 0x5bd1e995, thetaMid * 2.4, i * 0.5, 2, 1.95, 0.56);
    const localRadius = rPx + noiseR * rPx * 0.035;
    const localWidth = baseW * sector.thickness * (0.7 + 0.3 * (noiseW * 0.5 + 0.5));

    ctx.lineWidth = Math.max(2, localWidth);
    ctx.beginPath();
    ctx.arc(cx, cy, localRadius, theta, theta + segArc + 0.02); // slight overlap
    ctx.stroke();
  }

  // === 2. BLOBS — overlapping filled circles ===
  for (const blob of grammar.blobs) {
    const blobCx = cx + Math.cos(blob.theta) * rPx;
    const blobCy = cy + Math.sin(blob.theta) * rPx;

    for (let d = 0; d < blob.discCount; d++) {
      const angle = rnd() * Math.PI * 2;
      const drift = baseW * (0.3 + rnd() * 1.2);
      const dx = blobCx + Math.cos(angle) * drift * (0.5 + blob.radialBias);
      const dy = blobCy + Math.sin(angle) * drift * (0.5 + blob.radialBias);
      const r = baseW * (0.8 + rnd() * 1.6);

      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Extra thick ring connection at blob location
    ctx.lineWidth = baseW * 2.2;
    ctx.beginPath();
    ctx.arc(cx, cy, rPx, blob.theta - blob.arcSpan * 0.5, blob.theta + blob.arcSpan * 0.5);
    ctx.stroke();
  }

  // === 3. TENDRILS — short tapered ink splatter rays ===
  for (const tendril of grammar.tendrils) {
    const anchorX = cx + Math.cos(tendril.theta) * rPx;
    const anchorY = cy + Math.sin(tendril.theta) * rPx;
    const outDirX = Math.cos(tendril.theta);
    const outDirY = Math.sin(tendril.theta);

    for (let r = 0; r < tendril.rayCount; r++) {
      const spreadAngle = (rnd() - 0.5) * 1.2;
      const rayDirX = outDirX * Math.cos(spreadAngle) - outDirY * Math.sin(spreadAngle);
      const rayDirY = outDirX * Math.sin(spreadAngle) + outDirY * Math.cos(spreadAngle);
      const rayLen = rPx * tendril.lengthFactor * (0.5 + rnd() * 0.5);
      const rayBaseWidth = baseW * (0.6 + rnd() * 0.8);

      // Draw as 4-5 segments with decreasing width
      const segments = 4 + Math.floor(rnd() * 2);
      let px = anchorX;
      let py = anchorY;

      for (let s = 0; s < segments; s++) {
        const u0 = s / segments;
        const u1 = (s + 1) / segments;
        const taper = 1 - u1 * u1; // quadratic taper to zero
        const w = rayBaseWidth * taper;
        if (w < 0.5) break;

        const curl = (rnd() - 0.5) * 0.3;
        const cdx = rayDirX * Math.cos(curl) - rayDirY * Math.sin(curl);
        const cdy = rayDirX * Math.sin(curl) + rayDirY * Math.cos(curl);

        const nx = px + cdx * rayLen * (u1 - u0);
        const ny = py + cdy * rayLen * (u1 - u0);

        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(nx, ny);
        ctx.stroke();

        px = nx;
        py = ny;
      }

      // Branch with 30% probability
      if (rnd() < 0.3) {
        const branchAngle = (rnd() - 0.5) * 0.8;
        const bDirX = rayDirX * Math.cos(branchAngle) - rayDirY * Math.sin(branchAngle);
        const bDirY = rayDirX * Math.sin(branchAngle) + rayDirY * Math.cos(branchAngle);
        const bLen = rayLen * 0.35;
        const bStartX = anchorX + rayDirX * rayLen * 0.35;
        const bStartY = anchorY + rayDirY * rayLen * 0.35;

        let bx = bStartX;
        let by = bStartY;
        for (let bs = 0; bs < 3; bs++) {
          const bt = (bs + 1) / 3;
          const bw = rayBaseWidth * 0.5 * (1 - bt);
          if (bw < 0.5) break;
          const bnx = bx + bDirX * bLen * (1 / 3);
          const bny = by + bDirY * bLen * (1 / 3);
          ctx.lineWidth = bw;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bnx, bny);
          ctx.stroke();
          bx = bnx;
          by = bny;
        }
      }
    }
  }

  // === 4. POST-PROCESSING: threshold → dilate → blur → binarize → edge erode ===
  const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
  const pixels = imageData.data;

  // Extract to single-channel (0 = ink, 255 = paper from red channel)
  const mono = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    mono[i] = pixels[i * 4] < 200 ? 255 : 0; // threshold: dark = ink (255), light = paper (0)
  }

  // Dilate (2px separable max filter)
  const dilateR = 2;
  const dilated = separableMaxFilter(mono, SIZE, SIZE, dilateR);

  // Box blur (2px separable)
  const blurR = 2;
  const blurred = separableBoxBlur(dilated, SIZE, SIZE, blurR);

  // Binarize with slight softness
  const binary = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    binary[i] = blurred[i] > 80 ? 255 : 0;
  }

  // Edge erosion with FBM noise for frayed ink texture
  const noiseRnd = seeded(grammar.seed ^ 0xbead5678);
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      if (binary[i] === 0) continue;
      // Check if edge pixel (any neighbor is paper)
      const isEdge =
        binary[i - 1] === 0 ||
        binary[i + 1] === 0 ||
        binary[i - SIZE] === 0 ||
        binary[i + SIZE] === 0;
      if (!isEdge) continue;
      // FBM noise-based erosion
      const nx = (x / SIZE) * 14.0;
      const ny = (y / SIZE) * 14.0;
      const noise = fbm2(grammar.seed ^ 0xbead5678, nx, ny, 3, 2.1, 0.55) * 0.5 + 0.5;
      if (noise < 0.42) {
        binary[i] = 0;
      }
    }
  }

  // Write back to RGBA ImageData (ink = black, paper = white)
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = binary[i] > 0 ? 0 : 255; // ink pixels → black, paper → white
    pixels[i * 4] = v;
    pixels[i * 4 + 1] = v;
    pixels[i * 4 + 2] = v;
    pixels[i * 4 + 3] = 255;
  }

  return imageData;
}

function separableMaxFilter(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  // Horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = 0;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) mx = Math.max(mx, src[y * w + xx]);
      tmp[y * w + x] = mx;
    }
  }
  // Vertical
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let mx = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) mx = Math.max(mx, tmp[yy * w + x]);
      out[y * w + x] = mx;
    }
  }
  return out;
}

function separableBoxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const kernel = 2 * r + 1;
  // Horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) sum += src[y * w + xx];
      tmp[y * w + x] = Math.round(sum / (x1 - x0 + 1));
    }
  }
  // Vertical
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) sum += tmp[yy * w + x];
      out[y * w + x] = Math.round(sum / (y1 - y0 + 1));
    }
  }
  return out;
}
