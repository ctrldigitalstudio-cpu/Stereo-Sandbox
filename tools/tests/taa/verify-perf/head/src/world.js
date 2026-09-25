// Main-thread view of the world: streams chunks around the camera through the world worker,
// keeps a copy of block data for physics/raycasts, and records player edits for saving.
// When no worker can run (a host Content-Security-Policy without blob: workers, a failed load),
// the same WorldService runs on the page instead, behind the same message interface.

import { CHUNK, HEIGHT, B, SOLID } from './blocks.js';
import { WorldService } from './worker.js';

const keyOf = (cx, cz) => `${cx},${cz}`;
const READY_TIMEOUT_MS = 10000;   // no 'ready' from the worker by then: run on the page instead

// WorldService on the page, with the Worker interface World uses. Messages stay asynchronous and
// ordered both ways; work runs in setTimeout slices between frames.
function createLocalWorker() {
  let dead = false;
  const shim = { onmessage: null, onerror: null };
  const out = [];
  const flush = () => {
    while (out.length && !dead) { const data = out.shift(); if (shim.onmessage) shim.onmessage({ data }); }
  };
  const service = new WorldService({
    post: (msg) => { out.push(msg); if (out.length === 1) setTimeout(flush, 0); },
    schedule: (f) => setTimeout(() => { if (!dead) f(); }, 0),
  });
  shim.postMessage = (msg) => queueMicrotask(() => { if (!dead) service.handle(msg); });
  shim.terminate = () => { dead = true; out.length = 0; };
  shim.local = true;
  return shim;
}

