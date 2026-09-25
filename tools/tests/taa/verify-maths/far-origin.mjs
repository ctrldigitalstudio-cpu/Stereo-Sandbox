// Reads the TAA aux target (accumulated weight) back after controlled camera motion to check
// that reprojection keeps history where it should (static world) and rejects where it should.
//   node tools/tests/taa/verify-maths/motion-stats.mjs [scale] [originX]
import { chromium } from 'playwright';
import { startStaticServer } from '../../../static-server.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(root, 'tools/out/taa-verify-maths');
fs.mkdirSync(OUT, { recursive: true });
const scale = Number(process.argv[2] || 1);
const ox = Number(process.argv[3] || 0);
const tag = `s${scale}-x${ox}`;
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 225 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`);
await page.waitForFunction(() => window.__game);
await page.evaluate(() => window.__game.play());
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
await page.evaluate(({ scale, ox }) => {
  const g = window.__game;
  g.setSettings({ aa: 'taa', renderScale: scale, viewBobbing: false, dayLength: 0, bloom: false });
  g.setTime(0.3);
  const x = 15.5 + ox, z = 28.5;
  window.__base = [x, g.gen.heightAt(Math.floor(x), 28) + 1.6, z];
  g.teleport(window.__base[0], window.__base[1], window.__base[2], 2.5, 0.05);
}, { scale, ox });
await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 600000 });
await frames(3);

const stats = () => page.evaluate(() => {
  const r = window.__game.renderer, gl = r.gl, t = r.post.taa;
  const w = t.width, h = t.height;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.targets.aux[t.index], 0);
  const px = new Float32Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  let fresh = 0, sum = 0, inner = 0, innerFresh = 0;
  const hist = new Array(14).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const W = px[(y * w + x) * 4 + 2] * 32;
    sum += W;
    hist[Math.min(13, Math.floor(W))]++;
    const edge = x < 12 || y < 12 || x >= w - 12 || y >= h - 12;
    if (W <= 1.0001) fresh++;
    if (!edge) { inner++; if (W <= 1.0001) innerFresh++; }
  }
  return { size: `${w}x${h}`, render: `${r.renderWidth}x${r.renderHeight}`, meanW: +(sum / (w * h)).toFixed(3), fresh: +(fresh / (w * h)).toFixed(4), innerFresh: +(innerFresh / inner).toFixed(4), hist: hist.join(','), valid: t.valid, cuts: t.cuts };
});

const grab = async (name) => { const data = await page.evaluate(() => window.__game.capture()); fs.writeFileSync(path.join(OUT, `${tag}-${name}.png`), Buffer.from(data.split(',')[1], 'base64')); };

// A: still
await frames(12);
console.log('still  ', JSON.stringify(await stats()));
// B: strafe 0.12 blocks/frame
for (let i = 1; i <= 8; i++) {
  await page.evaluate((i) => { const g = window.__game, b = window.__base, yaw = 2.5; g.teleport(b[0] + Math.cos(yaw) * 0.12 * i, b[1], b[2] - Math.sin(yaw) * 0.12 * i, yaw, 0.05); }, i);
  await frames(1);
}
console.log('strafe ', JSON.stringify(await stats()));
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 1; });
await grab('strafe-debug');
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 0; });
await browser.close(); server.close(); process.exit(0);
const endPos = await page.evaluate(() => window.__game.player.pos.slice());
await frames(10);
for (let i = 1; i <= 8; i++) {
  await page.evaluate(({ i, p }) => { window.__game.teleport(p[0], p[1], p[2], 2.5 + 0.02 * i, 0.05); }, { i, p: endPos });
  await frames(1);
}
console.log('yaw    ', JSON.stringify(await stats()));
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 1; });
await grab('yaw-debug');
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 0; });
// D: pitch rotation
await frames(10);
for (let i = 1; i <= 8; i++) {
  await page.evaluate(({ i, p }) => { window.__game.teleport(p[0], p[1], p[2], 2.66, 0.05 + 0.015 * i); }, { i, p: endPos });
  await frames(1);
}
console.log('pitch  ', JSON.stringify(await stats()));
// E: vertical move
await frames(10);
for (let i = 1; i <= 8; i++) {
  await page.evaluate(({ i, p }) => { window.__game.teleport(p[0], p[1] + 0.1 * i, p[2], 2.66, 0.17); }, { i, p: endPos });
  await frames(1);
}
console.log('rise   ', JSON.stringify(await stats()));
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 1; });
await grab('rise-debug');
await browser.close();
server.close();
