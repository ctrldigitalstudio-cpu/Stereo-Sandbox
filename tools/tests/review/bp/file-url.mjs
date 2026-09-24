// Review (build/portability): README says dist/index.html "works from disk". Open it via file://.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() !== 'log') console.log('[console]', m.type(), m.text().slice(0, 200)); });
await page.goto('file:///home/user/minecraft-browser/dist/index.html?test', { waitUntil: 'load' });
const ok = await page.waitForFunction(() => window.__game && window.__game.loaded(2) >= 1, null, { timeout: 90000, polling: 500 }).then(() => true, () => false);
console.log(JSON.stringify({ loaded: ok, origin: await page.evaluate(() => self.origin), chunks: await page.evaluate(() => window.__game && window.__game.world.loadedCount) }));
await browser.close();
