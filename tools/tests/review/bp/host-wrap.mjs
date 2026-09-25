// Review (build/portability): run dist/artifact.html the way the artifact host does: wrapped in a
// skeleton (charset + viewport + small reset), inside a sandboxed opaque-origin iframe, under a CSP.
//   node tools/tests/review/bp/host-wrap.mjs [--csp "<policy>"] [--extra "<script to inject before artifact>"] [--wait 30000] [--size 960x540] [--mobile]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const CSP = opt('csp', "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; worker-src blob:; connect-src 'none'");
const extra = opt('extra', '');
const wait = Number(opt('wait', '30000'));
const [W, H] = opt('size', '960x540').split('x').map(Number);
const shot = opt('shot', 'tools/out/review/bp/host-wrap.png');
const skeleton = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui;background:#fafaf7}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${extra ? `<script>${extra}</script>` : ''}${body}</body></html>`;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/outer.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><body style="margin:0"><iframe id=f sandbox="allow-scripts allow-pointer-lock allow-popups" src="/wrapped.html" style="border:0;width:${W}px;height:${H}px"></iframe>`);
    return;
  }
  if (url === '/wrapped.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
    res.end(skeleton(fs.readFileSync(path.join(root, 'dist/artifact.html'), 'utf8')));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctxOpts = args.includes('--mobile') ? { ...devices['iPhone 13'] } : { viewport: { width: W, height: H } };
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url().slice(0, 120), r.failure()?.errorText));
await page.goto(`http://127.0.0.1:${server.address().port}/outer.html`, { waitUntil: 'load' });
let frame;
for (let i = 0; i < 60 && !frame; i++) { await page.waitForTimeout(250); frame = page.frames().find((f) => f.url().includes('wrapped.html')); }
let r = null;
const t0 = Date.now();
while (Date.now() - t0 < wait) {
  await page.waitForTimeout(1000);
  r = await frame.evaluate(() => ({
    origin: location.origin,
    game: !!window.__game,
    loaded: window.__game ? window.__game.world.loadedFraction(2) : null,
    chunks: window.__game ? window.__game.world.loadedCount : null,
    frame: window.__game ? window.__game.frame : null,
    fatal: document.querySelector('.fatal-error')?.innerText || null,
    bootStatus: document.querySelector('.boot-status')?.textContent || null,
    title: document.title,
  })).catch((e) => 'eval error ' + e.message);
  if (r && r.loaded >= 1) break;
}
console.log('result:', JSON.stringify(r));
await page.screenshot({ path: path.join(root, shot) });
await browser.close(); server.close();
