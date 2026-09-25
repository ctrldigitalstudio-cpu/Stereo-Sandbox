#!/usr/bin/env node
// Review scratch (performance), read-only: main-thread cost of TerrainRenderer.edgeMap() (called
// from Renderer.render whenever a chunk mesh arrives/leaves or the camera moved > 3 blocks).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test&preset=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.evaluate(() => { window.__game.setRender(false); window.__game.play(); });
await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
const r = await page.evaluate(() => {
  const T = window.__game.renderer.terrain, cam = window.__game.camera.pos;
  if (!T.edgeMap) return 'no edgeMap';
  const time = (f, n = 1) => { const a = performance.now(); for (let i = 0; i < n; i++) f(); return +((performance.now() - a) / n).toFixed(3); };
  for (const c of T.chunks.values()) c.summary = undefined;
  const cold = time(() => { T._edgeDirty = true; T.edgeMap(cam, 146); });
  const warm = time(() => { T._edgeDirty = true; T.edgeMap(cam, 146); }, 50);
  let k = 0; for (const c of T.chunks.values()) { if (k++ < 9) c.summary = undefined; }
  const nine = time(() => { T._edgeDirty = true; T.edgeMap(cam, 146); });
  return { chunks: T.chunks.size, coldAllSummaries_ms: cold, warm_ms: warm, after9Remeshes_ms: nine };
});
console.log(JSON.stringify(r));
await browser.close(); server.close();
