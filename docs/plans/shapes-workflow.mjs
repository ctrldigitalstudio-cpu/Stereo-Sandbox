export const meta = {
  name: 'stereo-sandbox-block-shapes',
  description: 'Add slabs, stairs, fences, doors and lanterns to Stereo Sandbox: world side and gameplay/render side in parallel, two verifiers, then fixes',
  phases: [
    { title: 'Implement', detail: 'blocks/shapes/meshing/textures, and physics/placement/doors/overlays, in parallel against one contract' },
    { title: 'Verify', detail: 'visual quality; gameplay correctness + performance' },
    { title: 'Fix', detail: 'apply confirmed issues, re-run checks' },
  ],
}

const REPO = '/home/user/minecraft-browser'

const CONTEXT = 'Project: "Stereo Sandbox", a Minecraft-style voxel sandbox with shader-pack graphics in plain ES modules + WebGL2 (no dependencies). Repo: ' + REPO + ' (local git repo). Read CLAUDE.md and SPEC.md first, then the files named in your task. Existing features: TAA, weather, POM/GTAO options, far LOD terrain. Blocks are stored as one byte per cell (Uint8Array) in chunks, the worker meshes chunks (src/mesher.js) into the packed vertex format (src/vertex.js), the player (src/player.js) collides with world.isSolid and raycasts full cells.\n\n' +
  'Tools: node tests under tools/tests/{mesher,player,gameplay,textures}; `node tools/run-page.mjs <page> ...`; `node tools/smoke-test.mjs --size 800x450 --out tools/out/<dir> --only a,b`; tools/tests/visual/shoot.mjs and live.mjs; window.__game (teleport, setTime, setSettings, capture(), world.setBlock, player). BUDGET: software rendering on 4 shared cores and a session usage limit: captures one at a time at 640x360, a modest number of runs. Do not run git commands that change state.\n\n' +
  'SHARED CONTRACT:\n' +
  '- Existing block ids NEVER change (saved worlds). Block states are encoded as separate ids appended to the registry (the byte storage stays): for materials M in oak_planks, spruce_planks, birch_planks, cobblestone, stone_bricks, bricks, sandstone: M_slab (bottom, top), M_stairs (facing N/E/S/W x half bottom/top), and a full-block result when a slab is placed onto a same-material slab of the other half (that becomes the full M block); fences: oak_fence, spruce_fence, birch_fence (connections computed from neighbours at mesh/collision time, no state); doors: oak_door, spruce_door (facing x lower/upper x closed/open); lantern (standing) and lantern_hanging (emissive, warm light like a torch). Must stay under 256 ids in total.\n' +
  '- Each placeable family has ONE inventory item id (the representative state); BLOCKS[id].family gives the item id for any state (pick-block, icons, sounds, labels "Oak Stairs" etc.).\n' +
  '- New module src/shapes.js (owned by the world engineer) exports: SHAPE kinds; `blockBoxes(id, getBlock, x, y, z) -> Float32Array` of AABBs (x0,y0,z0,x1,y1,z1 per box, block-local 0..1, fences use neighbours via getBlock) used for meshing, collision, raycasting and the selection outline; `placeState(itemId, hit /* {x,y,z,nx,ny,nz, px,py,pz: hit point} */, yaw, getBlock) -> { id, x, y, z, extra?: [{x,y,z,id}] } | null` (orientation from player yaw, slab/stair half from the clicked face and hit height, doors fill two cells and need support; null when not placeable); `onUse(id, x, y, z, getBlock) -> [{x,y,z,id}] | null` (doors toggle both halves); `onBreak(id, x, y, z, getBlock) -> [{x,y,z,id}]` (breaking one door half removes the other); `isFullCube(id)`, `lightOpacity`, and anything else both sides need. The gameplay engineer codes against this API (stubbing it in tests only until it exists).\n' +
  '- Collision: World gains `boxesAt(x, y, z) -> Float32Array` (world-space AABBs from blockBoxes; unloaded chunk = full box); the player collides with boxes instead of whole cells and gets a Minecraft-like step-up of 0.6 blocks when walking (onto slabs and stairs), not when flying.\n' +
  '- Raycast hits the actual boxes (you can target through an open door, pick the slab half), returning the hit face, the hit point and the block.'

