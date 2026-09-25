#!/usr/bin/env node
// Pause -> Settings with real clicks and keys: every entry of SETTINGS_SCHEMA is changed through
// its control (each preset, render distance 4 and 16, resolution scale at both ends, every toggle
// and every option), and each change must apply live (main's settings, the renderer's state, the
// world's streaming radius, audio, HUD) while the view keeps rendering and nothing errors.
// Then Defaults, the Controls panel, Resume, and mouse sensitivity / invert-Y felt in play.
//   node tools/tests/gameplay/settings.mjs [--size 400x225]

import { startServer, launch, newGamePage, waitReady, frames, reporter, opt, sleep, LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY } from './lib.mjs';
import { SETTINGS_SCHEMA, QUALITY_PRESETS, DEFAULT_SETTINGS } from '../../../src/config.js';

const { log, check, finish } = reporter('settings');
const [W, H] = opt('size', '400x225').split('x').map(Number);
const server = await startServer();
const browser = await launch();
const { page, errors } = await newGamePage(browser, { width: W, height: H, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 12345 } } });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tabOf = {};
for (const g of SETTINGS_SCHEMA) for (const item of g.items) tabOf[item.key] = { tab: slug(g.group), item };

await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await waitReady(page, 2);
await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
await page.click('.btn-play');
await page.waitForFunction(() => window.__game.state === 'playing');
await frames(page, 2);
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__game.state === 'paused');
await page.evaluate(() => window.__game.setRender(false));   // frames are drawn by rendered() below
await page.click('.pause-panel .menu-row .btn:first-child');
await page.waitForFunction(() => window.__game.ui.screen === 'settings');
log('settings open');

const game = () => page.evaluate(() => {
  const g = window.__game, r = g.renderer;
  return {
    settings: { ...g.settings }, rs: { ...r.settings }, shadowRes: r.shadowRes, shadowTex: !!r.shadowTex,
    renderWidth: r.renderWidth, width: r.width, worldRD: g.world.renderDistance, frame: r.frameIndex,
    sound: { enabled: g.player.sound.enabled, volume: g.player.sound.volume }, stored: JSON.parse(localStorage.getItem('stereo-sandbox.settings.v1') || '{}'),
  };
});
// Draw n frames after a change and read each back (the view keeps drawing, the GPU has finished).
// The loop otherwise runs without drawing: in contended software GL a queued heavy frame (big
// shadow maps) stalls the whole browser, input included, for minutes.
const rendered = async (n = 2) => {
  for (let i = 0; i < n; i++) {
    const png = await page.evaluate(() => window.__game.capture());
    if (!png.startsWith('data:image/png')) throw new Error('no frame');
  }
};
const selectTab = async (key) => {
  const { tab } = tabOf[key];
  await page.click(`#settings-tab-${tab}`);
};
// Drive one control with real input. value: option value, or 'min' / 'max' for ranges, or a toggle.
async function setVia(key, value) {
  const { item } = tabOf[key];
  await selectTab(key);
  const id = `#setting-${key}`;
  if (item.type === 'range') {
    await page.focus(id);
    await page.keyboard.press(value === 'min' ? 'Home' : value === 'max' ? 'End' : 'ArrowRight');
  } else if (item.type === 'toggle') {
    await page.click(id);
  } else if (item.options.length <= 5) {
    const i = item.options.findIndex(([v]) => String(v) === String(value));
    await page.click(`${id} [role=radio]:nth-child(${i + 1})`);
  } else {
    await page.selectOption(id, String(value));
  }
}
const expectOf = (key, value) => {
  const { item } = tabOf[key];
  if (item.type === 'range') return value === 'min' ? item.min : item.max;
  return value;
};

