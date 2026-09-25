// Skeptic check: context loss against current sources (index.html -> src/main.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.split('\n')[0], '|', (e.stack||'').split('\n').slice(1,4).join(' / ')));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 160)); });
let navs = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.loaded(2) >= 1, null, { timeout: 90000, polling: 500 });
await page.evaluate(() => __game.setRender(false));
console.log('--- losing context');
await page.evaluate(() => { window.__lc = __game.renderer.gl.getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
await page.waitForTimeout(500);
console.log('lost:', await page.evaluate(() => __game.renderer.gl.isContextLost()), 'maxTex:', await page.evaluate(() => __game.renderer.gl.getParameter(__game.renderer.gl.MAX_TEXTURE_SIZE)));
console.log('--- direct resize() while lost');
console.log(await page.evaluate(() => { try { __game.renderer._sizeDirty = true; __game.renderer.renderWidth = 1; __game.renderer.resize(); return 'ok'; } catch (e) { return 'threw: ' + e.message; } }));
console.log('--- UI volume change while lost');
const r2 = await page.evaluate(() => {
  const ui = __game.ui; const before = __game.settings.volume;
  let res;
  try { ui._applySetting('volume', before === 0.3 ? 0.4 : 0.3); res = 'ok'; } catch (e) { res = 'threw: ' + e.message; }
  let stored = null; try { stored = localStorage.getItem(Object.keys(localStorage).find(k => /setting/i.test(k)) || ''); } catch {}
  return { res, before, uiVol: ui.settings.volume, gameVol: __game.settings.volume, soundVol: __game.renderer && (window.__game.sound?.volume), stored: stored && stored.slice(0, 200), keys: Object.keys(localStorage) };
});
console.log(JSON.stringify(r2));
console.log('--- restoring');
await page.evaluate(() => window.__lc.restoreContext());
await page.waitForTimeout(3000);
console.log('reloads:', navs - 1);
await browser.close(); server.close();