const WORLD = CONTEXT + '\n\n' +
  'TASK (world side): you own src/blocks.js, src/shapes.js (new), src/mesher.js, src/worker.js, src/vertex.js, src/textures.js (new textures: door panels with windows/hinges, lantern body + glass + flame, and icons for every new family via makeBlockIcon drawing the real shape), SPEC.md (blocks/shapes/meshing sections), tools/tests/mesher/, tools/tests/textures/. The gameplay engineer owns src/player.js, src/world.js, src/main.js, src/audio.js, src/ui.js, src/render/overlays.js at the same time: do not edit those.\n' +
  '1. Registry + shapes.js per the contract (write shapes.js FIRST so the other engineer can build on it early).\n' +
  '2. Meshing of every shape with correct face culling against neighbours (a slab\'s top half face against the block above is not hidden unless that face is fully covered; stairs\' step faces; fence posts and arms by connection; door panels; lantern body and chain), UVs sampled from the right part of the material texture (slabs use the top/bottom half of the side texture, like Minecraft), smooth light + AO that look right on partial faces, emissive lantern flame, light rules (slabs/stairs let light into their own cell; decide opacity sensibly and document it).\n' +
  '3. Textures + icons for the new families; INVENTORY gains the new items in sensible positions.\n' +
  '4. Tests: shape boxes for every id, culling cases (slab next to slab, stairs corners, fence connections to fences/solid blocks), light/AO on partial faces, packing, mesher bench before/after (no significant slowdown for normal terrain), texture sheet + icon screenshots.\n' +
  'Final message: ## Files changed, ## Design (ids table, shapes API, light rules), ## Tests + bench, ## Notes for the gameplay engineer.'

const PLAY = CONTEXT + '\n\n' +
  'TASK (gameplay + overlays): you own src/player.js, src/world.js, src/main.js, src/audio.js, src/ui.js, src/render/overlays.js, tools/tests/player/, tools/tests/shapes-play/. The world engineer owns src/blocks.js, src/shapes.js, src/mesher.js, src/worker.js, src/vertex.js, src/textures.js at the same time: do not edit those; code against the contract and stub shapes.js only inside your tests until it exists.\n' +
  '1. Physics: collide against World.boxesAt boxes (sweep per axis as now, no tunnelling at any dt), step-up 0.6 blocks when walking on ground (smooth camera, no step-up while flying or swimming), sneaking edge guard still works on slabs/stairs.\n' +
  '2. Raycast against boxes; placement via shapes.placeState (orientation, halves, doors needing two free cells and support; slab-on-slab merging; refuse when overlapping the player); right-click on a door toggles it via shapes.onUse (before placement) with a door sound (synthesized, wood creak/thud in src/audio.js); breaking via shapes.onBreak (both door halves, particles/sounds per family); pick-block returns the family item.\n' +
  '3. Selection outline (overlays.drawSelection) draws the real boxes of the targeted block; the held block (buildHeldMesh) shows the real shape for the new families (stairs, slab, fence post, door, lantern); particles use the family texture.\n' +
  '4. UI: inventory shows the new families (icons from makeBlockIcon), search by name works; hotbar labels show family names.\n' +
  '5. Tests (node): collision/step-up on slabs and stairs at many dt, walking into fences (1.5 high), closed vs open doors, raycast picking slab halves and stair steps, placement rules for every family and facing, door toggle and double-break, save/load of edited shapes via the existing gameplay tests; then a real-game run with no errors.\n' +
  'Final message: ## Files changed, ## Design, ## Tests, ## Notes for the world engineer.'

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
  { key: 'visual', prompt: 'Your angle: VISUAL QUALITY (budget: at most 5 capture runs, one at a time, 640x360), judged only from images you capture in the real game: build a small scene with __game.world.setBlock (a house with stairs roof, slab floors, fences around it, an oak and a spruce door open and closed, standing and hanging lanterns at night) and look at it by day, at sunset and at night with lanterns; check texture mapping on partial faces, face culling gaps or z-fighting, AO/light on partial faces, lantern glow, selection outlines and the held shapes, icons in the inventory.' },
  { key: 'gameplay-perf', prompt: 'Your angle: GAMEPLAY CORRECTNESS, PERFORMANCE AND REGRESSIONS (budget: browser checks one at a time at 640x360). (1) Existing block ids unchanged (compare with `git show HEAD:src/blocks.js`) and old saves load; placement orientation and halves for every family, slab merging, doors (two cells, support, toggle, double-break, cannot walk through closed, can through open), step-up on slabs/stairs, no getting stuck or tunnelling, raycast on partial shapes, pick-block, save/load of shapes, worker remesh across chunk borders. (2) Mesher bench before/after (export HEAD versions with `git show HEAD:src/mesher.js` into a scratch directory; never stash or check out), physics cost per frame, no GL errors, existing tests pass (mesher, worker with the stub hook, player, gameplay journey), smoke test passes (node tools/smoke-test.mjs --size 800x450 --out tools/out/shapes-verify-smoke --only afternoon,torches).' },
]

