#!/usr/bin/env node
// Drives the real game (index.html?test) to check the UI <-> main.js contract with real key
// events: E opens/closes the inventory exactly once, Escape pauses, the UI's own Escape handling
// in Settings, clicking inventory blocks updates player.hotbar. Uses low settings so SwiftShader
// keeps up, and screenshots the UI over the live world.
//   node tools/tests/ui/game.mjs [--size 800x450]

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const [W, H] = opt('size', '640x360').split('x').map(Number);
const outDir = path.join(root, 'tools/out');
const fontCache = path.join(outDir, 'fontcache');
fs.mkdirSync(fontCache, { recursive: true });

const server = await startStaticServer(root);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-proxy-server'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
  const url = route.request().url();
  const file = path.join(fontCache, url.replace(/[^a-z0-9]+/gi, '_').slice(-180));
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, execFileSync('curl', ['-sSfL', '-A', route.request().headers()['user-agent'], url]));
    await route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': url.includes('/css') ? 'text/css' : 'font/woff2', 'access-control-allow-origin': '*' } });
  } catch (e) { await route.abort(); }
});
await ctx.addInitScript(() => {
  localStorage.setItem('blockvale.settings.v1', JSON.stringify({
    preset: 'low', renderDistance: 4, renderScale: 0.5, shadows: false, volumetrics: 0, clouds: 0, ssr: 0, fxaa: false, autoResolution: false,
  }));
});
const page = await ctx.newPage();
page.setDefaultTimeout(240000);   // SwiftShader frames take seconds; input waits for them
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') { errors.push(m.text()); console.log(`[console.error] ${m.text()}`); }
  else if (m.type() === 'warning') console.log(`[console.warn] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const shot = async (name) => {
  const file = path.join(outDir, `ui-game-${name}.png`);
  await page.screenshot({ path: file, timeout: 120000 });
  log(`shot ${path.relative(root, file)}`);
};
const state = () => page.evaluate(() => ({
  state: window.__game.state, screen: window.__game.ui.screen, inv: window.__game.ui.inventoryOpen, menu: window.__game.ui.menuOpen,
}));

await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
log('game ready');
await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 300000, polling: 1000 });
await frames(4);
const f0 = await page.evaluate(() => window.__game.frame);
await page.waitForTimeout(5000);
log(`terrain loaded; ${((await page.evaluate(() => window.__game.frame)) - f0) / 5} fps`);
let s = await state();
ok(s.state === 'title' && s.screen === 'title' && s.menu, 'boots into the title screen');
ok(await page.evaluate(() => !window.__game.ui.el.play.disabled), 'Play enabled once loaded');
ok(await page.evaluate(() => !document.querySelector('#ui .boot')), 'boot splash removed');
await shot('title');

// Settings from the title, closed with the UI's own Escape handling.
await page.click('.title-screen .menu-row .btn:first-child');
await frames(1);
ok((await state()).screen === 'settings', 'Settings opens from the title');
await page.click('#settings-tab-world');
await page.click('#setting-cloudCoverage', { position: { x: 4, y: 14 } });
await frames(1);
const cc = await page.evaluate(() => window.__game.settings.cloudCoverage);
ok(cc === 0, `range click applies live through onSettingsChange (cloudCoverage ${cc})`);
await shot('settings');
await page.keyboard.press('Escape');
await frames(1);
ok((await state()).screen === 'title', 'Escape in Settings returns to the title');

// Play (pointer lock fails headless -> drag-look + toast).
await page.click('.btn-play');
await frames(3);
s = await state();
ok(s.state === 'playing' && s.screen === null && !s.menu, 'Play starts the game and hides the title');
await page.mouse.move(W / 2, H / 2);

// E through main.js: opens exactly once, E again closes.
await page.keyboard.press('KeyE');
await frames(2);
s = await state();
ok(s.inv && s.menu && s.state === 'playing', 'E opens the inventory (main.js), UI does not double-toggle');
await shot('inventory');
const before = await page.evaluate(() => window.__game.player.hotbar.slice());
const sel = await page.evaluate(() => window.__game.player.selected);
await page.click('.inv-item[aria-label="Diamond Ore"]');
await frames(1);
const after = await page.evaluate(() => window.__game.player.hotbar.slice());
ok(after[sel] !== before[sel] && after[sel] === await page.evaluate(() => window.__game.ui.hotbar[window.__game.player.selected]), 'clicking a block updates player.hotbar via onHotbarChange');
await page.click('.inv-hotbar .inv-slot:nth-child(6)');
await frames(2);
ok(await page.evaluate(() => window.__game.player.selected === 5 && window.__game.ui.selected === 5), 'clicking an inventory slot selects it in the player');
await page.click('.search-input');
await page.keyboard.type('e');
await frames(2);
s = await state();
ok(s.inv, 'typing E in the search box does not close the inventory');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await frames(2);
s = await state();
ok(s.inv, 'Escape in the search box clears / leaves the field only');
await page.keyboard.press('Escape');
await frames(2);
s = await state();
ok(!s.inv && s.state === 'playing', 'Escape outside the field closes the inventory (main.js)');
await page.keyboard.press('KeyE');
await frames(2);
await page.keyboard.press('KeyE');
await frames(2);
s = await state();
ok(!s.inv && !s.menu, 'E toggles closed again');

// F3 debug + F1 hide HUD through main.js.
await page.keyboard.press('F3');
await frames(4);
await page.waitForTimeout(300);
await frames(2);
ok(await page.evaluate(() => !window.__game.ui.el.debug.hidden && /\d/.test(window.__game.ui._debugRows.xyz.textContent)), 'F3 shows the debug panel with values');
await shot('hud-debug');
await page.keyboard.press('F1');
await frames(2);
ok(await page.evaluate(() => window.__game.ui.el.hotbar.hidden && window.__game.ui.el.crosshair.hidden), 'F1 hides the HUD');
await page.keyboard.press('F1');
await page.keyboard.press('F3');
await frames(2);

// Escape pauses (no pointer lock in headless, so it arrives as a key press).
await page.keyboard.press('Escape');
await frames(2);
s = await state();
ok(s.state === 'paused' && s.screen === 'pause', 'Escape pauses (main.js) and shows the pause menu');
await shot('pause');
await page.click('.pause-panel .menu > .menu-row .btn:last-child');
await frames(1);
ok((await state()).screen === 'controls', 'Controls opens from pause');
await page.keyboard.press('Escape');
await frames(1);
s = await state();
ok(s.screen === 'pause' && s.state === 'paused', 'Escape in Controls returns to pause without resuming');
await page.click('.pause-panel .btn-primary');
await frames(2);
s = await state();
ok(s.state === 'playing' && !s.menu, 'Resume returns to the game');

// Quit to title and back.
await page.keyboard.press('Escape');
await frames(2);
await page.click('text=Save and quit to title');
await frames(2);
s = await state();
ok(s.state === 'title' && s.screen === 'title', 'Save and quit returns to the title');

await browser.close();
server.close();
if (errors.filter((e) => !/fonts|ERR_CERT/.test(e)).length) failures++;
console.log(failures ? `GAME UI TEST FAILED (${failures})` : 'GAME UI TEST PASSED');
process.exit(failures ? 1 : 0);
