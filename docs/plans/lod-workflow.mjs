export const meta = {
  name: 'stereo-sandbox-far-terrain',
  description: 'Add distant LOD terrain visible beyond 1000 blocks to Stereo Sandbox: data/streaming and rendering in parallel, two verifiers, then fixes',
  phases: [
    { title: 'Implement', detail: 'LOD generation + streaming, and LOD rendering, in parallel against one contract' },
    { title: 'Verify', detail: 'visual quality; correctness + performance' },
    { title: 'Fix', detail: 'apply confirmed issues, re-run checks' },
  ],
}

const REPO = '/home/user/minecraft-browser'

const CONTEXT = 'Project: "Stereo Sandbox", a Minecraft-style voxel sandbox with shader-pack graphics in plain ES modules + WebGL2 (no dependencies). Repo: ' + REPO + ' (local git repo). Read CLAUDE.md and SPEC.md first, then the files named in your task. The renderer has TAA with temporal upscaling (src/render/taa.js), dynamic weather (src/weather.js, src/render/weather.js), POM and GTAO options. Chunks load within renderDistance (4-16 chunks); beyond that the sky pass currently paints a flat "void plane" continuation of the world from a 64-sector summary of the outer chunks (see common.js voidColor and the far-terrain summary texels in the irradiance texture).\n\n' +
  'Tools: `node tools/run-page.mjs <page> --until <expr> --shot tools/out/x.png` (headless Chromium, SwiftShader software GL on 4 shared cores: frames take seconds, judge images, never speed); `node tools/smoke-test.mjs --size 800x450 --out tools/out/<dir> --only a,b`; tools/tests/visual/shoot.mjs and live.mjs; window.__game (teleport, setTime, setSettings, setWeather, capture(), gen, world, frame, loaded(r)). Test mode: index.html?test. BUDGET: this machine renders in software and the session has a usage limit: captures one at a time at 640x360, a modest number of runs. Do not run git commands that change state.\n\n' +
  'SHARED CONTRACT:\n' +
  '- New setting `farTerrain`: 0 (off) | 512 | 1024 | 2048 blocks (label "Far terrain", group Graphics). Presets: low 0, medium 512, high 1024, ultra 2048.\n' +
  '- LOD tiles: square tiles of 64x64 blocks in world space, keyed (tx, tz) = floor(x/64), floor(z/64), each at a level L (0: 2-block cells, 1: 4-block cells, 2: 8-block cells, 3: 16-block cells) chosen by distance rings from the player; a tile\'s mesh is a heightfield of cells with vertical skirts toward lower neighbours (so cliffs read as walls), per-cell colour (top block colour by biome/surface: grass tint, sand, snow, stone, water) and a water flag. Terrain height/biome comes from WorldGen pure functions (heightAt, columnInfo, biomeAt) sampled at the cell centre (or max of a few samples so mountains keep their peaks); trees can be approximated by darkening/raising forest cells slightly. Water cells sit at the sea surface (y = SEA - 1 + 14/16).\n' +
  '- Worker protocol: main -> worker `{ type: "lod-want", tiles: [[tx, tz, level], ...] }` (priority order, replaces the LOD queue) and `{ type: "lod-drop", tiles: [[tx, tz], ...] }`; worker -> main `{ type: "lod", tx, tz, level, verts: Float32Array | Uint32Array (implementer\'s packed format, documented in SPEC.md), count, minY, maxY }` transferred. LOD work always yields to chunk work (lower priority).\n' +
  '- Main-thread World gains `updateLod(camX, camZ, farTerrain)` and an `onLod(tx, tz, level, msg)` / `onLodDrop(tx, tz)` pair of callbacks that main.js wires to renderer.lod.upload/remove.\n' +
  '- Renderer: `renderer.lod` (src/render/lod.js) with upload(tx, tz, level, msg), remove(tx, tz), draw(view) called in the opaque scene pass before chunks; LOD fragments inside the loaded chunk area are discarded (a smooth circular cut-out at the loaded radius minus a margin, matched by a crossfade so there is no seam); the camera far plane grows to cover farTerrain when enabled (keep 24-bit depth precision adequate: check near-field z-fighting); fog, aerial perspective and the loaded-area edge fade move out to the LOD distance when LOD is on; the void-plane continuation remains the fallback beyond LOD and when farTerrain is 0.'

const DATA = CONTEXT + '\n\n' +
  'TASK (LOD data + streaming): you own src/lod.js (new: LOD tile generation, used by the worker), src/worker.js, src/world.js, src/main.js (LOD wiring + setting only), src/config.js (farTerrain setting only), src/worldgen.js (only add cheap sampling helpers if needed, never change generation results), SPEC.md (worker protocol + LOD format), tools/tests/lod/. The render engineer owns src/render/*, src/renderer.js at the same time: do not edit those.\n' +
  '1. Generate LOD tiles fast (target < 3 ms for a level-0 tile in V8; measure) with the contract\'s heightfield + skirts + colours; colours must match what the near terrain looks like from afar (grass tint per biome from the same climate colours the mesher uses, snow caps, sand, stone cliffs by slope, water).\n' +
  '2. Streaming: rings around the player out to farTerrain, re-requested when the player moves a tile; never starve chunk loading; drop far tiles; bounded memory; priorities toward the view direction.\n' +
  '3. Tests: determinism, seams between tiles and levels (matching edge heights or skirts that hide cracks), colour mapping sanity, timing, protocol (worker test with the stub generator hook in tools/tests/mesher/).\n' +
  'Final message: ## Files changed, ## Design (format, rings, priorities), ## Tests + timings, ## Notes for the render engineer.'

