// Skeptic check: after the 400 ms click suppression, a canvas click while a pointer-lock request is
// still pending (Chrome's ~1.25 s re-lock cooldown after Esc; Input retries from a timer) -- is it a
// game click that breaks the block under the crosshair?
// Chrome's cooldown is emulated by wrapping requestPointerLock (headless has no Esc-unlock gesture).
import { serve, launch, gamePage, frames } from '../gameplay-ui/harness.mjs';
const server = await serve();
const browser = await launch();
const { page } = await gamePage(browser);
await page.addInitScript(() => {
  window.__userExit = -1e9;
  const orig = HTMLCanvasElement.prototype.requestPointerLock;
  HTMLCanvasElement.prototype.requestPointerLock = function (opts) {
    if (performance.now() - window.__userExit < 1250) {
      (window.__denied = window.__denied || []).push(Math.round(performance.now() - window.__userExit));
      setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
      return Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'NotAllowedError'));
    }
    return orig.call(this, opts);
  };
});
await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250 });
await page.evaluate(() => window.__game.setRender(false));
const play = await page.evaluate(() => { const r = window.__game.ui.el.play.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; });
await page.mouse.click(play[0], play[1]);
await page.waitForFunction(() => !!document.pointerLockElement);
await frames(page, 3);

// Aim at the ground and record breaks.
await page.evaluate(() => {
  const g = window.__game, p = g.player;
  p.pitch = -1.2; p._updateTarget();
  g.__breaks = [];
  p.onBreak = ((orig) => (x, y, z, id) => { g.__breaks.push([Math.round(performance.now() - window.__userExit), x, y, z, id]); orig(x, y, z, id); })(p.onBreak);
});

// "Esc": user unlock -> pause.
await page.evaluate(() => { window.__userExit = performance.now(); document.exitPointerLock(); });
await page.waitForFunction(() => window.__game.state === 'paused');
await page.waitForTimeout(250);
const rb = await page.evaluate(() => { const r = window.__game.ui.el.resume.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; });
const snap = (what) => page.evaluate((what) => {
  const g = window.__game, inp = g.player.input;
  return { what, t: Math.round(performance.now() - window.__userExit), state: g.state, locked: inp.locked, dragLook: inp.dragLook, pending: !!inp._lockPending, target: g.player.target && [g.player.target.x, g.player.target.y, g.player.target.z, g.player.target.id], breaks: g.__breaks, denied: window.__denied };
}, what);
console.log(JSON.stringify(await snap('before Resume')));
await page.mouse.click(rb[0], rb[1]);                  // Resume (inside the cooldown -> denied, retry scheduled)
console.log(JSON.stringify(await snap('after Resume click')));
// Cursor still visible, look doesn't work -> player clicks the game once more, after the 400 ms suppression.
await page.waitForFunction(() => performance.now() - window.__userExit > 780);
console.log(JSON.stringify(await snap('before canvas click')));
await page.mouse.click(240, 135);
await frames(page, 3);
console.log(JSON.stringify(await snap('after canvas click')));
await page.waitForTimeout(1200);
console.log(JSON.stringify(await snap('later')));
await browser.close(); server.close();
