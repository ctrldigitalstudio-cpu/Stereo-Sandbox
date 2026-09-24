# Stereo Sandbox

A voxel world to build in, right in the browser: a Minecraft-style sandbox rendered with a
hand-written WebGL2 pipeline that aims for "shader pack" quality. No game engine, no runtime
dependencies, no downloaded assets: every texture, sound, and chunk of terrain is generated
in code.

## Play

- **Single file:** open `dist/index.html` in a desktop browser (Chrome, Edge, Firefox, Safari 15+).
  It works from disk, from any static host, and embedded in a sandboxed iframe (without pointer
  lock you look around by dragging with the mouse; without storage it simply doesn't save).
- **From source:** `npm run serve`, then open <http://localhost:8080/>.

A keyboard and mouse are needed.

| Action | Keys |
| --- | --- |
| Move | W A S D |
| Jump / swim up | Space |
| Fly | Double-tap Space, or F |
| Fly down / sneak | Shift |
| Sprint | Double-tap W, or hold R |
| Break / place / pick block | Left / right / middle click |
| Select block | 1–9 or mouse wheel |
| Creative inventory | E |
| Hide HUD / debug info | F1 / F3 |
| Pause and settings | Esc |

Your world, edits, position, hotbar and time of day save automatically in the browser
(localStorage, every 10 s, when you pause and when you leave the page); saves from before the
rename to Stereo Sandbox carry over. "New world" in the pause menu starts over with a fresh seed.

## Graphics

- Sun and moon shadow mapping with a distorted shadow map (sharp near the player) and
  percentage-closer soft shadows (contact-hardening penumbrae).
- Physically based sky: Rayleigh + Mie + ozone single scattering, sun disk with limb
  darkening, moon phases, twinkling stars, twilight colours.
- Volumetric clouds (ray-marched, self-shadowed, drifting with the wind) that cast shadows.
- Volumetric light shafts through trees, clouds and caves, and underwater god rays.
- Water with screen-space reflections, refraction, depth-based absorption, Fresnel,
  sun glints, Snell's window from below, and caustics on the sea floor.
- Per-pixel lighting with generated normal and specular maps (LabPBR-style), GGX
  specular on smooth and metallic blocks, subsurface light through leaves.
- Minecraft-style smooth lighting and ambient occlusion, flood-filled sky and block light,
  flickering warm torchlight, emissive glowstone and lava.
- Waving leaves and grass, biome-tinted foliage and water.
- HDR pipeline: bloom, automatic exposure (eyes adapt between caves and daylight), ACES
  filmic tone mapping, colour grading, FXAA.
- Adaptive resolution and Low/Medium/High/Ultra presets.

## World

Continents and oceans, beaches, rivers, plains, forests, birch forests, taiga, snowy tundra,
deserts and snow-capped mountains; caves with lava lakes; coal, iron, gold, redstone and
diamond ores; oak, birch, spruce and large oak trees; flowers, ferns, grass and cacti.
Terrain streams in around the player from a Web Worker that generates, lights and meshes
chunks.

## Build

```sh
npm install
npm run build     # -> dist/index.html (single self-contained file) + dist/artifact.html
npm test          # headless Chromium smoke test, screenshots in tools/out/
node tools/tests/gameplay/run-all.mjs   # play-through tests with real input (see below)
```

`tools/tests/gameplay/` drives the real game with Playwright keyboard and mouse events: the
whole journey from the title screen through movement, building, the inventory and every setting,
saving and loading, edits across chunk borders, the title camera, sandboxed iframes, the
single-file build (HTTP, `file://`, artifact), missing WebGL2, tiny and resized windows, and a
race-condition fuzz test of the world worker protocol (`world-sync.test.mjs`, plain node).

## Layout

```
index.html, style.css     page shell and UI styles
src/main.js               bootstrap and game loop
src/world.js              chunk streaming on the main thread
src/worker.js             world worker: generation, lighting, meshing
src/worldgen.js           terrain, biomes, caves, trees
src/mesher.js             light propagation and mesh building
src/textures.js           procedural block textures (albedo, normal, specular)
src/renderer.js           frame graph
src/render/               terrain, water, sky, clouds, post-processing, overlays
src/player.js, input.js   movement, physics, interaction, controls
src/audio.js              synthesized sound effects
src/ui.js                 menus, HUD, inventory, settings
SPEC.md                   module contracts
```

Not affiliated with Mojang or Microsoft. Minecraft is a trademark of Mojang Synergies AB.
