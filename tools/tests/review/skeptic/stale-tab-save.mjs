// A second instance writes a save with new edits while this instance is open; then this (stale)
// instance is closed. Does its pagehide save wipe the other instance's edits?
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const KEY = 'stereo-sandbox.save.v1';
const ready = (p) => p.waitForFunction(() => window.__game && window.__game.world && window.__game.world.loadedCount > 20, null, { timeout: 90000 });
const summary = (p) => p.evaluate((KEY) => { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && { seed: s.seed, edits: JSON.parse(s.edits).reduce((n, [, l]) => n + l.length, 0), x: s.player.x }; }, KEY);

// 1. Existing save S0 (seed a world, save on close).
const P0 = await ctx.newPage(); await P0.goto(base + 'index.html', { timeout: 90000 }); await ready(P0);
await P0.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 1500));
const probe = await ctx.newPage(); await probe.goto(base + 'package.json');
console.log('S0 on disk:', await summary(probe));

// 2. Instance A opens (loads S0) and sits at the title screen.
const A = await ctx.newPage(); await A.goto(base + 'index.html', { timeout: 90000 }); await ready(A);
console.log('S0 seen from A:', await summary(A));
console.log('A state:', await A.evaluate(() => window.__game.state), 'A edits in memory:', await A.evaluate(() => window.__game.world.edits.size));

// 3. Instance B (another tab) saves S1 = S0 + 7 new block edits (what B's saveGame would write).
await probe.evaluate((KEY) => {
  const s = JSON.parse(localStorage.getItem(KEY));
  const edits = JSON.parse(s.edits);
  edits.push(['0,0', [[1000, 1], [1001, 1], [1002, 1], [1003, 1], [1004, 1], [1005, 1], [1006, 1]]]);
  s.edits = JSON.stringify(edits); s.player.x += 50;
  localStorage.setItem(KEY, JSON.stringify(s));
}, KEY);
console.log('S1 written by "B":', await summary(probe));

// 4. The player closes stale tab A without ever playing in it.
await A.close({ runBeforeUnload: true });
await new Promise((r) => setTimeout(r, 1500));
console.log('after closing A:', await summary(probe));
await browser.close(); server.close();
