#!/usr/bin/env node
// One-shot visual captures (no live session): boots index.html?test (seed 12345) and grabs the
// named scenes of scenes.mjs into tools/out/visual-<tag>-<scene>.png. Use it to check a quality
// preset end to end (live.mjs keeps the ?test settings):
//
//   node tools/tests/visual/shoot.mjs --preset low --only afternoon,torches --tag low [--size 800x450]
//
// Exits non-zero on any page error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';
import { sceneList, findShore, titleCamera } from './scenes.mjs';
import { WorldGen } from '../../../src/worldgen.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'shot');
const [W, H] = opt('size', '800x450').split('x').map(Number);
const only = (opt('only', 'afternoon')).split(',');
const preset = opt('preset', null);
const outDir = path.join(root, 'tools/out');
fs.mkdirSync(outDir, { recursive: true });

const server = await startStaticServer(root);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
const external = (t) => /fonts\.(googleapis|gstatic)\.com|net::ERR_/.test(t);
page.on('console', (m) => {
  if (m.type() === 'error' && !external(m.text())) { errors.push(m.text()); console.log(`[console.error] ${m.text().slice(0, 3000)}`); }
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
const setRender = (on) => page.evaluate((on) => { if (window.__game.setRender) window.__game.setRender(on); }, on);

const sp = await page.evaluate(() => window.__game.gen.findSpawn());
const shore = await page.evaluate(`(${findShore.toString()})(window.__game.gen, ${sp.x}, ${sp.z})`);
const all = sceneList(sp, shore, titleCamera(new WorldGen(12345), sp));
for (const name of only) {
  const s = all.find((x) => x.name === name);
  if (!s) { console.log(`unknown scene ${name}`); continue; }
  await setRender(false);
  await page.evaluate((s) => {
    const g = window.__game;
    let y = s.pos[1];
    if (s.ground) y = g.gen.heightAt(Math.floor(s.pos[0]), Math.floor(s.pos[2])) + 1;
    g.teleport(s.pos[0], y, s.pos[2], s.yaw, s.pitch);
    g.player.flying = true;
    g.setTime(s.time);
    g.player.selected = s.selected ?? 0;
  }, { ...s, edits: undefined });
  await frames(3);
  const rd = await page.evaluate(() => window.__game.settings.renderDistance);
  await page.waitForFunction((r) => window.__game.loaded(r) >= 0.999, s.far ? rd : 3, { timeout: 600000, polling: 500 });
  if (s.edits) {
    await page.evaluate(({ src, base }) => {
      const g = window.__game, w = g.world, p = base || g.player.pos;
      for (const [x, y, z, id] of new Function('return ' + src)()(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]))) w.setBlock(x, y, z, id);
    }, { src: s.edits.toString(), base: s.editBase || null });
  }
  await frames(s.settle || 30);
  await setRender(true);
  await frames(1);
  await page.evaluate(() => { window.__game.renderer.post.resetExposure = true; });
  await frames(2);
  const data = await page.evaluate(() => window.__game.capture());
  const file = path.join(outDir, `visual-${tag}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  const st = await page.evaluate(() => {
    const s = window.__game.renderer.stats;
    return `${s.renderWidth}x${s.renderHeight} chunks ${s.chunks} quads ${s.quads} passes ${s.passes} gpuMs ${(s.gpuMs || 0).toFixed(0)}`;
  });
  log(`${name}: ${path.relative(root, file)} (${st})`);
}

await browser.close();
server.close();
console.log(errors.length ? `FAILED: ${errors.length} error(s)` : 'PASSED');
process.exit(errors.length ? 1 : 0);
