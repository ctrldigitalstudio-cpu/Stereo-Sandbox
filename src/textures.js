// Procedural block textures. Every texture is a 16x16 pixel-art recipe seeded from its name:
// albedo (sRGB), a height field (-> tangent-space normal map via Sobel) and LabPBR-like
// material channels (smoothness, metalness, emissive, biome-tint mask). The result is a set
// of texture-array layers with 5 mip levels. Pure JS so it runs on the main thread, in
// workers and in node; only makeBlockIcon needs a DOM canvas.

import {
  BLOCKS, NUM_BLOCKS, faceTextures, SHAPE_NONE, SHAPE_CROSS, SHAPE_TORCH, SHAPE_FLUID,
  TINT_GRASS, TINT_FOLIAGE, TINT_BIRCH, TINT_SPRUCE, TINT_WATER,
} from './blocks.js';
import { mulberry32 } from './noise.js';

export const TEX_SIZE = 16;
export const TEX_LEVELS = 5;

const S = 16;
const N = S * S;

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------
const idx = (x, y) => (x & 15) | ((y & 15) << 4);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const grey = (v) => [v, v, v];
const fade = (t) => t * t * (3 - 2 * t);
const smoothstep = (e0, e1, x) => fade(clamp01((x - e0) / (e1 - e0)));

function pick(pal, t) {
  const n = pal.length;
  const i = Math.floor(t * n);
  return pal[i < 0 ? 0 : i >= n ? n - 1 : i];
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic PRNG per recipe name, so shared bases (stone under ores) come out identical.
const rng = (name) => mulberry32(fnv1a(name) ^ 0x2545f491);

// Stretch a field to exactly 0..1 so every seed gets the same contrast.
function stretch(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}

// Tileable value noise over the 16 px period. octaves: [[cellsX, cellsY, weight], ...]; unequal
// cell counts give streaks (few cells along x and many along y -> horizontal streaks).
function field(rand, octaves) {
  const out = new Float32Array(N);
  for (const [cx, cy, w] of octaves) {
    const g = new Float32Array(cx * cy);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    for (let y = 0; y < S; y++) {
      const fy = (y * cy) / S, iy = Math.floor(fy), ty = fade(fy - iy);
      const r0 = (iy % cy) * cx, r1 = ((iy + 1) % cy) * cx;
      for (let x = 0; x < S; x++) {
        const fx = (x * cx) / S, ix = Math.floor(fx), tx = fade(fx - ix);
        const x0 = ix % cx, x1 = (ix + 1) % cx;
        const a = g[r0 + x0] + (g[r0 + x1] - g[r0 + x0]) * tx;
        const b = g[r1 + x0] + (g[r1 + x1] - g[r1 + x0]) * tx;
        out[x + y * S] += w * (a + (b - a) * ty);
      }
    }
  }
  return stretch(out);
}

// Tileable Worley noise: one jittered point per cell of a gx x gy grid, toroidal distances.
// f1/f2 = nearest/second distances (px), id = nearest cell, (dx, dy) = offset from its point.
function voronoi(rand, gx, gy, jitter = 0.85) {
  const n = gx * gy;
  const px = new Float32Array(n), py = new Float32Array(n);
  for (let j = 0, k = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++, k++) {
      px[k] = ((i + 0.5 + (rand() - 0.5) * jitter) * S) / gx;
      py[k] = ((j + 0.5 + (rand() - 0.5) * jitter) * S) / gy;
    }
  }
  const f1 = new Float32Array(N), f2 = new Float32Array(N), id = new Uint8Array(N);
  const dx = new Float32Array(N), dy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i & 15) + 0.5, y = (i >> 4) + 0.5;
    let d1 = 1e9, d2 = 1e9, best = 0, bx = 0, by = 0;
    for (let k = 0; k < n; k++) {
      let ox = x - px[k]; ox -= S * Math.round(ox / S);
      let oy = y - py[k]; oy -= S * Math.round(oy / S);
      const d = Math.sqrt(ox * ox + oy * oy);
      if (d < d1) { d2 = d1; d1 = d; best = k; bx = ox; by = oy; } else if (d < d2) d2 = d;
    }
    f1[i] = d1; f2[i] = d2; id[i] = best; dx[i] = bx; dy[i] = by;
  }
  return { n, f1, f2, id, dx, dy };
}

// Grow a compact blob of `size` pixels around (x0, y0): each step adds the frontier pixel
// closest to the centre (plus noise), so clusters come out as lumps rather than squiggles.
function blob(rand, x0, y0, size) {
  const cells = [idx(x0, y0)];
  const set = new Set(cells);
  while (cells.length < size) {
    let best = -1, bestScore = Infinity;
    for (const c of cells) {
      for (let d = 0; d < 4; d++) {
        const x = (c & 15) + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const y = (c >> 4) + (d === 2 ? 1 : d === 3 ? -1 : 0);
        const j = idx(x, y);
        if (set.has(j)) continue;
        const dx = x - x0, dy = y - y0;
        const score = dx * dx + dy * dy + rand() * 1.6;
        if (score < bestScore) { bestScore = score; best = j; }
      }
    }
    set.add(best);
    cells.push(best);
  }
  return cells;
}

// ---------------------------------------------------------------------------------------------
// Texture canvas: float channels, albedo in sRGB 0..255, everything else 0..1
// ---------------------------------------------------------------------------------------------
class Tex {
  constructor() {
    this.r = new Float32Array(N);
    this.g = new Float32Array(N);
    this.b = new Float32Array(N);
    this.a = new Float32Array(N);
    this.h = new Float32Array(N);   // height (0 = deep, 1 = raised)
    this.sm = new Float32Array(N);  // smoothness
    this.mt = new Float32Array(N);  // metalness
    this.em = new Float32Array(N);  // emissive
    this.tm = new Float32Array(N);  // biome tint mask
    this.reset('');
  }

  // One scratch canvas is reused for every layer (keeps the build allocation-light).
  reset(name) {
    this.name = name;
    this.r.fill(0); this.g.fill(0); this.b.fill(0);
    this.a.fill(1);
    this.h.fill(0.5);
    this.sm.fill(0.1);
    this.mt.fill(0); this.em.fill(0); this.tm.fill(0);
    this.cutout = false;
    this.bump = 2;       // normal strength: height units -> texel depth
    this.bake = 0;       // amount of top-left light baked into the albedo from the height field
    this.flat = false;   // flat normal map (plants, torch)
    return this;
  }

  set(i, c, k = 1) { this.r[i] = c[0] * k; this.g[i] = c[1] * k; this.b[i] = c[2] * k; }
  get(i) { return [this.r[i], this.g[i], this.b[i]]; }
  scale(i, k) { this.r[i] *= k; this.g[i] *= k; this.b[i] *= k; }
  clear() { this.a.fill(0); this.cutout = true; }
  px(x, y, c, k = 1) { const i = idx(x, y); this.set(i, c, k); this.a[i] = 1; return i; }
}

// Shared bases (stone under the ores, dirt under grass sides, oak planks under the bookshelf and
// crafting table) are generated once and copied, instead of re-running the recipe.
const BASES = new Map();
const TEX_FIELDS = ['r', 'g', 'b', 'a', 'h', 'sm', 'mt', 'em', 'tm'];
function base(t, key, fn) {
  let snap = BASES.get(key);
  if (!snap) {
    fn(t);
    snap = { bump: t.bump, bake: t.bake, cutout: t.cutout, flat: t.flat };
    for (const f of TEX_FIELDS) snap[f] = t[f].slice();
    BASES.set(key, snap);
    return;
  }
  for (const f of TEX_FIELDS) t[f].set(snap[f]);
  t.bump = snap.bump; t.bake = snap.bake; t.cutout = snap.cutout; t.flat = snap.flat;
}

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

// ---- Stone family ---------------------------------------------------------------------------
const STONE_PAL = [[94, 94, 96], [104, 104, 106], [114, 114, 115], [122, 122, 123], [130, 130, 131], [138, 138, 139], [148, 148, 149], [158, 158, 159]];

function stoneBase(t) {
  base(t, 'stone', stoneRecipe);
}

function stoneRecipe(t) {
  const r = rng('stone');
  const blot = field(r, [[4, 4, 0.55], [8, 8, 1], [16, 16, 0.6]]);
  for (let i = 0; i < N; i++) {
    const v = blot[i] * 0.72 + r() * 0.28;
    t.set(i, pick(STONE_PAL, v));
    t.h[i] = 0.3 + v * 0.5;
    t.sm[i] = 0.07 + v * 0.07;
  }
  // Short horizontal flecks: dark cracks with a lit lip above, the classic stone look
  for (let s = 0; s < 10; s++) {
    const x0 = Math.floor(r() * S), y = Math.floor(r() * S), len = 2 + Math.floor(r() * 3);
    const dark = s < 7;
    for (let k = 0; k < len; k++) {
      const i = idx(x0 + k, y);
      t.set(i, dark ? STONE_PAL[k === 0 || k === len - 1 ? 1 : 0] : STONE_PAL[7]);
      t.h[i] = dark ? 0.12 : 0.85;
      if (dark && r() < 0.6) { const j = idx(x0 + k, y - 1); t.set(j, STONE_PAL[6]); t.h[j] = Math.max(t.h[j], 0.7); }
    }
  }
  t.bump = 1.8;
  t.bake = 0.2;
}

function cobbleBase(t) {
  base(t, 'cobblestone', cobbleRecipe);
}

function cobbleRecipe(t) {
  const r = rng('cobblestone');
  const v = voronoi(r, 3, 3, 0.9);
  const tone = Array.from({ length: v.n }, () => r());
  const tilt = Array.from({ length: v.n }, () => [r() - 0.5, r() - 0.5]);
  const grain = field(r, [[8, 8, 1], [16, 16, 0.8]]);
  const pal = [[82, 82, 84], [98, 98, 100], [112, 112, 114], [126, 126, 128], [140, 140, 142], [156, 156, 158]];
  for (let i = 0; i < N; i++) {
    const e = v.f2[i] - v.f1[i];
    const c = v.id[i];
    if (e < 1.05) {
      t.set(i, e < 0.55 ? [52, 52, 54] : [66, 66, 68]);
      t.h[i] = 0.02 + e * 0.1;
      t.sm[i] = 0.05;
      continue;
    }
    const dome = smoothstep(0.9, 4.2, e);
    const lum = tone[c] * 0.55 + grain[i] * 0.3 + dome * 0.25 + (tilt[c][0] * v.dx[i] + tilt[c][1] * v.dy[i]) * 0.04;
    t.set(i, pick(pal, lum * 0.95));
    t.h[i] = 0.25 + dome * 0.6 + grain[i] * 0.12;
    t.sm[i] = 0.08 + tone[c] * 0.06;
  }
  t.bump = 2.2;
  t.bake = 0.45;
}

