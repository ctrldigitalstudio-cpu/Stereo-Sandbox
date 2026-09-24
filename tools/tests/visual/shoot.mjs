#!/usr/bin/env node
// Visual-tuning captures: boots the game (index.html?test, seed 12345) once and grabs a set of
// representative views through the full renderer into tools/out/visual-<tag>-<scene>.png.
//
//   node tools/tests/visual/shoot.mjs [--tag before] [--size 800x450] [--only a,b] [--preset high]
//        [--frames 6] [--list]
//
// Exposure is reset (snapped to its converged value) right before each grab, so a scene only
// needs enough frames for chunks to load and the eye sky light to settle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'cur');
const [W, H] = opt('size', '800x450').split('x').map(Number);
const only = opt('only', null)?.split(',');
const preset = opt('preset', null);
const settle = Number(opt('frames', 6));
const outDir = path.join(root, 'tools/out');
fs.mkdirSync(outDir, { recursive: true });

// Brick wall + torch + glowstone in front of the camera (same layout as the smoke test).
function torchWall(x, y, z) {
  const e = [];
  for (let dx = -3; dx <= 3; dx++) for (let dy = 0; dy < 4; dy++) e.push([x + dx, y + dy, z - 6, 26]);
  e.push([x - 2, y, z - 5, 30], [x + 2, y, z - 5, 29]);
  return e;
}
// A little texture test bench: glass, leaves, tall grass, flowers, planks, torch.
function bench(x, y, z) {
  const e = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -4; dz <= -2; dz++) e.push([x + dx, y - 1, z + dz, 5]); // planks floor
  e.push([x - 2, y, z - 3, 10], [x - 2, y + 1, z - 3, 10]);   // glass
  e.push([x - 1, y, z - 4, 9], [x, y, z - 4, 9], [x, y + 1, z - 4, 9]); // oak leaves
  e.push([x + 1, y, z - 3, 21], [x + 2, y, z - 3, 22], [x + 1, y, z - 2, 23]); // tall grass, poppy, dandelion
  e.push([x + 2, y, z - 4, 3], [x + 2, y + 1, z - 4, 1]);      // dirt, stone
  return e;
}

const SCENES = (sp, shore) => [
  { name: 'noon', time: 0.25, pos: [sp.x, sp.y + 22, sp.z], yaw: 0.6, pitch: -0.3 },
  { name: 'afternoon', time: 0.41, pos: [sp.x, sp.y + 6, sp.z], yaw: -1.2, pitch: -0.08 },
  { name: 'golden', time: 0.455, pos: [sp.x + 4, sp.y + 14, sp.z - 20], yaw: Math.PI / 2 + 0.5, pitch: -0.12 },
  { name: 'sunset', time: 0.485, pos: [sp.x, sp.y + 12, sp.z], yaw: -Math.PI / 2 + 0.3, pitch: 0.02 },
  { name: 'dusk', time: 0.51, pos: [sp.x, sp.y + 12, sp.z], yaw: -Math.PI / 2 + 0.3, pitch: 0.06 },
  { name: 'night', time: 0.78, pos: [sp.x, sp.y + 10, sp.z], yaw: 0.6, pitch: 0.1 },
  { name: 'overcast', time: 0.3, pos: [sp.x, sp.y + 10, sp.z], yaw: 2.2, pitch: -0.05, settings: { cloudCoverage: 0.8 } },
  { name: 'water', time: 0.33, pos: [shore.x, 64, shore.z], yaw: 0.3, pitch: -0.35 },
  { name: 'water-flat', time: 0.36, pos: [shore.x, 60, shore.z], yaw: 0.3, pitch: -0.05 },
  { name: 'underwater', time: 0.3, pos: [shore.x, 50, shore.z], yaw: 0.3, pitch: -0.2 },
  { name: 'underwater-up', time: 0.3, pos: [shore.x, 49, shore.z], yaw: 0.3, pitch: 0.7 },
  { name: 'beach-sunset', time: 0.49, pos: [59, 60, -68], yaw: 1.2, pitch: -0.05 },
  { name: 'forest', time: 0.36, pos: [15.5, 62, 28.5], yaw: 2.5, pitch: 0.05, ground: true },
  { name: 'desert', time: 0.3, pos: [19, 84, -61], yaw: 0.5, pitch: -0.15 },
  { name: 'snow', time: 0.3, pos: [334, 126, 70], yaw: 0.2, pitch: -0.2 },
  { name: 'bench', time: 0.3, pos: [sp.x, sp.y, sp.z + 4], yaw: 0, pitch: -0.35, edits: bench, ground: true },
  { name: 'torches', time: 0.8, pos: [sp.x, sp.y + 1, sp.z + 4], yaw: 0, pitch: -0.25, edits: torchWall, ground: true },
  { name: 'cave', time: 0.3, pos: [-46.5, 12.2, -34.5], yaw: 0.8, pitch: -0.35, frames: 24 },
];

