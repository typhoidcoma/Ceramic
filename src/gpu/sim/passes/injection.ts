import type { DispatchContext } from "./common";
import { dispatch2d } from "./common";

export function runInjectionPass(ctx: DispatchContext, pipeline: GPUComputePipeline): void {
  dispatch2d(ctx, pipeline);
}
