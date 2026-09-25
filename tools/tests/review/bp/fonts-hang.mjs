// Review (build/portability): Google Fonts reachable but slow/blackholed (corporate proxy, GFW):
// does the game's boot wait for the font stylesheet? Delays the fonts.googleapis.com response by N ms.
//   node tools/tests/review/bp/fonts-hang.mjs [delayMs=20000] [page=dist/index.html]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const delay = Number(process.argv[2] || 20000);
const pg = process.argv[3] || 'dist/index.html';
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
  await new Promise((r) => setTimeout(r, delay));
  await route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts */' }).catch(() => {});
});
const T0 = Date.now();
page.goto(`http://127.0.0.1:${server.address().port}/${pg}?test`, { waitUntil: 'commit' }).catch(() => {});
let bootAt = null, workerSrcAt = null;
while (Date.now() - T0 < delay + 15000) {
  const r = await page.evaluate(() => ({ worker: typeof window.__WORKER_SRC__, game: !!window.__game })).catch(() => null);
  if (r && r.worker === 'string' && workerSrcAt === null) workerSrcAt = Date.now() - T0;
  if (r && r.game) { bootAt = Date.now() - T0; break; }
  await new Promise((res) => setTimeout(res, 200));
}
console.log(JSON.stringify({ fontDelayMs: delay, inlineScriptRanAtMs: workerSrcAt, gameBootedAtMs: bootAt }));
await browser.close(); server.close();
