// Review check: double-clicking menu buttons that swap the panel under the cursor.
import { serve, launch, gamePage } from './harness.mjs';
const server = await serve();
const browser = await launch();
for (const [w, h] of [[1280, 720], [960, 540], [640, 360], [480, 640]]) {
  const { page, ctx } = await gamePage(browser, { width: w, height: h });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.ui, null, { polling: 250 });
  await page.evaluate(() => { const g = window.__game; g.setRender(false); });
  const out = [];
  for (const from of ['title', 'pause']) {
    for (const label of ['Settings', 'Controls']) {
      await page.evaluate((from) => { const ui = window.__game.ui; ui._setScreen(null); if (from === 'title') ui.showTitle(); else ui.showPause(); }, from);
      await page.waitForTimeout(350);
      const before = await page.evaluate(() => JSON.stringify(window.__game.ui.settings));
      const r = await page.evaluate(([from, label]) => {
        const e = [...document.querySelectorAll(`.${from}-screen button`)].find((b) => b.textContent.trim() === label);
        const q = e.getBoundingClientRect(); return [(q.left + q.right) / 2, (q.top + q.bottom) / 2];
      }, [from, label]);
      await page.mouse.dblclick(r[0], r[1]);
      await page.waitForTimeout(200);
      const res = await page.evaluate((before) => {
        const ui = window.__game.ui, now = ui.settings, was = JSON.parse(before), changed = {};
        for (const k in now) if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) changed[k] = [was[k], now[k]];
        return { screen: ui.screen, changed };
      }, before);
      const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); const b = e && e.closest('button, input, label, .setting'); return b ? (b.getAttribute('aria-label') || b.textContent.trim().slice(0, 30) || b.className) : e && e.className; }, r);
      out.push(`${from}/${label}: screen=${res.screen} changed=${JSON.stringify(res.changed)} underCursor="${under}"`);
    }
  }
  console.log(`${w}x${h}\n  ` + out.join('\n  '));
  await ctx.close();
}
await browser.close(); server.close();
