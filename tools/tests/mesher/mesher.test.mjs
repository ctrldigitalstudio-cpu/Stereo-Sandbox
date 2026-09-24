// Correctness tests for src/mesher.js.  Run: node tools/tests/mesher/mesher.test.mjs
import { meshChunk, lightAt, decodeVertex } from '../../../src/mesher.js';
import { packVertex, FACES, FLAG_WAVE_LEAVES, FLAG_WAVE_PLANT, FLAG_UNDERWATER, FLAG_PLANT } from '../../../src/vertex.js';
import { B, OPAQUE, LIGHT_OPACITY, EMIT, NUM_BLOCKS } from '../../../src/blocks.js';
import { WorldGen } from './synth-worldgen.js';
import { mulberry32 } from '../../../src/noise.js';

let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) passes++;
  else { failures++; console.log('FAIL:', msg); }
}
function eq(a, b, msg) { check(a === b, `${msg}: expected ${b}, got ${a}`); }
function section(name) { console.log(`- ${name}`); }

// 3 × 3 chunks around chunk (0, 0); world coords -16..31, centre chunk = 0..15.
function makeWorld(fill = 0) {
  const nb = [];
  for (let i = 0; i < 9; i++) {
    const colors = new Uint8Array(256 * 9);
    for (let c = 0; c < 256; c++) colors.set([10, 20, 30, 40, 50, 60, 70, 80, 90], c * 9);
    nb.push({ blocks: new Uint8Array(32768).fill(fill), colors });
  }
  const set = (x, y, z, id) => {
    if (x < -16 || x > 31 || z < -16 || z > 31 || y < 0 || y > 127) return;
    const dx = Math.floor(x / 16), dz = Math.floor(z / 16);
    nb[(dz + 1) * 3 + dx + 1].blocks[(x & 15) | ((z & 15) << 4) | (y << 8)] = id;
  };
  const get = (x, y, z) => {
    if (y < 0) return B.BEDROCK;
    if (y > 127) return 0;
    const dx = Math.floor(x / 16), dz = Math.floor(z / 16);
    return nb[(dz + 1) * 3 + dx + 1].blocks[(x & 15) | ((z & 15) << 4) | (y << 8)];
  };
  const box = (x0, y0, z0, x1, y1, z1, id) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, y, z, id);
  };
  return { nb, set, get, box };
}

const LAYERS = new Uint16Array(NUM_BLOCKS * 6);
for (let i = 0; i < LAYERS.length; i++) LAYERS[i] = 1000 + i; // distinct layer per block face

function quads(words) {
  const out = [];
  for (let o = 0; o < words.length; o += 16) {
    out.push([0, 1, 2, 3].map((k) => decodeVertex(words, o + k * 4)));
  }
  return out;
}

