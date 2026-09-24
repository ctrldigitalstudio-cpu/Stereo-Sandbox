#!/usr/bin/env node
// The full play-through with real keyboard and mouse events, as a person would play it:
//   title (loading progress, keys that must do nothing while loading, double-clicked Play),
//   drag-look when pointer lock is denied (drag, click, right-click, hold to repeat),
//   movement (walk, sprint two ways, sneak edge guard, jump onto a block, fly up/down/land, swim,
//   surface, climb out), building (break + particles + sounds, place every kind of block, pick,
//   hotbar keys + wheel), the creative inventory (search, assign, close with E / Escape / Done),
//   F1 / F3, then pointer lock granted (look, inventory, Escape pauses, Resume re-locks).
// Rendering is switched off for long stretches (window.__game.setRender) so the simulation runs
// in real time; it is switched back on at the end to check the edited world still draws cleanly.
//   node tools/tests/gameplay/journey.mjs [--size 480x270]

import {
  startServer, launch, newGamePage, waitReady, frames, reporter, playerState, state, sleep, grab, opt, outDir,
  LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY,
} from './lib.mjs';
import path from 'node:path';
import { B } from '../../../src/blocks.js';
import { WorldGen } from '../../../src/worldgen.js';

const { log, check, finish } = reporter('journey');
const [W, H] = opt('size', '480x270').split('x').map(Number);
const CX = W / 2, CY = H / 2;
const server = await startServer();
const browser = await launch();

// Pointer lock denied (as in a sandboxed iframe without allow-pointer-lock).
const denyLock = () => {
  Element.prototype.requestPointerLock = function () {
    const d = this.ownerDocument;
    setTimeout(() => d.dispatchEvent(new Event('pointerlockerror')), 0);
    return Promise.reject(new DOMException('Pointer lock denied', 'NotAllowedError'));
  };
};
// A saved game standing at spawn looking at the ground, so a stray click would break a block.
const spawn = new WorldGen(12345).findSpawn();
const { page, errors } = await newGamePage(browser, {
  width: W, height: H, init: denyLock,
  storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 12345, player: { x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0.6, pitch: -1.2, flying: false } } },
});
// Count sound + particle activity from inside the page.
const spy = () => page.evaluate(() => {
  const g = window.__game, s = g.player.sound;
  if (!s.__spied) {
    s.__spied = true;
    window.__sounds = [];
    const play = s.play.bind(s);
    s.play = (kind, material, pos) => { window.__sounds.push([kind, material]); return play(kind, material, pos); };
  }
  window.__sounds.length = 0;
});
const sounds = () => page.evaluate(() => window.__sounds.slice());
const setView = (yaw, pitch) => page.evaluate(([y, p]) => { const pl = window.__game.player; pl.yaw = y; pl.pitch = p; }, [yaw, pitch]);
const block = (x, y, z) => page.evaluate(([x, y, z]) => window.__game.world.getBlock(x, y, z), [x, y, z]);
const holdKeys = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const settle = (n = 6) => frames(page, n);
const lookAt = (x, y, z) => page.evaluate(([x, y, z]) => {
  const p = window.__game.player, e = p.eye();
  const dx = x + 0.5 - e[0], dy = y + 0.5 - e[1], dz = z + 0.5 - e[2];
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}, [x, y, z]);
const land = () => page.waitForFunction(() => window.__game.player.onGround, null, { timeout: 30000, polling: 20 }).catch(() => null);

// ---- 1. boot + title -------------------------------------------------------------------------
await page.goto(`${server.base}/index.html`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__game && document.querySelector('.btn-play'), null, { timeout: 120000, polling: 20 });
const early = await page.evaluate(() => ({
  disabled: document.querySelector('.btn-play').disabled,
  progress: Number(document.querySelector('.progress').getAttribute('aria-valuenow')),
  status: document.querySelector('.title-status').textContent,
  loaded: window.__game.loaded(4),
}));
log(`early title: ${JSON.stringify(early)}`);
check(early.loaded >= 1 || (early.disabled && early.progress < 100), 'Play disabled with progress while loading');
// Record toasts (they fade after a few seconds, frames can be slower than that).
await page.evaluate(() => {
  const ui = window.__game.ui, toast = ui.toast.bind(ui);
  window.__toasts = [];
  ui.toast = (m, ms) => { window.__toasts.push(String(m)); return toast(m, ms); };
});
// Keys that must do nothing on the title / while loading (Enter only plays once the world is ready).
await page.evaluate(() => {
  window.__keys = [];
  addEventListener('keydown', (e) => window.__keys.push([e.code, window.__game.ui._loading.ready]), true);
});
await page.keyboard.press('KeyE');
await page.keyboard.press('Escape');
await page.keyboard.press('Enter');
await settle(3);
let s = await state(page);
const keyLog = await page.evaluate(() => window.__keys);
const enterWhileReady = keyLog.some(([c, r]) => c === 'Enter' && r);
check(!s.inv && s.screen !== 'pause' && (enterWhileReady ? s.state === 'playing' : s.state === 'title' && s.screen === 'title'),
  `E / Escape do nothing on the title, Enter only once ready (${JSON.stringify(s)}, keys ${JSON.stringify(keyLog)})`);
