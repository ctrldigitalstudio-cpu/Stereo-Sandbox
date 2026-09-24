# Blockvale — technical spec

A Minecraft-style voxel sandbox in the browser. Plain ES modules + WebGL2, no runtime
dependencies. The goal is gameplay that feels like creative-mode Minecraft, rendered with
"shader pack" quality: shadow mapping with soft shadows, physically based sky, volumetric
clouds and light shafts, reflective/refractive water, HDR bloom, auto exposure, filmic tone
mapping. Everything (textures included) is procedurally generated — no external assets.

This document is the contract between modules. **If you own a module, implement exactly the
exports described here** — other modules are being written in parallel against this spec.
Where the spec is silent, choose what makes the game look and play best.

Visual target: the game should look like Minecraft with a high-end shader pack (BSL /
Complementary / SEUS style): warm golden-hour light, long soft shadows, god rays through
leaves, glossy water that reflects the sky and terrain, blue atmospheric depth on distant
mountains, glowing torches with bloom.

## Conventions

- World axes: +X east, +Y up, +Z south. Right-handed. Block `(x, y, z)` occupies `[x, x+1) × [y, y+1) × [z, z+1)`.
- Chunks are 16 × 128 × 16 (`CHUNK`, `HEIGHT` in `src/blocks.js`). Chunk `(cx, cz)` covers x ∈ [16cx, 16cx+16).
- Block index inside a chunk: `idx = x | (z << 4) | (y << 8)` (x, z local 0..15, y 0..127).
- Column index: `col = x | (z << 4)`.
- Sea level `SEA = 56`. y = 0 is bedrock.
- Chunk key string: `` `${cx},${cz}` ``.
- Camera: `yaw = 0` looks toward −Z; positive yaw turns LEFT (toward −X), so mouse-right *decreases* yaw.
  `pitch > 0` looks up. Forward = `forwardFromYawPitch(yaw, pitch)` in `src/math.js`.
- Rendering is camera-relative: the view matrix is rotation only; every mesh is drawn with
  `uChunkOffset = chunkOrigin − cameraPos` (computed in JS doubles) to keep float precision.
- All GL matrices are column-major (gl-matrix style, see `src/math.js`).

## Directory layout and ownership

```
index.html              UI markup + <script type=module src=src/main.js>      (UI agent)
style.css               all styling                                           (UI agent)
src/
  noise.js              DONE  seeded PRNG, hash2/hash3, Simplex (noise2, noise3, fbm2, ridged2)
  blocks.js             DONE  block registry + flat lookup tables
  math.js               DONE  mat4, vec3, frustum helpers
  gl.js                 DONE  Program, texture/FBO helpers, UNIT table
  vertex.js             DONE  packed vertex format, FACES table, index buffer, VAO attribs
  config.js             DONE  settings defaults/presets/schema/persistence
  render/common.js      DONE  GLSL header, Frame UBO, shared GLSL, shadow matrix
  textures.js           Textures agent
  worldgen.js           Worldgen agent   (+ tools/preview-map.mjs)
  mesher.js             Mesher agent
  worker.js             Mesher agent
  render/terrain.js     Terrain-render agent (terrain, shadow, water programs + chunk GPU meshes)
  render/overlays.js    Terrain-render agent (selection box, particles draw, held block)
  particles.js          Terrain-render agent (CPU particle simulation)
  render/atmosphere.js  Sky/post agent (sky LUT, irradiance, sky pass, noise textures)
  render/post.js        Sky/post agent (volumetrics, clouds composite, bloom, exposure, tonemap, FXAA)
  renderer.js           Sky/post agent (frame graph orchestration)
  player.js             Player agent
  input.js              Player agent
  audio.js              Player agent
  ui.js                 UI agent
  world.js              Game agent
  main.js               Game agent
build.mjs               Game agent (esbuild single-file build)
tools/smoke-test.mjs    Game agent (headless Chromium test + screenshots)
package.json            Game agent
```

Read the DONE files before writing code — they are the contract.

## Blocks (`src/blocks.js`, done)

