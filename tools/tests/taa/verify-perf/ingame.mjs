#!/usr/bin/env node
// Verifier scratch: in-game GL-error matrix across settings + SwiftShader per-pass timing.
//   node tools/tests/taa/verify-perf/ingame.mjs [--part errors|timing] [--size 640x360] [--src dist]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const part = opt('part', 'errors');
const [W, H] = opt('size', '640x360').split('x').map(Number);
const outDir = path.join(root, 'tools/out/taa-verify-perf');
fs.mkdirSync(outDir, { recursive: true });
const server = await startStaticServer(root);
const pageUrl = `http://127.0.0.1:${server.address().port}/${opt('page', 'index.html')}?test`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_|fonts\./.test(m.text())) { errors.push(m.text()); console.log('[console.error]', m.text().slice(0, 500)); } if (m.type() === 'warning') console.log('[warn]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });

// Instrumentation before the game loads: label programs by fragment-shader fingerprint; optional
// per-draw gl.finish() timing (window.__timePasses = true) collected into window.__passT.
await page.addInitScript(() => {
  const P = WebGL2RenderingContext.prototype;
  const labels = new Map();
  const fp = [
    [/oHistory/, 'taa-resolve'], [/uSharpness/, 'sharpen'], [/EDGE_THRESHOLD/, 'fxaa'], [/ACES_IN/, 'tonemap'],
    [/uKaris/, 'bloom-down'], [/tap\(vec2\(0\.0\)\) \* 4\.0/, 'bloom-up'], [/uReset/, 'exposure'], [/volumetricLight/, 'post-half'],
    [/oCloud/, 'denoise'], [/uFlatClouds/, 'composite'], [/uHeldLight/, 'held'], [/traceSSR/, 'water'],
    [/o = vec4\(texture\(uTex, vUV\)\.rgb, 1\.0\)/, 'copy'],
  ];
  const oLink = P.linkProgram;
  P.linkProgram = function (p) {
    const r = oLink.call(this, p);
    let label = 'other';
    for (const s of this.getAttachedShaders(p) || []) {
      if (this.getShaderParameter(s, this.SHADER_TYPE) !== this.FRAGMENT_SHADER) continue;
      const src = this.getShaderSource(s) || '';
      const hit = fp.find(([re]) => re.test(src));
      label = hit ? hit[1] : (/shadowVisibility/.test(src) ? 'terrain' : /discard/.test(src) && src.length < 6000 ? 'shadow/misc' : 'other' + (src.length >> 10));
    }
    labels.set(p, label);
    return r;
  };
  let cur = null;
  const oUse = P.useProgram; P.useProgram = function (p) { cur = p; return oUse.call(this, p); };
  window.__passT = {};
  window.__pending = [];
  let ext = null;
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'blitFramebuffer']) {
    const o = P[name];
    P[name] = function (...a) {
      if (!window.__timePasses) return o.apply(this, a);
      ext = ext || this.getExtension('EXT_disjoint_timer_query_webgl2');
      const q = this.createQuery();
      this.beginQuery(ext.TIME_ELAPSED_EXT, q);
      const r = o.apply(this, a);
      this.endQuery(ext.TIME_ELAPSED_EXT);
      window.__pending.push([name === 'blitFramebuffer' ? 'blit' : (labels.get(cur) || 'unk'), q, this]);
      return r;
    };
  }
  window.__collect = () => {
    const left = [];
    for (const [k, q, gl] of window.__pending) {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { left.push([k, q, gl]); continue; }
      window.__passT[k] = (window.__passT[k] || 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
    }
    window.__pending = left;
    return left.length;
  };
});

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(pageUrl, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 600000, polling: 500 });
log('loaded');
await page.evaluate(() => window.__game.play());
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
const shore = await page.evaluate(({ x, z }) => {
  const g = window.__game.gen;
  for (let r = 16; r < 900; r += 16) for (let a = 0; a < 32; a++) {
    const px = Math.round(x + Math.cos(a / 32 * Math.PI * 2) * r), pz = Math.round(z + Math.sin(a / 32 * Math.PI * 2) * r);
    if (g.heightAt(px, pz) < 44) return { x: px, z: pz };
  }
  return null;
}, spawn);
log(`spawn ${JSON.stringify(spawn)} shore ${JSON.stringify(shore)}`);
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const drain = () => page.evaluate(() => { const gl = window.__game.renderer.gl; const e = []; for (let i = 0; i < 8; i++) { const x = gl.getError(); if (!x) break; e.push('0x' + x.toString(16)); } return e; });
const base = { renderDistance: 4, shadowRes: 1024, shadowRadius: 64, volumetrics: 12, clouds: 10, ssr: 16, shadows: true, pcss: true, bloom: true, autoResolution: false };
const land = { pos: [spawn.x, spawn.y + 6, spawn.z], yaw: -1.2, pitch: -0.08, time: 0.41 };
const sea = shore ? { pos: [shore.x, 64, shore.z], yaw: 0.3, pitch: -0.35, time: 0.33 } : land;
const under = shore ? { pos: [shore.x, 50, shore.z], yaw: 0.3, pitch: -0.2, time: 0.3 } : land;
const place = async (v) => {
  await page.evaluate((v) => { const g = window.__game; g.teleport(v.pos[0], v.pos[1], v.pos[2], v.yaw, v.pitch); g.setTime(v.time); }, v);
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 300000, polling: 500 });
};