const N = FACES.map((f) => f.n);
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function sub(a, b) { return [a.x - b.x, a.y - b.y, a.z - b.z]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
// Normal of triangle (a, b, c) with CCW winding.
function triN(a, b, c) { return cross(sub(b, a), sub(c, a)); }

// Axis-aligned quad checks: every vertex on the face plane of its cell, both triangles CCW outward.
function checkCubeQuad(q, lx, y, lz, msg) {
  const f = q[0].normal;
  const n = N[f];
  const axis = n[0] ? 'x' : n[1] ? 'y' : 'z';
  const base = { x: lx * 16, y: y * 16, z: lz * 16 }[axis] + (n[0] + n[1] + n[2] > 0 ? 16 : 0);
  for (const v of q) {
    check(v.normal === f, `${msg}: same normal on all vertices`);
    check(v[axis] === base, `${msg}: vertex ${axis}=${v[axis]} on face plane ${base}`);
  }
  const t1 = triN(q[0], q[1], q[2]), t2 = triN(q[0], q[2], q[3]);
  check(dot(t1, n) > 0 && dot(t2, n) > 0, `${msg}: face ${f} CCW outward (tri1 ${t1}, tri2 ${t2})`);
  check(Math.abs(dot(t1, n)) === Math.hypot(...t1), `${msg}: triangle normal parallel to face normal`);
}

// Find quads by predicate.
const find = (qs, pred) => qs.filter(pred);

// ---------------------------------------------------------------------------------------------
section('packing round-trip');
{
  const rnd = mulberry32(7);
  const w = new Uint32Array(4);
  for (let t = 0; t < 2000; t++) {
    const f = {
      x: (rnd() * 257) | 0, y: (rnd() * 2049) | 0, z: (rnd() * 257) | 0, u: (rnd() * 17) | 0, v: (rnd() * 17) | 0,
      layer: (rnd() * 65536) | 0, normal: (rnd() * 6) | 0, ao: (rnd() * 4) | 0, sky: (rnd() * 256) | 0,
      block: (rnd() * 256) | 0, flags: (rnd() * 16) | 0, r: (rnd() * 256) | 0, g: (rnd() * 256) | 0, b: (rnd() * 256) | 0,
    };
    packVertex(w, 0, f.x, f.y, f.z, f.u, f.v, f.layer, f.normal, f.ao, f.sky, f.block, f.flags, f.r, f.g, f.b);
    const d = decodeVertex(w, 0);
    for (const k in f) if (d[k] !== f[k]) { check(false, `round-trip ${k}: ${f[k]} -> ${d[k]}`); break; }
  }
  passes++;
}

// ---------------------------------------------------------------------------------------------
section('face culling');
{
  const w = makeWorld();
  w.set(8, 64, 8, B.STONE);
  const m = meshChunk(w.nb, LAYERS);
  eq(m.opaqueQuads, 6, 'single stone quads');
  eq(m.waterQuads, 0, 'single stone water quads');
  eq(m.opaque.length, 6 * 16, 'opaque words');
  eq(m.minY, 64, 'minY'); eq(m.maxY, 65, 'maxY');
  const qs = quads(m.opaque);
  const normals = qs.map((q) => q[0].normal).sort().join();
  eq(normals, '0,1,2,3,4,5', 'one quad per face');
  for (const q of qs) {
    checkCubeQuad(q, 8, 64, 8, 'single stone');
    for (const v of q) {
      // The cell under the block is shaded (14): its bottom face averages 14,15,15,15 -> 251.
      const sky = v.normal === 3 ? 251 : 255;
      check(v.sky === sky && v.block === 0 && v.ao === 3, `open-air stone vertex light/ao (face ${v.normal} sky ${v.sky} ao ${v.ao})`);
      eq(v.layer, LAYERS[B.STONE * 6 + v.normal], 'stone layer per face');
      eq(v.flags, 0, 'stone flags');
      check(v.r === 255 && v.g === 255 && v.b === 255, 'stone untinted');
      check((v.u === 0 || v.u === 16) && (v.v === 0 || v.v === 16), 'full-face uv');
    }
  }
  // Texture orientation: side faces have v = 0 at the top edge.
  for (const q of qs) for (const v of q) if (q[0].normal !== 2 && q[0].normal !== 3) check((v.v === 0) === (v.y === 65 * 16), 'side face v=0 at top');

  w.set(9, 64, 8, B.STONE);
  eq(meshChunk(w.nb, LAYERS).opaqueQuads, 10, 'two adjacent stones');

  const l = makeWorld();
  l.set(8, 64, 8, B.OAK_LEAVES); l.set(9, 64, 8, B.OAK_LEAVES);
  eq(meshChunk(l.nb, LAYERS).opaqueQuads, 10, 'leaves-leaves internal faces culled');
  l.set(9, 64, 8, B.BIRCH_LEAVES);
  eq(meshChunk(l.nb, LAYERS).opaqueQuads, 12, 'different leaves keep both faces');
  l.set(9, 64, 8, B.STONE);
  eq(meshChunk(l.nb, LAYERS).opaqueQuads, 11, 'leaves next to stone: leaf face hidden, stone face shown');

  const g = makeWorld();
  g.set(8, 64, 8, B.GLASS); g.set(8, 65, 8, B.GLASS);
  eq(meshChunk(g.nb, LAYERS).opaqueQuads, 10, 'glass-glass culled');

  // Culling across chunk borders (x = 15 | 16 and z = 0 | -1).
  const c = makeWorld();
  c.set(15, 64, 0, B.STONE); c.set(16, 64, 0, B.STONE); c.set(15, 64, -1, B.STONE);
  eq(meshChunk(c.nb, LAYERS).opaqueQuads, 4, 'faces toward neighbour chunks culled');

  // y = 0: bottom face hidden. y = 127: top face visible and fully sky lit.
  const y = makeWorld();
  y.set(3, 0, 3, B.BEDROCK);
  y.set(5, 127, 5, B.STONE);
  const my = meshChunk(y.nb, LAYERS);
  const qy = quads(my.opaque);
  eq(my.opaqueQuads, 5 + 6, 'bedrock at y=0 has no bottom face; y=127 block has all 6');
  eq(my.maxY, 128, 'maxY at world top');
  eq(my.minY, 0, 'minY at bedrock');
  const topQ = find(qy, (q) => q[0].normal === 2 && q[0].y === 128 * 16);
  eq(topQ.length, 1, 'top face at y=128');
  check(topQ[0] && topQ[0].every((v) => v.sky === 255), 'y=127 top face sky 255');
}

// ---------------------------------------------------------------------------------------------
section('AO + diagonal flip');
{
  // Inside corner: floor y=63, walls along x=4 and z=4 at y=64. Floor cell (5,63,5) top face.
  const w = makeWorld();
  w.box(0, 63, 0, 10, 63, 10, B.STONE);
  w.box(4, 64, 0, 4, 64, 10, B.STONE);
  w.box(0, 64, 4, 10, 64, 4, B.STONE);
  const m = meshChunk(w.nb, LAYERS);
  const q = find(quads(m.opaque), (q) => q[0].normal === 2 && q[0].y === 64 * 16 && q.every((v) => v.x >= 80 && v.x <= 96 && v.z >= 80 && v.z <= 96))[0];
  check(!!q, 'inside-corner floor quad exists');
  if (q) {
    const at = (x, z) => q.find((v) => v.x === x * 16 && v.z === z * 16);
    eq(at(5, 5).ao, 0, 'corner between two walls AO');
    eq(at(6, 5).ao, 1, 'corner along z-wall AO');
    eq(at(5, 6).ao, 1, 'corner along x-wall AO');
    eq(at(6, 6).ao, 3, 'open corner AO');
    checkCubeQuad(q, 5, 63, 5, 'inside corner');
    // Diagonal goes through the brighter pair: (5,5)+(6,6) = 3 > (6,5)+(5,6) = 2 -> v0 is a 0/3 corner.
    const d = q[0].ao + q[2].ao, e = q[1].ao + q[3].ao;
    check(d >= e, `diagonal through brighter pair (${d} vs ${e})`);
    // Light: corner between walls averages only the 1 open sample.
    const [s] = lightAt(5, 64, 5);
    eq(at(5, 5).sky, s * 17, 'AO-0 corner light = P light only');
  }

  // A single block diagonal to the floor cell -> AO 2 at one corner; the quad must flip.
  const f = makeWorld();
  f.box(0, 63, 0, 10, 63, 10, B.STONE);
  f.set(4, 64, 4, B.STONE);
  const qs = quads(meshChunk(f.nb, LAYERS).opaque);
  const fq = find(qs, (q) => q[0].normal === 2 && q[0].y === 64 * 16 && q.every((v) => v.x >= 80 && v.x <= 96 && v.z >= 80 && v.z <= 96))[0];
  check(!!fq, 'flip quad exists');
  if (fq) {
    const at = (x, z) => fq.find((v) => v.x === x * 16 && v.z === z * 16);
    eq(at(5, 5).ao, 2, 'diagonal-only corner AO');
    check(fq[0].ao + fq[2].ao > fq[1].ao + fq[3].ao, 'emitted diagonal (v0,v2) through the brighter pair');
    check(!(fq[0].x === 80 && fq[0].z === 80), 'flipped: dark corner is not on the diagonal');
    checkCubeQuad(fq, 5, 63, 5, 'flipped quad');
  }
}

// ---------------------------------------------------------------------------------------------
section('light');
{
  const w = makeWorld();
  w.box(-16, 63, -16, 31, 63, 31, B.STONE);          // ground everywhere
  w.box(4, 70, 4, 6, 70, 6, B.STONE);                // 3x3 roof
  meshChunk(w.nb, LAYERS);
  eq(lightAt(8, 64, 12)[0], 15, 'open sky');
  eq(lightAt(5, 69, 5)[0], 13, 'under 3x3 roof centre');
  eq(lightAt(4, 69, 5)[0], 14, 'under 3x3 roof edge');
  eq(lightAt(5, 64, 5)[0], 13, 'ground under roof centre');
  eq(lightAt(5, 71, 5)[0], 15, 'on the roof');
  const m = meshChunk(w.nb, LAYERS);
  const gq = find(quads(m.opaque), (q) => q[0].normal === 2 && q[0].y === 64 * 16 && q.every((v) => v.x >= 80 && v.x <= 96 && v.z >= 80 && v.z <= 96))[0];
  check(gq && gq.every((v) => v.sky >= 13 * 17 && v.sky <= 14 * 17), `ground under roof vertex sky ~14*17 (${gq && gq.map((v) => v.sky)})`);

  // Sealed cave + torch.
  const c = makeWorld();
  c.box(-16, 0, -16, 31, 80, 31, B.STONE);
  c.box(2, 40, 2, 13, 45, 13, B.AIR);
  c.set(8, 40, 8, B.TORCH);
  c.set(3, 50, 3, B.AIR);                             // isolated pocket
  const cm = meshChunk(c.nb, LAYERS);
  eq(lightAt(3, 42, 3)[0], 0, 'sealed cave sky');
  eq(lightAt(3, 50, 3)[0], 0, 'sealed pocket sky');
  eq(lightAt(3, 50, 3)[1], 0, 'sealed pocket block');
  eq(lightAt(8, 40, 8)[1], 14, 'torch cell');
  eq(lightAt(9, 40, 8)[1], 13, 'torch +1');
  eq(lightAt(10, 40, 8)[1], 12, 'torch +2');
  eq(lightAt(8, 42, 8)[1], 12, 'torch up 2');
  eq(lightAt(11, 42, 10)[1], 14 - 3 - 2 - 2, 'torch manhattan 7');
  const torchQ = find(quads(cm.opaque), (q) => q[0].flags & FLAG_PLANT);
  eq(torchQ.length, 5, 'torch on floor: 5 quads (bottom culled)');
  for (const q of torchQ) {
    for (const v of q) {
      eq(v.block, 238, 'torch vertex block light = own cell 14*17');
      eq(v.ao, 3, 'torch ao');
      check(v.x >= 8 * 16 + 7 && v.x <= 8 * 16 + 9 && v.z >= 8 * 16 + 7 && v.z <= 8 * 16 + 9 && v.y >= 640 && v.y <= 650, 'torch box');
      check(v.u >= 7 && v.u <= 9, 'torch u 7..9');
      const f = q[0].normal;
      if (f === 2) check(v.v >= 6 && v.v <= 8, 'torch top v 6..8');
      else if (f === 3) check(v.v >= 14, 'torch bottom v 14..16');
      else check(v.v === (v.y === 650 ? 6 : 16), 'torch side v 6..16');
    }
    checkCubeQuadWinding(q);
  }
  // Floating torch -> 6 quads.
  const ft = makeWorld();
  ft.set(8, 70, 8, B.TORCH);
  eq(meshChunk(ft.nb, LAYERS).opaqueQuads, 6, 'floating torch 6 quads');

  // Glowstone behind glass lights the far side; a stone wall does not pass light.
  const g = makeWorld();
  g.box(-16, 0, -16, 31, 80, 31, B.STONE);
  g.box(2, 40, 8, 12, 40, 8, B.AIR);                 // 1-block tunnel along x
  g.set(2, 40, 8, B.GLOWSTONE); g.set(3, 40, 8, B.GLASS);
  meshChunk(g.nb, LAYERS);
  eq(lightAt(3, 40, 8)[1], 14, 'glass next to glowstone');
  eq(lightAt(4, 40, 8)[1], 13, 'lit through glass');
  eq(lightAt(10, 40, 8)[1], 7, 'tunnel falls 1/block');
  eq(lightAt(4, 40, 9)[1], 0, 'stone stays dark');

  // Water and leaves attenuate the sky column by their opacity.
  const o = makeWorld();
  o.box(-16, 50, -16, 31, 50, 31, B.STONE);
  o.box(-16, 51, -16, 31, 56, 31, B.WATER);
  o.set(8, 80, 8, B.OAK_LEAVES);
  meshChunk(o.nb, LAYERS);
  eq(lightAt(8, 56, 12)[0], 14, 'first water block');
  eq(lightAt(8, 52, 12)[0], 10, 'water depth 5');
  eq(lightAt(8, 79, 8)[0], 14, 'under a leaf');
  eq(lightAt(8, 80, 8)[0], 14, 'leaf cell');
}

function checkCubeQuadWinding(q) {
  const n = N[q[0].normal];
  const t1 = triN(q[0], q[1], q[2]), t2 = triN(q[0], q[2], q[3]);
  check(dot(t1, n) > 0 && dot(t2, n) > 0, `winding face ${q[0].normal}`);
}

// ---------------------------------------------------------------------------------------------
section('plants, tints, flags');
{
  const w = makeWorld();
  w.box(-16, 0, -16, 31, 63, 31, B.GRASS);
  w.set(5, 64, 5, B.TALL_GRASS);
  w.set(0, 64, 0, B.POPPY);
  w.set(15, 64, 15, B.FERN);
  const m = meshChunk(w.nb, LAYERS, 3, -2);
  const qs = quads(m.opaque);
  const plants = find(qs, (q) => q[0].flags & FLAG_PLANT);
  eq(plants.length, 12, '3 plants x 4 quads');
  eq(m.opaqueQuads, 256 + 12, 'grass tops + plants');
  const tall = plants.filter((q) => q.every((v) => v.x >= 5 * 16 - 1 && v.x <= 6 * 16 + 1 && v.z >= 5 * 16 - 1 && v.z <= 6 * 16 + 1));
  eq(tall.length, 4, 'tall grass quads in its cell (+jitter)');
  let dirs = new Set();
  for (const q of tall) {
    for (const v of q) {
      eq(v.normal, 2, 'plant normal index 2');
      const top = v.y === 65 * 16;
      check(top || v.y === 64 * 16, 'plant spans its cell height');
      eq(v.flags, top ? FLAG_PLANT | FLAG_WAVE_PLANT : FLAG_PLANT, 'plant flags');
      eq(v.ao, top ? 3 : 1, 'plant ao');
      eq(v.sky, 255, 'plant own-cell sky');
      check(v.r === 10 && v.g === 20 && v.b === 30, 'tall grass grass tint');
      eq(v.layer, LAYERS[B.TALL_GRASS * 6], 'plant layer');
      eq(v.v, top ? 0 : 16, 'plant v');
    }
    const t = triN(q[0], q[1], q[2]);
    check(t[1] === 0 && Math.abs(t[0]) === Math.abs(t[2]), 'plant plane is vertical + diagonal');
    dirs.add(`${Math.sign(t[0])},${Math.sign(t[2])}`);
  }
  eq(dirs.size, 4, 'both planes x both windings');
  for (const q of plants) for (const v of q) check(v.x >= 0 && v.x <= 256 && v.z >= 0 && v.z <= 256, 'plant inside chunk range');
  const poppy = plants.filter((q) => q.every((v) => v.x <= 20 && v.z <= 20));
  check(poppy.length === 4 && poppy.every((q) => q.every((v) => v.r === 255)), 'poppy untinted');
  // Jitter depends on the chunk position passed in.
  const other = quads(meshChunk(w.nb, LAYERS, 4, -2).opaque).filter((q) => q[0].flags & FLAG_PLANT);
  check(JSON.stringify(other.map((q) => q[0].x)) !== JSON.stringify(plants.map((q) => q[0].x)), 'jitter varies with chunk position');

  // Grass top tint, leaves foliage/birch/spruce tints + waving, underwater flag.
  const t = makeWorld();
  t.set(2, 64, 2, B.OAK_LEAVES); t.set(6, 64, 2, B.BIRCH_LEAVES); t.set(10, 64, 2, B.SPRUCE_LEAVES);
  t.set(2, 64, 8, B.GRASS);
  t.set(8, 64, 12, B.STONE); t.set(9, 64, 12, B.WATER);
  const tq = quads(meshChunk(t.nb, LAYERS).opaque);
  const at = (x, z) => tq.filter((q) => q.every((v) => v.x >= x * 16 && v.x <= x * 16 + 16 && v.z >= z * 16 && v.z <= z * 16 + 16));
  const rgb = (q) => [q[0].r, q[0].g, q[0].b].join();
  check(at(2, 2).length === 6 && at(2, 2).every((q) => rgb(q) === '40,50,60' && q.every((v) => v.flags & FLAG_WAVE_LEAVES)), 'oak leaves foliage tint + wave');
  check(at(6, 2).every((q) => rgb(q) === '128,167,85'), 'birch tint');
  check(at(10, 2).every((q) => rgb(q) === '97,153,97'), 'spruce tint');
  check(at(2, 8).every((q) => rgb(q) === '10,20,30'), 'grass tint on all faces (mask decides)');
  const stoneQ = tq.filter((q) => q.every((v) => v.x >= 128 && v.x <= 144 && v.z >= 192 && v.z <= 208 && v.y >= 1024 && v.y <= 1040) && q[0].layer === LAYERS[B.STONE * 6 + q[0].normal]);
  eq(stoneQ.length, 6, 'stone next to water keeps 6 faces');
  eq(stoneQ.filter((q) => q[0].flags & FLAG_UNDERWATER).length, 1, 'only the face touching water is FLAG_UNDERWATER');
  check(stoneQ.find((q) => q[0].flags & FLAG_UNDERWATER)?.[0].normal === 0, 'underwater face is +X');
}

// ---------------------------------------------------------------------------------------------
section('water + lava');
{
  // A 5x5x3 pool in a stone basin: water only shows its top surface.
  const w = makeWorld();
  w.box(-16, 0, -16, 31, 60, 31, B.STONE);
  w.box(4, 58, 4, 8, 60, 8, B.WATER);
  let m = meshChunk(w.nb, LAYERS);
  eq(m.waterQuads, 25, 'pool: only surface quads');
  let wq = quads(m.water);
  check(wq.every((q) => q[0].normal === 2 && q.every((v) => v.y === 60 * 16 + 14)), 'surface at 14/16');
  check(wq.every((q) => q.every((v) => v.r === 70 && v.g === 80 && v.b === 90)), 'water tint from column colour');
  check(wq.every((q) => q.every((v) => v.layer === LAYERS[B.WATER * 6 + 2])), 'water layer');
  check(wq.every((q) => q.every((v) => v.sky === 255)), 'open water surface fully sky lit');
  eq(m.opaqueQuads, 231 + 25 + 60, 'basin: dry tops + pool floor + pool walls (water never hides stone)');

  // Water column of 2 in air: top + 8 sides + bottom; upper sides clipped with matching texels.
  const c = makeWorld();
  c.set(8, 64, 8, B.WATER); c.set(8, 65, 8, B.WATER);
  m = meshChunk(c.nb, LAYERS);
  eq(m.waterQuads, 10, 'water column quads');
  eq(m.opaqueQuads, 0, 'no opaque quads');
  eq(m.maxY, 66, 'maxY with water');
  wq = quads(m.water);
  const sides = wq.filter((q) => q[0].normal !== 2 && q[0].normal !== 3);
  for (const q of sides) {
    const topY = Math.max(...q.map((v) => v.y));
    const low = Math.min(...q.map((v) => v.y));
    const upper = low === 65 * 16;
    eq(topY - low, upper ? 14 : 16, 'side height');
    for (const v of q) eq(v.v, v.y === topY ? (upper ? 2 : 0) : 16, 'side v follows clip');
    checkCubeQuadWinding(q);
  }
  // Water next to glass/leaves shows a face, next to stone doesn't; top under a ceiling still shows.
  const g = makeWorld();
  g.set(8, 64, 8, B.WATER); g.set(9, 64, 8, B.GLASS); g.set(7, 64, 8, B.STONE);
  g.set(8, 65, 8, B.STONE); g.set(8, 64, 9, B.WATER);
  m = meshChunk(g.nb, LAYERS);
  const a = quads(m.water).filter((q) => q.every((v) => v.x >= 128 && v.x <= 144 && v.z >= 128 && v.z <= 144));
  eq(a.map((q) => q[0].normal).sort().join(), '0,2,3,5', 'water faces: glass(+X) top bottom -Z');
  check(a.find((q) => q[0].normal === 2).every((v) => v.sky > 0), 'water top under a ceiling still lit (own/side light)');

  // Lava: opaque buffer, lava layer, block-lit.
  const l = makeWorld();
  l.box(-16, 0, -16, 31, 20, 31, B.STONE);
  l.box(4, 10, 4, 8, 12, 8, B.AIR);
  l.box(4, 10, 4, 8, 10, 8, B.LAVA);
  m = meshChunk(l.nb, LAYERS);
  eq(m.waterQuads, 0, 'lava not in water buffer');
  const lq = quads(m.opaque).filter((q) => q[0].layer === LAYERS[B.LAVA * 6 + q[0].normal]);
  eq(lq.length, 25, 'lava surface quads');
  check(lq.every((q) => q.every((v) => v.y === 10 * 16 + 14 && v.block === 14 * 17 && v.r === 255)), 'lava surface height, block light, untinted');
}

// ---------------------------------------------------------------------------------------------
const NBS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// Reference light: column pass + Bellman-Ford relaxation over the full 48 x 128 x 48 area.
function referenceLight(w) {
  const X0 = -16, S = 48, H = 128;
  const idx = (x, y, z) => (x - X0) + (z - X0) * S + y * S * S;
  const ids = new Uint8Array(S * S * H), sky = new Uint8Array(S * S * H), blk = new Uint8Array(S * S * H);
  const LOP = (id) => (OPAQUE[id] ? 15 : LIGHT_OPACITY[id]);
  for (let z = X0; z < X0 + S; z++) for (let x = X0; x < X0 + S; x++) {
    let L = 15;
    for (let y = H - 1; y >= 0; y--) {
      const id = w.get(x, y, z), i = idx(x, y, z);
      ids[i] = id;
      L = Math.max(0, L - LOP(id));
      sky[i] = L;
      blk[i] = EMIT[id];
    }
  }
  for (const arr of [sky, blk]) {
    for (let changed = true; changed;) {
      changed = false;
      for (let y = 0; y < H; y++) for (let z = X0; z < X0 + S; z++) for (let x = X0; x < X0 + S; x++) {
        const i = idx(x, y, z), c = LOP(ids[i]);
        let best = arr[i];
        for (const [dx, dy, dz] of NBS) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < X0 || nx >= X0 + S || nz < X0 || nz >= X0 + S || ny < 0) continue;
          const L = ny >= H ? (arr === sky ? 15 : 0) : arr[idx(nx, ny, nz)];
          const v = L - 1 - c;
          if (v > best) best = v;
        }
        if (best > arr[i]) { arr[i] = best; changed = true; }
      }
    }
  }
  return (x, y, z) => [sky[idx(x, y, z)], blk[idx(x, y, z)]];
}

