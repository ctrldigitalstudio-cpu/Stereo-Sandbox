// Skeptic check for gameplay #8: sandboxed iframe without allow-pointer-lock. Count toasts,
// requestPointerLock calls and console errors across Play + inventory round trips + pause/resume.
import { serve, launch, gamePage, frames } from '../gameplay-ui/harness.mjs';
const server = await serve({
  '/outer.html': `<!doctype html><body style="margin:0"><iframe id=f sandbox="allow-scripts allow-same-origin" src="/index.html" style="border:0;width:640px;height:360px"></iframe></body>`,
});
const browser = await launch();
const { page } = await gamePage(browser, { width: 640, height: 360 });
let consoleErrors = 0;
page.on('console', (m) => { if (m.type() === 'error' && /pointer lock/i.test(m.text())) consoleErrors++; });
await page.goto(`${server.base}/outer.html`, { waitUntil: 'load' });
let f;
for (let i = 0; i < 100 && !f; i++) { await page.waitForTimeout(200); f = page.frames().find((x) => x.url().includes('/index.html')); }
await f.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250, timeout: 240000 });
await f.evaluate(() => {
  const g = window.__game; g.__log = []; g.__rpl = 0;
  g.setRender && g.setRender(false);
  const t = g.ui.toast.bind(g.ui);
  g.ui.toast = (m, ms) => { g.__log.push(m); return t(m, ms); };
  const proto = HTMLCanvasElement.prototype, orig = proto.requestPointerLock;
  proto.requestPointerLock = function (...a) { g.__rpl++; return orig.apply(this, a); };
});
const play = await f.locator('.btn-play').boundingBox();
await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
await frames(f, 5); await page.waitForTimeout(300);
const st = () => f.evaluate(() => { const g = window.__game, i = g.player.input; return { state: g.state, toasts: g.__log.length, rpl: g.__rpl, lockBlocked: i.lockBlocked, dragLook: i.dragLook }; });
console.log('after Play:', JSON.stringify(await st()), 'consoleErrors', consoleErrors);
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('KeyE'); await frames(f, 3);
  await page.keyboard.press('KeyE'); await frames(f, 3); await page.waitForTimeout(200);
}
console.log('after 3 inventory round trips:', JSON.stringify(await st()), 'consoleErrors', consoleErrors);
console.log('toasts:', JSON.stringify(await f.evaluate(() => window.__game.__log)));
await browser.close(); server.close();