function mossyCobble(t) {
  cobbleBase(t);
  const r = rng('mossy_cobblestone');
  const moss = field(r, [[2, 2, 1], [4, 4, 0.7], [8, 8, 0.35]]);
  const pal = [[58, 84, 38], [72, 100, 44], [86, 116, 50], [102, 132, 58], [118, 146, 66]];
  for (let i = 0; i < N; i++) {
    const low = 1 - t.h[i];                 // moss gathers in the mortar and low spots first
    const y = i >> 4;
    const m = moss[i] * 0.85 + low * 0.35 + (y < 8 ? 0.05 : 0) + (r() - 0.5) * 0.12;
    if (m > 0.72) {
      const k = clamp01((m - 0.72) * 2.4 + r() * 0.45);
      t.set(i, pick(pal, k));
      t.h[i] = Math.max(t.h[i], 0.45 + k * 0.2);
      t.sm[i] = 0.04;
    }
  }
  t.bake = 0.3;
}

function bedrock(t) {
  const r = rng('bedrock');
  const f = field(r, [[4, 4, 1], [8, 8, 0.7], [16, 16, 0.5]]);
  const v = voronoi(r, 4, 4, 1);
  const pal = [[16, 16, 17], [36, 36, 38], [58, 58, 60], [84, 84, 86], [112, 112, 114], [142, 142, 144]];
  for (let i = 0; i < N; i++) {
    const e = v.f2[i] - v.f1[i];
    let k = f[i] * 0.75 + r() * 0.25;
    if (e < 0.7) k *= 0.35;
    t.set(i, pick(pal, k));
    t.h[i] = k;
    t.sm[i] = 0.08;
  }
  t.bump = 2.6;
  t.bake = 0.35;
}

function obsidian(t) {
  const r = rng('obsidian');
  const v = voronoi(r, 3, 3, 0.95);
  const dir = Array.from({ length: v.n }, () => { const a = r() * Math.PI * 2; return [Math.cos(a), Math.sin(a), 0.5 + r() * 0.5]; });
  const f = field(r, [[4, 4, 1], [8, 8, 0.6], [16, 16, 0.4]]);
  const pal = [[10, 7, 17], [17, 12, 29], [25, 17, 41], [34, 23, 55], [45, 31, 71]];
  for (let i = 0; i < N; i++) {
    const c = v.id[i], d = dir[c];
    // Conchoidal facets: each cell is a tilted plane, so reflections break up per facet.
    const plane = (v.dx[i] * d[0] + v.dy[i] * d[1]) * 0.07 * d[2];
    const k = f[i] * 0.7 + r() * 0.3 + plane * 1.5;
    t.set(i, pick(pal, k));
    t.h[i] = 0.5 + plane;
    t.sm[i] = 0.72 + r() * 0.06;
    if (v.f2[i] - v.f1[i] < 0.6) { t.set(i, pal[4], 1.1); t.sm[i] = 0.8; }
  }
  for (let s = 0; s < 11; s++) {
    const i = Math.floor(r() * N);
    t.set(i, r() < 0.5 ? [86, 58, 132] : [124, 92, 178]);
    t.sm[i] = 0.85;
    if (r() < 0.4) { const j = idx((i & 15) + 1, i >> 4); t.set(j, [66, 44, 104]); }
  }
  t.bump = 2;
}

// ---- Ores: identical stone with clusters of the ore colour and a darker rim --------------
function ore(name, count, sizeMin, sizeMax, pal, mat) {
  return (t) => {
    stoneBase(t);
    const r = rng(name);
    const centres = [];
    let guard = 0;
    while (centres.length < count && guard++ < 400) {
      const x = 1 + Math.floor(r() * 14), y = 1 + Math.floor(r() * 14);
      let ok = true;
      for (const [cx, cy] of centres) {
        let dx = Math.abs(cx - x), dy = Math.abs(cy - y);
        dx = Math.min(dx, S - dx); dy = Math.min(dy, S - dy);
        if (dx * dx + dy * dy < 22) ok = false;
      }
      if (ok) centres.push([x, y]);
    }
    const oreMask = new Uint8Array(N);
    for (const [x, y] of centres) {
      for (const j of blob(r, x, y, sizeMin + Math.floor(r() * (sizeMax - sizeMin + 1)))) oreMask[j] = 1;
    }
    // Darker rim around each cluster so the ore reads against the stone.
    for (let i = 0; i < N; i++) {
      if (oreMask[i]) continue;
      const x = i & 15, y = i >> 4;
      let near = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (oreMask[idx(x + ox, y + oy)]) near += (ox && oy) ? 0.5 : 1;
      if (near > 0) { t.scale(i, near >= 1 ? 0.7 : 0.82); t.h[i] = Math.min(t.h[i], 0.3); }
    }
    for (let i = 0; i < N; i++) {
      if (!oreMask[i]) continue;
      const x = i & 15, y = i >> 4;
      // Light from the top-left: pixels with an ore neighbour below-right get the highlight.
      const lit = !oreMask[idx(x - 1, y)] || !oreMask[idx(x, y - 1)];
      const shadowed = !oreMask[idx(x + 1, y)] || !oreMask[idx(x, y + 1)];
      let k = 1 + (r() - 0.5) * 0.5;
      if (lit && !shadowed) k += 0.8; else if (shadowed && !lit) k -= 0.8;
      t.set(i, pick(pal, k / 2));
      t.h[i] = 0.78 + r() * 0.15;
      mat(t, i, r);
    }
    t.bake = 0.3;
  };
}

// ---- Soil ------------------------------------------------------------------------------------
const DIRT_PAL = [[87, 60, 40], [101, 70, 48], [114, 80, 55], [121, 85, 58], [131, 93, 64], [146, 104, 72]];

function dirtBase(t) {
  base(t, 'dirt', dirtRecipe);
}

function dirtRecipe(t) {
  const r = rng('dirt');
  const f = field(r, [[4, 4, 1], [8, 8, 0.8], [16, 16, 0.5]]);
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.55 + r() * 0.45;
    t.set(i, pick(DIRT_PAL, v));
    t.h[i] = 0.3 + v * 0.45;
    t.sm[i] = 0.05;
  }
  // Pebbles and dark crumbs
  for (let s = 0; s < 7; s++) {
    const x = Math.floor(r() * S), y = Math.floor(r() * S);
    const i = idx(x, y);
    t.set(i, r() < 0.5 ? [150, 128, 104] : [136, 112, 88]);
    t.h[i] = 0.95;
    if (r() < 0.5) { const j = idx(x + 1, y); t.set(j, [104, 84, 64]); t.h[j] = 0.7; }
  }
  for (let s = 0; s < 9; s++) {
    const i = Math.floor(r() * N);
    t.set(i, [74, 50, 33]);
    t.h[i] = 0.15;
  }
  t.bump = 1.8;
  t.bake = 0.15;
}

const GRASS_PAL = [134, 147, 160, 172, 184, 196, 210];

function grassTop(t) {
  const r = rng('grass_top');
  const f = field(r, [[4, 4, 1], [8, 8, 0.7]]);
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.45 + r() * 0.55;
    t.set(i, grey(pick(GRASS_PAL, v)));
    t.h[i] = 0.35 + v * 0.35;
    t.sm[i] = 0.1;
    t.tm[i] = 1;
  }
  // Blades: short bright strokes with a darker root, some leaning
  for (let s = 0; s < 34; s++) {
    const x = Math.floor(r() * S), y = Math.floor(r() * S);
    const lean = r() < 0.3 ? (r() < 0.5 ? -1 : 1) : 0;
    const top = idx(x + lean, y), root = idx(x, y + 1);
    t.set(top, grey(212 + r() * 14)); t.h[top] = 0.95;
    t.set(root, grey(176 + r() * 10)); t.h[root] = Math.max(t.h[root], 0.75);
  }
  for (let s = 0; s < 22; s++) {
    const i = Math.floor(r() * N);
    t.set(i, grey(122 + r() * 10));
    t.h[i] = 0.15;
  }
  t.bump = 1.6;
}

// Grass side: dirt with an irregular grass fringe (3-5 px) and a few drips.
function sideFringe(t, name, depthMin, depthVar, colourAt, material) {
  dirtBase(t);
  const r = rng(name);
  const edge = field(r, [[4, 1, 1], [8, 1, 0.6], [16, 1, 0.5]]);
  const depth = new Uint8Array(S);
  for (let x = 0; x < S; x++) depth[x] = depthMin + Math.floor(edge[x] * (depthVar + 0.999));
  for (let s = 0; s < 4; s++) {
    const x = Math.floor(r() * S);
    depth[x] += 1 + Math.floor(r() * 2.2);
  }
  for (let x = 0; x < S; x++) {
    const d = depth[x];
    for (let y = 0; y < d; y++) {
      const i = idx(x, y);
      colourAt(t, i, r, y, d);
      material(t, i);
      t.h[i] = 0.8 + r() * 0.15 - (y === d - 1 ? 0.12 : 0);
    }
    // Shadow the dirt right under the overhang
    const i = idx(x, d);
    t.scale(i, 0.78);
    t.h[i] = 0.2;
  }
}

function grassSide(t) {
  sideFringe(t, 'grass_side', 3, 2, (t, i, r, y, d) => {
    const v = r() * 0.8 + (y === 0 ? 0.25 : 0) - (y === d - 1 ? 0.3 : 0);
    t.set(i, grey(pick(GRASS_PAL, v)));
  }, (t, i) => { t.tm[i] = 1; t.sm[i] = 0.1; });
  t.bake = 0.15;
}

const SNOW_PAL = [[214, 226, 238], [224, 233, 243], [233, 240, 248], [241, 246, 252], [249, 251, 255]];

function snowySide(t) {
  sideFringe(t, 'snowy_grass_side', 4, 2, (t, i, r, y, d) => {
    const v = r() * 0.7 + 0.3 - (y === d - 1 ? 0.45 : 0);
    t.set(i, pick(SNOW_PAL, v));
  }, (t, i) => { t.sm[i] = 0.4; });
  t.bake = 0.12;
}

function snow(t) {
  const r = rng('snow');
  const f = field(r, [[2, 2, 1], [4, 4, 0.6], [8, 8, 0.35]]);
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.6 + r() * 0.4;
    t.set(i, pick(SNOW_PAL, 0.15 + v * 0.85));
    t.h[i] = 0.4 + f[i] * 0.3;
    t.sm[i] = 0.38 + r() * 0.05;
  }
  // Sparkles: bright, very smooth flakes that catch the sun
  for (let s = 0; s < 9; s++) {
    const i = Math.floor(r() * N);
    t.set(i, [255, 255, 255]);
    t.sm[i] = 0.8;
    t.h[i] = 0.8;
  }
  t.bump = 1.2;
}

const SAND_PAL = [[196, 181, 132], [206, 192, 143], [214, 201, 153], [219, 206, 160], [225, 213, 168], [232, 221, 179]];

function sand(t) {
  const r = rng('sand');
  const f = field(r, [[4, 4, 1], [8, 8, 0.5]]);
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.3 + r() * 0.7;
    t.set(i, pick(SAND_PAL, v));
    t.h[i] = 0.4 + v * 0.3;
    t.sm[i] = 0.06;
  }
  for (let s = 0; s < 8; s++) {
    const i = Math.floor(r() * N);
    t.set(i, r() < 0.6 ? [176, 160, 116] : [240, 232, 200]);
  }
  t.bump = 1.2;
}

