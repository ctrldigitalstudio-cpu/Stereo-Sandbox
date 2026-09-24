// Review check: does double-clicking Play (or Resume) break the block under the crosshair?
import { serve, launch, gamePage, frames, out } from './harness.mjs';

const server = await serve();
const browser = await launch();
const { page } = await gamePage(browser);
await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250 });
console.log('title ready, state =', await page.evaluate(() => window.__game.state));

// Aim at the ground right in front of the (saved/spawn) player, as happens after any pause.
const aim = async () => page.evaluate(() => {
  const g = window.__game, p = g.player;
  p.pitch = -1.2;
  p._updateTarget();
  g.__breaks = [];
  p.onBreak = ((orig) => (x, y, z, id) => { g.__breaks.push([x, y, z, id]); orig(x, y, z, id); })(p.onBreak);
  return p.target && { x: p.target.x, y: p.target.y, z: p.target.z, id: p.target.id };
});
console.log('target before Play:', JSON.stringify(await aim()));

const box = await page.locator('.btn-play').boundingBox();
await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
await frames(page, 5);
let r = await page.evaluate(() => ({ state: window.__game.state, locked: !!document.pointerLockElement, dragLook: window.__game.player.input.dragLook, breaks: window.__game.__breaks }));
console.log('after double-click on Play:', JSON.stringify(r));

// Pause (Escape in drag-look / unlocked mode), re-aim, then double-click Resume.
await page.evaluate(() => { if (document.pointerLockElement) document.exitPointerLock(); });
await page.keyboard.press('Escape');
await frames(page, 3);
console.log('state after Escape:', await page.evaluate(() => window.__game.state));
console.log('target before Resume:', JSON.stringify(await aim()));
const rb = await page.locator('.pause-screen .btn-primary').boundingBox();
await page.mouse.dblclick(rb.x + rb.width / 2, rb.y + rb.height / 2);
await frames(page, 5);
r = await page.evaluate(() => ({ state: window.__game.state, breaks: window.__game.__breaks }));
console.log('after double-click on Resume:', JSON.stringify(r));

await browser.close();
server.close();
