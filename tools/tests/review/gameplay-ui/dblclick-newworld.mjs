// Review check: where do "Keep playing" / "Delete world" appear relative to the "New world" button?
// A double-click on New world must not land on Delete world. Also: double-click on "Save and quit".
import { serve, launch, gamePage, frames } from './harness.mjs';
const server = await serve();
const browser = await launch();
for (const [w, h] of [[1280, 720], [960, 540], [640, 360], [390, 700]]) {
  const { page, ctx } = await gamePage(browser, { width: w, height: h });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.ui, null, { polling: 250 });
  await page.evaluate(() => {
    const g = window.__game; g.setRender(false);
    g.__calls = [];
    g.ui.opts.onNewWorld = () => g.__calls.push('onNewWorld (world deleted)');
    const q = g.ui.opts.onQuit; g.ui.opts.onQuit = () => { g.__calls.push('onQuit'); q(); };
    const p = g.ui.opts.onPlay; g.ui.opts.onPlay = () => { g.__calls.push('onPlay'); p(); };
    g.ui.hideTitle(); g.ui.showPause();
  });
  await page.waitForTimeout(400);   // pause fade-in
  const rect = (sel) => page.evaluate((sel) => { const e = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().width); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); }, sel);
  const nw = await rect('.pause-screen .btn-quiet-danger');
  await page.mouse.dblclick((nw[0] + nw[2]) / 2, (nw[1] + nw[3]) / 2);
  await page.waitForTimeout(300);
  const del = await rect('.pause-screen .btn-danger');
  const calls1 = await page.evaluate(() => window.__game.__calls.splice(0));
  console.log(`${w}x${h} New world ${JSON.stringify(nw)} -> Delete world ${JSON.stringify(del)}; double-click New world called: ${JSON.stringify(calls1)}`);
  await ctx.close();
}
await browser.close(); server.close();
