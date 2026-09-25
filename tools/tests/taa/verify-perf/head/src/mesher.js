// Chunk lighting + meshing (runs in the world worker). Sky and block light are flood-filled over
// the chunk ± 15 blocks (light never travels further), then the centre chunk is turned into packed
// quads with Minecraft-style smooth lighting and ambient occlusion. See SPEC.md "Meshing + lighting".
//
// All scratch memory is module-level and reused between calls; only the returned typed arrays are
// fresh (they get transferred to the main thread).

import {
  CHUNK, HEIGHT, B, NUM_BLOCKS, OPAQUE, SHAPE, LIGHT_OPACITY, EMIT, CULL_SAME, TINT, WAVE,
  SHAPE_CUBE, SHAPE_CROSS, SHAPE_TORCH, SHAPE_FLUID,
  TINT_GRASS, TINT_FOLIAGE, TINT_BIRCH, TINT_SPRUCE, TINT_WATER,
} from './blocks.js';
import { FACES, QUAD_UV, WORDS_PER_VERTEX, FLAG_WAVE_LEAVES, FLAG_WAVE_PLANT, FLAG_UNDERWATER, FLAG_PLANT } from './vertex.js';

// ---------------------------------------------------------------------------------------------
// Region layout. The lit region is the chunk ± PAD blocks (46 × 46 columns) surrounded by a
// one-cell wall ring, plus a wall layer at y = -1 and an open-sky layer above the top, so the
// flood fill and the AO sampling never need bounds checks.
// ---------------------------------------------------------------------------------------------
export const REGION_PAD = 15;                 // blocks of neighbour context lit around the chunk
const RW = CHUNK + 2 * REGION_PAD + 2;        // 48 cells per row, wall ring included
const LAYER = RW * RW;                        // cells per y layer
const OX = REGION_PAD + 1;                    // region x/z of local x/z = 0
const MAX_LAYERS = HEIGHT + 2;                // y = -1 (wall) .. 128 (open sky)
const WORDS_PER_QUAD = WORDS_PER_VERTEX * 4;

// Sentinel ids (unused by the registry): walls stop everything; SKY is open air that light can't
// flood into (it is only ever sampled, as full sky light).
const WALL = 255;
const SKY = 254;
if (NUM_BLOCKS > SKY) throw new Error('mesher: block ids collide with region sentinels');

// Local lookup tables: OPQ drives culling + AO, LOP is the light cost of entering a cell. Opaque
// cells cost 15, so the flood rule `L - 1 - LOP` can never enter them and needs no opaque test.
const OPQ = new Uint8Array(256);
const LOP = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  OPQ[id] = OPAQUE[id];
  LOP[id] = OPAQUE[id] ? 15 : Math.min(15, LIGHT_OPACITY[id]);
}
OPQ[WALL] = 1; LOP[WALL] = 15;
OPQ[SKY] = 0; LOP[SKY] = 15;

const WATER = B.WATER;
const WHITE = 0xffffff;
const TINT_BIRCH_RGB = 128 | (167 << 8) | (85 << 16);
const TINT_SPRUCE_RGB = 97 | (153 << 8) | (97 << 16);

// Region scratch (≈ 300 KB each), allocated once.
const ids = new Uint8Array(LAYER * MAX_LAYERS);
const sky = new Uint8Array(LAYER * MAX_LAYERS);
const blk = new Uint8Array(LAYER * MAX_LAYERS);
const colTop = new Int16Array(LAYER);         // lowest y from which the column pass is full sky (15)
const colLow = new Int16Array(LAYER);         // lowest y where the column pass still has light ≥ 2
for (let y = 0; y < MAX_LAYERS; y++) {
  const o = y * LAYER;
  for (let j = 0; j < RW; j++) {
    ids[o + j] = WALL; ids[o + (RW - 1) * RW + j] = WALL;
    ids[o + j * RW] = WALL; ids[o + j * RW + RW - 1] = WALL;
  }
}
ids.fill(WALL, 0, LAYER);

// Flood-fill ring buffer. Seeding pushes each cell at most once, so it must exceed the region size.
let queue = new Int32Array(1 << 19);
let emitList = new Int32Array(4096);
let emitCount = 0;

