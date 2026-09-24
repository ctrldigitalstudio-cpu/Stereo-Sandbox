// UI harness: paints a stand-in "3D world" on the canvas and drives src/ui.js into one screen
// (?screen=boot|title|loading|pause|confirm|settings|controls|inventory|search|hud|debug|underwater|selftest).
// Extra flags: bg=warm|bright|night, tab=<settings group slug>, boot (keep the boot splash).

import { UI, formatSetting, clockTime } from '../../../src/ui.js';
import { buildTextures } from '../../../src/textures.js';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA, QUALITY_PRESETS } from '../../../src/config.js';
import { B, BLOCKS, INVENTORY, DEFAULT_HOTBAR } from '../../../src/blocks.js';

const q = new URLSearchParams(location.search);
const screen = q.get('screen') || 'title';
const bg = q.get('bg') || 'warm';

// ---- stand-in world: golden-hour sky, hazy blocky mountains, hills, water, trees ----------------
function paint() {
  const c = document.getElementById('game');
  c.width = innerWidth;
  c.height = innerHeight;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const skies = {
    warm: ['#46679f', '#b89aa3', '#f3bb82', '#ffd9a0'],
    bright: ['#5f9be0', '#9cc6f2', '#dcebfa', '#f4f8fc'],
    night: ['#050a18', '#0b1630', '#16264a', '#243a62'],
  };
  const sky = skies[bg] || skies.warm;
  const grad = g.createLinearGradient(0, 0, 0, H * 0.68);
  sky.forEach((col, i) => grad.addColorStop(i / (sky.length - 1), col));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  if (bg !== 'night') {
    const sun = g.createRadialGradient(W * 0.7, H * 0.5, 0, W * 0.7, H * 0.5, H * 0.5);
    sun.addColorStop(0, bg === 'bright' ? 'rgba(255,255,255,0.95)' : 'rgba(255,240,200,0.95)');
    sun.addColorStop(0.08, bg === 'bright' ? 'rgba(255,255,255,0.5)' : 'rgba(255,200,120,0.5)');
    sun.addColorStop(1, 'rgba(255,190,120,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, W, H);
  } else {
    g.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 160; i++) g.fillRect((Math.sin(i * 91.7) * 0.5 + 0.5) * W, (Math.sin(i * 53.1) * 0.5 + 0.5) * H * 0.55, 1.5, 1.5);
  }
  const bs = Math.max(6, Math.round(W / 110));
  const layers = bg === 'night'
    ? [[0.5, 0.2, '#101a2e'], [0.62, 0.12, '#0b1322'], [0.74, 0.08, '#070c16']]
    : bg === 'bright'
      ? [[0.46, 0.22, '#b8c9dc'], [0.58, 0.14, '#6f9a6a'], [0.7, 0.1, '#4f7d3f']]
      : [[0.46, 0.22, '#8d8ea8'], [0.58, 0.14, '#5b6f53'], [0.7, 0.1, '#3f5a2f']];
  layers.forEach(([base, amp, col], li) => {
    g.fillStyle = col;
    for (let x = 0; x < W; x += bs) {
      const t = x / W;
      const hgt = Math.sin(t * 7 + li * 2) * 0.5 + Math.sin(t * 17 + li) * 0.25 + Math.sin(t * 3.1 + li * 5) * 0.6;
      const y = Math.round((H * (base - amp * hgt * 0.5)) / bs) * bs;
      g.fillRect(x, y, bs, H - y);
      if (li === 1 && ((x / bs) | 0) % 13 === 5) {
        g.fillStyle = bg === 'night' ? '#0a1424' : '#2f4a26';
        g.fillRect(x - bs, y - bs * 4, bs * 3, bs * 3);
        g.fillStyle = bg === 'night' ? '#0d0a08' : '#5a3f28';
        g.fillRect(x, y - bs, bs, bs);
        g.fillStyle = col;
      }
    }
  });
  const wy = Math.round(H * 0.8 / bs) * bs;
  const wg = g.createLinearGradient(0, wy, 0, H);
  wg.addColorStop(0, bg === 'night' ? '#0b1a30' : '#3c7f98');
  wg.addColorStop(1, bg === 'night' ? '#050b16' : '#1c4561');
  g.fillStyle = wg;
  g.fillRect(0, wy, W * 0.55, H - wy);
  g.fillStyle = 'rgba(255,255,255,0.2)';
  for (let i = 0; i < 20; i++) g.fillRect(((i * 97) % 100) / 100 * W * 0.5, wy + bs * (1 + (i % 5)), bs * 3, 1);
}
paint();
addEventListener('resize', paint);

