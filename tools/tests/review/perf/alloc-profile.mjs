#!/usr/bin/env node
// Review scratch (performance), read-only: sampling heap profile of the main thread over N rendered
// frames of gameplay (High preset, small canvas so SwiftShader keeps up). Reports bytes allocated per
// frame by function, including objects already collected by the scavenger.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 256, height: 144 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test&preset=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.evaluate(() => { window.__game.setRender(false); window.__game.play(); });
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
await page.evaluate((s) => { const g = window.__game; g.teleport(s.x, s.y + 1, s.z, 0.6, -0.1); g.player.flying = false; g.setTime(0.4); }, spawn);
await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
await page.evaluate(() => window.__game.setRender(true));
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
await frames(3);
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.collectGarbage');
const f0 = await page.evaluate(() => window.__game.frame);
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await frames(12);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const f1 = await page.evaluate(() => window.__game.frame);
const n = f1 - f0;
const by = new Map();
let total = 0;
const walk = (node, stack) => {
  const cf = node.callFrame;
  const name = `${cf.functionName || '(anon)'} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
  if (node.selfSize) {
    total += node.selfSize;
    by.set(name, (by.get(name) || 0) + node.selfSize);
  }
  for (const c of node.children) walk(c, stack);
};
walk(profile.head, []);
console.log(`frames sampled: ${n}; approx bytes allocated per frame: ${(total / n / 1024).toFixed(1)} KB`);
[...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`${(v / n).toFixed(0).padStart(7)} B/frame  ${k}`));
await browser.close();
server.close();