// Output scratch; grown on demand, sliced into fresh arrays at the end of each call.
const opaqueOut = { buf: new Uint32Array(1 << 16), n: 0 };
const waterOut = { buf: new Uint32Array(1 << 14), n: 0 };
let minY16 = 0, maxY16 = 0;
let lastRY = 0;

// Per-corner values for the quad being emitted.
const cAO = new Int32Array(4);
const cSky = new Int32Array(4);
const cBlk = new Int32Array(4);

// ---------------------------------------------------------------------------------------------
// Face tables (index f * 4 + k for face f, corner k in QUAD_UV order).
// ---------------------------------------------------------------------------------------------
const delta = (v) => v[0] + v[2] * RW + v[1] * LAYER;
const NOFF = new Int32Array(6);               // region offset of the face-adjacent cell
const CUX = new Uint8Array(24), CUY = new Uint8Array(24), CUZ = new Uint8Array(24); // unit corner
const D1 = new Int32Array(24), D2 = new Int32Array(24), D3 = new Int32Array(24);   // AO samples
const QU = new Uint8Array(4), QV = new Uint8Array(4);
for (let k = 0; k < 4; k++) { QU[k] = QUAD_UV[k][0]; QV[k] = QUAD_UV[k][1]; }
for (let f = 0; f < 6; f++) {
  const { n, base, U, V } = FACES[f];
  NOFF[f] = delta(n);
  for (let k = 0; k < 4; k++) {
    const cu = QU[k], cv = QV[k], j = f * 4 + k;
    CUX[j] = base[0] + cu * U[0] + cv * V[0];
    CUY[j] = base[1] + cu * U[1] + cv * V[1];
    CUZ[j] = base[2] + cu * U[2] + cv * V[2];
    // Step from the face-adjacent cell toward this corner along U and V.
    const s1 = U.map((a) => (cu ? a : -a)), s2 = V.map((a) => (cv ? a : -a));
    D1[j] = delta(s1);
    D2[j] = delta(s2);
    D3[j] = delta([s1[0] + s2[0], s1[1] + s2[1], s1[2] + s2[2]]);
  }
}

// Average of `n` light samples summing to `sum`, scaled from 0..15 to 0..255: LSCALE[n * 64 + sum].
const LSCALE = new Uint8Array(5 * 64);
for (let n = 1; n <= 4; n++) for (let s = 0; s <= 15 * n; s++) LSCALE[n * 64 + s] = Math.round((s * 17) / n);

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

// neighbors: 9 entries, index (dz + 1) * 3 + (dx + 1); each { blocks, colors }.
// cx, cz (optional) seed the per-position plant jitter so it doesn't repeat every chunk.
export function meshChunk(neighbors, faceLayers, cx = 0, cz = 0) {
  let top = -1, centerTop = -1;
  for (let n = 0; n < 9; n++) {
    const t = chunkTop(neighbors[n].blocks);
    if (t > top) top = t;
    if (n === 4) centerTop = t;
  }
  // One air layer above the highest block is enough: nothing samples higher, and any light path
  // that would go higher can be flattened into that all-air layer at no extra cost.
  const RY = Math.min(HEIGHT, Math.max(1, top + 2));

  lastRY = RY;
  buildRegion(neighbors, RY);
  lightSky();
  lightBlocks();

  opaqueOut.n = 0;
  waterOut.n = 0;
  minY16 = 1 << 30;
  maxY16 = -1;
  const layers = faceLayers || EMPTY_LAYERS;
  emitGeometry(neighbors[4].colors, layers, centerTop, cx, cz);

  const any = maxY16 >= 0;
  return {
    opaque: opaqueOut.buf.slice(0, opaqueOut.n * WORDS_PER_QUAD),
    water: waterOut.buf.slice(0, waterOut.n * WORDS_PER_QUAD),
    opaqueQuads: opaqueOut.n,
    waterQuads: waterOut.n,
    minY: any ? Math.floor(minY16 / 16) : 0,
    maxY: any ? Math.ceil(maxY16 / 16) : 0,
  };
}

