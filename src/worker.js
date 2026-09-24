// World worker: owns the authoritative chunk data, generates chunks on demand (re-applying recorded
// edits), lights + meshes them and streams meshes to the main thread. See SPEC.md "Worker protocol".
//
// The logic lives in WorldService so it can be driven from node tests; the self.onmessage glue at
// the bottom only runs inside a real worker (module worker in dev, bundled IIFE from a Blob URL in
// the single-file build — so no import.meta and no dynamic imports here).

import { WorldGen } from './worldgen.js';
import { meshChunk, REGION_PAD } from './mesher.js';
import { CHUNK, HEIGHT } from './blocks.js';

// Numeric chunk keys (cheaper than strings in the hot bookkeeping); ±1M chunks per axis.
const KEY_OFF = 1 << 20;
const KEY_SPAN = 1 << 21;
export const chunkKey = (cx, cz) => (cx + KEY_OFF) * KEY_SPAN + (cz + KEY_OFF);
export const keyCX = (k) => Math.floor(k / KEY_SPAN) - KEY_OFF;
export const keyCZ = (k) => (k % KEY_SPAN) - KEY_OFF;

// Unedited chunk data further than this (Chebyshev, in chunks) from every wanted/held chunk is freed.
const KEEP_RADIUS = 2;

// Yield between tasks with a MessageChannel (no 4 ms setTimeout clamping) so that messages from
// the main thread interleave with the work queue.
export function defaultScheduler() {
  if (typeof MessageChannel === 'function') {
    const ch = new MessageChannel();
    let fn = null;
    ch.port1.onmessage = () => { const f = fn; fn = null; if (f) f(); };
    return (f) => { fn = f; ch.port2.postMessage(0); };
  }
  return (f) => setTimeout(f, 0);
}

export class WorldService {
  // post(msg, transfer): send to main. createGenerator(seed): object with generateChunk(cx, cz).
  // schedule(fn): run fn in a later task.
  constructor({ post, createGenerator = (seed) => new WorldGen(seed), schedule = defaultScheduler(), keepRadius = KEEP_RADIUS } = {}) {
    this.post = post;
    this.createGenerator = createGenerator;
    this.schedule = schedule;
    this.keepRadius = keepRadius;
    this.gen = null;
    this.faceLayers = null;
    this.chunks = new Map();    // key -> { cx, cz, blocks, colors, edited }
    this.edits = new Map();     // key -> Map(idx -> id), survives eviction + regeneration
    this.held = new Set();      // chunks main holds a mesh for (sent, not unloaded)
    this.urgent = [];           // remesh keys after edits, processed before `pending`
    this.pending = [];          // wanted keys, highest priority first
    this.pendingPos = 0;
    this.scheduled = false;
    this.stats = { generated: 0, meshed: 0, evicted: 0, meshMs: 0, genMs: 0 };
  }

  handle(msg) {
    switch (msg && msg.type) {
      case 'init': this.init(msg); break;
      case 'want': this.want(msg.keys); break;
      case 'unload': this.unload(msg.keys); break;
      case 'set': this.set(msg.x, msg.y, msg.z, msg.id); break;
      default: break;
    }
  }

  init({ seed, faceLayers, edits }) {
    this.gen = this.createGenerator(seed);
    this.faceLayers = faceLayers;
    this.chunks.clear();
    this.edits.clear();
    this.held.clear();
    this.urgent.length = 0;
    this.pending = [];
    this.pendingPos = 0;
    for (const [key, list] of edits || []) {
      const [cx, cz] = String(key).split(',').map(Number);
      if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
      const m = new Map();
      for (const [idx, id] of list) m.set(idx, id);
      if (m.size) this.edits.set(chunkKey(cx, cz), m);
    }
    this.post({ type: 'ready' });
    this._kick();
  }

  want(keys) {
    const list = [];
    for (const [cx, cz] of keys || []) {
      const k = chunkKey(cx, cz);
      if (!this.held.has(k)) list.push(k);
    }
    this.pending = list;
    this.pendingPos = 0;
    this._evict();
    this._kick();
  }

  unload(keys) {
    for (const [cx, cz] of keys || []) this.held.delete(chunkKey(cx, cz));
    // Acknowledge: a mesh of these chunks main receives before this reply was posted before the
    // unload (stale, main drops it); one after it answers a newer 'want'.
    this.post({ type: 'unloaded', keys: keys || [] });
    this._evict();
  }