function gravel(t) {
  const r = rng('gravel');
  const v = voronoi(r, 4, 4, 1);
  const cols = [[136, 132, 130], [152, 148, 146], [120, 116, 114], [170, 166, 163], [146, 130, 114], [128, 114, 102], [108, 106, 106], [184, 180, 176]];
  const tone = Array.from({ length: v.n }, () => cols[Math.floor(r() * cols.length)]);
  for (let i = 0; i < N; i++) {
    const e = v.f2[i] - v.f1[i];
    if (e < 0.55) {
      t.set(i, r() < 0.5 ? [86, 82, 80] : [98, 94, 91]);
      t.h[i] = 0.05;
    } else {
      const dome = smoothstep(0.4, 2.6, e);
      t.set(i, tone[v.id[i]], 0.84 + dome * 0.2 + (r() - 0.5) * 0.14);
      t.h[i] = 0.2 + dome * 0.75;
    }
    t.sm[i] = 0.08;
  }
  t.bump = 2;
  t.bake = 0.4;
}

function clay(t) {
  const r = rng('clay');
  const f = field(r, [[2, 2, 1], [4, 4, 0.6], [8, 8, 0.3]]);
  const pal = [[150, 156, 168], [157, 163, 175], [162, 168, 180], [168, 174, 186], [175, 181, 192]];
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.65 + r() * 0.35;
    t.set(i, pick(pal, v));
    t.h[i] = 0.4 + f[i] * 0.25;
    t.sm[i] = 0.3;
  }
  for (let s = 0; s < 6; s++) {
    const i = Math.floor(r() * N);
    t.set(i, [140, 146, 158]);
    t.h[i] = 0.3;
  }
  t.bump = 1;
}

function terracotta(t) {
  const r = rng('terracotta');
  const f = field(r, [[4, 4, 1], [8, 8, 0.7], [16, 16, 0.5]]);
  const pal = [[141, 87, 62], [147, 91, 65], [152, 94, 67], [157, 98, 70], [162, 102, 73]];
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.55 + r() * 0.45;
    t.set(i, pick(pal, v));
    t.h[i] = 0.45 + v * 0.15;
    t.sm[i] = 0.12;
  }
  for (let s = 0; s < 6; s++) {
    const i = Math.floor(r() * N);
    t.set(i, [134, 82, 58]);
  }
  t.bump = 1;
}

// ---- Sandstone -------------------------------------------------------------------------------
const SANDSTONE_PAL = [[188, 172, 124], [200, 185, 136], [210, 196, 147], [217, 204, 156], [224, 212, 165], [231, 220, 176]];

function sandstoneTop(t) {
  const r = rng('sandstone_top');
  const f = field(r, [[2, 2, 1], [4, 4, 0.5]]);
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.5 + r() * 0.3 + 0.2;
    t.set(i, pick(SANDSTONE_PAL, v));
    t.h[i] = 0.5 + f[i] * 0.15;
    t.sm[i] = 0.14;
  }
  // Faint bevel so a flat sandstone floor still shows block edges
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    if (x === 0 || y === 0) t.scale(i, 1.03);
    if (x === 15 || y === 15) { t.scale(i, 0.92); t.h[i] = 0.4; }
  }
  t.bump = 1.2;
}

function sandstoneBottom(t) {
  const r = rng('sandstone_bottom');
  const f = field(r, [[4, 4, 1], [8, 8, 0.7], [16, 16, 0.5]]);
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.6 + r() * 0.4;
    t.set(i, pick(SANDSTONE_PAL, v * 0.85));
    t.h[i] = 0.35 + v * 0.4;
    t.sm[i] = 0.1;
  }
  for (let s = 0; s < 10; s++) {
    const i = Math.floor(r() * N);
    t.set(i, [170, 154, 108]);
    t.h[i] = 0.1;
  }
  t.bump = 1.8;
  t.bake = 0.2;
}

function sandstoneSide(t) {
  const r = rng('sandstone_side');
  const wav = field(r, [[2, 16, 1], [4, 16, 0.5]]);
  const rowTone = Array.from({ length: S }, () => r());
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    let v, h;
    if (y <= 2) { v = 0.72 + r() * 0.28; h = 0.72; }                 // smooth cap band
    else if (y === 3) { v = 0.05 + r() * 0.12; h = 0.3; }             // groove under the cap
    else if (y >= 13) { v = 0.25 + r() * 0.45; h = 0.45 + r() * 0.2; } // rougher base band
    else {
      v = rowTone[y] * 0.45 + wav[i] * 0.4 + r() * 0.15;              // wavy strata
      h = 0.45 + rowTone[y] * 0.2;
    }
    if (y === 12) { v *= 0.55; h = 0.35; }
    t.set(i, pick(SANDSTONE_PAL, v));
    t.h[i] = h;
    t.sm[i] = 0.12;
    if (x === 15 && y > 3) t.scale(i, 0.97);
  }
  t.bump = 1.8;
  t.bake = 0.2;
}

// ---- Wood --------------------------------------------------------------------------------------
function barkSide(t, name, pal, crack, opts = {}) {
  const r = rng(name);
  const stripes = field(r, [[8, 1, 1], [16, 2, 0.6], [16, 4, 0.35]]);
  for (let i = 0; i < N; i++) {
    const v = stripes[i] * 0.8 + r() * 0.2;
    t.set(i, pick(pal, v));
    t.h[i] = 0.35 + v * 0.5;
    t.sm[i] = 0.14;
  }
  // Vertical crevices that wander by a pixel now and then
  const cracks = opts.cracks ?? 4;
  for (let c = 0; c < cracks; c++) {
    let x = Math.floor((c + r() * 0.6) * (S / cracks));
    let y = Math.floor(r() * S);
    const len = 6 + Math.floor(r() * 9);
    for (let k = 0; k < len; k++, y++) {
      if (r() < 0.14) x += r() < 0.5 ? -1 : 1;
      const i = idx(x, y);
      t.set(i, crack);
      t.h[i] = 0.05;
      const j = idx(x + 1, y);
      t.scale(j, 0.88);
      t.h[j] = Math.min(t.h[j], 0.4);
    }
  }
  t.bump = 2;
  t.bake = 0.25;
}

function birchBark(t) {
  const r = rng('birch_log');
  const f = field(r, [[8, 1, 1], [16, 3, 0.6]]);
  const pal = [[196, 196, 188], [208, 208, 200], [218, 217, 210], [227, 226, 220], [236, 235, 229]];
  for (let i = 0; i < N; i++) {
    const v = f[i] * 0.6 + r() * 0.4;
    t.set(i, pick(pal, v));
    t.h[i] = 0.6 + v * 0.2;
    t.sm[i] = 0.22;
  }
  // Black horizontal lenticel dashes with a grey fringe
  for (let s = 0; s < 11; s++) {
    const x0 = Math.floor(r() * S), y = Math.floor(r() * S), len = 2 + Math.floor(r() * 4);
    for (let k = 0; k < len; k++) {
      const i = idx(x0 + k, y);
      t.set(i, k === 0 || k === len - 1 ? [78, 74, 68] : [40, 38, 34]);
      t.h[i] = 0.2;
      t.sm[i] = 0.12;
      if (r() < 0.35) { const j = idx(x0 + k, y + 1); t.set(j, [150, 148, 140]); t.h[j] = 0.45; }
    }
  }
  t.bump = 1.8;
  t.bake = 0.15;
}

function logTop(t, name, barkPal, light, dark, pith) {
  const r = rng(name);
  const wob = field(r, [[4, 4, 1], [8, 8, 0.5]]);
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    const dx = x - 7.5, dy = y - 7.5;
    const cheb = Math.max(Math.abs(dx), Math.abs(dy));
    if (cheb >= 7) {                                        // bark rim
      t.set(i, pick(barkPal, r() * 0.8 + 0.1));
      t.h[i] = 0.55 + r() * 0.25;
      t.sm[i] = 0.12;
      continue;
    }
    const d = cheb * 0.55 + Math.sqrt(dx * dx + dy * dy) * 0.45 + (wob[i] - 0.5) * 0.9;
    const ring = d / 1.55;
    const phase = ring - Math.floor(ring);
    let c = phase < 0.38 ? dark : light;
    if (cheb >= 6) c = mix3(dark, barkPal[1], 0.45);       // cambium ring just inside the bark
    if (cheb < 1.1) c = pith;
    t.set(i, c, 0.95 + r() * 0.1);
    t.h[i] = phase < 0.38 ? 0.45 : 0.58;
    t.sm[i] = 0.25;
  }
  t.bump = 1.4;
  t.bake = 0.1;
}

function planks(t, name, pal, seam) {
  const r = rng(name);
  const grain = field(r, [[2, 16, 1], [4, 16, 0.6], [1, 8, 0.4]]);
  const joints = [3, 11, 7, 14];                            // staggered butt joints per plank
  const tone = [r(), r(), r(), r()];
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    const p = y >> 2, row = y & 3;
    if (row === 3) {                                        // seam under each plank
      t.set(i, seam, 0.95 + r() * 0.1);
      t.h[i] = 0.08;
      t.sm[i] = 0.1;
      continue;
    }
    if (x === joints[p]) {
      t.set(i, seam, 1.05);
      t.h[i] = 0.12;
      t.sm[i] = 0.1;
      continue;
    }
    let v = grain[i] * 0.6 + tone[p] * 0.25 + r() * 0.15;
    if (row === 0) v += 0.18;                               // lit upper edge of the board
    if (row === 2) v -= 0.12;
    t.set(i, pick(pal, v));
    t.h[i] = 0.62 + grain[i] * 0.2 - (row === 2 ? 0.08 : 0);
    t.sm[i] = 0.24 + grain[i] * 0.06;
  }
  t.bump = 2;
  t.bake = 0.25;
}

const OAK_PAL = [[124, 97, 57], [141, 111, 66], [156, 124, 74], [168, 134, 81], [180, 145, 89], [192, 156, 97]];
const OAK_SEAM = [96, 74, 43];
const oakPlanks = (t) => base(t, 'oak_planks', (t) => planks(t, 'oak_planks', OAK_PAL, OAK_SEAM));
const BIRCH_PLANK_PAL = [[164, 147, 98], [178, 161, 110], [192, 174, 121], [202, 186, 132], [212, 196, 142], [222, 207, 153]];
const SPRUCE_PLANK_PAL = [[84, 59, 32], [96, 69, 38], [108, 79, 45], [118, 88, 51], [129, 97, 58], [140, 106, 64]];