`BLOCKS[id]` has: `name, label, shape (SHAPE_NONE|CUBE|CROSS|TORCH|FLUID), tex (string or {top,bottom,side}),
opaque, solid, cutout, cullSame, lightOpacity, emit, tint (TINT_*), wave, sound, replaceable, placeable, unbreakable`.
`B.STONE` etc. give ids. Flat `Uint8Array(256)` tables: `OPAQUE, SOLID, SHAPE, LIGHT_OPACITY, EMIT, CULL_SAME, TINT, WAVE, REPLACEABLE`.
`faceTextures(def)` → 6 texture names in face order (+X, −X, +Y, −Y, +Z, −Z).
`INVENTORY` (ids for the creative inventory), `DEFAULT_HOTBAR` (9 ids).

## Textures (`src/textures.js`)

```js
export function buildTextures(): TextureSet
export function makeBlockIcon(tex: TextureSet, blockId: number, size = 64): HTMLCanvasElement
```
`TextureSet`:
```js
{
  size: 16, layers: N, levels: 5,              // mip levels 16, 8, 4, 2, 1
  albedo: Uint8Array[],   // per mip level; RGBA8, sRGB-encoded; level data = layers × s × s × 4, layer-major
  normal: Uint8Array[],   // per mip level; RGBA8 tangent-space normal * 0.5 + 0.5 (+x = +u right, +y = +v DOWN the image, +z out)
  spec: Uint8Array[],     // per mip level; RGBA8: r = smoothness, g = metalness, b = emissive, a = tint mask
  layerOf: { [textureName]: layer },
  faceLayers: Uint16Array(NUM_BLOCKS * 6),     // layer for each block face, face order +X,-X,+Y,-Y,+Z,-Z
  cutout: Uint8Array(layers),                   // 1 if the layer uses alpha testing
}
```
- Pure JS (no DOM) so it can also run in a worker/node; `makeBlockIcon` is main-thread only (canvas).
- Every texture name referenced by `faceTextures()` of any block must exist, plus `water`, `lava`.
- Minecraft-like 16×16 pixel art, original designs (never copy Mojang textures). Each texture also
  gets a height field → normal map (Sobel, wrap-around), per-pixel smoothness/metalness/emissive
  (LabPBR-like) and a tint mask (1 where the biome tint applies: grass top, grass-side fringe,
  leaves, tall grass, fern).
- Tinted textures store greyscale (≈ 0.55–0.9 luminance) in tinted pixels; the shader multiplies by the
  vertex tint where the mask is set.
- Mips: average in linear space then re-encode sRGB; for cutout layers keep alpha coverage (scale alpha
  so the fraction of texels with a ≥ 0.5 matches level 0). Normals: average then renormalise.
- Emissive pixels: glowstone, torch flame, lava, sea lantern, redstone ore specks (faint).
- Icons: isometric 3-face cube (top brightest, left/right shaded) drawn from level-0 albedo (with tint
  applied using a default green for grass/leaves), flat sprite for cross/torch blocks. Pixelated, crisp.

## World generation (`src/worldgen.js`)

```js
export const BIOMES: { id, name }[]
export class WorldGen {
  constructor(seed: number)
  heightAt(x, z): number               // pure; y of the top terrain block (before caves/trees)
  climateAt(x, z): { temperature, humidity }   // 0..1
  biomeAt(x, z): number                // BIOMES id
  generateChunk(cx, cz): { blocks: Uint8Array(16*16*128), colors: Uint8Array(256 * 9) }
  findSpawn(): { x, y, z }             // feet position on dry land near the origin
}
```
- `colors`: per column (col * 9): grass RGB, foliage RGB, water RGB. Continuous functions of climate so
  neighbouring columns blend smoothly.
- Generation must be a pure function of (seed, cx, cz) — chunks may be generated in any order and
  trees/features crossing chunk borders must come out identical on both sides.
- Features: continents/oceans, beaches, rivers, rolling plains, forests (oak/birch), birch forest,
  taiga (spruce), snowy tundra (snowy grass, frozen water → ice), desert (sand/sandstone, cactus,
  dead bush), large mountains with stone cliffs and snow caps; caves (spaghetti tunnels + caverns),
  lava below y = 10 in caves, ores (coal, iron, gold, diamond, redstone), tall grass/ferns/flowers,
  gravel/clay/sand ocean floors. Bedrock at y = 0 plus scattered y 1–3.
- Performance target: ≤ 5 ms per chunk in V8.
- `tools/preview-map.mjs`: renders a top-down colour PNG of the terrain (biome colours, height
  shading, water) so the generator can be tuned by eye (write a tiny PNG encoder with `zlib`).