if (enterWhileReady) {
  // Loading finished before Enter arrived: go back to the title for the rest of the checks.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__game.state === 'paused');
  await page.click('text=Save and quit to title');
  await page.waitForFunction(() => window.__game.state === 'title');
}
await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { timeout: 300000, polling: 50 });
const ready = await page.evaluate(() => ({
  progress: Number(document.querySelector('.progress').getAttribute('aria-valuenow')),
  status: document.querySelector('.title-status').textContent,
  cam: window.__game.camera,
}));
check(ready.progress === 100 && /ready/i.test(ready.status), `ready: ${ready.progress}% "${ready.status}"`);
const camBlock = await block(...ready.cam.pos);
check(camBlock === 0, `title camera is in open air (block ${camBlock} at ${ready.cam.pos.map((v) => v.toFixed(1))})`);
await page.keyboard.press('KeyE');
await settle(2);
check(!(await state(page)).inv, 'E on the title does not open the inventory');
await grab(page, path.join(outDir, 'gameplay-title.png'));

// Double-click Play: the second click must not reach the world as a block break.
await page.dblclick('.btn-play');
await settle(4);
await sleep(450);
s = await state(page);
check(s.state === 'playing' && s.screen === null && !s.menu, 'double-clicked Play starts the game once');
const target0 = await page.evaluate(() => window.__game.player.target);
check(!!target0 && await page.evaluate(() => window.__game.world.edits.size === 0), `double-clicking Play broke nothing (crosshair on ${JSON.stringify(target0 && target0.id)})`);
await page.waitForFunction(() => window.__game.player.input.dragLook, null, { timeout: 10000 }).catch(() => null);
await sleep(200);
const toasts = await page.evaluate(() => window.__toasts.slice());
check(await page.evaluate(() => window.__game.player.input.dragLook), 'pointer lock denied -> drag-look fallback');
check(toasts.some((t) => /drag/i.test(t)), `drag-look toast shown (${JSON.stringify(toasts)})`);

// From here on simulate in real time without drawing.
await page.evaluate(() => window.__game.setRender(false));
await spy();

// ---- test arena high above the terrain -------------------------------------------------------
const A = await page.evaluate(({ STONE, WATER }) => {
  const g = window.__game, w = g.world;
  const s = g.gen.findSpawn();
  const ox = Math.floor(s.x), oz = Math.floor(s.z), y = 100;
  const set = (x, yy, z, id) => w.setBlock(x, yy, z, id);
  for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) set(ox + dx, y, oz + dz, STONE);
  // Pool (3 x 3, five deep) in the +x / -z corner: water y 96..100 with stone walls and floor.
  for (let dx = 1; dx <= 5; dx++) for (let dz = -5; dz <= -1; dz++) {
    set(ox + dx, 95, oz + dz, STONE);
    const inner = dx >= 2 && dx <= 4 && dz >= -4 && dz <= -2;
    for (let yy = 96; yy <= 100; yy++) set(ox + dx, yy, oz + dz, inner ? WATER : STONE);
  }
  // Walls (three high) so a late key release can't walk the player off the arena; the north side
  // has a gap at x = ox-4..ox-1 for the sneak edge test.
  for (let d = -6; d <= 6; d++) {
    for (let yy = y + 1; yy <= y + 3; yy++) {
      set(ox - 6, yy, oz + d, STONE); set(ox + 6, yy, oz + d, STONE); set(ox + d, yy, oz + 6, STONE);
      if (d < -4 || d > -1) set(ox + d, yy, oz - 6, STONE);
    }
  }
  // A stone column under the hold-to-break spot.
  for (let yy = 94; yy < y; yy++) set(ox - 4, yy, oz + 3, STONE);
  return { ox, oz, y, water: WATER };
}, { STONE: B.STONE, WATER: B.WATER });
log(`arena at ${A.ox}, ${A.y}, ${A.oz}`);
const ids = await page.evaluate(() => {
  const map = {};
  for (const el of document.querySelectorAll('.inv-item')) map[el.getAttribute('aria-label')] = Number(el.dataset.id);
  return map;
});
check(await block(A.ox + 3, 99, A.oz - 3) === B.WATER, 'arena pool is water');
const stand = async (x, z, yaw = 0, pitch = 0) => {
  await page.evaluate(([x, y, z, yaw, pitch]) => {
    const g = window.__game;
    g.teleport(x, y, z, yaw, pitch);
    g.player.flying = false;
  }, [x, A.y + 1, z, yaw, pitch]);
  await settle(4);
};