// ---- UI -------------------------------------------------------------------------------------------
const calls = { play: 0, resume: 0, newWorld: 0, quit: 0, settings: [], hotbar: [], invClose: 0 };
const textures = buildTextures();
const settings = { ...DEFAULT_SETTINGS, showFps: true };
const opts = {
  textures,
  settings,
  seed: 1234567,
  onPlay: () => { calls.play++; },
  onResume: () => { calls.resume++; },
  onNewWorld: () => { calls.newWorld++; },
  onQuit: () => { calls.quit++; },
  onSettingsChange: (next) => { calls.settings.push(next); },
  onHotbarChange: (ids, sel) => { calls.hotbar.push([ids, sel]); },
};
if (q.has('done')) opts.onInventoryClose = () => { calls.invClose++; ui.toggleInventory(false); };
// ?screen=boot shows the static splash from the page markup (no UI constructed).
const ui = screen === 'boot' ? null : new UI(opts);
window.__ui = ui;
window.__calls = calls;

const info = {
  fps: 58.7, pos: [123.456, 71.62, -842.25], yaw: 0.6, pitch: -0.21, biome: 'Birch Forest', chunks: 317,
  drawCalls: 412, quads: 1234567, time: 0.36, flying: false, underwater: false, target: 'Oak Leaves',
  debug: false, hideHud: false, showFps: false, renderScale: 0.85, state: 'playing',
};

function frame() {
  info.fps = 58 + Math.sin(performance.now() / 300) * 2;
  ui.update(info);
  requestAnimationFrame(frame);
}

function inGame() {
  ui.hideTitle();
  ui.setHotbar(DEFAULT_HOTBAR, 3);
}

async function setup() {
  switch (screen) {
    case 'title':
      ui.showTitle();
      ui.setLoading(1, 'World ready');
      info.state = 'title';
      break;
    case 'loading':
      ui.showTitle();
      ui.setLoading(0.42, 'Generating terrain · 42%');
      info.state = 'title';
      break;
    case 'pause':
    case 'confirm':
      inGame();
      ui.showPause();
      info.state = 'paused';
      if (screen === 'confirm') ui.el.newWorld.click();
      break;
    case 'settings':
    case 'controls':
      inGame();
      ui.showPause();
      info.state = 'paused';
      ui._openSub(screen, null);
      if (q.get('tab')) ui._selectTab(q.get('tab'));
      if (q.has('focus')) {
        // Show keyboard focus styling on a control
        const el = document.querySelector(q.get('focus'));
        if (el) el.focus();
      }
      break;
    case 'inventory':
    case 'search':
      inGame();
      ui.toggleInventory(true);
      if (screen === 'search') {
        ui.el.search.value = q.get('q') || 'wool';
        ui.el.search.dispatchEvent(new Event('input'));
      } else {
        // Simulate a hover to show the tooltip and the in-hotbar dots.
        const item = ui._items[INVENTORY.indexOf(B.OAK_PLANKS)];
        item.dispatchEvent(new MouseEvent('mouseenter'));
        ui._items[INVENTORY.indexOf(B.GLOWSTONE)].click();
      }
      break;
    case 'hud':
    case 'debug':
    case 'underwater':
      inGame();
      info.showFps = true;
      info.debug = screen === 'debug';
      info.underwater = screen === 'underwater';
      ui.setHotbar(DEFAULT_HOTBAR, 5);
      ui.toast('Mouse capture is blocked here. Drag with the mouse to look around.');
      ui.toast('World saved');
      break;
    case 'selftest':
      break;
    default:
      console.error(`unknown screen ${screen}`);
  }
  requestAnimationFrame(frame);
  if (screen === 'selftest') await selftest();
  await new Promise((r) => setTimeout(r, q.has('boot') ? 0 : 900));
  window.__done = true;
}