## Meshing + lighting (`src/mesher.js`) and the world worker (`src/worker.js`)

```js
// neighbors: 9 entries, index (dz + 1) * 3 + (dx + 1); each { blocks, colors } (all 9 required)
export function meshChunk(neighbors, faceLayers: Uint16Array): {
  opaque: Uint32Array, water: Uint32Array,      // packed vertices (4 words each, 4 vertices per quad)
  opaqueQuads: number, waterQuads: number,
  minY: number, maxY: number,                   // geometry spans y in [minY, maxY) (maxY exclusive, blocks)
}
```
Lighting (Minecraft rules, computed over the 46 × 46 region = chunk ± 15 blocks, across all 9 chunks):
- Sky light: 15 straight down through blocks with `LIGHT_OPACITY` 0; each block subtracts its opacity;
  opaque stops it. Then BFS flood: neighbour gets `L − 1 − opacity(neighbour)`.
- Block light: BFS from `EMIT[id]` sources with the same rule.
- Only cells whose light can still change need BFS seeds; keep it fast (reuse typed arrays).

Geometry (see `src/vertex.js` for packing, `FACES` for corner layout):
- Cubes: emit a face when the neighbour is not opaque and not (same id with `CULL_SAME`). Faces at y = −1
  are hidden; faces above y = 127 are visible.
- Smooth lighting + AO per vertex: in the plane of the face-adjacent cell P, sample P, P+s1, P+s2, P+s1+s2
  (s1, s2 toward the corner). AO = both sides opaque ? 0 : 3 − (side1 + side2 + corner). Light = average
  of the non-opaque samples (skip the corner if both sides are opaque), scaled to 0..255.
- Flip the quad diagonal (emit corners rotated by one) when that puts the diagonal through the brighter
  pair (AO first, light as tie-break) — removes AO anisotropy.
- Cross plants (`SHAPE_CROSS`): two diagonal planes from (2/16, 2/16) to (14/16, 14/16), both windings
  (4 quads), a deterministic ±3/16 xz jitter per position, light = the plant cell's own light, `ao`
  = 1 for bottom vertices and 3 for top, flags `FLAG_PLANT` (+ `FLAG_WAVE_PLANT` on top vertices).
  Normal index 2 (+Y).
- Torch (`SHAPE_TORCH`): box x,z ∈ [7/16, 9/16], y ∈ [0, 10/16]; side u 7..9, v 6..16; top u 7..9 v 6..8;
  bottom u 7..9 v 14..16. `FLAG_PLANT`. Own-cell light.
- Water (`SHAPE_FLUID`, id `B.WATER`) goes to the `water` buffer: surface height 14/16 unless water
  above (then 1); faces toward non-water, non-opaque neighbours; top face when the block above is not
  water. Tint = column water colour. Lava (`B.LAVA`) goes to the opaque buffer the same way (its own
  texture, emissive).
- `FLAG_UNDERWATER` on cube faces whose face-adjacent cell is water. `FLAG_WAVE_LEAVES` on every vertex of
  blocks with `WAVE[id] === 1`.
- Tint by `TINT[id]`: GRASS/FOLIAGE/WATER from the column colours; BIRCH = (128,167,85), SPRUCE = (97,153,97); else white.
- Performance target: ≤ 8 ms per chunk (lighting + meshing) for typical terrain.

Worker protocol (`src/worker.js`, a module worker; also bundled into a blob for the single-file build):

Main → worker
- `{ type: 'init', seed, faceLayers: Uint16Array, edits: [[key, [[idx, id], ...]], ...] }`
- `{ type: 'want', keys: [[cx, cz], ...] }` — chunks main wants meshed, highest priority first. Replaces the pending queue. The worker generates any missing neighbours itself.
- `{ type: 'unload', keys: [[cx, cz], ...] }` — main dropped these; forget that main has their mesh. The worker may free unedited chunk data far from all wanted chunks.
- `{ type: 'set', x, y, z, id }` — block edit. Worker applies it (and records it so regeneration keeps it), then re-meshes, before any queued work: the chunk containing the block first, then every loaded neighbour chunk that main currently holds (light can travel 15 blocks).

