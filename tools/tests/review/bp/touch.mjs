// Review (build/portability): touch-only phone flow. iOS Safari has no Element.requestPointerLock;
// this removes it, taps Play, then checks what a touch player can do (look, move, pause) and what a tap does.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await context.newPage();
await page.addInitScript(() => { delete Element.prototype.requestPointerLock; Element.prototype.requestPointerLock = undefined; });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const T0 = Date.now(); const lg = (s) => console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + s);
await page.goto(`http://127.0.0.1:${server.address().port}/dist/index.html?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.loaded(3) >= 1 && !document.querySelector('.btn-play').disabled, null, { timeout: 90000, polling: 500 });
lg('loaded; touch-note visible: ' + await page.evaluate(() => getComputedStyle(document.querySelector('.touch-note')).display));
const cdp0 = await context.newCDPSession(page);
const rp = await page.evaluate(() => { const r = document.querySelector('.btn-play').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await cdp0.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rp[0], y: rp[1] }] });
await cdp0.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForFunction(() => window.__game.state === 'playing', null, { timeout: 30000 }).catch(() => {});
const g = await page.evaluate(() => ({ state: __game.state, dragLook: __game.renderer && true, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }));
lg('after tap Play: ' + JSON.stringify(g));
// Any visible, tappable control left on screen?
const controls = await page.evaluate(() => [...document.querySelectorAll('button, [role=button], a')].filter((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !b.closest('[hidden]') && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; }).map((b) => b.className + ' "' + (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 30) + '"'));
lg('tappable controls: ' + JSON.stringify(controls));
// Swipe to look: does yaw change?
const yaw0 = await page.evaluate(() => __game.player.yaw);
const cdp = await context.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
await touch('touchStart', 100, 300);
for (let i = 1; i <= 10; i++) await touch('touchMove', 100 + i * 15, 300);
await touch('touchEnd');
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const yaw1 = await page.evaluate(() => __game.player.yaw);
lg(`swipe: yaw ${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)}`);
// Tap on the world while looking at the ground: what happens?
await page.evaluate(() => { __game.player.pitch = -1.3; });
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const before = await page.evaluate(() => ({ target: __game.player.target, edits: __game.world.exportEdits().length }));
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 300 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const after = await page.evaluate(() => ({ edits: __game.world.exportEdits(), state: __game.state }));
lg('tap on world: target before ' + JSON.stringify(before.target) + ' edits after: ' + after.edits.slice(0, 120) + ' state ' + after.state);

await browser.close(); server.close();