// Every preset, in order. High and Ultra take minutes per frame in contended software GL and a
// queued frame stalls the whole browser (input included), so those draw exactly one frame, at a
// small size, read back to completion.
for (const p of ['low', 'medium', 'high', 'ultra', 'low']) {
  const heavy = p === 'high' || p === 'ultra';
  await setVia('preset', p);
  if (heavy) {
    await frames(page, 2);   // world.update() + applySettings, no drawing
    await page.setViewportSize({ width: 200, height: 112 });
    const t0 = Date.now();
    const png = await page.evaluate(() => window.__game.capture());
    await page.setViewportSize({ width: W, height: H });
    log(`preset ${p}: one frame drawn in ${((Date.now() - t0) / 1000).toFixed(1)} s (${png.length} bytes)`);
    check(png.startsWith('data:image/png') && png.length > 2000, `preset ${p} renders`);
  } else {
    await rendered(1);
  }
  const g = await game();
  const want = QUALITY_PRESETS[p];
  const mismatched = Object.keys(want).filter((k) => g.settings[k] !== want[k]);
  check(g.settings.preset === p && mismatched.length === 0, `preset ${p} applies all its values ${mismatched.length ? JSON.stringify(mismatched) : ''}`);
  check(g.shadowTex === want.shadows && (!want.shadows || g.shadowRes === want.shadowRes) && g.worldRD === want.renderDistance,
    `preset ${p}: renderer shadows ${g.shadowTex} (${g.shadowRes}), world radius ${g.worldRD}`);
  check(g.stored.preset === p, `preset ${p} persisted`);
  log(`preset ${p}: frame ${g.frame}`);
}
// Presets are heavy in software GL: go back to light values for the rest.
await page.evaluate(() => window.__game.setSettings({ renderScale: 0.5, shadows: false, volumetrics: 0, clouds: 0, ssr: 0, renderDistance: 4, autoResolution: false, fxaa: false }));
await rendered(1);

// Every other entry.
const plan = [];
for (const g of SETTINGS_SCHEMA) {
  for (const item of g.items) {
    if (item.key === 'preset') continue;
    if (item.type === 'range') plan.push([item.key, 'max'], [item.key, 'min']);
    else if (item.type === 'toggle') plan.push([item.key, 'toggle'], [item.key, 'toggle']);
    else for (const [v] of item.options) plan.push([item.key, v]);
  }
}
for (const [key, value] of plan) {
  const before = await game();
  // Rows that depend on another setting are disabled while it is off.
  if ((key === 'shadowRes' || key === 'pcss') && !before.settings.shadows) { await setVia('shadows', 'toggle'); await rendered(1); }
  if (key === 'volume' && !before.settings.sound) { await setVia('sound', 'toggle'); }
  // Keep software rendering bearable: shadows only while their own rows are tested.
  if (!['shadows', 'shadowRes', 'pcss'].includes(key) && before.settings.shadows) { await setVia('shadows', 'toggle'); await rendered(1); }
  const b = await game();
  await setVia(key, value);
  await rendered(key === 'renderDistance' ? 1 : 2);
  const a = await game();
  const want = value === 'toggle' ? !b.settings[key] : expectOf(key, value);
  let applied = a.settings[key] === want;
  let detail = `${JSON.stringify(b.settings[key])} -> ${JSON.stringify(a.settings[key])}`;
  if (key === 'renderDistance') { applied = applied && a.worldRD === want; detail += `, world radius ${a.worldRD}`; }
  if (key === 'renderScale') { applied = applied && a.renderWidth === Math.max(1, Math.round(a.width * want)); detail += `, render width ${a.renderWidth} of ${a.width}`; }
  if (key === 'shadows') { applied = applied && a.shadowTex === want; detail += `, shadow map ${a.shadowTex}`; }
  if (key === 'shadowRes') { applied = applied && a.shadowRes === want; detail += `, shadow map ${a.shadowRes}`; }
  if (['volumetrics', 'clouds', 'ssr', 'bloom', 'fxaa', 'pcss'].includes(key)) { applied = applied && a.rs[key] === want; detail += `, renderer ${JSON.stringify(a.rs[key])}`; }
  if (key === 'sound') { applied = applied && a.sound.enabled === want; detail += `, audio enabled ${a.sound.enabled}`; }
  if (key === 'volume') { applied = applied && Math.abs(a.sound.volume - want) < 1e-9; detail += `, audio volume ${a.sound.volume}`; }
  applied = applied && a.stored[key] === a.settings[key];
  check(applied && a.frame > b.frame, `${key} = ${JSON.stringify(want)} applies live and persists (${detail})`);
  if (key === 'renderDistance' && want === 16) {
    // Let the bigger radius actually stream for a moment, then come back down.
    await sleep(3000);
    const n = await page.evaluate(() => window.__game.world.loadedCount);
    log(`render distance 16: ${n} chunks after 3 s`);
  }
}