function createWorker() {
  // The single-file build inlines the bundled worker source; dev loads the module directly.
  if (typeof window !== 'undefined' && typeof window.__WORKER_SRC__ === 'string') {
    const url = URL.createObjectURL(new Blob([window.__WORKER_SRC__], { type: 'text/javascript' }));
    return new Worker(url);
  }
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

export class World {
  constructor({ seed, faceLayers, edits, onMesh, onUnload, onFallback }) {
    this.seed = seed;
    this.faceLayers = faceLayers;
    this.onFallback = onFallback || (() => {});
    this.chunks = new Map();              // key -> { cx, cz, blocks }
    this.edits = edits || new Map();      // key -> Map(idx -> id)
    this.onMesh = onMesh || (() => {});
    this.onUnload = onUnload || (() => {});
    this.center = null;
    this.renderDistance = 0;
    this.lastWantTime = 0;
    this.meshesReceived = 0;
    this._last = null;                    // last chunk looked up (hot path cache)
    this._unloading = new Map();          // key -> unload messages the worker hasn't acknowledged yet

    this._ready = false;
    this.ready = new Promise((resolve) => { this._resolveReady = resolve; });
    let worker = null;
    try {
      worker = createWorker();
    } catch (e) {
      console.warn('World worker could not be created:', (e && e.message) || e);
    }
    if (!worker) { this._runLocally(); return; }
    this._attach(worker);
    worker.onerror = (e) => {
      // Load failures carry no message (e.g. a blob: worker refused by the page's CSP).
      const why = (e && (e.message || e.filename)) || 'the worker failed to load (blob: workers blocked here?)';
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (!this._ready) { console.warn(`World worker failed before starting: ${why}`); this._runLocally(); } else console.error('World worker error:', why);
    };
    this._readyTimer = setTimeout(() => { if (!this._ready) this._runLocally(); }, READY_TIMEOUT_MS);
  }

  _attach(worker) {
    this.worker = worker;
    worker.onmessage = (e) => this._onMessage(e.data);
    const editList = [];
    for (const [k, m] of this.edits) editList.push([k, [...m]]);
    worker.postMessage({ type: 'init', seed: this.seed, faceLayers: this.faceLayers, edits: editList });
  }

  // Switch to the on-page WorldService (before anything was streamed: nothing to reconcile).
  _runLocally() {
    if (this.worker && this.worker.local) return;
    clearTimeout(this._readyTimer);
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = null;
      try { this.worker.terminate(); } catch (e) { /* already gone */ }
    }
    this._unloading.clear();
    this.center = null;           // the next update() re-sends everything it wants
    this._attach(createLocalWorker());
    this.onFallback();
  }

  _onMessage(msg) {
    if (msg.type === 'ready') { this._ready = true; clearTimeout(this._readyTimer); this._resolveReady(); return; }
    if (msg.type === 'unloaded') {
      for (const [cx, cz] of msg.keys) {
        const key = keyOf(cx, cz), n = (this._unloading.get(key) || 0) - 1;
        if (n > 0) this._unloading.set(key, n); else this._unloading.delete(key);
      }
      return;
    }
    if (msg.type !== 'mesh') return;
    const { cx, cz } = msg;
    const key = keyOf(cx, cz);
    // Posted before the worker saw our unload of this chunk: stale. Keeping it would leave the
    // worker believing we don't hold the chunk, so edits in and next to it would never re-mesh it.
    // Messages are ordered, so anything after the acknowledgement answers a newer request.
    if (this._unloading.has(key)) return;
    if (this.center && !this._inRange(cx, cz, this.renderDistance + 2)) {
      // Arrived after we moved away; tell the worker we don't hold it.
      this._postUnload([[cx, cz]]);
      return;
    }
    let chunk = this.chunks.get(key);
    if (!chunk) {
      // Only take block data on first arrival: later copies may predate edits made since.
      chunk = { cx, cz, blocks: msg.blocks };
      this.chunks.set(key, chunk);
    }
    this.meshesReceived++;
    this.onMesh(cx, cz, msg);
  }

  _postUnload(keys) {
    for (const [cx, cz] of keys) {
      const key = keyOf(cx, cz);
      this._unloading.set(key, (this._unloading.get(key) || 0) + 1);
    }
    this.worker.postMessage({ type: 'unload', keys });
  }

  _inRange(cx, cz, r) {
    const dx = cx - this.center[0], dz = cz - this.center[1];
    return dx * dx + dz * dz <= (r + 0.5) * (r + 0.5);
  }

  _chunkAt(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const last = this._last;
    if (last && last.cx === cx && last.cz === cz) return last;
    const c = this.chunks.get(keyOf(cx, cz));
    if (c) this._last = c;
    return c;
  }

  getBlock(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 0) return B.BEDROCK;
    if (y >= HEIGHT) return B.AIR;
    const c = this._chunkAt(x, z);
    if (!c) return -1;
    return c.blocks[(x & 15) | ((z & 15) << 4) | (y << 8)];
  }

  isSolid(x, y, z) {
    const id = this.getBlock(x, y, z);
    return id < 0 || SOLID[id] === 1;
  }

  isLoaded(x, z) { return !!this._chunkAt(Math.floor(x), Math.floor(z)); }

  setBlock(x, y, z, id) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 0 || y >= HEIGHT) return false;
    const c = this._chunkAt(x, z);
    if (!c) return false;
    const idx = (x & 15) | ((z & 15) << 4) | (y << 8);
    if (c.blocks[idx] === id) return false;
    c.blocks[idx] = id;
    const key = keyOf(c.cx, c.cz);
    let m = this.edits.get(key);
    if (!m) { m = new Map(); this.edits.set(key, m); }
    m.set(idx, id);
    this.editsDirty = true;
    this.worker.postMessage({ type: 'set', x, y, z, id });
    return true;
  }

  // Stream chunks around the camera. fx/fz: horizontal view direction (optional) to load
  // what the player is looking at first.
  update(camX, camZ, renderDistance, fx = 0, fz = 0) {
    const ccx = Math.floor(camX / CHUNK), ccz = Math.floor(camZ / CHUNK);
    const moved = !this.center || this.center[0] !== ccx || this.center[1] !== ccz || renderDistance !== this.renderDistance;
    this.center = [ccx, ccz];
    this.renderDistance = renderDistance;

    if (moved) {
      // Unload with hysteresis so walking back and forth across a border doesn't thrash.
      const drop = [];
      for (const [key, c] of this.chunks) {
        if (!this._inRange(c.cx, c.cz, renderDistance + 2)) {
          this.chunks.delete(key);
          drop.push([c.cx, c.cz]);
          this.onUnload(c.cx, c.cz);
        }
      }
      this._last = null;
      if (drop.length) this._postUnload(drop);
    }

    const now = performance.now();
    if (!moved && now - this.lastWantTime < 1500) return;

    const fl = Math.hypot(fx, fz);
    const nfx = fl > 0 ? fx / fl : 0, nfz = fl > 0 ? fz / fl : 0;
    const want = [];
    const r = renderDistance;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > (r + 0.5) * (r + 0.5)) continue;
        const cx = ccx + dx, cz = ccz + dz;
        if (this.chunks.has(keyOf(cx, cz))) continue;
        const d = Math.sqrt(d2);
        // Chunks ahead of the camera get up to ~40% priority boost; the nearest ring always first.
        const facing = d > 0 ? (dx * nfx + dz * nfz) / d : 1;
        const score = d2 <= 2 ? d2 - 100 : d * (1.2 - 0.4 * Math.max(0, facing));
        want.push([score, cx, cz]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    const keys = want.map((w) => [w[1], w[2]]);
    // Re-sent periodically as a safety net; the worker skips chunks we already hold.
    if (moved || keys.length) this.worker.postMessage({ type: 'want', keys });
    this.lastWantTime = now;
  }

  // Fraction of chunks within `radius` of the current centre that have arrived.
  loadedFraction(radius) {
    if (!this.center) return 0;
    let total = 0, have = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > (radius + 0.5) * (radius + 0.5)) continue;
        total++;
        if (this.chunks.has(keyOf(this.center[0] + dx, this.center[1] + dz))) have++;
      }
    }
    return total ? have / total : 0;
  }

  get loadedCount() { return this.chunks.size; }

  exportEdits() {
    const out = [];
    for (const [k, m] of this.edits) out.push([k, [...m]]);
    return JSON.stringify(out);
  }

  static importEdits(str) {
    const map = new Map();
    if (!str) return map;
    try {
      for (const [k, list] of JSON.parse(str)) map.set(k, new Map(list));
    } catch (e) {
      console.warn('Ignoring corrupt saved edits', e);
    }
    return map;
  }

  terminate() {
    clearTimeout(this._readyTimer);
    this.worker.terminate();
    this.chunks.clear();
    this._unloading.clear();
  }
}