// ---- Leaves (greyscale, tinted by the mesher) ------------------------------------------------
function leaves(t, name, o) {
  const r = rng(name);
  const v = voronoi(r, o.cells, o.cells, 1);
  const tone = Array.from({ length: v.n }, () => r());
  const fine = field(r, [[8, 8, 1], [16, 16, 0.8]]);
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const e = v.f2[i] - v.f1[i];
    const centre = 1 - clamp01(v.f1[i] / o.leaf);
    // Each cell is a leaf cluster: brighter towards its upper-left, darker at the rim.
    const side = clamp01(0.5 - (v.dx[i] + v.dy[i]) * 0.12);
    lum[i] = tone[v.id[i]] * 0.35 + centre * 0.3 + side * 0.25 + fine[i] * 0.2 - (e < 0.8 ? 0.25 : 0) + (r() - 0.5) * 0.15;
  }
  if (o.needles) {
    // Needle strokes along the diagonals
    for (let s = 0; s < 46; s++) {
      const x = Math.floor(r() * S), y = Math.floor(r() * S);
      const dir = r() < 0.5 ? 1 : -1, len = 2 + Math.floor(r() * 2);
      const k = r() < 0.55 ? 0.5 : -0.45;
      for (let j = 0; j < len; j++) lum[idx(x + j * dir, y + j)] += k;
    }
  }
  // Holes: lowest-scoring pixels on cluster rims, a fixed fraction of the tile
  const score = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const e = v.f2[i] - v.f1[i];
    score[i] = (1 - smoothstep(0, 2.2, e)) * 0.7 + fine[i] * 0.35 + r() * 0.45;
  }
  const sorted = Array.from(score).sort((a, b) => b - a);
  const cut = sorted[Math.floor(N * o.holes) - 1];
  for (let i = 0; i < N; i++) {
    t.tm[i] = 1;
    t.sm[i] = 0.35;
    if (score[i] >= cut) {
      t.a[i] = 0;
      t.h[i] = 0;
      t.set(i, grey(o.pal[1]));
      continue;
    }
    const k = clamp01(lum[i]);
    t.set(i, grey(pick(o.pal, k)));
    t.h[i] = 0.35 + k * 0.6;
  }
  t.cutout = true;
  t.bump = 1.6;
}

// ---- Plants (cross sprites) -------------------------------------------------------------------
function plantCanvas(t, tinted) {
  t.clear();
  t.flat = true;
  t.sm.fill(0.2);
  if (tinted) t.tm.fill(1);
}

function stem(t, x, yTop, yBottom, col, lean = 0) {
  let fx = x;
  for (let y = yBottom; y >= yTop; y--) {
    t.px(Math.round(fx), y, col, 0.9 + ((y * 7) % 3) * 0.06);
    fx += lean;
  }
  return Math.round(fx - lean);
}

function tallGrass(t) {
  plantCanvas(t, true);
  const r = rng('tall_grass');
  const blades = [[1, 9], [3, 5], [4, 11], [6, 3], [7, 8], [8, 2], [10, 6], [11, 10], [12, 4], [14, 7]];
  for (const [bx, top] of blades) {
    let x = bx + (r() - 0.5) * 0.8;
    const lean = (r() - 0.5) * 0.35 + (bx < 8 ? -0.08 : 0.08);
    for (let y = 15; y >= top; y--) {
      const f = (15 - y) / (15 - top + 1e-3);
      const v = lerp(150, 214, f) + (r() - 0.5) * 18;
      t.px(Math.round(x), y, grey(v));
      if (y > 12 && r() < 0.5) t.px(Math.round(x) + 1, y, grey(v - 14));
      x += lean * (0.5 + f);
    }
  }
}

function fern(t) {
  plantCanvas(t, true);
  const r = rng('fern');
  // Fronds arch up and outward from the base, each with alternating leaflets that shorten
  // toward the tip. [start angle from vertical, bend over its length, length in px]
  const fronds = [[-0.45, -1.9, 9], [0.45, 1.85, 9.5], [-0.2, -1.05, 12], [0.22, 1.0, 11.5], [0.02, -0.25, 13.5]];
  for (const [a0, bend, len] of fronds) {
    let x = 7.5 + a0 * 2, y = 15.5;
    let leaf = 0;
    for (let s = 0; s < len; s += 0.5) {
      const f = s / len;
      const a = a0 + bend * f * f;
      x += Math.sin(a) * 0.5;
      y -= Math.cos(a) * 0.5;
      const px = Math.floor(x), py = Math.floor(y);
      t.px(px, py, grey(lerp(136, 170, f)));
      if (s >= leaf && f > 0.22) {
        // Leaflet perpendicular to the rachis, sides alternate
        const side = Math.round(leaf * 2) % 2 ? 1 : -1;
        const n = f < 0.75 ? 2 : 1;
        const nx = Math.cos(a) * side, ny = Math.sin(a) * side;
        for (let k = 1; k <= n; k++) {
          t.px(Math.floor(x + nx * k * 0.9), Math.floor(y + ny * k * 0.9 - k * 0.35), grey(lerp(172, 214, f) - k * 6 + (r() - 0.5) * 12));
        }
        leaf += 0.95;
      }
    }
    t.px(Math.floor(x), Math.floor(y), grey(214));
  }
}

const STEM = [72, 124, 40];
const STEM_DARK = [52, 96, 30];

function leaf(t, x, y, dir) {
  t.px(x + dir, y, STEM);
  t.px(x + dir * 2, y - 1, [92, 146, 52]);
  t.px(x + dir * 2, y, STEM_DARK);
}

function poppy(t) {
  plantCanvas(t, false);
  stem(t, 7, 8, 15, STEM);
  leaf(t, 7, 12, 1);
  leaf(t, 7, 10, -1);
  const petals = [
    '..rRRr..',
    '.rRHHRr.',
    'rRHRRRRr',
    'RRRddRRr',
    'rRRddRRd',
    '.rRRRRd.',
    '..rddr..',
  ];
  const C = { R: [214, 34, 30], r: [170, 22, 24], H: [246, 92, 72], d: [110, 14, 18] };
  petals.forEach((row, y) => [...row].forEach((ch, x) => {
    if (C[ch]) {
      const i = t.px(4 + x, 2 + y, C[ch]);
      t.sm[i] = 0.3;
    }
  }));
  // Dark centre
  t.px(7, 5, [36, 22, 20]); t.px(8, 5, [52, 36, 24]); t.px(7, 6, [44, 30, 22]); t.px(8, 6, [30, 18, 16]);
}

function dandelion(t) {
  plantCanvas(t, false);
  stem(t, 8, 9, 15, STEM);
  leaf(t, 8, 14, -1);
  leaf(t, 8, 13, 1);
  const head = [
    '.yYy.',
    'yYHYy',
    'YHWHY',
    'yYHYo',
    '.oYo.',
  ];
  const C = { Y: [248, 214, 40], y: [226, 176, 22], H: [255, 236, 96], W: [255, 250, 170], o: [200, 140, 16] };
  head.forEach((row, y) => [...row].forEach((ch, x) => { if (C[ch]) t.px(6 + x, 5 + y, C[ch]); }));
}

function cornflower(t) {
  plantCanvas(t, false);
  stem(t, 7, 8, 15, STEM);
  leaf(t, 7, 13, 1);
  leaf(t, 7, 11, -1);
  const head = [
    'b.B.b',
    '.BLB.',
    'BLDLB',
    '.BLBb',
    'b.B..',
  ];
  const C = { B: [72, 104, 226], b: [48, 70, 186], L: [128, 164, 255], D: [36, 34, 110] };
  head.forEach((row, y) => [...row].forEach((ch, x) => { if (C[ch]) t.px(5 + x, 3 + y, C[ch]); }));
  t.px(7, 8, STEM_DARK);
}

function deadBush(t) {
  plantCanvas(t, false);
  const r = rng('dead_bush');
  const cols = [[124, 86, 46], [104, 70, 36], [146, 104, 60], [88, 58, 30]];
  const branch = (x, y, dx, len, depth) => {
    let fx = x;
    for (let k = 0; k < len; k++) {
      y -= 1;
      fx += dx + (r() - 0.5) * 0.3;
      if (y < 1) return;
      t.px(Math.round(fx), y, cols[Math.floor(r() * cols.length)]);
      if (depth < 3 && k > 1 && r() < 0.35) branch(Math.round(fx), y, dx + (r() < 0.5 ? -0.7 : 0.7), Math.max(2, len - k - 1), depth + 1);
    }
  };
  t.px(7, 15, cols[3]); t.px(8, 15, cols[1]); t.px(7, 14, cols[0]);
  branch(7, 14, -0.55, 9, 0);
  branch(8, 14, 0.6, 9, 0);
  branch(7, 14, -0.1, 11, 1);
  branch(8, 14, 0.25, 8, 1);
}

// ---- Glass / ice / water / lava ----------------------------------------------------------------
function glass(t) {
  t.clear();
  const r = rng('glass');
  for (let i = 0; i < N; i++) t.sm[i] = 0.95;
  for (let k = 0; k < S; k++) {
    for (const [x, y] of [[k, 0], [k, 15], [0, k], [15, k]]) {
      const corner = (x === 0 || x === 15) && (y === 0 || y === 15);
      const lit = x === 0 || y === 0;
      const c = corner ? [176, 202, 212] : lit ? [226, 240, 246] : [196, 218, 228];
      const i = t.px(x, y, c, 0.96 + r() * 0.06);
      t.h[i] = 0.8;
    }
  }
  // Diagonal glints
  const streaks = [[3, 6, 3], [4, 8, 4], [10, 13, 3], [11, 14, 2], [2, 4, 2]];
  for (const [x, y, len] of streaks) {
    for (let k = 0; k < len; k++) {
      const i = t.px(x + k, y - k, k === 0 ? [236, 246, 250] : [214, 234, 244]);
      t.h[i] = 0.6;
    }
  }
  t.flat = true;
}

function ice(t, name, pal, veins, smooth) {
  const r = rng(name);
  const f = field(r, [[2, 2, 1], [4, 4, 0.6], [8, 8, 0.3]]);
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    // Soft diagonal banding suggests light passing through the ice
    const band = 0.5 + 0.5 * Math.sin((x + y) * (Math.PI / 8));
    const v = f[i] * 0.6 + band * 0.25 + r() * 0.15;
    t.set(i, pick(pal, v));
    t.h[i] = 0.7 + f[i] * 0.1;
    t.sm[i] = smooth;
  }
  // Hairline cracks: short wandering lines lighter than the ice around them
  for (let c = 0; c < veins; c++) {
    let fx = r() * S, fy = r() * S;
    const a = r() * Math.PI * 2;
    let dx = Math.cos(a), dy = Math.sin(a);
    const len = 4 + Math.floor(r() * 5);
    let last = -1;
    for (let k = 0; k < len; k++) {
      const i = idx(Math.floor(fx), Math.floor(fy));
      if (i !== last) {
        t.set(i, mix3(t.get(i), [236, 246, 255], name === 'ice' ? 0.62 : 0.4));
        t.h[i] = 0.45;
        last = i;
      }
      const turn = (r() - 0.5) * 0.8;
      const ndx = dx * Math.cos(turn) - dy * Math.sin(turn), ndy = dx * Math.sin(turn) + dy * Math.cos(turn);
      dx = ndx; dy = ndy;
      fx += dx; fy += dy;
    }
  }
  t.bump = 1.2;
}

