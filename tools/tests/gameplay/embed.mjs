#!/usr/bin/env node
// The game inside sandboxed iframes, the way an Artifact host embeds it:
//   - sandbox="allow-scripts allow-same-origin" (no allow-pointer-lock), dev modules and dist build
//   - sandbox="allow-scripts" (opaque origin: localStorage throws), dist build (inline module +
//     blob worker)
// Each: boots, Play works, drag-look turns the view, keys reach the game after clicking into it,
// hold-to-break works, the game keeps running with saving silently disabled, no page errors.
//   node tools/tests/gameplay/embed.mjs [--only same,dist-same,dist-opaque]

import { startServer, launch, routeFonts, watchErrors, reporter, opt, sleep, outDir, root } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const { log, check, finish } = reporter('embed');
const only = opt('only', null)?.split(',');
execFileSync(process.execPath, [path.join(root, 'build.mjs')], { stdio: 'inherit' });

const harness = (src, sandbox) => `<!doctype html><html><head><meta charset="utf-8"><title>Embed harness</title>
<style>html,body{margin:0;height:100%;background:#222}header{height:40px;color:#ccc;font:14px sans-serif;display:flex;align-items:center;padding:0 12px}
iframe{display:block;width:100%;height:calc(100% - 40px);border:0}</style></head>
<body><header>Host page · ${sandbox || 'no sandbox'}</header><iframe id="game" ${sandbox == null ? '' : `sandbox="${sandbox}"`} src="${src}"></iframe></body></html>`;
const server = await startServer({
  '/embed-same.html': harness('/index.html', 'allow-scripts allow-same-origin'),
  '/embed-dist-same.html': harness('/dist/index.html', 'allow-scripts allow-same-origin'),
  '/embed-dist-opaque.html': harness('/dist/index.html', 'allow-scripts'),
});
const browser = await launch();
const W = 560, H = 360;

