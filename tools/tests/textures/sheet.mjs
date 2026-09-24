#!/usr/bin/env node
// Builds the texture set and writes PNG contact sheets to tools/out/:
//   textures-albedo.png   level-0 albedo, 8x, biome tint applied, checkerboard behind alpha
//   textures-raw.png      level-0 albedo exactly as stored (greyscale tinted layers)
//   textures-normal.png   normal maps
//   textures-spec.png     r = smoothness, g = metalness, b = emissive
//   textures-mask.png     tint mask (white = tinted)
//   textures-lit.png      albedo lit by a grazing top-left light through the normal map
//   textures-tiled.png    every texture tiled 3x3 at 4x (seams, repetition, read at a glance)
//   textures-mips.png     all 5 mip levels per layer, each scaled to 32 px
// Also validates the TextureSet shape and prints the layer -> name mapping and build timings.
//
//   node tools/tests/textures/sheet.mjs [--only name,name] [--scale 8]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildTextures, textureNames, defaultTint } from '../../../src/textures.js';
import { BLOCKS, NUM_BLOCKS, faceTextures, SHAPE_NONE } from '../../../src/blocks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(root, 'tools/out');
fs.mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

// ---- PNG encoder ----------------------------------------------------------------------------
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(root, file)} (${w}x${h})`);
}

// ---- 3x5 digit font for layer labels ----------------------------------------------------------
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
function label(img, W, x0, y0, n, s = 2) {
  const str = String(n);
  for (let k = 0; k < str.length; k++) {
    const g = DIGITS[+str[k]];
    for (let y = -1; y < 6; y++) for (let x = -1; x < 4; x++) {
      const on = x >= 0 && x < 3 && y >= 0 && y < 5 && g[y * 3 + x] === '1';
      for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) {
        const px = x0 + (k * 4 + x) * s + sx, py = y0 + y * s + sy;
        const o = (px + py * W) * 4;
        const v = on ? 255 : 0;
        img[o] = v; img[o + 1] = on ? 220 : 0; img[o + 2] = on ? 120 : 0; img[o + 3] = 255;
      }
    }
  }
}

// ---- Build + validate -------------------------------------------------------------------------
const t0 = performance.now();
const tex = buildTextures();
const tCold = performance.now() - t0;
const warm = [];
for (let k = 0; k < 10; k++) { const a = performance.now(); buildTextures(); warm.push(performance.now() - a); }
warm.sort((a, b) => a - b);
console.log(`buildTextures: cold ${tCold.toFixed(1)} ms, warm median ${warm[5].toFixed(1)} ms, min ${warm[0].toFixed(1)} ms`);

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
const names = textureNames();
if (tex.layers !== names.length) fail('layer count');
if (tex.size !== 16 || tex.levels !== 5) fail('size/levels');
if (tex.missing.length) fail('missing recipes: ' + tex.missing.join(', '));
for (const n of names) if (!(n in tex.layerOf)) fail('no layer for ' + n);
for (const n of ['water', 'lava']) if (!(n in tex.layerOf)) fail('no layer for ' + n);
for (const d of BLOCKS) {
  if (d.shape === SHAPE_NONE) continue;
  faceTextures(d).forEach((n, f) => { if (tex.faceLayers[d.id * 6 + f] !== tex.layerOf[n]) fail(`faceLayers ${d.name} face ${f}`); });
}
if (!(tex.faceLayers instanceof Uint16Array) || tex.faceLayers.length !== NUM_BLOCKS * 6) fail('faceLayers type/length');
for (let l = 0, s = 16; l < 5; l++, s >>= 1) {
  for (const k of ['albedo', 'normal', 'spec']) {
    if (!(tex[k][l] instanceof Uint8Array) || tex[k][l].length !== tex.layers * s * s * 4) fail(`${k}[${l}] length`);
  }
}
// Determinism
const again = buildTextures();
for (let l = 0; l < 5; l++) for (const k of ['albedo', 'normal', 'spec']) {
  if (Buffer.compare(Buffer.from(tex[k][l]), Buffer.from(again[k][l])) !== 0) fail(`non-deterministic ${k}[${l}]`);
}
// Torch stick must sit exactly on the texels the mesher maps (u 7..9, v 6..16)
{
  const L = tex.layerOf.torch;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const a = tex.albedo[0][(L * 256 + x + y * 16) * 4 + 3];
    const want = x >= 7 && x <= 8 && y >= 6 ? 255 : 0;
    if (a !== want) fail(`torch alpha at ${x},${y} = ${a}`);
  }
}
// Stats per layer: coverage, hole fraction, mean luminance of tinted pixels, normal z
const lines = [];
for (let L = 0; L < tex.layers; L++) {
  let cov = 0, tintLum = 0, tintN = 0, nz = 0, em = 0, sm = 0;
  for (let i = 0; i < 256; i++) {
    const o = (L * 256 + i) * 4;
    const a = tex.albedo[0][o + 3];
    if (a >= 128) cov++;
    if (tex.spec[0][o + 3] > 128 && a >= 128) {
      tintLum += (0.2126 * tex.albedo[0][o] + 0.7152 * tex.albedo[0][o + 1] + 0.0722 * tex.albedo[0][o + 2]) / 255; tintN++;
    }
    nz += tex.normal[0][o + 2] / 255 * 2 - 1;
    em += tex.spec[0][o + 2] / 255;
    sm += tex.spec[0][o] / 255;
  }
  // Coverage of each mip (alpha >= 0.5)
  const mipCov = [];
  for (let l = 1, s = 8; l < 5; l++, s >>= 1) {
    let c = 0;
    for (let i = 0; i < s * s; i++) if (tex.albedo[l][(L * s * s + i) * 4 + 3] >= 128) c++;
    mipCov.push((c / (s * s)).toFixed(2));
  }
  lines.push(`${String(L).padStart(2)} ${tex.names[L].padEnd(20)} cut=${tex.cutout[L]} cov=${(cov / 256).toFixed(2)} mips=[${mipCov.join(',')}]` +
    `${tintN ? ` tintLum=${(tintLum / tintN).toFixed(2)}` : ''} nz=${(nz / 256).toFixed(3)} sm=${(sm / 256).toFixed(2)}${em > 0 ? ` em=${(em / 256).toFixed(2)}` : ''}`);
}
console.log(lines.join('\n'));

// ---- Sheets -------------------------------------------------------------------------------------
const only = opt('only', null)?.split(',');
const layerList = only ? only.map((n) => tex.layerOf[n]).filter((l) => l !== undefined) : [...Array(tex.layers).keys()];
const SC = Number(opt('scale', only ? 16 : 8));
const COLS = only ? Math.min(layerList.length, 6) : 8;
const GAP = 6;
const tintOfLayer = new Map();
for (const d of BLOCKS) {
  if (d.shape === SHAPE_NONE) continue;
  for (let f = 0; f < 6; f++) if (!tintOfLayer.has(tex.faceLayers[d.id * 6 + f])) tintOfLayer.set(tex.faceLayers[d.id * 6 + f], defaultTint(d.id));
}

const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toSrgb = (l) => { l = Math.max(0, Math.min(1, l)); return Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255); };

function sheet(file, cell, pixel, tile = 1, level = 0) {
  const s = 16 >> level;
  const cw = s * cell * tile;
  const rows = Math.ceil(layerList.length / COLS);
  const W = COLS * (cw + GAP) + GAP, H = rows * (cw + GAP + 12) + GAP;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { img[i * 4] = 30; img[i * 4 + 1] = 32; img[i * 4 + 2] = 38; img[i * 4 + 3] = 255; }
  layerList.forEach((L, k) => {
    const gx = GAP + (k % COLS) * (cw + GAP), gy = GAP + 12 + Math.floor(k / COLS) * (cw + GAP + 12);
    label(img, W, gx, gy - 12, L);
    for (let y = 0; y < cw; y++) for (let x = 0; x < cw; x++) {
      const tx = Math.floor(x / cell) % s, ty = Math.floor(y / cell) % s;
      const c = pixel(L, tx, ty, level, x, y);
      const o = ((gx + x) + (gy + y) * W) * 4;
      const chk = ((x >> 3) + (y >> 3)) & 1 ? 150 : 110;
      const a = c[3] / 255;
      img[o] = c[0] * a + chk * (1 - a); img[o + 1] = c[1] * a + chk * (1 - a); img[o + 2] = c[2] * a + chk * (1 - a);
    }
  });
  writePNG(path.join(outDir, file), W, H, img);
}

const at = (arr, L, x, y, level = 0) => {
  const s = 16 >> level;
  const o = (L * s * s + x + y * s) * 4;
  return [arr[level][o], arr[level][o + 1], arr[level][o + 2], arr[level][o + 3]];
};
const tinted = (L, x, y, level = 0) => {
  const c = at(tex.albedo, L, x, y, level), sp = at(tex.spec, L, x, y, level);
  const t = tintOfLayer.get(L) || [255, 255, 255];
  const m = sp[3] / 255;
  return [c[0] * (1 - m + m * t[0] / 255), c[1] * (1 - m + m * t[1] / 255), c[2] * (1 - m + m * t[2] / 255), c[3]];
};

sheet('textures-albedo.png', SC, (L, x, y) => tinted(L, x, y));
sheet('textures-raw.png', SC, (L, x, y) => at(tex.albedo, L, x, y));
sheet('textures-normal.png', SC, (L, x, y) => { const c = at(tex.normal, L, x, y); return [c[0], c[1], c[2], 255]; });
sheet('textures-spec.png', SC, (L, x, y) => { const c = at(tex.spec, L, x, y); return [c[0], c[1], c[2], 255]; });
sheet('textures-mask.png', SC, (L, x, y) => { const c = at(tex.spec, L, x, y); return [c[3], c[3], c[3], 255]; });
const Ld = (() => { const v = [-0.55, -0.55, 0.45]; const l = Math.hypot(...v); return v.map((a) => a / l); })();
sheet('textures-lit.png', SC, (L, x, y) => {
  const c = tinted(L, x, y), n = at(tex.normal, L, x, y), sp = at(tex.spec, L, x, y);
  const nx = n[0] / 127.5 - 1, ny = n[1] / 127.5 - 1, nz = n[2] / 127.5 - 1;
  const d = Math.max(0, nx * Ld[0] + ny * Ld[1] + nz * Ld[2]);
  const e = sp[2] / 255;
  const k = 0.18 + 1.25 * d + e * 1.2;
  return [toSrgb(toLin(c[0]) * k), toSrgb(toLin(c[1]) * k), toSrgb(toLin(c[2]) * k), c[3]];
});
sheet('textures-tiled.png', Math.max(2, SC >> 1), (L, x, y) => tinted(L, x, y), 3);
// Mips: each level magnified to 32 px, laid out side by side per layer
{
  const cell = 32, cw = cell * 5 + 4 * 2;
  const cols = 4, rows = Math.ceil(layerList.length / cols);
  const W = cols * (cw + GAP * 2) + GAP, H = rows * (cell + GAP + 12) + GAP;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { img[i * 4] = 30; img[i * 4 + 1] = 32; img[i * 4 + 2] = 38; img[i * 4 + 3] = 255; }
  layerList.forEach((L, k) => {
    const gx = GAP + (k % cols) * (cw + GAP * 2), gy = GAP + 12 + Math.floor(k / cols) * (cell + GAP + 12);
    label(img, W, gx, gy - 12, L);
    for (let level = 0; level < 5; level++) {
      const s = 16 >> level;
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const c = tinted(L, Math.floor(x * s / cell), Math.floor(y * s / cell), level);
        const o = ((gx + level * (cell + 2) + x) + (gy + y) * W) * 4;
        const chk = ((x >> 2) + (y >> 2)) & 1 ? 150 : 110;
        const a = c[3] / 255;
        img[o] = c[0] * a + chk * (1 - a); img[o + 1] = c[1] * a + chk * (1 - a); img[o + 2] = c[2] * a + chk * (1 - a);
      }
    }
  });
  writePNG(path.join(outDir, 'textures-mips.png'), W, H, img);
}
if (process.exitCode) console.log('VALIDATION FAILED'); else console.log('validation OK');
