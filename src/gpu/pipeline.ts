import shaderCode from "./shaders.wgsl?raw";

export type PipelineBundle = {
  pipeline: GPURenderPipeline;
  globalsBindGroupLayout: GPUBindGroupLayout;
  instancesBindGroupLayout: GPUBindGroupLayout;
};

export function createPipeline(device: GPUDevice, format: GPUTextureFormat): PipelineBundle {
  const module = device.createShaderModule({ code: shaderCode });

  const globalsBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const instancesBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  const layout = device.createPipelineLayout({
    bindGroupLayouts: [globalsBindGroupLayout, instancesBindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module,
      entryPoint: "vs_main",
    },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none",
    },
  });

  return { pipeline, globalsBindGroupLayout, instancesBindGroupLayout };
}
