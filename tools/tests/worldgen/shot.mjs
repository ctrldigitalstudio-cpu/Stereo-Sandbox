// Open tools/tests/worldgen/game.html (real game, cheap settings) and save the canvas grabbed
// in-page. Usage: node tools/tests/worldgen/shot.mjs "x=..&z=..&yaw=..&t=.." out.png [WxH]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [query = '', out = 'tools/out/wg-game.png', size = '640x360'] = process.argv.slice(2);
const [W, H] = size.split('x').map(Number);
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${server.address().port}/tools/tests/worldgen/game.html?test&${query}`);
await page.waitForFunction(() => window.__done, null, { timeout: 900000, polling: 1000 });
const url = await page.evaluate(() => window.__shot);
fs.writeFileSync(path.resolve(root, out), Buffer.from(url.split(',')[1], 'base64'));
console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await browser.close();
server.close();