const server = await startStaticServer(root);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
const external = (t) => /fonts\.(googleapis|gstatic)\.com|net::ERR_/.test(t);
page.on('console', (m) => {
  if (m.type() === 'error' && !external(m.text())) { errors.push(m.text()); console.log(`[console.error] ${m.text().slice(0, 3000)}`); }
});
page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const url = `http://127.0.0.1:${server.address().port}/index.html?test${preset ? '&preset=' + preset : ''}`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const want = (n) => !only || only.includes(n);

async function grab(name) {
  await page.evaluate(() => { window.__game.renderer.post.resetExposure = true; });
  await frames(2);
  const data = await page.evaluate(() => window.__game.capture());
  const file = path.join(outDir, `visual-${tag}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  const st = await page.evaluate(() => {
    const s = window.__game.renderer.stats;
    return `chunks ${s.chunks} quads ${s.quads} passes ${s.passes} gpuMs ${s.gpuMs.toFixed(0)}`;
  });
  log(`${name}: ${path.relative(root, file)} (${st})`);
}

if (want('title')) {
  await page.waitForFunction(() => window.__game.loaded(3) >= 1, null, { timeout: 900000, polling: 1000 });
  await frames(settle);
  await grab('title');
}
await page.evaluate(() => window.__game.play());
const sp = await page.evaluate(() => window.__game.gen.findSpawn());
const shore = await page.evaluate(({ x, z }) => {
  const g = window.__game.gen;
  for (let r = 16; r < 900; r += 16) {
    for (let a = 0; a < 32; a++) {
      const px = Math.round(x + Math.cos(a / 32 * Math.PI * 2) * r), pz = Math.round(z + Math.sin(a / 32 * Math.PI * 2) * r);
      if (g.heightAt(px, pz) < 44) return { x: px, z: pz };
    }
  }
  return { x: -176, z: -45 };
}, sp);

let lastSettings = null;
for (const s of SCENES(sp, shore)) {
  if (!want(s.name)) continue;
  const patch = { cloudCoverage: 0.45, ...(s.settings || {}) };
  const key = JSON.stringify(patch);
  await page.evaluate(({ s, patch, change }) => {
    const g = window.__game;
    if (change) g.setSettings(patch);
    let y = s.pos[1];
    if (s.ground) y = g.gen.heightAt(Math.floor(s.pos[0]), Math.floor(s.pos[2])) + 1;
    g.teleport(s.pos[0], y, s.pos[2], s.yaw, s.pitch);
    g.player.flying = true;
    g.setTime(s.time);
  }, { s, patch, change: key !== lastSettings });
  lastSettings = key;
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(3) >= 1, null, { timeout: 900000, polling: 500 });
  if (s.edits) {
    await page.evaluate(({ edits }) => {
      const g = window.__game;
      const p = g.player.pos;
      const x = Math.floor(p[0]), y = Math.floor(p[1]), z = Math.floor(p[2]);
      for (const [bx, by, bz, id] of new Function('return ' + edits)()(x, y, z)) g.world.setBlock(bx, by, bz, id);
    }, { edits: s.edits.toString() });
  }
  await frames(s.frames || settle);
  await grab(s.name);
}

await browser.close();
server.close();
console.log(errors.length ? `FAILED: ${errors.length} error(s)` : 'PASSED');
process.exit(errors.length ? 1 : 0);
