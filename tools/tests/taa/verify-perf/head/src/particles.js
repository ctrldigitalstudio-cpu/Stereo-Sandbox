// CPU particle simulation: block-break debris and water splashes. Pure JS (no GL); the
// Overlays draw them from the flat Float32Array `gpu` that update() fills every frame.

import { B, OPAQUE, EMIT } from './blocks.js';
import { mulberry32 } from './noise.js';
import { defaultTint } from './textures.js';

// GPU layout per particle (4 × vec4):
//   [x, y, z, size]         position relative to `origin`, billboard edge length (blocks)
//   [u0, v0, span, layer]   texture sub-rect (0..1 face uv) and array layer
//   [r, g, b, water]        tint (sRGB 0..1, linearised in the shader, applied through the tint mask; water = 1 tints everything)
//   [sky, block, 0, 0]      light levels 0..1
export const PARTICLE_FLOATS = 16;
export const MAX_PARTICLES = 2048;

const GRAVITY = 16;
const DRAG = 0.9;          // per second, exponential air drag
const WATER_DRAG = 4.0;

// Biome-less default tint (sRGB 0..1) shared with the hotbar icons and the held block.
function tintOf(blockId) {
  const t = defaultTint(blockId);
  return t ? [t[0] / 255, t[1] / 255, t[2] / 255] : [1, 1, 1];
}

