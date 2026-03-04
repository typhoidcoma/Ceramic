# Reference Dataset Cache

This folder stores locally cached Arrival benchmark references from Wolfram's `ScriptLogoJpegs`.

## Import

From repo root:

```bash
npm run benchmark:import:wolfram
```

The importer:
- downloads `.jpg` files from `WolframResearch/Arrival-Movie-Live-Coding/ScriptLogoJpegs`
- writes images into `data/reference/arrival-script-logo-jpegs/`
- computes morphology stats
- writes `data/reference/manifest.json`

## Runtime Usage

- Server route `GET /api/benchmark/references` serves `manifest.json`.
- If `manifest.json` is missing, benchmark runs in disabled mode (no crash).

## Refresh

Run `npm run benchmark:import:wolfram` again to refresh the cache and regenerate the manifest.
