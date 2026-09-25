#!/usr/bin/env node
// Review scratch (skeptic, read-only): A/B of skipping chunks lying entirely beyond the fog end
// (uCam.z). Compares images (noise floor A1 vs A2, then A vs B) and SwiftShader frame time.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const outDir = path.join(root, 'tools/out/skeptic-fogring');
fs.mkdirSync(outDir, { recursive: true });
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test&preset=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.evaluate(() => { window.__game.setRender(false); window.__game.play(); });
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
let x = spawn.x;
const pitch = Number(process.env.PITCH ?? 0.05);
await page.evaluate(({ x, s }) => { const g = window.__game; g.teleport(x, s.y + 30, s.z, Math.PI / 2, -0.1); g.setTime(0.4); }, { x, s: spawn });
await frames(3);
await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
for (let i = 1; i <= 3; i++) {
  x += 16;
  await page.evaluate(({ x, s }) => { window.__game.teleport(x, s.y + 30, s.z, -Math.PI / 2, -0.1); }, { x, s: spawn });
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
}
await page.evaluate((p) => { const g = window.__game; g.player.yaw = Math.PI / 2; g.player.pitch = p; }, pitch);
await frames(5);

// Install the toggleable cull + a timing wrapper.
await page.evaluate(() => {
  const R = window.__game.renderer, T = R.terrain, gl = R.gl;
  const orig = T._collect;
  window.__cull = false;
  window.__skipped = 0;
  T._collect = function (view, kind, btf) {
    const l = orig.call(this, view, kind, btf);
    if (!window.__cull || view.underwater) return l;
    const fe = Math.max(R.settings.renderDistance * 16 - 14, 24) + 0.25;
    const cam = view.camPos;
    let j = 0;
    for (const c of l) {
      const x0 = c.cx * 16, z0 = c.cz * 16;
      const dx = Math.max(x0 - cam[0], 0, cam[0] - (x0 + 16)), dz = Math.max(z0 - cam[2], 0, cam[2] - (z0 + 16));
      if (dx * dx + dz * dz < fe * fe) l[j++] = c; else if (kind === 'opaque') window.__skipped++;
    }
    l.length = j;
    return l;
  };
  const origRender = R.render;
  window.__times = [];
  R.render = function (f) { const t = performance.now(); origRender.call(this, f); gl.finish(); window.__times.push(performance.now() - t); };
});

const cap = async (name) => {
  const url = await page.evaluate(() => window.__game.capture());
  fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
  return url;
};
const diff = (a, b) => page.evaluate(async ({ a, b }) => {
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
  const x = c.getContext('2d');
  x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data;
  x.clearRect(0, 0, c.width, c.height); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, max = 0, over4 = 0, over12 = 0, n = c.width * c.height;
  let minY = 1e9, maxY = -1;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    sum += d; if (d > max) max = d; if (d > 4) over4++; if (d > 12) { over12++; const y = (i / 4 / c.width) | 0; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { mean: +(sum / n).toFixed(3), max, over4, over12, over12Rows: over12 ? [minY, maxY] : null, pixels: n };
}, { a, b });

const A1 = await cap('A1');
const A2 = await cap('A2');
await page.evaluate(() => { window.__cull = true; window.__skipped = 0; });
const B1 = await cap('B1');
const skipped = await page.evaluate(() => window.__skipped);
const B2 = await cap('B2');
console.log('noise floor A1 vs A2', JSON.stringify(await diff(A1, A2)));
console.log('noise floor B1 vs B2', JSON.stringify(await diff(B1, B2)));
console.log('A2 vs B1 (cull off vs on)', JSON.stringify(await diff(A2, B1)), 'opaque chunks skipped in B1:', skipped);

// Timing: alternate 8 frames off / 8 frames on, several rounds.
await page.evaluate(() => window.__game.setRender(true));
const res = { off: [], on: [] };
for (let round = 0; round < 4; round++) {
  for (const mode of ['off', 'on']) {
    await page.evaluate((m) => { window.__cull = m === 'on'; window.__times.length = 0; }, mode);
    await frames(8);
    const t = await page.evaluate(() => window.__times.slice(2));
    res[mode].push(...t);
  }
}
await page.evaluate(() => window.__game.setRender(false));
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return +s[s.length >> 1].toFixed(1); };
console.log('SwiftShader render()+finish ms median: cull off', med(res.off), 'cull on', med(res.on), 'n', res.off.length, res.on.length);
const st = await page.evaluate(() => window.__game.renderer.stats);
console.log('stats', JSON.stringify({ chunks: st.chunks, quads: st.quads }));
await browser.close();
server.close();
