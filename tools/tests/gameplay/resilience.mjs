#!/usr/bin/env node
// Hostile or unusual environments:
//   csp      a host CSP that refuses blob: workers -> the world runs on the page, the game plays
//   fonts    fonts.googleapis.com hanging for 20 s doesn't hold up the boot
//   touch    a touch-only device: Play explains instead of trapping the player, taps break nothing
//   adapt    adaptive resolution keeps full resolution under a 30 Hz rAF cap, but still steps
//            down when frames really are fill-bound
//   motion   prefers-reduced-motion: the title camera only pans (no bob, no sway)
//   paused   the paused game redraws ~10 times a second, not every frame
//   node tools/tests/gameplay/resilience.mjs [--only csp,fonts,touch,adapt,motion,paused]

import { startServer, launch, newGamePage, waitReady, frames, reporter, opt, sleep, root, LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { log, check, finish } = reporter('resilience');
const only = opt('only', null)?.split(',');
const want = (n) => !only || only.includes(n);
execFileSync(process.execPath, [path.join(root, 'build.mjs')], { stdio: 'inherit' });
const dist = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const server = await startServer({
  '/csp.html': { body: dist, headers: { 'Content-Security-Policy': "worker-src 'self'" } },
});
const browser = await launch();
const storage = { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 12345 } };
const cspNoise = (e) => /Refused to create a worker|Content Security Policy/.test(e);

if (want('csp')) {
  const { page, ctx, errors } = await newGamePage(browser, { width: 400, height: 225, storage });
  await page.goto(`${server.base}/csp.html`, { waitUntil: 'load' });
  await waitReady(page, 2);
  const local = await page.evaluate(() => !!window.__game.world.worker.local);
  check(local, 'blob: worker refused -> world generation runs on the page');
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
  await page.click('.btn-play');
  await page.waitForFunction(() => window.__game.state === 'playing');
  const m0 = await page.evaluate(() => {
    const g = window.__game, p = g.player;
    g.world.setBlock(Math.floor(p.pos[0]) + 2, Math.floor(p.pos[1]) + 3, Math.floor(p.pos[2]), 29);
    return g.world.meshesReceived;
  });
  await page.waitForFunction((m) => window.__game.world.meshesReceived > m, m0, { timeout: 30000 }).catch(() => null);
  check(await page.evaluate((m) => window.__game.world.meshesReceived > m, m0), 'edits re-mesh through the on-page world');
  const bad = errors.filter((e) => !cspNoise(e));
  check(bad.length === 0, `csp: no errors besides the refusal itself ${bad.slice(0, 2).join(' | ')}`);
  await ctx.close();
}

if (want('fonts')) {
  const { page, ctx, errors } = await newGamePage(browser, { width: 400, height: 225, storage });
  await ctx.unroute(/fonts\.(googleapis|gstatic)\.com/);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, async (r) => { await sleep(20000); await r.abort().catch(() => {}); });
  const t0 = Date.now();
  await page.goto(`${server.base}/dist/index.html`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__game, null, { timeout: 60000, polling: 100 });
  const booted = (Date.now() - t0) / 1000;
  check(booted < 12, `fonts hanging for 20 s: the game booted after ${booted.toFixed(1)} s`);
  await ctx.close();
}

if (want('touch')) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((storage) => { for (const k in storage) if (localStorage.getItem(k) == null) localStorage.setItem(k, JSON.stringify(storage[k])); }, storage);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await waitReady(page, 2);
  await page.evaluate(() => {
    window.__game.setRender(false);
    const ui = window.__game.ui, toast = ui.toast.bind(ui);
    window.__toasts = [];
    ui.toast = (m, ms) => { window.__toasts.push(String(m)); return toast(m, ms); };
  });
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.touch-note')).display !== 'none'), 'touch-only: the title explains keyboard + mouse are needed');
  await page.tap('.btn-play');
  await sleep(500);
  const st = await page.evaluate(() => ({ state: window.__game.state, toasts: window.__toasts }));
  check(st.state === 'title' && st.toasts.some((t) => /keyboard and mouse/.test(t)), `touch-only: Play explains instead of starting (${JSON.stringify(st)})`);
  // Even in play (test mode can enter it; hybrid devices can), a tap is not a click on a block.
  await page.goto(`${server.base}/index.html?test`, { waitUntil: 'load' });
  await waitReady(page, 2);
  await page.evaluate(() => { const g = window.__game; g.setRender(false); g.play(); g.player.pitch = -1.4; });
  await sleep(500);
  await frames(page, 3);
  await sleep(500);
  const target = await page.evaluate(() => window.__game.player.target);
  await page.tap('#game', { position: { x: 180, y: 320 } });
  await frames(page, 3);
  check(!!target && await page.evaluate(() => window.__game.world.edits.size === 0), 'a tap on the view breaks nothing');
  await ctx.close();
}

