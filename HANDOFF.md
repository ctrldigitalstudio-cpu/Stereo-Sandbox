# Handoff: continue locally

The cloud session stopped here. `main` is the last verified state (playable, tested). This branch
(`handoff/local`) adds unfinished work on top of it.

## Unfinished: TAA with temporal upscaling
- Implemented in `src/render/taa.js` + changes in `renderer.js`, `post.js`, `common.js`, `terrain.js`,
  `overlays.js`, `config.js` (`aa: taa|fxaa|off`). Maths verified correct.
- Still to fix (details in `docs/plans/taa-maths-result.json`):
  1. TAAU mip/footprint bias: scale texture gradients, pixelArtUV footprint, star/sun AA width and the
     selection outline by renderWidth/outputWidth when TAA is on.
  2. Clouds and the void plane in sky pixels are reprojected as infinitely far; use the cloud march's
     mean distance for reprojection.
- Then: visual check (moving camera, ghosting), `npm test`, `npm run build`, commit to main.

## Queue (plans in docs/plans/)
1. Weather (rain/snow/thunder, wet surfaces, puddles): `weather-workflow.mjs`
2. POM + GTAO, on by default only in High/Ultra: `pom-gtao-brief.md`
3. Far LOD terrain beyond 1000 blocks: `lod-workflow.mjs`
4. Slabs, stairs, fences, doors, lanterns: `shapes-workflow.mjs`
Coloured lighting was dropped. A Unity port is under consideration (decide before building 1-4 in JS).

The .mjs files are Claude Code workflow scripts (2 verifiers each); their prompts double as specs.