function water(t) {
  const r = rng('water');
  const a = field(r, [[4, 4, 1], [8, 8, 0.4]]);
  const b = field(r, [[2, 4, 1], [4, 8, 0.5]]);
  for (let i = 0; i < N; i++) {
    const w = a[i] * 0.6 + b[i] * 0.4;
    const ripple = Math.abs(((w * 3.2) % 1) - 0.5);          // contour lines of the swell
    let c = [168, 186, 202];
    if (ripple < 0.09) c = [202, 216, 228];
    else if (ripple > 0.44) c = [154, 172, 190];
    t.set(i, c, 0.97 + r() * 0.05);
    t.h[i] = w;
    t.sm[i] = 0.98;
    t.tm[i] = 1;
  }
  t.bump = 0.8;
}

function lava(t) {
  const r = rng('lava');
  const v = voronoi(r, 3, 3, 0.9);
  const crustF = field(r, [[2, 2, 1], [4, 4, 0.7], [8, 8, 0.35]]);
  const heat = field(r, [[4, 4, 1], [8, 8, 0.5], [16, 16, 0.3]]);
  const orange = [[184, 56, 10], [208, 82, 14], [228, 108, 22], [244, 138, 34]];
  const vein = [[255, 186, 52], [255, 214, 92], [255, 240, 156]];
  const crust = [[62, 20, 8], [86, 30, 10], [112, 42, 14]];
  for (let i = 0; i < N; i++) {
    const e = v.f2[i] - v.f1[i];
    const n = r() * 0.25;
    if (e < 1.25) {                                         // bright molten veins between plates
      t.set(i, pick(vein, (1.25 - e) / 1.25 * 0.8 + n));
      t.em[i] = 1;
      t.h[i] = 0.25;
      t.sm[i] = 0.6;
    } else if (crustF[i] > 0.66) {                          // cooling crust patches
      t.set(i, pick(crust, (crustF[i] - 0.66) * 2 + n));
      t.em[i] = 0.4;
      t.h[i] = 0.8 + (crustF[i] - 0.66) * 0.5;
      t.sm[i] = 0.15;
    } else {
      t.set(i, pick(orange, heat[i] * 0.75 + n));
      t.em[i] = 0.85;
      t.h[i] = 0.45;
      t.sm[i] = 0.55;
    }
  }
  t.bump = 1.6;
}

// ---- Masonry --------------------------------------------------------------------------------
function bricks(t) {
  const r = rng('bricks');
  const cols = [[150, 72, 56], [138, 64, 50], [160, 82, 64], [128, 58, 46], [146, 76, 62]];
  const grain = field(r, [[8, 8, 1], [16, 16, 0.8]]);
  const tone = [];
  for (let k = 0; k < 8; k++) tone.push(cols[Math.floor(r() * cols.length)]);
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    const row = y >> 2, ry = y & 3;
    const off = row & 1 ? 4 : 0;
    const bx = (x + off) & 15, rx = bx & 7;
    if (ry === 3 || rx === 7) {                             // mortar
      t.set(i, pick([[148, 142, 134], [160, 154, 146], [172, 166, 158]], r()));
      t.h[i] = 0.12;
      t.sm[i] = 0.06;
      continue;
    }
    const b = tone[row * 2 + (bx >> 3)];
    let k = 0.9 + grain[i] * 0.16 + (r() - 0.5) * 0.08;
    if (ry === 0) k += 0.1;                                 // lit top edge
    if (rx === 6 || ry === 2) k -= 0.06;
    t.set(i, b, k);
    t.h[i] = 0.72 + grain[i] * 0.15;
    t.sm[i] = 0.14;
  }
  t.bump = 2.2;
  t.bake = 0.2;
}

function stoneBricks(t) {
  const r = rng('stone_bricks');
  const grain = field(r, [[4, 4, 1], [8, 8, 0.7], [16, 16, 0.5]]);
  const pal = [[104, 104, 106], [114, 114, 116], [122, 122, 124], [130, 130, 132], [138, 138, 140]];
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    const row = y >> 3, ry = y & 7;
    const bx = (x + (row ? 8 : 0)) & 15;
    if (ry === 7 || bx === 15) {
      t.set(i, [70, 70, 72], 0.95 + r() * 0.1);
      t.h[i] = 0.05;
      t.sm[i] = 0.06;
      continue;
    }
    let c = pick(pal, grain[i] * 0.7 + r() * 0.3);
    let h = 0.8 + grain[i] * 0.1;
    if (ry === 0 || bx === 0) { c = mul3(c, 1.16); h = 0.62; }      // bevel: lit top/left
    else if (ry === 6 || bx === 14) { c = mul3(c, 0.8); h = 0.55; } // shaded bottom/right
    t.set(i, c);
    t.h[i] = h;
    t.sm[i] = 0.12;
  }
  // A crack in the lower right brick
  let x = 11, y = 8;
  for (let k = 0; k < 6; k++) {
    const i = idx(x, y);
    t.set(i, [78, 78, 80]);
    t.h[i] = 0.25;
    y += 1;
    x += r() < 0.5 ? 1 : 0;
    if (k === 3) { const j = idx(x - 2, y - 1); t.set(j, [88, 88, 90]); t.h[j] = 0.35; }
  }
  t.bump = 2.2;
  t.bake = 0.25;
}

// ---- Light sources -----------------------------------------------------------------------------
function glowstone(t) {
  const r = rng('glowstone');
  const v = voronoi(r, 4, 4, 1);
  const pal = [[214, 138, 58], [236, 168, 78], [248, 196, 104], [255, 220, 138], [255, 240, 186]];
  const tone = Array.from({ length: v.n }, () => r());
  for (let i = 0; i < N; i++) {
    const e = v.f2[i] - v.f1[i];
    if (e < 0.8) {
      t.set(i, e < 0.4 ? [92, 58, 26] : [128, 86, 40]);
      t.em[i] = 0.15;
      t.h[i] = 0.1;
      t.sm[i] = 0.2;
      continue;
    }
    const facet = 1 - clamp01(v.f1[i] / 3.2);
    const k = tone[v.id[i]] * 0.5 + facet * 0.45 + (r() - 0.5) * 0.2 + clamp01(-(v.dx[i] + v.dy[i]) * 0.08);
    t.set(i, pick(pal, k));
    t.em[i] = 0.8 + clamp01(k) * 0.2;
    t.h[i] = 0.35 + facet * 0.6;
    t.sm[i] = 0.55;
  }
  t.bump = 2;
  t.bake = 0.15;
}

function seaLantern(t) {
  const r = rng('sea_lantern');
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    const dx = x - 7.5, dy = y - 7.5;
    const cheb = Math.max(Math.abs(dx), Math.abs(dy));
    const d = Math.sqrt(dx * dx + dy * dy);
    let c, em, h;
    if (cheb >= 7) {                                        // frame, lit top/left
      c = x === 0 || y === 0 ? [150, 196, 186] : [108, 156, 146];
      em = 0.5; h = 0.9;
    } else if (x === 7 || x === 8 || y === 7 || y === 8) {  // bright mullions leading to the core
      c = mix3([176, 222, 212], [236, 252, 248], clamp01(1 - d / 7));
      em = 0.85; h = 0.75;
    } else {
      // Four panes: darker at their outer rim, brightening toward the core, with a glint line
      const px = x < 8 ? x - 1 : 14 - x, py = y < 8 ? y - 1 : 14 - y; // 0 at the outer rim
      const k = clamp01((px + py) / 10) * 0.75 + (r() - 0.5) * 0.1;
      c = mix3([104, 170, 160], [206, 240, 232], k);
      if (px === 0 || py === 0) c = mul3(c, 0.86);
      if (px + py === 3) c = mix3(c, [236, 252, 248], 0.55);
      em = 0.75 + k * 0.25; h = 0.45 + k * 0.1;
    }
    if (cheb < 2) { c = cheb < 1 ? [255, 255, 255] : [236, 252, 250]; em = 1; h = 0.7; }
    t.set(i, c);
    t.em[i] = em;
    t.h[i] = h;
    t.sm[i] = 0.75;
  }
  t.bump = 1.6;
}

function torch(t) {
  t.clear();
  t.flat = true;
  // Stick: 2 px wide at x = 7..8, y = 6..15 (the mesher maps the torch box to exactly these texels)
  for (let y = 8; y <= 15; y++) {
    const k = 1 - (y - 8) * 0.02;
    t.px(7, y, [150, 112, 64], k);
    t.px(8, y, [104, 76, 42], k);
  }
  // Charred top of the stick, then the flame head
  t.px(7, 8, [98, 68, 38]); t.px(8, 8, [74, 50, 28]);
  t.em[idx(7, 8)] = 0.35; t.em[idx(8, 8)] = 0.25;
  const flame = [[7, 6, [255, 248, 196]], [8, 6, [255, 222, 110]], [7, 7, [255, 196, 72]], [8, 7, [240, 142, 38]]];
  for (const [x, y, c] of flame) {
    const i = t.px(x, y, c);
    t.em[i] = 1;
    t.sm[i] = 0.3;
  }
}

// ---- Wood products -----------------------------------------------------------------------------
function bookshelf(t) {
  oakPlanks(t);
  const r = rng('bookshelf');
  const books = [[150, 44, 38], [52, 76, 140], [64, 118, 54], [160, 128, 64], [112, 52, 112], [176, 156, 112], [96, 64, 42], [44, 104, 104], [184, 88, 44]];
  // Boards: top y 0-1, middle y 7-8, bottom y 14-15
  for (let i = 0; i < N; i++) {
    const y = i >> 4;
    const board = y <= 1 || y === 7 || y === 8 || y >= 14;
    if (board) {
      const k = y === 0 || y === 7 || y === 14 ? 1.08 : 0.8;
      t.set(i, pick(OAK_PAL, 0.5 + (r() - 0.5) * 0.4), k);
      t.h[i] = y === 0 || y === 7 || y === 14 ? 0.95 : 0.85;
      t.sm[i] = 0.25;
    } else {
      t.set(i, [44, 32, 20]);                               // dark back of the shelf
      t.h[i] = 0.05;
      t.sm[i] = 0.05;
    }
  }
  for (const [top, bottom] of [[2, 6], [9, 13]]) {
    let x = 0;
    while (x < S) {
      const w = r() < 0.6 ? 2 : 1;
      if (r() < 0.12 && x > 0) { x++; continue; }          // gap
      const hgt = 3 + Math.floor(r() * 3);                  // 3..5 px tall, standing on the shelf
      const c = books[Math.floor(r() * books.length)];
      const band = r() < 0.6 ? bottom - Math.floor(hgt * 0.6) : -1;
      for (let dx = 0; dx < w && x + dx < S; dx++) {
        for (let y = bottom - hgt + 1; y <= bottom; y++) {
          const i = idx(x + dx, y);
          let k = w === 2 ? (dx === 0 ? 1.1 : 0.82) : 0.96;
          if (y === bottom - hgt + 1) k *= 1.12;
          t.set(i, y === band ? mix3(c, [214, 186, 98], 0.6) : c, k);
          t.h[i] = 0.55 + (w === 2 && dx === 0 ? 0.15 : 0.05);
          t.sm[i] = 0.18;
        }
      }
      x += w;
    }
  }
  t.bump = 2;
  t.bake = 0.15;
}