export class ParticleSystem {
  constructor(textureSet) {
    this.tex = textureSet;
    this.count = 0;
    this.world = null;          // last world seen by update(), used to estimate light at spawn
    this.origin = [0, 0, 0];    // gpu positions are relative to this (keeps float32 precision)
    this.gpu = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);
    this.version = 0;           // bumped whenever `gpu` changes
    this.rand = mulberry32(0x9e3779b9);
    const n = MAX_PARTICLES;
    this.pos = new Float64Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);     // remaining seconds
    this.size = new Float32Array(n);
    this.tex4 = new Float32Array(n * 4); // u0, v0, span, layer
    this.tint = new Float32Array(n * 3);
    this.light = new Float32Array(n * 2);
    this.flags = new Uint8Array(n);      // 1 = resting on the ground, 2 = water droplet
    this._opaqueCache = new Map();
  }

  // Opaque texels (level 0) of a texture layer, so debris only uses parts of the texture that exist.
  _opaqueTexels(layer) {
    let list = this._opaqueCache.get(layer);
    if (list) return list;
    const t = this.tex;
    const s = (t && t.size) || 16;
    const src = t && t.albedo && t.albedo[0];
    const xs = [];
    for (let i = 0; i < s * s; i++) {
      if (!src || src.length < (layer + 1) * s * s * 4 || src[(layer * s * s + i) * 4 + 3] >= 128) xs.push(i);
    }
    list = xs.length ? xs : [((s >> 1) * s) + (s >> 1)];
    this._opaqueCache.set(layer, list);
    return list;
  }

  _estimateLight(x, y, z) {
    const w = this.world;
    if (!w || typeof w.getBlock !== 'function') return [1, 0];
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    // Sky: straight up plus four slanted rays; each clear ray adds a fifth.
    let open = 0;
    const dirs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      let clear = true;
      for (let t = 1; t < 40; t++) {
        const yy = by + t;
        if (yy >= 128) break;
        const id = w.getBlock(bx + dx * (t >> 1), yy, bz + dz * (t >> 1));
        if (id > 0 && OPAQUE[id]) { clear = false; break; }
      }
      if (clear) open++;
    }
    // Block light: brightest emitter within reach (Minecraft falloff of one level per block)
    let best = 0;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let dx = -6; dx <= 6; dx++) {
          const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (d > 14) continue;
          const id = w.getBlock(bx + dx, by + dy, bz + dz);
          if (id > 0 && EMIT[id] - d > best) best = EMIT[id] - d;
        }
      }
    }
    return [Math.max(open / dirs.length, 0.08), best / 15];
  }

  _alloc() {
    if (this.count >= MAX_PARTICLES) return -1;
    return this.count++;
  }

  _rebase(x, y, z) {
    if (this.count === 0 || Math.abs(x - this.origin[0]) > 256 || Math.abs(z - this.origin[2]) > 256) {
      this.origin[0] = Math.floor(x);
      this.origin[1] = Math.floor(y);
      this.origin[2] = Math.floor(z);
    }
  }

  // ~40 debris particles with 4×4-texel bits of the block's side texture.
  // light: optional [sky, block] 0..1; estimated from the world when omitted.
  spawnBlockBreak(x, y, z, blockId, light) {
    const t = this.tex;
    if (!t || !t.faceLayers || blockId <= 0) return;
    const rand = this.rand;
    const layer = t.faceLayers[blockId * 6 + 0];
    const size = t.size || 16;
    const opaque = this._opaqueTexels(layer);
    const tint = tintOf(blockId);
    const lt = light || this._estimateLight(x + 0.5, y + 0.5, z + 0.5);
    this._rebase(x, y, z);
    // 4x4-texel bits; sparse textures (torch, flowers) use 2x2 so each bit is mostly filled
    const w = opaque.length < size * size * 0.3 ? 2 : 4;
    const n = 40;
    for (let k = 0; k < n; k++) {
      const i = this._alloc();
      if (i < 0) break;
      // Sub-rect around a random opaque texel
      const c = opaque[Math.floor(rand() * opaque.length)];
      const u = Math.min(size - w, Math.max(0, (c % size) - (w >> 1) + (rand() < 0.5 ? 0 : 1)));
      const v = Math.min(size - w, Math.max(0, Math.floor(c / size) - (w >> 1) + (rand() < 0.5 ? 0 : 1)));
      const px = x + 0.12 + rand() * 0.76, py = y + 0.12 + rand() * 0.76, pz = z + 0.12 + rand() * 0.76;
      this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
      // Burst outward from the centre with an upward kick, like vanilla block-break debris
      const s = 1.6 + rand() * 1.8;
      this.vel[i * 3] = (px - x - 0.5) * s * 2 + (rand() - 0.5) * 0.8;
      this.vel[i * 3 + 1] = (py - y - 0.5) * s * 1.5 + 1.8 + rand() * 2.2;
      this.vel[i * 3 + 2] = (pz - z - 0.5) * s * 2 + (rand() - 0.5) * 0.8;
      this.life[i] = 0.5 + rand() * 0.9;
      this.size[i] = (0.075 + rand() * 0.075) * (w === 2 ? 0.7 : 1);
      this.tex4[i * 4] = u / size; this.tex4[i * 4 + 1] = v / size; this.tex4[i * 4 + 2] = w / size; this.tex4[i * 4 + 3] = layer;
      this.tint[i * 3] = tint[0]; this.tint[i * 3 + 1] = tint[1]; this.tint[i * 3 + 2] = tint[2];
      this.light[i * 2] = lt[0]; this.light[i * 2 + 1] = lt[1];
      this.flags[i] = 0;
    }
    this._fill();
  }

  // Droplets thrown up when something falls into water.
  spawnSplash(x, y, z, light) {
    const t = this.tex;
    if (!t) return;
    const rand = this.rand;
    const layer = t.layerOf && Number.isInteger(t.layerOf.water) ? t.layerOf.water : t.faceLayers[B.WATER * 6 + 2];
    const size = t.size || 16;
    const lt = light || this._estimateLight(x, y + 1, z);
    const tint = tintOf(B.WATER);
    this._rebase(x, y, z);
    for (let k = 0; k < 28; k++) {
      const i = this._alloc();
      if (i < 0) break;
      const a = rand() * Math.PI * 2, r = 0.15 + rand() * 0.45;
      this.pos[i * 3] = x + Math.cos(a) * r; this.pos[i * 3 + 1] = y + rand() * 0.2; this.pos[i * 3 + 2] = z + Math.sin(a) * r;
      const out = 0.8 + rand() * 1.6;
      this.vel[i * 3] = Math.cos(a) * out; this.vel[i * 3 + 1] = 3.0 + rand() * 3.5; this.vel[i * 3 + 2] = Math.sin(a) * out;
      this.life[i] = 0.35 + rand() * 0.45;
      this.size[i] = 0.05 + rand() * 0.06;
      const u = Math.floor(rand() * (size - 2)), v = Math.floor(rand() * (size - 2));
      this.tex4[i * 4] = u / size; this.tex4[i * 4 + 1] = v / size; this.tex4[i * 4 + 2] = 2 / size; this.tex4[i * 4 + 3] = layer;
      this.tint[i * 3] = tint[0] * 1.3; this.tint[i * 3 + 1] = tint[1] * 1.3; this.tint[i * 3 + 2] = Math.min(1, tint[2] * 1.1);
      this.light[i * 2] = lt[0]; this.light[i * 2 + 1] = lt[1];
      this.flags[i] = 2;
    }
    this._fill();
  }

  _kill(i) {
    const j = --this.count;
    if (i === j) return;
    this.pos[i * 3] = this.pos[j * 3]; this.pos[i * 3 + 1] = this.pos[j * 3 + 1]; this.pos[i * 3 + 2] = this.pos[j * 3 + 2];
    this.vel[i * 3] = this.vel[j * 3]; this.vel[i * 3 + 1] = this.vel[j * 3 + 1]; this.vel[i * 3 + 2] = this.vel[j * 3 + 2];
    this.life[i] = this.life[j];
    this.size[i] = this.size[j];
    for (let k = 0; k < 4; k++) this.tex4[i * 4 + k] = this.tex4[j * 4 + k];
    for (let k = 0; k < 3; k++) this.tint[i * 3 + k] = this.tint[j * 3 + k];
    this.light[i * 2] = this.light[j * 2]; this.light[i * 2 + 1] = this.light[j * 2 + 1];
    this.flags[i] = this.flags[j];
  }

  update(dt, world) {
    if (world) this.world = world;
    if (this.count === 0) return;
    dt = Math.min(dt, 0.05);
    const solid = world && typeof world.isSolid === 'function' ? (x, y, z) => world.isSolid(x, y, z) : () => false;
    const getBlock = world && typeof world.getBlock === 'function' ? world.getBlock.bind(world) : null;
    const P = this.pos, Vl = this.vel;
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this._kill(i); continue; }
      const o = i * 3;
      let x = P[o], y = P[o + 1], z = P[o + 2];
      let vx = Vl[o], vy = Vl[o + 1], vz = Vl[o + 2];
      const inWater = getBlock ? getBlock(x, y, z) === B.WATER : false;
      if (inWater && this.flags[i] === 2 && vy < 0) { this._kill(i); continue; } // droplet fell back in
      const drag = Math.exp(-(inWater ? WATER_DRAG : DRAG) * dt);
      vx *= drag; vz *= drag;
      vy = vy * drag - GRAVITY * (inWater ? 0.25 : 1) * dt;
      const h = this.size[i] * 0.5;
      // Per-axis moves against solid blocks: bounce a little, then rest.
      let nx = x + vx * dt;
      if (solid(nx + Math.sign(vx) * h, y, z)) { vx *= -0.25; nx = x; }
      let nz = z + vz * dt;
      if (solid(nx, y, nz + Math.sign(vz) * h)) { vz *= -0.25; nz = z; }
      let ny = y + vy * dt;
      if (vy < 0 && solid(nx, ny - h, nz)) {
        ny = Math.floor(ny - h) + 1 + h;
        if (ny > y + 0.5) ny = y; // stepped into a block from the side; don't pop up
        vy = vy < -2.5 ? -vy * 0.2 : 0;
        vx *= 0.6; vz *= 0.6;
        this.flags[i] = this.flags[i] === 2 ? 2 : 1;
      } else if (vy > 0 && solid(nx, ny + h, nz)) {
        vy = 0; ny = y;
      }
      P[o] = nx; P[o + 1] = ny; P[o + 2] = nz;
      Vl[o] = vx; Vl[o + 1] = vy; Vl[o + 2] = vz;
    }
    this._fill();
  }

  _fill() {
    const g = this.gpu, ox = this.origin[0], oy = this.origin[1], oz = this.origin[2];
    for (let i = 0; i < this.count; i++) {
      const o = i * PARTICLE_FLOATS;
      const shrink = Math.min(1, this.life[i] / 0.3);
      g[o] = this.pos[i * 3] - ox; g[o + 1] = this.pos[i * 3 + 1] - oy; g[o + 2] = this.pos[i * 3 + 2] - oz;
      g[o + 3] = this.size[i] * (0.35 + 0.65 * shrink);
      g[o + 4] = this.tex4[i * 4]; g[o + 5] = this.tex4[i * 4 + 1]; g[o + 6] = this.tex4[i * 4 + 2]; g[o + 7] = this.tex4[i * 4 + 3];
      g[o + 8] = this.tint[i * 3]; g[o + 9] = this.tint[i * 3 + 1]; g[o + 10] = this.tint[i * 3 + 2]; g[o + 11] = this.flags[i] === 2 ? 1 : 0;
      g[o + 12] = this.light[i * 2]; g[o + 13] = this.light[i * 2 + 1]; g[o + 14] = 0; g[o + 15] = 0;
    }
    this.version++;
  }

  clear() {
    this.count = 0;
    this.version++;
  }
}