if (want('adapt')) {
  // Headless Chromium slows every frame down while the pointer is locked: measure without it.
  const noLock = () => { Element.prototype.requestPointerLock = function () { return Promise.reject(new DOMException('denied', 'NotAllowedError')); }; };
  // (a) rAF capped at 30 Hz, frames cheap: full resolution must stay.
  const capped = () => {
    const raf = window.requestAnimationFrame.bind(window);
    let next = 0;
    window.requestAnimationFrame = (cb) => {
      const now = performance.now();
      next = Math.max(next + 33.3, now);
      return setTimeout(() => raf(cb), Math.max(0, next - now));
    };
    Element.prototype.requestPointerLock = function () { return Promise.reject(new DOMException('denied', 'NotAllowedError')); };
  };
  {
    const { page, ctx } = await newGamePage(browser, { width: 320, height: 180, init: capped, storage });
    await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
    await waitReady(page, 2);
    await page.evaluate(() => { const g = window.__game; g.setRender(false); g.play(); g.setSettings({ autoResolution: true, renderScale: 1 }); });
    const samples = [];
    for (let i = 0; i < 16; i++) { await sleep(1000); samples.push(await page.evaluate(() => window.__game.renderScale)); }
    log(`30 Hz cap: render scale ${samples.map((v) => v.toFixed(2)).join(' ')}`);
    check(Math.min(...samples) >= 0.8 - 1e-6 && samples[samples.length - 1] === 1, 'rAF capped at 30 Hz: full resolution stays (a short probe is undone)');
    await ctx.close();
  }
  // (b) Frames really cost more at higher resolution: it steps down.
  {
    const { page, ctx } = await newGamePage(browser, { width: 320, height: 180, init: noLock, storage });
    await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
    await waitReady(page, 2);
    await page.evaluate(() => {
      const g = window.__game, r = g.renderer;
      r.render = () => { const end = performance.now() + 90 * r.settings.renderScale ** 2; while (performance.now() < end); };
      g.play();
      g.setSettings({ autoResolution: true, renderScale: 1 });
    });
    await sleep(14000);
    const scale = await page.evaluate(() => window.__game.renderScale);
    check(scale <= 0.8 + 1e-6, `fill-bound frames: render scale stepped down to ${scale.toFixed(2)}`);
    await ctx.close();
  }
}

if (want('motion')) {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 180 }, reducedMotion: 'reduce' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${server.base}/index.html?test`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
  const cam = await page.evaluate(() => [0, 7, 22, 45].map((t) => { const c = window.__game.titleCameraAt(t); return [c.pos[1], c.pitch, c.yaw]; }));
  check(cam.every((c) => c[0] === cam[0][0] && c[1] === cam[0][1]) && cam[3][2] !== cam[0][2], `reduced motion: the title camera pans without bobbing or swaying (${JSON.stringify(cam.map((c) => c.map((v) => +v.toFixed(3))))})`);
  await ctx.close();
}

if (want('paused')) {
  const { page, ctx } = await newGamePage(browser, { width: 320, height: 180, storage });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await waitReady(page, 2);
  await page.evaluate(() => {
    const r = window.__game.renderer;
    window.__draws = 0;
    r.render = () => { window.__draws++; };   // count draws; no GL work
  });
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
  await page.click('.btn-play');
  await page.waitForFunction(() => window.__game.state === 'playing');
  const count = async () => { const a = await page.evaluate(() => [window.__draws, window.__game.frame]); await sleep(2000); const b = await page.evaluate(() => [window.__draws, window.__game.frame]); return [b[0] - a[0], b[1] - a[1]]; };
  const playing = await count();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__game.state === 'paused');
  const paused = await count();
  log(`draws / frames over 2 s: playing ${playing}, paused ${paused}`);
  check(playing[0] === playing[1] && paused[0] <= 25 && paused[1] > paused[0] * 2, 'paused: ~10 draws a second instead of every frame');
  await page.click('.pause-panel .menu-row .btn:first-child');
  const d0 = await page.evaluate(() => window.__draws);
  await page.click('#setting-bloom');
  await page.waitForFunction((d) => window.__draws > d, d0, { timeout: 2000 }).catch(() => null);
  check(await page.evaluate((d) => window.__draws > d, d0), 'a settings change redraws right away');
  await ctx.close();
}

await browser.close();
server.close();
process.exit(finish());
