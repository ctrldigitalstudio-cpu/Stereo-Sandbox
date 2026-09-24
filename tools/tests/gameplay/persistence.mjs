#!/usr/bin/env node
// Saving and loading with real input: edits, position, orientation, hotbar and time survive the
// autosave and a reload (pagehide); "Save and quit to title" then Play; "New world" really starts
// a fresh world (fresh seed, no edits) instead of re-saving the old one on the way out.
//   node tools/tests/gameplay/persistence.mjs

import {
  startServer, launch, newGamePage, waitReady, frames, reporter, playerState, sleep,
  LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY, LEGACY_SAVE_KEY,
} from './lib.mjs';

const { log, check, finish } = reporter('persistence');
const W = 480, H = 270;
const server = await startServer();
const browser = await launch();
const { page, errors } = await newGamePage(browser, { width: W, height: H, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 424242 } } });
const readSave = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), SAVE_KEY);
const boot = async () => {
  await waitReady(page, 2);
  await page.evaluate(() => { window.__game.setRender(false); window.__booted = true; });
};

await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await boot();
check(await page.evaluate(() => window.__game.world.seed === 424242), 'saved seed is used');
await page.click('.btn-play');
await page.waitForFunction(() => window.__game.state === 'playing');
await frames(page, 5);
await sleep(450);   // clicks right after Play are ignored (double-click guard)

// Build on a known spot: stand on a stone pad high in the air (independent of the terrain).
const pad = await page.evaluate(() => {
  const g = window.__game, p = g.player;
  const x0 = Math.floor(p.pos[0]), z0 = Math.floor(p.pos[2]), y = 100;
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) g.world.setBlock(x0 + dx, y, z0 + dz, 1);
  g.teleport(x0 + 0.5, y + 1, z0 + 0.5, 0, -1.2);
  p.flying = false;
  return { x0, y, z0 };
});
await frames(page, 10);
let p = await playerState(page);
check(p.onGround && Math.abs(p.pos[1] - (pad.y + 1)) < 1e-6, `standing on the pad (y ${p.pos[1]})`);

// Break the pad block in front of the feet (left click), place stone and glass (right click).
check(!!p.target && p.target.y === pad.y, `looking at the pad (${JSON.stringify(p.target)})`);
const broken = p.target;
await page.mouse.click(W / 2, H / 2, { button: 'left' });
await frames(page, 3);
check(await page.evaluate((t) => window.__game.world.getBlock(t.x, t.y, t.z), broken) === 0, 'left click broke a pad block');
await page.keyboard.press('Digit2');
await frames(page, 2);
await page.evaluate(() => { window.__game.player.pitch = -0.9; window.__game.player.yaw = Math.PI / 2; });
await frames(page, 2);
p = await playerState(page);
const placeAt = p.target && { x: p.target.x + p.target.nx, y: p.target.y + p.target.ny, z: p.target.z + p.target.nz };
const placedId = p.hotbar[p.selected];
await page.mouse.click(W / 2, H / 2, { button: 'right' });
await frames(page, 3);
check(placeAt && await page.evaluate(({ b, id }) => window.__game.world.getBlock(b.x, b.y, b.z) === id, { b: placeAt, id: placedId }), `right click placed block ${placedId} at ${JSON.stringify(placeAt)}`);

// Change the hotbar through the inventory (E, click Bookshelf, E) and select slot 7 with the wheel.
await page.keyboard.press('KeyE');
await page.waitForFunction(() => window.__game.ui.inventoryOpen);
await page.click('.inv-item[aria-label="Bookshelf"]');
await page.keyboard.press('KeyE');
await page.waitForFunction(() => !window.__game.ui.inventoryOpen);
await frames(page, 2);
await page.mouse.move(W / 2, H / 2);
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 100); await frames(page, 1); }
await frames(page, 2);
p = await playerState(page);
const invId = await page.evaluate(() => Number(document.querySelector('.inv-item[aria-label="Bookshelf"]').dataset.id));
check(p.hotbar[1] === invId && p.selected === 6, `inventory click put Bookshelf in slot 2, wheel selected slot 7 (${p.hotbar} / ${p.selected})`);

// Move a little and turn, set a distinctive time of day.
await page.keyboard.down('KeyD');
await sleep(600);
await page.keyboard.up('KeyD');
await page.evaluate(() => { window.__game.player.yaw = 1.234; window.__game.player.pitch = -0.321; window.__game.setTime(0.6); });
await frames(page, 3);