// ---- 2. drag-look ----------------------------------------------------------------------------
await stand(A.ox + 0.5, A.oz + 0.5, 0, 0);
let p = await playerState(page);
await page.mouse.move(CX, CY);
await page.mouse.down();
for (let i = 1; i <= 6; i++) { await page.mouse.move(CX + i * 10, CY + i * 5); await sleep(16); }
await page.mouse.up();
await settle(3);
let q = await playerState(page);
const dyaw = q.yaw - p.yaw, dpitch = q.pitch - p.pitch;
check(Math.abs(dyaw + 60 * 0.0022) < 0.01 && Math.abs(dpitch + 30 * 0.0022) < 0.01, `drag right/down turns right/down (dyaw ${dyaw.toFixed(3)}, dpitch ${dpitch.toFixed(3)})`);
const editsBefore = await page.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
await setView(0, -1.25);   // look at the floor in front of the feet
await settle(3);
p = await playerState(page);
check(p.target && p.target.y === A.y, `targeting the arena floor (${JSON.stringify(p.target)})`);
const editsAfterDrag = await page.evaluate(() => [...window.__game.world.edits.values()].reduce((n, m) => n + m.size, 0));
check(editsAfterDrag === editsBefore, 'a drag does not break or place anything');

// Still right click places the selected block (slot 2: stone) on top of the floor.
await page.keyboard.press('Digit2');
await settle(2);
await setView(0, -0.95);
await settle(2);
p = await playerState(page);
let t = p.target;
await page.mouse.click(CX, CY, { button: 'right' });
await settle(3);
check(t && await block(t.x + t.nx, t.y + t.ny, t.z + t.nz) === p.hotbar[1], `drag-look right click placed stone at ${t && [t.x + t.nx, t.y + t.ny, t.z + t.nz]}`);
// Still left click breaks it again.
await settle(2);
p = await playerState(page);
t = p.target;
await page.mouse.click(CX, CY, { button: 'left' });
await settle(3);
check(t && t.y === A.y + 1 && await block(t.x, t.y, t.z) === 0, 'drag-look left click broke the placed block');
// Hold left without moving: repeats every 0.25 s.
await stand(A.ox - 3.5, A.oz + 3.5, 0, -1.5707);
await page.evaluate(() => { window.__game.player.flying = true; window.__game.player.vel = [0, 0, 0]; });
await spy();
await page.mouse.move(CX, CY);
await page.mouse.down();
const th0 = await page.evaluate(() => window.__game.player.time);
await page.waitForFunction((t0) => window.__game.player.time - t0 > 1.3, th0, { polling: 20 });
await page.mouse.up();
await settle(2);
const column = await page.evaluate(({ ox, oz, y }) => {
  let n = 0;
  for (let yy = 94; yy <= y; yy++) if (window.__game.world.getBlock(ox - 4, yy, oz + 3) === 0) n++;
  return n;
}, A);
const heldBreaks = await page.evaluate(() => window.__sounds.filter((s) => s[0] === 'break').length);
check(heldBreaks >= 4 && column === heldBreaks, `holding the button repeats breaking (${heldBreaks} breaks in 1.3 s, ${column} column blocks gone)`);
await page.evaluate(() => { window.__game.player.flying = false; });

