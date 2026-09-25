#!/usr/bin/env node
// Main-thread World <-> world worker protocol under message races (node, no browser).
// The real World (src/world.js) talks to the real WorldService (src/worker.js) through queues whose
// delivery order is randomised: meshes arrive late, after the camera moved away and back, after
// edits; unload / want / set messages interleave with worker tasks. After every run the system is
// drained and these must hold:
//   1. every chunk main holds is known as held by the worker (so edits keep re-meshing it)
//   2. main's block copy of every held chunk equals the worker's data (physics == visuals)
//   3. the last mesh main received for each held chunk equals a mesh built from scratch with the
//      same seed + edits (incremental re-meshing of edits and their neighbours is exact)
//   4. main and worker agree on the recorded edits
//   node tools/tests/gameplay/world-sync.test.mjs [--runs 12] [--seed 1]

import { World } from '../../../src/world.js';
import { WorldService, chunkKey } from '../../../src/worker.js';
import { WorldGen } from '../../../src/worldgen.js';
import { B, NUM_BLOCKS, CHUNK } from '../../../src/blocks.js';
import { mulberry32 } from '../../../src/noise.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? Number(args[i + 1]) : d; };
const RUNS = opt('runs', 12);
const SEED0 = opt('seed', 1);
const faceLayers = new Uint16Array(NUM_BLOCKS * 6).map((_, i) => i % 7);
const gens = new Map();
const genFor = (seed) => { if (!gens.has(seed)) gens.set(seed, new WorldGen(seed)); return gens.get(seed); };

let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };

// Worker stand-in: World posts into `toWorker`; the test decides when each message is delivered.
let current = null;
globalThis.Worker = class {
  constructor() { this.onmessage = null; this.onerror = null; current = this; this.toWorker = []; }
  postMessage(msg) { this.toWorker.push(structuredClone(msg)); }
  terminate() {}
};

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function run(runSeed) {
  const rnd = mulberry32(runSeed);
  const pick = (n) => Math.floor(rnd() * n);
  const seed = 1000 + runSeed;
  const lastMesh = new Map();         // key -> mesh message main last uploaded
  const world = new World({
    seed, faceLayers, edits: new Map(),
    onMesh: (cx, cz, msg) => lastMesh.set(`${cx},${cz}`, msg),
    onUnload: (cx, cz) => lastMesh.delete(`${cx},${cz}`),
  });
  const worker = current;
  const toMain = [];
  const tasks = [];
  const svc = new WorldService({
    post: (msg, transfer) => toMain.push(structuredClone(msg, { transfer: transfer || [] })),
    schedule: (f) => tasks.push(f),
    createGenerator: genFor,
  });
  const deliverToWorker = () => { const m = worker.toWorker.shift(); if (m) svc.handle(m); return !!m; };
  const deliverToMain = () => { const m = toMain.shift(); if (m) worker.onmessage({ data: m }); return !!m; };
  const runTask = () => { const f = tasks.shift(); if (f) f(); return !!f; };

  const RD = 2;
  let cam = [8, 8];
  const moveCamera = () => {
    const r = rnd();
    if (r < 0.5) cam = [cam[0] + (pick(3) - 1) * CHUNK, cam[1] + (pick(3) - 1) * CHUNK];      // step
    else if (r < 0.8) cam = [cam[0] + (pick(2) ? 1 : -1) * (RD + 3) * CHUNK, cam[1]];       // leave range
    else cam = [8 + (pick(3) - 1) * CHUNK, 8 + (pick(3) - 1) * CHUNK];                         // come back home
    world.lastWantTime = -1e9;   // no 1.5 s throttle in a simulation
    world.update(cam[0], cam[1], RD);
  };
  const edit = () => {
    const keys = [...world.chunks.keys()];
    if (!keys.length) return;
    const [cx, cz] = keys[pick(keys.length)].split(',').map(Number);
    // Bias toward chunk borders and corners, where neighbour re-meshing matters.
    const lx = [0, 1, 14, 15, pick(16)][pick(5)], lz = [0, 1, 14, 15, pick(16)][pick(5)];
    const x = cx * CHUNK + lx, z = cz * CHUNK + lz;
    let y = 127;
    while (y > 1 && world.getBlock(x, y, z) === 0) y--;
    const ids = [0, B.STONE, B.GLOWSTONE, B.GLASS, B.TORCH, B.WATER, B.OAK_LEAVES];
    const id = ids[pick(ids.length)];
    world.setBlock(x, id === 0 ? y : y + 1 + pick(3), z, id);
  };

  world.update(cam[0], cam[1], RD);
  for (let step = 0; step < 900; step++) {
    const r = rnd();
    if (r < 0.28) deliverToWorker();
    else if (r < 0.58) runTask();
    else if (r < 0.86) deliverToMain();
    else if (r < 0.93) edit();
    else moveCamera();
  }
  // Settle: come home, then drain everything (messages in both directions, all worker tasks).
  cam = [8, 8];
  world.lastWantTime = -1e9;
  world.update(cam[0], cam[1], RD);
  for (let resends = 0; resends < 3;) {
    if (deliverToWorker() || runTask() || deliverToMain()) continue;
    // Idle: main re-sends its want list periodically (every 1.5 s in the game).
    if (world.loadedFraction(RD) >= 1) break;
    world.lastWantTime = -1e9;
    world.update(cam[0], cam[1], RD);
    resends++;
  }

  const tag = `run ${runSeed}`;
  if (world.loadedFraction(RD) < 1) fail(`${tag}: chunks around the camera never arrived (${world.loadedFraction(RD).toFixed(2)})`);
  // Reference: a fresh service with the same seed and edits builds every mesh from scratch.
  const edits = [];
  for (const [k, m] of world.edits) edits.push([k, [...m]]);
  const refPosts = [];
  const ref = new WorldService({ post: (m) => refPosts.push(m), schedule: () => {}, createGenerator: genFor });
  ref.handle({ type: 'init', seed, faceLayers, edits });
  let checked = 0;
  for (const [key, chunk] of world.chunks) {
    const k = chunkKey(chunk.cx, chunk.cz);
    if (!svc.held.has(k)) fail(`${tag}: main holds ${key} but the worker doesn't know (edits there would never re-mesh)`);
    const wc = svc.chunks.get(k);
    if (wc && !sameArray(wc.blocks, chunk.blocks)) fail(`${tag}: main's block copy of ${key} differs from the worker's`);
    refPosts.length = 0;
    ref.handle({ type: 'want', keys: [[chunk.cx, chunk.cz]] });
    ref.drain();
    const want = refPosts.find((m) => m.type === 'mesh');
    const got = lastMesh.get(key);
    if (!got) { fail(`${tag}: no mesh uploaded for held chunk ${key}`); continue; }
    if (!sameArray(want.blocks, chunk.blocks)) fail(`${tag}: ${key} block data differs from a fresh generation + edits`);
    if (got.opaqueQuads !== want.opaqueQuads || got.waterQuads !== want.waterQuads || !sameArray(got.opaque, want.opaque) || !sameArray(got.water, want.water)) {
      fail(`${tag}: stale mesh for ${key} (quads ${got.opaqueQuads}/${got.waterQuads}, fresh ${want.opaqueQuads}/${want.waterQuads})`);
    }
    ref.held.clear();
    checked++;
  }
  const mainEdits = JSON.stringify([...world.edits].map(([k, m]) => [k, [...m].sort((a, b) => a[0] - b[0])]).sort());
  const workerEdits = JSON.stringify([...svc.edits].map(([k, m]) => [`${Math.floor(k / (1 << 21)) - (1 << 20)},${(k % (1 << 21)) - (1 << 20)}`, [...m].sort((a, b) => a[0] - b[0])]).filter(([, l]) => l.length).sort());
  if (mainEdits !== workerEdits) fail(`${tag}: main and worker disagree on the edits`);
  console.log(`${tag}: ${checked} chunks checked, ${[...world.edits.values()].reduce((n, m) => n + m.size, 0)} edits, ${svc.stats.meshed} meshes, ${svc.stats.evicted} evictions`);
}

for (let i = 0; i < RUNS; i++) run(SEED0 + i);
console.log(failures ? `world-sync: FAILED (${failures})` : 'world-sync: PASSED');
process.exit(failures ? 1 : 0);
