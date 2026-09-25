#!/usr/bin/env node
// Portability and robustness of the shipped page:
//   dist/index.html over HTTP and from file:// (inline module + blob worker), dist/artifact.html
//   wrapped in a minimal skeleton, the WebGL2-missing fatal message, very small windows and
//   resizing mid-game (no horizontal scroll in any menu), devicePixelRatio 2, tab hidden/visible
//   and window blur while keys are held (no stuck movement).
//   node tools/tests/gameplay/portability.mjs [--only http,file,artifact,nogl,small,dpr,focus]

import { startServer, launch, newGamePage, waitReady, frames, gameSeconds, reporter, opt, sleep, outDir, root, state, LIGHT_SETTINGS, SETTINGS_KEY } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { log, check, finish } = reporter('portability');
const only = opt('only', null)?.split(',');
const want = (n) => !only || only.includes(n);
execFileSync(process.execPath, [path.join(root, 'build.mjs')], { stdio: 'inherit' });
const artifact = fs.readFileSync(path.join(root, 'dist/artifact.html'), 'utf8');
check(!/<(html|head|body)[\s>]/i.test(artifact) && !/<!doctype/i.test(artifact), 'artifact.html has no document wrapper tags');
const skeleton = `<!doctype html><html><head><meta charset="utf-8"></head><body>\n${artifact}\n</body></html>`;
const server = await startServer({ '/artifact-wrapped.html': skeleton });
const browser = await launch();
const light = { [SETTINGS_KEY]: LIGHT_SETTINGS };

// Boot a URL, Play, run a few frames of play with rendering on; returns the page for more checks.
async function bootAndPlay(name, url, opts = {}) {
  const { page, errors, ctx } = await newGamePage(browser, { width: 480, height: 270, storage: light, ...opts });
  await page.goto(url, { waitUntil: 'load' });
  await waitReady(page, 2);
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
  const info = await page.evaluate(() => ({
    blobWorker: typeof window.__WORKER_SRC__ === 'string',
    title: document.title,
    canvas: [document.getElementById('game').clientWidth, document.getElementById('game').clientHeight],
    fontsOk: document.fonts ? document.fonts.check('16px Silkscreen') : null,
  }));
  log(`${name}: ${JSON.stringify(info)}`);
  await page.click('.btn-play');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await page.keyboard.down('KeyW');
  await frames(page, 4);
  await page.keyboard.up('KeyW');
  const s = await page.evaluate(() => ({ chunks: window.__game.world.loadedCount, draws: window.__game.renderer.stats.drawCalls, meshes: window.__game.world.meshesReceived }));
  check(s.chunks > 20 && s.draws > 0, `${name}: boots, streams chunks and draws (${JSON.stringify(s)})`);
  return { page, errors, ctx, info };
}

