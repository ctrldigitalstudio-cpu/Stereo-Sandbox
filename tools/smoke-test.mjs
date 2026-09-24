#!/usr/bin/env node
// End-to-end smoke test in headless Chromium (SwiftShader). Boots the game in test mode,
// waits for terrain, then captures screenshots of several scenes and fails on any page error.
//
//   node tools/smoke-test.mjs [--dist] [--size 960x540] [--only name,name] [--out tools/out] [--ui]
// --ui: capture scenes with the HTML UI (page screenshots) instead of canvas grabs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from './static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const useDist = args.includes('--dist');
const [W, H] = opt('size', '960x540').split('x').map(Number);
const only = opt('only', null)?.split(',');
const outDir = path.resolve(root, opt('out', 'tools/out'));
fs.mkdirSync(outDir, { recursive: true });

const server = await startStaticServer(root);
const url = `http://127.0.0.1:${server.address().port}/${useDist ? 'dist/index.html' : 'index.html'}?test`;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
// External font requests can't leave this sandbox; they are optional (fallback stacks).
const external = (text) => /fonts\.(googleapis|gstatic)\.com|net::ERR_/.test(text);
page.on('console', (m) => {
  if (m.type() === 'error' && !external(m.text() + ' ' + (m.location()?.url || ''))) errors.push(m.text());
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text().slice(0, 2000)}`);
});
page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
log(`open ${url}`);
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
log('game object ready; waiting for terrain');
await page.waitForFunction(() => window.__game.loaded(3) >= 1, null, { timeout: 600000, polling: 500 });
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
await frames(20);
log('terrain loaded');

const want = (name) => !only || only.includes(name);

// Software GL can make a single frame take seconds, so page screenshots may time out; the
// canvas grab (read back right after a frame) always works but omits the HTML UI.
async function shoot(file, withUI) {
  if (withUI) {
    try {
      await page.screenshot({ path: file, timeout: 180000 });
      return;
    } catch (e) {
      console.log(`[smoke] page screenshot failed (${e.message.split('\n')[0]}), using canvas grab`);
    }
  }
  const url = await page.evaluate(() => window.__game.capture());
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
}
if (want('title')) {
  await shoot(path.join(outDir, 'smoke-title.png'), true);
  log('title screenshot');
}

await page.evaluate(() => window.__game.play());
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());

// Find some ocean nearby for the water shots.
const shore = await page.evaluate(({ x, z }) => {
  const g = window.__game.gen;
  for (let r = 16; r < 900; r += 16) {
    for (let a = 0; a < 32; a++) {
      const px = Math.round(x + Math.cos(a / 32 * Math.PI * 2) * r), pz = Math.round(z + Math.sin(a / 32 * Math.PI * 2) * r);
      if (g.heightAt(px, pz) < 44) return { x: px, z: pz };
    }
  }
  return null;
}, spawn);

const scenes = [
  { name: 'noon', time: 0.25, pos: [spawn.x, spawn.y + 22, spawn.z], yaw: 0.6, pitch: -0.3 },
  { name: 'afternoon', time: 0.41, pos: [spawn.x, spawn.y + 6, spawn.z], yaw: -1.2, pitch: -0.08 },
  { name: 'sunset', time: 0.485, pos: [spawn.x, spawn.y + 12, spawn.z], yaw: -Math.PI / 2 + 0.3, pitch: 0.02 },
  { name: 'night', time: 0.78, pos: [spawn.x, spawn.y + 10, spawn.z], yaw: 0.6, pitch: 0.1 },
];
if (shore) {
  scenes.push({ name: 'water', time: 0.33, pos: [shore.x, 64, shore.z], yaw: 0.3, pitch: -0.35 });
  scenes.push({ name: 'underwater', time: 0.3, pos: [shore.x, 50, shore.z], yaw: 0.3, pitch: -0.2 });
}
scenes.push({ name: 'torches', time: 0.8, pos: [spawn.x, spawn.y + 1, spawn.z + 4], yaw: 0, pitch: -0.25, setup: Math.floor(spawn.y) });

for (const s of scenes) {
  if (!want(s.name)) continue;
  await page.evaluate((s) => {
    const g = window.__game;
    g.teleport(s.pos[0], s.pos[1], s.pos[2], s.yaw, s.pitch);
    g.setTime(s.time);
  }, s);
  await frames(3); // let world.update() see the new position before checking load state
  await page.waitForFunction(() => window.__game.loaded(3) >= 1, null, { timeout: 240000, polling: 500 });
  if (s.setup !== undefined) {
    await page.evaluate((s) => {
      const w = window.__game.world;
      const x = Math.floor(s.pos[0]), y = s.setup, z = Math.floor(s.pos[2]); // y = first air block above ground
      for (let dx = -3; dx <= 3; dx++) for (let dy = 0; dy < 4; dy++) w.setBlock(x + dx, y + dy, z - 6, 26); // brick wall
      w.setBlock(x - 2, y, z - 5, 30); // torch
      w.setBlock(x + 2, y, z - 5, 29); // glowstone
    }, s);
  }
  await frames(25);
  const file = path.join(outDir, `smoke-${s.name}.png`);
  await shoot(file, args.includes('--ui'));
  const stats = await page.evaluate(() => JSON.stringify(window.__game.renderer.stats || {}));
  log(`${s.name}: ${file} ${stats}`);
}

await browser.close();
server.close();
if (errors.length) {
  console.log(`FAILED: ${errors.length} error(s)`);
  process.exit(1);
}
console.log('PASSED');
