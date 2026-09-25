// Review check: for which viewport sizes does "Delete world" cover the centre of "New world"?
import { serve, launch, gamePage } from './harness.mjs';
const server = await serve();
const browser = await launch();
const { page } = await gamePage(browser, { width: 800, height: 600 });
await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.ui, null, { polling: 250 });
await page.evaluate(() => { const g = window.__game; g.setRender(false); g.ui.hideTitle(); g.ui.showPause(); });
await page.waitForTimeout(400);
const hits = [];
for (const w of [320, 360, 390, 414, 430, 460, 480, 500, 540, 600, 700, 800, 1024, 1280, 1920]) {
  for (const h of [360, 480, 600, 720, 900]) {
    await page.setViewportSize({ width: w, height: h });
    const r = await page.evaluate(() => {
      const ui = window.__game.ui;
      ui._confirm(false);
      const a = document.querySelector('.pause-screen .btn-quiet-danger').getBoundingClientRect();
      ui._confirm(true);
      const d = document.querySelector('.pause-screen .btn-danger').getBoundingClientRect();
      ui._confirm(false);
      const cx = (a.left + a.right) / 2, cy = (a.top + a.bottom) / 2;
      const ox = Math.max(0, Math.min(a.right, d.right) - Math.max(a.left, d.left));
      const oy = Math.max(0, Math.min(a.bottom, d.bottom) - Math.max(a.top, d.top));
      return { centreHit: cx >= d.left && cx <= d.right && cy >= d.top && cy <= d.bottom, overlapPct: Math.round(100 * ox * oy / (a.width * a.height)) };
    });
    hits.push(`${w}x${h}: centre ${r.centreHit ? 'HIT' : 'miss'}, ${r.overlapPct}% of New world covered`);
  }
}
console.log(hits.join('\n'));
await browser.close(); server.close();
