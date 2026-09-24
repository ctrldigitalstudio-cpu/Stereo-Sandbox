// Review (build/portability): window moved from a 1x to a 2x display (DPR changes, CSS size doesn't).
// Does the canvas backing store follow?
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/dist/index.html?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.frame > 2, null, { timeout: 90000, polling: 500 });
await page.evaluate(() => __game.setRender(false));
await page.evaluate(() => { window.__resizeEvents = 0; addEventListener('resize', () => window.__resizeEvents++); });
const before = await page.evaluate(() => ({ dpr: devicePixelRatio, canvas: [__game.renderer.canvas.width, __game.renderer.canvas.height] }));
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 180, deviceScaleFactor: 2, mobile: false });
const f0 = await page.evaluate(() => __game.frame);
await page.waitForFunction((f0) => __game.frame > f0 + 10, f0, { timeout: 90000, polling: 200 });
await page.waitForTimeout(1000);
const after = await page.evaluate(() => ({ dpr: devicePixelRatio, css: [innerWidth, innerHeight], canvas: [__game.renderer.canvas.width, __game.renderer.canvas.height], resizeEvents: window.__resizeEvents, sizeDirty: __game.renderer._sizeDirty }));
console.log(JSON.stringify({ before, after }));
await browser.close(); server.close();
