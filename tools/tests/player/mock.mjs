// Test fixtures for the player module: a small voxel world with the features the physics has to
// handle, and a minimal fake DOM so the real Input class can be driven from node.

import { B, SOLID, HEIGHT } from '../../../src/blocks.js';

// Layout (floor top at y = 61, so a standing player has feet at 61):
//   floor         stone for y <= 60 everywhere loaded
//   wall          x = 10, z -5..5, y 61..62 (2 high)
//   step          x = -10, z -5..5, y 61 (1 high)
//   ceiling       x 20..30, z -5..5, y 63 (2 blocks of headroom)
//   platform      x 40..45, z -5..5, y 61..62 (top at 63, drops 2 blocks at its edges)
//   pool          x 0..8, z 20..28, water y 55..60 (6 deep), surface cell y 60
//   unloaded      x >= 100 (getBlock -1, isSolid true)
export class MockWorld {
  constructor() {
    this.edits = new Map();
    this.sets = [];
  }

  base(x, y, z) {
    if (y < 0) return B.BEDROCK;
    if (y >= HEIGHT) return B.AIR;
    if (x >= 100) return -1;
    if (x >= 0 && x <= 8 && z >= 20 && z <= 28 && y >= 55 && y <= 60) return B.WATER;
    if (y <= 60) return y === 0 ? B.BEDROCK : B.STONE;
    if (x === 10 && z >= -5 && z <= 5 && y <= 62) return B.STONE;
    if (x === -10 && z >= -5 && z <= 5 && y === 61) return B.STONE;
    if (x >= 20 && x <= 30 && z >= -5 && z <= 5 && y === 63) return B.STONE;
    if (x >= 40 && x <= 45 && z >= -5 && z <= 5 && y <= 62) return B.STONE;
    return B.AIR;
  }

  getBlock(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const k = `${x},${y},${z}`;
    if (this.edits.has(k)) return this.edits.get(k);
    return this.base(x, y, z);
  }

  isSolid(x, y, z) {
    const id = this.getBlock(x, y, z);
    return id < 0 || SOLID[id] === 1;
  }

  setBlock(x, y, z, id) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 0 || y >= HEIGHT || this.getBlock(x, y, z) < 0) return false;
    if (this.getBlock(x, y, z) === id) return false;
    this.edits.set(`${x},${y},${z}`, id);
    this.sets.push([x, y, z, id]);
    return true;
  }

  fill(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.edits.set(`${x},${y},${z}`, id);
  }
}

// Random world for raycast cross-checks.
export class RandomWorld {
  constructor(seed, density = 0.12) {
    this.seed = seed;
    this.density = density;
  }

  getBlock(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 0) return B.BEDROCK;
    if (y >= HEIGHT) return B.AIR;
    let h = (x * 374761393 + y * 668265263 + z * 2147483647 + this.seed * 144269) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    const r = (h >>> 0) / 4294967296;
    if (r < this.density * 0.2) return B.WATER;       // fluids are skipped by the raycast
    if (r < this.density * 0.3) return B.TALL_GRASS;  // plants are hit with their full cell
    if (r < this.density) return B.STONE;
    return B.AIR;
  }

  isSolid(x, y, z) {
    return SOLID[this.getBlock(x, y, z)] === 1;
  }

  setBlock() { return false; }
}

// ---- fake DOM ------------------------------------------------------------------------------------

export function makeEvent(type, props = {}) {
  const e = new Event(type, { cancelable: true, bubbles: true });
  for (const k in props) Object.defineProperty(e, k, { value: props[k], configurable: true, enumerable: true });
  return e;
}

// Installs window/document globals. `lockMode`: 'promise' | 'legacy' | 'reject' | 'reject-raw' |
// 'none' (no requestPointerLock) | 'silent' (never answers) | 'error-then-ok'.
export function installDom({ lockMode = 'promise', clock } = {}) {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.body = { tagName: 'BODY' };
  doc.activeElement = doc.body;
  doc.pointerLockElement = null;
  doc.hidden = false;
  doc.exitPointerLock = () => {
    if (!doc.pointerLockElement) return;
    doc.pointerLockElement = null;
    queueMicrotask(() => doc.dispatchEvent(makeEvent('pointerlockchange')));
  };
  const el = new EventTarget();
  el.tagName = 'CANVAS';
  el.lockCalls = [];
  const grant = () => {
    doc.pointerLockElement = el;
    doc.dispatchEvent(makeEvent('pointerlockchange'));
  };
  const deny = () => doc.dispatchEvent(makeEvent('pointerlockerror'));
  let calls = 0;
  if (lockMode !== 'none') {
    el.requestPointerLock = (opts) => {
      el.lockCalls.push(opts || null);
      calls++;
      switch (lockMode) {
        case 'promise':
          return new Promise((res) => setTimeout(() => { grant(); res(); }, 5));
        case 'legacy':
          setTimeout(grant, 5);
          return undefined;
        case 'legacy-deny':
          setTimeout(deny, 5);
          return undefined;
        case 'reject':
          return new Promise((res, rej) => setTimeout(() => { deny(); rej(Object.assign(new Error('denied'), { name: 'SecurityError' })); }, 5));
        case 'reject-raw':
          if (opts && opts.unadjustedMovement) {
            return new Promise((res, rej) => setTimeout(() => { deny(); rej(Object.assign(new Error('raw'), { name: 'NotSupportedError' })); }, 5));
          }
          return new Promise((res) => setTimeout(() => { grant(); res(); }, 5));
        case 'error-then-ok': // denied while inside the unlock cooldown, granted afterwards
          if (calls === 1) return new Promise((res, rej) => setTimeout(() => { deny(); rej(Object.assign(new Error('cooldown'), { name: 'SecurityError' })); }, 5));
          return new Promise((res) => setTimeout(() => { grant(); res(); }, 5));
        case 'silent':
        default:
          return new Promise(() => {});
      }
    };
  }
  globalThis.window = win;
  globalThis.document = doc;
  if (clock) globalThis.__clock = clock;
  return { win, doc, el };
}

export function uninstallDom() {
  delete globalThis.window;
  delete globalThis.document;
}
