export type FrameLumaMetrics = {
  frameLumaMeanActual: number;
  frameLumaMaxActual: number;
  brightPixelRatioActual: number;
  frameLumaHistogramActual: number[];
};

function alignTo(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple;
}

export class LumaReadback {
  private device: GPUDevice;
  private readBuffer: GPUBuffer | null = null;
  private width = 0;
  private height = 0;
  private bytesPerRow = 0;
  private inFlight = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  private ensure(width: number, height: number): void {
    const nextBytesPerRow = alignTo(width * 4, 256);
    if (this.readBuffer && this.width === width && this.height === height && this.bytesPerRow === nextBytesPerRow) return;
    this.readBuffer?.destroy();
    this.width = width;
    this.height = height;
    this.bytesPerRow = nextBytesPerRow;
    this.readBuffer = this.device.createBuffer({
      label: "frame-luma-readback",
      size: this.bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  enqueueCopy(encoder: GPUCommandEncoder, texture: GPUTexture, width: number, height: number): boolean {
    if (this.inFlight) return false;
    this.ensure(width, height);
    if (!this.readBuffer) return false;
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: this.readBuffer, bytesPerRow: this.bytesPerRow, rowsPerImage: this.height },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );
    return true;
  }

  async readMetrics(): Promise<FrameLumaMetrics | null> {
    if (!this.readBuffer || this.inFlight) return null;
    this.inFlight = true;
    try {
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const mapped = this.readBuffer.getMappedRange();
      const bytes = new Uint8Array(mapped);

      let sum = 0;
      let max = 0;
      let bright = 0;
      let count = 0;
      const hist = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.height; y += 1) {
        const rowOffset = y * this.bytesPerRow;
        for (let x = 0; x < this.width; x += 1) {
          const idx = rowOffset + x * 4;
          // BGRA8
          const b = bytes[idx] / 255;
          const g = bytes[idx + 1] / 255;
          const r = bytes[idx + 2] / 255;
          const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
          sum += l;
          max = Math.max(max, l);
          if (l > 0.92) bright += 1;
          const bucket = Math.min(hist.length - 1, Math.floor(l * hist.length));
          hist[bucket] += 1;
          count += 1;
        }
      }

      this.readBuffer.unmap();
      if (count === 0) return null;
      return {
        frameLumaMeanActual: sum / count,
        frameLumaMaxActual: max,
        brightPixelRatioActual: bright / count,
        frameLumaHistogramActual: hist.map((v) => v / count),
      };
    } catch {
      try {
        this.readBuffer.unmap();
      } catch {
        // noop
      }
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
