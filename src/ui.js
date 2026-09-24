// Menus, HUD and the creative inventory. Every element is built here inside #ui, so the page shell
// stays minimal and the UI can be exercised on its own (tools/tests/ui/).
//
// Key ownership: main.js handles the game keys through Input (E opens/closes the inventory, Escape
// pauses or closes the inventory while playing, F1, F3). The UI never toggles the inventory or the
// pause menu from the keyboard; it only reacts to keys inside its own panels:
//   - Escape in Settings / Controls goes back to the screen that opened them.
//   - Escape in the new-world confirm cancels it.
//   - Enter on the title screen (nothing focused) presses Play once the world is ready.
//   - Inventory: arrows / Home / End move through the grid, Enter or Space assigns, 1-9 puts the
//     hovered or focused block into that slot (or selects the slot), "/" focuses search. Input
//     ignores keys typed into the search box, so Escape there is handled here: it clears the text,
//     then leaves the field (the next Escape reaches main.js and closes the inventory, or
//     onInventoryClose is called directly when main provides it).

import { BLOCKS, B, INVENTORY, DEFAULT_HOTBAR } from './blocks.js';
import { SETTINGS_SCHEMA, DEFAULT_SETTINGS, updateSetting, saveSettings } from './config.js';
import { makeBlockIcon } from './textures.js';

const VERSION = '1.0';
const SLOTS = 9;
const TOAST_MS = 3400;
const MAX_TOASTS = 4;
const NAME_MS = 1500;         // selected block name above the hotbar before it fades
const DEBUG_MS = 125;         // F3 panel refresh interval (8 per second)
const FPS_MS = 250;

// Rows that only matter while another setting is on: dimmed and disabled otherwise.
const DEPENDS = { shadowRes: 'shadows', pcss: 'shadows', volume: 'sound' };

// Controls cheat-sheet. A key is [label, note?]; a mouse key is { mouse: 'left'|'right'|'middle'|'move', text }.
const mouse = (which, text) => ({ mouse: which, text });
const CONTROLS = [
  ['Movement', [
    ['Move', [['W'], ['A'], ['S'], ['D']]],
    ['Look around', [mouse('move', 'Mouse')]],
    ['Jump, swim, fly up', [['Space']]],
    ['Toggle flying', [['Space', '×2'], 'or', ['F']]],
    ['Sneak, fly down', [['Shift']]],
    ['Sprint', [['W', '×2'], 'or', ['R']]],
  ]],
  ['Building', [
    ['Break block', [mouse('left', 'Left')]],
    ['Place block', [mouse('right', 'Right')]],
    ['Pick block', [mouse('middle', 'Middle')]],
    ['Select slot', [['1'], '–', ['9'], 'or', mouse('middle', 'Wheel')]],
    ['Creative inventory', [['E']]],
  ]],
  ['Interface', [
    ['Pause and settings', [['Esc']]],
    ['Hide HUD', [['F1']]],
    ['Debug info', [['F3']]],
  ]],
];

// 1-bit pixel glyphs ('#' = currentColor, 'a' = accent) drawn as crisp SVG.
const GLYPHS = {
  back: ['...##', '..##.', '.##..', '##...', '.##..', '..##.', '...##'],
  search: ['.####...', '#....#..', '#....#..', '#....#..', '#....#..', '.####...', '.....##.', '......##'],
  reset: ['..####.', '.#....#', '#......', '#......', '#....##', '.#...##', '..####.'],
};
function mouseGlyph(which) {
  const l = which === 'left' ? 'a' : '.', r = which === 'right' ? 'a' : '.', m = which === 'middle' ? 'a' : '.';
  return [
    '.#####.',
    `#${l}${l}${m}${r}${r}#`,
    `#${l}${l}${m}${r}${r}#`,
    `#${l}${l}#${r}${r}#`,
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#.....#',
    '.#####.',
  ];
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, v | 0));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isTextField = (t) => !!t && (t.tagName === 'TEXTAREA' || t.isContentEditable ||
  (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(t.type || 'text')));

// Tiny element builder: h('button', { class, onclick, 'aria-x': ... }, children...)
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function pixelSvg(rows, cls = '') {
  const w = rows[0].length, ht = rows.length;
  let d = '', a = '';
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      if (c === '#') d += `M${x} ${y}h1v1h-1z`;
      else if (c === 'a') a += `M${x} ${y}h1v1h-1z`;
    }
  }
  const t = document.createElement('template');
  t.innerHTML = `<svg class="px ${cls}" viewBox="0 0 ${w} ${ht}" width="${w * 2}" height="${ht * 2}" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><path fill="currentColor" d="${d}"/>${a ? `<path class="px-accent" d="${a}"/>` : ''}</svg>`;
  return t.content.firstChild;
}

