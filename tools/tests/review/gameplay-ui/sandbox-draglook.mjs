// Review check: the whole play flow inside a sandboxed iframe without allow-pointer-lock
// (drag-to-look fallback), driven with real mouse/keyboard events.
import { serve, launch, gamePage, frames } from './harness.mjs';

const sandbox = process.env.SANDBOX ?? 'allow-scripts allow-same-origin';
const server = await serve({
  '/outer.html': `<!doctype html><body style="margin:0;background:#222"><iframe id=f sandbox="${sandbox}" src="/index.html" style="border:0;width:640px;height:360px;margin:20px"></iframe></body>`,
});
const browser = await launch();
const { page } = await gamePage(browser, { width: 700, height: 420 });
await page.goto(`${server.base}/outer.html`, { waitUntil: 'load' });
let f;
for (let i = 0; i < 100 && !f; i++) { await page.waitForTimeout(200); f = page.frames().find((x) => x.url().includes('/index.html')); }
await f.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250, timeout: 240000 });
const ox = 20, oy = 20;   // iframe offset in the outer page
const st = () => f.evaluate(() => {
  const g = window.__game, p = g.player;
  return { state: g.state, screen: g.ui.screen, inv: g.ui.inventoryOpen, dragLook: p.input.dragLook, locked: p.input.locked,
    yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    active: document.activeElement && (document.activeElement.className || document.activeElement.tagName), breaks: g.__breaks || [] };
});
await f.evaluate(() => {
  const g = window.__game, p = g.player;
  g.__breaks = [];
  const orig = p.onBreak;
  p.onBreak = (x, y, z, id) => { g.__breaks.push([x, y, z, id]); orig(x, y, z, id); };
});
const play = await f.locator('.btn-play').boundingBox();
await page.mouse.click(ox + play.x + play.width / 2, oy + play.y + play.height / 2);
await page.waitForTimeout(2500);
await frames(f, 2);
console.log('after Play:', JSON.stringify(await st()));

// Drag to look (left button), quick.
const cx = ox + 320, cy = oy + 180;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 12, cy + i * 3);
await page.mouse.up();
await frames(f, 3);
console.log('after drag:', JSON.stringify(await st()));

// Escape -> pause, then Resume.
await page.keyboard.press('Escape');
await frames(f, 3);
console.log('after Escape:', JSON.stringify(await st()));
await page.keyboard.press('Escape');
await frames(f, 3);
console.log('after 2nd Escape:', JSON.stringify(await st()));
const res = await f.locator('.pause-screen .btn-primary').boundingBox();
await page.mouse.click(ox + res.x + res.width / 2, oy + res.y + res.height / 2);
await page.waitForTimeout(2500);
await frames(f, 3);
console.log('after Resume:', JSON.stringify(await st()));

// Inventory round trip with E.
await page.keyboard.press('KeyE');
await frames(f, 3);
console.log('after E:', JSON.stringify(await st()));
await page.keyboard.press('KeyE');
await frames(f, 3);
console.log('after E again:', JSON.stringify(await st()));

// Walk: hold W for a bit.
const p0 = await f.evaluate(() => window.__game.player.pos.slice());
await page.keyboard.down('KeyW');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
const p1 = await f.evaluate(() => window.__game.player.pos.slice());
console.log('walked', Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2), 'blocks');
await browser.close();
server.close();