// ---- 3. movement -----------------------------------------------------------------------------
// Repair the arena floor first (the hold test dug into it).
await page.evaluate(({ ox, oz, y, STONE, WATER }) => {
  const w = window.__game.world;
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
    const inPool = dx >= 2 && dx <= 4 && dz >= -4 && dz <= -2;
    for (let yy = y + 1; yy <= y + 3; yy++) w.setBlock(ox + dx, yy, oz + dz, 0);
    w.setBlock(ox + dx, y, oz + dz, inPool ? WATER : STONE);
  }
}, { ...A, STONE: B.STONE, WATER: B.WATER });
const speedOver = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(350);
  const a = await playerState(page);
  await sleep(ms);
  const b = await playerState(page);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  return { v: Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]) / (b.time - a.time), a, b };
};
await stand(A.ox + 0.5, A.oz + 5.5, 0, 0);
let r = await speedOver(['KeyW'], 700);
check(Math.abs(r.v - 4.317) < 0.35 && r.b.onGround, `walk speed ${r.v.toFixed(2)} m/s (4.3)`);
await settle(10);
await stand(A.ox + 0.5, A.oz + 5.5, 0, 0);
await page.keyboard.press('KeyW');
await sleep(90);
r = await speedOver(['KeyW'], 700);
check(Math.abs(r.v - 5.612) < 0.4 && r.b.sprinting, `double-tap W sprints at ${r.v.toFixed(2)} m/s (5.6)`);
await settle(10);
await stand(A.ox + 0.5, A.oz + 5.5, 0, 0);
r = await speedOver(['KeyR', 'KeyW'], 700);
check(Math.abs(r.v - 5.612) < 0.4 && r.b.sprinting, `hold R + W sprints at ${r.v.toFixed(2)} m/s`);
await settle(10);
q = await playerState(page);
check(!q.sprinting, 'sprint ends when W is released');

// Sneak: walking toward the north edge (z = oz - 6 is the last floor row) never falls off.
await stand(A.ox - 2.5, A.oz - 4.5, 0, 0);
await holdKeys(['ShiftLeft', 'KeyW'], 2200);
await settle(4);
q = await playerState(page);
check(q.onGround && Math.abs(q.pos[1] - (A.y + 1)) < 1e-6 && q.pos[2] > A.oz - 6 - 0.31 && q.pos[2] < A.oz - 5, `sneak edge guard holds at z ${q.pos[2].toFixed(3)} (edge ${A.oz - 6})`);
await sleep(400);
q = await playerState(page);
const eyeSneak = await page.evaluate(() => window.__game.player.eye()[1] - window.__game.player.pos[1]);
check(!q.sneaking && eyeSneak > 1.5, `standing up again after Shift (eye ${eyeSneak.toFixed(2)})`);
// Without Shift the same walk goes over the edge.
await holdKeys(['KeyW'], 700);
await settle(4);
q = await playerState(page);
check(q.pos[1] < A.y + 1 - 0.5, `without Shift the edge is walkable off (y ${q.pos[1].toFixed(2)})`);

// Jump onto a one-block step, not onto a two-block wall.
await page.evaluate(({ ox, oz, y }) => { window.__game.world.setBlock(ox, y + 1, oz - 1, 1); }, A);
await stand(A.ox + 0.5, A.oz + 1.5, 0, 0);
await page.keyboard.down('KeyW');
await page.keyboard.down('Space');
const climbed = await page.waitForFunction((y) => { const p = window.__game.player; return p.onGround && Math.abs(p.pos[1] - y) < 1e-6; }, A.y + 2, { timeout: 5000, polling: 10 }).then(() => true, () => false);
await page.keyboard.up('Space');
await page.keyboard.up('KeyW');
await land();
check(climbed, 'W + Space climbs onto a one-block step');
await page.evaluate(({ ox, oz, y }) => { const w = window.__game.world; w.setBlock(ox, y + 1, oz - 1, 0); w.setBlock(ox, y + 1, oz - 3, 1); w.setBlock(ox, y + 2, oz - 3, 1); }, A);
await stand(A.ox + 0.5, A.oz - 1.5, 0, 0);
await holdKeys(['KeyW', 'Space'], 900);
await land();
q = await playerState(page);
check(Math.abs(q.pos[1] - (A.y + 1)) < 1e-6 && q.pos[2] > A.oz - 2 - 0.31, `a two-block wall stops the player (y ${q.pos[1].toFixed(2)}, z ${q.pos[2].toFixed(2)})`);
await page.evaluate(({ ox, oz, y }) => { const w = window.__game.world; w.setBlock(ox, y + 1, oz - 3, 0); w.setBlock(ox, y + 2, oz - 3, 0); }, A);

