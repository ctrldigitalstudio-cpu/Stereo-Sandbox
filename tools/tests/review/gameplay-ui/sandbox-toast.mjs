// Review check: when does the drag-look toast appear in a sandboxed iframe, and how fast do frames run?
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
  const g = window.__game; g.__log = [];
  const t = g.ui.toast.bind(g.ui);
  g.ui.toast = (m, ms) => { g.__log.push([Math.round(performance.now()), 'toast', m]); return t(m, ms); };
  const rl = g.player.input.requestLock.bind(g.player.input);
  g.player.input.requestLock = () => { g.__log.push([Math.round(performance.now()), 'requestLock']); const p = rl(); p.then((ok) => g.__log.push([Math.round(performance.now()), 'settled', ok])); return p; };
});
const play = await f.locator('.btn-play').boundingBox();
await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
const t0 = await f.evaluate(() => [performance.now(), window.__game.frame]);
await page.waitForTimeout(4000);
const t1 = await f.evaluate(() => [performance.now(), window.__game.frame]);
console.log('fps in iframe ~', ((t1[1] - t0[1]) / ((t1[0] - t0[0]) / 1000)).toFixed(1));
console.log(JSON.stringify(await f.evaluate(() => window.__game.__log)));
await browser.close(); server.close();