// [sky, block] light (0..15) at a centre-chunk-local cell from the most recent meshChunk call.
// The region covers local x/z -15..30 and y up to one air layer above the highest block of the 9
// chunks; above that it reports open sky (block light there is never needed). For tests/debugging.
export function lightAt(lx, y, lz) {
  if (y < 0) return [0, 0];
  if (y >= lastRY) return [15, 0];
  const i = (lx + OX) + (lz + OX) * RW + (y + 1) * LAYER;
  return [sky[i], blk[i]];
}

// Unpack one vertex (4 words at offset o) back into its fields. Inverse of packVertex.
export function decodeVertex(words, o = 0, out = {}) {
  const w0 = words[o], w1 = words[o + 1], w2 = words[o + 2], w3 = words[o + 3];
  out.x = w0 & 511; out.u = (w0 >>> 9) & 127;
  out.y = (w0 >>> 16) & 4095; out.flags = w0 >>> 28;
  out.z = w1 & 511; out.v = (w1 >>> 9) & 127; out.layer = w1 >>> 16;
  out.normal = w2 & 7; out.ao = (w2 >>> 3) & 3; out.sky = (w2 >>> 8) & 255; out.block = (w2 >>> 16) & 255;
  out.r = w3 & 255; out.g = (w3 >>> 8) & 255; out.b = (w3 >>> 16) & 255;
  return out;
}

const EMPTY_LAYERS = new Uint16Array(256 * 6);

// ---------------------------------------------------------------------------------------------
// Region build + column sky pass (one sweep per column, top down)
// ---------------------------------------------------------------------------------------------

function chunkTop(blocks) {
  for (let y = HEIGHT - 1; y >= 0; y--) {
    const s = y << 8;
    for (let j = s + 255; j >= s; j--) if (blocks[j] !== 0) return y;
  }
  return -1;
}

