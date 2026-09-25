// Diagnostics: boot, go to a scene, render some frames and print TAA state per frame.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 225 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text().slice(0, 500)}`); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`);
await page.waitForFunction(() => window.__game);
await page.evaluate(() => window.__game.play());
await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 300000 });
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
await page.evaluate(() => { const g = window.__game; g.teleport(15.5, g.gen.heightAt(15, 28) + 1, 28.5, 2.5, 0.05); g.setSettings({ aa: 'taa', renderScale: 1 }); });
for (let i = 0; i < 6; i++) {
  await frames(1);
  console.log(await page.evaluate(() => {
    const r = window.__game.renderer, t = r.post.taa;
    const U = r.frameUniforms;
    return JSON.stringify({ frame: t.frame, jit: r.jitter.map((v) => +v.toFixed(3)), valid: t.valid, histOk: t.historyOk, idx: t.index, uTAA: [0, 1, 2, 3].map((i) => +U.get('uTAA', i).toFixed(3)), cd: [0, 1, 2].map((i) => +U.get('uCamDelta', i).toFixed(4)), temporal: r.post.temporal, aa: r.settings.aa, proj8: +r.proj[8].toFixed(5), proj9: +r.proj[9].toFixed(5) });
  }));
}
fs.mkdirSync(path.join(root, 'tools/out/taa-diag'), { recursive: true });
const grab = async (name) => { const data = await page.evaluate(() => window.__game.capture()); fs.writeFileSync(path.join(root, 'tools/out/taa-diag', name), Buffer.from(data.split(',')[1], 'base64')); };
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 1; });
await frames(2);
await grab('weight.png');
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 2; });
for (let i = 0; i < 3; i++) { await grab(`raw${i}.png`); console.log(await page.evaluate(() => JSON.stringify(window.__game.renderer.jitter))); }
await page.evaluate(() => { window.__game.renderer.post.taa.debug = 0; });
for (let i = 0; i < 3; i++) { await grab(`res${i}.png`); console.log(await page.evaluate(() => JSON.stringify(window.__game.renderer.jitter))); }
await browser.close(); server.close();
