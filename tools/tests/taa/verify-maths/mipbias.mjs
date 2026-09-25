// Texture detail under temporal upscaling: TAA at renderScale 1 vs 0.5 as shipped vs 0.5 with the
// terrain's texture derivatives (mip LOD + pixelArtUV seam width) scaled to OUTPUT pixels.
// The patched terrain.js / common.js are served through request interception only (no repo edits).
//   node tools/tests/taa/verify-maths/mipbias.mjs [patched=0|1]
import { chromium } from 'playwright';
import { startStaticServer } from '../../../static-server.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(root, 'tools/out/taa-verify-maths');
fs.mkdirSync(OUT, { recursive: true });
const patched = process.argv[2] === '1';
const CW = 400;
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: CW, height: 225 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
if (patched) {
  let terrain = fs.readFileSync(path.join(root, 'src/render/terrain.js'), 'utf8');
  const a = 'vec2 gx = dFdx(uv), gy = dFdy(uv);';
  const b = 'vec3 tc = vec3(pixelArtUV(uv, !lava), float(vLayer));';
  if (!terrain.includes(a) || !terrain.includes(b)) throw new Error('patch anchors not found');
  // Output-pixel footprint: render derivatives x (render width / canvas width) when TAA is on.
  terrain = terrain.replace(a, `float taauK = taaOn() ? uRes.x / ${CW.toFixed(1)} : 1.0; vec2 gx = dFdx(uv) * taauK, gy = dFdy(uv) * taauK;`);
  terrain = terrain.replace(b, 'vec3 tc = vec3(pixelArtUVd(uv, fwidth(uv * 16.0) * taauK, !lava), float(vLayer));');
  await page.route('**/src/render/terrain.js', (route) => route.fulfill({ body: terrain, contentType: 'text/javascript' }));
}
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`);
await page.waitForFunction(() => window.__game);
await page.evaluate(() => window.__game.play());
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
await page.evaluate(() => {
  const g = window.__game;
  g.setSettings({ aa: 'taa', renderScale: 1, viewBobbing: false, dayLength: 0, bloom: false });
  g.setTime(0.28);
  g.teleport(15.5, g.gen.heightAt(15, 28) + 1.6, 28.5, 2.5, -0.45);
});
await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 600000 });
await frames(3);

// High-frequency energy of luma (mean |Laplacian|) over the lower 60% of the image.
const metric = (url) => page.evaluate(async (url) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const L = (i, j) => { const k = (j * c.width + i) * 4; return 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; };
  let s = 0, n = 0;
  for (let j = Math.floor(c.height * 0.4); j < c.height - 1; j++) for (let i = 1; i < c.width - 1; i++) {
    if (i > c.width * 0.68 && j > c.height * 0.7) continue;   // skip the held block
    s += Math.abs(4 * L(i, j) - L(i - 1, j) - L(i + 1, j) - L(i, j - 1) - L(i, j + 1)); n++;
  }
  return +(s / n).toFixed(3);
}, url);

const res = {};
for (const scale of patched ? [0.5, 1] : [1, 0.5]) {
  await page.evaluate((s) => window.__game.setSettings({ renderScale: s }), scale);
  await frames(24);
  const url = await page.evaluate(() => window.__game.capture());
  fs.writeFileSync(path.join(OUT, `mip-${patched ? 'patched' : 'shipped'}-s${scale}.png`), Buffer.from(url.split(',')[1], 'base64'));
  res[scale] = await metric(url);
}
console.log(patched ? 'patched' : 'shipped', JSON.stringify(res));
await browser.close();
server.close();
