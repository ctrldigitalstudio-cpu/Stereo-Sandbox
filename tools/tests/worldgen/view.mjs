// Quick CPU "voxel space" perspective view of generated terrain (height field of top blocks,
// trees included) for judging the landscape without the WebGL renderer.
//   node tools/tests/worldgen/view.mjs --seed 12345 --pos x,y,z --yaw deg --pitch deg --out file
import fs from 'node:fs';
import { WorldGen } from '../../../src/worldgen.js';
import { B, HEIGHT } from '../../../src/blocks.js';
import { encodePNG } from './png.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const seed = Number(opt('seed', '12345'));
const gen = new WorldGen(seed);
let [px, py, pz] = opt('pos', 'spawn').split(',').map(Number);
if (Number.isNaN(px)) { const s = gen.findSpawn(); px = s.x; py = s.y + 25; pz = s.z; }
if (opt('above', null) !== null) {
  let top = 0;
  for (let dz = -6; dz <= 6; dz += 3) for (let dx = -6; dx <= 6; dx += 3) top = Math.max(top, gen.heightAt(px + dx, pz + dz));
  py = top + Number(opt('above', '20'));
}
const yaw = Number(opt('yaw', '0')) * Math.PI / 180;     // 0 = looking -Z, positive = left
const pitch = Number(opt('pitch', '-10')) * Math.PI / 180;
const W = Number(opt('w', '960')), H = Number(opt('h', '540'));
const R = Number(opt('range', '600'));
const out = opt('out', 'tools/out/wg-view.png');

