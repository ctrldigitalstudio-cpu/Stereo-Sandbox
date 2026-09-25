#!/usr/bin/env node
// Live TAA tuning session: boots index.html?test once and keeps it running; renderer changes are
// hot-swapped (same mechanism as tools/tests/visual/live.mjs). Control on 127.0.0.1:<port>:
//
//   /reload                         re-import src/ and rebuild the renderer (keeps chunk meshes)
//   /run?scenes=forest&variants=taa@1,taa@0.5&frames=16&motion=strafe&steps=8&grab=4,8&speed=1&tag=x
//                                   same captures as shots.mjs, into tools/out/taa-<tag>/
//   /eval?js=expr                   evaluate in the page (JSON result)
//   /quit
//
//   node tools/tests/taa/live.mjs [--port 9481] [--size 800x450] [--preset high]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { sceneList, findShore, titleCamera } from '../visual/scenes.mjs';
import { WorldGen } from '../../../src/worldgen.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', 9481));
const [W, H] = opt('size', '800x450').split('x').map(Number);
const preset = opt('preset', null);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const files = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]).replace(/^\/v\d+\//, '/');
  let file = path.join(root, url);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
await new Promise((r) => files.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
let errors = [];
const external = (t) => /fonts\.(googleapis|gstatic)\.com|net::ERR_/.test(t);
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' && !external(t)) || m.type() === 'warning') { if (m.type() === 'error') errors.push(t); console.log(`[console.${m.type()}] ${t.slice(0, 4000)}`); }
});
page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(`http://127.0.0.1:${files.address().port}/index.html?test${preset ? '&preset=' + preset : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
await page.evaluate(() => window.__game.play());
log('game ready');

const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const setRender = (on) => page.evaluate((on) => window.__game.setRender(on), on);

let version = 0;
async function reload(textures) {
  version++;
  const msg = await page.evaluate(async ({ v, textures }) => {
    const g = window.__game;
    const target = g.renderer;             // the object main.js holds; its methods get redirected
    const prev = target.__impl || target;
    const mod = await import(`/v${v}/src/renderer.js`);
    let tex = prev.textureSet;
    if (textures) tex = (await import(`/v${v}/src/textures.js`)).buildTextures();
    const R = new mod.Renderer(target.canvas, tex, prev.settings);
    // Hand over the chunk meshes (their VAOs keep referencing the old index buffer, which stays alive).
    R.terrain.chunks = prev.terrain.chunks;
    R.terrain.stats.loaded = R.terrain.chunks.size;
    for (const [key, c] of R.terrain.chunks) { const w = g.world.chunks.get(key); if (w) c.blocks = w.blocks; c.summary = undefined; }
    const gl = R.gl;
    // Free what the previous implementation owned (never its chunk meshes or index buffer).
    try {
      prev._deleteShadowMap(); prev._deleteSceneTargets(); prev.post.dispose(); prev.atmosphere.dispose();
      for (const p of [prev.terrain.terrain, prev.terrain.shadow, prev.terrain.water]) gl.deleteProgram(p.program);
      prev.overlays.dispose();
      for (const t of [prev.albedoTex, prev.normalTex, prev.specTex, prev.dummyDepth]) gl.deleteTexture(t);
      if (prev._resizeObserver) prev._resizeObserver.disconnect();
    } catch (e) { console.warn('dispose failed', e); }
    target.__impl = R;
    target.render = (f) => R.render(f);
    target.applySettings = (s) => R.applySettings(s);
    target.resize = () => R.resize();
    for (const k of ['terrain', 'overlays', 'post', 'atmosphere', 'stats', 'settings']) target[k] = R[k];
    R.post.resetExposure = true;
    return `renderer v${v} (${R.terrain.chunks.size} chunks)`;
  }, { v: version, textures: !!textures });
  await setRender(true);
  await frames(1);
  return msg;
}

// Extra views for anti-aliasing checks (seed 12345).
const EXTRA = [
  // Leaves against the sky, trunks, grass: the classic TAA stress test.
  { name: 'canopy', time: 0.3, pos: [15.5, 62, 28.5], yaw: 2.5, pitch: 0.35, ground: true },
  // Long straight block edges and distant ridges (high up, looking across the land).
  { name: 'ridges', time: 0.36, pos: [-40, 100, 40], yaw: 0.9, pitch: -0.12, far: true },
];

let motion = null, speed = 1;
// Per-frame camera delta for --motion (blocks / radians per frame, scaled by --speed).
function poseAt(base, k) {
  const p = { ...base, pos: base.pos.slice() };
  const f = k * speed;
  if (motion === 'strafe') { p.pos[0] += Math.cos(base.yaw) * 0.12 * f; p.pos[2] -= Math.sin(base.yaw) * 0.12 * f; }
  else if (motion === 'forward') { p.pos[0] -= Math.sin(base.yaw) * 0.2 * f; p.pos[2] -= Math.cos(base.yaw) * 0.2 * f; }
  else if (motion === 'yaw') p.yaw += 0.012 * f;
  else if (motion === 'pitch') p.pitch += 0.01 * f;
  else if (motion === 'orbit') { p.yaw += 0.01 * f; p.pos[0] += Math.cos(base.yaw) * 0.08 * f; p.pos[2] -= Math.sin(base.yaw) * 0.08 * f; }
  return p;
}


let all = null;
async function run(q) {
  const tag = q.get('tag') || 'live';
  const outDir = path.join(root, 'tools/out', `taa-${tag}`);
  fs.mkdirSync(outDir, { recursive: true });
  const save = async (name) => {
    const data = await page.evaluate(() => window.__game.capture());
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    return path.relative(root, file);
  };
  if (!all) {
    const sp = await page.evaluate(() => window.__game.gen.findSpawn());
    const shore = await page.evaluate(`(${findShore.toString()})(window.__game.gen, ${sp.x}, ${sp.z})`);
    all = [...sceneList(sp, shore, titleCamera(new WorldGen(12345), sp)), ...EXTRA];
  }
  const variants = (q.get('variants') || 'taa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
  const nFrames = Number(q.get('frames') || 16);
  motion = q.get('motion');
  speed = Number(q.get('speed') || 1);
  const steps = Number(q.get('steps') || 8);
  const grab = (q.get('grab') || String(steps)).split(',').map(Number);
  const extraSettings = q.get('settings') ? JSON.parse(q.get('settings')) : {};
  const lines = [];
  for (const name of (q.get('scenes') || 'forest').split(',')) {
    const s = all.find((x) => x.name === name);
    if (!s) { lines.push(`unknown scene ${name}`); continue; }
    await setRender(false);
    const base = await page.evaluate((s) => {
      const g = window.__game;
      g.setSettings({ cloudCoverage: 0.45, ...(s.settings || {}) });
      let y = s.pos[1];
      if (s.ground) y = g.gen.heightAt(Math.floor(s.pos[0]), Math.floor(s.pos[2])) + 1;
      g.teleport(s.pos[0], y, s.pos[2], s.yaw, s.pitch);
      g.player.flying = true;
      g.setTime(s.time);
      g.player.selected = s.selected ?? 0;
      return { pos: [s.pos[0], y, s.pos[2]], yaw: s.yaw, pitch: s.pitch };
    }, { ...s, edits: undefined });
    await frames(3);
    const rd = await page.evaluate(() => window.__game.settings.renderDistance);
    await page.waitForFunction((r) => window.__game.loaded(r) >= 0.999, s.far ? rd : 3, { timeout: 600000, polling: 500 });
    let restore = null;
    if (s.edits) {
      restore = await page.evaluate(({ src, base }) => {
        const g = window.__game, w = g.world, p = base || g.player.pos;
        const list = new Function('return ' + src)()(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]));
        const undo = list.map(([x, y, z]) => [x, y, z, Math.max(0, w.getBlock(x, y, z))]).reverse();
        for (const [x, y, z, id] of list) w.setBlock(x, y, z, id);
        return undo;
      }, { src: s.edits.toString(), base: s.editBase || null });
    }
    await frames(s.settle || 20);
    for (const v of variants) {
      await page.evaluate(({ v, e }) => window.__game.setSettings({ aa: v.aa, renderScale: v.scale, ...e }), { v, e: extraSettings });
      await page.evaluate((b) => window.__game.teleport(b.pos[0], b.pos[1], b.pos[2], b.yaw, b.pitch), base);
      await setRender(true);
      await frames(1);
      await page.evaluate(() => { window.__game.renderer.post.resetExposure = true; });
      await frames(Math.max(1, nFrames - 1));
      const id = `${name}-${v.aa}-${v.scale}`;
      lines.push(await save(id));
      if (motion) {
        for (let k = 1; k <= steps; k++) {
          const p = poseAt(base, k);
          await page.evaluate((p) => window.__game.teleport(p.pos[0], p.pos[1], p.pos[2], p.yaw, p.pitch), p);
          if (grab.includes(k)) lines.push(await save(`${id}-${motion}${k}`));
          else await frames(1);
        }
      }
      await setRender(false);
    }
    if (restore) await page.evaluate((undo) => { for (const [x, y, z, id] of undo) window.__game.world.setBlock(x, y, z, id); }, restore);
  }
  lines.forEach((l) => log(l));
  return lines.join('\n');
}

let busy = Promise.resolve();
const control = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const go = async () => {
    errors = [];
    let body = '';
    try {
      if (u.pathname === '/reload') body = await reload(false);
      else if (u.pathname === '/run') body = await run(u.searchParams);
      else if (u.pathname === '/eval') body = JSON.stringify(await page.evaluate(u.searchParams.get('js')));
      else if (u.pathname === '/quit') { body = 'bye'; setTimeout(async () => { await browser.close(); process.exit(0); }, 100); }
      else body = 'unknown command';
    } catch (e) { body = `ERROR ${e.stack || e.message}`; }
    if (errors.length) body += `\nPAGE ERRORS (${errors.length}):\n` + errors.map((e) => e.slice(0, 3000)).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(body + '\n');
  };
  busy = busy.then(go, go);
});
control.listen(port, '127.0.0.1', () => log(`control on http://127.0.0.1:${port}`));