section('flood fill vs brute-force reference (random + generated terrain)');
{
  const rnd = mulberry32(99);
  const scenes = [];
  // Random caves with emitters, water, leaves and glass.
  for (let s = 0; s < 3; s++) {
    const w = makeWorld();
    w.box(-16, 0, -16, 31, 40 + s * 10, 31, B.STONE);
    for (let t = 0; t < 1500; t++) {
      const x = -16 + ((rnd() * 48) | 0), y = 1 + ((rnd() * (50 + s * 10)) | 0), z = -16 + ((rnd() * 48) | 0);
      const r = rnd();
      const id = r < 0.6 ? B.AIR : r < 0.7 ? B.WATER : r < 0.8 ? B.OAK_LEAVES : r < 0.85 ? B.GLASS : r < 0.9 ? B.TORCH : r < 0.93 ? B.GLOWSTONE : r < 0.95 ? B.LAVA : B.ICE;
      const rad = (rnd() * 3) | 0;
      w.box(x - rad, y - rad, z - rad, x + rad, y + rad, z + rad, id === B.TORCH || id === B.GLOWSTONE ? B.AIR : id);
      if (id === B.TORCH || id === B.GLOWSTONE) w.set(x, y, z, id);
    }
    scenes.push([`random ${s}`, w]);
  }
  // Synthetic terrain chunks.
  const gen = new WorldGen(1234);
  for (const [cx, cz] of [[0, 0], [5, -3]]) {
    const w = makeWorld();
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = gen.generateChunk(cx + dx, cz + dz);
      w.nb[(dz + 1) * 3 + dx + 1].blocks.set(c.blocks);
    }
    scenes.push([`synth ${cx},${cz}`, w]);
  }
  for (const [name, w] of scenes) {
    const t0 = performance.now();
    const ref = referenceLight(w);
    const refMs = performance.now() - t0;
    meshChunk(w.nb, LAYERS);
    // Geometry samples cells up to one layer above the highest block; compare exactly those.
    let top = -1;
    for (const c of w.nb) for (let i = 0; i < 32768; i++) if (c.blocks[i] && (i >> 8) > top) top = i >> 8;
    let bad = 0, first = '';
    for (let y = 0; y <= Math.min(127, top + 1); y++) for (let z = -1; z <= 16; z++) for (let x = -1; x <= 16; x++) {
      const a = lightAt(x, y, z), b = ref(x, y, z);
      if (a[0] !== b[0] || a[1] !== b[1]) { if (!bad) first = `(${x},${y},${z}) got ${a} want ${b}`; bad++; }
    }
    check(bad === 0, `${name}: ${bad} light mismatches ${first}`);
    if (!bad) console.log(`    ${name}: light matches reference for y 0..${top + 1} (${(refMs / 1000).toFixed(1)} s brute force)`);
  }
}