// Build maps of the area.
const N = Math.ceil(R / 16) * 2 + 1;
const cx0 = Math.floor(px / 16) - (N >> 1), cz0 = Math.floor(pz / 16) - (N >> 1);
const MW = N * 16;
const topY = new Float32Array(MW * MW), col = new Float32Array(MW * MW * 3), water = new Uint8Array(MW * MW), floorY = new Float32Array(MW * MW);
const RGB = {};
const S = (id, r, g, b) => { RGB[id] = [r, g, b]; };
S(B.STONE, 125, 125, 125); S(B.DIRT, 121, 85, 58); S(B.SAND, 219, 206, 160); S(B.GRAVEL, 134, 127, 124);
S(B.SNOW, 240, 244, 250); S(B.SNOWY_GRASS, 236, 240, 246); S(B.ICE, 170, 200, 245); S(B.SANDSTONE, 214, 198, 146);
S(B.CACTUS, 72, 128, 44); S(B.CLAY, 158, 164, 176); S(B.OAK_LOG, 104, 82, 50); S(B.BIRCH_LOG, 214, 210, 200);
S(B.SPRUCE_LOG, 74, 54, 32); S(B.COAL_ORE, 60, 60, 60); S(B.IRON_ORE, 170, 150, 130); S(B.LAVA, 255, 120, 20);
S(B.POPPY, 210, 40, 30); S(B.DANDELION, 250, 220, 40); S(B.CORNFLOWER, 80, 110, 230); S(B.DEAD_BUSH, 140, 100, 50);
S(B.GOLD_ORE, 200, 180, 90); S(B.PACKED_ICE, 150, 180, 235); S(B.BEDROCK, 50, 50, 50);
S(B.MOSSY_COBBLESTONE, 96, 118, 84); S(B.COBBLESTONE, 110, 110, 110); S(B.TERRACOTTA, 170, 92, 58);
const t0 = performance.now();
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const { blocks, colors } = gen.generateChunk(cx0 + i, cz0 + j);
  for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
    const c = lx | (lz << 4), m = (i * 16 + lx) + (j * 16 + lz) * MW;
    let y = HEIGHT - 1;
    while (y > 0 && blocks[c | (y << 8)] === 0) y--;
    let id = blocks[c | (y << 8)];
    let tint = null;
    if (id === B.TALL_GRASS || id === B.FERN) { y--; id = blocks[c | (y << 8)]; }
    let rgb;
    if (id === B.GRASS) rgb = [colors[c * 9] * 0.8, colors[c * 9 + 1] * 0.8, colors[c * 9 + 2] * 0.8];
    else if (id === B.OAK_LEAVES) rgb = [colors[c * 9 + 3] * 0.62, colors[c * 9 + 4] * 0.62, colors[c * 9 + 5] * 0.62];
    else if (id === B.BIRCH_LEAVES) rgb = [128 * 0.7, 167 * 0.7, 85 * 0.7];
    else if (id === B.SPRUCE_LEAVES) rgb = [97 * 0.55, 153 * 0.55, 97 * 0.55];
    else if (id === B.WATER) {
      water[m] = 1;
      let fy = y; while (fy > 0 && blocks[c | (fy << 8)] === B.WATER) fy--;
      floorY[m] = fy;
      rgb = [colors[c * 9 + 6], colors[c * 9 + 7], colors[c * 9 + 8]];
    } else rgb = RGB[id] || [255, 0, 255];
    topY[m] = y + 1;
    col[m * 3] = rgb[0]; col[m * 3 + 1] = rgb[1]; col[m * 3 + 2] = rgb[2];
  }
}
console.log(`generated ${N * N} chunks in ${(performance.now() - t0).toFixed(0)} ms`);
// Lighting: sun from the south-west, 35 degrees.
const L = [-0.55, 0.6, 0.58]; const ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
const at = (x, z) => topY[Math.max(0, Math.min(MW - 1, x)) + Math.max(0, Math.min(MW - 1, z)) * MW];
const lit = new Float32Array(MW * MW * 3);
for (let z = 0; z < MW; z++) for (let x = 0; x < MW; x++) {
  const m = x + z * MW;
  const dx = at(x + 1, z) - at(x - 1, z), dz = at(x, z + 1) - at(x, z - 1);
  let nx = -dx * 0.5, ny = 1, nz = -dz * 0.5; const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
  let d = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
  // Cheap shadow: march toward the sun over the height field.
  let sh = 1;
  for (let s = 1; s < 60; s += 1.5) {
    const sx = Math.round(x + L[0] / Math.hypot(L[0], L[2]) * s), sz = Math.round(z + L[2] / Math.hypot(L[0], L[2]) * s);
    if (at(sx, sz) > topY[m] + s * L[1] / Math.hypot(L[0], L[2])) { sh = 0; break; }
  }
  const k = water[m] ? 0.9 : (0.42 + 0.9 * d * sh);
  for (let q = 0; q < 3; q++) lit[m * 3 + q] = col[m * 3 + q] * k / 255;
}
// Render.
const rgb = new Uint8Array(W * H * 3);
const sky = (v) => [0.55 + 0.25 * v, 0.72 + 0.15 * v, 0.95];
const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
const rx = Math.cos(yaw), rz = -Math.sin(yaw);
const focal = (W / 2) / Math.tan(40 * Math.PI / 180);
const horizon = H / 2 + Math.tan(pitch) * focal;
for (let sx = 0; sx < W; sx++) {
  const u = (sx - W / 2) / focal;
  const dx = fx + rx * u, dz = fz + rz * u;
  let ybuf = H;
  for (let y = 0; y < H; y++) { const s = sky(Math.min(1, Math.max(0, (horizon - y) / H * 2))); const p = (sx + y * W) * 3; rgb[p] = s[0] * 255; rgb[p + 1] = s[1] * 255; rgb[p + 2] = s[2] * 255; }
  let dist = 1;
  while (dist < R && ybuf > 0) {
    const wx = px + dx * dist, wz = pz + dz * dist;
    const mx = Math.floor(wx) - cx0 * 16, mz = Math.floor(wz) - cz0 * 16;
    if (mx < 0 || mz < 0 || mx >= MW || mz >= MW) break;
    const m = mx + mz * MW;
    const hgt = water[m] ? topY[m] - 0.1 : topY[m];
    const sy = Math.floor(horizon + (py - hgt) / dist * focal);
    if (sy < ybuf) {
      let c = [lit[m * 3], lit[m * 3 + 1], lit[m * 3 + 2]];
      const fog = 1 - Math.exp(-dist / 420);
      const s = sky(0.1);
      c = c.map((v, q) => v * (1 - fog) + s[q] * fog);
      for (let y = Math.max(0, sy); y < ybuf; y++) { const p = (sx + y * W) * 3; rgb[p] = Math.min(255, c[0] * 255); rgb[p + 1] = Math.min(255, c[1] * 255); rgb[p + 2] = Math.min(255, c[2] * 255); }
      ybuf = Math.max(0, sy);
    }
    dist += dist < 60 ? 0.25 : dist * 0.004;
  }
}
fs.writeFileSync(out, encodePNG(W, H, rgb));
console.log(`wrote ${out} pos ${px.toFixed(1)},${py.toFixed(1)},${pz.toFixed(1)}`);
