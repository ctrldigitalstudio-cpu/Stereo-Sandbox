// Review check (sandboxed iframe, no pointer lock): toasts/lock requests on every inventory close and
// Resume; double-click on Play in drag-look mode.
import { serve, launch, gamePage, frames } from './harness.mjs';
const server = await serve({
  '/outer.html': `<!doctype html><body style="margin:0"><iframe id=f sandbox="allow-scripts allow-same-origin" src="/index.html" style="border:0;width:640px;height:360px"></iframe></body>`,
});
const browser = await launch();
const { page } = await gamePage(browser, { width: 640, height: 360 });
await page.goto(`${server.base}/outer.html`, { waitUntil: 'load' });
let f;
for (let i = 0; i < 100 && !f; i++) { await page.waitForTimeout(200); f = page.frames().find((x) => x.url().includes('/index.html')); }
await f.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250, timeout: 240000 });
await f.evaluate(() => {
  const g = window.__game, p = g.player; g.__log = []; g.__breaks = [];
  g.setRender(false);
  const t = g.ui.toast.bind(g.ui);
  g.ui.toast = (m, ms) => { g.__log.push(m); return t(m, ms); };
  const orig = p.onBreak;
  p.onBreak = (x, y, z, id) => { g.__breaks.push([x, y, z, id]); orig(x, y, z, id); };
  p.pitch = -1.2; p._updateTarget();
});
console.log('target:', JSON.stringify(await f.evaluate(() => window.__game.player.target)));
const play = await f.locator('.btn-play').boundingBox();
await page.mouse.dblclick(play.x + play.width / 2, play.y + play.height / 2);
await frames(f, 5);
console.log('after double-click Play:', JSON.stringify(await f.evaluate(() => ({ state: window.__game.state, dragLook: window.__game.player.input.dragLook, breaks: window.__game.__breaks }))));
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('KeyE'); await frames(f, 3);
  await page.keyboard.press('KeyE'); await frames(f, 3);
}
console.log('toasts after Play + 3 inventory round trips:', JSON.stringify(await f.evaluate(() => window.__game.__log)));
await browser.close(); server.close();
