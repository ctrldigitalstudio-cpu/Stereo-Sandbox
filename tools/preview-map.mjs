#!/usr/bin/env node
// Terrain previews for tuning src/worldgen.js by eye (PNG, written with a tiny zlib encoder).
//
//   node tools/preview-map.mjs [--seed 12345] [--size 1024] [--center 0,0] [--scale 1] [--zoom 1]
//        [--mode full|height|slice] [--y 30] [--out tools/out/map.png] [--stats]
//        [--section] [--section-z Z] [--section-width 512] [--section-out tools/out/section.png]
//
// Modes (1 px per block unless --scale):
//   full    real chunks: top blocks with biome tints (grass/leaves/water), trees and plants, flowers
//           as coloured dots, hillshading from the top-block height map, water shaded by depth,
//           cave mouths darkened. ~1.3 ms per chunk, so 1024^2 takes ~10 s.
//   height  heightAt/biomeAt only: biome colours + hillshading, fast enough for whole continents
//           (--scale 8 renders 8 blocks per pixel; the origin is marked red). Default when --scale > 1.
//   slice   horizontal cut at --y through real chunks: caves (dark), ores, lava, stone.
// --zoom N upscales the image (nearest) for inspecting details. --stats prints the biome mix and
// the spawn point. --section adds an x-y cross-section at --section-z (2 px per block) showing
// terrain layers, caves, ores, water and lava, with a dotted sea-level line.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WorldGen, BIOMES, WATER_TOP } from '../src/worldgen.js';
import { B, HEIGHT, SEA } from '../src/blocks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);

const seed = Number(opt('seed', '12345'));
const size = Number(opt('size', '1024'));
const scale = Math.max(1, Number(opt('scale', '1')) | 0);
const [centerX, centerZ] = opt('center', '0,0').split(',').map(Number);
const mode = opt('mode', scale > 1 ? 'height' : 'full');
const out = path.resolve(root, opt('out', 'tools/out/map.png'));
const zoom = Math.max(1, Number(opt('zoom', '1')) | 0);

// ---- PNG encoder (RGB8, filter 0) -----------------------------------------------------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Nearest-neighbour upscale for inspecting details.
function upscale(img, k) {
  if (k === 1) return img;
  const W = img.W * k, H = img.H * k;
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((x / k | 0) + (y / k | 0) * img.W) * 3, d = (x + y * W) * 3;
      rgb[d] = img.rgb[s]; rgb[d + 1] = img.rgb[s + 1]; rgb[d + 2] = img.rgb[s + 2];
    }
  }
  return { ...img, W, H, rgb };
}

// ---- Block colours (top-down look) ------------------------------------------------------------
const BLOCK_RGB = new Array(256).fill(null);
const setc = (id, r, g, b) => { BLOCK_RGB[id] = [r, g, b]; };
setc(B.STONE, 122, 122, 122); setc(B.DIRT, 121, 85, 58); setc(B.COBBLESTONE, 110, 110, 110);
setc(B.SAND, 219, 206, 160); setc(B.GRAVEL, 134, 127, 124); setc(B.OAK_LOG, 104, 82, 50);
setc(B.BIRCH_LOG, 214, 210, 200); setc(B.SPRUCE_LOG, 74, 54, 32); setc(B.SNOW, 242, 246, 250);
setc(B.SNOWY_GRASS, 238, 242, 248); setc(B.ICE, 156, 188, 238); setc(B.PACKED_ICE, 140, 172, 230);
setc(B.SANDSTONE, 214, 198, 146); setc(B.CACTUS, 72, 128, 44); setc(B.CLAY, 158, 164, 176);
setc(B.BEDROCK, 50, 50, 50); setc(B.LAVA, 234, 110, 20); setc(B.OBSIDIAN, 20, 16, 30);
setc(B.COAL_ORE, 58, 58, 58); setc(B.IRON_ORE, 216, 172, 140); setc(B.GOLD_ORE, 250, 220, 60);
setc(B.DIAMOND_ORE, 90, 230, 230); setc(B.REDSTONE_ORE, 230, 30, 30); setc(B.TERRACOTTA, 160, 90, 60);
setc(B.POPPY, 210, 40, 30); setc(B.DANDELION, 250, 220, 40); setc(B.CORNFLOWER, 80, 110, 230);
setc(B.DEAD_BUSH, 140, 100, 50); setc(B.GLOWSTONE, 250, 220, 140);
setc(B.MOSSY_COBBLESTONE, 96, 118, 84); setc(B.TERRACOTTA, 170, 92, 58);

