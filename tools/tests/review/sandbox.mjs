// Review check: does the built page's world worker start inside a sandboxed iframe
// (sandbox="allow-scripts", opaque origin, like a hosted artifact)?
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const csp = process.argv[2] || '';
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/outer.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<iframe id=f sandbox="allow-scripts allow-pointer-lock" src="/dist/index.html?test" style="width:480px;height:270px"></iframe>`);
    return;
  }
  const file = path.join(root, url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const h = { 'Content-Type': 'text/html' };
    if (csp) h['Content-Security-Policy'] = csp;
    res.writeHead(200, h);
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/outer.html`, { waitUntil: 'load' });
let frame;
for (let i = 0; i < 60 && !frame; i++) { await page.waitForTimeout(500); frame = page.frames().find((f) => f.url().includes('dist/index.html')); }
let r = null;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  r = await frame.evaluate(() => window.__game ? { origin: location.origin, loaded: window.__game.world.loadedFraction(2), chunks: window.__game.world.loadedCount } : null).catch((e) => 'eval error ' + e.message);
  if (r && r.loaded >= 1) break;
}
console.log('result:', JSON.stringify(r));
await browser.close(); server.close();
