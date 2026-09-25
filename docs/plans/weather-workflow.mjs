export const meta = {
  name: 'stereo-sandbox-weather',
  description: 'Add dynamic weather (rain, snow, thunderstorms) to Stereo Sandbox: simulation+audio and rendering in parallel, then verification and fixes',
  phases: [
    { title: 'Implement', detail: 'weather simulation/audio/integration and weather rendering, in parallel against one contract' },
    { title: 'Verify', detail: 'visual quality; state/integration + performance' },
    { title: 'Fix', detail: 'apply confirmed issues, re-run checks' },
  ],
}

const REPO = '/home/user/minecraft-browser'

const CONTEXT = 'Project: "Stereo Sandbox", a Minecraft-style voxel sandbox with shader-pack graphics in plain ES modules + WebGL2 (no dependencies). Repo: ' + REPO + ' (local git repo). Read CLAUDE.md and SPEC.md first, then the files named in your task. The renderer already has TAA with temporal upscaling (src/render/taa.js, resolve after the composite; the held block is drawn after the resolve at output resolution).\n\n' +
  'Tools: `node tools/run-page.mjs <page> --until <expr> --shot tools/out/x.png` (headless Chromium, SwiftShader software GL on 4 shared cores: frames take seconds, judge images, never speed); `node tools/smoke-test.mjs --size 800x450 --out tools/out/<dir> --only a,b`; tools/tests/visual/shoot.mjs and live.mjs (capture named scenes; a live session that swaps in renderer changes). window.__game exposes teleport, setTime, setSettings, capture() (PNG of the next frame), frame, loaded(r), player, world, renderer, gen. Test mode: index.html?test. View PNGs with the Read tool. Do not run git commands that change state.\n\n' +
  'SHARED CONTRACT (both implementers build against exactly this):\n' +
  '- src/weather.js exports class Weather { constructor(gen) ; update(dt, { pos:[x,y,z], timeOfDay, settings, world }) ; state ; serialize() ; static deserialize(obj) ; onLightning(cb) }.\n' +
  '- weather.state (read every frame by main.js and passed to the renderer as frame.weather) = { rain: 0..1 (liquid precipitation intensity at the player), snow: 0..1 (frozen precipitation intensity; rain and snow are exclusive per position: cold biomes or high altitude get snow), thunder: 0..1, wetness: 0..1 (slow ramp up while raining, slow dry-out after), snowCover: 0..1 (slow build-up while snowing), cloudCoverage: 0..1 (replaces settings.cloudCoverage when weather is dynamic), overcast: 0..1 (sky/sun dimming), fogDensity: multiplier >= 1, wind: [x, z] blocks/s, lightning: 0..1 (flash intensity this frame, decays over ~0.3 s), lightningPos: [x, y, z] | null, precipOcclusion: { data: Uint8Array(64*64) of the highest precipitation-blocking block y+1 per column (0..128) in a 64x64 window, originX, originZ (world x/z of texel 0), version (increments when data changes) } }.\n' +
  '- settings.weather: "dynamic" | "clear" | "rain" | "thunder" | "snow" (default "dynamic"), added to src/config.js DEFAULT_SETTINGS and SETTINGS_SCHEMA (group World, label "Weather").\n' +
  '- Precipitation, splashes and lightning bolts are drawn AFTER the TAA resolve at output resolution (like the held block), unjittered, so fast streaks never ghost. Wetness, puddles, ripples and snow cover are part of normal scene shading (before the resolve).'