const PLANTS = new Set([B.TALL_GRASS, B.FERN, B.POPPY, B.DANDELION, B.CORNFLOWER, B.DEAD_BUSH]);
const FLOWERS = new Set([B.POPPY, B.DANDELION, B.CORNFLOWER]);

function blockColor(id, colors, col, out) {
  const o = col * 9;
  switch (id) {
    case B.GRASS: out[0] = colors[o] * 0.78; out[1] = colors[o + 1] * 0.78; out[2] = colors[o + 2] * 0.78; return;
    case B.TALL_GRASS: case B.FERN: out[0] = colors[o] * 0.72; out[1] = colors[o + 1] * 0.72; out[2] = colors[o + 2] * 0.72; return;
    case B.OAK_LEAVES: out[0] = colors[o + 3] * 0.62; out[1] = colors[o + 4] * 0.62; out[2] = colors[o + 5] * 0.62; return;
    case B.BIRCH_LEAVES: out[0] = 128 * 0.66; out[1] = 167 * 0.66; out[2] = 85 * 0.66; return;
    case B.SPRUCE_LEAVES: out[0] = 97 * 0.55; out[1] = 153 * 0.55; out[2] = 97 * 0.55; return;
    case B.WATER: out[0] = colors[o + 6]; out[1] = colors[o + 7]; out[2] = colors[o + 8]; return;
    default: {
      const c = BLOCK_RGB[id] || [255, 0, 255];
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
    }
  }
}

function shade(hmap, w, h, x, z, k) {
  const at = (xx, zz) => hmap[Math.min(w - 1, Math.max(0, xx)) + Math.min(h - 1, Math.max(0, zz)) * w];
  const dx = (at(x + 1, z) - at(x - 1, z)) * 0.5 * k, dz = (at(x, z + 1) - at(x, z - 1)) * 0.5 * k;
  // Light from the north-west, fairly low.
  const nx = -dx, ny = 1, nz = -dz;
  const len = Math.hypot(nx, ny, nz);
  const lx = -0.55, ly = 0.7, lz = -0.45;
  const d = (nx * lx + ny * ly + nz * lz) / len / Math.hypot(lx, ly, lz);
  return 0.35 + 0.8 * Math.max(0, d);
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// ---- Full mode: real chunks ---------------------------------------------------------------
function renderFull(gen) {
  const W = size, H = size;
  const x0 = Math.round(centerX - W / 2), z0 = Math.round(centerZ - H / 2);
  const topId = new Uint8Array(W * H), topY = new Float32Array(W * H), floorY = new Int16Array(W * H);
  const floorId = new Uint8Array(W * H), plantId = new Uint8Array(W * H), caveHole = new Uint8Array(W * H);
  const colorsArr = new Uint8Array(W * H * 9);
  const cx0 = Math.floor(x0 / 16), cz0 = Math.floor(z0 / 16);
  const cx1 = Math.floor((x0 + W - 1) / 16), cz1 = Math.floor((z0 + H - 1) / 16);
  let chunks = 0, ms = 0;
  const times = [];
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const t = performance.now();
      const { blocks, colors } = gen.generateChunk(cx, cz);
      const dt = performance.now() - t;
      ms += dt; times.push(dt); chunks++;
      for (let lz = 0; lz < 16; lz++) {
        const pz = cz * 16 + lz - z0;
        if (pz < 0 || pz >= H) continue;
        for (let lx = 0; lx < 16; lx++) {
          const px = cx * 16 + lx - x0;
          if (px < 0 || px >= W) continue;
          const col = lx | (lz << 4);
          const p = px + pz * W;
          let y = HEIGHT - 1;
          while (y > 0 && blocks[col | (y << 8)] === 0) y--;
          let id = blocks[col | (y << 8)];
          if (PLANTS.has(id)) { plantId[p] = id; y--; id = blocks[col | (y << 8)]; }
          topId[p] = id; topY[p] = y;
          let fy = y;
          if (id === B.WATER || id === B.ICE) {
            while (fy > 0 && (blocks[col | (fy << 8)] === B.WATER || blocks[col | (fy << 8)] === B.ICE)) fy--;
            floorId[p] = blocks[col | (fy << 8)];
          }
          floorY[p] = fy;
          // Cave mouth: surface column carved below the expected terrain height.
          const hh = gen.heightAt(cx * 16 + lx, cz * 16 + lz);
          if (id === B.AIR || (y < hh - 1 && id !== B.WATER && hh >= WATER_TOP)) caveHole[p] = 1;
          for (let k = 0; k < 9; k++) colorsArr[p * 9 + k] = colors[col * 9 + k];
        }
      }
    }
  }
  times.sort((a, b) => a - b);
  console.log(`generated ${chunks} chunks in ${ms.toFixed(0)} ms: mean ${(ms / chunks).toFixed(2)} ms, median ${times[chunks >> 1].toFixed(2)}, p95 ${times[Math.floor(chunks * 0.95)].toFixed(2)}, max ${times[chunks - 1].toFixed(2)}`);

  const rgb = Buffer.alloc(W * H * 3);
  const c = [0, 0, 0], f = [0, 0, 0];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const p = x + z * W;
      const id = topId[p];
      if (id === B.WATER || id === B.ICE) {
        blockColor(B.WATER, colorsArr, p, c);
        blockColor(floorId[p], colorsArr, p, f);
        const depth = topY[p] - floorY[p];
        const a = Math.exp(-depth / 5.5);
        const s = shade(floorY, W, H, x, z, 0.8);
        for (let k = 0; k < 3; k++) c[k] = (c[k] * (1 - a) * 0.95 + f[k] * s * a * 0.8);
        if (id === B.ICE) { c[0] = c[0] * 0.3 + 160 * 0.7; c[1] = c[1] * 0.3 + 192 * 0.7; c[2] = c[2] * 0.3 + 236 * 0.7; }
      } else {
        blockColor(id, colorsArr, p, c);
        if (plantId[p] && FLOWERS.has(plantId[p])) blockColor(plantId[p], colorsArr, p, c);
        else if (plantId[p]) { blockColor(plantId[p], colorsArr, p, f); for (let k = 0; k < 3; k++) c[k] = c[k] * 0.6 + f[k] * 0.4; }
        const s = shade(topY, W, H, x, z, 1);
        for (let k = 0; k < 3; k++) c[k] *= s;
        if (caveHole[p]) { c[0] *= 0.25; c[1] *= 0.25; c[2] *= 0.25; }
      }
      rgb[p * 3] = clampByte(c[0]); rgb[p * 3 + 1] = clampByte(c[1]); rgb[p * 3 + 2] = clampByte(c[2]);
    }
  }
  return { W, H, rgb };
}

