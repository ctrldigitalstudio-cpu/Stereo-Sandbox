# Stereo Sandbox — working notes for Claude

Browser voxel sandbox (Minecraft-style) with a hand-written WebGL2 "shader pack" renderer.
Plain ES modules, zero runtime dependencies, everything procedural. `SPEC.md` is the contract
between modules (vertex format, worker protocol, Frame uniform block, texture units, frame graph)
— read it before changing anything that crosses a module boundary.

## Commands
- `npm install` — dev tools only (esbuild, playwright).
- `npm run serve` → http://localhost:8080/ (dev, unbundled modules; `?test` = fixed seed + light settings,
  `?test&preset=high` = a real preset).
- `npm run build` → `dist/index.html` (single self-contained file, commit it) + `dist/artifact.html`
  (same page without html/head/body wrappers, for claude.ai artifacts).
- `npm test` → `tools/smoke-test.mjs`: boots the game headless, screenshots noon/afternoon/sunset/night/
  water/underwater/torches into `tools/out/` (gitignored), fails on any page error. `--only a,b`,
  `--size WxH`, `--ui`, `--dist`.
- `node tools/tests/gameplay/run-all.mjs` — play-through tests with real keyboard/mouse input.
- Per-module tests: `node tools/tests/mesher/mesher.test.mjs`, `node tools/tests/worldgen/test.mjs`,
  `node tools/tests/player/player.test.mjs`, `node tools/tests/player/input.test.mjs`,
  `node tools/tests/terrain-render/particles.test.mjs`, UI harness `tools/tests/ui/`.
- `node tools/run-page.mjs <page> --until <expr> --shot tools/out/x.png` — open any page headless and
  capture console output + a screenshot.
- `node tools/preview-map.mjs` — top-down PNG of the generated world (tune worldgen by eye).

Headless tests use SwiftShader (software GL), so frames take seconds; judge looks from screenshots,
never performance. On a Mac with a real GPU, set `PW_GPU=1` to let Chromium use the GPU.

## Where things live
- `src/main.js` game loop + state machine (title / playing / paused), `window.__game` test hooks.
- `src/world.js` main-thread chunk streaming ↔ `src/worker.js` (generation, lighting, meshing via
  `src/worldgen.js`, `src/mesher.js`).
- `src/renderer.js` frame graph; `src/render/common.js` shared GLSL + Frame UBO (every shader starts
  with `GLSL_COMMON`); `terrain.js` terrain/water/shadow; `atmosphere.js` sky LUT, irradiance, stars,
  noise textures; `post.js` light shafts, clouds, composite, bloom, exposure, tone map, FXAA;
  `overlays.js` selection box, particles, held block.
- `src/textures.js` procedural 16×16 textures (albedo + normal + LabPBR-style specular), `src/blocks.js`
  block registry, `src/config.js` settings/presets, `src/ui.js` + `style.css` all menus/HUD.

## Rules of thumb
- Block textures: MAG filter is LINEAR on purpose; sample them through `pixelArtUV(uv, clamp)` +
  `textureGrad` (see common.js) — NEAREST magnification is ignored by D3D11/ANGLE once anisotropy is on.
- Camera-relative rendering: never put absolute world coordinates in float uniforms/vertices.
- Keep the Low preset genuinely cheap; the default High must stay 60 fps on mid-range GPUs.
- Everything that touches storage is wrapped in try/catch (sandboxed iframes throw).
- No new runtime dependencies; no network requests besides Google Fonts.
- After gameplay or rendering changes: `npm test` (and the gameplay suite), then `npm run build` and
  commit `dist/index.html`.

## Links
- Repo: https://github.com/ctrldigitalstudio-cpu/Stereo-Sandbox
- Playable build (claude.ai artifact, private): https://claude.ai/artifact/1LTeG9XgN89C47jJvAgRwf —
  update it by republishing `dist/artifact.html` to that URL.
- Upgrade ideas: `ROADMAP.md`.