const SIM = CONTEXT + '\n\n' +
  'TASK (weather simulation, audio, integration): you own src/weather.js (new), src/main.js, src/audio.js, src/config.js (weather setting only; do not change other settings), src/world.js (only if the occlusion window needs a helper), README.md (a short Weather section), tools/tests/weather/ (your tests). The rendering engineer owns src/render/*, src/renderer.js and src/particles.js at the same time: do not edit those.\n' +
  '1. Weather state machine: states clear, cloudy, rain, thunder (and snow where cold). Minecraft-like durations: clear 5-15 min, rain 3-8 min, thunder 2-5 min, with smooth ramps (~20-40 s) between intensities; deterministic enough to test (inject a random source). Precipitation type at the player from WorldGen climate (gen.climateAt / columnInfo: temperature < ~0.25 or altitude above the snow line -> snow). Deserts and badlands: no precipitation (clouds only). Forced modes from settings.weather. Wind grows with storms.\n' +
  '2. precipOcclusion: 64x64 window centred on the player, updated when the player crosses a block or when blocks change (listen to world.setBlock / new meshes cheaply; recompute incrementally or at most a few times per second), highest block that stops rain (solid or leaves or glass; not plants/torches/water surface? water surface stops it at the top of the water) per column.\n' +
  '3. Lightning: during thunder, random strikes every 5-20 s within ~100 blocks; lightning 0..1 flash envelope (double flicker), lightningPos; onLightning callbacks. Thunder sound delayed by distance / 343 m/s.\n' +
  '4. Audio (src/audio.js, synthesized WebAudio, fail-silent): a rain bed (filtered noise, intensity-scaled, brighter hiss on leaves, muffled when the player is under cover or indoors: use eyeSkyLight and whether the eye column is occluded), rain on water/ground variation optional, snow is silent (maybe faint wind), thunder (low rumble + crack for near strikes, delayed, panned by direction), wind gusts during storms. Respect the sound settings and the underwater muffle. Keep CPU cheap (no per-frame node creation).\n' +
  '5. Integration in main.js: create Weather, update it each frame (paused -> frozen), pass frame.weather to renderer.render, use weather.state.cloudCoverage instead of settings.cloudCoverage when settings.weather is dynamic, save/load weather with the game (serialize), expose __game.weather and __game.setWeather(mode) for tests, show a subtle toast when a thunderstorm starts (optional). The F3 debug panel: add weather info through ui.update (ui.js may need a tiny addition: if so make it minimal).\n' +
  '6. Tests (node, tools/tests/weather/): state transitions and ramps, forced modes, precipitation type by climate, occlusion window correctness against a mock world (roof, tree, open sky, cave), lightning timing, serialize round-trip. Then run the real game (index.html?test with __game.setWeather) and make sure there are no errors.\n' +
  'Final message: ## Files changed, ## Design, ## Tests, ## Notes for the rendering engineer.'

const RENDER = CONTEXT + '\n\n' +
  'TASK (weather rendering): you own src/render/weather.js (new), src/render/terrain.js, src/render/atmosphere.js, src/render/post.js, src/render/taa.js, src/render/common.js, src/renderer.js, src/render/overlays.js, src/particles.js. The simulation engineer owns src/weather.js, src/main.js, src/audio.js, src/config.js at the same time: do not edit those. Until src/weather.js exists, drive your work with a hand-made frame.weather object in your own harness (tools/tests/weather-render/), e.g. by wrapping renderer.render in the live game and injecting frame.weather.\n' +
  '1. Precipitation (src/render/weather.js, drawn after the TAA resolve at output resolution with the scene depth for occlusion against terrain in front): rain as camera-facing velocity-aligned streaks (instanced, generated in the vertex shader from gl_InstanceID + time, looping in a cylinder of ~24-40 blocks around the camera, density by intensity, slanted by wind, lit by sky ambient + lightning, slightly refractive/bright near light sources), snow as slow fluttering flakes. Upload precipOcclusion as an R8 64x64 texture (when version changes) and discard drops below the occluding height of their column, so there is no rain under roofs, trees or in caves. Splash particles where drops hit the occlusion height near the camera (cheap, GPU-side). Fade near the camera to avoid big streaks in the face; nothing when underwater.\n' +
  '2. Wet world (terrain shader): wetness darkens porous albedo and raises smoothness on surfaces exposed to the sky (sky light high), more on up-facing faces; puddles on up-facing faces in low spots via noise (not on leaves/plants), mirror-like with sky reflection (and the existing reflection path), with animated rain ripples (ring normals) while raining; the same ripples on water surfaces (water shader). Snow cover: up-facing exposed faces blend toward a sparkly snow material by snowCover with a noisy edge, leaves get a frosted top.\n' +
  '3. Sky and light: overcast desaturates and darkens the sky LUT/irradiance and the sun/moon light (cloud coverage from weather drives the volumetric clouds, which should look heavier and darker in storms), fog density multiplier, a darker exposure target. Lightning: a brief scene-wide bluish-white flash (sky + ambient boost), optionally a bolt (jagged emissive line geometry from the cloud base to lightningPos, drawn after the resolve, very bright so it blooms).\n' +
  '4. Performance: the weather pass must be cheap (one instanced draw for precipitation, one for splashes); zero cost when there is no weather (skip passes, uniform branches). Keep the Low preset cheap (fewer drops).\n' +
  '5. Verify with captures: clear vs rain vs thunder vs snow at noon and dusk, under a tree/roof (no rain inside), a puddle close-up while raining, water ripples, snow cover in a snowy biome, lightning flash frame, underwater during rain (no streaks). Run the compile check and the smoke test at the end.\n' +
  'Final message: ## Files changed, ## Design, ## Evidence (image paths), ## Notes for the simulation engineer.'

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
  { key: 'visual', prompt: 'Your angle: VISUAL QUALITY (budget: at most 5 capture runs, one at a time, 640x360), judged only from images you capture in the real game (index.html?test, __game.setWeather(mode), setTime, teleport). Does rain/snow/thunder look beautiful and believable, like a good Minecraft shader pack? Check streak look and density, no rain under roofs/trees/in caves, splashes, wet surfaces and puddle reflections, ripples on water and puddles, snow cover, overcast sky and heavier clouds, lightning flash, dusk and night rain, underwater during rain, transitions (capture a sequence while the weather ramps), and TAA interaction (no ghost trails from streaks).' },
  { key: 'state-perf', prompt: 'Your angle: SIMULATION, INTEGRATION, PERSISTENCE, PERFORMANCE AND REGRESSIONS (two lenses in one; budget: browser checks one at a time at 640x360). (1) Check the Weather state machine, ramps, forced modes from settings, precipitation type by biome/altitude, precipOcclusion correctness near the player and after block edits, lightning timing and the thunder delay, save/load of weather, paused/title behaviour, the audio lifecycle (no node leaks per frame, muffling indoors and underwater, sound setting respected), and that frame.weather matches the contract field-for-field between src/weather.js/main.js and the renderer. (2) Count the added passes/draws/fetches; confirm zero cost when clear; no per-frame allocations on the main thread from weather; no GL errors across weather modes x presets (low/high) x aa (taa/fxaa); the smoke test passes (node tools/smoke-test.mjs --size 800x450 --out tools/out/weather-verify-smoke --only afternoon,water,torches); existing tests still pass (mesher, player, weather).' },
]

