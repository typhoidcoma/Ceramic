export type SimulationResources = {
  simWidth: number;
  simHeight: number;
  cellCount: number;
  carrierRead: GPUBuffer;
  carrierWrite: GPUBuffer;
  pigmentRead: GPUBuffer;
  pigmentWrite: GPUBuffer;
  velocityRead: GPUBuffer;
  velocityWrite: GPUBuffer;
  pressureRead: GPUBuffer;
  pressureWrite: GPUBuffer;
  divergence: GPUBuffer;
  targetDensity: GPUBuffer;
};

function createStorageBuffer(device: GPUDevice, label: string, size: number): GPUBuffer {
  return device.createBuffer({
    label,
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
}

export function createSimulationResources(device: GPUDevice, simWidth: number, simHeight: number): SimulationResources {
  const cellCount = Math.max(1, simWidth * simHeight);
  const scalarSize = cellCount * 4;
  const vec2Size = cellCount * 8;

  return {
    simWidth,
    simHeight,
    cellCount,
    carrierRead: createStorageBuffer(device, "carrier-read", scalarSize),
    carrierWrite: createStorageBuffer(device, "carrier-write", scalarSize),
    pigmentRead: createStorageBuffer(device, "pigment-read", scalarSize),
    pigmentWrite: createStorageBuffer(device, "pigment-write", scalarSize),
    velocityRead: createStorageBuffer(device, "velocity-read", vec2Size),
    velocityWrite: createStorageBuffer(device, "velocity-write", vec2Size),
    pressureRead: createStorageBuffer(device, "pressure-read", scalarSize),
    pressureWrite: createStorageBuffer(device, "pressure-write", scalarSize),
    divergence: createStorageBuffer(device, "divergence", scalarSize),
    targetDensity: createStorageBuffer(device, "target-density", scalarSize),
  };
}

export function copyBuffer(encoder: GPUCommandEncoder, from: GPUBuffer, to: GPUBuffer, size: number): void {
  encoder.copyBufferToBuffer(from, 0, to, 0, size);
}