function craftingTop(t) {
  oakPlanks(t);
  const r = rng('crafting_table_top');
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    const cheb = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    if (cheb >= 7) {                                        // frame of darker end grain
      t.set(i, pick([[112, 84, 48], [124, 94, 55], [136, 104, 62]], r()), x === 0 || y === 0 ? 1.12 : 0.92);
      t.h[i] = 0.9;
      t.sm[i] = 0.22;
    } else if (cheb >= 6) {                                 // inset groove
      t.set(i, [74, 54, 30]);
      t.h[i] = 0.1;
    } else {
      // Work surface with a faint 3x3 grid
      const gx = x === 5 || x === 10, gy = y === 5 || y === 10;
      if (gx || gy) { t.set(i, mix3(t.get(i), [96, 72, 42], 0.5)); t.h[i] = 0.45; }
      if (x === 2 || y === 2) t.scale(i, 0.9);             // shadow under the frame lip
    }
  }
  t.bake = 0.2;
}

function craftingSide(t) {
  oakPlanks(t);
  const r = rng('crafting_table_side');
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    if (y <= 2) {                                           // thick table top edge
      t.set(i, pick(OAK_PAL, 0.55 + (r() - 0.5) * 0.4), y === 0 ? 1.12 : y === 2 ? 0.72 : 0.92);
      t.h[i] = 0.95;
    } else if (x <= 1 || x >= 14 || y === 15) {             // legs and bottom rail
      t.set(i, pick([[104, 78, 45], [116, 88, 51], [128, 97, 57]], r()), x === 0 ? 1.1 : 1);
      t.h[i] = 0.85;
    } else if (y === 3) {
      t.scale(i, 0.7);                                      // shadow below the top
      t.h[i] = 0.3;
    }
  }
  const METAL = [[168, 168, 172], [132, 132, 138], [96, 96, 102]];
  const WOOD = [[136, 92, 48], [98, 64, 32]];
  // Tools hang proud of the panel: steel is smooth and metallic, handles are plain wood.
  const metal = (x, y, c) => { const i = t.px(x, y, c); t.h[i] = 0.95; t.sm[i] = 0.55; t.mt[i] = 0.8; };
  const wood = (x, y, c) => { const i = t.px(x, y, c); t.h[i] = 0.92; t.sm[i] = 0.25; };
  // Hammer: head across the top, handle down
  for (let x = 3; x <= 7; x++) { metal(x, 5, METAL[0]); metal(x, 6, METAL[1]); }
  metal(7, 6, METAL[2]); metal(3, 6, METAL[2]);
  for (let y = 7; y <= 12; y++) { wood(5, y, WOOD[0]); wood(6, y, WOOD[1]); }
  // Saw: tapering blade with teeth, handle on top
  for (let y = 7; y <= 13; y++) {
    const w = y < 10 ? 3 : 2;
    for (let k = 0; k < w; k++) metal(9 + k, y, k === 0 ? METAL[0] : METAL[1]);
    metal(9 + w, y, y % 2 ? METAL[2] : METAL[1]);
  }
  for (let x = 9; x <= 12; x++) { wood(x, 5, WOOD[0]); wood(x, 6, WOOD[1]); }
  wood(10, 5, [70, 46, 24]);
  t.bake = 0.2;
}

// ---- Cactus --------------------------------------------------------------------------------------
const CACTUS_PAL = [[30, 70, 22], [42, 90, 30], [56, 110, 38], [70, 128, 44], [86, 146, 52], [104, 164, 62]];

function cactusSide(t) {
  const r = rng('cactus_side');
  const f = field(r, [[16, 2, 1], [16, 4, 0.5]]);
  const ridge = [0.1, 0.35, 0.8, 0.45, 0.15, 0.4, 0.85, 0.5, 0.2, 0.45, 0.9, 0.55, 0.2, 0.45, 0.85, 0.35];
  for (let i = 0; i < N; i++) {
    const x = i & 15;
    const v = ridge[x] * 0.75 + f[i] * 0.15 + r() * 0.1;
    t.set(i, pick(CACTUS_PAL, v));
    t.h[i] = 0.25 + ridge[x] * 0.65;
    t.sm[i] = 0.3;
    if (x === 0 || x === 15) t.scale(i, 0.85);
  }
  // Pale spines on the ridges
  for (const x of [2, 6, 10, 14]) {
    for (let y = (x * 3) % 4; y < S; y += 4) {
      const i = idx(x, y);
      t.set(i, [222, 226, 186]);
      t.h[i] = 1;
      const j = idx(x, y + 1);
      t.scale(j, 0.75);
    }
  }
  t.bump = 2;
  t.bake = 0.2;
}

function cactusTop(t) {
  const r = rng('cactus_top');
  for (let i = 0; i < N; i++) {
    const x = i & 15, y = i >> 4;
    const cheb = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const ring = Math.floor(7.5 - cheb);                    // 0 = outer
    const tone = [0.1, 0.55, 0.3, 0.7, 0.45, 0.85, 0.6, 0.95][ring];
    t.set(i, pick(CACTUS_PAL, tone * 0.85 + r() * 0.15));
    t.h[i] = 0.4 + tone * 0.4;
    t.sm[i] = 0.3;
  }
  for (const [x, y] of [[3, 3], [12, 3], [3, 12], [12, 12], [7, 2], [2, 8], [13, 7], [8, 13]]) {
    const i = idx(x, y);
    t.set(i, [214, 220, 180]);
    t.h[i] = 1;
  }
  t.bump = 1.6;
}

// ---- Wool ----------------------------------------------------------------------------------------
function wool(name, base) {
  return (t) => {
    const r = rng(name);
    const f = field(rng('wool'), [[4, 4, 1], [8, 8, 0.6]]);
    const lum = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i & 15, y = i >> 4;
      // Knitted stitches: a 4 x 4 twill that shifts one pixel per row, broken up by noise
      const tw = (x + y * 2) & 3, rib = (x - y) & 7;
      lum[i] = (tw === 0 ? 0.28 : tw === 1 ? 0.12 : tw === 2 ? -0.06 : -0.2) + (rib === 0 ? -0.12 : 0) + (f[i] - 0.5) * 0.35 + (r() - 0.5) * 0.18;
    }
    // Loose fibres crossing the weave
    const fr = rng('wool');
    for (let s = 0; s < 18; s++) {
      const x = Math.floor(fr() * S), y = Math.floor(fr() * S);
      const dir = s & 1 ? 1 : -1, len = 2 + Math.floor(fr() * 2);
      for (let j = 0; j < len; j++) lum[idx(x + j * dir, y + j)] += 0.16;
    }
    const lift = Math.max(...base) < 60 ? 26 : 0;            // keep black wool from crushing to 0
    for (let i = 0; i < N; i++) {
      const k = 0.9 + lum[i] * 0.42;
      const add = lift * (k - 0.78);
      t.set(i, [base[0] * k + add, base[1] * k + add, base[2] * k + add]);
      t.h[i] = 0.45 + lum[i] * 0.9;
      t.sm[i] = 0;
    }
    t.bump = 1.4;
  };
}

// ---- Metal / gem blocks -------------------------------------------------------------------------
function mineralBlock(name, pal, light, dark, mat) {
  return (t) => {
    const r = rng(name);
    const f = field(r, [[2, 2, 1], [4, 4, 0.5], [16, 16, 0.25]]);
    for (let i = 0; i < N; i++) {
      const x = i & 15, y = i >> 4;
      // Broad diagonal sheen across the face
      const sheen = 0.5 + 0.35 * Math.cos((x - y) * 0.42) + (f[i] - 0.5) * 0.4;
      let c = pick(pal, sheen);
      let h = 0.85;
      if (x === 0 || y === 0) { c = light; h = 0.45; } else if (x === 15 || y === 15) { c = dark; h = 0.45; } else if (x === 1 || y === 1) { c = mix3(c, light, 0.5); h = 0.7; } else if (x === 14 || y === 14) { c = mix3(c, dark, 0.5); h = 0.7; }
      t.set(i, c);
      t.h[i] = h;
      mat(t, i, r);
    }
    // Glints
    for (const [x, y, len] of [[3, 5, 3], [4, 7, 2], [9, 12, 3], [11, 4, 2]]) {
      for (let k = 0; k < len; k++) {
        const i = idx(x + k, y - k);
        t.set(i, mix3(t.get(i), light, 0.7));
      }
    }
    t.bump = 2;
  };
}

// ---------------------------------------------------------------------------------------------
// Recipe table
// ---------------------------------------------------------------------------------------------
const OAK_BARK = [[62, 47, 27], [78, 60, 35], [92, 72, 42], [106, 83, 50], [118, 94, 57]];
const BIRCH_BARK_RIM = [[200, 200, 192], [214, 213, 206], [226, 225, 219], [96, 92, 84]];
const SPRUCE_BARK = [[40, 26, 12], [50, 33, 16], [60, 40, 20], [72, 49, 25], [84, 58, 31]];