function stepDecimals(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function formatSetting(item, v) {
  if (item.format === 'percent') return `${Math.round(v * 100)}%`;
  if (item.format === 'multiplier') return `${Number(v).toFixed(2)}×`;
  return `${Number(v).toFixed(stepDecimals(item.step ?? 1))}${item.unit || ''}`;
}

function formatCount(n) {
  if (!Number.isFinite(n)) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

// timeOfDay: 0 = sunrise (06:00), 0.25 = noon, 0.5 = sunset (18:00), 0.75 = midnight.
export function clockTime(t) {
  const minutes = Math.floor((((t % 1) + 1) % 1) * 1440 + 360) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function dayPhase(t) {
  const f = ((t % 1) + 1) % 1;
  if (f < 0.03 || f > 0.97) return 'sunrise';
  if (f > 0.47 && f < 0.53) return 'sunset';
  return f < 0.5 ? 'day' : 'night';
}

// yaw = 0 looks toward -Z (north); positive yaw turns left (toward -X, west).
function facing(yaw) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  if (Math.abs(fz) >= Math.abs(fx)) return fz < 0 ? 'North (−Z)' : 'South (+Z)';
  return fx > 0 ? 'East (+X)' : 'West (−X)';
}

const deg = (r) => {
  let d = (r * 180) / Math.PI;
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return `${d.toFixed(1)}°`;
};

const schedule = typeof requestIdleCallback === 'function'
  ? (fn) => requestIdleCallback(fn, { timeout: 400 })
  : (fn) => setTimeout(fn, 32);

export class UI {
  // opts: { textures, settings, onSettingsChange(next), onPlay(), onResume(), onNewWorld(), onQuit()?,
  //         onHotbarChange(ids, selected)?, onInventoryClose()?, sound?, seed?, version?, root? }
  constructor(opts = {}) {
    this.opts = opts;
    this.textures = opts.textures || null;
    this.settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
    this.hotbar = DEFAULT_HOTBAR.slice(0, SLOTS);
    this.selected = 0;
    this.screen = null;             // 'title' | 'pause' | 'settings' | 'controls' | null
    this._return = null;            // screen that Settings / Controls go back to
    this._opener = null;            // button that opened the current sub-panel (focus returns there)
    this._invOpen = false;
    this._confirming = false;
    this._hotbarReady = false;
    this._icons = new Map();        // block id -> data URL ('' when no icon could be made)
    this._shown = {};               // last visibility written by update()
    this._debugT = -1e9;
    this._fpsT = -1e9;
    this._loading = { f: -1, text: null, ready: false };
    this._tab = slug(SETTINGS_SCHEMA[0].group);
    this._hoverId = 0;
    this._invActive = 0;            // index into INVENTORY of the roving-tabindex item
    this._nameTimer = 0;
    this._invNoteTimer = 0;
    this.el = {};

    let root = opts.root || document.getElementById('ui');
    if (!root) {
      root = h('div', { id: 'ui' });
      document.body.append(root);
    }
    this.root = root;
    const boot = root.querySelector('.boot');
    root.textContent = '';

    root.append(
      this._buildUnderwater(),
      this._buildHud(),
      this._buildTitle(),
      this._buildPause(),
      this._buildSettings(),
      this._buildControls(),
      this._buildInventory(),
      this._buildToasts(),
      this._buildTooltip(),
    );
    for (const s of ['title', 'pause', 'settings', 'controls', 'inventory']) this._setOpen(this.el[s], false);
    this._renderAllSlots();
    this._refreshSettings();

    // Cross-fade the static boot splash from index.html into the live UI.
    if (boot) {
      root.append(boot);
      requestAnimationFrame(() => requestAnimationFrame(() => boot.classList.add('is-leaving')));
      setTimeout(() => boot.remove(), reducedMotion() ? 0 : 700);
    }

    this._onKey = (e) => this._handleKey(e);
    this._onResize = () => this._hideTooltip();
    document.addEventListener('keydown', this._onKey);
    addEventListener('resize', this._onResize);
    this._warmIcons();
  }

  // ---- public API ----------------------------------------------------------------------------

  get inventoryOpen() { return this._invOpen; }

  // True while any overlay that should block gameplay input is visible.
  get menuOpen() { return this.screen !== null || this._invOpen; }

  setLoading(fraction, text) {
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    const L = this._loading;
    const ready = f >= 1;
    if (Math.abs(f - L.f) >= 0.001 || ready !== L.ready) {
      L.f = f;
      this.el.progressFill.style.transform = `scaleX(${f})`;
      this.el.progress.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    }
    if (ready !== L.ready) {
      L.ready = ready;
      this.el.play.disabled = !ready;
      this.el.title.classList.toggle('is-ready', ready);
    }
    const t = text == null ? (ready ? 'World ready' : 'Generating terrain') : String(text);
    if (t !== L.text) {
      L.text = t;
      this.el.status.textContent = t;
    }
  }

  showTitle() {
    if (this._invOpen) this.toggleInventory(false);
    this._confirm(false);
    this._setScreen('title');
    this._releasePointer();
  }

  hideTitle() {
    if (this.screen === 'title' || (this._isSub() && this._return === 'title')) this._setScreen(null);
  }

  showPause() {
    if (this._invOpen) this.toggleInventory(false);
    this._confirm(false);
    this._setScreen('pause');
    this._releasePointer();
    this._focus(this.el.resume);
  }

  hidePause() {
    if (this.screen === 'pause' || (this._isSub() && this._return === 'pause')) this._setScreen(null);
  }

  // open: true / false, or undefined to toggle. Returns the new state.
  toggleInventory(open) {
    const next = open === undefined ? !this._invOpen : !!open;
    if (next === this._invOpen) return next;
    this._invOpen = next;
    if (next) {
      this._fillInventoryIcons();
      this._renderInvMarks();
      const i = INVENTORY.indexOf(this.hotbar[this.selected]);
      this._setInvActive(i >= 0 && !this._items[i].hidden ? i : this._firstVisible());
    } else {
      this._hideTooltip();
      this._hoverId = 0;
    }
    this._setOpen(this.el.inventory, next);
    this._syncRootState();
    if (next) {
      this._releasePointer();
      this._focus(this.el.grid);
    }
    return next;
  }

  setHotbar(ids, selected = this.selected) {
    const sel = Number.isInteger(selected) ? clampInt(selected, 0, SLOTS - 1) : this.selected;
    let slotChanged = false;
    for (let i = 0; i < SLOTS; i++) {
      const id = ids && Number.isInteger(ids[i]) && BLOCKS[ids[i]] ? ids[i] : 0;
      if (id !== this.hotbar[i] || !this._hotbarReady) {
        this.hotbar[i] = id;
        this._renderSlot(i);
        if (i === sel) slotChanged = true;
      }
    }
    const selChanged = sel !== this.selected;
    if (selChanged || !this._hotbarReady) {
      this.selected = sel;
      this._renderSelection();
    }
    if (this._hotbarReady && (selChanged || slotChanged)) this._flashName(this.hotbar[sel]);
    if (this._invOpen && slotChanged) this._renderInvMarks();
    this._hotbarReady = true;
  }

  // Per-frame HUD refresh. Only touches the DOM when something visible changed.
  update(info = {}) {
    const now = performance.now();
    const state = info.state || (this.screen === 'title' ? 'title' : 'playing');
    const inGame = state !== 'title' && this.screen !== 'title';
    const hud = inGame && !info.hideHud;
    const debug = inGame && !!info.debug;
    const fps = !!info.showFps && !debug && !(inGame && info.hideHud);

    this._show('hotbar', hud && !this._invOpen);
    this._show('crosshair', hud && state === 'playing' && !this.menuOpen);
    this._show('fps', fps);
    if (this._show('debug', debug)) this._debugT = -1e9;
    this._flag(this.root, 'debug-on', debug);
    this._flag(this.el.underwater, 'is-on', inGame && !!info.underwater);

    if (fps && now - this._fpsT >= FPS_MS) {
      this._fpsT = now;
      this._text(this.el.fps, `${Math.round(info.fps || 0)} FPS`);
    }
    if (debug && now - this._debugT >= DEBUG_MS) {
      this._debugT = now;
      this._renderDebug(info);
    }
  }

  toast(text, ms = TOAST_MS) {
    if (text == null || text === '') return null;
    const msg = String(text);
    const box = this.el.toasts;
    const last = box.lastElementChild;
    if (last && last.textContent === msg && !last.classList.contains('is-leaving')) {
      clearTimeout(last._timer);
      last._timer = setTimeout(() => this._dismissToast(last), ms);
      return last;
    }
    const el = h('div', { class: 'toast' }, msg);
    box.append(el);
    while (box.children.length > MAX_TOASTS) box.firstElementChild.remove();
    el._timer = setTimeout(() => this._dismissToast(el), ms);
    return el;
  }

  // Replace the settings the panel shows (e.g. when main changed them itself).
  setSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    this._refreshSettings();
  }

  destroy() {
    document.removeEventListener('keydown', this._onKey);
    removeEventListener('resize', this._onResize);
    clearTimeout(this._nameTimer);
    clearTimeout(this._invNoteTimer);
    this.root.textContent = '';
  }

  // ---- screens -------------------------------------------------------------------------------

  _isSub() { return this.screen === 'settings' || this.screen === 'controls'; }

  _setScreen(name) {
    this.screen = name;
    for (const s of ['title', 'pause', 'settings', 'controls']) this._setOpen(this.el[s], s === name);
    this._syncRootState();
  }

  _syncRootState() {
    this.root.dataset.screen = this.screen || (this._invOpen ? 'inventory' : 'game');
  }

  _setOpen(el, open) {
    el.classList.toggle('is-open', open);
    el.inert = !open;
    el.setAttribute('aria-hidden', String(!open));
    if (!open && el.contains(document.activeElement)) document.activeElement.blur();
  }

  _openSub(name, opener) {
    if (!this._isSub()) this._return = this.screen;
    this._opener = opener || null;
    this._setScreen(name);
    this._focus(name === 'settings' ? this._tabs.get(this._tab).tab : this.el.controlsBack);
  }

  _back() {
    const to = this._return;
    this._setScreen(to === 'title' || to === 'pause' ? to : null);
    if (this._opener && this.screen) this._focus(this._opener);
    this._opener = null;
  }

  // Menus need the cursor. Esc normally releases pointer lock by itself, but a pause triggered any
  // other way (a key the browser didn't treat as the unlock gesture, a script) would leave every
  // click going to the locked canvas.
  _releasePointer() {
    if (document.pointerLockElement && typeof document.exitPointerLock === 'function') document.exitPointerLock();
  }

  _focus(el) {
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  _click() {
    const s = this.opts.sound;
    if (s && typeof s.play === 'function') {
      try { s.play('click', 'none'); } catch (e) { /* audio is optional */ }
    }
  }

  _btn(label, onClick, cls = '', attrs = {}) {
    return h('button', {
      type: 'button', class: `btn ${cls}`.trim(), ...attrs,
      onclick: (e) => { this._click(); onClick(e); },
    }, label);
  }

  _handleKey(e) {
    const t = e.target;
    if (e.key === 'Escape' || e.code === 'Escape') {
      if (e.repeat) return;
      if (this._isSub()) {
        e.preventDefault();
        this._back();
      } else if (this.screen === 'pause' && this._confirming) {
        e.preventDefault();
        this._confirm(false);
        this._focus(this.el.newWorld);
      }
      // Escape in the search box is handled by the field itself; everything else belongs to main.js.
      return;
    }
    if (this._invOpen && !this.screen) {
      if (isTextField(t)) return;
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      if (m && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const slot = Number(m[1]) - 1;
        const a = document.activeElement;
        const focusedId = a && a.classList && a.classList.contains('inv-item') ? Number(a.dataset.id) : 0;
        const id = this._hoverId || focusedId;
        if (id) this._assign(id, slot);
        else this._select(slot);
        return;
      }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this._focus(this.el.search);
      }
      return;
    }
    if (this.screen === 'title' && e.key === 'Enter' && this._loading.ready &&
        (t === document.body || t === document.documentElement || t === null)) {
      e.preventDefault();
      this._click();
      if (this.opts.onPlay) this.opts.onPlay();
    }
  }

  // ---- builders ------------------------------------------------------------------------------

  _buildUnderwater() {
    this.el.underwater = h('div', { class: 'underwater', 'aria-hidden': 'true' });
    return this.el.underwater;
  }

  _buildHud() {
    const el = this.el;
    el.crosshair = h('div', { class: 'crosshair', 'aria-hidden': 'true', hidden: true });
    el.fps = h('div', { class: 'fps-meter', hidden: true });

    // F3 panel: rows built once, values updated in place.
    this._debugRows = {};
    const dl = h('dl', { class: 'debug-list' });
    for (const [key, label] of [
      ['fps', 'FPS'], ['xyz', 'XYZ'], ['block', 'Block'], ['chunk', 'Chunk'], ['facing', 'Facing'],
      ['biome', 'Biome'], ['time', 'Time'], ['world', 'World'], ['target', 'Target'], ['mode', 'Mode'],
    ]) {
      const dd = h('dd', null, '');
      this._debugRows[key] = dd;
      dl.append(h('dt', null, label), dd);
    }
    el.debug = h('div', { class: 'debug-panel', hidden: true, 'aria-label': 'Debug information' },
      h('div', { class: 'debug-head' }, `Stereo Sandbox ${this.opts.version || VERSION}`, h('span', null, 'F3')), dl);

    el.hudSlots = [];
    const bar = h('div', { class: 'hotbar' });
    for (let i = 0; i < SLOTS; i++) {
      const img = h('img', { class: 'icon', alt: '', width: 32, height: 32, draggable: 'false' });
      const slot = h('div', { class: 'slot' }, img);
      slot._img = img;
      el.hudSlots.push(slot);
      bar.append(slot);
    }
    el.blockName = h('div', { class: 'block-name', 'aria-live': 'polite' });
    el.hotbar = h('div', { class: 'hotbar-wrap', hidden: true }, el.blockName, bar);
    return h('div', { class: 'hud' }, el.crosshair, el.fps, el.debug, el.hotbar);
  }

  _buildTitle() {
    const el = this.el;
    el.logoMark = h('img', { class: 'logo-mark', alt: '', width: 64, height: 64, draggable: 'false' });
    const src = this._icon(B.GRASS);
    if (src) el.logoMark.src = src;
    else el.logoMark.hidden = true;

    el.play = h('button', {
      type: 'button', class: 'btn btn-primary btn-play', disabled: true, 'aria-describedby': 'title-status',
      onclick: () => {
        if (!this._loading.ready) return;
        this._click();
        if (this.opts.onPlay) this.opts.onPlay();
      },
    }, 'Play');
    el.progressFill = h('span', { class: 'progress-fill' });
    el.progress = h('div', {
      class: 'progress', role: 'progressbar', 'aria-label': 'Loading the world',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
    }, el.progressFill);
    el.status = h('p', { class: 'title-status', id: 'title-status' }, 'Generating terrain');

    const settings = this._btn('Settings', (e) => this._openSub('settings', e.currentTarget));
    const controls = this._btn('Controls', (e) => this._openSub('controls', e.currentTarget));
    const seed = Number.isFinite(this.opts.seed) ? ` · Seed ${this.opts.seed}` : '';

    el.title = h('section', { class: 'screen title-screen', 'aria-label': 'Main menu' },
      h('div', { class: 'title-main' },
        h('header', { class: 'brand' },
          el.logoMark,
          h('h1', { class: 'logo' },
            h('span', { class: 'logo-word' }, 'Stereo'), ' ', h('span', { class: 'logo-word' }, 'Sandbox')),
          h('p', { class: 'tagline' }, 'A voxel world to build in')),
        h('div', { class: 'title-menu' },
          h('div', { class: 'play-wrap' }, el.play, el.progress),
          h('div', { class: 'menu-row' }, settings, controls),
          el.status,
          h('p', { class: 'touch-note' },
            'Stereo Sandbox is played with a keyboard and mouse. On this device you can enjoy the view.'))),
      h('footer', { class: 'title-footer' },
        h('span', null, `Version ${this.opts.version || VERSION}${seed}`),
        h('span', { class: 'title-legal' }, 'Not affiliated with Mojang or Microsoft')));
    return el.title;
  }

  _buildPause() {
    const el = this.el;
    el.resume = this._btn('Resume', () => { if (this.opts.onResume) this.opts.onResume(); }, 'btn-primary btn-wide');
    const settings = this._btn('Settings', (e) => this._openSub('settings', e.currentTarget));
    const controls = this._btn('Controls', (e) => this._openSub('controls', e.currentTarget));
    const quit = this.opts.onQuit
      ? this._btn('Save and quit to title', () => this.opts.onQuit(), 'btn-wide') : null;
    el.newWorld = this._btn('New world', () => { this._confirm(true); this._focus(el.confirmCancel); }, 'btn-wide btn-quiet-danger');
    el.pauseMenu = h('div', { class: 'menu' },
      el.resume, h('div', { class: 'menu-row' }, settings, controls), quit, el.newWorld);

    el.confirmCancel = this._btn('Keep playing', () => { this._confirm(false); this._focus(el.newWorld); });
    const del = this._btn('Delete world', () => { if (this.opts.onNewWorld) this.opts.onNewWorld(); }, 'btn-danger');
    el.confirmBox = h('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'confirm-title', hidden: true },
      h('p', { class: 'confirm-title', id: 'confirm-title' }, 'Start a new world?'),
      h('p', { class: 'confirm-text' },
        'This world and everything you built in it will be deleted. A fresh world is generated from a new seed.'),
      h('div', { class: 'menu-row' }, el.confirmCancel, del));

    el.pause = h('section', { class: 'screen pause-screen scrim', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pause-title' },
      h('div', { class: 'panel pause-panel' },
        h('h2', { class: 'panel-title', id: 'pause-title' }, 'Paused'),
        el.pauseMenu, el.confirmBox,
        h('p', { class: 'hint' }, 'Click Resume to capture the mouse')));
    return el.pause;
  }

  _confirm(on) {
    this._confirming = on;
    if (!this.el.confirmBox) return;
    this.el.confirmBox.hidden = !on;
    this.el.pauseMenu.hidden = on;
  }

  _panelHead(titleId, title, onBack, extra) {
    const back = h('button', {
      type: 'button', class: 'btn btn-ghost btn-back', 'aria-label': 'Back',
      onclick: () => { this._click(); onBack(); },
    }, pixelSvg(GLYPHS.back), h('span', null, 'Back'));
    return { back, head: h('header', { class: 'panel-head' }, back, h('h2', { class: 'panel-title', id: titleId }, title), extra || h('span', { class: 'panel-head-spacer' })) };
  }

  _buildSettings() {
    const el = this.el;
    this._settingViews = new Map();   // key -> { item, row, update(value), setDisabled(bool) }
    this._tabs = new Map();           // slug -> { tab, panel }

    const reset = h('button', {
      type: 'button', class: 'btn btn-ghost btn-reset', title: 'Reset all settings to their defaults',
      onclick: () => { this._click(); this._replaceSettings({ ...DEFAULT_SETTINGS }); },
    }, pixelSvg(GLYPHS.reset), h('span', null, 'Defaults'));
    const { head } = this._panelHead('settings-title', 'Settings', () => this._back(), reset);

    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Settings sections' });
    const body = h('div', { class: 'panel-body settings-body' });
    for (const g of SETTINGS_SCHEMA) {
      const id = slug(g.group);
      const tab = h('button', {
        type: 'button', role: 'tab', class: 'tab', id: `settings-tab-${id}`,
        'aria-controls': `settings-panel-${id}`, 'aria-selected': 'false', tabindex: '-1',
        onclick: () => { this._click(); this._selectTab(id); },
      }, g.group);
      const panel = h('div', {
        role: 'tabpanel', class: 'settings-group', id: `settings-panel-${id}`,
        'aria-labelledby': tab.id, hidden: true,
      });
      for (const item of g.items) panel.append(this._settingRow(item));
      this._tabs.set(id, { tab, panel });
      tablist.append(tab);
      body.append(panel);
    }
    tablist.addEventListener('keydown', (e) => {
      const ids = [...this._tabs.keys()];
      let i = ids.indexOf(this._tab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (i + 1) % ids.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (i - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = ids.length - 1;
      else return;
      e.preventDefault();
      this._selectTab(ids[i]);
      this._focus(this._tabs.get(ids[i]).tab);
    });
    this._selectTab(this._tab);

    el.settings = h('section', { class: 'screen settings-screen scrim', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
      h('div', { class: 'panel panel-wide settings-panel' }, head, tablist, body));
    return el.settings;
  }

  _selectTab(id) {
    if (!this._tabs.has(id)) return;
    this._tab = id;
    for (const [k, { tab, panel }] of this._tabs) {
      const on = k === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    }
  }

  _settingRow(item) {
    const id = `setting-${item.key}`;
    const labelId = `${id}-label`;
    const row = h('div', { class: `setting setting-${item.type}`, 'data-key': item.key });
    const view = { item, row, update: () => {}, setDisabled: () => {} };

    if (item.type === 'range') {
      const decimals = stepDecimals(item.step);
      const input = h('input', {
        type: 'range', class: 'range', id, min: item.min, max: item.max, step: item.step, 'aria-labelledby': labelId,
      });
      const out = h('output', { class: 'setting-value', for: id });
      input.addEventListener('input', () => {
        const raw = Number(input.value);
        const v = Number((Math.round((raw - item.min) / item.step) * item.step + item.min).toFixed(decimals));
        this._applySetting(item.key, v);
      });
      view.update = (v) => {
        const n = Number(v);
        if (Number(input.value) !== n) input.value = String(n);
        const text = formatSetting(item, n);
        out.textContent = text;
        input.setAttribute('aria-valuetext', text);
        input.style.setProperty('--fill', `${((n - item.min) / (item.max - item.min)) * 100}%`);
      };
      view.setDisabled = (d) => { input.disabled = d; };
      row.append(h('label', { class: 'setting-label', id: labelId, for: id }, item.label),
        h('div', { class: 'setting-control' }, input, out));
    } else if (item.type === 'toggle') {
      const state = h('span', { class: 'switch-state', 'aria-hidden': 'true' });
      const sw = h('button', {
        type: 'button', role: 'switch', class: 'switch', id, 'aria-checked': 'false', 'aria-labelledby': labelId,
        onclick: () => { this._click(); this._applySetting(item.key, !this.settings[item.key]); },
      }, h('span', { class: 'switch-thumb' }));
      view.update = (v) => {
        sw.setAttribute('aria-checked', String(!!v));
        state.textContent = v ? 'On' : 'Off';
      };
      view.setDisabled = (d) => { sw.disabled = d; };
      row.append(h('label', { class: 'setting-label', id: labelId, for: id }, item.label),
        h('div', { class: 'setting-control' }, state, sw));
    } else if (item.options.length <= 5) {
      // Few choices: a segmented radio group shows them all at once.
      const group = h('div', { class: 'segmented', role: 'radiogroup', id, 'aria-labelledby': labelId });
      const buttons = item.options.map(([val, text]) => h('button', {
        type: 'button', role: 'radio', class: 'seg', 'aria-checked': 'false', tabindex: '-1',
        onclick: () => { this._click(); this._applySetting(item.key, val); },
      }, text));
      group.append(...buttons);
      group.style.setProperty('--n', String(buttons.length));
      group.addEventListener('keydown', (e) => {
        let i = buttons.indexOf(document.activeElement);
        if (i < 0) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (i + 1) % buttons.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (i - 1 + buttons.length) % buttons.length;
        else if (e.key === 'Home') i = 0;
        else if (e.key === 'End') i = buttons.length - 1;
        else return;
        e.preventDefault();
        this._focus(buttons[i]);
        this._applySetting(item.key, item.options[i][0]);
      });
      view.update = (v) => {
        let any = false;
        item.options.forEach(([val], i) => {
          const on = String(val) === String(v);
          any = any || on;
          buttons[i].setAttribute('aria-checked', String(on));
          buttons[i].tabIndex = on ? 0 : -1;
        });
        if (!any) buttons[0].tabIndex = 0;
      };
      view.setDisabled = (d) => { for (const b of buttons) b.disabled = d; };
      row.append(h('span', { class: 'setting-label', id: labelId }, item.label),
        h('div', { class: 'setting-control' }, group));
    } else {
      const select = h('select', { class: 'select', id, 'aria-labelledby': labelId },
        item.options.map(([val, text]) => h('option', { value: String(val) }, text)));
      select.addEventListener('change', () => this._applySetting(item.key, item.options[select.selectedIndex][0]));
      view.update = (v) => {
        const i = item.options.findIndex(([val]) => String(val) === String(v));
        select.selectedIndex = i;
      };
      view.setDisabled = (d) => { select.disabled = d; };
      row.append(h('label', { class: 'setting-label', id: labelId, for: id }, item.label),
        h('div', { class: 'setting-control' }, select));
    }
    this._settingViews.set(item.key, view);
    return row;
  }

  _refreshSettings() {
    if (!this._settingViews) return;
    for (const [key, view] of this._settingViews) {
      view.update(this.settings[key]);
      const dep = DEPENDS[key];
      const off = !!dep && !this.settings[dep];
      view.row.classList.toggle('is-disabled', off);
      view.setDisabled(off);
    }
  }

  _applySetting(key, value) {
    if (this.settings[key] === value) return;
    this._replaceSettings(updateSetting(this.settings, key, value));
  }

  _replaceSettings(next) {
    this.settings = next;
    this._refreshSettings();
    if (this.opts.onSettingsChange) this.opts.onSettingsChange(next);
    saveSettings(next);
  }

  _key(k) {
    if (typeof k === 'string') return h('span', { class: 'key-sep' }, k);
    if (k.mouse) {
      return h('kbd', { class: 'key key-mouse', 'aria-label': k.mouse === 'move' ? 'Mouse' : `${k.text} mouse button` },
        pixelSvg(mouseGlyph(k.mouse), 'mouse-glyph'), h('span', null, k.text));
    }
    const [label, note] = k;
    const cap = h('kbd', { class: `key${label.length > 2 ? ' key-wide' : ''}` }, label);
    return note ? h('span', { class: 'key-group' }, cap, h('span', { class: 'key-note' }, note)) : cap;
  }

  _buildControls() {
    const el = this.el;
    const { head, back } = this._panelHead('controls-title', 'Controls', () => this._back());
    el.controlsBack = back;
    const sections = CONTROLS.map(([title, rows]) => h('section', { class: 'controls-section' },
      h('h3', { class: 'section-title' }, title),
      h('ul', { class: 'controls-list' }, rows.map(([label, keys]) => h('li', { class: 'control-row' },
        h('span', { class: 'control-label' }, label),
        h('span', { class: 'control-keys' }, keys.map((k) => this._key(k))))))));
    el.controls = h('section', { class: 'screen controls-screen scrim', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'controls-title' },
      h('div', { class: 'panel panel-wide controls-panel' }, head,
        h('div', { class: 'panel-body controls-body' }, sections),
        h('p', { class: 'hint controls-foot' }, 'Your world, position and hotbar save automatically in this browser.')));
    return el.controls;
  }

  _buildInventory() {
    const el = this.el;
    el.search = h('input', {
      type: 'search', class: 'search-input', placeholder: 'Search blocks', 'aria-label': 'Search blocks',
      autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done',
    });
    el.search.addEventListener('input', () => this._filterInventory());
    el.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (el.search.value) {
          el.search.value = '';
          this._filterInventory();
        } else if (this.opts.onInventoryClose) {
          this.opts.onInventoryClose();
        } else {
          this._focus(el.grid);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const i = this._firstVisible();
        if (i >= 0) this._assign(INVENTORY[i], this.selected);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const i = this._firstVisible();
        if (i >= 0) { this._setInvActive(i); this._focus(this._items[i]); }
      }
    });
    const search = h('label', { class: 'search' }, pixelSvg(GLYPHS.search), el.search);

    // Grid of every placeable block; roving tabindex so Tab enters once and arrows move within.
    el.grid = h('div', { class: 'inv-grid', role: 'grid', 'aria-label': 'Blocks', tabindex: '-1' });
    this._items = INVENTORY.map((id, i) => {
      const label = BLOCKS[id].label;
      const img = h('img', { class: 'icon', alt: '', width: 32, height: 32, draggable: 'false' });
      const item = h('button', {
        type: 'button', class: 'inv-item', 'data-id': id, 'aria-label': label, tabindex: '-1', draggable: 'true',
        onclick: () => { this._setInvActive(i); this._assign(id, this.selected); },
        onmouseenter: () => { this._hoverId = id; this._showTooltip(item, label); },
        onmouseleave: () => { if (this._hoverId === id) this._hoverId = 0; this._hideTooltip(); },
        onfocus: () => { this._setInvActive(i); this._showTooltip(item, label); },
        onblur: () => this._hideTooltip(),
        ondragstart: (e) => {
          this._hideTooltip();
          e.dataTransfer.setData('text/plain', `block:${id}`);
          e.dataTransfer.effectAllowed = 'copy';
          if (img.complete && img.naturalWidth) e.dataTransfer.setDragImage(img, img.naturalWidth / 2, img.naturalHeight / 2);
        },
      }, img, h('span', { class: 'inv-dot', 'aria-hidden': 'true' }));
      item._img = img;
      el.grid.append(item);
      return item;
    });
    el.grid.addEventListener('keydown', (e) => this._gridKey(e));
    el.invEmpty = h('p', { class: 'inv-empty', hidden: true });

    el.invSlots = [];
    const hotbar = h('div', { class: 'inv-hotbar', role: 'radiogroup', 'aria-label': 'Hotbar' });
    for (let i = 0; i < SLOTS; i++) {
      const img = h('img', { class: 'icon', alt: '', width: 32, height: 32, draggable: 'false' });
      const slot = h('button', {
        type: 'button', class: 'inv-slot', role: 'radio', 'aria-checked': 'false', draggable: 'true',
        onclick: () => { this._click(); this._select(i); },
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', `slot:${i}`);
          e.dataTransfer.effectAllowed = 'move';
          if (img.complete && img.naturalWidth) e.dataTransfer.setDragImage(img, img.naturalWidth / 2, img.naturalHeight / 2);
        },
        ondragover: (e) => { e.preventDefault(); slot.classList.add('is-drop'); },
        ondragleave: () => slot.classList.remove('is-drop'),
        ondrop: (e) => {
          e.preventDefault();
          slot.classList.remove('is-drop');
          const data = e.dataTransfer.getData('text/plain') || '';
          const [kind, v] = data.split(':');
          const n = Number(v);
          if (kind === 'block' && BLOCKS[n]) this._assign(n, i);
          else if (kind === 'slot' && Number.isInteger(n) && n !== i) this._swap(n, i);
        },
      }, h('span', { class: 'slot-num', 'aria-hidden': 'true' }, String(i + 1)), img);
      slot._img = img;
      el.invSlots.push(slot);
      hotbar.append(slot);
    }

    el.invNote = h('span', { class: 'inv-note', 'aria-live': 'polite' });
    const done = this.opts.onInventoryClose
      ? this._btn('Done', () => this.opts.onInventoryClose(), 'btn-primary btn-done') : null;
    el.inventory = h('section', { class: 'screen inventory-screen scrim scrim-light', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'inv-title' },
      h('div', { class: 'panel inventory-panel' },
        h('header', { class: 'inv-head' }, h('h2', { class: 'panel-title', id: 'inv-title' }, 'Blocks'), search),
        el.grid, el.invEmpty,
        h('div', { class: 'inv-divider' }, h('span', null, 'Hotbar'), el.invNote),
        hotbar,
        h('footer', { class: 'inv-foot' },
          h('p', { class: 'hint inv-hint' },
            'Click a block to put it in the selected slot. Press ', h('kbd', { class: 'key key-small' }, '1'),
            '–', h('kbd', { class: 'key key-small' }, '9'), ' over a block to place it in that slot. ',
            h('kbd', { class: 'key key-small' }, 'E'), ' closes.'),
          done)));
    return el.inventory;
  }

  _buildToasts() {
    this.el.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    return this.el.toasts;
  }

  _buildTooltip() {
    this.el.tooltip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
    return this.el.tooltip;
  }

  // ---- hotbar + inventory --------------------------------------------------------------------

  _icon(id) {
    if (!id || !BLOCKS[id]) return '';
    let url = this._icons.get(id);
    if (url === undefined) {
      url = '';
      if (this.textures) {
        try {
          url = makeBlockIcon(this.textures, id, 64).toDataURL('image/png');
        } catch (e) {
          console.warn(`Stereo Sandbox UI: no icon for ${BLOCKS[id].name}:`, e && e.message);
        }
      }
      this._icons.set(id, url);
    }
    return url;
  }

  _setImg(img, id) {
    const src = this._icon(id);
    if (img._src === src) return;
    img._src = src;
    if (src) {
      img.src = src;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }

  // Build every inventory icon a few at a time while the browser is idle, so opening the
  // inventory the first time doesn't hitch.
  _warmIcons() {
    if (!this.textures) return;
    const ids = [...new Set([...this.hotbar, ...INVENTORY])].filter((id) => !this._icons.has(id));
    let i = 0;
    const step = () => {
      const t0 = performance.now();
      while (i < ids.length && performance.now() - t0 < 6) this._icon(ids[i++]);
      if (i < ids.length) schedule(step);
    };
    schedule(step);
  }

  _fillInventoryIcons() {
    for (const item of this._items) this._setImg(item._img, Number(item.dataset.id));
  }

  _renderSlot(i) {
    const id = this.hotbar[i];
    const label = BLOCKS[id] && id ? BLOCKS[id].label : 'Empty';
    this._setImg(this.el.hudSlots[i]._img, id);
    this._setImg(this.el.invSlots[i]._img, id);
    this.el.invSlots[i].setAttribute('aria-label', `Slot ${i + 1}: ${label}`);
  }

  _renderAllSlots() {
    for (let i = 0; i < SLOTS; i++) this._renderSlot(i);
    this._renderSelection();
  }

  _renderSelection() {
    for (let i = 0; i < SLOTS; i++) {
      const on = i === this.selected;
      this.el.hudSlots[i].classList.toggle('is-selected', on);
      this.el.invSlots[i].classList.toggle('is-selected', on);
      this.el.invSlots[i].setAttribute('aria-checked', String(on));
      this.el.invSlots[i].tabIndex = on ? 0 : -1;
    }
  }

  _renderInvMarks() {
    const inBar = new Set(this.hotbar);
    for (const item of this._items) item.classList.toggle('in-hotbar', inBar.has(Number(item.dataset.id)));
  }

  _flashName(id) {
    const def = BLOCKS[id];
    if (!def || !id) return;
    const el = this.el.blockName;
    el.textContent = def.label;
    el.classList.add('is-shown');
    clearTimeout(this._nameTimer);
    this._nameTimer = setTimeout(() => el.classList.remove('is-shown'), NAME_MS);
  }

  _hotbarChanged() {
    if (this.opts.onHotbarChange) this.opts.onHotbarChange(this.hotbar.slice(), this.selected);
  }

  _assign(id, slot) {
    if (!BLOCKS[id] || !id) return;
    this._click();
    const changed = this.hotbar[slot] !== id;
    this.hotbar[slot] = id;
    this._renderSlot(slot);
    this._renderInvMarks();
    if (changed || slot === this.selected) this._pulse(this.el.invSlots[slot]);
    this._note(`${BLOCKS[id].label} → slot ${slot + 1}`);
    if (slot === this.selected) this._flashName(id);
    this._hotbarChanged();
  }

  _swap(a, b) {
    const t = this.hotbar[a];
    this.hotbar[a] = this.hotbar[b];
    this.hotbar[b] = t;
    this._renderSlot(a);
    this._renderSlot(b);
    this._pulse(this.el.invSlots[b]);
    this._hotbarChanged();
  }

  _select(slot) {
    if (slot === this.selected) return;
    this.selected = slot;
    this._renderSelection();
    this._flashName(this.hotbar[slot]);
    this._hotbarChanged();
  }

  _pulse(el) {
    if (reducedMotion()) return;
    el.classList.remove('is-pulse');
    void el.offsetWidth;   // restart the animation
    el.classList.add('is-pulse');
  }

  _note(text) {
    const n = this.el.invNote;
    n.textContent = text;
    n.classList.add('is-shown');
    clearTimeout(this._invNoteTimer);
    this._invNoteTimer = setTimeout(() => n.classList.remove('is-shown'), 1800);
  }

  _filterInventory() {
    const q = this.el.search.value.trim().toLowerCase();
    let shown = 0;
    INVENTORY.forEach((id, i) => {
      const d = BLOCKS[id];
      const match = !q || d.label.toLowerCase().includes(q) || d.name.replace(/_/g, ' ').includes(q);
      this._items[i].hidden = !match;
      if (match) shown++;
    });
    this.el.invEmpty.hidden = shown > 0;
    if (!shown) this.el.invEmpty.textContent = `No blocks match “${this.el.search.value.trim()}”`;
    if (this._items[this._invActive].hidden) this._setInvActive(this._firstVisible());
  }

  _firstVisible() {
    return this._items.findIndex((it) => !it.hidden);
  }

  _setInvActive(i) {
    if (i < 0) return;
    if (this._items[this._invActive]) this._items[this._invActive].tabIndex = -1;
    this._invActive = i;
    this._items[i].tabIndex = 0;
  }

  _gridKey(e) {
    const visible = this._items.filter((it) => !it.hidden);
    if (!visible.length) return;
    const cur = visible.indexOf(this._items[this._invActive]);
    if (e.target === this.el.grid && /^(Arrow|Home|End)/.test(e.key)) {
      e.preventDefault();
      this._focus(this._items[this._invActive]);
      return;
    }
    // Columns = items sharing the first row's offsetTop (the grid is responsive).
    const top = visible[0].offsetTop;
    let cols = 0;
    while (cols < visible.length && visible[cols].offsetTop === top) cols++;
    let next = cur;
    switch (e.key) {
      case 'ArrowRight': next = Math.min(visible.length - 1, cur + 1); break;
      case 'ArrowLeft': next = Math.max(0, cur - 1); break;
      case 'ArrowDown': next = cur + cols < visible.length ? cur + cols : cur; break;
      case 'ArrowUp':
        if (cur - cols < 0) { e.preventDefault(); this._focus(this.el.search); return; }
        next = cur - cols;
        break;
      case 'Home': next = e.ctrlKey ? 0 : cur - (cur % cols); break;
      case 'End': next = e.ctrlKey ? visible.length - 1 : Math.min(visible.length - 1, cur - (cur % cols) + cols - 1); break;
      default: return;
    }
    e.preventDefault();
    const item = visible[Math.max(0, next)];
    this._setInvActive(this._items.indexOf(item));
    this._focus(item);
  }

  _showTooltip(anchor, text) {
    const tip = this.el.tooltip;
    tip.textContent = text;
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 6;
    if (y < 8) y = r.bottom + 6;
    x = Math.max(8, Math.min(innerWidth - tw - 8, x));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  _hideTooltip() {
    if (this.el.tooltip) this.el.tooltip.hidden = true;
  }

  // ---- HUD helpers ---------------------------------------------------------------------------

  // Returns true when the visibility actually changed to visible.
  _show(name, on) {
    if (this._shown[name] === on) return false;
    this._shown[name] = on;
    this.el[name].hidden = !on;
    return on;
  }

  _flag(el, cls, on) {
    const k = `flag:${cls}`;
    if (el[k] === on) return;
    el[k] = on;
    el.classList.toggle(cls, on);
  }

  _text(el, s) {
    if (el._t !== s) {
      el._t = s;
      el.textContent = s;
    }
  }

  _renderDebug(info) {
    const r = this._debugRows;
    const pos = info.pos || [0, 0, 0];
    const [x, y, z] = pos;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const fps = Math.round(info.fps || 0);
    const ms = info.fps > 0 ? (1000 / info.fps).toFixed(1) : '–';
    const scale = Number.isFinite(info.renderScale) ? ` · scale ${Math.round(info.renderScale * 100)}%` : '';
    this._text(r.fps, `${fps} (${ms} ms)${scale}`);
    this._text(r.xyz, `${x.toFixed(3)} / ${y.toFixed(3)} / ${z.toFixed(3)}`);
    this._text(r.block, `${bx} ${by} ${bz}`);
    this._text(r.chunk, `${Math.floor(bx / 16)} ${Math.floor(bz / 16)} · in chunk ${bx & 15} ${bz & 15}`);
    const yaw = info.yaw || 0, pitch = info.pitch || 0;
    this._text(r.facing, `${facing(yaw)} · yaw ${deg(yaw)} · pitch ${deg(pitch)}`);
    this._text(r.biome, info.biome || '–');
    this._text(r.time, Number.isFinite(info.time) ? `${clockTime(info.time)} · ${dayPhase(info.time)}` : '–');
    const parts = [];
    if (Number.isFinite(info.chunks)) parts.push(`${info.chunks} chunks`);
    if (Number.isFinite(info.drawCalls)) parts.push(`${info.drawCalls} draws`);
    if (Number.isFinite(info.quads)) parts.push(`${formatCount(info.quads)} quads`);
    this._text(r.world, parts.join(' · ') || '–');
    this._text(r.target, info.target || '–');
    const mode = [info.flying ? 'Flying' : 'Walking'];
    if (info.underwater) mode.push('Underwater');
    this._text(r.mode, mode.join(' · '));
  }

  _dismissToast(el) {
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 260);
  }
}