// Autosave: within ~10 s of play the save reflects all of it.
const t0 = Date.now();
await page.waitForFunction((k) => {
  const s = JSON.parse(localStorage.getItem(k) || 'null');
  return s && s.selected === 6 && Math.abs(s.player.yaw - 1.234) < 1e-9 && s.time > 0.6;
}, SAVE_KEY, { polling: 250, timeout: 60000 }).catch(() => null);
let save = await readSave();
check(save && save.selected === 6 && save.hotbar[1] === invId && Math.abs(save.player.yaw - 1.234) < 1e-9, `autosave written after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
check(save && save.edits.includes(`${Math.floor(broken.x / 16)},${Math.floor(broken.z / 16)}`), 'autosave contains the edits');

// Reload (pagehide saves the very latest state).
const before = await page.evaluate(() => {
  const g = window.__game, p = g.player;
  return { pos: p.pos.slice(), yaw: p.yaw, pitch: p.pitch, hotbar: p.hotbar.slice(), selected: p.selected, time: g.timeOfDay, flying: p.flying };
});
await page.reload({ waitUntil: 'load' });
await boot();
const after = await page.evaluate(() => {
  const g = window.__game, p = g.player;
  return { pos: p.pos.slice(), yaw: p.yaw, pitch: p.pitch, hotbar: p.hotbar.slice(), selected: p.selected, time: g.timeOfDay, seed: g.world.seed, state: g.state, uiHotbar: g.ui.hotbar.slice(), uiSel: g.ui.selected };
});
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
check(after.state === 'title' && after.seed === 424242, 'reload: title screen of the same world');
check(after.pos.every((v, i) => near(v, before.pos[i], 1e-3)), `reload: position ${after.pos.map((v) => v.toFixed(2))} (was ${before.pos.map((v) => v.toFixed(2))})`);
check(near(after.yaw, before.yaw, 1e-3) && near(after.pitch, before.pitch, 1e-3), 'reload: orientation restored');
check(after.hotbar.join() === before.hotbar.join() && after.selected === before.selected, 'reload: hotbar + selected slot restored');
check(after.uiHotbar.join() === before.hotbar.join() && after.uiSel === before.selected, 'reload: HUD hotbar shows the restored slots');
check(near(after.time, before.time, 0.01), `reload: time of day restored (${after.time.toFixed(3)} vs ${before.time.toFixed(3)})`);
await page.waitForFunction((b) => window.__game.world.getBlock(b.x, b.y, b.z) >= 0, broken);
const edited = await page.evaluate(({ broken, placeAt, placedId }) => {
  const w = window.__game.world;
  return { hole: w.getBlock(broken.x, broken.y, broken.z), placed: w.getBlock(placeAt.x, placeAt.y, placeAt.z), placedId };
}, { broken, placeAt, placedId });
check(edited.hole === 0 && edited.placed === placedId, `reload: edits restored ${JSON.stringify(edited)}`);

// Play again from the restored state, then "Save and quit to title", then Play again.
await page.click('.btn-play');
await page.waitForFunction(() => window.__game.state === 'playing');
await frames(page, 3);
p = await playerState(page);
check(p.pos.every((v, i) => near(v, before.pos[i], 0.05)), 'Play resumes where the player was');
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__game.state === 'paused');
await page.click('text=Save and quit to title');
await page.waitForFunction(() => window.__game.state === 'title' && window.__game.ui.screen === 'title');
save = await readSave();
check(save && near(save.player.x, p.pos[0], 0.05), 'Save and quit wrote the save');
await page.waitForFunction(() => !window.__game.ui.el.play.disabled, null, { timeout: 120000 });
await page.click('.btn-play');
await page.waitForFunction(() => window.__game.state === 'playing');
await frames(page, 3);
p = await playerState(page);
check(p.pos.every((v, i) => near(v, before.pos[i], 0.05)), 'Play after quitting continues at the same place');

// New world: fresh seed, no edits, spawn position; the old world must not be re-saved on unload.
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__game.state === 'paused');
await page.click('text=New world');
await page.click('text=Delete world');
await page.waitForFunction(() => !window.__booted, null, { timeout: 60000 });
await boot();
const fresh = await page.evaluate(() => {
  const g = window.__game, s = g.gen.findSpawn();
  return { seed: g.world.seed, edits: g.world.edits.size, pos: g.player.pos.slice(), spawn: [s.x, s.y, s.z], time: g.timeOfDay };
});
check(fresh.seed !== 424242, `New world has a fresh seed (${fresh.seed})`);
check(fresh.edits === 0, `New world has no edits (${fresh.edits})`);
check(fresh.pos.every((v, i) => near(v, fresh.spawn[i], 1e-6)), 'New world starts at its spawn');
check(near(fresh.time, 0.4, 0.01), `New world starts in the afternoon (${fresh.time.toFixed(3)})`);

check(errors.length === 0, `no page errors (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
await page.context().close();

// A save from before the rename (legacy key only) carries over; New world clears it too.
{
  const legacy = { seed: 31337, time: 0.1, player: { x: 10.5, y: 120, z: -20.5, yaw: 0.5, pitch: -0.2, flying: true }, hotbar: [1, 2, 3, 4, 5, 6, 7, 8, 9], selected: 4, edits: JSON.stringify([['0,0', [[1234, 1]]]]) };
  const { page, errors } = await newGamePage(browser, { width: W, height: H, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [LEGACY_SAVE_KEY]: legacy } });
  await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
  await page.evaluate(() => { window.__booted = true; });
  const got = await page.evaluate(() => { const g = window.__game; return { seed: g.world.seed, pos: g.player.pos.slice(), sel: g.player.selected, edits: g.world.exportEdits() }; });
  check(got.seed === 31337 && got.pos[0] === 10.5 && got.sel === 4 && got.edits.includes('1234'), `legacy save loads (${JSON.stringify(got)})`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
  const keys = await page.evaluate(([k, l]) => ({ now: JSON.parse(localStorage.getItem(k) || 'null'), old: !!localStorage.getItem(l) }), [SAVE_KEY, LEGACY_SAVE_KEY]);
  check(keys.now && keys.now.seed === 31337, 'the save is written under the new key');
  await waitReady(page, 2);
  await page.click('.btn-play');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__game.state === 'paused');
  await page.evaluate(() => { window.__booted = true; });
  await page.click('text=New world');
  await page.click('text=Delete world');
  await page.waitForFunction(() => !window.__booted, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
  const fresh = await page.evaluate(([k, l]) => ({ seed: window.__game.world.seed, edits: window.__game.world.edits.size, old: localStorage.getItem(l) }), [SAVE_KEY, LEGACY_SAVE_KEY]);
  check(fresh.seed !== 31337 && fresh.edits === 0 && !fresh.old, `New world also drops the legacy save (${JSON.stringify(fresh)})`);
  check(errors.length === 0, `legacy: no page errors ${errors.slice(0, 3).join(' | ')}`);
}

await browser.close();
server.close();
process.exit(finish());