// ---- self test ----------------------------------------------------------------------------------
let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`ok   ${msg}`);
  else { failures++; console.error(`FAIL ${msg}`); }
}
const key = (code, keyName, target = document.activeElement || document.body) => {
  const e = new KeyboardEvent('keydown', { code, key: keyName ?? code, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const tick = () => new Promise((r) => requestAnimationFrame(() => r()));

async function selftest() {
  ok(!ui.menuOpen && !ui.inventoryOpen, 'initially no menu open');
  ok(document.querySelectorAll('#ui .boot').length <= 1, 'boot splash handed over');

  // Title + loading
  ui.showTitle();
  ok(ui.menuOpen && ui.screen === 'title', 'showTitle opens the title');
  ui.setLoading(0.5, 'Generating terrain · 50%');
  ok(ui.el.play.disabled, 'Play disabled while loading');
  ok(ui.el.status.textContent === 'Generating terrain · 50%', 'status text shown');
  ui.el.play.click();
  ok(calls.play === 0, 'disabled Play does not call onPlay');
  key('Enter', 'Enter', document.body);
  ok(calls.play === 0, 'Enter does nothing before the world is ready');
  ui.setLoading(1, 'World ready');
  ok(!ui.el.play.disabled, 'Play enabled at fraction 1');
  ui.el.play.click();
  ok(calls.play === 1, 'Play calls onPlay');
  document.activeElement.blur();
  key('Enter', 'Enter', document.body);
  ok(calls.play === 2, 'Enter on the title (nothing focused) plays');

  // Settings from the title; Escape goes back; hideTitle closes a sub-panel opened from it.
  ui._openSub('settings', ui.el.play);
  ok(ui.screen === 'settings' && ui.menuOpen, 'settings open from title');
  key('Escape', 'Escape');
  ok(ui.screen === 'title', 'Escape in settings returns to the title');
  ui._openSub('controls', null);
  ui.hideTitle();
  ok(ui.screen === null && !ui.menuOpen, 'hideTitle also closes a sub-panel opened from the title');

  // Pause flow
  ui.showPause();
  ok(ui.screen === 'pause' && ui.menuOpen, 'showPause');
  ok(document.activeElement === ui.el.resume, 'Resume focused on pause');
  ui.el.resume.click();
  ok(calls.resume === 1, 'Resume calls onResume');
  ui.el.newWorld.click();
  ok(!ui.el.confirmBox.hidden && ui.el.pauseMenu.hidden, 'New world asks for inline confirmation');
  key('Escape', 'Escape');
  ok(ui.el.confirmBox.hidden && ui.screen === 'pause', 'Escape cancels the confirmation, stays paused');
  ui.el.newWorld.click();
  ui.el.confirmBox.querySelector('.btn-danger').click();
  ok(calls.newWorld === 1, 'Delete world calls onNewWorld');
  ui._confirm(false);
  const quitBtn = [...ui.el.pauseMenu.querySelectorAll('button')].find((b) => /quit/i.test(b.textContent));
  quitBtn.click();
  ok(calls.quit === 1, 'Save and quit calls onQuit');
  key('Escape', 'Escape');
  ok(ui.screen === 'pause', 'Escape on the pause root is left to main.js');
  const settingsBtn = [...ui.el.pauseMenu.querySelectorAll('button')].find((b) => b.textContent === 'Settings');
  settingsBtn.click();
  ok(ui.screen === 'settings', 'Settings from pause');
  key('Escape', 'Escape');
  ok(ui.screen === 'pause' && document.activeElement === settingsBtn, 'Escape returns to pause and restores focus');
  settingsBtn.click();
  ui.hidePause();
  ok(ui.screen === null, 'hidePause closes a sub-panel opened from pause');

  // Game keys belong to main.js: the UI must not react to E / Escape / F1 / F3 while playing.
  document.activeElement.blur();
  for (const c of ['KeyE', 'Escape', 'F1', 'F3']) key(c, c === 'KeyE' ? 'e' : c, document.body);
  ok(!ui.menuOpen && !ui.inventoryOpen, 'UI ignores E / Escape / F1 / F3 during play');

  // Hotbar
  calls.hotbar.length = 0;
  ui.setHotbar(DEFAULT_HOTBAR, 4);
  ui.el.blockName.textContent = '';
  ui.setHotbar(DEFAULT_HOTBAR.slice(), 4);
  ok(ui.el.blockName.textContent === '', 'unchanged setHotbar does not flash the name');
  ui.setHotbar(DEFAULT_HOTBAR, 2);
  ok(calls.hotbar.length === 0, 'setHotbar never calls onHotbarChange');
  ok(ui.el.hudSlots[2].classList.contains('is-selected') && !ui.el.hudSlots[4].classList.contains('is-selected'), 'selected slot highlighted');
  ok(ui.el.blockName.textContent === BLOCKS[DEFAULT_HOTBAR[2]].label && ui.el.blockName.classList.contains('is-shown'), 'selection change shows the block name');

  // Inventory
  ok(ui.toggleInventory(true) === true && ui.inventoryOpen && ui.menuOpen, 'toggleInventory(true)');
  key('KeyE', 'e', ui.el.grid);
  key('Escape', 'Escape', ui.el.grid);
  ok(ui.inventoryOpen, 'UI leaves E / Escape in the inventory to main.js');
  const glassIdx = INVENTORY.indexOf(B.GLASS);
  ui._items[glassIdx].click();
  let last = calls.hotbar.at(-1);
  ok(last && last[0][2] === B.GLASS && last[1] === 2, 'click assigns the block to the selected slot');
  ok(ui.hotbar[2] === B.GLASS, 'local hotbar updated immediately');
  ui._items[INVENTORY.indexOf(B.SAND)].focus();
  key('Digit5', '5');
  last = calls.hotbar.at(-1);
  ok(last && last[0][4] === B.SAND && last[1] === 2, 'digit key puts the focused block in that slot');
  document.activeElement.blur();
  ui._hoverId = 0;
  key('Digit7', '7', document.body);
  ok(calls.hotbar.at(-1)[1] === 6 && ui.selected === 6, 'digit key with nothing hovered selects the slot');
  ui.el.invSlots[0].click();
  ok(ui.selected === 0 && calls.hotbar.at(-1)[1] === 0, 'clicking an inventory hotbar slot selects it');
  // Arrow navigation
  ui._items[0].focus();
  key('ArrowRight', 'ArrowRight');
  ok(document.activeElement === ui._items[1], 'ArrowRight moves focus');
  key('ArrowDown', 'ArrowDown');
  ok(document.activeElement === ui._items[10], 'ArrowDown moves one row (9 columns)');
  key('Enter', 'Enter');
  // Enter on a button fires click natively only for real key events; check via click semantics instead.
  // Search
  ui.el.search.focus();
  ui.el.search.value = 'wool';
  ui.el.search.dispatchEvent(new Event('input'));
  const vis = ui._items.filter((i) => !i.hidden).length;
  ok(vis === 6, `search "wool" shows 6 blocks (got ${vis})`);
  key('Escape', 'Escape', ui.el.search);
  ok(ui.el.search.value === '' && ui._items.every((i) => !i.hidden) && ui.inventoryOpen, 'Escape in search clears it');
  key('Escape', 'Escape', ui.el.search);
  ok(document.activeElement !== ui.el.search && ui.inventoryOpen, 'second Escape leaves the field (main closes the inventory)');
  ui.el.search.value = 'zzz';
  ui.el.search.dispatchEvent(new Event('input'));
  ok(!ui.el.invEmpty.hidden, 'empty search result message');
  ui.el.search.value = '';
  ui.el.search.dispatchEvent(new Event('input'));
  ok(ui.toggleInventory(false) === false && !ui.menuOpen, 'toggleInventory(false)');
  ok(ui.toggleInventory() === true && ui.toggleInventory() === false, 'toggleInventory() toggles');

  // Settings
  calls.settings.length = 0;
  const rd = document.getElementById('setting-renderDistance');
  rd.value = '7';
  rd.dispatchEvent(new Event('input'));
  last = calls.settings.at(-1);
  ok(last && last.renderDistance === 7 && last.preset === 'custom', 'range applies via updateSetting (preset -> custom)');
  ok(ui.el.settings.querySelector('[data-key="renderDistance"] output').textContent === '7 chunks', 'range readout with unit');
  const presetLow = [...document.querySelectorAll('#setting-preset .seg')].find((b) => b.textContent === 'Low');
  presetLow.click();
  last = calls.settings.at(-1);
  ok(last.preset === 'low' && last.renderDistance === QUALITY_PRESETS.low.renderDistance && last.shadows === false, 'preset applies all its values');
  ok(Number(rd.value) === QUALITY_PRESETS.low.renderDistance, 'controls refresh after a preset change');
  ok(document.querySelector('[data-key="pcss"]').classList.contains('is-disabled'), 'PCSS row disabled while shadows are off');
  document.getElementById('setting-shadows').click();
  ok(calls.settings.at(-1).shadows === true && !document.querySelector('[data-key="pcss"]').classList.contains('is-disabled'), 'toggle switch applies and re-enables dependants');
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('stereo-sandbox.settings.v1')); } catch (e) { /* ignore */ }
  ok(stored && stored.shadows === true && stored.preset === 'custom', 'settings saved with saveSettings()');
  const n = calls.settings.length;
  document.getElementById('setting-shadows').click();
  document.getElementById('setting-shadows').click();
  ok(calls.settings.length === n + 2, 'each change calls onSettingsChange once');
  ui.setSettings({ fov: 90 });
  ok(document.getElementById('setting-fov').value === '90', 'setSettings refreshes the panel');
  const ids = SETTINGS_SCHEMA.flatMap((g) => g.items.map((i) => `setting-${i.key}`));
  ok(ids.every((id) => document.getElementById(id)), 'every schema item has a control with a stable id');

  ok(formatSetting({ format: 'percent' }, 0.75) === '75%', 'percent format');
  ok(formatSetting({ format: 'multiplier' }, 1.25) === '1.25×', 'multiplier format');
  ok(formatSetting({ unit: '°', step: 1 }, 75) === '75°', 'unit format');
  ok(clockTime(0) === '06:00' && clockTime(0.25) === '12:00' && clockTime(0.5) === '18:00' && clockTime(0.75) === '00:00', 'clock time');

  // Toasts
  ui.toast('Hello');
  ui.toast('Hello');
  ok(ui.el.toasts.children.length === 1, 'duplicate toast is merged');
  for (let i = 0; i < 6; i++) ui.toast(`Toast ${i}`);
  ok(ui.el.toasts.children.length === 4, 'at most 4 toasts');

  // update(): no DOM writes when nothing visible changes; debug throttled.
  const base = { ...info, showFps: false, debug: false, state: 'playing' };
  ui.update(base);
  await tick();
  let mutations = 0;
  // Fade timers (block name, inventory note, toasts) may fire meanwhile; they aren't update()'s doing.
  const timerDriven = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest('.block-name, .inv-note, .toasts, .boot');
  const mo = new MutationObserver((list) => { mutations += list.filter((m) => !timerDriven(m.target)).length; });
  mo.observe(ui.root, { subtree: true, childList: true, attributes: true, characterData: true });
  for (let i = 0; i < 300; i++) ui.update({ ...base, fps: 50 + (i % 10), pos: [i, 70, i] });
  await tick();
  ok(mutations === 0, `update() with a hidden debug/fps panel writes nothing (got ${mutations} mutations)`);
  mutations = 0;
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < 500) {
    ui.update({ ...base, debug: true, fps: 50 + (frames % 10), pos: [frames * 0.1, 70, 3] });
    frames++;
    if (frames % 50 === 0) await tick();
  }
  await tick();
  const writesPerSec = mutations / 0.5;
  ok(writesPerSec < 12 * 10, `debug panel refresh throttled (~${writesPerSec.toFixed(0)} mutations/s over ${frames} updates)`);
  mo.disconnect();
  const t1 = performance.now();
  for (let i = 0; i < 20000; i++) ui.update(base);
  const per = ((performance.now() - t1) / 20000) * 1000;
  ok(per < 5, `update() cost ${per.toFixed(2)} µs per call`);

  ui.update({ ...base, hideHud: true });
  ok(ui.el.hotbar.hidden && ui.el.crosshair.hidden, 'hideHud hides hotbar and crosshair');
  ui.update({ ...base, underwater: true });
  ok(ui.el.underwater.classList.contains('is-on'), 'underwater tint toggles');
  ui.update({ ...base, state: 'title' });
  ok(ui.el.hotbar.hidden, 'no HUD on the title state');

  console.log(failures ? `SELFTEST FAILED (${failures})` : 'SELFTEST PASSED');
  if (failures) console.error('selftest failures');
}

if (ui) setup();
else window.__done = true;