// ---- Slice mode: horizontal cut at --y through real chunks (caves, ores, lava) ------------------
function renderSlice(gen) {
  const W = size, H = size, Y = Number(opt('y', '30'));
  const x0 = Math.round(centerX - W / 2), z0 = Math.round(centerZ - H / 2);
  const rgb = Buffer.alloc(W * H * 3);
  const c = [0, 0, 0];
  let air = 0, solid = 0;
  for (let cz = Math.floor(z0 / 16); cz <= Math.floor((z0 + H - 1) / 16); cz++) {
    for (let cx = Math.floor(x0 / 16); cx <= Math.floor((x0 + W - 1) / 16); cx++) {
      const { blocks, colors } = gen.generateChunk(cx, cz);
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const px = cx * 16 + lx - x0, pz = cz * 16 + lz - z0;
        if (px < 0 || pz < 0 || px >= W || pz >= H) continue;
        const col = lx | (lz << 4);
        const id = blocks[col | (Y << 8)];
        if (id === 0) { c[0] = 20; c[1] = 18; c[2] = 34; air++; } else { blockColor(id, colors, col, c); solid++; }
        const p = (px + pz * W) * 3;
        rgb[p] = clampByte(c[0]); rgb[p + 1] = clampByte(c[1]); rgb[p + 2] = clampByte(c[2]);
      }
    }
  }
  console.log(`slice y=${Y}: ${(air / (air + solid) * 100).toFixed(1)}% air`);
  return { W, H, rgb };
}

