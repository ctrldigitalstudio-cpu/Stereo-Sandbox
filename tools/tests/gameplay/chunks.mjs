#!/usr/bin/env node
// Edits at chunk borders in the real game: after each phase the mesh the game holds for every chunk
// around the edits (faces and baked light) must equal a mesh built from scratch in the page with
// the same seed + edits (src/worker.js WorldService imported directly), the main-thread block copy
// must match, and the GPU chunk set must match the world's.
//   phase 1: glowstone / torch / pillar / holes / water on and around a chunk corner
//   phase 2: fly far away (chunks unload, the worker evicts their neighbours) and come back
//   phase 3: edit, then leave immediately (edit racing the unload), come back
//   phase 4: reload the page (pagehide save) and compare again
//   node tools/tests/gameplay/chunks.mjs

import { startServer, launch, newGamePage, waitReady, reporter, sleep, frames, LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY } from './lib.mjs';
import { B } from '../../../src/blocks.js';

const { log, check, finish } = reporter('chunks');
const server = await startServer();
const browser = await launch();
// Record every mesh the game uploads, from the very first one: hook window.__game as main.js
// assigns it (before any worker message can be delivered).
const recordMeshes = () => {
  window.__meshLog = new Map();   // key -> last mesh uploaded
  window.__lastMeshT = performance.now();
  let game;
  Object.defineProperty(window, '__game', {
    configurable: true,
    get: () => game,
    set: (g) => {
      game = g;
      const w = g.world, orig = w.onMesh;
      w.onMesh = (cx, cz, msg) => {
        window.__meshLog.set(`${cx},${cz}`, { opaque: msg.opaque.slice(), water: msg.water.slice(), oq: msg.opaqueQuads, wq: msg.waterQuads });
        window.__lastMeshT = performance.now();
        orig(cx, cz, msg);
      };
    },
  });
};
const { page, errors } = await newGamePage(browser, { width: 400, height: 240, init: recordMeshes, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 12345 } } });

async function boot() {
  await waitReady(page, 2);
  await page.evaluate(() => window.__game.setRender(false));
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
  await page.click('.btn-play');
  await page.waitForFunction(() => window.__game.state === 'playing');
}

// Wait until chunks around the player are in and the worker has gone quiet.
async function quiesce(radius = 3) {
  await frames(page, 3);   // let world.update() see a teleport first
  await page.waitForFunction((r) => window.__game.loaded(r) >= 1, radius, { polling: 100, timeout: 300000 });
  await page.waitForFunction(() => performance.now() - window.__lastMeshT > 1500, null, { polling: 100, timeout: 300000 });
}

// Compare the game's meshes for the given chunks with meshes built from scratch in the page.
async function compare(tag, chunks) {
  const r = await page.evaluate(async (chunks) => {
    const g = window.__game, w = g.world;
    const { WorldService } = await import('/src/worker.js');
    const edits = [];
    for (const [k, m] of w.edits) edits.push([k, [...m]]);
    const posts = [];
    const ref = new WorldService({ post: (m) => posts.push(m), schedule: () => {} });
    ref.handle({ type: 'init', seed: w.seed, faceLayers: g.renderer.textureSet.faceLayers, edits });
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const out = [];
    for (const [cx, cz] of chunks) {
      const key = `${cx},${cz}`;
      posts.length = 0;
      ref.held.clear();
      ref.handle({ type: 'want', keys: [[cx, cz]] });
      ref.drain();
      const want = posts.find((m) => m.type === 'mesh');
      const got = window.__meshLog.get(key);
      const held = w.chunks.get(key);
      out.push({
        key,
        meshOk: !!got && got.oq === want.opaqueQuads && got.wq === want.waterQuads && same(got.opaque, want.opaque) && same(got.water, want.water),
        blocksOk: !!held && same(held.blocks, want.blocks),
        gpu: g.renderer.terrain.chunks.has(key),
        quads: got ? [got.oq, got.wq] : null, fresh: [want.opaqueQuads, want.waterQuads],
      });
    }
    const worldKeys = [...w.chunks.keys()].sort().join(' ');
    const gpuKeys = [...g.renderer.terrain.chunks.keys()].sort().join(' ');
    return { out, gpuMatches: worldKeys === gpuKeys, nWorld: w.chunks.size, nGpu: g.renderer.terrain.chunks.size };
  }, chunks);
  const bad = r.out.filter((c) => !c.meshOk || !c.blocksOk || !c.gpu);
  check(bad.length === 0, `${tag}: ${r.out.length} chunks re-meshed exactly (faces + light) ${bad.length ? JSON.stringify(bad) : ''}`);
  check(r.gpuMatches, `${tag}: GPU chunk set == world chunk set (${r.nWorld} / ${r.nGpu})`);
}

