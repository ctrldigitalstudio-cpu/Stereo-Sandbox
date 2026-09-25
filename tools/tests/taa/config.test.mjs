// Settings migration and preset checks for the anti-aliasing setting (node, no browser).
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { loadSettings, DEFAULT_SETTINGS, QUALITY_PRESETS, SETTINGS_SCHEMA, PRESET_KEYS, AA_MODES, updateSetting } = await import('../../../src/config.js');
const KEY = 'stereo-sandbox.settings.v1';
const load = (saved) => { store.clear(); if (saved) store.set(KEY, JSON.stringify(saved)); return loadSettings(); };

assert.equal(DEFAULT_SETTINGS.aa, 'taa');
assert.equal(QUALITY_PRESETS.low.aa, 'fxaa');
for (const p of ['medium', 'high', 'ultra']) assert.equal(QUALITY_PRESETS[p].aa, 'taa');
assert.ok(PRESET_KEYS.includes('aa') && !PRESET_KEYS.includes('fxaa'));
const item = SETTINGS_SCHEMA.flatMap((g) => g.items).find((i) => i.key === 'aa');
assert.equal(item.label, 'Anti-aliasing');
assert.deepEqual(item.options.map((o) => o[1]), ['TAA', 'FXAA', 'Off']);
assert.deepEqual(item.options.map((o) => o[0]), AA_MODES);
assert.ok(!SETTINGS_SCHEMA.flatMap((g) => g.items).some((i) => i.key === 'fxaa'));

assert.equal(load(null).aa, 'taa');
// Old saves: untouched named preset -> the preset's current values.
let s = load({ preset: 'high', ...QUALITY_PRESETS.high, renderScale: 1, aa: undefined, fxaa: true, fov: 90 });
assert.equal(s.aa, 'taa'); assert.equal(s.renderScale, QUALITY_PRESETS.high.renderScale); assert.equal(s.fov, 90);
assert.ok(!('fxaa' in s));
s = load({ preset: 'low', renderScale: 0.75, fxaa: true });
assert.equal(s.aa, 'fxaa');
// Custom (or inconsistent) setups keep their choice.
s = load({ preset: 'custom', renderScale: 0.5, fxaa: true });
assert.equal(s.aa, 'fxaa'); assert.equal(s.renderScale, 0.5);
s = load({ preset: 'custom', renderScale: 0.5, fxaa: false });
assert.equal(s.aa, 'off');
s = load({ preset: 'low', renderDistance: 4, renderScale: 0.5, fxaa: false });
assert.equal(s.aa, 'off'); assert.equal(s.renderDistance, 4);
// New saves are taken as they are; junk falls back to the default.
assert.equal(load({ aa: 'off', fxaa: true }).aa, 'off');
assert.equal(load({ aa: 'fxaa' }).aa, 'fxaa');
assert.equal(load({ aa: 'msaa' }).aa, 'taa');
// Changing aa by hand makes the preset custom; choosing a preset sets it.
assert.equal(updateSetting(DEFAULT_SETTINGS, 'aa', 'fxaa').preset, 'custom');
assert.equal(updateSetting({ ...DEFAULT_SETTINGS, aa: 'off' }, 'preset', 'medium').aa, 'taa');
console.log('config.test: OK');