Worker → main
- `{ type: 'ready' }` after init.
- `{ type: 'mesh', cx, cz, blocks: Uint8Array (copy), opaque, water, opaqueQuads, waterQuads, minY, maxY }` — typed arrays transferred.

The worker processes one chunk per task and yields (e.g. `setTimeout(0)` / `MessageChannel`) between
tasks so edits and new `want` lists are handled promptly.

## Main-thread world (`src/world.js`)

```js
export class World {
  constructor({ seed, faceLayers, edits /* Map key -> Map(idx -> id) */, onMesh(cx, cz, msg), onUnload(cx, cz) })
  ready: Promise<void>
  getBlock(x, y, z): number          // 0 for y ≥ 128, B.BEDROCK for y < 0, -1 if the chunk isn't loaded
  isSolid(x, y, z): boolean          // true for unloaded chunks (so the player can't fall through)
  setBlock(x, y, z, id): void        // updates local data, records the edit, posts 'set'
  update(camX, camZ, renderDistance): void   // stream chunks around the camera
  loadedFraction(radius): number     // 0..1 of chunks within `radius` that have meshes (loading screen)
  exportEdits(): string / static importEdits(str): Map
  terminate()
}
```
World creates the worker (module worker in dev; `new Worker(URL.createObjectURL(new Blob([window.__WORKER_SRC__])))`
when `window.__WORKER_SRC__` is defined by the single-file build).

## Rendering

### Shared contract (`src/render/common.js`, done)
- Every program's source = `GLSL_COMMON` + its own code. `GLSL_COMMON` declares the `Frame` uniform block
  (binding 0) and the standard samplers; `Program` (src/gl.js) binds samplers to `UNIT` automatically.
- Standard texture units (bound by the renderer once per frame, before any module draws):
  `0 uAlbedo, 1 uNormals, 2 uSpecular (sampler2DArray)`, `3 uShadowCmp (sampler2DShadow)`, `4 uShadowRaw`,
  `5 uSkyLUT`, `6 uIrradiance`, `7 uNoise2D`, `8 uNoise3D (sampler3D)`. Pass-specific inputs use units 10–15.
  When shadows are off the renderer still binds a 1×1 depth texture (cleared to 1) on units 3/4.
- Shared GLSL helpers: `ign/ignFrame, linearDepth, positionFromDepth, shadowDistort, shadowCoord,
  shadowTexelWorld, skyLutUV/skyLutDir/sampleSky, skyIrradiance, groundIrradiance, lightColor,
  sunDiskRadiance, ambientLight(n), henyeyGreenstein, cloudCoverage, cloudShadow, applyFog`.
- `GLSL_BLOCK_VERTEX`: attribute declarations + decoders for packed chunk vertices, `FACE_N/T/B` tables.
- `FrameUniforms` (JS writer for the UBO), `computeShadowMatrix(camPos, lightDir, radius)`.

HDR units: `lightColor()` ≈ 3 for noon sun, `skyIrradiance()` ≈ 0.6–1.0 at noon, torch light ≈ 2–3
at the source. Albedo is linear (sRGB texture decode). Lambert without the 1/π (radiance = albedo × E).
Auto exposure then maps the scene to display; aim for mid-grey ≈ 0.18 after exposure.

### Terrain renderer (`src/render/terrain.js`)
```js
export class TerrainRenderer {
  constructor(gl, textureSet)                 // creates programs, shared quad index buffer
  upload(cx, cz, msg)                         // create/replace GPU buffers for a chunk ('mesh' message)
  remove(cx, cz)
  drawShadow(view)   // into the bound shadow FBO; view = { camPos, shadowCenter, shadowRadius, time }
  drawOpaque(view)   // view = { camPos, frustum: Float32Array(24) camera-relative planes, time }
  drawWater(view)    // same view; scene colour copy on unit 10, scene depth copy on unit 11
  stats: { chunks, drawCalls, quads }
}
```
Programs:
- **terrain** (opaque + cutout + lava): decode vertex; leaves/plant waving (wind, `uCamPos.w` time); alpha test;
  normal map (TBN = FACE_T/FACE_B/FACE_N; none for `FLAG_PLANT`); biome tint via spec.a mask; lighting:
  sun/moon `lightColor()` × N·L × shadow × cloudShadow, shadow = PCSS (blocker search on `uShadowRaw`,
  12-tap rotated Vogel-disk PCF on `uShadowCmp`, penumbra from blocker distance × `uShadow.w`) or plain
  PCF when `uQuality.w == 0`; normal-offset bias scaled by `shadowTexelWorld`; beyond the shadow radius
  fall back to sky light; direct light × smoothstep on sky light so caves stay dark. Ambient =
  `ambientLight(N)` × skyLight² × AO. Block light: warm (1.0, 0.62, 0.32) with inverse-square-like falloff,
  subtle flicker. GGX sun specular + sky reflection for smooth/metal materials, emissive × 4.
  Foliage/plant translucency (light from behind). Caustics + wavelength-dependent sun absorption on
  `FLAG_UNDERWATER` faces below sea level. Lava: scroll/distort its UVs over time, strongly emissive.
  Finish with `applyFog`. Output HDR `vec4(color, 1)`.
