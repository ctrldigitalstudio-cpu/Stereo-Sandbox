// Settings: defaults, quality presets, the schema the settings screen is built from, persistence.

const STORAGE_KEY = 'blockvale.settings.v1';

export const QUALITY_PRESETS = {
  low: {
    renderDistance: 6, renderScale: 0.75, shadows: false, shadowRes: 1024, shadowRadius: 64, pcss: false,
    volumetrics: 0, clouds: 0, ssr: 0, bloom: true, fxaa: true,
  },
  medium: {
    renderDistance: 8, renderScale: 1, shadows: true, shadowRes: 1024, shadowRadius: 96, pcss: false,
    volumetrics: 12, clouds: 10, ssr: 16, bloom: true, fxaa: true,
  },
  high: {
    renderDistance: 10, renderScale: 1, shadows: true, shadowRes: 2048, shadowRadius: 128, pcss: true,
    volumetrics: 16, clouds: 16, ssr: 24, bloom: true, fxaa: true,
  },
  ultra: {
    renderDistance: 12, renderScale: 1, shadows: true, shadowRes: 4096, shadowRadius: 160, pcss: true,
    volumetrics: 24, clouds: 24, ssr: 32, bloom: true, fxaa: true,
  },
};

export const DEFAULT_SETTINGS = {
  preset: 'high',
  ...QUALITY_PRESETS.high,
  autoResolution: true,   // lower renderScale automatically when the frame rate drops
  fov: 75,                // vertical degrees
  sensitivity: 1.0,
  invertY: false,
  dayLength: 1200,        // seconds for a full day/night cycle
  cloudCoverage: 0.45,
  sound: true,
  volume: 0.6,
  viewBobbing: true,
  showFps: false,
};

// Drives the settings screen. `apply: 'reload'` means the change needs a renderer rebuild.
export const SETTINGS_SCHEMA = [
  { group: 'Graphics', items: [
    { key: 'preset', label: 'Quality preset', type: 'select', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']] },
    { key: 'renderDistance', label: 'Render distance', type: 'range', min: 4, max: 16, step: 1, unit: ' chunks' },
    { key: 'renderScale', label: 'Resolution scale', type: 'range', min: 0.5, max: 1, step: 0.05, format: 'percent' },
    { key: 'autoResolution', label: 'Adaptive resolution', type: 'toggle' },
    { key: 'shadows', label: 'Shadows', type: 'toggle' },
    { key: 'shadowRes', label: 'Shadow quality', type: 'select', options: [[1024, '1024'], [2048, '2048'], [4096, '4096']] },
    { key: 'pcss', label: 'Soft shadows (PCSS)', type: 'toggle' },
    { key: 'volumetrics', label: 'Light shafts', type: 'select', options: [[0, 'Off'], [12, 'Low'], [16, 'Medium'], [24, 'High']] },
    { key: 'clouds', label: 'Volumetric clouds', type: 'select', options: [[0, 'Off'], [10, 'Low'], [16, 'Medium'], [24, 'High']] },
    { key: 'ssr', label: 'Water reflections', type: 'select', options: [[0, 'Sky only'], [16, 'Low'], [24, 'Medium'], [32, 'High']] },
    { key: 'bloom', label: 'Bloom', type: 'toggle' },
    { key: 'fxaa', label: 'Anti-aliasing (FXAA)', type: 'toggle' },
  ] },
  { group: 'World', items: [
    { key: 'dayLength', label: 'Day length', type: 'select', options: [[300, '5 min'], [600, '10 min'], [1200, '20 min'], [2400, '40 min'], [0, 'Frozen']] },
    { key: 'cloudCoverage', label: 'Cloud cover', type: 'range', min: 0, max: 1, step: 0.05, format: 'percent' },
  ] },
  { group: 'Controls', items: [
    { key: 'fov', label: 'Field of view', type: 'range', min: 50, max: 110, step: 1, unit: '°' },
    { key: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.2, max: 3, step: 0.05, format: 'multiplier' },
    { key: 'invertY', label: 'Invert mouse', type: 'toggle' },
    { key: 'viewBobbing', label: 'View bobbing', type: 'toggle' },
  ] },
  { group: 'Audio & display', items: [
    { key: 'sound', label: 'Sound', type: 'toggle' },
    { key: 'volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05, format: 'percent' },
    { key: 'showFps', label: 'Show FPS', type: 'toggle' },
  ] },
];

// Keys that belong to a quality preset; changing one of them switches the preset to 'custom'.
export const PRESET_KEYS = Object.keys(QUALITY_PRESETS.high);

export function loadSettings() {
  let saved = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw) || {};
  } catch (e) { /* storage unavailable */ }
  const s = { ...DEFAULT_SETTINGS };
  for (const k in saved) if (k in DEFAULT_SETTINGS) s[k] = saved[k];
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

// Returns a new settings object with `key` changed, applying preset logic.
export function updateSetting(s, key, value) {
  const next = { ...s, [key]: value };
  if (key === 'preset' && QUALITY_PRESETS[value]) Object.assign(next, QUALITY_PRESETS[value]);
  else if (PRESET_KEYS.includes(key)) next.preset = 'custom';
  return next;
}
