export type SimulationResources = {
  simWidth: number;
  simHeight: number;
  cellCount: number;
  densityRead: GPUBuffer;
  densityWrite: GPUBuffer;
  velocityRead: GPUBuffer;
  velocityWrite: GPUBuffer;
  pressureRead: GPUBuffer;
  pressureWrite: GPUBuffer;
  divergence: GPUBuffer;
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
    densityRead: createStorageBuffer(device, "density-read", scalarSize),
    densityWrite: createStorageBuffer(device, "density-write", scalarSize),
    velocityRead: createStorageBuffer(device, "velocity-read", vec2Size),
    velocityWrite: createStorageBuffer(device, "velocity-write", vec2Size),
    pressureRead: createStorageBuffer(device, "pressure-read", scalarSize),
    pressureWrite: createStorageBuffer(device, "pressure-write", scalarSize),
    divergence: createStorageBuffer(device, "divergence", scalarSize),
  };
}

export function copyBuffer(encoder: GPUCommandEncoder, from: GPUBuffer, to: GPUBuffer, size: number): void {
  encoder.copyBufferToBuffer(from, 0, to, 0, size);
}
