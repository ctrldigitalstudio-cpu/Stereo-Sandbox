#!/usr/bin/env node
// Long-lived visual-tuning session: boots the game once (index.html?test, seed 12345) and keeps
// it running, so shader edits can be checked without regenerating the world. Controlled over
// HTTP on 127.0.0.1:<port> (default 9471):
//
//   /reload[?textures=1]         hot-swap the renderer: re-imports src/ under a fresh URL prefix,
//                                builds a new Renderer on the same canvas and hands it the loaded
//                                chunk meshes (textures=1 also rebuilds the texture set)
//   /shoot?scenes=a,b&tag=t      capture scenes (see scenes.mjs) to tools/out/visual-<tag>-<scene>.png
//   /settings?json={...}         __game.setSettings(patch)
//   /eval?js=expr                evaluate an expression in the page (JSON result)
//   /quit
//
//   node tools/tests/visual/live.mjs [--port 9471] [--size 800x450] [--preset high]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { sceneList, findShore } from './scenes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', 9471));
const [W, H] = opt('size', '800x450').split('x').map(Number);
const preset = opt('preset', null);
const outDir = path.join(root, 'tools/out');

// Static server; /v<N>/<path> serves <path> so a re-import gets fresh module instances.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const files = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]).replace(/^\/v\d+\//, '/');
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
await page.addScriptTag({ path: path.join(root, 'tools/tests/visual/probe.js') });
log('game ready');

const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const setRender = (on) => page.evaluate((on) => { if (window.__game.setRender) window.__game.setRender(on); }, on);

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

let sp = null, shore = null;
async function shoot(names, tag, settle) {
  if (!sp) {
    sp = await page.evaluate(() => window.__game.gen.findSpawn());
    shore = await page.evaluate(`(${findShore.toString()})(window.__game.gen, ${sp.x}, ${sp.z})`);
  }
  const all = sceneList(sp, shore);
  const out = [];
  for (const name of names) {
    const s = all.find((x) => x.name === name);
    if (!s) { out.push(`unknown scene ${name}`); continue; }
    const t1 = Date.now();
    await setRender(false);
    await page.evaluate(({ s }) => {
      const g = window.__game;
      g.setSettings({ cloudCoverage: 0.45, ...(s.settings || {}) });
      let y = s.pos[1];
      if (s.ground) y = g.gen.heightAt(Math.floor(s.pos[0]), Math.floor(s.pos[2])) + 1;
      g.teleport(s.pos[0], y, s.pos[2], s.yaw, s.pitch);
      g.player.flying = true;
      g.setTime(s.time);
    }, { s: { ...s, edits: undefined } });
    await frames(3);
    const rd = await page.evaluate(() => window.__game.settings.renderDistance);
    try {
      await page.waitForFunction((r) => window.__game.loaded(r) >= 0.999, s.far ? rd : 3, { timeout: 400000, polling: 500 });
    } catch (e) { out.push(`${name}: load timeout`); }
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
    await frames(s.settle || 30);           // meshes of edits arrive, eye sky light settles (no drawing)
    await setRender(true);
    await frames(1);
    await page.evaluate(() => { window.__game.renderer.post.resetExposure = true; });
    await frames(settle);
    const data = await page.evaluate(() => window.__game.capture());
    const file = path.join(outDir, `visual-${tag}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    const st = await page.evaluate(() => {
      const s = window.__game.renderer.stats;
      return `chunks ${s.chunks} quads ${s.quads} passes ${s.passes} gpuMs ${(s.gpuMs || 0).toFixed(0)}`;
    });
    if (restore) await page.evaluate((undo) => { for (const [x, y, z, id] of undo) window.__game.world.setBlock(x, y, z, id); }, restore);
    const line = `${name}: ${path.relative(root, file)} ${((Date.now() - t1) / 1000).toFixed(0)}s (${st})`;
    log(line);
    out.push(line);
  }
  return out.join('\n');
}

let busy = Promise.resolve();
const control = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const run = async () => {
    errors = [];
    let body = '';
    try {
      if (u.pathname === '/reload') body = await reload(u.searchParams.get('textures') === '1');
      else if (u.pathname === '/shoot') body = await shoot((u.searchParams.get('scenes') || 'noon').split(','), u.searchParams.get('tag') || 'cur', Number(u.searchParams.get('settle') || 2));
      else if (u.pathname === '/settings') body = await page.evaluate((p) => { window.__game.setSettings(p); return JSON.stringify(window.__game.settings); }, JSON.parse(u.searchParams.get('json')));
      else if (u.pathname === '/eval') {
        await page.addScriptTag({ path: path.join(root, 'tools/tests/visual/probe.js') });
        body = JSON.stringify(await page.evaluate(u.searchParams.get('js')));
      }
      else if (u.pathname === '/quit') { body = 'bye'; setTimeout(async () => { await browser.close(); process.exit(0); }, 100); }
      else body = 'unknown command';
    } catch (e) { body = `ERROR ${e.stack || e.message}`; }
    if (errors.length) body += `\nPAGE ERRORS (${errors.length}):\n` + errors.map((e) => e.slice(0, 3000)).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(body + '\n');
  };
  busy = busy.then(run, run);
});
control.listen(port, '127.0.0.1', () => log(`control on http://127.0.0.1:${port}`));
