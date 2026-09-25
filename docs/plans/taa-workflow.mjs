export const meta = {
  name: 'stereo-sandbox-taa',
  description: 'Implement TAA with temporal upscaling in the Stereo Sandbox renderer, verify it (visual + maths), fix confirmed issues',
  phases: [
    { title: 'Implement', detail: 'one engineer builds TAA + temporal upscaling' },
    { title: 'Verify', detail: 'visual ghosting/stability (maths verified earlier)' },
    { title: 'Fix', detail: 'apply confirmed issues, re-run checks' },
  ],
}

const REPO = '/home/user/minecraft-browser'

const CONTEXT = 'Project: "Stereo Sandbox", a Minecraft-style voxel sandbox with shader-pack graphics in plain ES modules + WebGL2 (no dependencies). Repo: ' + REPO + ' (local git repo). Read CLAUDE.md and SPEC.md first, then src/renderer.js (frame graph), src/render/common.js (GLSL_COMMON, Frame UBO), src/render/post.js (light shafts, clouds, composite, bloom, exposure, tone map, FXAA), src/render/terrain.js, src/render/atmosphere.js, src/render/overlays.js (held block), src/config.js, src/main.js (how frames are built; do not edit it).\n\n' +
  'Tools: `node tools/run-page.mjs <page> --until <expr> --shot tools/out/x.png` (headless Chromium, SwiftShader software GL on 4 shared cores: frames take seconds, so judge images, never speed); `node tools/smoke-test.mjs --size 800x450 --out tools/out/<dir> --only a,b` (scenes: noon, afternoon, sunset, night, water, underwater, torches); tools/tests/visual/shoot.mjs and live.mjs (the visual engineer\'s capture tools: named scenes, and a live session that swaps in renderer changes). window.__game exposes teleport(x,y,z,yaw,pitch), setTime(t), setSettings(patch), capture() (PNG of the next frame), frame, loaded(r), player, renderer. Test mode: index.html?test (seed 12345, light settings). View PNGs with the Read tool; tools/tests/sky-post/crop.mjs zooms into regions.\n\n' +
  'A gameplay QA engineer is editing src/main.js, src/world.js, src/player.js, src/input.js, src/ui.js, src/audio.js, index.html, style.css, README.md and tools/smoke-test.mjs right now: never edit those. Do not run git commands that change state. Keep outputs under tools/out/taa-*/ and test files under tools/tests/taa/.'

const IMPLEMENT = CONTEXT + '\n\n' +
  'TASK: implement temporal anti-aliasing with temporal upscaling (TAAU) and make it the default anti-aliasing. You own src/renderer.js, src/render/post.js, src/render/common.js, a new src/render/taa.js, src/render/terrain.js, src/render/atmosphere.js, src/render/overlays.js, src/config.js and the SPEC.md rendering section.\n\n' +
  'Requirements:\n' +
  '1. Sub-pixel jitter: Halton(2,3) sequence (8-16 samples) in render-resolution pixels, applied to the projection used by every geometry pass and by full-screen passes that reconstruct view rays (sky, clouds, light shafts, SSR, composite), so the whole image is consistently jittered. The shadow pass is never jittered. Keep unjittered view-projection matrices (current and previous) for reprojection, and put what shaders need in the Frame UBO (update FRAME_OFFSETS and the GLSL block consistently).\n' +
  '2. Reprojection for a static world: reconstruct the camera-relative position from depth, add the camera translation delta (camPos - prevCamPos, computed in JS doubles), project with the previous unjittered view-projection. Use the closest depth in a 3x3 neighbourhood (depth dilation) for edges. Sky pixels reproject by direction only (no translation).\n' +
  '3. Resolve (new pass after the composite, before bloom/exposure/tone map): output-resolution history (RGBA16F ping-pong). The current frame is sampled from the render-resolution buffer with a jitter-aware reconstruction filter (e.g. Gaussian or Blackman-Harris weights over the 3x3 render texels around the output pixel centre). Neighbourhood clamp: variance clipping in YCoCg on the current 3x3. History sampled with a 5-tap Catmull-Rom. Blend factor around 0.1 at native resolution, with more history weight when upscaling. Reduce the current-frame weight where the reconstruction confidence is low (the output pixel is far from any jittered sample). Luminance weighting (1/(1+luma)) against fireflies. Reject history on disocclusion (reprojected position off-screen, or large depth mismatch) and on camera cuts (translation > ~4 blocks in a frame or rotation > ~60 degrees: a teleport).\n' +
  '4. Temporal upscaling: when renderScale < 1 the resolve reconstructs directly to the canvas/output resolution. Everything after the resolve (bloom, exposure, tone map, final pass) runs at output resolution. Adaptive resolution (main.js lowers renderScale via applySettings) must keep working. History is reset on output-size change; a renderScale change keeps the history if possible (it is output-sized) but reprojects correctly.\n' +
  '5. Keep the scene-colour alpha channel semantics the visual engineer relies on: alpha = 1 - self-emission, carried through the bloom chain, and the exposure pass meters bloom level 4 and reads the scene depth. Adapt those inputs to the new resolution flow without breaking them.\n' +
  '6. The held block (overlays.drawHeld) must not be jittered or smeared: draw it after the resolve, into the output-resolution HDR target with its own depth.\n' +
  '7. The half-resolution light shafts and clouds are dithered per frame (ignFrame); with TAA their 3x3 denoise can be lighter so the temporal accumulation removes noise without blurring. Tune it.\n' +
  '8. After TAA, apply a light contrast-adaptive sharpen (RCAS/CAS-style) in the final pass to restore pixel-art crispness. FXAA stays available as the non-temporal option. The final pass does sharpen+sRGB (TAA), FXAA, or a straight copy (off).\n' +
  '9. Settings: replace the boolean fxaa with `aa: "taa" | "fxaa" | "off"` in src/config.js (schema label "Anti-aliasing", options TAA, FXAA, Off). Presets: low -> "fxaa", medium/high/ultra -> "taa". Map an old saved `fxaa` boolean to `aa` in loadSettings. Renderer.applySettings reads settings.aa (and tolerates the old fxaa field). With TAA on, the High and Ultra presets may use renderScale 0.85 to spend the saved time elsewhere; Medium 0.75. Decide from quality comparisons.\n' +
  '10. Robustness: no GL errors; RGBA8 fallback path still works (history in RGBA8 is acceptable, just no worse); context loss guards stay; resize and DPR changes reset history; the first frame after reset shows the current frame only.\n\n' +
  'Verify as you go: compile checks, then screenshots. Static camera: TAA converges to clean edges (compare TAA vs FXAA crops of leaves, fences of blocks, distant edges, texture detail). Moving camera: write a capture script that moves the camera a little each frame (teleport or yaw/pitch deltas) and grabs frames mid-motion to check for ghosting and smearing on edges, leaves and water. Check renderScale 0.5 and 0.75 upscaled against 1.0. Run the smoke test at the end (no page errors).\n\n' +
  'Final message: ## Files changed, ## Design (the frame graph now, the resolve maths, the UBO changes), ## Evidence (image paths and what they show), ## Known limitations.'

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
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'what you observed or ran, with image paths or code quotes' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'severity', 'evidence', 'fix'],
      },
    },
    verdict: { type: 'string', description: 'overall assessment of the TAA implementation from your angle' },
  },
  required: ['findings', 'verdict'],
}

