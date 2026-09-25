// Skeptic check for gameplay #8 (normal page part): one transient lock failure. Is drag-look sticky?
// Does a canvas click relock? Does Esc -> Resume relock?
import { serve, launch, gamePage, frames } from '../gameplay-ui/harness.mjs';
const server = await serve();
const browser = await launch();
const { page } = await gamePage(browser);
await page.addInitScript(() => {
  window.__failNext = 1; window.__rpl = 0;
  const orig = HTMLCanvasElement.prototype.requestPointerLock;
  HTMLCanvasElement.prototype.requestPointerLock = function (opts) {
    window.__rpl++;
    if (window.__failNext > 0) {
      window.__failNext--;
      setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
      return Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'NotAllowedError'));
    }
    return orig.call(this, opts);
  };
});
await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250 });
await page.evaluate(() => { const g = window.__game; g.setRender(false); g.__log = []; const t = g.ui.toast.bind(g.ui); g.ui.toast = (m, ms) => { g.__log.push(m); return t(m, ms); }; });
const st = (what) => page.evaluate((what) => { const g = window.__game, i = g.player.input; return { what, state: g.state, rpl: window.__rpl, dragLook: i.dragLook, lockBlocked: i.lockBlocked, locked: !!document.pointerLockElement, toasts: g.__log }; }, what);
const play = await page.evaluate(() => { const r = window.__game.ui.el.play.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; });
await page.mouse.click(play[0], play[1]);
await page.waitForTimeout(700);
console.log(JSON.stringify(await st('after Play (1st request fails)')));
await page.mouse.click(240, 135); await frames(page, 3); await page.waitForTimeout(300);
console.log(JSON.stringify(await st('after canvas click')));
await page.keyboard.press('Escape'); await frames(page, 3);
console.log(JSON.stringify(await st('after Esc')));
await page.evaluate(() => window.__game.ui.el.resume.click());
await page.waitForTimeout(700);
console.log(JSON.stringify(await st('after Resume')));
await browser.close(); server.close();