if (want('http')) {
  const { ctx, errors, info } = await bootAndPlay('dist over http', `${server.base}/dist/index.html`);
  check(info.blobWorker && info.title === 'Stereo Sandbox', 'dist over http: single file with a blob worker');
  check(errors.length === 0, `dist over http: no page errors ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

if (want('file')) {
  const { ctx, errors, info } = await bootAndPlay('dist from file://', `file://${path.join(root, 'dist/index.html')}`);
  check(info.blobWorker, 'dist from file://: runs with the blob worker');
  check(errors.length === 0, `dist from file://: no page errors ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

if (want('artifact')) {
  const { page, ctx, errors, info } = await bootAndPlay('artifact.html in a skeleton', `${server.base}/artifact-wrapped.html`);
  check(info.canvas[0] === 480 && info.canvas[1] === 270, `artifact: the canvas fills the window (${info.canvas})`);
  check(info.title === 'Stereo Sandbox', 'artifact: <title> kept');
  const scroll = await page.evaluate(() => [document.scrollingElement.scrollWidth, document.scrollingElement.scrollHeight, innerWidth, innerHeight]);
  check(scroll[0] <= scroll[2] && scroll[1] <= scroll[3], `artifact: no page scroll (${scroll})`);
  check(errors.length === 0, `artifact: no page errors ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

if (want('nogl')) {
  const { page, ctx, errors } = await newGamePage(browser, {
    width: 480, height: 270,
    init: () => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/i.test(type) ? null : get.call(this, type, ...rest);
      };
    },
  });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('.fatal-error', { timeout: 60000 }).catch(() => null);
  const fatal = await page.evaluate(() => {
    const el = document.querySelector('.fatal-error');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return { text: el.innerText, covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, onTop: el.contains(top) };
  });
  check(fatal && /can.t start/i.test(fatal.text) && /WebGL2/.test(fatal.text) && fatal.covers && fatal.onTop, `no WebGL2: friendly fatal message (${fatal && fatal.text.split('\n')[0]})`);
  const unexpected = errors.filter((e) => !/WebGL2 not supported/.test(e));
  check(unexpected.length === 0, `no WebGL2: nothing but the WebGL error (${errors.join(' | ')})`);
  await page.screenshot({ path: path.join(outDir, 'gameplay-nogl.png') });
  await ctx.close();
}

if (want('small')) {
  const { page, ctx, errors } = await newGamePage(browser, { width: 320, height: 200, storage: light });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await waitReady(page, 2);
  const noHScroll = (where) => page.evaluate(() => [document.scrollingElement.scrollWidth, innerWidth]).then(([sw, w]) => check(sw <= w, `320x200 ${where}: no horizontal scroll (${sw} / ${w})`));
  const playBox = await page.evaluate(() => { const r = document.querySelector('.btn-play').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
  check(playBox[0] >= 0 && playBox[2] <= 320 && playBox[1] >= 0 && playBox[3] <= 200, `320x200 title: Play button on screen (${playBox.map(Math.round)})`);
  await noHScroll('title');
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
  await page.click('.btn-play');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await frames(page, 2);
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => window.__game.ui.inventoryOpen);
  await noHScroll('inventory');
  // Too short for the whole panel: it scrolls, so the hotbar and Done stay reachable.
  const inv = await page.evaluate(() => { const p = document.querySelector('.inventory-panel'); return { sh: p.scrollHeight, ch: p.clientHeight, oy: getComputedStyle(p).overflowY }; });
  check(inv.sh <= inv.ch || inv.oy === 'auto', `320x200 inventory: panel scrolls when it doesn't fit (${JSON.stringify(inv)})`);
  await page.click('.inv-hotbar .inv-slot:nth-child(3)');
  check(await page.evaluate(() => window.__game.player.selected === 2), '320x200 inventory: hotbar slots reachable');
  await page.click('.btn-done');
  check(await page.evaluate(() => !window.__game.ui.inventoryOpen), '320x200 inventory: Done reachable');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__game.state === 'paused');
  await noHScroll('pause');
  await page.click('.pause-panel .menu-row .btn:first-child');
  await noHScroll('settings');
  await page.keyboard.press('Escape');
  // Resize mid-game (several times, including a tiny one) and keep playing.
  await page.click('.pause-panel .btn-primary');
  await page.waitForFunction(() => window.__game.state === 'playing');
  for (const [w, h] of [[1024, 600], [200, 150], [640, 360]]) {
    await page.setViewportSize({ width: w, height: h });
    await frames(page, 3);
    const r = await page.evaluate(() => ({ cw: window.__game.renderer.width, ch: window.__game.renderer.height, css: [innerWidth, innerHeight], dpr: devicePixelRatio, rw: window.__game.renderer.renderWidth }));
    check(r.cw === Math.round(w * Math.min(r.dpr, 1.5)) && r.ch === Math.round(h * Math.min(r.dpr, 1.5)) && r.rw > 0, `resize to ${w}x${h}: canvas ${r.cw}x${r.ch}, render width ${r.rw}`);
  }
  check(errors.length === 0, `small / resize: no page errors ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

if (want('dpr')) {
  const { page, ctx, errors } = await newGamePage(browser, { width: 480, height: 270, dpr: 2, storage: light });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await waitReady(page, 2);
  await frames(page, 2);
  const r = await page.evaluate(() => ({ dpr: devicePixelRatio, w: window.__game.renderer.width, h: window.__game.renderer.height, cw: document.getElementById('game').width }));
  check(r.dpr === 2 && r.w === 720 && r.h === 405, `DPR 2: backing store capped at 1.5x (${JSON.stringify(r)})`);
  const icon = await page.evaluate(() => { const i = document.querySelector('.hotbar .slot img'); return i && [i.naturalWidth, i.getBoundingClientRect().width]; });
  log(`DPR 2: hotbar icon natural/css width ${icon}`);
  await page.screenshot({ path: path.join(outDir, 'gameplay-dpr2-title.png'), timeout: 120000 }).catch(() => null);
  check(errors.length === 0, `DPR 2: no page errors ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

if (want('focus')) {
  const { page, ctx, errors } = await newGamePage(browser, { width: 480, height: 270, storage: { ...light, 'stereo-sandbox.save.v1': { seed: 12345 } } });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await waitReady(page, 2);
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
  await page.click('.btn-play');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await page.evaluate(() => {
    // A flat stone floor high above the terrain, so nothing but the keys decides the motion.
    const g = window.__game, s = g.gen.findSpawn(), w = g.world;
    const x0 = Math.floor(s.x), z0 = Math.floor(s.z);
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) w.setBlock(x0 + dx, 100, z0 + dz, 1);
    g.setRender(false);
    g.teleport(x0 + 0.5, 101, z0 + 8.5, 0, 0);
    g.player.flying = false;
  });
  await sleep(300);
  // Window blur while W is held: movement must stop although no keyup ever arrives.
  await page.keyboard.down('KeyW');
  await sleep(400);
  const moving = await page.evaluate(() => Math.hypot(window.__game.player.vel[0], window.__game.player.vel[2]));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await gameSeconds(page, 0.8);   // simulated time: frames can lag behind the wall clock here
  const a = await page.evaluate(() => window.__game.player.pos.slice());
  await gameSeconds(page, 0.5);
  const b = await page.evaluate(() => window.__game.player.pos.slice());
  const drift = Math.hypot(b[0] - a[0], b[2] - a[2]);
  check(moving > 1.5 && drift < 1e-3, `blur while W held stops the player (speed before ${moving.toFixed(2)}, drift after ${drift.toFixed(4)})`);
  await page.keyboard.up('KeyW');
  // Pressing W again afterwards works normally.
  await page.keyboard.down('KeyW');
  await sleep(500);
  await page.keyboard.up('KeyW');
  const c = await page.evaluate(() => window.__game.player.pos.slice());
  check(Math.hypot(c[0] - b[0], c[2] - b[2]) > 0.3, `W works again after the blur (${Math.hypot(c[0] - b[0], c[2] - b[2]).toFixed(2)} m)`);
  // Held mouse button (drag-look hold or locked) is released by blur too.
  await page.evaluate(() => { window.__game.player.input.buttons[0] = true; window.dispatchEvent(new Event('blur')); });
  check(await page.evaluate(() => !window.__game.player.input.buttonDown(0)), 'blur releases held mouse buttons');
  // Tab hidden: the game saves; visible again: resumes without a time jump or stuck keys.
  await page.keyboard.down('KeyD');
  await sleep(200);
  const hidden = await page.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    localStorage.removeItem('stereo-sandbox.save.v1');
    document.dispatchEvent(new Event('visibilitychange'));
    const saved = !!localStorage.getItem('stereo-sandbox.save.v1');
    const keys = window.__game.player.input.keys.size;
    delete document.hidden;
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    return { saved, keys };
  });
  check(hidden.saved && hidden.keys === 0, `tab hidden: saves and releases held keys (${JSON.stringify(hidden)})`);
  await page.keyboard.up('KeyD');
  const t0 = await page.evaluate(() => window.__game.player.time);
  await frames(page, 5);
  const t1 = await page.evaluate(() => window.__game.player.time);
  check(t1 - t0 < 0.6, `visible again: simulation continues in small steps (${(t1 - t0).toFixed(3)} s over 5 frames)`);
  check((await state(page)).state === 'playing', 'still playing after hide/show');
  check(errors.length === 0, `focus: no page errors ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

await browser.close();
server.close();
process.exit(finish());