const RECIPES = {
  stone: stoneBase,
  cobblestone: cobbleBase,
  mossy_cobblestone: mossyCobble,
  bedrock,
  obsidian,
  dirt: dirtBase,
  grass_top: grassTop,
  grass_side: grassSide,
  snowy_grass_side: snowySide,
  snow,
  sand,
  gravel,
  clay,
  terracotta,
  sandstone_top: sandstoneTop,
  sandstone_bottom: sandstoneBottom,
  sandstone_side: sandstoneSide,
  oak_log: (t) => barkSide(t, 'oak_log', OAK_BARK, [44, 33, 18]),
  birch_log: birchBark,
  spruce_log: (t) => barkSide(t, 'spruce_log', SPRUCE_BARK, [28, 18, 8], { cracks: 5 }),
  oak_log_top: (t) => logTop(t, 'oak_log_top', OAK_BARK, [178, 144, 90], [148, 116, 68], [110, 84, 48]),
  birch_log_top: (t) => logTop(t, 'birch_log_top', BIRCH_BARK_RIM, [206, 186, 134], [180, 160, 110], [150, 128, 84]),
  spruce_log_top: (t) => logTop(t, 'spruce_log_top', SPRUCE_BARK, [126, 92, 54], [102, 74, 42], [80, 56, 30]),
  oak_planks: oakPlanks,
  birch_planks: (t) => planks(t, 'birch_planks', BIRCH_PLANK_PAL, [140, 122, 80]),
  spruce_planks: (t) => planks(t, 'spruce_planks', SPRUCE_PLANK_PAL, [66, 45, 24]),
  oak_leaves: (t) => leaves(t, 'oak_leaves', { cells: 4, leaf: 3, holes: 0.2, pal: [96, 116, 136, 156, 176, 196, 214] }),
  birch_leaves: (t) => leaves(t, 'birch_leaves', { cells: 5, leaf: 2.6, holes: 0.2, pal: [110, 130, 150, 170, 188, 206, 222] }),
  spruce_leaves: (t) => leaves(t, 'spruce_leaves', { cells: 5, leaf: 2.4, holes: 0.13, needles: true, pal: [92, 110, 128, 148, 166, 186, 204] }),
  tall_grass: tallGrass,
  fern,
  poppy,
  dandelion,
  cornflower,
  dead_bush: deadBush,
  glass,
  ice: (t) => ice(t, 'ice', [[122, 162, 234], [132, 172, 239], [142, 181, 243], [153, 191, 246], [166, 202, 250]], 4, 0.9),
  packed_ice: (t) => ice(t, 'packed_ice', [[136, 166, 222], [144, 174, 228], [152, 182, 233], [160, 190, 238]], 2, 0.8),
  water,
  lava,
  bricks,
  stone_bricks: stoneBricks,
  glowstone,
  sea_lantern: seaLantern,
  torch,
  coal_ore: ore('coal_ore', 4, 6, 9, [[18, 18, 20], [30, 30, 32], [44, 44, 46], [66, 66, 68]], (t, i) => { t.sm[i] = 0.25; }),
  iron_ore: ore('iron_ore', 4, 5, 8, [[168, 124, 96], [196, 152, 120], [216, 176, 146], [234, 204, 178]], (t, i) => { t.sm[i] = 0.35; t.mt[i] = 0.6; }),
  gold_ore: ore('gold_ore', 4, 5, 7, [[204, 150, 20], [236, 198, 44], [252, 224, 76], [255, 246, 150]], (t, i) => { t.sm[i] = 0.8; t.mt[i] = 1; }),
  diamond_ore: ore('diamond_ore', 4, 4, 6, [[26, 160, 156], [62, 208, 200], [104, 236, 228], [196, 255, 250]], (t, i) => { t.sm[i] = 0.9; }),
  redstone_ore: ore('redstone_ore', 5, 3, 5, [[132, 0, 0], [184, 8, 8], [226, 24, 20], [255, 96, 86]], (t, i) => { t.sm[i] = 0.4; t.em[i] = 0.25; }),
  bookshelf,
  crafting_table_top: craftingTop,
  crafting_table_side: craftingSide,
  cactus_side: cactusSide,
  cactus_top: cactusTop,
  white_wool: wool('white_wool', [232, 234, 234]),
  red_wool: wool('red_wool', [158, 40, 36]),
  blue_wool: wool('blue_wool', [54, 60, 158]),
  yellow_wool: wool('yellow_wool', [244, 194, 40]),
  green_wool: wool('green_wool', [86, 112, 30]),
  black_wool: wool('black_wool', [24, 24, 30]),
  gold_block: mineralBlock('gold_block', [[226, 170, 34], [240, 196, 52], [250, 216, 70], [255, 232, 104]], [255, 250, 176], [176, 120, 14],
    (t, i) => { t.mt[i] = 1; t.sm[i] = 0.85; }),
  iron_block: mineralBlock('iron_block', [[196, 196, 198], [210, 210, 212], [222, 222, 224], [234, 234, 236]], [252, 252, 252], [146, 146, 150],
    (t, i) => { t.mt[i] = 1; t.sm[i] = 0.75; }),
  diamond_block: mineralBlock('diamond_block', [[76, 204, 198], [102, 222, 216], [134, 236, 230], [176, 248, 244]], [222, 255, 252], [38, 144, 146],
    (t, i) => { t.sm[i] = 0.9; }),
};

// Fallback for a texture name without a recipe: loud magenta checker so it is noticed.
function missing(t) {
  for (let i = 0; i < N; i++) t.set(i, ((i & 15) >> 3) ^ ((i >> 4) >> 3) ? [255, 0, 255] : [16, 16, 16]);
}

// ---------------------------------------------------------------------------------------------
// Encoding: level 0 + mip chain
// ---------------------------------------------------------------------------------------------
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
// Linear -> sRGB8 through a 4096-entry table (sub-LSB error everywhere; avoids pow per texel).
const LIN_TO_SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const l = i / 4096;
  LIN_TO_SRGB[i] = Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255);
}
const linToSrgb8 = (l) => (l <= 0 ? 0 : l >= 1 ? 255 : LIN_TO_SRGB[(l * 4096 + 0.5) | 0]);
const unit8 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

// Sobel gradient of a wrapped height field at texel i, in height units per pixel -> (GX, GY).
let GX = 0, GY = 0;
function sobelAt(h, i) {
  const x = i & 15, y = i & 240;
  const xm = (x + 15) & 15, xp = (x + 1) & 15, ym = (y + 240) & 240, yp = (y + 16) & 240;
  const a = h[xm | ym], b = h[x | ym], c = h[xp | ym];
  const d = h[xm | y], f = h[xp | y];
  const g = h[xm | yp], k = h[x | yp], l = h[xp | yp];
  GX = (c + 2 * f + l - a - 2 * d - g) * 0.125;
  GY = (g + 2 * k + l - a - 2 * b - c) * 0.125;
}

// Bake a hint of top-left light into the albedo from the height field (pixel-art bevels that
// still read on distant mips and icons where the normal map has averaged away).
const BAKE_L = (() => { const v = [-0.5, -0.6, 0.62]; const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; })();
function bakeLight(t) {
  if (!t.bake) return;
  const k = t.bump;
  for (let i = 0; i < N; i++) {
    sobelAt(t.h, i);
    const nx = -GX * k, ny = -GY * k;
    const d = (nx * BAKE_L[0] + ny * BAKE_L[1] + BAKE_L[2]) / Math.sqrt(nx * nx + ny * ny + 1);
    const f = 1 + (d / BAKE_L[2] - 1) * t.bake;
    t.scale(i, f < 0.55 ? 0.55 : f > 1.35 ? 1.35 : f);
  }
}

// Give transparent texels the colour/material of nearby opaque ones, so bilinear filtering and
// mips of cutout layers get no dark fringes.
const BLEED_KNOWN = new Uint8Array(N);
const BLEED_NEW = new Float32Array(N * 7);
const BLEED_LIST = new Int16Array(N);
function bleed(t) {
  const known = BLEED_KNOWN;
  let any = false;
  for (let i = 0; i < N; i++) { known[i] = t.a[i] >= 0.5 ? 1 : 0; if (known[i]) any = true; }
  if (!any) return;
  const ch = [t.r, t.g, t.b, t.sm, t.mt, t.em, t.tm];
  for (let pass = 0; pass < 16; pass++) {
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (known[i]) continue;
      const x = i & 15, y = i >> 4;
      let n = 0;
      const o = count * 7;
      for (let c = 0; c < 7; c++) BLEED_NEW[o + c] = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const j = ((x + ox) & 15) | (((y + oy) & 15) << 4);
          if (!known[j]) continue;
          for (let c = 0; c < 7; c++) BLEED_NEW[o + c] += ch[c][j];
          n++;
        }
      }
      if (!n) continue;
      for (let c = 0; c < 7; c++) BLEED_NEW[o + c] /= n;
      BLEED_LIST[count++] = i;
    }
    if (!count) break;
    for (let k = 0; k < count; k++) {
      const i = BLEED_LIST[k];
      for (let c = 0; c < 7; c++) ch[c][i] = BLEED_NEW[k * 7 + c];
      known[i] = 1;
    }
  }
}

// Mip chain state per texel, interleaved: alpha-weighted linear r, g, b, normal x, y, z, height,
// smoothness, metalness, emissive, tint mask, then the weight and the plain alpha.
const CH = 11;
const STRIDE = CH + 2;
const MIP_BUF = [0, 1, 2, 3, 4].map((l) => new Float32Array((N >> (2 * l)) * STRIDE));
const MIP_ALPHA = new Float32Array(64);

function encodeLayer(t, layer, out) {
  const { albedo, normal, spec, cutout } = out;
  // Clamped views round and clamp on store, so no per-channel conversion calls are needed.
  const alb0 = out.albedoC[0], nor0 = out.normalC[0], spc0 = out.specC[0];
  const cur = MIP_BUF[0];
  const base = layer * N * 4;
  const bump = t.bump, flat = t.flat, cut = t.cutout;
  const R = t.r, G = t.g, Bc = t.b, A = t.a, H = t.h, SM = t.sm, MT = t.mt, EM = t.em, TM = t.tm;
  let covered = 0;
  for (let i = 0; i < N; i++) {
    const o = base + i * 4;
    alb0[o] = R[i]; alb0[o + 1] = G[i]; alb0[o + 2] = Bc[i];
    const a = cut ? (A[i] >= 0.5 ? 1 : 0) : 1;
    alb0[o + 3] = a * 255;
    let nx = 0, ny = 0, nz = 1;
    if (!flat) {
      sobelAt(H, i);
      nx = -GX * bump; ny = -GY * bump;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= l; ny /= l; nz = 1 / l;
    }
    nor0[o] = nx * 127.5 + 127.5;
    nor0[o + 1] = ny * 127.5 + 127.5;
    nor0[o + 2] = nz * 127.5 + 127.5;
    nor0[o + 3] = H[i] * 255;
    spc0[o] = SM[i] * 255;
    spc0[o + 1] = MT[i] * 255;
    spc0[o + 2] = EM[i] * 255;
    spc0[o + 3] = TM[i] * 255;
    // Transparent texels still contribute a little so fully empty regions keep a colour.
    const w = a + 1e-3;
    const c = i * STRIDE;
    cur[c] = SRGB_TO_LIN[albedo[0][o]] * w; cur[c + 1] = SRGB_TO_LIN[albedo[0][o + 1]] * w; cur[c + 2] = SRGB_TO_LIN[albedo[0][o + 2]] * w;
    cur[c + 3] = nx * w; cur[c + 4] = ny * w; cur[c + 5] = nz * w;
    cur[c + 6] = H[i] * w; cur[c + 7] = SM[i] * w; cur[c + 8] = MT[i] * w;
    cur[c + 9] = EM[i] * w; cur[c + 10] = TM[i] * w;
    cur[c + 11] = w; cur[c + 12] = a;
    covered += a;
  }
  const coverage = covered / N;
  if (cut) cutout[layer] = 1;

  let w0 = S;
  for (let level = 1; level < TEX_LEVELS; level++) {
    const src = MIP_BUF[level - 1], dst = MIP_BUF[level];
    const w1 = w0 >> 1, n1 = w1 * w1;
    for (let y = 0; y < w1; y++) {
      for (let x = 0; x < w1; x++) {
        const d = (x + y * w1) * STRIDE;
        const a0 = (2 * x + 2 * y * w0) * STRIDE, a1 = a0 + STRIDE, a2 = a0 + w0 * STRIDE, a3 = a2 + STRIDE;
        for (let c = 0; c < STRIDE; c++) dst[d + c] = (src[a0 + c] + src[a1 + c] + src[a2 + c] + src[a3 + c]) * 0.25;
      }
    }
    let scale = 1;
    if (cut) {
      for (let j = 0; j < n1; j++) MIP_ALPHA[j] = dst[j * STRIDE + 12];
      scale = coverageScale(MIP_ALPHA.subarray(0, n1), coverage);
    }
    const lb = layer * n1 * 4;
    const alb = albedo[level], nor = out.normalC[level], spc = out.specC[level];
    for (let j = 0; j < n1; j++) {
      const o = lb + j * 4, c = j * STRIDE, iw = 1 / dst[c + 11];
      alb[o] = linToSrgb8(dst[c] * iw);
      alb[o + 1] = linToSrgb8(dst[c + 1] * iw);
      alb[o + 2] = linToSrgb8(dst[c + 2] * iw);
      alb[o + 3] = cut ? unit8(dst[c + 12] * scale) : 255;
      const nx = dst[c + 3], ny = dst[c + 4], nz = dst[c + 5];
      const l = 127.5 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nor[o] = nx * l + 127.5;
      nor[o + 1] = ny * l + 127.5;
      nor[o + 2] = nz * l + 127.5;
      nor[o + 3] = dst[c + 6] * iw * 255;
      spc[o] = dst[c + 7] * iw * 255;
      spc[o + 1] = dst[c + 8] * iw * 255;
      spc[o + 2] = dst[c + 9] * iw * 255;
      spc[o + 3] = dst[c + 10] * iw * 255;
    }
    w0 = w1;
  }
}