const VERIFIERS = [
  { key: 'visual', prompt: 'Your angle: VISUAL QUALITY. BUDGET: this machine renders in software on 4 shared cores and the session has a usage limit, so run at most 4 capture scripts in total, one at a time (never in parallel), at 640x360, and reuse the implementer\'s comparison images in tools/out/taa-final/ where they already answer a question. Judge the new TAA/TAAU the way a player would, only from images you capture yourself. Check: static convergence (edges clean, textures sharp, pixel-art not blurred); ghosting and smearing while the camera strafes, turns and flies (write a script that moves the camera a little each frame and grabs frames mid-motion); leaves waving, particles, water waves and underwater views; the held block not jittered or smeared; sky, clouds and stars stable (no swimming or trails); light shafts and clouds less noisy than before; the torches scene at night; renderScale 0.5, 0.75 and 1.0 (is 0.75 TAAU close to native?); a teleport (no smeared transition). Compare against FXAA (setSettings({aa: "fxaa"})). Report concrete problems with image evidence.' },
]

phase('Implement')
const impl = await agent(IMPLEMENT, { label: 'implement:taa', phase: 'Implement' })

phase('Verify')
const reviews = await parallel(VERIFIERS.map((v) => () =>
  agent(CONTEXT + '\n\nAn engineer just implemented TAA with temporal upscaling. Their report:\n' + String(impl).slice(0, 12000) + '\n\nYou are an independent, skeptical verifier. This is READ-ONLY for tracked files (write only scratch files under tools/tests/taa/verify-' + v.key + '/ and outputs under tools/out/taa-verify-' + v.key + '/). ' + v.prompt + ' Report at most 10 findings, most severe first, each with evidence.', {
    label: 'verify:' + v.key, phase: 'Verify', schema: FINDINGS,
  }).then((r) => Object.assign({ angle: v.key }, r))))

// The maths review already ran in an earlier run of this workflow; it is passed in via args.
const allReviews = reviews.filter(Boolean).concat((args && args.priorReviews) || [])
const findings = allReviews.flatMap((r) => (r.findings || []).map((f) => Object.assign({ angle: r.angle }, f)))
const verdicts = allReviews.map((r) => r.angle + ': ' + r.verdict).join('\n')
log(findings.length + ' findings from ' + allReviews.length + ' verifiers')

phase('Fix')
let fix = 'No findings to fix.'
if (findings.length) {
  fix = await agent(CONTEXT + '\n\nYou implemented (or are taking over) the TAA/TAAU work in this repo; the implementer\'s report:\n' + String(impl).slice(0, 8000) + '\n\nTwo independent verifiers reviewed it (visual quality, maths/state). Their verdicts:\n' + verdicts + '\n\nTheir findings (JSON):\n' + JSON.stringify(findings, null, 1) + '\n\nFor each finding: re-check it against the code/images; if it is real, fix the root cause; if it is not, say why. You own the same files as the implementer (src/renderer.js, src/render/*.js, src/render/taa.js, src/config.js, SPEC.md rendering section). Also check performance/regressions yourself cheaply (no GL errors across aa taa/fxaa/off and renderScale 0.5-1 via tools/tests/taa/compile.html). Re-run the relevant captures (one at a time, 640x360) and finally the smoke test (node tools/smoke-test.mjs --size 800x450 --out tools/out/taa-final --only afternoon,water,torches) and the compile check (node tools/run-page.mjs tools/tests/common-compile.html --until window.__done). Final message: ## Findings (each: fixed / not an issue, with one line why), ## Files changed, ## Evidence, ## Remaining issues.', { label: 'fix:taa', phase: 'Fix' })
}

return { implementation: String(impl), verdicts, findings, fix: String(fix) }
