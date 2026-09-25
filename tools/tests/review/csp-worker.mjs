// Review check: what does the player see if the world worker cannot start (CSP blocks blob: workers)?
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "worker-src 'self'" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('console', (m) => { if (m.type() !== 'log') console.log('[console]', m.type(), m.text().slice(0, 160)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/dist/index.html`, { waitUntil: 'load' });
await page.waitForTimeout(15000);
const r = await page.evaluate(() => ({ hasGame: !!window.__game, loaded: window.__game && window.__game.world.loadedFraction(2), fatal: !!document.querySelector('.fatal-error'), loadingText: (document.body.innerText.match(/Generating terrain[^\n]*/) || [''])[0] }));
console.log('after 15 s:', JSON.stringify(r));
await page.screenshot({ path: path.join(root, 'tools/out/review/csp-worker.png') });
await browser.close(); server.close();
