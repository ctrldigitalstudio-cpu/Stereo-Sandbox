// Review harness: main-thread World + WorldService connected through a simulated event loop with
// message latency and per-task worker cost. Random movement across chunk borders + random edits,
// then quiesce and check main/worker/renderer consistency.
//   node tools/tests/review/sim.mjs [seed] [steps]
import { WorldService, chunkKey } from '../../../src/worker.js';
import { meshChunk } from '../../../src/mesher.js';
import { B, NUM_BLOCKS } from '../../../src/blocks.js';
import { mulberry32 } from '../../../src/noise.js';

const SEED = Number(process.argv[2] || 1), STEPS = Number(process.argv[3] || 3000);
const rnd = mulberry32(SEED);
let now = 0;
Object.defineProperty(performance, 'now', { value: () => now, configurable: true });

// --- discrete event loop -------------------------------------------------------------------
const events = []; let seq = 0;
const at = (t, fn) => { events.push({ t, s: seq++, fn }); };
function runUntil(tEnd) {
  for (;;) {
    let bi = -1;
    for (let i = 0; i < events.length; i++) if (events[i].t <= tEnd && (bi < 0 || events[i].t < events[bi].t || (events[i].t === events[bi].t && events[i].s < events[bi].s))) bi = i;
    if (bi < 0) break;
    const e = events.splice(bi, 1)[0];
    now = Math.max(now, e.t);
    e.fn();
  }
  now = Math.max(now, tEnd);
}

// Worker thread: a FIFO of tasks (incoming messages + scheduled steps), each costing time.
const LAT = () => 0.2 + rnd() * 3;            // message latency ms
const workerQ = []; let workerBusyUntil = 0; let workerPumping = false;
function workerEnqueue(task) { workerQ.push(task); pumpWorker(); }
function pumpWorker() {
  if (workerPumping || !workerQ.length) return;
  workerPumping = true;
  at(Math.max(now, workerBusyUntil), () => {
    workerPumping = false;
    const task = workerQ.shift();
    const cost = task();
    workerBusyUntil = now + (cost || 0.05);
    pumpWorker();
  });
}
let svc;
const lastMesh = new Map();   // renderer view: key -> mesh
globalThis.Worker = class {
  constructor() {
    svc = new WorldService({
      post: (msg, transfer) => {
        const clone = structuredClone(msg, { transfer: transfer || [] });
        at(now + LAT(), () => this.onmessage && this.onmessage({ data: clone }));
      },
      schedule: (fn) => workerEnqueue(() => { const g = svc.stats.generated, m = svc.stats.meshed; fn(); return svc.stats.generated > g ? 4 : svc.stats.meshed > m ? 7 : 0.05; }),
    });
  }
  postMessage(msg) {
    const clone = structuredClone(msg);
    at(now + LAT(), () => workerEnqueue(() => { svc.handle(clone); return 0.05; }));
  }
  terminate() {}
};
const { World } = await import('../../../src/world.js');

const LAYERS = new Uint16Array(NUM_BLOCKS * 6);
const world = new World({
  seed: 12345, faceLayers: LAYERS, edits: new Map(),
  onMesh: (cx, cz, msg) => lastMesh.set(`${cx},${cz}`, msg),
  onUnload: (cx, cz) => lastMesh.delete(`${cx},${cz}`),
});
const RD = 3;
let px = 8, pz = 8;
let edits = 0, editsRejected = 0;
const PLACE = [B.STONE, B.GLOWSTONE, B.AIR, B.GLASS, B.TORCH, B.AIR, B.AIR];
for (let step = 0; step < STEPS; step++) {
  runUntil(now + 16);
  // Walk mostly back and forth across chunk borders, sometimes jump far.
  const r = rnd();
  if (r < 0.02) { px += (rnd() - 0.5) * 120; pz += (rnd() - 0.5) * 120; }
  else { px += (rnd() - 0.5) * 6; pz += (rnd() - 0.5) * 6; }
  world.update(px, pz, RD, rnd() - 0.5, rnd() - 0.5);
  if (rnd() < 0.3) {
    const x = Math.floor(px + (rnd() - 0.5) * 40), z = Math.floor(pz + (rnd() - 0.5) * 40), y = 30 + Math.floor(rnd() * 60);
    const ok = world.setBlock(x, y, z, PLACE[(rnd() * PLACE.length) | 0]);
    if (ok) edits++; else editsRejected++;
  }
}
// Quiesce: stop editing, keep calling update at the final position until everything settles.
for (let i = 0; i < 4000; i++) { runUntil(now + 16); world.update(px, pz, RD, 0, 1); if (!events.length && world.loadedFraction(RD) >= 1 && i > 200) break; }
runUntil(now + 100000);

// --- invariants ------------------------------------------------------------------------------
let blockDiff = 0, staleMesh = 0, heldDiff = 0, missingMesh = 0, extraMesh = 0, examples = [];
const mainKeys = new Set(world.chunks.keys());
for (const [key, c] of world.chunks) {
  const k = chunkKey(c.cx, c.cz);
  if (!svc.held.has(k)) { heldDiff++; if (examples.length < 6) examples.push(`main holds ${key}, worker not`); }
  // Worker's authoritative data (generate if evicted).
  let wc = svc.chunks.get(k);
  if (!wc) { svc._generate(c.cx, c.cz); wc = svc.chunks.get(k); }
  let d = 0; for (let i = 0; i < 32768; i++) if (wc.blocks[i] !== c.blocks[i]) d++;
  if (d) { blockDiff++; if (examples.length < 6) examples.push(`${key}: ${d} blocks differ main vs worker`); }
  const m = lastMesh.get(key);
  if (!m) { missingMesh++; continue; }
  // Fresh mesh from the worker's current data.
  const nb = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    let n = svc.chunks.get(chunkKey(c.cx + dx, c.cz + dz));
    if (!n) { svc._generate(c.cx + dx, c.cz + dz); n = svc.chunks.get(chunkKey(c.cx + dx, c.cz + dz)); }
    nb.push(n);
  }
  const fresh = meshChunk(nb, LAYERS, c.cx, c.cz);
  const same = fresh.opaque.length === m.opaque.length && fresh.opaque.every((v, i) => v === m.opaque[i]) && fresh.water.length === m.water.length;
  if (!same) { staleMesh++; if (examples.length < 6) examples.push(`${key}: stale mesh`); }
}
for (const k of svc.held) { const cx = Math.floor(k / 2 ** 21) - 2 ** 20, cz = (k % 2 ** 21) - 2 ** 20; if (!mainKeys.has(`${cx},${cz}`)) { heldDiff++; if (examples.length < 6) examples.push(`worker thinks main holds ${cx},${cz}`); } }
for (const key of lastMesh.keys()) if (!mainKeys.has(key)) extraMesh++;
console.log(JSON.stringify({ seed: SEED, edits, editsRejected, mainChunks: mainKeys.size, workerChunks: svc.chunks.size, held: svc.held.size, blockDiff, staleMesh, heldDiff, missingMesh, extraMesh, stats: svc.stats }));
if (examples.length) console.log(examples.join('\n'));