phase('Implement')
const [world, play] = await parallel([
  () => agent(WORLD, { label: 'implement:shapes-world', phase: 'Implement' }),
  () => agent(PLAY, { label: 'implement:shapes-play', phase: 'Implement' }),
])

phase('Verify')
const reports = 'WORLD ENGINEER REPORT:\n' + String(world).slice(0, 8000) + '\n\nGAMEPLAY ENGINEER REPORT:\n' + String(play).slice(0, 8000)
const reviews = await parallel(VERIFIERS.map((v) => () =>
  agent(CONTEXT + '\n\nTwo engineers just added slabs, stairs, fences, doors and lanterns.\n' + reports + '\n\nYou are an independent, skeptical verifier. READ-ONLY for tracked files (scratch files under tools/tests/shapes-verify-' + v.key + '/, outputs under tools/out/shapes-verify-' + v.key + '/). ' + v.prompt + ' Report at most 10 findings, most severe first, each with evidence.', {
    label: 'verify:' + v.key, phase: 'Verify', schema: FINDINGS,
  }).then((r) => Object.assign({ angle: v.key }, r))))

const findings = reviews.filter(Boolean).flatMap((r) => (r.findings || []).map((f) => Object.assign({ angle: r.angle }, f)))
const verdicts = reviews.filter(Boolean).map((r) => r.angle + ': ' + r.verdict).join('\n')
log(findings.length + ' findings from ' + reviews.filter(Boolean).length + ' verifiers')

phase('Fix')
let fix = 'No findings to fix.'
if (findings.length) {
  fix = await agent(CONTEXT + '\n\nSlabs, stairs, fences, doors and lanterns were just added by two engineers.\n' + reports + '\n\nTwo independent verifiers reviewed it. Verdicts:\n' + verdicts + '\n\nFindings (JSON):\n' + JSON.stringify(findings, null, 1) + '\n\nYou now own every file involved (src/blocks.js, src/shapes.js, src/mesher.js, src/worker.js, src/vertex.js, src/textures.js, src/player.js, src/world.js, src/main.js, src/audio.js, src/ui.js, src/render/overlays.js, SPEC.md). For each finding: re-check it; fix the root cause if real, otherwise say why not. Then run the mesher/worker/player/shape tests, the compile check (node tools/run-page.mjs tools/tests/common-compile.html --until window.__done) and the smoke test (node tools/smoke-test.mjs --size 800x450 --out tools/out/shapes-final --only afternoon,torches). Final message: ## Findings (fixed / not an issue, one line why), ## Files changed, ## Evidence, ## Remaining issues.', { label: 'fix:shapes', phase: 'Fix' })
}

return { world: String(world), play: String(play), verdicts, findings, fix: String(fix) }