- **shadow**: same decode + identical waving; `gl_Position = uShadowMat * pos` with `xy = shadowDistort(xy)`;
  alpha test cutout layers; no face culling.
- **water**: refraction (offset by wave normal, reject samples in front of the water using the depth copy),
  Beer–Lambert absorption by water thickness (tinted with the vertex water colour), in-scatter, screen-space
  reflections (march `uQuality.x` steps in camera-relative space against the depth copy + binary refinement,
  fade at screen edges) falling back to `sampleSky` + a cheap `cloudCoverage` reflection, Fresnel (Schlick,
  F0 0.02), sharp sun glint (GGX, shadowed), underside (camera below) shows total internal reflection
  outside Snell's window. Waves from `uNoise2D` scrolled in 2–3 directions. Culling off. `applyFog` at the end.
- Culling: frustum-cull chunks (AABB from minY/maxY); sort opaque chunks front-to-back; shadow pass only
  chunks within the shadow radius of `shadowCenter`.

### Overlays (`src/render/overlays.js`) and particles (`src/particles.js`)
```js
export class ParticleSystem {
  constructor(textureSet)
  spawnBlockBreak(x, y, z, blockId)           // ~40 small cubes/billboards with bits of the block texture
  spawnSplash(x, y, z)                        // optional
  update(dt, world)                            // gravity, drag, collide with world.isSolid
  count
}
export class Overlays {
  constructor(gl, textureSet)
  drawSelection(view, block /* {x,y,z} or null */)          // thin dark outline around the targeted block
  drawParticles(view, particles)                             // lit, alpha-tested, in the opaque scene pass
  drawHeld(view, held /* { blockId, swing 0..1, equip 0..1, bobX, bobY, light: [sky, block] } */)
}
```
`drawHeld` renders the selected block in the lower right like Minecraft's first-person item (cube for cube
blocks, flat sprite for plants/torch), with its own projection, into the HDR target after compositing.

### Sky + post (`src/render/atmosphere.js`, `src/render/post.js`) and the frame graph (`src/renderer.js`)
```js
export class Renderer {
  constructor(canvas, textureSet, settings)    // throws Error('WebGL2 not supported') if unavailable
  terrain: TerrainRenderer
  overlays: Overlays
  applySettings(settings)                      // resize targets / rebuild shadow map as needed
  resize()                                     // canvas CSS size × devicePixelRatio (≤ 1.5) × renderScale
  render(frame)
  stats: { fps-independent: drawCalls, chunks, quads, gpuMs? }
}
```
`frame` = `{ camPos:[x,y,z], yaw, pitch, fov (radians, vertical), time (s), dt, timeOfDay (0..1),
sunDir, moonDir, underwater (bool), eyeSkyLight (0..1), selection, particles, held, cloudCoverage }`.

Time of day: 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight. Sun direction
`a = timeOfDay·2π`, `sunDir = normalize(cos a, sin a·cos φ, sin a·sin φ)` with φ = 25° tilt toward +Z;
`moonDir = −sunDir`. Shadows follow the sun while it is above −3°, otherwise the moon.

