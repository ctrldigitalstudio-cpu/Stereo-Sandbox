// Review check: in a sandboxed iframe (drag-look), after focus moves to the host page, does clicking
// the game canvas give the iframe keyboard focus back? (mousedown preventDefault can block focus.)
import { serve, launch, gamePage, frames } from './harness.mjs';
const sandbox = process.env.SANDBOX ?? 'allow-scripts allow-same-origin';
const server = await serve({
  '/outer.html': `<!doctype html><body style="margin:0;background:#222"><input id=chat style="position:absolute;left:10px;top:400px;width:300px"><iframe id=f sandbox="${sandbox}" src="/index.html" style="border:0;width:640px;height:360px;margin:20px"></iframe></body>`,
});
const browser = await launch();
const { page } = await gamePage(browser, { width: 700, height: 440 });
await page.goto(`${server.base}/outer.html`, { waitUntil: 'load' });
let f;
for (let i = 0; i < 100 && !f; i++) { await page.waitForTimeout(200); f = page.frames().find((x) => x.url().includes('/index.html')); }
await f.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250, timeout: 240000 });
await f.evaluate(() => window.__game.setRender(false));
const play = await f.locator('.btn-play').boundingBox();
await page.mouse.click(20 + play.x + play.width / 2, 20 + play.y + play.height / 2);
await page.waitForTimeout(500);
const probe = async (label) => {
  const r = await f.evaluate(() => ({ state: window.__game.state, dragLook: window.__game.player.input.dragLook, iframeHasFocus: document.hasFocus() }));
  const outer = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  // Hold W briefly and see whether the game saw it.
  await f.evaluate(() => { window.__sawW = false; addEventListener('keydown', (e) => { if (e.code === 'KeyW') window.__sawW = true; }, { once: true }); });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(150); await page.keyboard.up('KeyW');
  const sawW = await f.evaluate(() => window.__sawW);
  const chat = await page.evaluate(() => document.getElementById('chat').value);
  console.log(label, JSON.stringify({ ...r, outerActive: outer, gameSawW: sawW, chatValue: chat }));
};
await probe('after Play:');
// Focus the host page's text field (user types in the chat), then click back onto the game canvas.
await page.click('#chat');
await probe('after clicking host input:');
await page.evaluate(() => { document.getElementById('chat').value = ''; });
await page.mouse.click(20 + 320, 20 + 180);   // still click on the canvas (drag-look: a click)
await page.waitForTimeout(300);
await probe('after clicking the canvas:');
await page.evaluate(() => { document.getElementById('chat').value = ''; });
// Drag on the canvas instead.
await page.mouse.move(340, 200); await page.mouse.down(); for (let i = 1; i < 8; i++) await page.mouse.move(340 + i * 10, 200); await page.mouse.up();
await page.waitForTimeout(300);
await probe('after dragging on the canvas:');
// Candidate fix, injected in-page only: focus the frame on canvas mousedown.
if (process.env.FIX) {
  await f.evaluate(() => document.getElementById('game').addEventListener('mousedown', () => { if (!document.hasFocus()) window.focus(); }));
  await page.click('#chat');
  await page.evaluate(() => { document.getElementById('chat').value = ''; });
  await page.mouse.click(20 + 320, 20 + 180);
  await page.waitForTimeout(300);
  await probe('FIX window.focus() on mousedown, after clicking the canvas:');
}
await browser.close(); server.close();
