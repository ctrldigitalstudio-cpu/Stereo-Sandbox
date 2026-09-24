// Worker protocol tests (WorldService driven directly, fake postMessage).
//   node --import ./tools/tests/mesher/stub-worldgen-hook.mjs tools/tests/mesher/worker.test.mjs
import { WorldService, chunkKey, keyCX, keyCZ } from '../../../src/worker.js';
import { WorldGen as SynthGen } from './synth-worldgen.js';
import { B, NUM_BLOCKS } from '../../../src/blocks.js';

let failures = 0, passes = 0;
const check = (c, m) => { if (c) passes++; else { failures++; console.log('FAIL:', m); } };
const eq = (a, b, m) => check(a === b, `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (n) => console.log(`- ${n}`);

// Manual scheduler: tasks run only when the test says so.
function manualScheduler() {
  const q = [];
  const s = (f) => q.push(f);
  s.run = (n = Infinity) => { let k = 0; while (q.length && k < n) { q.shift()(); k++; } return k; };
  s.size = () => q.length;
  return s;
}

function makeService(opts = {}) {
  const posts = [];
  const sched = manualScheduler();
  const svc = new WorldService({
    post: (msg, transfer) => {
      if (msg.type === 'mesh') {
        // Must be transferable exactly as given (no duplicate / foreign buffers).
        const clone = structuredClone(msg, { transfer });
        check(msg.blocks.byteLength === 0 && msg.opaque.byteLength === 0, 'buffers detached by transfer');
        posts.push(clone);
      } else posts.push(msg);
    },
    schedule: sched,
    createGenerator: opts.createGenerator || ((seed) => new SynthGen(seed)),
  });
  return { svc, posts, sched };
}
const meshes = (posts) => posts.filter((p) => p.type === 'mesh').map((p) => `${p.cx},${p.cz}`);
const idxOf = (x, y, z) => (x & 15) | ((z & 15) << 4) | (y << 8);
const LAYERS = new Uint16Array(NUM_BLOCKS * 6);

section('chunk keys');
for (const [cx, cz] of [[0, 0], [-1, -1], [12345, -54321], [-1048576, 1048575]]) {
  const k = chunkKey(cx, cz);
  check(keyCX(k) === cx && keyCZ(k) === cz, `key round-trip ${cx},${cz}`);
}

section('init / ready / want / mesh messages');
{
  const { svc, posts, sched } = makeService();
  const editIdx = idxOf(3, 100, 4);
  svc.handle({ type: 'init', seed: 42, faceLayers: LAYERS, edits: [['0,0', [[editIdx, B.GLOWSTONE]]], ['-2,5', [[0, B.STONE]]]] });
  eq(posts.length, 1, 'ready posted synchronously');
  eq(posts[0].type, 'ready', 'ready message');
  svc.handle({ type: 'want', keys: [[0, 0], [1, 0]] });
  const trace = [];
  while (sched.size()) {
    const gb = svc.stats.generated, mb = meshes(posts).length;
    sched.run(1);
    trace.push(svc.stats.generated > gb ? 'g' : meshes(posts).length > mb ? 'm' : '?');
  }
  eq(trace.join(''), 'gggggggggmgggm', 'one chunk generated or meshed per task');
  eq(meshes(posts).join(' '), '0,0 1,0', 'mesh order follows want order');
  const m = posts[1];
  check(m.blocks instanceof Uint8Array && m.blocks.length === 32768, 'blocks copy');
  check(m.opaque instanceof Uint32Array && m.water instanceof Uint32Array, 'packed arrays');
  eq(m.opaque.length, m.opaqueQuads * 16, 'opaque words = quads * 16');
  eq(m.water.length, m.waterQuads * 16, 'water words = quads * 16');
  check(Number.isInteger(m.minY) && Number.isInteger(m.maxY) && m.maxY > m.minY, 'minY/maxY');
  eq(m.blocks[editIdx], B.GLOWSTONE, 'init edit applied on generation');
  check(svc.chunks.get(chunkKey(0, 0)).blocks !== m.blocks, 'blocks is a copy');
  eq(svc.chunks.get(chunkKey(0, 0)).blocks[editIdx], B.GLOWSTONE, 'worker keeps its copy');
  check(svc.chunks.get(chunkKey(0, 0)).edited, 'chunk with init edits marked edited');
  eq(svc.held.size, 2, 'held after meshing');

  section('want skips held chunks; replaces the queue');
  svc.handle({ type: 'want', keys: [[0, 0], [1, 0]] });
  sched.run();
  eq(meshes(posts).length, 2, 'no remesh for held chunks');
  svc.handle({ type: 'want', keys: [[5, 5], [6, 5]] });
  sched.run(1);
  svc.handle({ type: 'want', keys: [[0, 1]] });
  sched.run();
  eq(meshes(posts).slice(2).join(' '), '0,1', 'new want replaces pending queue');

  section('set: apply, record, remesh containing chunk first then held neighbours, before queued work');
  posts.length = 0;
  // Held: 0,0 1,0 0,1. Edit in chunk 0,0 at local (1, 100, 1): inside the regions of 1,0 and 0,1
  // (both held) and -1,0 / -1,-1 etc. (not held).
  svc.handle({ type: 'want', keys: [[3, 3], [4, 4]] });
  svc.handle({ type: 'set', x: 1, y: 100, z: 1, id: B.STONE });
  svc.handle({ type: 'want', keys: [[3, 3], [4, 4]] }); // a later want must not drop the remeshes
  let n = 0;
  while (meshes(posts).length < 3 && n++ < 100) sched.run(1);
  eq(meshes(posts).join(' '), '0,0 1,0 0,1', 'remesh order: containing chunk, then held neighbours');
  eq(svc.stats.generated >= 0, true, 'ok');
  eq(posts[0].blocks[idxOf(1, 100, 1)], B.STONE, 'edit visible in remeshed chunk data');
  eq(svc.edits.get(chunkKey(0, 0)).get(idxOf(1, 100, 1)), B.STONE, 'edit recorded');

  section('set coalescing + region test');
  sched.run();
  posts.length = 0;
  svc.handle({ type: 'set', x: 5, y: 90, z: 5, id: B.GLASS });
  svc.handle({ type: 'set', x: 6, y: 90, z: 5, id: B.GLASS });
  svc.handle({ type: 'set', x: 7, y: 90, z: 5, id: B.GLASS });
  sched.run();
  eq(meshes(posts).filter((k) => k === '0,0').length, 1, 'three edits in one chunk -> one remesh');
  posts.length = 0;
  // x = 0 is outside 1,0's lit region (it starts at x = 1): only 0,0 remeshes.
  svc.handle({ type: 'set', x: 0, y: 90, z: 8, id: B.GLASS });
  sched.run();
  eq(meshes(posts).join(' '), '0,0 0,1', 'edit at x=0 does not touch chunk 1,0 (0,1 is held and its region contains it)');
  posts.length = 0;
  // Edit in a chunk main doesn't hold: only held neighbours whose region contains it.
  svc.handle({ type: 'set', x: -1, y: 90, z: 3, id: B.GLASS });
  sched.run();
  eq(meshes(posts).join(' '), '0,0 0,1', 'edit in unheld chunk remeshes held neighbours only');
  eq(svc.chunks.get(chunkKey(-1, 0)).blocks[idxOf(-1, 90, 3)], B.GLASS, 'edit applied to unheld loaded chunk');
  posts.length = 0;
  svc.handle({ type: 'set', x: 500, y: 90, z: 500, id: B.GLASS });
  sched.run();
  eq(meshes(posts).length, 0, 'edit far away: nothing to remesh');
  eq(svc.edits.get(chunkKey(31, 31)).get(idxOf(500, 90, 500)), B.GLASS, 'far edit recorded');
  svc.handle({ type: 'set', x: 1, y: 128, z: 1, id: B.GLASS });
  svc.handle({ type: 'set', x: 1, y: -1, z: 1, id: B.GLASS });
  eq(svc.urgent.length, 0, 'out-of-range y ignored');

  section('unload + eviction + regeneration keeps edits');
  posts.length = 0;
  svc.handle({ type: 'want', keys: [[40, 40]] });
  svc.handle({ type: 'unload', keys: [[0, 0], [1, 0], [0, 1], [3, 3], [4, 4]] });
  eq(svc.held.size, 0, 'unload forgets held chunks');
  const near = [...svc.chunks.values()].filter((c) => Math.abs(c.cx) < 10 && Math.abs(c.cz) < 10);
  check(near.every((c) => c.edited), `only edited chunks survive near the origin (${near.map((c) => `${c.cx},${c.cz}${c.edited ? '*' : ''}`).join(' ')})`);
  check(near.length >= 2, 'edited chunks kept');
  svc.handle({ type: 'want', keys: [[0, 0]] });
  sched.run();
  const again = posts.filter((p) => p.type === 'mesh' && p.cx === 0 && p.cz === 0)[0];
  check(!!again, 'unloaded chunk remeshed when wanted again');
  if (again) {
    eq(again.blocks[idxOf(1, 100, 1)], B.STONE, 'edit survives');
    eq(again.blocks[editIdx], B.GLOWSTONE, 'init edit survives');
  }
  // Force-evict an edited chunk and regenerate it: edits come back from the edit log.
  svc.chunks.delete(chunkKey(0, 0));
  svc.held.delete(chunkKey(0, 0));
  svc.handle({ type: 'want', keys: [[0, 0]] });
  sched.run();
  const regen = posts.filter((p) => p.type === 'mesh' && p.cx === 0 && p.cz === 0).pop();
  eq(regen.blocks[idxOf(1, 100, 1)], B.STONE, 'edit re-applied after regeneration');
  eq(regen.blocks[idxOf(7, 90, 5)], B.GLASS, 'later edit re-applied after regeneration');
  const genChunks = svc.chunks.size;
  check(genChunks < 40, `memory bounded (${genChunks} chunks kept)`);
}

section('generator errors drop the job, the loop continues');
{
  const { svc, posts, sched } = makeService({
    createGenerator: (seed) => {
      const g = new SynthGen(seed);
      return { generateChunk: (cx, cz) => { if (cx === 99) throw new Error('boom'); return g.generateChunk(cx, cz); } };
    },
  });
  const err = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  svc.handle({ type: 'init', seed: 1, faceLayers: LAYERS, edits: [] });
  svc.handle({ type: 'want', keys: [[98, 0], [0, 0]] });
  sched.run();
  console.error = err;
  eq(meshes(posts).join(' '), '0,0', 'failing chunk skipped, next one meshed');
  check(logged === 1, 'error logged once');
}

// Node drains up to 1000 MessagePort messages per event-loop turn (starving timers), so the async
// test uses setImmediate here; the browser test (page.html) checks the real MessageChannel scheduler.
section('async scheduler interleaves incoming messages');
{
  const posts = [];
  const svc = new WorldService({ post: (m) => posts.push(m), createGenerator: (s) => new SynthGen(s), schedule: (f) => setImmediate(f) });
  svc.handle({ type: 'init', seed: 3, faceLayers: LAYERS, edits: [] });
  const keys = [];
  for (let r = 0; r <= 2; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) keys.push([dx, dz]);
  let setAt = -1, heldAtSet = [];
  const orig = svc.post;
  svc.post = (m, t) => {
    orig(m, t);
    if (m.type === 'mesh' && meshes(posts).length === 2) {
      // Like a message from the main thread arriving while the worker is busy.
      setTimeout(() => {
        setAt = meshes(posts).length;
        heldAtSet = [...svc.held].map((k) => `${keyCX(k)},${keyCZ(k)}`);
        svc.handle({ type: 'set', x: 2, y: 100, z: 2, id: B.STONE });
      }, 0);
    }
  };
  const t0 = performance.now();
  svc.handle({ type: 'want', keys });
  await new Promise((resolve) => {
    const poll = () => (svc.held.size === keys.length && !svc.hasWork() ? resolve() : setTimeout(poll, 5));
    poll();
  });
  const list = meshes(posts);
  console.log(`    ${keys.length} chunks in ${(performance.now() - t0).toFixed(0)} ms; set handled after mesh #${setAt}`);
  check(setAt >= 2 && setAt < 6, `set handled promptly (after ${setAt} meshes)`);
  eq(list[setAt], '0,0', 'containing chunk remeshed right after the set');
  const remeshed = list.slice(setAt + 1, setAt + heldAtSet.length).sort().join(' ');
  eq(remeshed, heldAtSet.filter((k) => k !== '0,0').sort().join(' '), 'then the held neighbours');
  eq(new Set(list).size, keys.length, 'every wanted chunk meshed');
  eq(list.length, keys.length + heldAtSet.length, 'no extra meshes');
}

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
