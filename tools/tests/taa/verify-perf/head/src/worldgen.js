// World generation. Everything here is a pure function of (seed, world position): chunks can be
// generated in any order, on any thread, and features that straddle chunk borders (trees) come out
// identical on both sides because every decision is made from position-only functions.
//
// Pipeline per chunk:
//   1. Column data for the chunk plus a margin (height, climate, biome, slope, cave limits).
//      Low-frequency fields (continents, erosion, rivers, climate) are sampled on a world-aligned
//      4-block grid and bilinearly interpolated; per-column detail (hills, ridges) is exact.
//   2. Terrain columns: bedrock, stone, biome surface layers, water / ice.
//   3. Ore veins and underground dirt/gravel blobs (replace stone only).
//   4. Caves: spaghetti tunnels + deep caverns from 3D noise on a world-aligned 4-block lattice
//      (trilinear), lava below y = 10.
//   5. Trees and cacti from candidates within MARGIN blocks around the chunk (blocks written
//      only inside the chunk), then grass, ferns, flowers and dead bushes.

import { CHUNK, HEIGHT, SEA, B } from './blocks.js';
import { Simplex, hash2, hash3, mulberry32 } from './noise.js';

export const BIOMES = [
  { id: 0, key: 'ocean', name: 'Ocean', color: [46, 88, 170] },
  { id: 1, key: 'deep_ocean', name: 'Deep Ocean', color: [28, 58, 128] },
  { id: 2, key: 'frozen_ocean', name: 'Frozen Ocean', color: [120, 150, 200] },
  { id: 3, key: 'river', name: 'River', color: [60, 110, 200] },
  { id: 4, key: 'frozen_river', name: 'Frozen River', color: [150, 170, 220] },
  { id: 5, key: 'beach', name: 'Beach', color: [222, 208, 150] },
  { id: 6, key: 'stony_shore', name: 'Stony Shore', color: [140, 140, 136] },
  { id: 7, key: 'plains', name: 'Plains', color: [140, 186, 88] },
  { id: 8, key: 'forest', name: 'Forest', color: [60, 128, 50] },
  { id: 9, key: 'birch_forest', name: 'Birch Forest', color: [96, 150, 72] },
  { id: 10, key: 'taiga', name: 'Taiga', color: [48, 96, 80] },
  { id: 11, key: 'snowy_taiga', name: 'Snowy Taiga', color: [180, 200, 196] },
  { id: 12, key: 'snowy_tundra', name: 'Snowy Tundra', color: [232, 238, 244] },
  { id: 13, key: 'desert', name: 'Desert', color: [230, 206, 120] },
  { id: 14, key: 'mountains', name: 'Mountains', color: [128, 128, 122] },
  { id: 15, key: 'snowy_peaks', name: 'Snowy Peaks', color: [245, 248, 252] },
  { id: 16, key: 'badlands', name: 'Badlands', color: [186, 102, 60] },
];

const OCEAN = 0, DEEP_OCEAN = 1, FROZEN_OCEAN = 2, RIVER = 3, FROZEN_RIVER = 4, BEACH = 5,
  STONY_SHORE = 6, PLAINS = 7, FOREST = 8, BIRCH_FOREST = 9, TAIGA = 10, SNOWY_TAIGA = 11,
  SNOWY_TUNDRA = 12, DESERT = 13, MOUNTAINS = 14, SNOWY_PEAKS = 15, BADLANDS = 16;

// Water fills every non-solid cell at y <= WATER_TOP in columns below it, so the visible water
// surface sits at ~SEA (the top water block is drawn 14/16 high).
export const WATER_TOP = SEA - 1;

const G = 4;                    // coarse 2D field grid spacing (blocks)
const NF = 8;                   // fields per grid sample
const MARGIN = 4;               // max horizontal reach of a tree from its trunk
const PAD = MARGIN + 1;         // column data margin (slope / neighbour checks need one more)
const RW = CHUNK + 2 * PAD;     // padded region width
const RN = RW * RW;
const GW = (CHUNK + 2 * PAD + G - 1) / G + 2 | 0; // grid samples per axis covering the region
const CS = 4;                   // cave lattice spacing
const CGX = CHUNK / CS + 1;     // cave lattice points per horizontal axis in a chunk
const CGY = HEIGHT / CS + 1;
const MAX_H = 124;              // terrain never exceeds this (room for snow + trees)
const COAST = -0.11;            // continentalness at the shoreline (~35% ocean)
const RIVER_W = 0.075;          // river valley half-width in river-noise units
const RIVER_BED = 51.6;
const LAVA_Y = 10;

// Continentalness -> base height (piecewise linear).
const CONT_X = [-1.0, -0.5, -0.32, -0.2, -0.14, -0.11, -0.085, -0.04, 0.05, 0.2, 0.4, 1.0];
const CONT_Y = [30, 33, 38, 45, 50.5, 54.6, 56.2, 57.8, 60.5, 64, 69, 78];

function contHeight(c) {
  if (c <= CONT_X[0]) return CONT_Y[0];
  for (let k = 1; k < CONT_X.length; k++) {
    if (c < CONT_X[k]) {
      const t = (c - CONT_X[k - 1]) / (CONT_X[k] - CONT_X[k - 1]);
      return CONT_Y[k - 1] + (CONT_Y[k] - CONT_Y[k - 1]) * t;
    }
  }
  return CONT_Y[CONT_Y.length - 1];
}

