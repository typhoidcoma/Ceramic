import computeShaderCode from "./sim/shaders.wgsl?raw";
import renderShaderCode from "./sim/shaders.render.wgsl?raw";

export type PipelineBundle = {
  computeBindGroupLayout: GPUBindGroupLayout;
  renderBindGroupLayout: GPUBindGroupLayout;
  injection: GPUComputePipeline;
  velocity: GPUComputePipeline;
  advection: GPUComputePipeline;
  divergence: GPUComputePipeline;
  pressure: GPUComputePipeline;
  projection: GPUComputePipeline;
  damp: GPUComputePipeline;
  render: GPURenderPipeline;
};

export function createPipelineBundle(device: GPUDevice, format: GPUTextureFormat): PipelineBundle {
  const computeModule = device.createShaderModule({ code: computeShaderCode });
  const renderModule = device.createShaderModule({ code: renderShaderCode });

  const computeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ],
  });

  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ],
  });

  const computeLayout = device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] });
  const renderLayout = device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout] });

  const makeCompute = (entryPoint: string) =>
    device.createComputePipeline({
      layout: computeLayout,
      compute: { module: computeModule, entryPoint },
    });

  const render = device.createRenderPipeline({
    layout: renderLayout,
    vertex: { module: renderModule, entryPoint: "vs_fullscreen" },
    fragment: {
      module: renderModule,
      entryPoint: "fs_volume",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
  });

  return {
    computeBindGroupLayout,
    renderBindGroupLayout,
    injection: makeCompute("inject_main"),
    velocity: makeCompute("velocity_main"),
    advection: makeCompute("advect_main"),
    divergence: makeCompute("divergence_main"),
    pressure: makeCompute("pressure_main"),
    projection: makeCompute("projection_main"),
    damp: makeCompute("damp_main"),
    render,
  };
}
