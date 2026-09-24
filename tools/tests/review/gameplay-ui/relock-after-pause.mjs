// Review check: Chrome refuses to re-lock for ~1.25 s after the user pressed Esc; Input retries later
// from a timer. If the player pauses again before the retry fires, does the lock land on the pause menu?
// Chrome's cooldown is emulated by wrapping requestPointerLock (headless has no Esc-unlock gesture).
import { serve, launch, gamePage, frames } from './harness.mjs';
const server = await serve();
const browser = await launch();
const { page } = await gamePage(browser);
await page.addInitScript(() => {
  window.__userExit = -1e9;
  const orig = HTMLCanvasElement.prototype.requestPointerLock;
  HTMLCanvasElement.prototype.requestPointerLock = function (opts) {
    if (performance.now() - window.__userExit < 1250) {
      setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
      return Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'NotAllowedError'));
    }
    return orig.call(this, opts);
  };
});
await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250 });
await page.evaluate(() => window.__game.setRender(false));   // fast frames; logic only
const st = (what) => page.evaluate((what) => ({ what, t: Math.round(performance.now() - window.__userExit), state: window.__game.state, screen: window.__game.ui.screen, locked: document.pointerLockElement === document.getElementById('game') }), what);
// Where the Resume button will be (same panel layout on any screen).
const rb = await page.evaluate(async () => {
  const ui = window.__game.ui; ui.showPause();
  await new Promise((r) => setTimeout(r, 400));
  const r = ui.el.resume.getBoundingClientRect(); ui.showTitle();
  return [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
});
const play = await page.evaluate(() => { const r = window.__game.ui.el.play.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; });
await page.waitForTimeout(400);
await page.mouse.click(play[0], play[1]);
await page.waitForFunction(() => !!document.pointerLockElement);
// Timed in-page sequence right after the real Play click (Chrome's transient activation lasts ~5 s;
// the page's own timers keep the timing independent of CDP round trips).
const log = await page.evaluate(() => new Promise((done) => {
  const g = window.__game, log = [];
  const snap = (what) => log.push({ what, t: Math.round(performance.now() - window.__userExit), state: g.state, screen: g.ui.screen, locked: document.pointerLockElement === document.getElementById('game') });
  window.__userExit = performance.now();
  document.exitPointerLock();                                   // "Esc": user unlock -> pause
  setTimeout(() => { snap('before Resume'); g.ui.el.resume.click(); snap('Resume clicked (inside cooldown)'); }, 300);
  setTimeout(() => {                                            // mouse look seems dead -> Esc again
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
  }, 600);
  setTimeout(() => snap('after 2nd Esc'), 1000);
  setTimeout(() => { snap('2.2 s after the first Esc'); done(log); }, 2200);
}));
for (const l of log) console.log(JSON.stringify(l));
await browser.close(); server.close();