Frame graph (render size = canvas size × renderScale):
1. `atmosphere.update(frame)`: sky-view LUT `SKY_LUT_W × SKY_LUT_H` RGBA16F (single-scattering Rayleigh + Mie +
   ozone, 16 view steps × 8 light steps, sun plus a faint moon-lit sky, parametrised by `skyLutDir`),
   irradiance 4×1 RGBA16F (texel meanings in common.js: integrate the LUT over the hemisphere for sky
   irradiance; ground bounce ≈ albedo 0.25 × (sun + sky); light colour = transmittance to the sun × intensity,
   or moonlight (0.25, 0.32, 0.45)×0.12 at night; sun disk radiance). Night sky must stay deep blue, not black.
2. Shadow pass (if enabled) into a `shadowRes²` DEPTH_COMPONENT24 texture: `terrain.drawShadow`.
3. Scene FBO (RGBA16F colour + DEPTH_COMPONENT24 texture): `terrain.drawOpaque`, `overlays.drawParticles`,
   then `atmosphere.drawSky` (full-screen on the far plane, depth LEQUAL, no depth write): LUT colour,
   sun disk with limb darkening, moon disk with phases shading, twinkling stars rotating with `uWind.z`.
4. Blit scene colour + depth into copies (units 10, 11) → `terrain.drawWater` into the scene FBO → `overlays.drawSelection`.
5. `post.volumetrics`: half-res ray march from the camera to the scene depth (`uQuality.y` steps, IGN
   dither), sampling the shadow map (single tap) × cloud shadow × height-fog density × HG phase (g ≈ 0.6
   blended with isotropic); stronger, blue-green scattering when underwater.
6. `post.composite` → HDR target: scene + depth-aware upsampled volumetrics; volumetric clouds between
   `CLOUD_BOTTOM`/`CLOUD_TOP` (density = `cloudCoverage(xz)` × height profile − `uNoise3D` erosion,
   `uQuality.z` steps + 2 light steps, Beer–powder, dual-lobe HG, ambient from `skyIrradiance`, fading
   into `sampleSky` haze with distance, occluded by scene depth); underwater fog/absorption when
   `uEnv.x == 1`. Then `overlays.drawHeld` into the same target (own depth renderbuffer, cleared).
7. Bloom: 6-level 13-tap downsample / tent upsample chain.
8. Auto exposure: average log luminance of the smallest bloom level → 1×1 target blended over time
   (ping-pong), clamped so night is still readable and caves still get dark.
9. Tone map: exposure, bloom mix (~4–6%), ACES filmic, slight saturation/contrast grade, vignette,
   sRGB encode, ±0.5/255 dither, luma → alpha.
10. FXAA to the canvas (or straight copy when FXAA is off), upscaling from render size to canvas size.

Noise textures (created by `atmosphere.js`): `uNoise2D` 256² RGBA8 REPEAT/LINEAR/mipmapped — r, g, b =
tileable fbm (value/perlin) with base periods of 4, 8, 16 cells over the texture, contrast-stretched to use
the full 0..1 range; a = tileable inverted Worley (8 cells). `uNoise3D` 64³ R8 REPEAT/LINEAR — tileable
Perlin-Worley detail noise for cloud erosion.

## Player, input, audio

```js
export class Input {
  constructor(element)               // listens on element/window; tracks keys by KeyboardEvent.code
  isDown(code): boolean
  pressed(code): boolean             // went down since the last endFrame()
  mouseDelta(): [dx, dy]             // accumulated since last endFrame()
  buttonPressed(i): boolean          // 0 left, 1 middle, 2 right, since last endFrame()
  buttonDown(i): boolean
  wheel(): number                    // accumulated wheel steps since last endFrame()
  endFrame()
  requestLock(): Promise<boolean>    // pointer lock; on failure enables drag-to-look fallback
  locked: boolean; dragLook: boolean
  onLockChange: (locked) => void
}
export class Player {
  constructor(world, input, sound)
  pos: [x, y, z] (feet), vel, yaw, pitch, flying, onGround, inWater, eyeInWater, sprinting, sneaking
  eye(): [x, y, z]
  update(dt, settings, allowInput)   // movement + collision + interaction (break/place/pick) + hotbar keys
  target: { x, y, z, nx, ny, nz, id } | null   // raycast result (DDA, reach 6)
  hotbar: number[9], selected: number
  onBreak(x, y, z, id), onPlace(x, y, z, id), onStep(id), onSplash() — callbacks set by main
  bob(): { x, y }                    // view-bob offsets for camera + held item
  fovScale(): number                 // sprint FOV kick
  swing: number (0..1), equip: number (0..1)
}
export class Sound {
  constructor()
  resume()                           // call from a user gesture
  setVolume(v), enabled
  play(kind: 'break'|'place'|'step'|'splash'|'click', material: blocks' `sound` field, pos?: [x,y,z])
  ambient(time, underwater, eyeSkyLight)   // optional subtle wind/water ambience
}
```
Movement: walk 4.3 m/s, sprint 5.6 (double-tap W or hold R; never Ctrl — Ctrl+W closes the tab),
sneak 1.3 (Shift), gravity 32 m/s², jump 9 m/s, AABB 0.6 × 1.8 × 0.6, eye height 1.62 (1.27 sneaking),
per-axis sweep collision against `world.isSolid`, auto-jump off. Double-tap Space or F toggles flying
(10.9 m/s, sprint 21; Space up, Shift down). Water: slow sink, Space swims up, drag. Left click breaks
(repeat every 0.25 s while held; bedrock unbreakable), right click places onto the targeted face (not
inside the player unless the block is non-solid; replaces `REPLACEABLE` blocks), middle click picks the block
into the current slot. Breaking a block next to water (sides/above) fills it with water. Keys 1–9 and the
wheel select hotbar slots.
Sound: all synthesized with WebAudio (filtered noise bursts + short tones), different per material.

