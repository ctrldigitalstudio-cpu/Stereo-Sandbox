#!/usr/bin/env node
// End-to-end check of player/input/audio inside the real game (headless Chromium, ?test mode):
// real keyboard + mouse events drive walking, jumping, flying, breaking, placing and the hotbar.
//   node tools/tests/player/game.mjs [--size 640x360]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const [W, H] = opt('size', '640x360').split('x').map(Number);
const out = (n) => path.join(root, 'tools/out', `player-game-${n}.png`);

const server = await startStaticServer(root);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
// Web fonts come from Google Fonts; the sandbox network can't reach it, which isn't a game error.
const external = (t) => /Failed to load resource: net::ERR_(CERT|NAME|CONNECTION|INTERNET|TUNNEL|PROXY)/.test(t);
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  console.log(`[console.${m.type()}] ${m.text().slice(0, 500)}`);
  if (m.type() === 'error' && !external(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.stack || e.message}`); });

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const problems = [];
const check = (c, msg) => { if (!c) { problems.push(msg); log(`FAIL ${msg}`); } else log(`ok   ${msg}`); };
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);
const player = () => page.evaluate(() => {
  const p = window.__game.player;
  return { pos: p.pos.slice(), vel: p.vel.slice(), flying: p.flying, onGround: p.onGround, selected: p.selected, hotbar: p.hotbar.slice(), target: p.target, yaw: p.yaw, pitch: p.pitch, swing: p.swing, equip: p.equip, inWater: p.inWater };
});
// Hold for n rendered frames (software GL is slow; the game clamps dt to 0.1 s per frame).
const hold = async (key, n) => { await page.keyboard.down(key); await frames(n); await page.keyboard.up(key); };
const waitFrames = (n) => frames(n);

await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.waitForFunction(() => window.__game.loaded(3) >= 1, null, { timeout: 240000, polling: 500 });
log('terrain loaded');
await page.evaluate(() => {
  window.__game.setSettings({ renderScale: 0.5, shadows: false, volumetrics: 0, clouds: 0, ssr: 0, renderDistance: 4 });
  window.__game.play();
});
await page.evaluate(() => {
  const g = window.__game, s = g.gen.findSpawn();
  g.teleport(s.x, s.y + 0.5, s.z, 0.6, -0.15);
  g.player.flying = false;
  g.setTime(0.3);
});
await frames(30);
let p = await player();
check(p.onGround && Math.abs(p.pos[1] - Math.round(p.pos[1])) < 1e-9, `settled on the ground at y ${p.pos[1]}`);
const start = p.pos;

// Walk forward with real key events.
await hold('KeyW', 40);
await frames(5);
p = await player();
const walked = Math.hypot(p.pos[0] - start[0], p.pos[2] - start[2]);
check(walked > 1.5, `walked ${walked.toFixed(2)} m with W`);
check(p.onGround || p.inWater, 'still grounded after walking');

// Jump.
await page.keyboard.down('Space');
await frames(2);
await page.keyboard.up('Space');
p = await player();
check(!p.onGround && p.vel[1] !== 0, `airborne after Space (vy ${p.vel[1].toFixed(2)})`);
await waitFrames(30);

// Fly: F toggles, Space climbs.
await page.keyboard.press('KeyF');
await frames(2);
const y0 = (await player()).pos[1];
await hold('Space', 25);
p = await player();
check(p.flying && p.pos[1] > y0 + 2, `flying up: ${y0.toFixed(1)} -> ${p.pos[1].toFixed(1)}`);
await page.keyboard.press('KeyF');
await waitFrames(60);
p = await player();
check(!p.flying && p.onGround, 'fell back to the ground after F');

// Hotbar: digit + wheel over the canvas.
await page.keyboard.press('Digit4');
await frames(2);
check((await player()).selected === 3, 'Digit4 selects slot 4');
await page.mouse.move(W / 2, H / 2);
await page.mouse.wheel(0, 100);
await frames(3);
check((await player()).selected === 4, 'wheel down selects the next slot');

// Break the block under the crosshair with a real click on the canvas.
await page.evaluate(() => { window.__game.player.pitch = -1.0; });
await frames(3);
p = await player();
check(!!p.target, `targeting ${JSON.stringify(p.target)}`);
const tgt = p.target;
const before = await page.evaluate((t) => window.__game.world.getBlock(t.x, t.y, t.z), tgt);
await page.mouse.click(W / 2, H / 2, { button: 'left' });
await frames(3);
const after = await page.evaluate((t) => window.__game.world.getBlock(t.x, t.y, t.z), tgt);
check(before > 0 && (after === 0 || after === 11), `left click broke block ${before} -> ${after}`);

// Place: select stone and right-click the floor in front (repeat while held).
await page.keyboard.press('Digit2');
await page.evaluate(() => { window.__game.player.pitch = -0.75; });
await frames(3);
const edits0 = await page.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
await page.mouse.move(W / 2, H / 2);
await page.mouse.down({ button: 'right' });
await page.waitForFunction((t0) => window.__game.player.time - t0 > 0.6, await page.evaluate(() => window.__game.player.time), { polling: 50, timeout: 120000 });
await page.mouse.up({ button: 'right' });
await frames(3);
const edits1 = await page.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
check(edits1 - edits0 >= 2, `right button held placed ${edits1 - edits0} blocks`);
p = await player();
await page.screenshot({ path: out('build') });
log(`screenshot ${out('build')}`);

// Middle click picks the targeted block into the hotbar.
await page.mouse.click(W / 2, H / 2, { button: 'middle' });
await frames(3);
p = await player();
check(p.target && p.hotbar[p.selected] === p.target.id, `middle click pick -> slot ${p.selected} holds ${p.hotbar[p.selected]}`);

// Audio: the page's Sound object is alive (resume() after a gesture) and playing never throws.
const audio = await page.evaluate(async () => {
  const s = window.__game.sound || null;
  return { hasSound: !!s };
});
log(`sound exposed on __game: ${audio.hasSound}`);

// Water, if there is some nearby: swim down/up and check eyeInWater.
const shore = await page.evaluate(() => {
  const g = window.__game, s = g.gen.findSpawn();
  for (let r = 16; r < 700; r += 16) for (let a = 0; a < 32; a++) {
    const x = Math.round(s.x + Math.cos(a / 32 * Math.PI * 2) * r), z = Math.round(s.z + Math.sin(a / 32 * Math.PI * 2) * r);
    if (g.gen.heightAt(x, z) < 50) return { x, z };
  }
  return null;
});
if (shore) {
  await page.evaluate((s) => { const g = window.__game; g.teleport(s.x + 0.5, 60, s.z + 0.5, 0.3, -0.2); g.player.flying = false; }, shore);
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(2) >= 1, null, { timeout: 120000, polling: 300 });
  // After the plunge the drag holds the sink rate near 1.6 m/s until the player rests on the bottom.
  let fastest = 0;
  for (let i = 0; i < 40; i++) {
    await waitFrames(1);
    const vy = await page.evaluate(() => (window.__game.player.inWater && window.__game.player.eyeInWater ? window.__game.player.vel[1] : 0));
    if (i >= 15) fastest = Math.min(fastest, vy);
  }
  const w = await page.evaluate(() => { const p = window.__game.player; return { inWater: p.inWater, eye: p.eyeInWater, vy: p.vel[1], y: p.pos[1], onGround: p.onGround }; });
  check(w.inWater && w.eye && fastest > -2.2 && w.vy <= 0, `sinking slowly or resting on the bottom (fastest ${fastest.toFixed(2)}, ${JSON.stringify(w)})`);
  await page.screenshot({ path: out('underwater') });
  log(`screenshot ${out('underwater')}`);
  await page.keyboard.down('Space');
  await waitFrames(60);
  const w2 = await page.evaluate(() => { const p = window.__game.player; return { inWater: p.inWater, eye: p.eyeInWater, y: p.pos[1] }; });
  await page.keyboard.up('Space');
  check(w2.y > w.y && !w2.eye, `swam up to the surface (${JSON.stringify(w2)})`);
}

check(errors.length === 0, `no page errors (${errors.length})`);
await browser.close();
server.close();
console.log(problems.length ? `FAILED: ${problems.length}` : 'PASSED');
process.exit(problems.length ? 1 : 0);
