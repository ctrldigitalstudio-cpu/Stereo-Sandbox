// Scratch harness for the independent TAA visual verification (not part of the test suite).
// Boots index.html?test once. With `realtime: true` the page's requestAnimationFrame timestamps are
// replaced by a virtual 60 Hz clock, so animation (waving plants, water, clouds, particles) moves
// per frame as much as it would in a real 60 fps session instead of 100 ms per software-GL frame.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
import { sceneList, findShore, titleCamera } from '../../visual/scenes.mjs';
import { WorldGen } from '../../../../src/worldgen.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export async function boot({ tag, size = '800x450', realtime = true, preset = null } = {}) {
  const [W, H] = size.split('x').map(Number);
  const outDir = path.join(root, 'tools/out', `taa-verify-visual`, tag);
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startStaticServer(root);
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  if (realtime) {
    await page.addInitScript(() => {
      const orig = window.requestAnimationFrame.bind(window);
      let vt = 0, lastT = -1;
      window.__vt = { step: 1000 / 60 };
      window.requestAnimationFrame = (cb) => orig((t) => {
        if (t !== lastT) { lastT = t; vt += window.__vt.step; }
        cb(vt);
      });
    });
  }
  const errors = [];
  const external = (t) => /fonts\.(googleapis|gstatic)\.com|net::ERR_/.test(t);
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !external(t)) { errors.push(t); console.log(`[console.error] ${t.slice(0, 2000)}`); }
  });
  page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });
  const t0 = Date.now();
  const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test${preset ? '&preset=' + preset : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
  await page.evaluate(() => window.__game.play());
  const frames = (n) => page.evaluate((n) => new Promise((res) => {
    const start = window.__game.frame;
    const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
    tick();
  }), n);
  const setRender = (on) => page.evaluate((on) => window.__game.setRender(on), on);
  // capture() resolves with the canvas of the NEXT drawn frame.
  const save = async (name) => {
    const data = await page.evaluate(() => window.__game.capture());
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    return file;
  };
  const sp = await page.evaluate(() => window.__game.gen.findSpawn());
  const shore = await page.evaluate(`(${findShore.toString()})(window.__game.gen, ${sp.x}, ${sp.z})`);
  const scenes = sceneList(sp, shore, titleCamera(new WorldGen(12345), sp));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  // Go to a named scene of scenes.mjs (or a custom {pos,yaw,pitch,time,...}); waits for chunks.
  async function scene(s, { settle = 20 } = {}) {
    if (typeof s === 'string') s = scenes.find((x) => x.name === s);
    await setRender(false);
    const base = await ev((s) => {
      const g = window.__game;
      if (s.settings) g.setSettings(s.settings);
      let y = s.pos[1];
      if (s.ground) y = g.gen.heightAt(Math.floor(s.pos[0]), Math.floor(s.pos[2])) + 1;
      g.teleport(s.pos[0], y, s.pos[2], s.yaw, s.pitch);
      g.player.flying = true;
      g.setTime(s.time);
      g.player.selected = s.selected ?? 0;
      return { pos: [s.pos[0], y, s.pos[2]], yaw: s.yaw, pitch: s.pitch, time: s.time };
    }, { ...s, edits: undefined });
    await frames(3);
    const rd = await ev(() => window.__game.settings.renderDistance);
    await page.waitForFunction((r) => window.__game.loaded(r) >= 0.999, s.far ? rd : 3, { timeout: 600000, polling: 500 });
    if (s.edits) {
      await ev(({ src, base }) => {
        const g = window.__game, w = g.world, p = base || g.player.pos;
        for (const [x, y, z, id] of new Function('return ' + src)()(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]))) w.setBlock(x, y, z, id);
      }, { src: s.edits.toString(), base: s.editBase || null });
    }
    await frames(settle);
    return base;
  }
  const teleport = (p) => ev((p) => window.__game.teleport(p.pos[0], p.pos[1], p.pos[2], p.yaw, p.pitch), p);
  const setAA = (aa, scale) => ev((v) => window.__game.setSettings({ aa: v.aa, renderScale: v.scale }), { aa, scale });
  const setTime = (t) => ev((t) => window.__game.setTime(t), t);
  async function close() {
    await browser.close();
    server.close();
    console.log(errors.length ? `ERRORS: ${errors.length}` : 'no page errors');
  }
  return { page, frames, save, scene, teleport, setAA, setTime, setRender, ev, log, close, outDir, scenes, sp, shore, errors };
}