await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await boot();
await quiesce();
const S = await page.evaluate(() => {
  const g = window.__game, s = g.gen.findSpawn();
  const scx = Math.floor(s.x / 16), scz = Math.floor(s.z / 16);
  return { scx, scz, bx: (scx + 1) * 16, bz: (scz + 1) * 16, spawn: [s.x, s.y, s.z] };
});
const around = [];
for (let dz = -1; dz <= 2; dz++) for (let dx = -1; dx <= 2; dx++) around.push([S.scx + dx, S.scz + dz]);
log(`border corner at x=${S.bx}, z=${S.bz}; checking ${around.length} chunks`);

// Phase 1: edits on and around the corner of four chunks.
await page.evaluate(({ bx, bz, B }) => {
  const w = window.__game.world;
  const top = (x, z) => { let y = 127; while (y > 0 && w.getBlock(x, y, z) === 0) y--; return y; };
  const put = (x, y, z, id) => w.setBlock(x, y, z, id);
  let h = top(bx - 1, bz - 1);
  put(bx - 1, h + 1, bz - 1, B.GLOWSTONE);                       // light into three neighbours
  h = top(bx, bz + 3);
  put(bx, h, bz + 3, 0); put(bx, h - 1, bz + 3, 0);              // hole on the +x side exposes -x faces
  put(bx, h - 2, bz + 3, B.TORCH);
  h = top(bx - 1, bz + 6);
  for (let y = h + 1; y <= h + 6; y++) put(bx - 1, y, bz + 6, B.STONE);   // pillar shading +x
  for (let dx = -3; dx <= 2; dx++) put(bx + dx, top(bx + dx, bz - 4) + 4, bz - 4, B.OAK_PLANKS);   // bridge across the border
  h = top(bx + 2, bz);
  put(bx + 2, h, bz, B.WATER);                                   // water on the -z edge of a chunk
  put(bx - 1, top(bx - 1, bz - 8), bz - 8, B.GLASS);
  put(bx, top(bx, bz - 8) + 1, bz - 8, B.SEA_LANTERN);
}, { ...S, B: { GLOWSTONE: B.GLOWSTONE, TORCH: B.TORCH, STONE: B.STONE, OAK_PLANKS: B.OAK_PLANKS, WATER: B.WATER, GLASS: B.GLASS, SEA_LANTERN: B.SEA_LANTERN } });
await quiesce();
await compare('edits at a chunk corner', around);

// Phase 2: fly far away (everything unloads) and come back.
const far = [S.spawn[0] + 16 * 24, 110, S.spawn[2]];
await page.evaluate((p) => window.__game.teleport(p[0], p[1], p[2], 0, 0), far);
await page.waitForFunction(({ scx, scz }) => !window.__game.world.chunks.has(`${scx},${scz}`), S, { polling: 100 });
await quiesce();
const away = await page.evaluate(({ scx, scz }) => ({ gpu: window.__game.renderer.terrain.chunks.has(`${scx},${scz}`), world: window.__game.world.chunks.size }), S);
check(!away.gpu, `far away: the old chunks are unloaded from the GPU too (${away.world} chunks held)`);
await page.evaluate((s) => window.__game.teleport(s.spawn[0], s.spawn[1] + 30, s.spawn[2], 0, 0), S);
await quiesce();
await compare('after flying away and back', around);

// Phase 3: edits racing an unload: edit, leave in the same frame, return.
await page.evaluate(({ bx, bz, far, B }) => {
  const g = window.__game, w = g.world;
  const top = (x, z) => { let y = 127; while (y > 0 && w.getBlock(x, y, z) === 0) y--; return y; };
  w.setBlock(bx - 1, top(bx - 1, bz + 1) + 1, bz + 1, B.GLOWSTONE);
  w.setBlock(bx, top(bx, bz - 1), bz - 1, 0);
  g.teleport(far[0], far[1], far[2], 0, 0);
}, { ...S, far, B: { GLOWSTONE: B.GLOWSTONE } });
await sleep(300);
await page.evaluate((s) => window.__game.teleport(s.spawn[0], s.spawn[1] + 30, s.spawn[2], 0, 0), S);
await sleep(200);
await page.evaluate((p) => window.__game.teleport(p[0], p[1], p[2], 0, 0), far);
await sleep(150);
await page.evaluate((s) => window.__game.teleport(s.spawn[0], s.spawn[1] + 30, s.spawn[2], 0, 0), S);
await quiesce();
await compare('edits racing an unload, bouncing in and out of range', around);

// Phase 4: reload (pagehide saves), compare again.
const editCount = await page.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
await page.reload({ waitUntil: 'load' });
await boot();
await page.evaluate((s) => window.__game.teleport(s.spawn[0], s.spawn[1] + 30, s.spawn[2], 0, 0), S);
await quiesce();
const editCount2 = await page.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
check(editCount2 === editCount, `reload: ${editCount2} edits restored (${editCount} before)`);
await compare('after a reload', around);

check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
server.close();
process.exit(finish());
