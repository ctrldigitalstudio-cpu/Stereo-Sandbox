#!/usr/bin/env node
// Long-session growth: travel ~80 chunks across the world, break blocks all the way (particles,
// sounds), open and close the inventory, pause menu and settings many times, then check that
// nothing accumulates: held chunks stay within the streaming radius, GPU meshes match them, no
// unload bookkeeping is left behind, particles and toasts are bounded, the DOM doesn't grow, and
// the JS heap (after GC) stays flat.
//   node tools/tests/gameplay/soak.mjs

import { startServer, launch, newGamePage, waitReady, frames, reporter, sleep, LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY } from './lib.mjs';

const { log, check, finish } = reporter('soak');
const server = await startServer();
const browser = await launch(['--js-flags=--expose-gc']);
const { page, errors } = await newGamePage(browser, { width: 400, height: 225, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 4242 } } });

await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await waitReady(page, 2);
await page.evaluate(() => window.__game.setRender(false));
await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
await page.click('.btn-play');
await page.waitForFunction(() => window.__game.state === 'playing');

const measure = () => page.evaluate(() => {
  if (window.gc) window.gc();
  const g = window.__game;
  return {
    heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
    dom: document.getElementsByTagName('*').length,
    chunks: g.world.loadedCount, gpu: g.renderer.terrain.chunks.size, unloading: g.world._unloading.size,
    particles: g.particles.count, toasts: document.querySelectorAll('.toast').length,
    edits: [...g.world.edits.values()].reduce((n, m) => n + m.size, 0),
  };
});
const cycleMenus = async () => {
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => window.__game.ui.inventoryOpen);
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => !window.__game.ui.inventoryOpen);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__game.state === 'paused');
  await page.click('.pause-panel .menu-row .btn:first-child');
  await page.keyboard.press('Escape');
  await page.click('.pause-panel .btn-primary');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await sleep(450);   // clicks right after Resume are ignored (double-click guard)
};

// Warm up (icons, shaders, first chunks), then take the baseline.
await cycleMenus();
await frames(page, 30);
const base = await measure();
log(`baseline ${JSON.stringify(base)}`);

const start = await page.evaluate(() => window.__game.player.pos.slice());
const HOPS = 40;
for (let i = 1; i <= HOPS; i++) {
  await page.evaluate(([x, z]) => {
    const g = window.__game;
    g.teleport(x, 110, z, 0, -1.5707);
  }, [start[0] + i * 32, start[2] + (i % 2) * 20]);
  await frames(page, 3);
  await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { polling: 100, timeout: 120000 });
  // Dig straight down a few blocks: particles, sounds, edits, re-meshes.
  await page.evaluate(() => {
    const g = window.__game, p = g.player;
    let y = 127;
    const x = Math.floor(p.pos[0]), z = Math.floor(p.pos[2]);
    while (y > 0 && g.world.getBlock(x, y, z) <= 0) y--;
    g.teleport(p.pos[0], y + 1.5, p.pos[2], 0, -1.5707);
  });
  for (let k = 0; k < 3; k++) { await page.mouse.click(200, 112); await frames(page, 2); }
  if (i % 8 === 0) {
    await cycleMenus();
    const m = await measure();
    log(`hop ${i}: ${JSON.stringify(m)}`);
  }
}
await frames(page, 60);
await sleep(2000);
const end = await measure();
log(`end ${JSON.stringify(end)}`);

const maxHeld = Math.ceil(Math.PI * (4 + 2.5) ** 2);
check(end.chunks <= maxHeld, `held chunks bounded by the streaming radius (${end.chunks} <= ${maxHeld})`);
check(end.gpu === end.chunks, `GPU meshes == held chunks (${end.gpu} / ${end.chunks})`);
check(end.unloading === 0, `no unload bookkeeping left over (${end.unloading})`);
check(end.particles < 2048, `particles bounded (${end.particles})`);
check(end.toasts <= 4, `toasts bounded (${end.toasts})`);
check(end.edits >= HOPS, `edits recorded along the way (${end.edits})`);
check(end.dom <= base.dom + 10, `DOM doesn't grow (${base.dom} -> ${end.dom})`);
const growMB = (end.heap - base.heap) / 1048576;
check(!end.heap || growMB < 12, `JS heap after GC roughly flat (${(base.heap / 1048576).toFixed(1)} -> ${(end.heap / 1048576).toFixed(1)} MB)`);
check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
server.close();
process.exit(finish());