function buildRegion(nb, RY) {
  blk.fill(0, 0, (RY + 2) * LAYER);
  emitCount = 0;
  const skyLayer = (RY + 1) * LAYER;
  for (let rz = 1; rz < RW - 1; rz++) {
    const lz = rz - OX;
    const row = lz < 0 ? 0 : lz >= CHUNK ? 6 : 3;
    const bz = (lz & 15) << 4;
    for (let rx = 1; rx < RW - 1; rx++) {
      const lx = rx - OX;
      const src = nb[row + (lx < 0 ? 0 : lx >= CHUNK ? 2 : 1)].blocks;
      const c = rx + rz * RW;
      let s = (lx & 15) | bz | ((RY - 1) << 8);
      let r = c + RY * LAYER;
      let L = 15, topY = RY, lowY = RY;
      for (let y = RY - 1; y >= 0; y--, s -= 256, r -= LAYER) {
        const id = src[s];
        ids[r] = id;
        if (L !== 0) {
          // Straight down, sky light only loses each block's opacity.
          L -= LOP[id];
          if (L <= 0) L = 0;
          else {
            if (L === 15) topY = y;
            if (L > 1) lowY = y;
          }
        }
        sky[r] = L;
        const e = EMIT[id];
        if (e !== 0) {
          blk[r] = e;
          if (emitCount === emitList.length) {
            const g = new Int32Array(emitList.length * 2);
            g.set(emitList);
            emitList = g;
          }
          emitList[emitCount++] = r;
        }
      }
      colTop[c] = topY;
      colLow[c] = lowY;
      ids[skyLayer + c] = SKY;
      sky[skyLayer + c] = 15;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Flood fill
// ---------------------------------------------------------------------------------------------

// Seed only cells whose column-pass light can still raise a horizontal neighbour. Downward and
// upward neighbours are already consistent after the column pass (light only drops going down),
// and a column is full sky from colTop up, so only y in [own colLow, max neighbour colTop) matter.
function lightSky() {
  const q = queue;
  let tail = 0;
  for (let rz = 1; rz < RW - 1; rz++) {
    for (let rx = 1, c = 1 + rz * RW; rx < RW - 1; rx++, c++) {
      let hi = colTop[c - 1];
      const t1 = colTop[c + 1], t2 = colTop[c - RW], t3 = colTop[c + RW];
      if (t1 > hi) hi = t1;
      if (t2 > hi) hi = t2;
      if (t3 > hi) hi = t3;
      for (let y = colLow[c], r = c + (y + 1) * LAYER; y < hi; y++, r += LAYER) {
        const L = sky[r] - 1;
        if (L - LOP[ids[r - 1]] > sky[r - 1] || L - LOP[ids[r + 1]] > sky[r + 1] ||
            L - LOP[ids[r - RW]] > sky[r - RW] || L - LOP[ids[r + RW]] > sky[r + RW]) {
          q[tail++] = r;
        }
      }
    }
  }
  propagate(sky, tail);
}

function lightBlocks() {
  const q = queue;
  for (let j = 0; j < emitCount; j++) q[j] = emitList[j];
  propagate(blk, emitCount);
}

// Breadth-first flood from queue[0..count): a neighbour gets L - 1 - opacity(neighbour).
function propagate(light, count) {
  let q = queue, mask = q.length - 1, head = 0, tail = count;
  while (head !== tail) {
    if (((tail - head) & mask) > mask - 8) {
      // Rare: grow the ring buffer, unrolling it to start at 0.
      const n = (tail - head) & mask;
      const g = new Int32Array(q.length * 2);
      for (let j = 0; j < n; j++) g[j] = q[(head + j) & mask];
      queue = q = g; mask = q.length - 1; head = 0; tail = n;
    }
    const i = q[head];
    head = (head + 1) & mask;
    const L = light[i] - 1;
    if (L < 1) continue;
    let n = i + 1, v = L - LOP[ids[n]];
    if (v > light[n]) { light[n] = v; if (v > 1) { q[tail] = n; tail = (tail + 1) & mask; } }
    n = i - 1; v = L - LOP[ids[n]];
    if (v > light[n]) { light[n] = v; if (v > 1) { q[tail] = n; tail = (tail + 1) & mask; } }
    n = i + RW; v = L - LOP[ids[n]];
    if (v > light[n]) { light[n] = v; if (v > 1) { q[tail] = n; tail = (tail + 1) & mask; } }
    n = i - RW; v = L - LOP[ids[n]];
    if (v > light[n]) { light[n] = v; if (v > 1) { q[tail] = n; tail = (tail + 1) & mask; } }
    n = i + LAYER; v = L - LOP[ids[n]];
    if (v > light[n]) { light[n] = v; if (v > 1) { q[tail] = n; tail = (tail + 1) & mask; } }
    n = i - LAYER; v = L - LOP[ids[n]];
    if (v > light[n]) { light[n] = v; if (v > 1) { q[tail] = n; tail = (tail + 1) & mask; } }
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

function tintOf(id, colors, col) {
  let o;
  switch (TINT[id]) {
    case TINT_GRASS: o = col * 9; break;
    case TINT_FOLIAGE: o = col * 9 + 3; break;
    case TINT_WATER: o = col * 9 + 6; break;
    case TINT_BIRCH: return TINT_BIRCH_RGB;
    case TINT_SPRUCE: return TINT_SPRUCE_RGB;
    default: return WHITE;
  }
  return colors[o] | (colors[o + 1] << 8) | (colors[o + 2] << 16);
}

function emitGeometry(colors, layers, centerTop, cx, cz) {
  for (let y = 0; y <= centerTop; y++) {
    const y16 = y << 4;
    for (let lz = 0; lz < CHUNK; lz++) {
      let i = OX + (lz + OX) * RW + (y + 1) * LAYER;
      const z16 = lz << 4;
      for (let lx = 0; lx < CHUNK; lx++, i++) {
        const id = ids[i];
        if (id === 0) continue;
        const shape = SHAPE[id];
        if (shape === SHAPE_CUBE) {
          const cull = CULL_SAME[id];
          const wave = WAVE[id] === 1 ? FLAG_WAVE_LEAVES : 0;
          let tint = -1;
          for (let f = 0; f < 6; f++) {
            const n = i + NOFF[f];
            const nid = ids[n];
            if (OPQ[nid] === 1 || (nid === id && cull === 1)) continue;
            if (tint < 0) tint = tintOf(id, colors, lx | (lz << 4));
            sampleCorners(n, f, i);
            putQuad(opaqueOut, f, lx << 4, y16, z16, 16, 16, 16, 0, 0, 16, 16,
              layers[id * 6 + f], nid === WATER ? wave | FLAG_UNDERWATER : wave, tint);
          }
        } else if (shape === SHAPE_CROSS) {
          emitPlant(i, id, lx, y, lz, colors, layers, cx, cz);
        } else if (shape === SHAPE_FLUID) {
          emitFluid(i, id, lx, y16, lz, colors, layers);
        } else if (shape === SHAPE_TORCH) {
          emitTorch(i, id, lx, y16, z16, layers);
        }
      }
    }
  }
}

// Smooth light + AO for the 4 corners of face f, sampled in the plane of cell P (the face-adjacent
// cell). `self` is the emitting cell, used when P itself is opaque (fluid top under a ceiling).
function sampleCorners(P, f, self) {
  const pOpaque = OPQ[ids[P]] === 1;
  const ps = pOpaque ? 0 : sky[P], pb = pOpaque ? 0 : blk[P], pn = pOpaque ? 0 : 1;
  for (let k = 0, j = f * 4; k < 4; k++, j++) {
    const a = P + D1[j], b = P + D2[j];
    const o1 = OPQ[ids[a]], o2 = OPQ[ids[b]];
    let s = ps, l = pb, n = pn;
    if (o1 === 0) { s += sky[a]; l += blk[a]; n++; }
    if (o2 === 0) { s += sky[b]; l += blk[b]; n++; }
    if (o1 === 1 && o2 === 1) {
      cAO[k] = 0;                       // corner hidden between two walls: skip the diagonal
    } else {
      const c = P + D3[j];
      const o3 = OPQ[ids[c]];
      cAO[k] = 3 - o1 - o2 - o3;
      if (o3 === 0) { s += sky[c]; l += blk[c]; n++; }
    }
    if (n === 0) { s = sky[self]; l = blk[self]; n = 1; }
    cSky[k] = LSCALE[n * 64 + s];
    cBlk[k] = LSCALE[n * 64 + l];
  }
}

// Axis-aligned quad for face f of the box (x0,y0,z0) + (sx,sy,sz) in 1/16 units; texel rect
// u0 + cu*du, v0 + cv*dv. Corner values come from cAO/cSky/cBlk.
function putQuad(out, f, x0, y0, z0, sx, sy, sz, u0, v0, du, dv, layer, flags, tint) {
  if ((out.n + 1) * WORDS_PER_QUAD > out.buf.length) growOut(out);
  const buf = out.buf;
  let o = out.n * WORDS_PER_QUAD;
  out.n++;
  // Put the triangle diagonal through the brighter corner pair (AO first, then light), which
  // keeps AO gradients symmetric. Rotating the corner order by one keeps the CCW winding.
  const a02 = cAO[0] + cAO[2], a13 = cAO[1] + cAO[3];
  const start = a13 > a02 || (a13 === a02 &&
    cSky[1] + cBlk[1] + cSky[3] + cBlk[3] > cSky[0] + cBlk[0] + cSky[2] + cBlk[2]) ? 1 : 0;
  const hi = flags << 12, lay = layer << 16;
  for (let m = 0; m < 4; m++) {
    const k = (m + start) & 3, j = f * 4 + k;
    const x = x0 + CUX[j] * sx, y = y0 + CUY[j] * sy, z = z0 + CUZ[j] * sz;
    buf[o] = (x | ((u0 + QU[k] * du) << 9)) | ((y | hi) << 16);
    buf[o + 1] = (z | ((v0 + QV[k] * dv) << 9)) | lay;
    buf[o + 2] = f | (cAO[k] << 3) | (cSky[k] << 8) | (cBlk[k] << 16);
    buf[o + 3] = tint;
    o += 4;
  }
  if (y0 < minY16) minY16 = y0;
  if (y0 + sy > maxY16) maxY16 = y0 + sy;
}

function growOut(out) {
  const g = new Uint32Array(out.buf.length * 2);
  g.set(out.buf);
  out.buf = g;
}

// Water (water buffer) and lava (opaque buffer): surface at 14/16 unless the same fluid is above;
// faces toward non-fluid, non-opaque cells; the top face whenever the fluid doesn't continue up.
function emitFluid(i, id, lx, y16, lz, colors, layers) {
  const out = id === WATER ? waterOut : opaqueOut;
  const h = ids[i + LAYER] === id ? 16 : 14;
  let tint = -1;
  for (let f = 0; f < 6; f++) {
    const n = i + NOFF[f];
    const nid = ids[n];
    if (nid === id || (f !== 2 && OPQ[nid] === 1)) continue;
    if (tint < 0) tint = tintOf(id, colors, lx | (lz << 4));
    sampleCorners(n, f, i);
    // Side faces are clipped to the surface; their texels follow the clip so nothing squashes.
    const side = f !== 2 && f !== 3;
    putQuad(out, f, lx << 4, y16, lz << 4, 16, h, 16, 0, side ? 16 - h : 0, 16, side ? h : 16, layers[id * 6 + f], 0, tint);
  }
}

// Torch: a 2 × 10 × 2 texel stick, lit by its own cell. Bottom face skipped on solid ground.
function emitTorch(i, id, lx, y16, z16, layers) {
  const s = sky[i] * 17, b = blk[i] * 17;
  for (let k = 0; k < 4; k++) { cAO[k] = 3; cSky[k] = s; cBlk[k] = b; }
  for (let f = 0; f < 6; f++) {
    if (f === 3 && OPQ[ids[i - LAYER]] === 1) continue;
    const v0 = f === 3 ? 14 : 6, dv = f === 2 || f === 3 ? 2 : 10;
    putQuad(opaqueOut, f, (lx << 4) + 7, y16, z16 + 7, 2, 10, 2, 7, v0, 2, dv, layers[id * 6 + f], FLAG_PLANT, WHITE);
  }
}

// Cross plant: two diagonal planes, each emitted with both windings, jittered per position.
function emitPlant(i, id, lx, y, lz, colors, layers, cx, cz) {
  let h = Math.imul(lx + (cx << 4), 0x27d4eb2d) ^ Math.imul(lz + (cz << 4), 0x165667b1) ^ Math.imul(y, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  let jx = ((h & 0xffff) % 7) - 3, jz = ((h >>> 16) % 7) - 3;
  // Stay inside the chunk's 0..256 position range at its borders.
  if (lx === 0 && jx < -2) jx = -2;
  if (lx === CHUNK - 1 && jx > 2) jx = 2;
  if (lz === 0 && jz < -2) jz = -2;
  if (lz === CHUNK - 1 && jz > 2) jz = 2;
  const x0 = (lx << 4) + 2 + jx, x1 = x0 + 12, z0 = (lz << 4) + 2 + jz, z1 = z0 + 12;
  const y16 = y << 4;
  const tint = tintOf(id, colors, lx | (lz << 4));
  const lay = layers[id * 6] << 16;
  const light = (sky[i] * 17) << 8 | (blk[i] * 17) << 16;
  if ((opaqueOut.n + 4) * WORDS_PER_QUAD > opaqueOut.buf.length) growOut(opaqueOut);
  plantQuad(x0, z0, x1, z1, y16, lay, light, tint, false);
  plantQuad(x0, z0, x1, z1, y16, lay, light, tint, true);
  plantQuad(x0, z1, x1, z0, y16, lay, light, tint, false);
  plantQuad(x0, z1, x1, z0, y16, lay, light, tint, true);
  if (y16 < minY16) minY16 = y16;
  if (y16 + 16 > maxY16) maxY16 = y16 + 16;
}

const PLANT_BOTTOM = (FLAG_PLANT << 12) << 16;
const PLANT_TOP = ((FLAG_PLANT | FLAG_WAVE_PLANT) << 12) << 16;
const PLANT_ORDER = [[0, 1, 2, 3], [0, 3, 2, 1]];

function plantQuad(ax, az, bx, bz, y16, lay, light, tint, reverse) {
  const buf = opaqueOut.buf;
  let o = opaqueOut.n * WORDS_PER_QUAD;
  opaqueOut.n++;
  const order = PLANT_ORDER[reverse ? 1 : 0];
  for (let m = 0; m < 4; m++) {
    const k = order[m], cu = QU[k], top = QV[k] === 0;
    buf[o] = ((cu ? bx : ax) | (cu << 13)) | (((y16 + (top ? 16 : 0)) << 16) | (top ? PLANT_TOP : PLANT_BOTTOM));
    buf[o + 1] = ((cu ? bz : az) | ((top ? 0 : 16) << 9)) | lay;
    buf[o + 2] = 2 | ((top ? 3 : 1) << 3) | light;
    buf[o + 3] = tint;
    o += 4;
  }
}
