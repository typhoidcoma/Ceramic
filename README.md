# Ceramic Datamosh Lab

A browser-based WebGPU shader playground for datamosh and glitch visuals.

## What It Does

- Realtime multi-pass datamosh/glitch rendering
- Image background input
- Video background input with looping playback
- Large effect control surface (glitch, distortion, analog, stylization, masking, utility)
- Built-in slider self-test mode to sweep all controls

## Tech Stack

- Vite
- React + TypeScript
- Raw WebGPU + WGSL

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start dev server:

```bash
npm run dev
```

3. Type-check:

```bash
npm run typecheck
```

4. Build production bundle:

```bash
npm run build
```

## Usage

1. Open the app and click `Load Image` or `Load Video`.
2. Use the grouped sliders to shape the effect stack.
3. Use presets for quick looks.
4. Use `Start Self-Test` to auto-sweep controls and verify every effect path.
5. Click `Clear Media` to reset the source.

## Notes

- WebGPU-capable browser required.
- Video playback is muted and looped by default for shader preview workflows.
- `0` on sliders is intended to be neutral where applicable.
