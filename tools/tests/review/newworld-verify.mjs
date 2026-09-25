// Review check: does "Delete world" (onNewWorld) actually produce a new world after reload?
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(root, url);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const base = `http://127.0.0.1:${port}/index.html`;
await page.goto(base, { waitUntil: 'load' });
// Seed a known save, then reload so the game boots from it.
await page.evaluate(() => {
  localStorage.setItem('stereo-sandbox.save.v1', JSON.stringify({ seed: 777, time: 0.3, player: { x: 1000.5, y: 90, z: 2000.5, yaw: 0, pitch: 0, flying: true }, hotbar: null, selected: 0, edits: JSON.stringify([['5,5', [[1234, 1]]]]) }));
  // Keep settings light for SwiftShader.
});
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.world, null, { timeout: 60000 });
const before = await page.evaluate(() => ({ seed: window.__game.world.seed, pos: window.__game.player.pos, edits: window.__game.world.exportEdits() }));
console.log('booted from save:', JSON.stringify(before));
// Press "Delete world" (UI calls opts.onNewWorld -> clearSave(); world.terminate(); location.reload()).
await page.evaluate(() => { window.__game.world.edits.set('5,5', new Map([[1234, 1]])); window.__marker = 1; window.__game.ui.opts.onNewWorld(); }).catch(() => {});
for (let i = 0; i < 240; i++) {
  await page.waitForTimeout(500);
  const ok = await page.evaluate(() => !window.__marker && !!(window.__game && window.__game.world)).catch(() => false);
  if (ok) break;
}
const after = await page.evaluate(() => ({ legacy: localStorage.getItem('blockvale.save.v1'), seed: window.__game.world.seed, pos: window.__game.player.pos, edits: window.__game.world.exportEdits(), save: localStorage.getItem('stereo-sandbox.save.v1') && JSON.parse(localStorage.getItem('stereo-sandbox.save.v1')).seed }));
console.log('after "Delete world":', JSON.stringify(after));
console.log(after.seed === before.seed ? 'BUG: same world came back after New world' : 'ok: new seed');
await browser.close();
server.close();