// ---- Height mode: heightAt / biomeAt only ---------------------------------------------------
function renderHeight(gen) {
  const W = size, H = size;
  const hmap = new Float32Array(W * H), bmap = new Uint8Array(W * H);
  const t = performance.now();
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const wx = Math.round(centerX + (x - W / 2) * scale), wz = Math.round(centerZ + (z - H / 2) * scale);
      const info = gen.columnInfo(wx, wz);
      hmap[x + z * W] = info.height;
      bmap[x + z * W] = info.biome;
    }
  }
  console.log(`sampled ${W * H} columns in ${(performance.now() - t).toFixed(0)} ms`);
  const rgb = Buffer.alloc(W * H * 3);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const p = x + z * W;
      const h = hmap[p];
      let c = BIOMES[bmap[p]].color.slice();
      if (h < WATER_TOP) {
        const depth = WATER_TOP - h;
        const a = Math.exp(-depth / 8);
        c = [30 + 60 * a, 70 + 90 * a, 150 + 60 * a];
      } else {
        const s = shade(hmap, W, H, x, z, 1 / scale);
        c = c.map((v) => v * s);
      }
      rgb[p * 3] = clampByte(c[0]); rgb[p * 3 + 1] = clampByte(c[1]); rgb[p * 3 + 2] = clampByte(c[2]);
    }
  }
  // Mark the origin.
  const ox = Math.round(W / 2 - centerX / scale), oz = Math.round(H / 2 - centerZ / scale);
  for (let d = -4; d <= 4; d++) {
    for (const [x, z] of [[ox + d, oz], [ox, oz + d]]) {
      if (x >= 0 && x < W && z >= 0 && z < H) { const p = (x + z * W) * 3; rgb[p] = 255; rgb[p + 1] = 0; rgb[p + 2] = 0; }
    }
  }
  return { W, H, rgb, hmap, bmap };
}

// ---- Cross-section (x-y slice) ---------------------------------------------------------------
function renderSection(gen) {
  const sw = Number(opt('section-width', '512'));
  const sz = Number(opt('section-z', String(centerZ)));
  const px = 2;
  const x0 = Math.round(centerX - sw / 2);
  const W = sw * px, H = HEIGHT * px;
  const rgb = Buffer.alloc(W * H * 3);
  const cz = Math.floor(sz / 16), lz = ((sz % 16) + 16) % 16;
  const cache = new Map();
  for (let x = 0; x < sw; x++) {
    const wx = x0 + x;
    const cx = Math.floor(wx / 16), lx = ((wx % 16) + 16) % 16;
    if (!cache.has(cx)) cache.set(cx, gen.generateChunk(cx, cz));
    const { blocks, colors } = cache.get(cx);
    const col = lx | (lz << 4);
    let surface = HEIGHT - 1;
    while (surface > 0 && blocks[col | (surface << 8)] === 0) surface--;
    for (let y = 0; y < HEIGHT; y++) {
      const id = blocks[col | (y << 8)];
      let c;
      if (id === 0) c = y > surface ? [170, 205, 240] : [20, 18, 34];
      else { const t = [0, 0, 0]; blockColor(id, colors, col, t); c = t; }
      for (let dy = 0; dy < px; dy++) {
        for (let dx = 0; dx < px; dx++) {
          const p = ((x * px + dx) + ((HEIGHT - 1 - y) * px + dy) * W) * 3;
          rgb[p] = clampByte(c[0]); rgb[p + 1] = clampByte(c[1]); rgb[p + 2] = clampByte(c[2]);
        }
      }
    }
  }
  // Sea level guide.
  for (let x = 0; x < W; x += 6) {
    const p = (x + (HEIGHT - 1 - SEA) * px * W) * 3 + (px - 1) * W * 3;
    rgb[p] = 255; rgb[p + 1] = 255; rgb[p + 2] = 255;
  }
  return { W, H, rgb, z: sz };
}

// ---- Main -------------------------------------------------------------------------------------
const gen = new WorldGen(seed);
fs.mkdirSync(path.dirname(out), { recursive: true });
const img = upscale(mode === 'height' ? renderHeight(gen) : mode === 'slice' ? renderSlice(gen) : renderFull(gen), zoom);
fs.writeFileSync(out, encodePNG(img.W, img.H, img.rgb));
console.log(`wrote ${out} (${img.W}x${img.H}, seed ${seed}, ${mode}, ${scale} block/px, centre ${centerX},${centerZ})`);

if (flag('stats')) {
  const counts = new Map();
  const n = 200;
  const span = size * scale;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const b = gen.biomeAt(Math.round(centerX + (i / n - 0.5) * span), Math.round(centerZ + (j / n - 0.5) * span));
      counts.set(b, (counts.get(b) || 0) + 1);
    }
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1]).map(([b, c]) => `${BIOMES[b].name} ${(c / (n * n) * 100).toFixed(1)}%`);
  console.log('biomes:', rows.join(', '));
  const sp = gen.findSpawn();
  console.log('spawn:', JSON.stringify(sp), BIOMES[gen.biomeAt(sp.x, sp.z)].name);
}

if (flag('section')) {
  const s = renderSection(gen);
  const sout = path.resolve(root, opt('section-out', 'tools/out/section.png'));
  fs.writeFileSync(sout, encodePNG(s.W, s.H, s.rgb));
  console.log(`wrote ${sout} (${s.W}x${s.H}, z = ${s.z})`);
}
