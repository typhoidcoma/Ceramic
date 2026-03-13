# Architecture

Ceramic is a client-side WebGPU datamosh viewer built as a React + TypeScript app.

## Runtime Flow

1. Media source is loaded from UI (`image` or `video`).
2. Source pass renders media into a square-fit background texture.
3. Glitch pipeline applies multi-pass datamosh transforms:
   - warp
   - macroblock/decimate
   - temporal feedback
   - RGB/channel damage
4. Style pipeline applies post stylization/masking passes.
5. Final composited frame is presented to the canvas each animation frame.

## Core Modules

- `src/app.tsx`
  - UI controls, presets, media loading, self-test, parameter mapping.
- `src/gpu/playgroundRenderer.ts`
  - WebGPU frame orchestration, source texture updates, render loop.
- `src/gpu/glitchPipeline.ts` + `src/gpu/glitch.wgsl`
  - Datamosh/glitch pass chain and uniforms.
- `src/gpu/stylePipeline.ts` + `src/gpu/style.wgsl`
  - Stylization, masking, and utility effects.
- `src/gpu/playgroundSource.wgsl`
  - Source fit/composition shader.

## Data Model

The app is stateless beyond current UI parameters and loaded media source. There is no backend dependency in the viewer runtime.

## Performance Notes

- Fullscreen quad passes only.
- Persistent textures for feedback and pass chaining.
- Video frames are copied through an internal canvas before GPU upload for browser compatibility.
