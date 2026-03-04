export type GpuContext = {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
};

export async function initWebGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new Error("WebGPU not supported in this browser.");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No compatible GPU adapter found.");
  }
  const requestedStorageBuffers = Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage);
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBuffersPerShaderStage: requestedStorageBuffers,
    },
  });
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) {
    throw new Error("Could not acquire WebGPU canvas context.");
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  return { adapter, device, context, format };
}