// Fly: double-tap Space, climb, descend with Shift, F toggles, touching down ends flight.
await stand(A.ox - 2.5, A.oz + 2.5, 0, 0);
await page.keyboard.press('Space');
await sleep(90);
await page.keyboard.press('Space');
await settle(4);
q = await playerState(page);
check(q.flying, 'double-tap Space starts flying');
let y0 = q.pos[1];
await holdKeys(['Space'], 800);
q = await playerState(page);
check(q.flying && q.pos[1] > y0 + 4, `Space flies up (${y0.toFixed(1)} -> ${q.pos[1].toFixed(1)})`);
y0 = q.pos[1];
await holdKeys(['ShiftLeft'], 700);
q = await playerState(page);
check(q.flying && q.pos[1] < y0 - 1.5, `Shift flies down (${y0.toFixed(1)} -> ${q.pos[1].toFixed(1)})`);
await page.evaluate(({ ox, oz }) => { window.__game.teleport(ox - 2.5, 104, oz + 5.5, 0, 0); }, A);
r = await speedOver(['KeyW'], 300);
check(r.v > 8 && r.b.flying, `flying speed ${r.v.toFixed(1)} m/s`);
await page.evaluate(({ ox, oz }) => { window.__game.teleport(ox - 2.5, 104, oz + 2.5, 0, 0); }, A);
await settle(3);
await page.keyboard.press('KeyF');
await settle(3);
check(!(await playerState(page)).flying, 'F stops flying');
await land();
q = await playerState(page);
check(q.onGround && !q.flying && Math.abs(q.pos[1] - (A.y + 1)) < 1e-6, `fell and landed on the arena (y ${q.pos[1].toFixed(2)})`);
await page.keyboard.press('KeyF');
await settle(3);
await holdKeys(['Space'], 400);
check((await playerState(page)).flying, 'F starts flying');
await holdKeys(['ShiftLeft'], 1500);
await settle(4);
q = await playerState(page);
check(!q.flying && q.onGround, 'flying down onto the ground lands and ends flight');

// Swim: drop into the pool, sink slowly, swim up to the surface, climb out over the rim.
await page.evaluate(({ ox, oz }) => {
  const g = window.__game;
  g.teleport(ox + 3.5, 98.6, oz - 2.5, Math.PI / 2, 0);
  g.player.flying = false;
}, A);
await sleep(700);
q = await playerState(page);
check(q.inWater && q.eyeInWater && q.vel[1] < -0.5 && q.vel[1] > -2.5 && q.pos[1] < 98.6, `in the pool, sinking slowly (vy ${q.vel[1].toFixed(2)}, y ${q.pos[1].toFixed(2)})`);
await page.keyboard.down('Space');
await page.waitForFunction(() => !window.__game.player.eyeInWater, null, { timeout: 20000, polling: 20 }).catch(() => null);
q = await playerState(page);
check(q.inWater && !q.eyeInWater, `swam up to the surface (y ${q.pos[1].toFixed(2)})`);
await page.keyboard.down('KeyW');
const out = await page.waitForFunction((y) => { const p = window.__game.player; return !p.inWater && p.onGround && Math.abs(p.pos[1] - y) < 1e-6; }, A.y + 1, { timeout: 20000, polling: 10 }).then(() => true, () => false);
await page.keyboard.up('KeyW');
await page.keyboard.up('Space');
await land();
await sleep(300);
check(out, 'Space + W against the rim climbs out of the water');
q = await playerState(page);
check(!q.inWater && q.onGround && Math.abs(q.pos[1] - (A.y + 1)) < 1e-6, `climbed out of the pool onto the rim (y ${q.pos[1].toFixed(2)}, x ${q.pos[0].toFixed(2)})`);

// ---- 4. building -----------------------------------------------------------------------------
// Put one of every kind into the hotbar through the inventory: search, click, close with E.
const assign = async (label, slot) => {
  await page.keyboard.press(`Digit${slot + 1}`);
  await settle(2);
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => window.__game.ui.inventoryOpen);
  await page.fill('.search-input', label.toLowerCase());
  await page.click(`.inv-item[aria-label="${label}"]`);   // focus moves to the block button
  await page.keyboard.press('KeyE');
  await settle(3);
  check(!(await state(page)).inv, `E closes the inventory after assigning ${label}`);
};
await page.keyboard.press('KeyE');
await page.waitForFunction(() => window.__game.ui.inventoryOpen);
await page.fill('.search-input', 'wool');
await settle(1);
const woolShown = await page.evaluate(() => [...document.querySelectorAll('.inv-item')].filter((e) => !e.hidden).map((e) => e.getAttribute('aria-label')));
check(woolShown.length === 6 && woolShown.every((l) => /Wool/.test(l)), `search "wool" shows only wool (${woolShown.join(', ')})`);
await page.fill('.search-input', 'zzz');
await settle(1);
check(await page.evaluate(() => !document.querySelector('.inv-empty').hidden), 'search with no match shows the empty note');
await page.fill('.search-input', '');
await settle(1);
check(await page.evaluate(() => [...document.querySelectorAll('.inv-item')].every((e) => !e.hidden)), 'clearing the search shows every block');
await page.keyboard.type('w');
await page.keyboard.press('Escape');
check(await page.evaluate(() => window.__game.ui.inventoryOpen && document.querySelector('.search-input').value === ''), 'Escape in the search box clears the text first');
await page.click('.inv-head .panel-title');   // focus out of the search box
// While the inventory is open, game keys don't move the player.
await stand(A.ox + 0.5, A.oz + 0.5, 0, 0);
await sleep(300);
p = await playerState(page);
await holdKeys(['KeyW'], 300);
q = await playerState(page);
check(Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]) < 1e-6, 'W does nothing while the inventory is open');
await page.keyboard.press('KeyE');
await settle(2);
check(!(await state(page)).inv, 'E closes the inventory');