## UI (`index.html`, `style.css`, `src/ui.js`)

```js
export class UI {
  constructor({ textures, settings, onSettingsChange(settings), onPlay(), onResume(), onNewWorld(), onQuit() })
  setLoading(fraction, text)                 // title screen loading bar; Play enabled when ≥ 1
  showTitle() / hideTitle()
  showPause() / hidePause()
  toggleInventory(open?) / inventoryOpen: boolean
  setHotbar(ids[9], selected)
  update(info)          // per frame: { fps, pos, biome, chunks, time, flying, underwater, target, debug: bool }
  toast(text)
  menuOpen: boolean     // any overlay that should block gameplay input
}
```
- Title screen over the live, slowly drifting 3D world: game name "Blockvale", subtitle
  "A voxel sandbox", Play button (disabled with progress while loading), Settings, controls cheat-sheet,
  a note on phones that keyboard + mouse are needed.
- Pause menu (Esc / pointer lock lost): Resume, Settings, New world, Controls.
- Settings panel generated from `SETTINGS_SCHEMA` (config.js) with live apply.
- Hotbar (9 slots, icons from `makeBlockIcon`, selected slot highlight, block name toast on change),
  crosshair, creative inventory (E) grid of `INVENTORY` blocks — click to assign to the selected slot,
  F3 debug overlay, F1 hides HUD, underwater vignette tint.
- Visual language: frosted dark glass panels, warm off-white text, amber (#F2B45A-ish) accent from
  golden-hour sunlight; pixel display face (Google Font "Silkscreen" or "Pixelify Sans") for headings and
  a clean readable body face with system fallbacks. Must work offline (fonts optional).
  Everything scales down to phone width without horizontal scrolling.

## Game loop (`src/main.js`)
- Boot: settings → `buildTextures()` → Renderer → World (seed from saved game or random) → UI.
- Title: cinematic camera slowly orbiting above spawn while chunks stream in; Play → pointer lock → play.
- Each frame: input → player.update → world.update → time of day → particles.update → renderer.render →
  ui.update → input.endFrame.
- Adaptive resolution when enabled: keep ~60 fps by nudging renderScale between 0.5 and the setting.
- Save (localStorage, try/catch): seed, edits, player position/orientation, time of day, hotbar — every
  10 s and on `pagehide`. New world clears it.
- `window.__game = { player, world, renderer, settings, setTime(t), teleport(x, y, z, yaw, pitch), play() }`.
  URL `?test` → fixed seed 12345, skip saved game, hooks exposed immediately (for headless tests).

## Build (`build.mjs`)
`node build.mjs` → `dist/index.html`: a single self-contained file. Bundle `src/worker.js` (IIFE) and inline it
as `window.__WORKER_SRC__` (escape `</script`), bundle `src/main.js` (ESM, inline module script), inline
`style.css`. Also emit `dist/artifact.html`: the same content without `<!doctype>`, `<html>`, `<head>`,
`<body>` tags (title + style + markup + scripts only).
