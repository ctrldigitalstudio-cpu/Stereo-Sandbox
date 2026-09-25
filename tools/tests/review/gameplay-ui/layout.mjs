// Review check: are the menu controls reachable (inside the viewport or in a scroll container) at small sizes?
import { serve, launch, gamePage, frames, out } from './harness.mjs';
const server = await serve();
const browser = await launch();
const sizes = [[320, 568], [640, 360], [568, 320], [800, 450], [1280, 720]];
for (const [w, h] of sizes) {
  const { page, ctx } = await gamePage(browser, { width: w, height: h });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.ui, null, { polling: 250 });
  await page.evaluate(() => window.__game.setRender(false));
  const check = (label) => page.evaluate((label) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const res = [];
    const screen = document.querySelector('.screen.is-open');
    for (const el of (screen ? screen.querySelectorAll('button, input, select') : [])) {
      if (!vis(el) || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      // Reachable if inside the viewport, or inside a scrollable ancestor.
      let sc = el.parentElement, scrollable = false;
      while (sc && sc !== document.body) { const s = getComputedStyle(sc); if (/(auto|scroll)/.test(s.overflowY) && sc.scrollHeight > sc.clientHeight) { scrollable = true; break; } sc = sc.parentElement; }
      const inView = r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1;
      if (!inView && !scrollable) res.push(`${(el.textContent || el.getAttribute('aria-label') || el.className).trim().slice(0, 30)} @${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`);
    }
    return { label, hscroll: document.documentElement.scrollWidth > innerWidth, unreachable: res };
  }, label);
  const results = [];
  results.push(await check('title'));
  await page.evaluate(() => { const g = window.__game; g.ui._openSub('settings'); });
  for (const tab of ['graphics', 'world', 'controls', 'audio-display']) {
    await page.evaluate((t) => window.__game.ui._selectTab(t), tab);
    results.push(await check('settings/' + tab));
  }
  await page.evaluate(() => window.__game.ui._back());
  await page.evaluate(() => { window.__game.ui.showPause(); });
  results.push(await check('pause'));
  await page.evaluate(() => { window.__game.ui._confirm(true); });
  results.push(await check('pause/confirm'));
  await page.evaluate(() => { window.__game.ui._confirm(false); window.__game.ui.hidePause(); window.__game.ui.hideTitle(); window.__game.ui.toggleInventory(true); });
  results.push(await check('inventory'));
  await page.screenshot({ path: `${out}/inv-${w}x${h}.png` });
  console.log(`${w}x${h}:`, JSON.stringify(results.filter((r) => r.hscroll || r.unreachable.length)));
  await ctx.close();
}
await browser.close(); server.close();
