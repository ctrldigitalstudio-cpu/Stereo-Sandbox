// Node test for ParticleSystem: spawning, physics against a fake world, GPU array layout, expiry.
//   node tools/tests/terrain-render/particles.test.mjs
import assert from 'node:assert/strict';
import { ParticleSystem, PARTICLE_FLOATS, MAX_PARTICLES } from '../../../src/particles.js';
import { buildTextures } from '../../../src/textures.js';
import { B } from '../../../src/blocks.js';

const tex = buildTextures();
// Flat world: solid below y = 10, a torch-like emitter nearby, stone roof over x >= 100.
const world = {
  getBlock(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 10) return B.STONE;
    if (x >= 100 && y === 20) return B.STONE;
    if (x === 3 && y === 10 && z === 0) return B.GLOWSTONE;
    return 0;
  },
  isSolid(x, y, z) { const id = this.getBlock(x, y, z); return id !== 0; },
};

const ps = new ParticleSystem(tex);
assert.equal(ps.count, 0);
ps.update(0.016, world); // gives the system the world for light estimates

// Break a grass block sitting on the ground at (0, 10, 0)
ps.spawnBlockBreak(0, 10, 0, B.GRASS);
assert.ok(ps.count >= 30 && ps.count <= 48, `~40 particles, got ${ps.count}`);
const n0 = ps.count;
// Light estimate: open sky, glowstone 3 blocks away (level 15 - 3 = 12)
assert.equal(ps.light[0], 1, 'open sky');
assert.ok(Math.abs(ps.light[1] - 12 / 15) < 1e-6, `block light ${ps.light[1]}`);
// GPU array filled right away (spawn may happen after update in a frame)
for (let i = 0; i < n0; i++) {
  const o = i * PARTICLE_FLOATS;
  const g = ps.gpu;
  assert.ok(g[o + 3] > 0.02 && g[o + 3] < 0.2, 'size');
  assert.ok(g[o + 4] >= 0 && g[o + 4] <= 0.75 && g[o + 6] === 0.25, 'uv sub-rect of 4 texels');
  assert.equal(g[o + 7], tex.faceLayers[B.GRASS * 6], 'side layer');
  assert.ok(g[o + 8] < 1 && g[o + 9] > g[o + 8], 'grass debris is tinted green');
}

// Simulate: nothing falls through the floor, everything expires by 1.4 s
let minY = Infinity, t = 0, maxCount = n0;
while (t < 1.6) {
  ps.update(1 / 60, world);
  t += 1 / 60;
  for (let i = 0; i < ps.count; i++) minY = Math.min(minY, ps.pos[i * 3 + 1] - ps.size[i] * 0.5);
  maxCount = Math.max(maxCount, ps.count);
  if (t > 0.8) for (let i = 0; i < ps.count; i++) assert.ok(Math.abs(ps.vel[i * 3 + 1]) < 3, 'settled or slow by 0.8 s');
}
assert.ok(minY >= 10 - 1e-6, `particles stay above the ground (min ${minY})`);
assert.equal(ps.count, 0, 'all expired');

// Under a roof: no sky light estimated
ps.spawnBlockBreak(105, 12, 0, B.STONE);
assert.ok(ps.light[0] < 0.5, `roofed sky ${ps.light[0]}`);
ps.clear();

// Explicit light overrides the estimate
ps.spawnBlockBreak(0, 10, 0, B.STONE, [0.25, 0.5]);
assert.equal(ps.light[0], 0.25);
assert.equal(ps.light[1], 0.5);
ps.clear();

// Cutout blocks pick sub-rects with texels in them (torch is mostly transparent)
ps.spawnBlockBreak(0, 10, 0, B.TORCH);
const layer = tex.faceLayers[B.TORCH * 6];
let covered = 0;
for (let i = 0; i < ps.count; i++) {
  const u = Math.round(ps.tex4[i * 4] * 16), v = Math.round(ps.tex4[i * 4 + 1] * 16), w = Math.round(ps.tex4[i * 4 + 2] * 16);
  let n = 0;
  for (let y = v; y < v + w; y++) for (let x = u; x < u + w; x++) if (tex.albedo[0][(layer * 256 + y * 16 + x) * 4 + 3] >= 128) n++;
  if (n >= w * w / 2) covered++;
}
assert.ok(covered / ps.count > 0.95, `torch debris mostly visible (${covered}/${ps.count})`);
ps.clear();

// Splash: water layer, water tint flag, droplets die when they fall back into water
const pool = { getBlock: (x, y) => (y < 10 ? B.WATER : 0), isSolid: () => false };
ps.update(0, pool);
ps.spawnSplash(0, 10, 0);
assert.ok(ps.count > 10);
assert.equal(ps.gpu[11], 1, 'water flag');
assert.equal(ps.gpu[7], tex.layerOf.water);
for (let k = 0; k < 90; k++) ps.update(1 / 60, pool);
assert.equal(ps.count, 0, 'droplets gone after 1.5 s');

// Capacity: spawning beyond MAX_PARTICLES is clamped, not an error
for (let k = 0; k < 80; k++) ps.spawnBlockBreak(k, 10, 0, B.DIRT);
assert.equal(ps.count, MAX_PARTICLES);
ps.update(1 / 60, world);

// Far spawn rebases the gpu origin (float precision far from the world origin)
ps.clear();
ps.spawnBlockBreak(1e6 + 3, 10, -2e6, B.STONE);
assert.deepEqual(ps.origin, [1e6 + 3, 10, -2e6]);
assert.ok(Math.abs(ps.gpu[0]) < 2 && Math.abs(ps.gpu[2]) < 2, 'positions relative to origin');

// No world: update must not throw
const lone = new ParticleSystem(tex);
lone.spawnBlockBreak(0, 0, 0, B.STONE);
lone.update(0.1);
lone.update(0.1, null);
console.log('particles: all tests passed');
