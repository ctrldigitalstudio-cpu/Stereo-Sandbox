#!/usr/bin/env node
// TAA captures: boots index.html?test (seed 12345) once, then for every scene and every variant
// (anti-aliasing mode x render scale) renders a number of frames at a static camera and grabs the
// canvas; with --motion it then moves the camera a little every frame and grabs frames mid-motion
// (ghosting / smearing checks).
//
//   node tools/tests/taa/shots.mjs --tag cmp --scenes forest,bench --variants taa@1,fxaa@1,taa@0.5
//        [--frames 16] [--size 800x450] [--preset high] [--motion strafe|yaw|forward|pitch]
//        [--steps 8] [--grab 3,6,8] [--speed 1]
//
// Output: tools/out/taa-<tag>/<scene>-<aa>-<scale>[-m<k>].png. Exits non-zero on any page error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';
import { sceneList, findShore, titleCamera } from '../visual/scenes.mjs';
import { WorldGen } from '../../../src/worldgen.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'shot');
const [W, H] = opt('size', '800x450').split('x').map(Number);
const sceneNames = opt('scenes', 'forest').split(',');
const variants = opt('variants', 'taa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
const nFrames = Number(opt('frames', '16'));
const preset = opt('preset', null);
const motion = opt('motion', null);
const steps = Number(opt('steps', '8'));
const grab = opt('grab', String(steps)).split(',').map(Number);
const speed = Number(opt('speed', '1'));
const extra = opt('settings', null);
const outDir = path.join(root, 'tools/out', `taa-${tag}`);
fs.mkdirSync(outDir, { recursive: true });

// Extra views for anti-aliasing checks (seed 12345).
const EXTRA = [
  // Leaves against the sky, trunks, grass: the classic TAA stress test.
  { name: 'canopy', time: 0.3, pos: [15.5, 62, 28.5], yaw: 2.5, pitch: 0.35, ground: true },
  // Long straight block edges and distant ridges (high up, looking across the land).
  { name: 'ridges', time: 0.36, pos: [-40, 100, 40], yaw: 0.9, pitch: -0.12, far: true },
];

const server = await startStaticServer(root);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
if (process.env.TAA_FORCE_RGBA8) {
  // Simulate a GPU without float render targets (RGBA8 HDR fallback).
  await page.addInitScript(() => {
    const orig = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function (name) {
      if (/color_buffer_(half_)?float/i.test(name)) return null;
      return orig.call(this, name);
    };
  });
}
const errors = [];
const external = (t) => /fonts\.(googleapis|gstatic)\.com|net::ERR_/.test(t);
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !external(t)) { errors.push(t); console.log(`[console.error] ${t.slice(0, 3000)}`); }
  else if (m.type() === 'warning') console.log(`[console.warning] ${t.slice(0, 500)}`);
});
page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test${preset ? '&preset=' + preset : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
await page.evaluate(() => window.__game.play());
if (extra) await page.evaluate((p) => window.__game.setSettings(p), JSON.parse(extra));
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const setRender = (on) => page.evaluate((on) => window.__game.setRender(on), on);
const save = async (name) => {
  const data = await page.evaluate(() => window.__game.capture());
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  return path.relative(root, file);
};

const sp = await page.evaluate(() => window.__game.gen.findSpawn());
const shore = await page.evaluate(`(${findShore.toString()})(window.__game.gen, ${sp.x}, ${sp.z})`);
const all = [...sceneList(sp, shore, titleCamera(new WorldGen(12345), sp)), ...EXTRA];

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

for (const name of sceneNames) {
  const s = all.find((x) => x.name === name);
  if (!s) { console.log(`unknown scene ${name}`); continue; }
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
  await frames(s.settle || 30);
  for (const v of variants) {
    const t1 = Date.now();
    await page.evaluate((v) => window.__game.setSettings({ aa: v.aa, fxaa: v.aa === 'fxaa', renderScale: v.scale }), v);
    await page.evaluate((b) => window.__game.teleport(b.pos[0], b.pos[1], b.pos[2], b.yaw, b.pitch), base);
    await setRender(true);
    await frames(1);
    await page.evaluate(() => { window.__game.renderer.post.resetExposure = true; });
    await frames(Math.max(1, nFrames - 1));
    const id = `${name}-${v.aa}-${v.scale}`;
    const f = await save(id);
    const st = await page.evaluate(() => { const s = window.__game.renderer.stats; return `${s.renderWidth}x${s.renderHeight} -> ${s.width}x${s.height}, passes ${s.passes}`; });
    log(`${f} (${st}, ${((Date.now() - t1) / 1000).toFixed(0)}s)`);
    if (motion) {
      for (let k = 1; k <= steps; k++) {
        const p = poseAt(base, k);
        await page.evaluate((p) => window.__game.teleport(p.pos[0], p.pos[1], p.pos[2], p.yaw, p.pitch), p);
        if (grab.includes(k)) log(await save(`${id}-${motion}${k}`));
        else await frames(1);
      }
    }
    await setRender(false);
  }
  if (restore) await page.evaluate((undo) => { for (const [x, y, z, id] of undo) window.__game.world.setBlock(x, y, z, id); }, restore);
}

await browser.close();
server.close();
console.log(errors.length ? `FAILED: ${errors.length} error(s)` : 'PASSED');
process.exit(errors.length ? 1 : 0);