// ---------------------------------------------------------------------------------------------
section('geometry invariants on generated terrain (winding, planes, bounds)');
{
  const gen = new WorldGen(777);
  for (const [cx, cz] of [[0, 0], [2, 7], [-4, 1]]) {
    const nb = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(gen.generateChunk(cx + dx, cz + dz));
    const m = meshChunk(nb, LAYERS, cx, cz);
    let flipped = 0, bad = 0, badFlip = 0;
    const fluidLayer = (q) => q[0].layer === LAYERS[B.WATER * 6 + q[0].normal] || q[0].layer === LAYERS[B.LAVA * 6 + q[0].normal];
    for (const buf of [m.opaque, m.water]) {
      for (const q of quads(buf)) {
        for (const v of q) if (v.y < m.minY * 16 || v.y > m.maxY * 16) bad++;
        if (q[0].flags & FLAG_PLANT && q[0].normal === 2 && q.some((v) => v.flags & FLAG_WAVE_PLANT)) continue; // cross plants
        const n = N[q[0].normal];
        const t1 = triN(q[0], q[1], q[2]), t2 = triN(q[0], q[2], q[3]);
        if (!(dot(t1, n) > 0 && dot(t2, n) > 0)) bad++;
        const axis = n[0] ? 'x' : n[1] ? 'y' : 'z';
        if (!q.every((v) => v[axis] === q[0][axis])) bad++;
        // Emitted diagonal (v0, v2) must be the brighter pair: AO first, light as tie-break.
        const lum = (v) => v.sky + v.block;
        const a02 = q[0].ao + q[2].ao, a13 = q[1].ao + q[3].ao;
        if (!(a02 > a13 || (a02 === a13 && lum(q[0]) + lum(q[2]) >= lum(q[1]) + lum(q[3])))) badFlip++;
        // Unflipped cube quads start at texel corner (0, 0); flipped ones at corner 1.
        if (!(q[0].flags & FLAG_PLANT) && !fluidLayer(q) && (q[0].u !== 0 || q[0].v !== 0)) flipped++;
      }
    }
    eq(bad, 0, `chunk ${cx},${cz}: winding/plane/bounds violations`);
    eq(badFlip, 0, `chunk ${cx},${cz}: quads whose diagonal is not the brighter pair`);
    check(flipped > 0, `chunk ${cx},${cz}: some quads are flipped (${flipped})`);
    console.log(`    chunk ${cx},${cz}: ${m.opaqueQuads} opaque + ${m.waterQuads} water quads, y ${m.minY}..${m.maxY}, ${flipped} flipped`);
  }
}

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
