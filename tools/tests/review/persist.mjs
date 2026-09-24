// Review check: edits made in play survive a reload (pagehide save -> boot -> worker init edits).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port()}/index.html`, { waitUntil: 'load' });
function port() { return server.address().port; }
await page.waitForFunction(() => window.__game && window.__game.world.loadedFraction(2) >= 1, null, { timeout: 120000, polling: 500 });
const put = await page.evaluate(() => {
  const g = window.__game, w = g.world, p = g.player.pos;
  // A spot in a neighbouring chunk towards -x/-z (negative local maths), one block above ground.
  const x = Math.floor(p[0]) - 17, z = Math.floor(p[2]) - 17;
  let y = 127; while (y > 0 && w.getBlock(x, y, z) === 0) y--;
  y++;
  const ok = w.setBlock(x, y, z, 30); // glowstone id? use B lookup below
  return { x, y, z, ok, id: w.getBlock(x, y, z), seed: w.seed };
});
console.log('placed:', JSON.stringify(put));
await page.evaluate(() => { window.__marker = 1; location.reload(); }).catch(() => {});
for (let i = 0; i < 240; i++) {
  await page.waitForTimeout(500);
  const ok = await page.evaluate(() => !window.__marker && !!(window.__game && window.__game.world.loadedFraction(2) >= 1)).catch(() => false);
  if (ok) break;
}
const after = await page.evaluate((p) => ({ seed: window.__game.world.seed, id: window.__game.world.getBlock(p.x, p.y, p.z) }), put);
console.log('after reload:', JSON.stringify(after), after.id === put.id && after.seed === put.seed ? 'edit persisted' : 'EDIT LOST');
await browser.close(); server.close();