const kinds = [['Oak Leaves', 0], ['Poppy', 3], ['Tall Grass', 4]];
for (const [label, slot] of kinds) await assign(label, slot);
q = await playerState(page);
check(q.hotbar[0] === ids['Oak Leaves'] && q.hotbar[3] === ids.Poppy && q.hotbar[4] === ids['Tall Grass'], `inventory assignments reached player.hotbar (${q.hotbar})`);
check(await page.evaluate(() => window.__game.ui.hotbar.join() === window.__game.player.hotbar.join()), 'HUD hotbar matches player.hotbar');

// Place each kind on the floor in front, check it, break it, check particles + sounds.
const placeAndBreak = async (slot, label) => {
  await stand(A.ox - 2.5, A.oz + 2.5, 0, -0.95);
  await page.keyboard.press(`Digit${slot + 1}`);
  await settle(3);
  const p = await playerState(page);
  const id = p.hotbar[slot];
  const t = p.target;
  if (!t) return check(false, `${label}: no target`);
  const at = [t.x + t.nx, t.y + t.ny, t.z + t.nz];
  await spy();
  await page.mouse.click(CX, CY, { button: 'right' });
  await settle(3);
  const placed = await block(...at);
  let snd = await sounds();
  check(placed === id && snd.some((s) => s[0] === 'place'), `placed ${label} (${placed}) with a place sound ${JSON.stringify(snd)}`);
  const q = await playerState(page);
  const pc0 = await page.evaluate(() => window.__game.particles.count);
  await spy();
  await page.mouse.click(CX, CY, { button: 'left' });
  await settle(2);
  const pc1 = await page.evaluate(() => window.__game.particles.count);
  snd = await sounds();
  check(q.target && q.target.id === id && await block(...at) === 0 && pc1 > pc0 && snd.some((s) => s[0] === 'break'),
    `broke ${label}: particles ${pc0} -> ${pc1}, sounds ${JSON.stringify(snd)}`);
};
await placeAndBreak(1, 'Stone (cube)');
await placeAndBreak(5, 'Glass');
await placeAndBreak(0, 'Oak Leaves');
await placeAndBreak(6, 'Torch');
await placeAndBreak(3, 'Poppy');
await placeAndBreak(7, 'Glowstone');
await placeAndBreak(4, 'Tall Grass');

// Tall grass is replaced in place; a torch can't go on a torch; placing into yourself is refused.
await stand(A.ox - 2.5, A.oz + 2.5, 0, -0.95);
await page.keyboard.press('Digit5');
await settle(2);
p = await playerState(page);
t = p.target;
const grassAt = [t.x + t.nx, t.y + t.ny, t.z + t.nz];
await page.mouse.click(CX, CY, { button: 'right' });
await settle(2);
await page.keyboard.press('Digit2');
await settle(2);
await page.mouse.click(CX, CY, { button: 'right' });
await settle(3);
check(await block(...grassAt) === B.STONE, `placing stone on tall grass replaces the grass (${await block(...grassAt)})`);
await page.mouse.click(CX, CY, { button: 'left' });
await settle(2);
await setView(0, -1.5707);
await settle(2);
p = await playerState(page);
await page.mouse.click(CX, CY, { button: 'right' });
await settle(2);
check(await block(Math.floor(p.pos[0]), A.y + 1, Math.floor(p.pos[2])) === 0, 'cannot place a solid block inside the player');

