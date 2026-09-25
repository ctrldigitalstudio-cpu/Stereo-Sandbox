// Review harness (rendering): boot the game in headless Chromium, run scenes, capture canvas + GL errors.
//   node tools/tests/review/render/harness.mjs --tag name [--noFloat] [--size 480x270] [--scenes noon,night] [--js "code run after load"]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'run');
const [W, H] = opt('size', '480x270').split('x').map(Number);
const outDir = path.join(root, 'tools/out/review/render');
fs.mkdirSync(outDir, { recursive: true });
const server = await startStaticServer(root);
const query = opt('query', 'test');
const url = `http://127.0.0.1:${server.address().port}/index.html?${query}`;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const initNoFloat = args.includes('--noFloat');
await page.addInitScript(({ noFloat }) => {
  const P = WebGL2RenderingContext.prototype;
  const ge = P.getExtension;
  P.getExtension = function (n) {
    if (noFloat && (n === 'EXT_color_buffer_float' || n === 'EXT_color_buffer_half_float')) return null;
    return ge.call(this, n);
  };
  window.__glErrors = [];
  window.__checkGL = false;
  for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'blitFramebuffer', 'clear']) {
    const orig = P[fn];
    P[fn] = function (...a) {
      const r = orig.apply(this, a);
      if (window.__checkGL) {
        const e = this.getError();
        if (e) {
          const prog = this.getParameter(this.CURRENT_PROGRAM);
          window.__glErrors.push({ fn, e: '0x' + e.toString(16), stack: new Error().stack.split('\n').slice(2, 5).join(' | ') });
        }
      }
      return r;
    };
  }
}, { noFloat: initNoFloat });
const logs = [];
page.on('console', (m) => { const t = `[console.${m.type()}] ${m.text().slice(0, 600)}`; logs.push(t); if (m.type() !== 'log' && m.type() !== 'debug') console.log(t); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack || e.message}`));
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 600000, polling: 500 });
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
await frames(5);
log('loaded');
const pre = opt('js', null);
if (pre) { const v = await page.evaluate(pre); log('js: ' + JSON.stringify(v)); }
await page.evaluate(() => window.__game.play());
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
const all = {
  noon: { time: 0.25, pos: [spawn.x, spawn.y + 22, spawn.z], yaw: 0.6, pitch: -0.3 },
  night: { time: 0.78, pos: [spawn.x, spawn.y + 10, spawn.z], yaw: 0.6, pitch: 0.1 },
  nightdown: { time: 0.78, pos: [spawn.x, spawn.y + 10, spawn.z], yaw: 0.6, pitch: -0.4 },
  sunset: { time: 0.485, pos: [spawn.x, spawn.y + 12, spawn.z], yaw: -Math.PI / 2 + 0.3, pitch: 0.02 },
};
const want = opt('scenes', 'noon,night').split(',');
const results = {};
for (const name of want) {
  const s = all[name];
  await page.evaluate((s) => { const g = window.__game; g.teleport(s.pos[0], s.pos[1], s.pos[2], s.yaw, s.pitch); g.setTime(s.time); }, s);
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 240000, polling: 500 });
  await frames(Number(opt('frames', '30')));
  await page.evaluate(() => { window.__checkGL = true; });
  await frames(2);
  await page.evaluate(() => { window.__checkGL = false; });
  const dataUrl = await page.evaluate(() => window.__game.capture());
  const file = path.join(outDir, `${tag}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const post = opt('post', null);
  const extra = post ? await page.evaluate(post) : null;
  results[name] = extra;
  log(`${name}: ${file} ${extra ? JSON.stringify(extra) : ''}`);
}
const errs = await page.evaluate(() => window.__glErrors.slice(0, 20));
const info = await page.evaluate(() => { const r = window.__game.renderer; return { hdr: r.hdr && r.hdr.internal, ext: Object.fromEntries(Object.entries(r.gl.ext).map(([k, v]) => [k, !!v])) }; });
console.log('GL errors:', JSON.stringify(errs, null, 1));
console.log('info:', JSON.stringify(info));
fs.writeFileSync(path.join(outDir, `${tag}-console.log`), logs.join('\n'));
await browser.close();
server.close();
