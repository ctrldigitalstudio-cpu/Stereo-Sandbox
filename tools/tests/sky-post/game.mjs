#!/usr/bin/env node
// Boots the real game (index.html?test) with lighter settings seeded into localStorage so frames
// are affordable under SwiftShader, then captures a few scenes through the full renderer.
//   node tools/tests/sky-post/game.mjs [--size 640x360] [--rd 4] [--shadowRes 1024] [--only a,b]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const [W, H] = opt('size', '640x360').split('x').map(Number);
const only = opt('only', null)?.split(',');
const settings = {
  preset: 'custom', renderDistance: Number(opt('rd', 4)), renderScale: 1, shadows: true,
  shadowRes: Number(opt('shadowRes', 1024)), shadowRadius: 64, pcss: true, volumetrics: 12, clouds: 10, ssr: 16,
  bloom: true, fxaa: true, autoResolution: false, dayLength: 1200, cloudCoverage: 0.5,
};

const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') { errors.push(m.text()); console.log(`[console.error] ${m.text().slice(0, 500)}`); }
});
page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });
await page.addInitScript((s) => { localStorage.setItem('stereo-sandbox.settings.v1', JSON.stringify(s)); }, settings);

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
log('game ready');
await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 900000, polling: 1000 });
log('terrain loaded');
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const shot = async (name) => {
  await frames(2);
  await page.screenshot({ path: path.join(root, `tools/out/sky-post-game-${name}.png`), timeout: 300000 });
  const st = await page.evaluate(() => JSON.stringify(window.__game.renderer.stats));
  log(`${name}: ${st}`);
};
const want = (n) => !only || only.includes(n);

if (want('title')) await shot('title');
await page.evaluate(() => window.__game.play());
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
const scenes = [
  { name: 'morning', time: 0.08, pos: [spawn.x, spawn.y + 8, spawn.z], yaw: -1.3, pitch: -0.05 },
  { name: 'noon', time: 0.25, pos: [spawn.x, spawn.y + 18, spawn.z], yaw: 0.6, pitch: -0.3 },
  { name: 'dusk', time: 0.505, pos: [spawn.x, spawn.y + 10, spawn.z], yaw: Math.PI / 2, pitch: 0.05 },
  { name: 'night', time: 0.8, pos: [spawn.x, spawn.y + 8, spawn.z], yaw: 0.6, pitch: 0.15 },
];
for (const s of scenes) {
  if (!want(s.name)) continue;
  await page.evaluate((s) => { window.__game.teleport(...s.pos, s.yaw, s.pitch); window.__game.setTime(s.time); }, s);
  await frames(2);
  await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 900000, polling: 1000 });
  await frames(6);
  await shot(s.name);
}
await browser.close();
server.close();
console.log(errors.length ? `FAILED: ${errors.length} error(s)` : 'PASSED');
process.exit(errors.length ? 1 : 0);
