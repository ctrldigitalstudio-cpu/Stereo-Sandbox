#!/usr/bin/env node
// Review scratch (performance), read-only: after walking a few chunks, how many drawn chunks lie
// entirely beyond the distance where applyFog has fully dissolved terrain into voidColor (uCam.z)?
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test&preset=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.evaluate(() => { window.__game.setRender(false); window.__game.play(); });
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
const measure = () => page.evaluate(async () => {
  const g = window.__game, R = g.renderer, T = R.terrain, view = R.viewInfo;
  const fogEnd = Math.max(R.settings.renderDistance * 16 - 14, 24);
  const cam = view.camPos;
  const list = T._collect(view, 'opaque', false).slice();
  let beyond = 0, beyondQ = 0, q = 0;
  for (const c of list) {
    q += c.opaque.quads;
    const x0 = c.cx * 16, z0 = c.cz * 16;
    const dx = Math.max(x0 - cam[0], 0, cam[0] - (x0 + 16)), dz = Math.max(z0 - cam[2], 0, cam[2] - (z0 + 16));
    if (Math.hypot(dx, dz) >= fogEnd) { beyond++; beyondQ += c.opaque.quads; }
  }
  let loadedQ = 0; for (const c of T.chunks.values()) if (c.opaque) loadedQ += c.opaque.quads;
  return { fogEnd, loadedChunks: T.chunks.size, loadedQuads: loadedQ, drawnChunks: list.length, drawnQuads: q, drawnFullyFogged: beyond, drawnFullyFoggedQuads: beyondQ };
});
let x = spawn.x;
await page.evaluate(({ x, s }) => { const g = window.__game; g.teleport(x, s.y + 30, s.z, Math.PI / 2, -0.1); g.setTime(0.4); }, { x, s: spawn });
await frames(3);
await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
await frames(3);
await page.evaluate(() => window.__game.capture());
console.log('start', JSON.stringify(await measure()));
// Walk 3 chunks east, then turn around and look back west (yaw = -PI/2 looks toward +X; PI/2 toward -X).
for (let i = 1; i <= 3; i++) {
  x += 16;
  await page.evaluate(({ x, s }) => { window.__game.teleport(x, s.y + 30, s.z, -Math.PI / 2, -0.1); }, { x, s: spawn });
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
}
await frames(3);
await page.evaluate(() => window.__game.capture());
console.log('after walking 3 chunks east, looking east', JSON.stringify(await measure()));
await page.evaluate(() => { const g = window.__game; g.player.yaw = Math.PI / 2; });
await frames(3);
await page.evaluate(() => window.__game.capture());
console.log('same spot, looking back west', JSON.stringify(await measure()));
await browser.close();
server.close();