function smoothstep(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Shared by the chunk path and the single-point path so both produce bit-identical values.
function bilerp(a00, a10, a01, a11, fx, fz) {
  const top = a00 + (a10 - a00) * fx;
  const bot = a01 + (a11 - a01) * fx;
  return top + (bot - top) * fz;
}

function trilerp(a000, a100, a010, a110, a001, a101, a011, a111, fx, fy, fz) {
  const x00 = a000 + (a100 - a000) * fx;
  const x10 = a010 + (a110 - a010) * fx;
  const x01 = a001 + (a101 - a001) * fx;
  const x11 = a011 + (a111 - a011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

function mixSeed(seed, salt) {
  return (hash3(salt, seed | 0, salt * 7 + 3, 0x2f6b1d35) * 4294967296) | 0;
}

// ---- Climate colours --------------------------------------------------------------------------
// Grass colour over (temperature, humidity): cold / temperate / hot columns, dry and wet rows.
const GRASS_COLD_DRY = [136, 178, 140], GRASS_COLD_WET = [120, 182, 162];
const GRASS_TEMP_DRY = [146, 190, 88], GRASS_TEMP_WET = [100, 196, 84];
const GRASS_HOT_DRY = [191, 183, 85], GRASS_HOT_WET = [89, 201, 60];
const WATER_COLD = [38, 92, 168], WATER_WARM = [44, 150, 160];

function writeColors(out, o, T, H, v) {
  const lo = T < 0.5;
  const t = lo ? smoothstep(0.05, 0.5, T) : smoothstep(0.5, 0.95, T);
  const aD = lo ? GRASS_COLD_DRY : GRASS_TEMP_DRY, aW = lo ? GRASS_COLD_WET : GRASS_TEMP_WET;
  const bD = lo ? GRASS_TEMP_DRY : GRASS_HOT_DRY, bW = lo ? GRASS_TEMP_WET : GRASS_HOT_WET;
  const h = smoothstep(0.1, 0.9, H);
  // Small low-frequency variation so large biomes are not one flat colour.
  const vary = 1 + v * 0.045;
  const r = (aD[0] + (bD[0] - aD[0]) * t) * (1 - h) + (aW[0] + (bW[0] - aW[0]) * t) * h;
  const g = (aD[1] + (bD[1] - aD[1]) * t) * (1 - h) + (aW[1] + (bW[1] - aW[1]) * t) * h;
  const b = (aD[2] + (bD[2] - aD[2]) * t) * (1 - h) + (aW[2] + (bW[2] - aW[2]) * t) * h;
  const lum = (r * 0.3 + g * 0.59 + b * 0.11) * vary;
  out[o] = byte(r * vary); out[o + 1] = byte(g * vary); out[o + 2] = byte(b * vary);
  // Foliage: darker and more saturated than grass.
  out[o + 3] = byte((lum + (r * vary - lum) * 1.25) * 0.84);
  out[o + 4] = byte((lum + (g * vary - lum) * 1.25) * 0.84);
  out[o + 5] = byte((lum + (b * vary - lum) * 1.25) * 0.84);
  const wt = smoothstep(0.15, 0.85, T);
  out[o + 6] = byte(WATER_COLD[0] + (WATER_WARM[0] - WATER_COLD[0]) * wt);
  out[o + 7] = byte(WATER_COLD[1] + (WATER_WARM[1] - WATER_COLD[1]) * wt);
  out[o + 8] = byte(WATER_COLD[2] + (WATER_WARM[2] - WATER_COLD[2]) * wt);
}

const byte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

// ---- Column buffer ----------------------------------------------------------------------------
class Columns {
  constructor(n) {
    this.hF = new Float64Array(n);   // exact terrain height
    this.h = new Int16Array(n);      // top terrain block y
    this.biome = new Uint8Array(n);
    this.temp = new Float32Array(n); // height-adjusted temperature 0..1
    this.hum = new Float32Array(n);
    this.snowY = new Int16Array(n);
    this.mMask = new Float32Array(n);
    this.caveT = new Float32Array(n); // tunnel threshold
    this.veg = new Float32Array(n);  // vegetation density noise -1..1
    this.slope = new Float32Array(n);
    this.limit = new Int16Array(n);  // caves may carve y < limit
    this.top = new Uint8Array(n);    // surface block id
    this.nearWater = new Uint8Array(n);
    this.tree = new Uint8Array(n);   // accepted feature type (see TREE_*)
  }
}

const TREE_NONE = 0, TREE_OAK = 1, TREE_BIRCH = 2, TREE_SPRUCE = 3, TREE_BIG_OAK = 4, TREE_CACTUS = 5,
  TREE_BOULDER = 6;

// Ore veins per chunk: [block, veins, minY, maxY, minSize, maxSize, chance per vein]
const ORES = [
  [B.COAL_ORE, 20, 5, 100, 4, 8, 1],
  [B.IRON_ORE, 11, 4, 64, 3, 7, 1],
  [B.GOLD_ORE, 3, 4, 32, 3, 7, 0.8],
  [B.REDSTONE_ORE, 5, 3, 16, 3, 7, 1],
  [B.DIAMOND_ORE, 2, 3, 16, 3, 6, 0.55],
];

export class WorldGen {
  constructor(seed) {
    this.seed = seed | 0;
    const s = this.seed;
    this.nCont = new Simplex(mixSeed(s, 1));
    this.nEro = new Simplex(mixSeed(s, 2));
    this.nRiver = new Simplex(mixSeed(s, 3));
    this.nTemp = new Simplex(mixSeed(s, 4));
    this.nHum = new Simplex(mixSeed(s, 5));
    this.nWarp = new Simplex(mixSeed(s, 6));
    this.nJit = new Simplex(mixSeed(s, 7));
    this.nHill = new Simplex(mixSeed(s, 8));
    this.nRidge = new Simplex(mixSeed(s, 9));
    this.nDetail = new Simplex(mixSeed(s, 10));
    this.nPatch = new Simplex(mixSeed(s, 11));
    this.nCave1 = new Simplex(mixSeed(s, 12));
    this.nCave2 = new Simplex(mixSeed(s, 13));
    this.nCave3 = new Simplex(mixSeed(s, 14));
    this.seedTree = mixSeed(s, 20);
    this.seedTreeShape = mixSeed(s, 21);
    this.seedPlant = mixSeed(s, 22);
    this.seedBedrock = mixSeed(s, 23);
    this.seedOre = mixSeed(s, 24);
    this.seedMisc = mixSeed(s, 25);

    // Scratch (reused between chunks).
    this.grid = new Float64Array(GW * GW * NF);
    this.cols = new Columns(RN);
    this.f = new Float64Array(NF);
    // Float64 like the point path: carve decisions must match _caveAtPoint bit for bit.
    this.cave = new Float64Array(CGX * CGX * CGY * 3);
    // Single-point evaluation scratch.
    this.pGrid = new Float64Array(4 * NF);
    this.pCols = new Columns(1);
    this.pCave = new Float64Array(8 * 3);
  }

  // ---- Low-frequency fields on the 4-block grid --------------------------------------------
  _gridSample(gx, gz, out, o) {
    const x = gx * G, z = gz * G;
    // Domain warp breaks up the continents' blobby outlines into bays and peninsulas.
    const wx = x + this.nWarp.noise2(x / 460, z / 460) * 95;
    const wz = z + this.nWarp.noise2(x / 460 + 71.3, z / 460 - 33.1) * 95;
    out[o] = this.nCont.fbm2(wx / 1050, wz / 1050, 5) + 0.035;
    out[o + 1] = this.nEro.fbm2(x / 420, z / 420, 3);
    // Rivers follow |noise| ~ 0 of a separately warped field so they meander.
    const rx = x + this.nWarp.noise2(x / 170 - 19.7, z / 170 + 5.3) * 38;
    const rz = z + this.nWarp.noise2(x / 170 + 44.1, z / 170 + 91.7) * 38;
    out[o + 2] = this.nRiver.fbm2(rx / 640, rz / 640, 4);
    out[o + 3] = this.nTemp.fbm2(x / 950, z / 950, 3);
    out[o + 4] = this.nHum.fbm2(x / 640, z / 640, 3);
    out[o + 5] = this.nJit.noise2(x / 44, z / 44);
    out[o + 6] = this.nJit.noise2(x / 260 + 300, z / 260);
    out[o + 7] = this.nJit.noise2(x / 80 - 500, z / 80);
  }

  // ---- Per-column terrain + climate + biome (f = interpolated grid fields) -----------------
  _column(x, z, f, cb, i) {
    const c = f[0], e = f[1];
    const land = smoothstep(-0.13, 0.02, c);
    const flat = smoothstep(-0.25, 0.3, e);
    const hills = this.nHill.fbm2(x / 105, z / 105, 4);
    const detail = this.nDetail.noise2(x / 21, z / 21);
    let h = contHeight(c) + hills * (4 + land * (2 + 12 * (1 - flat))) + detail * (0.5 + 0.9 * land);

    // Mountains: ridged noise where the land is inland and erosion is low.
    const mMask = smoothstep(-0.06, 0.16, c) * (1 - smoothstep(-0.32, 0.0, e));
    if (mMask > 0) {
      // Ranges get taller where erosion is lowest, so peak heights vary between ranges.
      const ridge = this.nRidge.ridged2(x / 330, z / 330, 5);
      const amp = 50 + 40 * smoothstep(-0.12, -0.5, e);
      h += mMask * (10 + amp * Math.pow(ridge, 1.6));
    }

    // Rivers carve valleys down to below sea level (never up, never through high mountains).
    const rAbs = Math.abs(f[2]);
    const rStrength = smoothstep(-0.125, -0.085, c) * (1 - smoothstep(0.2, 0.55, mMask));
    let river = 0;
    if (rStrength > 0 && rAbs < RIVER_W) {
      const s = rAbs / RIVER_W;
      const k = s * s * (3 - 2 * s);
      const prof = RIVER_BED + (h - RIVER_BED) * k;
      if (prof < h) h += (prof - h) * rStrength;
      river = rStrength * (1 - smoothstep(0.25, 0.6, s));
    }

    // Soft ceiling keeps peaks inside the world with room for snow.
    if (h > 104) h = 104 + 20 * (1 - Math.exp(-(h - 104) / 20));
    if (h > MAX_H) h = MAX_H;
    if (h < 4) h = 4;
    const hi = Math.floor(h);

    // Climate: temperature cools with altitude; the jitter frays biome borders.
    const jit = f[5];
    const tBase = clamp01(0.5 + f[3] * 1.05 + jit * 0.035);
    const T = clamp01(tBase - Math.max(0, h - 78) * 0.005);
    const Hm = clamp01(0.5 + f[4] * 1.15 - jit * 0.03);
    const snowY = Math.round(90 + tBase * 28 + jit * 3);

    let biome;
    if (hi < WATER_TOP) {
      if (river > 0.35) biome = T < 0.15 ? FROZEN_RIVER : RIVER;
      else if (T < 0.15) biome = FROZEN_OCEAN;
      else biome = hi < SEA - 17 ? DEEP_OCEAN : OCEAN;
    } else if (mMask > 0.5 && hi > SEA + 24) {
      // Mountains in a desert climate become banded terracotta badlands.
      // Drier than the desert threshold so badlands always rise out of desert, never forest.
      biome = T > 0.68 && Hm < 0.4 ? BADLANDS : hi >= snowY ? SNOWY_PEAKS : MOUNTAINS;
    } else if (hi <= SEA + 2 && c < COAST + 0.07 && river < 0.2) {
      biome = mMask > 0.25 ? STONY_SHORE : BEACH;
    } else if (T < 0.2) biome = Hm > 0.52 ? SNOWY_TAIGA : SNOWY_TUNDRA;
    else if (T < 0.36) biome = TAIGA;
    else if (T > 0.64 && Hm < 0.45) biome = DESERT;
    else if (Hm > 0.62 && T < 0.58) biome = BIRCH_FOREST;
    else if (Hm > 0.5) biome = FOREST;
    else biome = PLAINS;

    cb.hF[i] = h;
    cb.h[i] = hi;
    cb.biome[i] = biome;
    cb.temp[i] = T;
    cb.hum[i] = Hm;
    cb.snowY[i] = snowY;
    cb.mMask[i] = mMask;
    // Tunnel threshold ~ (radius * |grad n|)^2; zero-crossings are steep, so r ~ 0 (no tunnels) to ~2.5 blocks.
    cb.caveT[i] = 0.042 * smoothstep(-0.55, 0.5, f[6]);
    cb.veg[i] = f[7];
  }

  // Evaluate one column through the same grid + interpolation as the chunk path.
  _point(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    const gx = Math.floor(x / G), gz = Math.floor(z / G);
    const g = this.pGrid;
    this._gridSample(gx, gz, g, 0);
    this._gridSample(gx + 1, gz, g, NF);
    this._gridSample(gx, gz + 1, g, 2 * NF);
    this._gridSample(gx + 1, gz + 1, g, 3 * NF);
    const fx = (x - gx * G) / G, fz = (z - gz * G) / G;
    const f = this.f;
    for (let k = 0; k < NF; k++) f[k] = bilerp(g[k], g[NF + k], g[2 * NF + k], g[3 * NF + k], fx, fz);
    this._column(x, z, f, this.pCols, 0);
    return this.pCols;
  }

  heightAt(x, z) { return this._point(x, z).h[0]; }

  climateAt(x, z) {
    const c = this._point(x, z);
    return { temperature: c.temp[0], humidity: c.hum[0] };
  }

  biomeAt(x, z) { return this._point(x, z).biome[0]; }

  // Everything known about a column without generating its chunk (debug / tools).
  columnInfo(x, z) {
    const c = this._point(x, z);
    return {
      height: c.h[0], biome: c.biome[0], temperature: c.temp[0], humidity: c.hum[0],
      snowLine: c.snowY[0], mountain: c.mMask[0],
    };
  }

  // ---- Caves -------------------------------------------------------------------------------
  // Three fields on a world-aligned lattice: two tunnel fields (tunnels where both are ~0) and a
  // cavern field. Returned through `out` at offset o.
  _caveSample(x, y, z, out, o) {
    // Near-isotropic: with squashed y both zero-surfaces turn horizontal and tunnels flatten
    // into thin sheets.
    out[o] = this.nCave1.noise3(x / 50, y / 42, z / 50);
    out[o + 1] = this.nCave2.noise3(x / 50, y / 42, z / 50);
    out[o + 2] = y < 52 ? this.nCave3.noise3(x / 84, y / 38, z / 84) * 0.75 + this.nCave3.noise3(x / 27 + 50, y / 18, z / 27) * 0.25 : -1;
  }

  // Carve test on interpolated fields; t = tunnel threshold of the column.
  // depth = blocks below the column's surface; tunnels pinch shut near the surface so only
  // steep crossings open up as cave mouths instead of long roofless trenches.
  static _carves(n1, n2, cav, y, t, depth) {
    let tt = y < 24 ? t * 1.6 : t;
    if (depth < 12) tt *= depth < 0 ? 0.25 : 0.25 + depth * 0.0625;
    if (n1 * n1 + n2 * n2 < tt) return true;
    if (y >= 50) return false;
    // Caverns: widest around y 12..30, fading out toward y 50 and the bedrock floor.
    const thr = 0.38 + smoothstep(28, 50, y) * 0.5 + (y < 8 ? (8 - y) * 0.06 : 0);
    return cav > thr;
  }

  // Single-point cave test through the same lattice as the chunk path (for placement checks).
  _caveAtPoint(x, y, z, t, h) {
    const gx = Math.floor(x / CS), gy = Math.floor(y / CS), gz = Math.floor(z / CS);
    const p = this.pCave;
    for (let k = 0; k < 8; k++) {
      this._caveSample((gx + (k & 1)) * CS, (gy + ((k >> 1) & 1)) * CS, (gz + (k >> 2)) * CS, p, k * 3);
    }
    const fx = (x - gx * CS) / CS, fy = (y - gy * CS) / CS, fz = (z - gz * CS) / CS;
    const n1 = trilerp(p[0], p[3], p[6], p[9], p[12], p[15], p[18], p[21], fx, fy, fz);
    const n2 = trilerp(p[1], p[4], p[7], p[10], p[13], p[16], p[19], p[22], fx, fy, fz);
    const cv = trilerp(p[2], p[5], p[8], p[11], p[14], p[17], p[20], p[23], fx, fy, fz);
    return WorldGen._carves(n1, n2, cv, y, t, h - y);
  }

  // ---- Chunk generation --------------------------------------------------------------------
  generateChunk(cx, cz) {
    const blocks = new Uint8Array(CHUNK * CHUNK * HEIGHT);
    const colors = new Uint8Array(256 * 9);
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const cb = this.cols;

    this._fillColumns(x0, z0);
    this._surfaces(x0, z0);

    let maxH = 0;
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = (lx + PAD) + (lz + PAD) * RW;
        const col = lx | (lz << 4);
        this._terrainColumn(blocks, col, lx + x0, lz + z0, i);
        writeColors(colors, col * 9, cb.temp[i], cb.hum[i], cb.veg[i]);
        if (cb.h[i] > maxH) maxH = cb.h[i];
      }
    }

    this._ores(blocks, cx, cz);
    this._caves(blocks, x0, z0, maxH);
    this._trees(blocks, x0, z0);
    this._plants(blocks, x0, z0);
    return { blocks, colors };
  }

  // Column data for the padded region [x0 - PAD, x0 + 16 + PAD).
  _fillColumns(x0, z0) {
    const grid = this.grid, f = this.f, cb = this.cols;
    const gx0 = Math.floor((x0 - PAD) / G), gz0 = Math.floor((z0 - PAD) / G);
    for (let j = 0; j < GW; j++) {
      for (let k = 0; k < GW; k++) this._gridSample(gx0 + k, gz0 + j, grid, (k + j * GW) * NF);
    }
    for (let rz = 0; rz < RW; rz++) {
      const z = z0 - PAD + rz;
      const gz = Math.floor(z / G), fz = (z - gz * G) / G;
      const jz = gz - gz0;
      for (let rx = 0; rx < RW; rx++) {
        const x = x0 - PAD + rx;
        const gx = Math.floor(x / G), fx = (x - gx * G) / G;
        const o00 = ((gx - gx0) + jz * GW) * NF, o10 = o00 + NF, o01 = o00 + GW * NF, o11 = o01 + NF;
        for (let k = 0; k < NF; k++) f[k] = bilerp(grid[o00 + k], grid[o10 + k], grid[o01 + k], grid[o11 + k], fx, fz);
        this._column(x, z, f, cb, rx + rz * RW);
      }
    }
  }

  // Slope, water proximity, cave limits and surface block for the region minus one ring.
  _surfaces(x0, z0) {
    const cb = this.cols;
    const hF = cb.hF, h = cb.h;
    for (let rz = 1; rz < RW - 1; rz++) {
      for (let rx = 1; rx < RW - 1; rx++) {
        const i = rx + rz * RW;
        const gx = (hF[i + 1] - hF[i - 1]) * 0.5, gz = (hF[i + RW] - hF[i - RW]) * 0.5;
        cb.slope[i] = Math.sqrt(gx * gx + gz * gz);
        let minWater = 999;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const hn = h[i + dx + dz * RW];
            if (hn < WATER_TOP && hn < minWater) minWater = hn;
          }
        }
        const hi = h[i], b = cb.biome[i];
        let limit = hi + 1;
        if (minWater < 999) limit = Math.min(limit, minWater - 4);
        if (b === BEACH || b === STONY_SHORE || hi <= WATER_TOP + 2) limit = Math.min(limit, hi - 5);
        cb.limit[i] = limit;
        cb.nearWater[i] = minWater < 999 ? 1 : 0;
        cb.top[i] = this._topBlock(x0 - PAD + rx, z0 - PAD + rz, i);
      }
    }
  }

  // Surface block of a column; also used by tree placement, so it must stay a pure function
  // of column data.
  _topBlock(x, z, i) {
    const cb = this.cols;
    const hi = cb.h[i], b = cb.biome[i], sl = cb.slope[i];
    const n = this.nPatch.noise2(x / 13, z / 13);
    if (hi < WATER_TOP) {
      const depth = WATER_TOP - hi;
      if (b === RIVER || b === FROZEN_RIVER) return n > 0.4 ? B.CLAY : n < -0.35 ? B.GRAVEL : B.SAND;
      if (depth <= 5) return n > 0.62 ? B.CLAY : (b === FROZEN_OCEAN && n < -0.2) ? B.GRAVEL : B.SAND;
      if (depth <= 12) return n > 0.3 ? B.GRAVEL : n < -0.5 ? B.CLAY : B.SAND;
      return n > -0.35 ? B.GRAVEL : B.CLAY;
    }
    if (hi >= cb.snowY[i] + Math.round(n * 2)) return sl > 2.6 ? B.STONE : B.SNOW;
    switch (b) {
      case BEACH: return cb.temp[i] < 0.2 ? B.SNOW : B.SAND;
      case STONY_SHORE: return n > 0.15 ? B.GRAVEL : B.STONE;
      case DESERT: return sl > 2.2 ? B.SANDSTONE : B.SAND;
      case MOUNTAINS: case SNOWY_PEAKS:
        if (sl > 1.45 + n * 0.25) return n > 0.55 ? B.GRAVEL : B.STONE;
        return B.GRASS;
      case BADLANDS: return sl > 1.1 + n * 0.3 ? B.TERRACOTTA : B.SAND;
      default: break;
    }
    if (sl > 2.3 + n * 0.3) return B.STONE;
    // Sandy banks where land meets rivers and lakes.
    if (cb.nearWater[i] && hi <= WATER_TOP + 1 && n > -0.15) return b === SNOWY_TUNDRA || b === SNOWY_TAIGA || b === TAIGA ? B.GRAVEL : B.SAND;
    if (b === SNOWY_TUNDRA || b === SNOWY_TAIGA) return B.SNOWY_GRASS;
    if (b === TAIGA && n > 0.5) return B.DIRT; // podzol-like bare patches
    return B.GRASS;
  }

  _terrainColumn(blocks, col, x, z, i) {
    const cb = this.cols;
    const hi = cb.h[i], top = cb.top[i], b = cb.biome[i];
    const r = hash2(x, z, this.seedMisc);
    // Bedrock floor with a ragged top.
    blocks[col] = B.BEDROCK;
    const sb = this.seedBedrock;
    for (let y = 1; y <= 3; y++) {
      blocks[col | (y << 8)] = hash3(x, y, z, sb) < 0.75 - y * 0.2 ? B.BEDROCK : B.STONE;
    }
    // Layers under the top block.
    let fill = B.DIRT, fd = 3 + (r < 0.5 ? 0 : 1), deep = B.STONE, dd = 0;
    switch (top) {
      case B.SAND:
        fill = B.SAND; fd = b === DESERT ? 3 + (r * 3 | 0) : 3; deep = B.SANDSTONE; dd = 3 + (r * 7 | 0) % 3;
        break;
      case B.SANDSTONE: fill = B.SANDSTONE; fd = 3; break;
      case B.GRAVEL: fill = B.GRAVEL; fd = 2 + (r * 2 | 0); break;
      case B.CLAY: fill = B.CLAY; fd = 2; deep = B.SAND; dd = 1; break;
      case B.STONE: fill = B.STONE; fd = 0; break;
      case B.SNOW:
        if (b === BEACH) { fill = B.SAND; fd = 3; deep = B.SANDSTONE; dd = 2; } else { fill = cb.slope[i] > 1.4 ? B.STONE : B.SNOW; fd = 1 + (r * 2 | 0); }
        break;
      case B.GRASS: case B.SNOWY_GRASS: case B.DIRT:
        if (b === MOUNTAINS || b === SNOWY_PEAKS) fd = 1 + (r * 3 | 0);
        break;
      default: break;
    }
    const yFill = hi - fd, yDeep = yFill - dd;
    for (let y = 4; y < hi; y++) {
      blocks[col | (y << 8)] = y >= yFill ? fill : y >= yDeep ? deep : B.STONE;
    }
    blocks[col | (hi << 8)] = top;
    if (b === BADLANDS) this._strata(blocks, col, x, z, hi, top === B.SAND ? hi - 1 - (r * 2 | 0) : hi);
    if (hi < WATER_TOP) {
      for (let y = hi + 1; y <= WATER_TOP; y++) blocks[col | (y << 8)] = B.WATER;
      // Frozen surface with a ragged edge where the climate crosses the freezing point.
      const T = cb.temp[i];
      if (T < 0.15 + (r - 0.5) * 0.04) blocks[col | (WATER_TOP << 8)] = B.ICE;
      if (T < 0.12 && hi < WATER_TOP - 4) this._iceberg(blocks, col, x, z, hi, T);
    }
  }

  // Wavy horizontal bands of terracotta, sandstone and pale clay down the badlands cliffs.
  _strata(blocks, col, x, z, hi, from) {
    const wave = Math.round(this.nPatch.noise2(x / 71 + 13.7, z / 71 - 8.1) * 4);
    const sm = this.seedMisc ^ 0x7a3b;
    for (let y = from; y > hi - 26 && y > SEA - 8; y--) {
      const band = (y + wave) >> 1;
      const k = hash2(band, 11, sm);
      blocks[col | (y << 8)] = k < 0.6 ? B.TERRACOTTA : k < 0.86 ? B.SANDSTONE : B.CLAY;
    }
  }

  // Packed-ice bergs drifting in frozen oceans: a rounded mound above the water with a deeper
  // keel below, snow-capped when tall enough.
  _iceberg(blocks, col, x, z, hi, T) {
    const n = this.nPatch.noise2(x / 21 - 311.5, z / 21 + 97.25) + (0.12 - T) * 1.5;
    if (n < 0.55) return;
    const k = n - 0.55;
    const up = Math.min(9, Math.floor(k * 22));
    const down = Math.min(WATER_TOP - hi - 1, 2 + Math.floor(k * 30));
    for (let y = WATER_TOP - down; y <= WATER_TOP + up; y++) blocks[col | (y << 8)] = B.PACKED_ICE;
    if (up >= 3) blocks[col | ((WATER_TOP + up) << 8)] = B.SNOW;
  }

  // ---- Ores --------------------------------------------------------------------------------
  _ores(blocks, cx, cz) {
    const rnd = mulberry32(mixSeed(this.seedOre ^ Math.imul(cx, 0x1f1f1f1f), cz * 0x3c6ef372 + 7));
    for (let o = 0; o < ORES.length; o++) {
      const [id, veins, minY, maxY, minS, maxS, chance] = ORES[o];
      for (let v = 0; v < veins; v++) {
        if (rnd() > chance) { rnd(); rnd(); rnd(); rnd(); continue; }
        let x = rnd() * 16 | 0, z = rnd() * 16 | 0;
        let y = minY + (rnd() * (maxY - minY) | 0);
        const size = minS + (rnd() * (maxS - minS + 1) | 0);
        for (let s = 0; s < size; s++) {
          if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < HEIGHT) {
            const idx = x | (z << 4) | (y << 8);
            if (blocks[idx] === B.STONE) blocks[idx] = id;
          }
          const d = rnd() * 6 | 0;
          if (d === 0) x++; else if (d === 1) x--; else if (d === 2) z++; else if (d === 3) z--; else if (d === 4) y++; else y--;
        }
      }
    }
    // Dirt and gravel pockets underground break up the solid stone in caves and cliffs.
    for (let k = 0; k < 5; k++) {
      const id = k < 3 ? B.DIRT : B.GRAVEL;
      const bx = rnd() * 16, by = 8 + rnd() * 60, bz = rnd() * 16, r = 1.3 + rnd() * 1.4;
      const r2 = r * r;
      for (let y = Math.max(1, Math.floor(by - r)); y <= Math.ceil(by + r); y++) {
        for (let z = Math.max(0, Math.floor(bz - r)); z <= Math.min(15, Math.ceil(bz + r)); z++) {
          for (let x = Math.max(0, Math.floor(bx - r)); x <= Math.min(15, Math.ceil(bx + r)); x++) {
            const dx = x + 0.5 - bx, dy = y + 0.5 - by, dz = z + 0.5 - bz;
            if (dx * dx + dy * dy * 1.6 + dz * dz > r2) continue;
            const idx = x | (z << 4) | (y << 8);
            if (blocks[idx] === B.STONE) blocks[idx] = id;
          }
        }
      }
    }
  }

  // ---- Caves -------------------------------------------------------------------------------
  _caves(blocks, x0, z0, maxH) {
    const cb = this.cols, cave = this.cave;
    const gyMax = Math.min(CGY - 1, Math.ceil((maxH + 2) / CS));
    const gx0 = x0 / CS, gz0 = z0 / CS;
    // Lattice samples (x fastest, then z, then y).
    for (let gy = 0; gy <= gyMax; gy++) {
      for (let gz = 0; gz < CGX; gz++) {
        for (let gx = 0; gx < CGX; gx++) {
          this._caveSample((gx0 + gx) * CS, gy * CS, (gz0 + gz) * CS, cave, ((gx + gz * CGX) + gy * CGX * CGX) * 3);
        }
      }
    }
    let tMax = 0;
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const t = cb.caveT[(lx + PAD) + (lz + PAD) * RW] * 1.6;
        if (t > tMax) tMax = t;
      }
    }
    const sq = Math.sqrt(tMax);
    const SY = CGX * CGX * 3, SZ = CGX * 3;
    for (let cy = 0; cy < gyMax; cy++) {
      for (let cz4 = 0; cz4 < CGX - 1; cz4++) {
        for (let cx4 = 0; cx4 < CGX - 1; cx4++) {
          const o = (cx4 + cz4 * CGX + cy * CGX * CGX) * 3;
          const o000 = o, o100 = o + 3, o010 = o + SY, o110 = o + SY + 3;
          const o001 = o + SZ, o101 = o + SZ + 3, o011 = o + SY + SZ, o111 = o + SY + SZ + 3;
          // Skip cells where interpolation cannot reach a carve: trilinear values stay within
          // the corner range.
          let min1 = 9, max1 = -9, min2 = 9, max2 = -9, maxC = -9;
          for (let k = 0; k < 8; k++) {
            const q = o + (k & 1) * 3 + ((k >> 1) & 1) * SY + (k >> 2) * SZ;
            const a = cave[q], b = cave[q + 1], c = cave[q + 2];
            if (a < min1) min1 = a; if (a > max1) max1 = a;
            if (b < min2) min2 = b; if (b > max2) max2 = b;
            if (c > maxC) maxC = c;
          }
          const noTunnel = min1 > sq || max1 < -sq || min2 > sq || max2 < -sq;
          if (noTunnel && maxC < 0.38) continue;
          for (let dy = 0; dy < CS; dy++) {
            const y = cy * CS + dy;
            if (y < 1) continue;
            const fy = dy / CS;
            for (let dz = 0; dz < CS; dz++) {
              const lz = cz4 * CS + dz, fz = dz / CS;
              for (let dx = 0; dx < CS; dx++) {
                const lx = cx4 * CS + dx;
                const i = (lx + PAD) + (lz + PAD) * RW;
                if (y >= cb.limit[i]) continue;
                const idx = lx | (lz << 4) | (y << 8);
                const id = blocks[idx];
                if (id === B.BEDROCK || id === B.WATER || id === B.ICE || id === 0) continue;
                const fx = dx / CS;
                const n1 = trilerp(cave[o000], cave[o100], cave[o010], cave[o110], cave[o001], cave[o101], cave[o011], cave[o111], fx, fy, fz);
                const n2 = trilerp(cave[o000 + 1], cave[o100 + 1], cave[o010 + 1], cave[o110 + 1], cave[o001 + 1], cave[o101 + 1], cave[o011 + 1], cave[o111 + 1], fx, fy, fz);
                const cv = trilerp(cave[o000 + 2], cave[o100 + 2], cave[o010 + 2], cave[o110 + 2], cave[o001 + 2], cave[o101 + 2], cave[o011 + 2], cave[o111 + 2], fx, fy, fz);
                if (WorldGen._carves(n1, n2, cv, y, cb.caveT[i], cb.h[i] - y)) blocks[idx] = y <= LAVA_Y ? B.LAVA : B.AIR;
              }
            }
          }
        }
      }
    }
  }

  // Would the caves remove block (x, y, z)? Pure; region index i must be inside the margin.
  _carvedAt(x, y, z, i) {
    const cb = this.cols;
    if (y < 1 || y >= cb.limit[i]) return false;
    return this._caveAtPoint(x, y, z, cb.caveT[i], cb.h[i]);
  }

  // ---- Trees -------------------------------------------------------------------------------
  _treeDensity(i) {
    const cb = this.cols;
    const v = cb.veg[i];
    switch (cb.biome[i]) {
      case PLAINS: return 0.0025 + 0.03 * smoothstep(0.5, 0.85, v);
      case FOREST: return v < -0.55 ? 0.012 : 0.05 + 0.05 * smoothstep(-0.5, 0.5, v);
      case BIRCH_FOREST: return v < -0.6 ? 0.012 : 0.05 + 0.04 * smoothstep(-0.5, 0.5, v);
      case TAIGA: return v < -0.5 ? 0.01 : 0.045 + 0.05 * smoothstep(-0.4, 0.6, v);
      case SNOWY_TAIGA: return v < -0.6 ? 0.008 : 0.04 + 0.04 * smoothstep(-0.4, 0.6, v);
      case SNOWY_TUNDRA: return 0.003 + 0.025 * smoothstep(0.45, 0.8, v);
      case MOUNTAINS: return cb.h[i] < cb.snowY[i] - 8 ? 0.012 + 0.02 * smoothstep(0.2, 0.7, v) : 0;
      case DESERT: return 0.0075;
      default: return 0;
    }
  }

  // Decide the feature at every margin column (pure function of column data).
  _placeFeatures(x0, z0) {
    const cb = this.cols, st = this.seedTree;
    const tree = cb.tree;
    tree.fill(0);
    for (let rz = 1; rz < RW - 1; rz++) {
      const z = z0 - PAD + rz;
      for (let rx = 1; rx < RW - 1; rx++) {
        const i = rx + rz * RW;
        const x = x0 - PAD + rx;
        const hv = hash2(x, z, st);
        if (hv >= this._treeDensity(i)) continue;
        // Keep trunks apart: a neighbouring candidate with a lower hash wins.
        let beaten = false;
        for (let dz = -1; dz <= 1 && !beaten; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const hn = hash2(x + dx, z + dz, st);
            if (hn < hv && hn < this._treeDensity(i + dx + dz * RW)) { beaten = true; break; }
          }
        }
        if (beaten) continue;
        tree[i] = this._featureFor(x, z, i, hv);
      }
    }
  }

  _featureFor(x, z, i, hv) {
    const cb = this.cols;
    const hi = cb.h[i], top = cb.top[i], b = cb.biome[i];
    if (hi < SEA || hi > MAX_H - 16) return TREE_NONE;
    if (b === DESERT) {
      if (top !== B.SAND) return TREE_NONE;
      // Cacti need flat sand with nothing touching their sides.
      if (cb.h[i - 1] > hi || cb.h[i + 1] > hi || cb.h[i - RW] > hi || cb.h[i + RW] > hi) return TREE_NONE;
      if (this._carvedAt(x, hi, z, i)) return TREE_NONE;
      return TREE_CACTUS;
    }
    if (top !== B.GRASS && top !== B.DIRT && top !== B.SNOWY_GRASS) return TREE_NONE;
    if (cb.slope[i] > 1.25) return TREE_NONE;
    if (this._carvedAt(x, hi, z, i) || this._carvedAt(x, hi - 1, z, i)) return TREE_NONE;
    const r = hv / Math.max(1e-6, this._treeDensity(i)); // 0..1, independent of the accept test
    switch (b) {
      case TAIGA: case SNOWY_TAIGA: return r > 0.94 ? TREE_BOULDER : TREE_SPRUCE;
      case MOUNTAINS: case SNOWY_PEAKS: return r > 0.8 ? TREE_BOULDER : TREE_SPRUCE;
      case SNOWY_TUNDRA: return TREE_SPRUCE;
      case BIRCH_FOREST: return r < 0.88 ? TREE_BIRCH : TREE_OAK;
      case FOREST: return r < 0.2 ? TREE_BIRCH : r < 0.32 ? TREE_BIG_OAK : r > 0.985 ? TREE_BOULDER : TREE_OAK;
      case PLAINS: return r < 0.18 ? TREE_BIG_OAK : TREE_OAK;
      default: return TREE_OAK;
    }
  }

  _trees(blocks, x0, z0) {
    this._placeFeatures(x0, z0);
    const cb = this.cols;
    // Canonical world order (z, then x) so overlapping trees resolve the same in every chunk.
    for (let rz = 1; rz < RW - 1; rz++) {
      for (let rx = 1; rx < RW - 1; rx++) {
        const i = rx + rz * RW;
        const type = cb.tree[i];
        if (!type) continue;
        const x = x0 - PAD + rx, z = z0 - PAD + rz, y = cb.h[i];
        const rnd = mulberry32((hash2(x, z, this.seedTreeShape) * 4294967296) | 0);
        switch (type) {
          case TREE_OAK: this._oak(blocks, x0, z0, x, y, z, rnd, B.OAK_LOG, B.OAK_LEAVES, 4 + (rnd() * 3 | 0)); break;
          case TREE_BIRCH: this._oak(blocks, x0, z0, x, y, z, rnd, B.BIRCH_LOG, B.BIRCH_LEAVES, 5 + (rnd() * 3 | 0)); break;
          case TREE_SPRUCE: this._spruce(blocks, x0, z0, x, y, z, rnd); break;
          case TREE_BIG_OAK: this._bigOak(blocks, x0, z0, x, y, z, rnd); break;
          case TREE_BOULDER: this._boulder(blocks, x0, z0, x, y, z, rnd); break;
          case TREE_CACTUS: {
            const hgt = 1 + (rnd() * 3 | 0);
            for (let k = 1; k <= hgt; k++) this._put(blocks, x0, z0, x, y + k, z, B.CACTUS, true);
            break;
          }
          default: break;
        }
      }
    }
  }

  // Write a block if it lies inside the chunk and above that column's terrain (so canopies never
  // leak into cave mouths). Logs replace air/leaves/plants; leaves only air/plants.
  _put(blocks, x0, z0, x, y, z, id, isLog) {
    const lx = x - x0, lz = z - z0;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y >= HEIGHT) return;
    if (y <= this.cols.h[(lx + PAD) + (lz + PAD) * RW]) return;
    const idx = lx | (lz << 4) | (y << 8);
    const cur = blocks[idx];
    if (cur === B.AIR || cur === B.TALL_GRASS || cur === B.FERN || cur === B.POPPY || cur === B.DANDELION ||
      cur === B.CORNFLOWER || cur === B.DEAD_BUSH || (isLog && (cur === B.OAK_LEAVES || cur === B.BIRCH_LEAVES || cur === B.SPRUCE_LEAVES))) {
      blocks[idx] = id;
    }
  }

  _groundUnder(blocks, x0, z0, x, y, z) {
    const lx = x - x0, lz = z - z0;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
    const idx = lx | (lz << 4) | (y << 8);
    const cur = blocks[idx];
    if (cur === B.GRASS || cur === B.SNOWY_GRASS) blocks[idx] = B.DIRT;
  }

  // Classic oak/birch: two wide layers (radius 2) under two narrow ones, corners trimmed at random.
  _oak(blocks, x0, z0, x, y, z, rnd, log, leaves, height) {
    const top = y + height;
    const sm = this.seedTreeShape;
    for (let ly = top - 2; ly <= top + 1; ly++) {
      const rel = ly - top;
      const r = rel < 0 ? 2 : 1;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const corner = Math.abs(dx) === r && Math.abs(dz) === r;
          if (corner) {
            if (rel === 1) continue;
            if (hash3(x + dx, ly, z + dz, sm) < (rel === 0 ? 0.6 : 0.45)) continue;
          }
          this._put(blocks, x0, z0, x + dx, ly, z + dz, leaves, false);
        }
      }
    }
    for (let k = 1; k <= height; k++) this._put(blocks, x0, z0, x, y + k, z, log, true);
    this._groundUnder(blocks, x0, z0, x, y, z);
  }

  // Spruce: conical canopy of alternating wide/narrow rings with a pointed tip.
  _spruce(blocks, x0, z0, x, y, z, rnd) {
    const height = 6 + (rnd() * 5 | 0);
    const top = y + height;
    const bottom = y + 2 + (rnd() * 2 | 0);
    const maxR = height >= 9 ? 3 : 2;
    this._put(blocks, x0, z0, x, top + 1, z, B.SPRUCE_LEAVES, false);
    this._put(blocks, x0, z0, x, top + 2, z, B.SPRUCE_LEAVES, false);
    let k = 0;
    for (let ly = top; ly >= bottom; ly--, k++) {
      const grow = Math.min(maxR, 1 + Math.floor(k / 2.5));
      const r = k === 0 ? 1 : (k & 1) ? grow : Math.max(1, grow - 1);
      const r2 = r * r + 0.6;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          if (d2 >= r * r && hash3(x + dx, ly, z + dz, this.seedTreeShape) < 0.3) continue;
          this._put(blocks, x0, z0, x + dx, ly, z + dz, B.SPRUCE_LEAVES, false);
        }
      }
    }
    for (let j = 1; j <= height; j++) this._put(blocks, x0, z0, x, y + j, z, B.SPRUCE_LOG, true);
    this._groundUnder(blocks, x0, z0, x, y, z);
  }

  // Large oak: tall trunk, a big rounded crown and two or three branches ending in leaf clusters.
  _bigOak(blocks, x0, z0, x, y, z, rnd) {
    const height = 7 + (rnd() * 4 | 0);
    const top = y + height;
    this._blob(blocks, x0, z0, x, top, z, 3.2, 2.4);
    this._blob(blocks, x0, z0, x, top + 1.5, z, 2.2, 1.6);
    const branches = 2 + (rnd() < 0.5 ? 1 : 0);
    const a0 = rnd() * Math.PI * 2;
    for (let b = 0; b < branches; b++) {
      const a = a0 + (b / branches) * Math.PI * 2 + (rnd() - 0.5) * 0.8;
      const by = y + Math.floor(height * (0.5 + rnd() * 0.2));
      const ex = Math.round(Math.cos(a) * 2), ez = Math.round(Math.sin(a) * 2);
      const steps = 3;
      let px = x, pz = z;
      for (let s = 1; s <= steps; s++) {
        px = x + Math.round(ex * s / steps);
        pz = z + Math.round(ez * s / steps);
        this._put(blocks, x0, z0, px, by + s, pz, B.OAK_LOG, true);
      }
      this._blob(blocks, x0, z0, px, by + steps + 0.5, pz, 2.1, 1.5);
    }
    for (let k = 1; k <= height; k++) this._put(blocks, x0, z0, x, y + k, z, B.OAK_LOG, true);
    this._groundUnder(blocks, x0, z0, x, y, z);
  }

  // Ellipsoid of oak leaves with a dithered edge. Horizontal radius must stay <= 2 from a
  // branch tip at distance 2, or <= 3 at the trunk (MARGIN).
  _blob(blocks, x0, z0, cx, cy, cz, rx, ry) {
    const sm = this.seedTreeShape;
    const R = Math.floor(rx), Y = Math.ceil(ry);
    const yc = Math.floor(cy);
    for (let dy = -Y; dy <= Y; dy++) {
      const ly = yc + dy;
      const ty = (ly + 0.5 - cy) / ry;
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = (dx * dx + dz * dz) / (rx * rx) + ty * ty;
          if (d > 1) continue;
          if (d > 0.62 && hash3(cx + dx, ly, cz + dz, sm) < (d - 0.62) * 1.6) continue;
          this._put(blocks, x0, z0, cx + dx, ly, cz + dz, B.OAK_LEAVES, false);
        }
      }
    }
  }

  // Half-buried mossy boulder (radius <= 2, inside MARGIN).
  _boulder(blocks, x0, z0, x, y, z, rnd) {
    const r = 1.2 + rnd() * 0.75, ry = r * (0.75 + rnd() * 0.2);
    const cy = y + 0.3;
    const sm = this.seedTreeShape ^ 0x3c;
    for (let dy = 0; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ty = (y + dy + 0.5 - cy) / ry;
          const d = (dx * dx + dz * dz) / (r * r) + ty * ty;
          if (d > 1) continue;
          const id = hash3(x + dx, y + dy, z + dz, sm) < 0.62 ? B.MOSSY_COBBLESTONE : B.COBBLESTONE;
          this._put(blocks, x0, z0, x + dx, y + dy, z + dz, id, true);
        }
      }
    }
  }

  // ---- Ground plants -----------------------------------------------------------------------
  _plants(blocks, x0, z0) {
    const cb = this.cols, sp = this.seedPlant;
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = (lx + PAD) + (lz + PAD) * RW;
        const y = cb.h[i];
        if (y + 1 >= HEIGHT) continue;
        const col = lx | (lz << 4);
        const ground = blocks[col | (y << 8)];
        if (blocks[col | ((y + 1) << 8)] !== B.AIR) continue;
        const x = x0 + lx, z = z0 + lz;
        const r = hash2(x, z, sp);
        const b = cb.biome[i];
        let id = 0;
        if (ground === B.GRASS) {
          const v = cb.veg[i];
          // Flowers grow in patches; each patch leans to one species.
          const patch = this.nPatch.noise2(x / 17 + 40.5, z / 17 - 12.25);
          const flowery = b === PLAINS ? 0.45 : b === FOREST || b === BIRCH_FOREST ? 0.55 : 2;
          if (patch > flowery && r < 0.26) {
            const kind = hash2(Math.floor(x / 11), Math.floor(z / 11), sp ^ 0x51);
            const pick = r < 0.05 ? (kind + 0.5) % 1 : kind;
            id = pick < 0.4 ? B.POPPY : pick < 0.78 ? B.DANDELION : B.CORNFLOWER;
          } else {
            let grass = 0, fern = 0;
            switch (b) {
              case PLAINS: grass = 0.22 + 0.2 * smoothstep(-0.6, 0.6, v); break;
              case FOREST: grass = 0.16; fern = 0.035; break;
              case BIRCH_FOREST: grass = 0.2; fern = 0.02; break;
              case TAIGA: grass = 0.08; fern = 0.16; break;
              case MOUNTAINS: grass = 0.12; fern = 0.02; break;
              case BEACH: case STONY_SHORE: grass = 0.03; break;
              default: grass = 0.1; break;
            }
            if (r < fern) id = B.FERN;
            else if (r < fern + grass) id = B.TALL_GRASS;
          }
        } else if (ground === B.SAND && (b === DESERT && r < 0.012 || b === BADLANDS && r < 0.02)) {
          // Keep dead bushes off cactus sides.
          const t = cb.tree;
          if (!t[i - 1] && !t[i + 1] && !t[i - RW] && !t[i + RW]) id = B.DEAD_BUSH;
        } else if (ground === B.DIRT && b === TAIGA && r < 0.1) {
          id = B.FERN;
        }
        if (id) blocks[col | ((y + 1) << 8)] = id;
      }
    }
  }

  // ---- Spawn -------------------------------------------------------------------------------
  // Feet position on dry, flat, grassy land near the origin. Prefers open plains (the title
  // screen orbits a camera just above the spawn), then plains/forest, then any grassy biome.
  findSpawn() {
    const good = [PLAINS, FOREST, BIRCH_FOREST];
    const ok = [PLAINS, FOREST, BIRCH_FOREST, TAIGA, SNOWY_TAIGA, SNOWY_TUNDRA];
    const cache = new Map();
    const tryPass = (allowed, maxR, open) => {
      for (let r = 0; r <= maxR; r += 8) {
        const n = r === 0 ? 1 : Math.max(8, Math.round(r * Math.PI / 6));
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
          const s = this._spawnCandidate(x, z, allowed, open, cache);
          if (s) return s;
        }
      }
      return null;
    };
    const s = tryPass([PLAINS], 384, true) || tryPass(good, 1024, false) || tryPass(ok, 2048, false) ||
      tryPass(null, 4096, false);
    if (s) return s;
    const h = this.heightAt(0, 0);
    return { x: 0.5, y: Math.max(h, WATER_TOP) + 1, z: 0.5 };
  }

  _spawnCandidate(x, z, allowed, open, cache) {
    const c = this._point(x, z);
    const h = c.h[0], b = c.biome[0];
    if (h < SEA + 2 || h > SEA + 40) return null;
    if (allowed && !allowed.includes(b)) return null;
    if (!allowed && (b === DESERT || b === SNOWY_PEAKS || b >= OCEAN && b <= FROZEN_RIVER)) return null;
    // Flat surroundings, no water nearby.
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dz) continue;
        const hn = this.heightAt(x + dx, z + dz);
        if (Math.abs(hn - h) > 1 || hn < SEA) return null;
      }
    }
    // Check the real generated chunk: grass underfoot, open air for the player, no tree trunk.
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const key = cx + ',' + cz;
    let entry = cache.get(key);
    if (!entry) {
      const { blocks } = this.generateChunk(cx, cz);
      entry = { blocks, trees: this.cols.tree.slice() };
      cache.set(key, entry);
    }
    const blocks = entry.blocks;
    if (open) {
      // No trees within 4 columns (their canopies would crowd the player and the title camera).
      const lx = (x & 15) + PAD, lz = (z & 15) + PAD;
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          const t = entry.trees[(lx + dx) + (lz + dz) * RW];
          if (t && t !== TREE_CACTUS && t !== TREE_BOULDER) return null;
        }
      }
    }
    const col = (x & 15) | ((z & 15) << 4);
    const g = blocks[col | (h << 8)];
    if (g !== B.GRASS && g !== B.SNOWY_GRASS) return null;
    for (let y = h + 1; y <= h + 3 && y < HEIGHT; y++) {
      const id = blocks[col | (y << 8)];
      if (id !== B.AIR && id !== B.TALL_GRASS && id !== B.FERN && id !== B.POPPY && id !== B.DANDELION && id !== B.CORNFLOWER) return null;
    }
    return { x: x + 0.5, y: h + 1, z: z + 0.5 };
  }
}