// Extra checks for settings whose effect is only visible in play.
await setVia('dayLength', 0);
const t0 = await page.evaluate(() => window.__game.timeOfDay);
await rendered(3);
check(await page.evaluate(() => window.__game.timeOfDay) === t0, 'day length "Frozen" stops the clock');
await setVia('dayLength', 300);
await setVia('showFps', 'toggle');
const fpsShown = await page.evaluate(() => window.__game.settings.showFps);

// Defaults resets everything (and persists).
await page.click('.btn-reset');
await rendered(1);
const d = await game();
const off = Object.keys(DEFAULT_SETTINGS).filter((k) => d.settings[k] !== DEFAULT_SETTINGS[k]);
check(off.length === 0 && Object.keys(DEFAULT_SETTINGS).every((k) => d.stored[k] === DEFAULT_SETTINGS[k]), `Defaults restores every setting ${JSON.stringify(off)}`);
await page.evaluate(() => window.__game.setSettings({ renderScale: 0.5, shadows: false, volumetrics: 0, clouds: 0, ssr: 0, renderDistance: 4, autoResolution: false, fxaa: false, showFps: true }));

// Back to pause with Escape, Controls panel, back, Resume.
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__game.ui.screen === 'pause');
check(await page.evaluate(() => window.__game.state === 'paused'), 'Escape in Settings returns to the pause menu');
await page.click('.pause-panel .menu > .menu-row .btn:last-child');
await page.waitForFunction(() => window.__game.ui.screen === 'controls');
const rows = await page.evaluate(() => document.querySelectorAll('.controls-screen .control-row').length);
check(rows >= 12, `Controls panel lists the controls (${rows} rows)`);
await page.click('.controls-screen .btn-back');
await page.waitForFunction(() => window.__game.ui.screen === 'pause');
await page.click('.pause-panel .btn-primary');
await page.waitForFunction(() => window.__game.state === 'playing');
await rendered(2);
check(await page.evaluate(() => !document.querySelector('.fps-meter').hidden), `Show FPS shows the meter in play (${fpsShown})`);

// Sensitivity and invert-Y, felt through (synthetic) locked mouse movement.
const turn = async () => {
  const a = await page.evaluate(() => [window.__game.player.yaw, window.__game.player.pitch]);
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.dispatchEvent(new MouseEvent('mousemove', { movementX: 10, movementY: 10 })); });
  await frames(page, 2);
  const b = await page.evaluate(() => [window.__game.player.yaw, window.__game.player.pitch]);
  return [b[0] - a[0], b[1] - a[1]];
};
await page.waitForFunction(() => window.__game.player.input.locked, null, { timeout: 5000 }).catch(() => null);
const locked = await page.evaluate(() => window.__game.player.input.locked);
if (locked) {
  await page.evaluate(() => window.__game.player.pitch = 0);
  const t1 = await turn();
  await page.evaluate(() => { window.__game.setSettings({ sensitivity: 2, invertY: true }); window.__game.player.pitch = 0; });
  const t2 = await turn();
  check(t1[1] < 0 && t2[1] > 0, `invert Y flips the vertical look (${t1[1].toFixed(3)} -> ${t2[1].toFixed(3)})`);
  check(Math.abs(t2[0] / t1[0] - 2) < 0.35, `sensitivity 2 turns twice as far (${(t2[0] / t1[0]).toFixed(2)}x)`);
} else log('pointer lock not granted here; skipping the sensitivity feel check');

check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
server.close();
process.exit(finish());
