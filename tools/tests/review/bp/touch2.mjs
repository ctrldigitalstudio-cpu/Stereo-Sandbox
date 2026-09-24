// Review (build/portability): touch-only phone flow, fast variant (rendering skipped so frames are quick).
// iOS Safari has no Element.requestPointerLock; removed here. Taps Play, swipes, taps the world.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await context.newPage();
await page.addInitScript(() => { Element.prototype.requestPointerLock = undefined; });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const lg = (s) => console.log(s);
await page.goto(`http://127.0.0.1:${server.address().port}/dist/index.html?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.frame > 1, null, { timeout: 90000, polling: 250 });
await page.evaluate(() => __game.setRender(false));
await page.waitForFunction(() => window.__game.loaded(3) >= 1 && !document.querySelector('.btn-play').disabled, null, { timeout: 90000, polling: 250 });
const cdp = await context.newCDPSession(page);
const tap = async (x, y) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
const frames = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const rp = await page.evaluate(() => { const r = document.querySelector('.btn-play').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await tap(rp[0], rp[1]);
await frames(5);
lg('after tapping Play: ' + JSON.stringify(await page.evaluate(() => ({ state: __game.state, toasts: document.body.innerText.match(/Mouse capture[^\n]*/)?.[0] || null }))));
const controls = await page.evaluate(() => [...document.querySelectorAll('button, a, [role=button]')].filter((b) => { const r = b.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e === b || b.contains(e); }).map((b) => (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 24)));
lg('controls a finger can reach now: ' + JSON.stringify(controls));
// swipe to look
const y0 = await page.evaluate(() => [__game.player.yaw, __game.player.pitch]);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y: 300 }] });
for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80 + i * 12, y: 300 - i * 4 }] }); }
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await frames(5);
const y1 = await page.evaluate(() => [__game.player.yaw, __game.player.pitch]);
lg(`swipe 144 px: yaw/pitch ${y0.map((v) => v.toFixed(3))} -> ${y1.map((v) => v.toFixed(3))}`);
// tap on the world while a block is targeted
await page.evaluate(() => { __game.player.pitch = -1.35; });
await frames(5);
const before = await page.evaluate(() => ({ target: __game.player.target && { x: __game.player.target.x, y: __game.player.target.y, z: __game.player.target.z, id: __game.player.target.id }, edits: __game.world.exportEdits() }));
await tap(160, 300);
await frames(8);
const after = await page.evaluate(() => __game.world.exportEdits());
lg('target before tap: ' + JSON.stringify(before.target) + '\nedits before: ' + before.edits + '\nedits after one tap: ' + after);
await browser.close(); server.close();
