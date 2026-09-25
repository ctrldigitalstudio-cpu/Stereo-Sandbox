#!/usr/bin/env node
// The title screen's drifting camera must never sit inside terrain, trees or water, for several
// seeds and for saved games that were left underground, high in the air or on a mountain.
// Samples the whole path (window.__game.titleCameraAt) over 25 minutes against the loaded world,
// with a small box around the eye for the near plane.
//   node tools/tests/gameplay/titlecam.mjs

import { startServer, launch, newGamePage, reporter, LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY } from './lib.mjs';
import { WorldGen } from '../../../src/worldgen.js';

const { log, check, finish } = reporter('titlecam');
const server = await startServer();
const browser = await launch();
// No drawing needed: hook window.__game as it is assigned and switch rendering off.
const noRender = () => {
  let game;
  Object.defineProperty(window, '__game', { configurable: true, get: () => game, set: (g) => { game = g; g.setRender(false); } });
};

function mountainNear(gen, x0, z0) {
  let best = null;
  for (let r = 0; r < 1500; r += 24) {
    for (let a = 0; a < 16; a++) {
      const x = Math.round(x0 + Math.cos(a * Math.PI / 8) * r), z = Math.round(z0 + Math.sin(a * Math.PI / 8) * r);
      const h = gen.heightAt(x, z);
      if (!best || h > best.h) best = { x, z, h };
    }
    if (best && best.h > 100) break;
  }
  return best;
}

const cases = [];
for (const seed of [12345, 1, 2024, 777777, 987654321, 42]) cases.push({ name: `seed ${seed}`, save: { seed } });
{
  const gen = new WorldGen(12345), s = gen.findSpawn();
  cases.push({ name: 'saved in a cave', save: { seed: 12345, player: { x: s.x, y: 20, z: s.z, yaw: 0, pitch: 0 } } });
  cases.push({ name: 'saved flying high', save: { seed: 12345, player: { x: s.x + 40, y: 150, z: s.z, yaw: 0, pitch: 0, flying: true } } });
  const m = mountainNear(gen, s.x, s.z);
  log(`mountain for seed 12345 at ${m.x}, ${m.z} (height ${m.h})`);
  cases.push({ name: `saved on a mountain (h ${m.h})`, save: { seed: 12345, player: { x: m.x + 0.5, y: m.h + 1, z: m.z + 0.5, yaw: 0, pitch: 0 } } });
}

for (const c of cases) {
  const { page, ctx, errors } = await newGamePage(browser, { width: 320, height: 180, init: noRender, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: c.save } });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.loaded(4) >= 1, null, { timeout: 300000, polling: 200 });
  const r = await page.evaluate(() => {
    const g = window.__game, w = g.world;
    const bad = [];
    let minClear = Infinity, unloaded = 0;
    for (let t = 0; t <= 1500; t += 0.5) {
      const { pos } = g.titleCameraAt(t);
      for (const [ox, oy, oz] of [[0, 0, 0], [0.2, 0.2, 0.2], [-0.2, 0.2, -0.2], [0.2, -0.2, -0.2], [-0.2, -0.2, 0.2]]) {
        const id = w.getBlock(pos[0] + ox, pos[1] + oy, pos[2] + oz);
        if (id < 0) { unloaded++; continue; }
        if (id !== 0) { bad.push([t, pos.map((v) => +v.toFixed(2)), id]); break; }
      }
      // Clearance above the ground straight below the eye.
      let y = Math.floor(pos[1]);
      while (y > 0 && w.getBlock(pos[0], y, pos[2]) === 0) y--;
      minClear = Math.min(minClear, pos[1] - (y + 1));
    }
    const cam = g.camera;
    return { bad: bad.slice(0, 5), nBad: bad.length, minClear, unloaded, start: g.titleCameraAt(0).pos.map((v) => +v.toFixed(1)), state: g.state };
  });
  check(r.nBad === 0 && r.unloaded === 0, `${c.name}: camera path stays in open air (start ${r.start}, min clearance ${r.minClear.toFixed(1)} blocks${r.nBad ? `, inside blocks: ${JSON.stringify(r.bad)}` : ''}${r.unloaded ? `, ${r.unloaded} unloaded samples` : ''})`);
  check(r.minClear > 1.5, `${c.name}: never skims the ground or treetops (${r.minClear.toFixed(1)} blocks)`);
  check(errors.length === 0, `${c.name}: no page errors ${errors.slice(0, 2).join(' | ')}`);
  await ctx.close();
}

await browser.close();
server.close();
process.exit(finish());
