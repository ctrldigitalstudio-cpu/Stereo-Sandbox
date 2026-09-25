# POM + GTAO for Stereo Sandbox

Project: "Stereo Sandbox", a Minecraft-style voxel sandbox with shader-pack graphics in plain ES
modules + WebGL2 (no dependencies). Repo: /home/user/minecraft-browser (local git repo). Read
CLAUDE.md and SPEC.md first, then src/render/common.js, src/render/terrain.js, src/renderer.js,
src/render/post.js, src/render/taa.js, src/config.js and src/textures.js (the normal map's alpha
channel is a 0..255 height field per texel).

## Task
Add two graphics options, on by default only in the High and Ultra presets (off in Low and
Medium), each toggleable in Settings:

1. **Parallax occlusion mapping** (`pom: true|false`, label "Parallax occlusion mapping").
   - In the terrain fragment shader, ray-march the height field (normal-map alpha) in tangent
     space (FACE_T/FACE_B/FACE_N) for cube faces only: skip FLAG_PLANT, leaves (cutout layers),
     glass, water, lava, emissive layers if they look wrong.
   - Keep the pixel-art look: march in texel steps so the relief is made of crisp stepped
     "pixel voxels" (like voxel-POM in shader packs), not smooth bumps. Depth around 1/16–2/16 of
     a block; per-texture strength can come from the height range.
   - Stay inside the 16x16 tile (no bleeding into neighbours at face edges); fade out with
     distance (~16–28 blocks) and at grazing angles; step count scales with angle (e.g. 8–24).
   - Use the same pixelArtUV/textureGrad path with the ORIGINAL gradients, so mips/anisotropy and
     TAA (with its TAAU mip bias if present) keep working.
   - Optional self-shadowing inside the relief from the sun/moon direction (a short march toward
     the light), multiplied into direct light only.
   - The shadow pass and silhouettes stay flat (no depth writes offset needed; if you add
     gl_FragDepth changes, measure the cost and justify it).
2. **GTAO** (`gtao: true|false`, label "Ambient occlusion (GTAO)").
   - A half-resolution ground-truth ambient occlusion pass after the opaque scene, from the scene
     depth (reconstruct normals from depth, or add a cheap normal output if needed), a few
     directions per pixel rotated per frame (ignFrame) so TAA accumulates it, a bilateral
     depth-aware blur/upsample.
   - Apply it to AMBIENT light only (sky/ambient and block-light bounce), not to direct sunlight:
     e.g. have the terrain shader output the ambient share of each pixel (a spare channel or an
     MRT target) so the composite can scale just that part; or apply it in the composite with a
     sound approximation. Keep the scene-colour alpha semantics (alpha = 1 - self-emission).
   - Radius in world units (~1–1.5 blocks), strength tuned to complement (not double) the
     per-vertex voxel AO: contact shadows under plants, torches, overhangs, trees meeting the ground.
   - Skip sky pixels and the held block; zero cost when off.
3. **Settings plumbing**: src/config.js DEFAULT_SETTINGS + QUALITY_PRESETS (low/medium false,
   high/ultra true) + SETTINGS_SCHEMA (Graphics group). Old saved settings without these keys get
   the preset's value. Renderer.applySettings reads them; the Frame UBO/uQuality or program
   defines carry them to shaders (prefer uniform branches or #defines so "off" costs nothing).

## Rules
- Do not break TAA, weather (if present), FXAA/Off paths, the RGBA8 fallback, or the Low preset's
  cost. No GL errors. Keep code style (ES modules, 2-space indent, concise comments that explain why).
- Budget: this machine renders in software (SwiftShader) on 4 shared cores and the session has a
  usage limit: run captures one at a time at 640x360, keep the number of runs modest.
- Do not run git commands that change state.

## Verify
Captures (on vs off, tools/tests/visual/shoot.mjs / live.mjs or your own under tools/tests/pom-gtao/):
close-up of stone bricks / cobblestone / planks / ores at a grazing angle (POM depth, stepped
pixel look, no tile bleeding, no swimming while the camera moves), a forest floor and a cave
corner (GTAO contact shadows, no halos around trees against the sky, no noise after TAA), a torch
scene at night. Then `node tools/run-page.mjs tools/tests/common-compile.html --until window.__done`
and `node tools/smoke-test.mjs --size 800x450 --out tools/out/pom-gtao-smoke --only afternoon,torches`.

Final message: ## Files changed, ## Design, ## Evidence (image paths, on/off pairs), ## Cost
(passes/fetches added, off = zero?), ## Remaining issues.
