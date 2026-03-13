# Architecture

Ceramic is a client-side WebGPU datamosh viewer/playground built with React + TypeScript.

## Runtime Flow

1. UI builds `BackgroundSource`, `EffectLayer[]`, and `GlobalOptions`.
2. Source pass renders square-fit media (or solid mode) into an RGBA source texture.
3. Datamosh core pipeline applies dedicated glitch passes:
   - warp
   - macroblock
   - temporal feedback
   - RGB damage
4. Reorderable effect stack pipeline runs non-datamosh layers in user-defined order.
5. Final composite pass renders stack output over configured underlay color.

## Core Modules

- `src/app.tsx`
  - stack UI, media loading, layer control, presets, global controls.
- `src/gpu/effectsRegistry.ts`
  - effect definitions, param metadata, public runtime types.
- `src/gpu/playgroundRenderer.ts`
  - frame orchestration and renderer-facing API.
- `src/gpu/glitchPipeline.ts` + `src/gpu/glitch.wgsl`
  - datamosh core pass chain.
- `src/gpu/effectStackPipeline.ts` + `src/gpu/effectStack.wgsl`
  - per-layer style/composition effect execution.
- `src/gpu/playgroundSource.wgsl`
  - source fit/alpha generation.
- `src/gpu/compose.wgsl`
  - underlay compositing.

## Public Renderer Interface

- `setBackgroundSource(background: BackgroundSource)`
- `setGlitchParams(params: Partial<GlitchParams>)`
- `setEffectStack(layers: EffectLayer[])`
- `setGlobalOptions(options: GlobalOptions)`

## Performance Notes

- Fullscreen quad-only render passes.
- Ping-pong textures in stack pipeline.
- Video copied via internal canvas before texture upload for browser compatibility.