// Middle click: picks the targeted block (selects its slot, or puts it in the current one).
await page.evaluate(({ ox, oz, y, B }) => { const w = window.__game.world; w.setBlock(ox - 3, y + 1, oz + 1, B.GLOWSTONE); w.setBlock(ox - 2, y + 1, oz + 1, B.OBSIDIAN); }, { ...A, B: { GLOWSTONE: B.GLOWSTONE, OBSIDIAN: B.OBSIDIAN } });
await stand(A.ox - 2.5, A.oz + 2.9, 0, 0);
await lookAt(A.ox - 3, A.y + 1, A.oz + 1);
await page.keyboard.press('Digit1');
await settle(3);
p = await playerState(page);
await page.mouse.click(CX, CY, { button: 'middle' });
await settle(3);
q = await playerState(page);
check(p.target && q.selected === q.hotbar.indexOf(p.target.id) && q.hotbar[q.selected] === p.target.id, `middle click picks ${p.target && p.target.id} (slot ${q.selected + 1})`);
await lookAt(A.ox - 2, A.y + 1, A.oz + 1);
await settle(2);
p = await playerState(page);
await page.mouse.click(CX, CY, { button: 'middle' });
await settle(3);
q = await playerState(page);
check(p.target && p.target.id === B.OBSIDIAN && q.hotbar[q.selected] === p.target.id, `middle click puts a new block (${p.target && p.target.id}) into the current slot`);
check(await page.evaluate(() => window.__game.ui.hotbar.join() === window.__game.player.hotbar.join() && window.__game.ui.selected === window.__game.player.selected), 'HUD follows picks');

// Hotbar keys and wheel (wrapping both ways).
for (const k of [9, 3, 1]) {
  await page.keyboard.press(`Digit${k}`);
  await settle(2);
  check((await playerState(page)).selected === k - 1, `key ${k} selects slot ${k}`);
}
await page.mouse.move(CX, CY);
await page.mouse.wheel(0, -100);
await settle(2);
check((await playerState(page)).selected === 8, 'wheel up from slot 1 wraps to slot 9');
await page.mouse.wheel(0, 100);
await settle(2);
check((await playerState(page)).selected === 0, 'wheel down from slot 9 wraps to slot 1');
check(await page.evaluate(() => window.__game.ui.selected === 0 && document.querySelectorAll('.hotbar .slot')[0].classList.contains('is-selected')), 'HUD highlights the selected slot');

// Inventory closing: Escape, Done, and a digit key over a hovered block.
await page.keyboard.press('KeyE');
await page.waitForFunction(() => window.__game.ui.inventoryOpen);
await page.fill('.search-input', '');
await page.click('.inv-head .panel-title');
await page.hover('.inv-item[aria-label="Block of Diamond"]');
await page.keyboard.press('Digit9');
await settle(2);
check((await playerState(page)).hotbar[8] === ids['Block of Diamond'], 'digit over a hovered block puts it in that slot');
await page.keyboard.press('Escape');
await settle(2);
s = await state(page);
check(!s.inv && s.state === 'playing', `Escape closes the inventory (${JSON.stringify(s)})`);
await page.keyboard.press('KeyE');
await page.waitForFunction(() => window.__game.ui.inventoryOpen);
await page.click('.btn-done');
await settle(2);
s = await state(page);
check(!s.inv && s.state === 'playing' && !s.menu, 'Done closes the inventory');

// ---- 5. F1 / F3 --------------------------------------------------------------------------------
await stand(A.ox + 0.5, A.oz + 0.5, 0.2, -0.3);
await page.keyboard.press('F3');
await settle(3);
await sleep(300);
await settle(3);
const dbg = await page.evaluate(() => {
  const g = window.__game, rows = g.ui._debugRows, text = {};
  for (const k in rows) text[k] = rows[k].textContent;
  return { text, shown: !g.ui.el.debug.hidden, pos: g.player.pos.slice(), chunks: g.world.loadedCount, time: g.timeOfDay };
});
log(`F3: ${JSON.stringify(dbg.text)}`);
const xyz = dbg.text.xyz.split('/').map(Number);
check(dbg.shown && xyz.every((v, i) => Math.abs(v - dbg.pos[i]) < 0.01), 'F3 shows the player position');
check(dbg.text.block === `${Math.floor(dbg.pos[0])} ${Math.floor(dbg.pos[1])} ${Math.floor(dbg.pos[2])}`, 'F3 block coordinates');
check(dbg.text.chunk.startsWith(`${Math.floor(dbg.pos[0] / 16)} ${Math.floor(dbg.pos[2] / 16)}`), 'F3 chunk coordinates');
check(/^[A-Z]/.test(dbg.text.biome) && dbg.text.biome !== '–', `F3 biome "${dbg.text.biome}"`);
check(/^\d\d:\d\d · (day|night|sunrise|sunset)$/.test(dbg.text.time), `F3 time "${dbg.text.time}"`);
check(new RegExp(`^${dbg.chunks} chunks`).test(dbg.text.world), `F3 world "${dbg.text.world}"`);
check(/North|South|East|West/.test(dbg.text.facing) && /Walking|Flying/.test(dbg.text.mode), `F3 facing "${dbg.text.facing}", mode "${dbg.text.mode}"`);
await page.keyboard.press('F1');
await settle(2);
check(await page.evaluate(() => window.__game.ui.el.hotbar.hidden && window.__game.ui.el.crosshair.hidden), 'F1 hides the HUD');
await page.keyboard.press('F1');
await page.keyboard.press('F3');
await settle(2);
check(await page.evaluate(() => !window.__game.ui.el.hotbar.hidden && !window.__game.ui.el.crosshair.hidden && window.__game.ui.el.debug.hidden), 'F1 / F3 again restore the HUD');