async function run(name, url, { opaque }) {
  log(`--- ${name}: ${url}`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  await routeFonts(ctx);
  // Light settings for software GL (only reachable when storage works; the opaque frame uses defaults
  // and is lightened through the test hook below).
  await ctx.addInitScript(() => {
    try {
      if (window.top !== window && !localStorage.getItem('stereo-sandbox.settings.v1')) {
        localStorage.setItem('stereo-sandbox.settings.v1', JSON.stringify({ preset: 'custom', renderDistance: 4, renderScale: 0.5, autoResolution: false, shadows: false, volumetrics: 0, clouds: 0, ssr: 0, fxaa: false }));
      }
    } catch (e) { /* opaque origin */ }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  const errors = watchErrors(page, `[${name}] `);
  const lockMessages = [];
  page.on('console', (m) => { if (/pointer lock/i.test(m.text())) lockMessages.push(`${m.type()}: ${m.text()}`); });
  await page.goto(`${server.base}${url}`, { waitUntil: 'load' });
  const frameEl = await page.waitForSelector('iframe');
  const frame = await frameEl.contentFrame();
  await frame.waitForFunction(() => window.__game, null, { timeout: 120000 });
  const storage = await frame.evaluate(() => { try { localStorage.getItem('x'); return 'ok'; } catch (e) { return e.name; } });
  check(opaque ? storage !== 'ok' : storage === 'ok', `${name}: localStorage ${storage}`);
  await frame.evaluate(() => {
    window.__game.setSettings({ shadows: false, volumetrics: 0, clouds: 0, ssr: 0, renderDistance: 4, renderScale: 0.5, fxaa: false, autoResolution: false });
  });
  await frame.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { timeout: 300000, polling: 250 });
  const box = await frameEl.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await frame.click('.btn-play');
  await frame.waitForFunction(() => window.__game.state === 'playing');
  await sleep(2000);   // the lock attempt fails asynchronously
  const st = await frame.evaluate(() => ({ drag: window.__game.player.input.dragLook, locked: window.__game.player.input.locked, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }));
  check(st.drag && !st.locked, `${name}: no pointer lock in the sandbox -> drag-look (${JSON.stringify(st)})`);
  await frame.evaluate(() => window.__game.setRender(false));

  // Drag to look.
  const y0 = await frame.evaluate(() => window.__game.player.yaw);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(cx - i * 12, cy); await sleep(16); }
  await page.mouse.up();
  await sleep(200);
  const y1 = await frame.evaluate(() => window.__game.player.yaw);
  check(Math.abs(y1 - y0 - 60 * 0.0022) < 0.01, `${name}: dragging left turns left (dyaw ${(y1 - y0).toFixed(3)})`);

  // Keys reach the game once the frame has focus (it got it from the clicks).
  const hasFocus = await frame.evaluate(() => document.hasFocus());
  check(hasFocus, `${name}: the iframe has keyboard focus after clicking into it`);
  const p0 = await frame.evaluate(() => { const g = window.__game, s = g.gen.findSpawn(); g.teleport(s.x + 0.5, s.y + 0.2, s.z + 0.5, 0.6, 0); g.player.flying = false; return g.player.pos.slice(); });
  await sleep(300);
  await page.keyboard.down('KeyW');
  await sleep(600);
  await page.keyboard.up('KeyW');
  const p1 = await frame.evaluate(() => window.__game.player.pos.slice());
  const moved = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  check(moved > 1, `${name}: W moves the player (${moved.toFixed(2)} m)`);
  await page.keyboard.press('Digit4');
  await sleep(100);
  check(await frame.evaluate(() => window.__game.player.selected === 3), `${name}: digit keys select hotbar slots`);
  await page.keyboard.press('KeyE');
  await frame.waitForFunction(() => window.__game.ui.inventoryOpen, null, { timeout: 5000 }).catch(() => null);
  check(await frame.evaluate(() => window.__game.ui.inventoryOpen), `${name}: E opens the inventory`);
  await page.keyboard.press('KeyE');
  await sleep(200);
  check(await frame.evaluate(() => !window.__game.ui.inventoryOpen && window.__game.state === 'playing'), `${name}: E closes it again`);

  // Hold to break (drag-look: a still press becomes a held button).
  await frame.evaluate(() => { const p = window.__game.player; p.pitch = -1.5; p.flying = true; p.vel = [0, 0, 0]; });
  await sleep(200);
  const e0 = await frame.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await sleep(1400);
  await page.mouse.up();
  const e1 = await frame.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
  check(e1 - e0 >= 3, `${name}: holding the mouse breaks repeatedly (${e1 - e0} blocks)`);

  // Press inside the frame, drag out over the host page and let go there: no stuck drag or hold.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await sleep(400);                                   // becomes a held button (hold-to-break)
  await page.mouse.move(cx, 20, { steps: 4 });        // over the host page's header
  await page.mouse.up();
  await page.mouse.move(cx + 40, cy + 30, { steps: 4 });   // back over the game, no button
  await sleep(300);
  const stuck = await frame.evaluate(() => { const i = window.__game.player.input; return { gesture: !!i._gesture, held: i.buttons.some(Boolean) }; });
  check(!stuck.gesture && !stuck.held, `${name}: releasing the mouse outside the frame ends the drag / hold (${JSON.stringify(stuck)})`);
  const yawA = await frame.evaluate(() => window.__game.player.yaw);
  await page.mouse.move(cx - 60, cy, { steps: 4 });
  await sleep(200);
  check(await frame.evaluate((a) => window.__game.player.yaw === a, yawA), `${name}: moving without a button afterwards doesn't turn the view`);

  // Pause + resume inside the frame, draw a few frames, the game keeps running without storage.
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => window.__game.state === 'paused', null, { timeout: 5000 }).catch(() => null);
  check(await frame.evaluate(() => window.__game.state === 'paused'), `${name}: Escape pauses`);
  await frame.click('.pause-panel .btn-primary');
  await sleep(1500);
  check(await frame.evaluate(() => window.__game.state === 'playing'), `${name}: Resume`);
  const toastCount = await frame.evaluate(() => [...document.querySelectorAll('.toast:not(.is-leaving)')].length);
  check(toastCount <= 1, `${name}: the lock warning is not repeated on every resume (${toastCount} toasts)`);
  await frame.evaluate(() => window.__game.setRender(true));
  const f0 = await frame.evaluate(() => window.__game.frame);
  await frame.waitForFunction((f) => window.__game.frame > f + 3, f0, { polling: 100 });
  await page.screenshot({ path: path.join(outDir, `gameplay-embed-${name}.png`), timeout: 120000 }).catch((e) => log(`screenshot failed: ${e.message.split('\n')[0]}`));
  log(`${name}: pointer lock console messages: ${JSON.stringify(lockMessages)}`);
  check(errors.length === 0, `${name}: no page errors (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

if (!only || only.includes('same')) await run('same', '/embed-same.html', { opaque: false });
if (!only || only.includes('dist-same')) await run('dist-same', '/embed-dist-same.html', { opaque: false });
if (!only || only.includes('dist-opaque')) await run('dist-opaque', '/embed-dist-opaque.html', { opaque: true });

await browser.close();
server.close();
process.exit(finish());