// Alpha scale for a mip level so the fraction of texels passing the 0.5 alpha test matches the
// base level as closely as possible (ties keep more texels), so foliage, plants and torches don't
// thin out or vanish with distance.
function coverageScale(a, target) {
  const n = a.length;
  const sorted = Array.from(a).sort((p, q) => q - p);
  // Candidate thresholds are the distinct alpha values: passing the k-th largest lets through
  // every texel tied with it, so compare whole tie groups.
  let bestK = 0, bestErr = target;
  for (let k = 1; k <= n; k++) {
    if (sorted[k - 1] <= 0) break;
    if (k < n && sorted[k] === sorted[k - 1]) continue;
    const err = Math.abs(k / n - target);
    if (err <= bestErr) { bestErr = err; bestK = k; }
  }
  return bestK ? Math.min(64, 0.5 / sorted[bestK - 1]) : 0;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

// Every texture name the blocks reference (in first-use order), plus water and lava.
export function textureNames() {
  const names = [];
  const seen = new Set();
  const add = (n) => { if (!seen.has(n)) { seen.add(n); names.push(n); } };
  for (const d of BLOCKS) {
    if (d.shape === SHAPE_NONE) continue;
    for (const n of faceTextures(d)) add(n);
  }
  add('water');
  add('lava');
  return names;
}

export function buildTextures() {
  const names = textureNames();
  const layers = names.length;
  const albedo = [], normal = [], spec = [];
  for (let level = 0, s = S; level < TEX_LEVELS; level++, s >>= 1) {
    albedo.push(new Uint8Array(layers * s * s * 4));
    normal.push(new Uint8Array(layers * s * s * 4));
    spec.push(new Uint8Array(layers * s * s * 4));
  }
  const cutout = new Uint8Array(layers);
  const layerOf = {};
  const missingNames = [];
  const clamped = (arr) => arr.map((a) => new Uint8ClampedArray(a.buffer, a.byteOffset, a.length));
  const out = { albedo, normal, spec, cutout, albedoC: clamped(albedo), normalC: clamped(normal), specC: clamped(spec) };
  const t = new Tex();
  names.forEach((name, layer) => {
    layerOf[name] = layer;
    t.reset(name);
    const recipe = RECIPES[name];
    if (recipe) recipe(t); else { missing(t); missingNames.push(name); }
    bakeLight(t);
    if (t.cutout) bleed(t);
    encodeLayer(t, layer, out);
  });
  if (missingNames.length) console.warn('textures: no recipe for', missingNames.join(', '));

  const faceLayers = new Uint16Array(NUM_BLOCKS * 6);
  for (const d of BLOCKS) {
    if (d.shape === SHAPE_NONE) continue;
    faceTextures(d).forEach((n, f) => { faceLayers[d.id * 6 + f] = layerOf[n] ?? 0; });
  }

  return { size: S, layers, levels: TEX_LEVELS, albedo, normal, spec, layerOf, faceLayers, cutout, names, missing: missingNames };
}

// Default tints (sRGB 0..255) for places without a biome: icons, held block, particles.
const DEFAULT_TINTS = {
  [TINT_GRASS]: [124, 189, 88],
  [TINT_FOLIAGE]: [96, 161, 58],
  [TINT_BIRCH]: [128, 167, 85],
  [TINT_SPRUCE]: [97, 153, 97],
  [TINT_WATER]: [52, 116, 204],
};
export function defaultTint(blockId) {
  const d = BLOCKS[blockId];
  return (d && DEFAULT_TINTS[d.tint]) || [255, 255, 255];
}

// Isometric view used for icons: 30 degree elevation, looking from the +X/+Z corner, so the
// +Z face is on the left, +X on the right (both upright, like Minecraft's inventory).
const ICON_EL = Math.PI / 6;
const ICON_FWD = [-Math.cos(ICON_EL) * Math.SQRT1_2, -Math.sin(ICON_EL), -Math.cos(ICON_EL) * Math.SQRT1_2];
const ICON_RIGHT = [Math.SQRT1_2, 0, -Math.SQRT1_2];
const ICON_UP = [
  ICON_RIGHT[1] * ICON_FWD[2] - ICON_RIGHT[2] * ICON_FWD[1],
  ICON_RIGHT[2] * ICON_FWD[0] - ICON_RIGHT[0] * ICON_FWD[2],
  ICON_RIGHT[0] * ICON_FWD[1] - ICON_RIGHT[1] * ICON_FWD[0],
];
// Face shading: +X, -X, +Y, -Y, +Z, -Z (back faces are only seen through cutout holes)
const ICON_SHADE = [0.6, 0.5, 1.0, 0.42, 0.8, 0.55];
const FACE_BASIS = [ // base corner, U, V (as in vertex.js FACES)
  [[1, 1, 1], [0, 0, -1], [0, -1, 0]],
  [[0, 1, 0], [0, 0, 1], [0, -1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 0, -1]],
  [[0, 1, 1], [1, 0, 0], [0, -1, 0]],
  [[1, 1, 0], [-1, 0, 0], [0, -1, 0]],
];

function texel(tex, layer, u, v, tint, out) {
  const tx = Math.min(15, Math.max(0, Math.floor(u * 16)));
  const ty = Math.min(15, Math.max(0, Math.floor(v * 16)));
  const o = (layer * N + tx + ty * S) * 4;
  const a = tex.albedo[0][o + 3];
  const m = tex.spec[0][o + 3] / 255;
  out[0] = tex.albedo[0][o] * (1 - m + (m * tint[0]) / 255);
  out[1] = tex.albedo[0][o + 1] * (1 - m + (m * tint[1]) / 255);
  out[2] = tex.albedo[0][o + 2] * (1 - m + (m * tint[2]) / 255);
  out[3] = a;
  out[4] = tex.spec[0][o + 2] / 255;
  return out;
}

function faceUV(face, p) {
  const [base, U, V] = FACE_BASIS[face];
  const dx = p[0] - base[0], dy = p[1] - base[1], dz = p[2] - base[2];
  return [dx * U[0] + dy * U[1] + dz * U[2], dx * V[0] + dy * V[1] + dz * V[2]];
}

// Orthographic ray through the unit cube: entry and exit faces + hit points.
function cubeHits(ox, oy, oz) {
  const o = [ox, oy, oz], d = ICON_FWD;
  let tn = -Infinity, tf = Infinity, fn = -1, ff = -1;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / d[a];
    let t0 = (0 - o[a]) * inv, t1 = (1 - o[a]) * inv;
    // Entering through the max side when travelling in -a
    let f0 = a * 2 + 1, f1 = a * 2;
    if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; const ft = f0; f0 = f1; f1 = ft; }
    if (t0 > tn) { tn = t0; fn = f0; }
    if (t1 < tf) { tf = t1; ff = f1; }
  }
  if (tn > tf) return null;
  return [fn, [o[0] + d[0] * tn, o[1] + d[1] * tn, o[2] + d[2] * tn], ff, [o[0] + d[0] * tf, o[1] + d[1] * tf, o[2] + d[2] * tf]];
}

export function makeBlockIcon(tex, blockId, size = 64) {
  size = Math.max(1, Math.round(size));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const def = BLOCKS[blockId];
  if (!def || def.shape === SHAPE_NONE || !tex) return canvas;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const px = img.data;
  const tint = defaultTint(blockId);
  const layers = tex.faceLayers.subarray(blockId * 6, blockId * 6 + 6);
  const s = [0, 0, 0, 0, 0];

  if (def.shape === SHAPE_CROSS || def.shape === SHAPE_TORCH) {
    // Flat sprite, nearest-neighbour scaled
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        texel(tex, layers[0], (x + 0.5) / size, (y + 0.5) / size, tint, s);
        if (s[3] < 128) continue;
        const o = (x + y * size) * 4;
        px[o] = s[0]; px[o + 1] = s[1]; px[o + 2] = s[2]; px[o + 3] = 255;
      }
    }
  } else {
    // Isometric cube, one ray per pixel so texels stay crisp
    const alpha = def.shape === SHAPE_FLUID && def.tint === TINT_WATER ? 215 : 255;
    const extent = Math.SQRT2 * Math.sin(ICON_EL) + Math.cos(ICON_EL); // projected height
    const k = extent / (size * 0.94);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const sx = (x + 0.5 - size / 2) * k, sy = (size / 2 - y - 0.5) * k;
        const ox = 0.5 + ICON_RIGHT[0] * sx + ICON_UP[0] * sy - ICON_FWD[0] * 4;
        const oy = 0.5 + ICON_RIGHT[1] * sx + ICON_UP[1] * sy - ICON_FWD[1] * 4;
        const oz = 0.5 + ICON_RIGHT[2] * sx + ICON_UP[2] * sy - ICON_FWD[2] * 4;
        const hit = cubeHits(ox, oy, oz);
        if (!hit) continue;
        let face = hit[0], uv = faceUV(face, hit[1]);
        texel(tex, layers[face], uv[0], uv[1], tint, s);
        if (s[3] < 128) {
          // See through cutout holes to the inside of the far faces
          face = hit[2];
          uv = faceUV(face, hit[3]);
          texel(tex, layers[face], uv[0], uv[1], tint, s);
          if (s[3] < 128) continue;
        }
        // Inner sides of the far faces are lit like the opposite face, a bit darker
        let shade = face === hit[0] ? ICON_SHADE[face] : ICON_SHADE[face ^ 1] * 0.72;
        shade += (1 - shade) * s[4] * 0.85;              // emissive faces stay bright
        const o = (x + y * size) * 4;
        px[o] = Math.min(255, s[0] * shade);
        px[o + 1] = Math.min(255, s[1] * shade);
        px[o + 2] = Math.min(255, s[2] * shade);
        px[o + 3] = alpha;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