// Escape pauses in drag-look mode; Resume goes back to drag-look without another toast pile-up.
await page.keyboard.press('Escape');
await settle(2);
s = await state(page);
check(s.state === 'paused' && s.screen === 'pause', 'Escape pauses');
await page.click('.pause-panel .btn-primary');
await settle(3);
await sleep(300);
s = await state(page);
check(s.state === 'playing' && !s.menu, 'Resume');
const toastCount = await page.evaluate(() => [...document.querySelectorAll('.toast:not(.is-leaving)')].filter((t) => /drag/i.test(t.textContent)).length);
check(toastCount <= 1, `the drag-look toast is not repeated (${toastCount})`);

// Draw the edited world again (no GL errors after all of the above).
await page.evaluate(() => window.__game.setRender(true));
await stand(A.ox - 4.5, A.oz + 5.5, -0.5, -0.35);
await settle(2);
await grab(page, path.join(outDir, 'gameplay-arena.png'));
check(errors.length === 0, `no page errors in drag-look play (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
await page.context().close();

// ---- 6. pointer lock granted -------------------------------------------------------------------
{
  const { page, errors } = await newGamePage(browser, { width: W, height: H, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 12345 } } });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await waitReady(page, 2);
  await page.evaluate(() => window.__game.setRender(false));
  await page.waitForFunction(() => !document.querySelector('.btn-play').disabled);
  await page.click('.btn-play');
  await page.waitForFunction(() => document.pointerLockElement && window.__game.player.input.locked, null, { timeout: 10000 }).catch(() => null);
  let s = await state(page);
  check(s.state === 'playing' && s.locked, 'lock granted: Play captures the mouse');
  await frames(page, 3);
  // Headless reports locked mouse moves oddly; feed movementX/Y like a real locked mouse.
  const p0 = await playerState(page);
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new MouseEvent('mousemove', { movementX: 20, movementY: -8 })); });
  await frames(page, 2);
  const p1 = await playerState(page);
  const dy = p1.yaw - p0.yaw, dp = p1.pitch - p0.pitch;
  // (headless adds its own recentring moves under lock, so allow some slack on the magnitude)
  check(dy < -0.8 * 80 * 0.0022 && dy > -1.4 * 80 * 0.0022 && dp > 0.8 * 32 * 0.0022 && dp < 1.4 * 32 * 0.0022, `locked mouse turns the view right / up (dyaw ${dy.toFixed(3)}, dpitch ${dp.toFixed(3)})`);
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => window.__game.ui.inventoryOpen);
  await frames(page, 2);
  s = await state(page);
  check(s.inv && !s.locked && s.state === 'playing', 'E releases the mouse for the inventory (no pause)');
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => document.pointerLockElement, null, { timeout: 5000 }).catch(() => null);
  await frames(page, 2);
  s = await state(page);
  check(!s.inv && s.locked && s.state === 'playing', 'closing the inventory captures the mouse again');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__game.state === 'paused', null, { timeout: 5000 }).catch(() => null);
  s = await state(page);
  check(s.state === 'paused' && !s.locked, 'Escape releases the mouse and pauses');
  await page.evaluate(() => document.exitPointerLock());
  await page.click('.pause-panel .btn-primary');
  await page.waitForFunction(() => document.pointerLockElement, null, { timeout: 5000 }).catch(() => null);
  await frames(page, 2);
  s = await state(page);
  check(s.state === 'playing' && s.locked, 'Resume captures the mouse again');
  // Losing the lock any other way (alt-tab, script) pauses too.
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => window.__game.state === 'paused', null, { timeout: 5000 }).catch(() => null);
  check((await state(page)).state === 'paused', 'losing pointer lock pauses');
  check(errors.length === 0, `no page errors with pointer lock (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
  await page.context().close();
}

await browser.close();
server.close();
process.exit(finish());
