// Review (build/portability): boot the game with some WebGL extensions hidden (as on GPUs/browsers
// that lack them), capture a frame, report errors and basic image stats.
//   node tools/tests/review/bp/ext.mjs --hide EXT_color_buffer_float,EXT_color_buffer_half_float [--page dist/index.html] [--out name]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const hide = (opt('hide', '') || '').split(',').filter(Boolean);
const pg = opt('page', 'dist/index.html');
const out = opt('out', 'ext-' + (hide.join('+') || 'none'));
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
await page.addInitScript((hide) => {
  const P = WebGL2RenderingContext.prototype;
  const ge = P.getExtension, gse = P.getSupportedExtensions;
  P.getExtension = function (n) { return hide.includes(n) ? null : ge.call(this, n); };
  P.getSupportedExtensions = function () { return gse.call(this).filter((n) => !hide.includes(n)); };
}, hide);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { console.log('[console]', m.type(), m.text().slice(0, 400)); if (m.type() === 'error' && !/fonts\.|ERR_/.test(m.text())) errors.push(m.text()); } });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); errors.push(e.message); });
const T0 = Date.now(); const lg = (s) => console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + s);
await page.goto(`http://127.0.0.1:${server.address().port}/${pg}?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.loaded(3) >= 1, null, { timeout: 60000, polling: 500 }).catch(() => console.log('not loaded'));
lg('loaded');
const info = await page.evaluate(async () => {
  const g = window.__game;
  g.play();
  g.setTime(0.3);
  const gl = g.renderer.gl;
  const s = g.renderer.stats;
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
  const url = await g.capture();
  return { hdr: g.renderer.hdr, internal: { RGBA16F: gl.RGBA16F, RGBA8: gl.RGBA8 }, url, err: gl.getError(), stats: { drawCalls: s.drawCalls, chunks: s.chunks } };
});
lg('captured');
const b64 = info.url.split(',')[1];
fs.writeFileSync(path.join(root, 'tools/out/review/bp', out + '.png'), Buffer.from(b64, 'base64'));
// image stats via a canvas in the page
const stats = await page.evaluate(async (url) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, min = 255, max = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; if (l < min) min = l; if (l > max) max = l; }
  return { w: c.width, h: c.height, mean: +(sum / n).toFixed(1), min, max };
}, info.url);
console.log(JSON.stringify({ hide, hdr: info.hdr, glError: info.err, stats: info.stats, image: stats, errors: errors.length }));
await browser.close(); server.close();