phase('Implement')
const [sim, render] = await parallel([
  () => agent(SIM, { label: 'implement:weather-sim', phase: 'Implement' }),
  () => agent(RENDER, { label: 'implement:weather-render', phase: 'Implement' }),
])

phase('Verify')
const reports = 'SIMULATION ENGINEER REPORT:\n' + String(sim).slice(0, 8000) + '\n\nRENDERING ENGINEER REPORT:\n' + String(render).slice(0, 8000)
const reviews = await parallel(VERIFIERS.map((v) => () =>
  agent(CONTEXT + '\n\nTwo engineers just implemented dynamic weather.\n' + reports + '\n\nYou are an independent, skeptical verifier. READ-ONLY for tracked files (scratch files under tools/tests/weather/verify-' + v.key + '/, outputs under tools/out/weather-verify-' + v.key + '/). ' + v.prompt + ' Report at most 10 findings, most severe first, each with evidence.', {
    label: 'verify:' + v.key, phase: 'Verify', schema: FINDINGS,
  }).then((r) => Object.assign({ angle: v.key }, r))))

const findings = reviews.filter(Boolean).flatMap((r) => (r.findings || []).map((f) => Object.assign({ angle: r.angle }, f)))
const verdicts = reviews.filter(Boolean).map((r) => r.angle + ': ' + r.verdict).join('\n')
log(findings.length + ' findings from ' + reviews.filter(Boolean).length + ' verifiers')

phase('Fix')
let fix = 'No findings to fix.'
if (findings.length) {
  fix = await agent(CONTEXT + '\n\nDynamic weather was just implemented by two engineers.\n' + reports + '\n\nTwo independent verifiers reviewed it. Verdicts:\n' + verdicts + '\n\nFindings (JSON):\n' + JSON.stringify(findings, null, 1) + '\n\nYou now own all weather-related files (src/weather.js, src/render/weather.js, src/render/*.js, src/renderer.js, src/main.js, src/audio.js, src/config.js, src/particles.js). For each finding: re-check it; fix the root cause if real, otherwise say why not. Then run node tools/tests/weather/ tests, the compile check (node tools/run-page.mjs tools/tests/common-compile.html --until window.__done) and the smoke test (node tools/smoke-test.mjs --size 800x450 --out tools/out/weather-final --only afternoon,water,torches). Final message: ## Findings (fixed / not an issue, one line why), ## Files changed, ## Evidence, ## Remaining issues.', { label: 'fix:weather', phase: 'Fix' })
}

return { sim: String(sim), render: String(render), verdicts, findings, fix: String(fix) }
