// Skeptic check: dist/artifact.html wrapped like the artifact host (sandboxed iframe + CSP),
// with fonts.googleapis.com delayed. Measures boot time and screenshots during the wait.
//   node tools/tests/review/skeptic/fonts-hang-host.mjs [delayMs=8000]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const delay = Number(process.argv[2] || 8000);
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; worker-src blob:; connect-src 'none'";
const skeleton = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:14px system-ui;background:#fafaf7}</style></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/outer.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><body style="margin:0"><iframe id=f sandbox="allow-scripts allow-pointer-lock" src="/wrapped.html" style="border:0;width:640px;height:360px"></iframe>`); return; }
  if (url === '/wrapped.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP }); res.end(skeleton(fs.readFileSync(path.join(root, 'dist/artifact.html'), 'utf8'))); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
  await new Promise((r) => setTimeout(r, delay));
  await route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts */' }).catch(() => {});
});
const T0 = Date.now();
page.goto(`http://127.0.0.1:${server.address().port}/outer.html`, { waitUntil: 'commit' }).catch(() => {});
let bootAt = null, shotDone = false, splash = null;
while (Date.now() - T0 < delay + 20000) {
  const fr = page.frames().find((f) => f.url().includes('wrapped.html'));
  if (fr) {
    const r = await fr.evaluate(() => ({ game: !!window.__game, splash: !!document.querySelector('.boot-status') })).catch(() => null);
    if (!shotDone && Date.now() - T0 > delay / 2 && r) { shotDone = true; splash = { ...r, t: Date.now() - T0, bodyChildren: await fr.evaluate(() => document.body ? document.body.children.length : -1).catch(() => null) }; }
    if (r && r.game) { bootAt = Date.now() - T0; break; }
  }
  await new Promise((res) => setTimeout(res, 200));
}
console.log(JSON.stringify({ fontDelayMs: delay, midWaitState: splash, gameBootedAtMs: bootAt }));
await browser.close(); server.close();
