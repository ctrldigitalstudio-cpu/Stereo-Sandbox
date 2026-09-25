// Minimal self-contained harness for the gameplay/UI review checks (read-only; serves the repo).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

export const root = process.env.SNAP ? path.resolve(process.env.SNAP) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../tools/out/review/gameplay-ui');
fs.mkdirSync(out, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

export function serve(pages = {}) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (pages[url] != null) { res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); res.end(pages[url]); return; }
    let file = path.join(root, url);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { server.base = `http://127.0.0.1:${server.address().port}`; r(server); }));
}

export const LIGHT = {
  preset: 'custom', renderDistance: 4, renderScale: 0.5, autoResolution: false, shadows: false, pcss: false,
  volumetrics: 0, clouds: 0, ssr: 0, bloom: false, fxaa: false,
};

export async function launch() {
  return chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
}

export async function gamePage(browser, { width = 480, height = 270, storage = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.addInitScript((storage) => {
    try {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      for (const k in storage) localStorage.setItem(k, typeof storage[k] === 'string' ? storage[k] : JSON.stringify(storage[k]));
    } catch (e) { /* opaque origin */ }
  }, { 'blockvale.settings.v1': LIGHT, 'stereo-sandbox.settings.v1': LIGHT, ...storage });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
  return { ctx, page };
}

export const frames = (t, n = 1) => t.evaluate((n) => new Promise((res) => {
  const s = window.__game.frame;
  const tick = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