const RENDER = CONTEXT + '\n\n' +
  'TASK (LOD rendering): you own src/render/lod.js (new), src/render/*.js, src/renderer.js. The data engineer owns src/lod.js, src/worker.js, src/world.js, src/main.js, src/config.js at the same time: do not edit those. Until their side lands, drive your work with LOD meshes you build in your own harness under tools/tests/lod-render/ from WorldGen directly.\n' +
  '1. Draw LOD tiles in the opaque pass (one draw per tile, frustum-culled, front-to-back), shaded consistently with the near terrain from afar: sun/moon light with N·L from the heightfield normal, sky ambient, cloud shadows, no shadow map, simple water with sky reflection + Fresnel (it must meet the near water seamlessly), snow/stone/grass colours, aerial perspective and fog matching applyFog so distant mountains turn hazy blue; weather (rain/overcast) affects them like the near terrain.\n' +
  '2. The loaded-area cut-out and crossfade so there is no visible seam or double geometry at the chunk edge at any renderDistance (4-16); the chunk-edge fog fade no longer hides the world when LOD is on (move fog/edge distances out to farTerrain); the void plane stays the fallback beyond.\n' +
  '3. Far plane and depth: extend the projection far plane when LOD is on; check 24-bit depth precision (no z-fighting on near geometry, no flicker on far LOD); TAA reprojection and the composite (clouds, light shafts) must treat LOD pixels as geometry at their real depth.\n' +
  '4. Keep it cheap: LOD vertex counts and draw calls within budget (report them), zero cost when farTerrain is 0.\n' +
  '5. Captures: a mountain range at 1000+ blocks from a peak at noon and at sunset, an ocean horizon with islands, flying at y 200, the chunk/LOD boundary up close (no seam), renderDistance 6 vs 12 with LOD on, rain over distant land. Compile check + smoke test at the end.\n' +
  'Final message: ## Files changed, ## Design, ## Evidence (image paths), ## Cost, ## Notes for the data engineer.'

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'severity', 'evidence', 'fix'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['findings', 'verdict'],
}

const VERIFIERS = [
  { key: 'visual', prompt: 'Your angle: VISUAL QUALITY (budget: at most 5 capture runs, one at a time, 640x360), judged only from images you capture in the real game with farTerrain 1024 and 2048: distant mountains, coastlines and oceans at noon/sunset/night, from the ground and flying high; the chunk/LOD boundary up close and at several renderDistances (no seam, no double geometry, no popping band); colours matching the near terrain; fog/haze believable; rain/overcast; TAA stability on distant LOD (no shimmer). Compare with farTerrain 0.' },
  { key: 'correctness-perf', prompt: 'Your angle: CORRECTNESS, PERFORMANCE AND REGRESSIONS (budget: browser checks one at a time at 640x360). (1) LOD generation determinism and seams, streaming/priorities (chunks never starved: measure time-to-load of the near chunks with LOD on vs off), memory bounds when flying far, drop/re-request races, depth precision (near z-fighting, far flicker), TAA/composite treatment of LOD depth. (2) Draw calls, vertex counts, added GPU work; zero cost with farTerrain 0; no GL errors across presets and aa modes; existing tests pass (mesher, worker with the stub hook, player, weather); smoke test passes (node tools/smoke-test.mjs --size 800x450 --out tools/out/lod-verify-smoke --only noon,water).' },
]

phase('Implement')
const [data, render] = await parallel([
  () => agent(DATA, { label: 'implement:lod-data', phase: 'Implement' }),
  () => agent(RENDER, { label: 'implement:lod-render', phase: 'Implement' }),
])

phase('Verify')
const reports = 'DATA ENGINEER REPORT:\n' + String(data).slice(0, 8000) + '\n\nRENDER ENGINEER REPORT:\n' + String(render).slice(0, 8000)
const reviews = await parallel(VERIFIERS.map((v) => () =>
  agent(CONTEXT + '\n\nTwo engineers just implemented distant LOD terrain.\n' + reports + '\n\nYou are an independent, skeptical verifier. READ-ONLY for tracked files (scratch files under tools/tests/lod-verify-' + v.key + '/, outputs under tools/out/lod-verify-' + v.key + '/). ' + v.prompt + ' Report at most 10 findings, most severe first, each with evidence.', {
    label: 'verify:' + v.key, phase: 'Verify', schema: FINDINGS,
  }).then((r) => Object.assign({ angle: v.key }, r))))

const findings = reviews.filter(Boolean).flatMap((r) => (r.findings || []).map((f) => Object.assign({ angle: r.angle }, f)))
const verdicts = reviews.filter(Boolean).map((r) => r.angle + ': ' + r.verdict).join('\n')
log(findings.length + ' findings from ' + reviews.filter(Boolean).length + ' verifiers')

phase('Fix')
let fix = 'No findings to fix.'
if (findings.length) {
  fix = await agent(CONTEXT + '\n\nDistant LOD terrain was just implemented by two engineers.\n' + reports + '\n\nTwo independent verifiers reviewed it. Verdicts:\n' + verdicts + '\n\nFindings (JSON):\n' + JSON.stringify(findings, null, 1) + '\n\nYou now own every file involved (src/lod.js, src/worker.js, src/world.js, src/main.js, src/config.js, src/render/*.js, src/renderer.js, SPEC.md). For each finding: re-check it; fix the root cause if real, otherwise say why not. Then run the LOD/worker tests, the compile check (node tools/run-page.mjs tools/tests/common-compile.html --until window.__done) and the smoke test (node tools/smoke-test.mjs --size 800x450 --out tools/out/lod-final --only noon,water). Final message: ## Findings (fixed / not an issue, one line why), ## Files changed, ## Evidence, ## Remaining issues.', { label: 'fix:lod', phase: 'Fix' })
}

return { data: String(data), render: String(render), verdicts, findings, fix: String(fix) }