if (part === 'errors') {
  const matrix = [
    ['taa 1.0 land', { aa: 'taa', renderScale: 1 }, land],
    ['taa 0.5 land', { aa: 'taa', renderScale: 0.5 }, land],
    ['taa 0.75 shadows off', { aa: 'taa', renderScale: 0.75, shadows: false }, land],
    ['taa 0.85 vol/clouds off', { aa: 'taa', renderScale: 0.85, volumetrics: 0, clouds: 0 }, land],
    ['taa 0.6 water', { aa: 'taa', renderScale: 0.6 }, sea],
    ['taa 0.7 underwater', { aa: 'taa', renderScale: 0.7 }, under],
    ['taa 0.55 underwater shadows off vol off', { aa: 'taa', renderScale: 0.55, shadows: false, volumetrics: 0, clouds: 0 }, under],
    ['fxaa 0.75 water', { aa: 'fxaa', renderScale: 0.75 }, sea],
    ['fxaa 1.0 underwater shadows off', { aa: 'fxaa', renderScale: 1, shadows: false }, under],
    ['off 1.0 land', { aa: 'off', renderScale: 1 }, land],
    ['off 0.65 vol/clouds off water', { aa: 'off', renderScale: 0.65, volumetrics: 0, clouds: 0 }, sea],
    ['taa 0.9 bloom off ssr 0', { aa: 'taa', renderScale: 0.9, bloom: false, ssr: 0 }, sea],
    ['taa 1.0 back to land', { aa: 'taa', renderScale: 1 }, land],
  ];
  const results = [];
  for (const [name, s, v] of matrix) {
    await page.evaluate((s) => window.__game.setSettings(s), { ...base, ...s });
    await place(v);
    await frames(3);
    const url = await page.evaluate(() => window.__game.capture());
    const safe = name.replace(/[^a-z0-9.]+/gi, '-');
    fs.writeFileSync(path.join(outDir, `err-${safe}.png`), Buffer.from(url.split(',')[1], 'base64'));
    const e = await drain();
    const st = await page.evaluate(() => { const r = window.__game.renderer; return { aa: r.stats.aa, rw: r.stats.renderWidth, w: r.stats.width, passes: r.stats.passes, u: !!r.viewInfo.underwater }; });
    results.push({ name, glErrors: e, ...st });
    log(`${name}: glErrors=${JSON.stringify(e)} ${JSON.stringify(st)}`);
  }
  fs.writeFileSync(path.join(outDir, 'ingame-errors.json'), JSON.stringify({ results, pageErrors: errors }, null, 1));
} else if (part === 'timing') {
  // SwiftShader per-pass time (gl.finish around each draw). Relative magnitudes only.
  const cfgs = JSON.parse(opt('cfgs', 'null')) || [
    ['taa 0.85', { aa: 'taa', renderScale: 0.85 }],
    ['taa 0.5', { aa: 'taa', renderScale: 0.5 }],
    ['fxaa 0.85', { aa: 'fxaa', renderScale: 0.85 }],
    ['fxaa 0.5', { aa: 'fxaa', renderScale: 0.5 }],
    ['fxaa 1.0', { aa: 'fxaa', renderScale: 1 }],
    ['taa 1.0', { aa: 'taa', renderScale: 1 }],
  ];
  await place(land);
  const results = [];
  for (const [name, s] of cfgs) {
    await page.evaluate((s) => window.__game.setSettings(s), { ...base, ...s });
    await frames(3);
    await page.evaluate(() => { window.__game.renderer.gl.ext.timer = null; window.__passT = {}; window.__pending = []; window.__timePasses = true; });
    const n = 3;
    const f0 = await page.evaluate(() => window.__game.frame);
    await frames(n);
    const f1 = await page.evaluate(() => { window.__timePasses = false; return window.__game.frame; });
    await page.waitForFunction(() => window.__collect() === 0, null, { timeout: 600000, polling: 1000 });
    const t = await page.evaluate(() => window.__passT);
    const nf = f1 - f0;
    const per = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +(v / nf).toFixed(1)]).sort((a, b) => b[1] - a[1]));
    const total = Object.values(per).reduce((a, b) => a + b, 0);
    results.push({ name, frames: nf, totalMs: +total.toFixed(1), per });
    log(`${name}: ${nf} frames, total ${total.toFixed(0)} ms/frame ${JSON.stringify(per)}`);
  }
  fs.writeFileSync(path.join(outDir, `ingame-timing-${W}x${H}.json`), JSON.stringify(results, null, 1));
}
log(`page errors: ${errors.length}`);
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
