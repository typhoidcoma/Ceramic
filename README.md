# Ceramic Datamosh Lab

Ceramic is a WebGPU datamosh and glitch playground with a true reorderable effect stack, advanced per-layer controls, and media-backed preview.

## Features

- Reorderable effect layer stack with per-layer:
  - amount
  - blend
  - bypass/enable
  - solo
  - duplicate
  - reset/remove
- Datamosh core pass chain (Data-Mosh, Feedback, Soft/Hard Glitch, Pixel Sort, Decimate)
- Style/composition stack layers (distortion, retro, stylization, procedural, image, masking, utility)
- Background source model:
  - solid color
  - image
  - looping video
- Solid underlay color and opacity composited under masked/transparent output
- Presets, randomize, and self-test controls

## Run

```bash
npm install
npm run dev
```

Type-check:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

## Notes

- Requires a WebGPU-capable browser.
- Video files are loaded locally, played muted, and looped.
- Neutral-zero behavior is enforced: amount sliders at `0` are intended to be visually neutral.

## Reference Attribution

This implementation is inspired by publicly available shader and effect references:

- [Mosh-Pro effect taxonomy and stacking model](https://moshpro.app/?ref=uiuxshowcase.com)
- [KinoDatamosh](https://github.com/keijiro/KinoDatamosh)
- [KinoGlitch](https://github.com/keijiro/KinoGlitch)
- [GODPUS datamosh GLSL](https://github.com/GODPUS/shaders/blob/master/datamosh/glsl/datamosh.glsl)
