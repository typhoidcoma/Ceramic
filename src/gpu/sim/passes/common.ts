import { WORKGROUP_SIZE } from "../constants";

export type DispatchContext = {
  pass: GPUComputePassEncoder;
  bindGroup: GPUBindGroup;
  width: number;
  height: number;
};

export function dispatch2d(ctx: DispatchContext, pipeline: GPUComputePipeline): void {
  ctx.pass.setPipeline(pipeline);
  ctx.pass.setBindGroup(0, ctx.bindGroup);
  ctx.pass.dispatchWorkgroups(Math.ceil(ctx.width / WORKGROUP_SIZE), Math.ceil(ctx.height / WORKGROUP_SIZE));
}