  set(x, y, z, id) {
    if (!this.gen || !(y >= 0 && y < HEIGHT)) return;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const k = chunkKey(cx, cz);
    const idx = (x - cx * CHUNK) | ((z - cz * CHUNK) << 4) | (y << 8);
    let m = this.edits.get(k);
    if (!m) { m = new Map(); this.edits.set(k, m); }
    m.set(idx, id);
    const c = this.chunks.get(k);
    if (c) { c.blocks[idx] = id; c.edited = true; }

    // Remesh the containing chunk first, then every held neighbour whose lit region (chunk ±
    // REGION_PAD) contains the edit — its mesh depends on nothing else.
    const front = [];
    if (this.held.has(k)) front.push(k);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx0 = (cx + dx) * CHUNK - REGION_PAD, nz0 = (cz + dz) * CHUNK - REGION_PAD;
        const span = CHUNK + 2 * REGION_PAD;
        if (x < nx0 || x >= nx0 + span || z < nz0 || z >= nz0 + span) continue;
        const nk = chunkKey(cx + dx, cz + dz);
        if (this.held.has(nk)) front.push(nk);
      }
    }
    if (!front.length) return;
    const inFront = new Set(front);
    this.urgent = front.concat(this.urgent.filter((u) => !inFront.has(u)));
    this._kick();
  }

  // --- work loop -----------------------------------------------------------------------------

  hasWork() {
    return this.urgent.length > 0 || this.pendingPos < this.pending.length;
  }

  _kick() {
    if (this.scheduled || !this.gen || !this.hasWork()) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      try {
        this.step();
      } finally {
        this._kick();
      }
    });
  }

  // One unit of work: generate one missing chunk, or light + mesh one chunk. Returns true if
  // anything was done.
  step() {
    while (this.urgent.length) {
      const k = this.urgent[0];
      if (!this.held.has(k)) { this.urgent.shift(); continue; }
      const r = this._work(k);
      if (r !== 0) this.urgent.shift();
      return true;
    }
    while (this.pendingPos < this.pending.length) {
      const k = this.pending[this.pendingPos];
      if (this.held.has(k)) { this.pendingPos++; continue; }
      const r = this._work(k);
      if (r !== 0) this.pendingPos++;
      return true;
    }
    return false;
  }

  // Drive the queue to completion synchronously (tests, tooling).
  drain(maxSteps = Infinity) {
    let n = 0;
    while (n < maxSteps && this.step()) n++;
    return n;
  }

  // 0 = generated a missing neighbour (job stays queued), 1 = meshed, -1 = failed (job dropped).
  _work(k) {
    const cx = keyCX(k), cz = keyCZ(k);
    const nb = new Array(9);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!c) {
          try {
            this._generate(cx + dx, cz + dz);
          } catch (e) {
            console.error(`worker: generating chunk ${cx + dx},${cz + dz} failed`, e);
            return -1;
          }
          return 0;
        }
        nb[(dz + 1) * 3 + (dx + 1)] = c;
      }
    }
    let mesh;
    const t0 = now();
    try {
      mesh = meshChunk(nb, this.faceLayers, cx, cz);
    } catch (e) {
      console.error(`worker: meshing chunk ${cx},${cz} failed`, e);
      return -1;
    }
    this.stats.meshMs += now() - t0;
    this.stats.meshed++;
    const blocks = nb[4].blocks.slice();
    this.held.add(k);
    this.post({
      type: 'mesh', cx, cz, blocks,
      opaque: mesh.opaque, water: mesh.water,
      opaqueQuads: mesh.opaqueQuads, waterQuads: mesh.waterQuads,
      minY: mesh.minY, maxY: mesh.maxY,
    }, [blocks.buffer, mesh.opaque.buffer, mesh.water.buffer]);
    return 1;
  }

  _generate(cx, cz) {
    const t0 = now();
    const { blocks, colors } = this.gen.generateChunk(cx, cz);
    const k = chunkKey(cx, cz);
    const m = this.edits.get(k);
    if (m) for (const [idx, id] of m) blocks[idx] = id;
    this.chunks.set(k, { cx, cz, blocks, colors, edited: !!m });
    this.stats.genMs += now() - t0;
    this.stats.generated++;
  }

  // Free unedited chunk data far from everything main holds or wants (edited chunks are kept:
  // they are few and likely to be revisited; their edits would survive regeneration anyway).
  _evict() {
    const interest = new Set(this.held);
    for (let j = this.pendingPos; j < this.pending.length; j++) interest.add(this.pending[j]);
    for (const k of this.urgent) interest.add(k);
    const R = this.keepRadius;
    for (const [k, c] of this.chunks) {
      if (c.edited || interest.has(k)) continue;
      let near = false;
      for (let dz = -R; dz <= R && !near; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (interest.has(chunkKey(c.cx + dx, c.cz + dz))) { near = true; break; }
        }
      }
      if (!near) { this.chunks.delete(k); this.stats.evicted++; }
    }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Worker glue (skipped when imported in node or on a page).
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  const service = new WorldService({ post: (msg, transfer) => self.postMessage(msg, transfer || []) });
  self.onmessage = (e) => {
    try {
      service.handle(e.data);
    } catch (err) {
      console.error('worker: message failed', err);
    }
  };
}
