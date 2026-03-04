import type { DispatchContext } from "./common";
import { dispatch2d } from "./common";

export function runAdvectionPass(ctx: DispatchContext, pipeline: GPUComputePipeline): void {
  dispatch2d(ctx, pipeline);
}
