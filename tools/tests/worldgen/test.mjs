// Worldgen correctness + performance tests:
//   node tools/tests/worldgen/test.mjs [--seed N] [--chunks 200]
// 1. Determinism: same chunk from fresh generators and in different generation orders is identical.
// 2. Tree continuity: every tree (from an independent, chunk-free reconstruction of its blocks)
//    appears intact in the stitched chunks, including across chunk borders.
// 3. Invariants: bedrock floor, heightAt matches generated terrain, water only up to WATER_TOP,
//    lava only at y <= 10, block ids valid, colours sane.
// 4. Timing of generateChunk over N chunks (after warm-up).
import { WorldGen, BIOMES, WATER_TOP } from '../../../src/worldgen.js';
import { B, NUM_BLOCKS, HEIGHT, SEA } from '../../../src/blocks.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const seeds = opt('seed', '12345,1,-987654,2024').split(',').map(Number);
const NCH = Number(opt('chunks', '200'));
let failures = 0;
const fail = (msg) => { failures++; if (failures < 30) console.log('FAIL', msg); };

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

for (const seed of seeds) {
  console.log(`--- seed ${seed}`);
  // 1. Determinism across instances and orders.
  const coords = [];
  for (let z = -3; z <= 3; z++) for (let x = -3; x <= 3; x++) coords.push([x * 7 + 2, z * 5 - 1]);
  coords.push([1000, -2000], [-31250, 31250]);
  const g1 = new WorldGen(seed);
  const ref = new Map(coords.map(([x, z]) => [`${x},${z}`, g1.generateChunk(x, z)]));
  const g2 = new WorldGen(seed);
  const shuffled = coords.slice().sort((a, b) => ((a[0] * 31 + a[1] * 17) & 7) - ((b[0] * 31 + b[1] * 17) & 7)).reverse();
  let detOk = true;
  for (const [x, z] of shuffled) {
    const c = g2.generateChunk(x, z);
    const r = ref.get(`${x},${z}`);
    if (!equal(c.blocks, r.blocks) || !equal(c.colors, r.colors)) { detOk = false; fail(`determinism chunk ${x},${z}`); }
  }
  // Interleaving point queries must not disturb chunk generation (shared scratch buffers).
  const g3 = new WorldGen(seed);
  for (const [x, z] of coords) {
    g3.heightAt(x * 16 + 3, z * 16 + 5); g3.biomeAt(x * 3, z * 9); g3.climateAt(x, z);
    const c = g3.generateChunk(x, z);
    if (!equal(c.blocks, ref.get(`${x},${z}`).blocks)) { detOk = false; fail(`determinism with interleaved queries ${x},${z}`); }
  }
  console.log(`determinism: ${detOk ? 'ok' : 'FAILED'} (${coords.length} chunks x 3 generators)`);

  // 2 + 3. Stitch a region and check invariants + trees.
  const gen = new WorldGen(seed);
  const spawn = gen.findSpawn();
  const R = 6; // (2R)^2 chunks around spawn
  const bcx = Math.floor(spawn.x / 16) - R, bcz = Math.floor(spawn.z / 16) - R;
  const S = 2 * R * 16;
  const world = new Uint8Array(S * S * HEIGHT);
  const idxW = (x, y, z) => (x - bcx * 16) + (z - bcz * 16) * S + y * S * S;
  // Generate in a scrambled order.
  const order = [];
  for (let j = 0; j < 2 * R; j++) for (let i = 0; i < 2 * R; i++) order.push([i, j]);
  order.sort((a, b) => ((a[0] * 7919 + a[1] * 104729) % 13) - ((b[0] * 7919 + b[1] * 104729) % 13));
  let badHeight = 0, badWater = 0, badLava = 0, badBedrock = 0, badId = 0, badColor = 0;
  for (const [i, j] of order) {
    const cx = bcx + i, cz = bcz + j;
    const { blocks, colors } = gen.generateChunk(cx, cz);
    if (!(blocks instanceof Uint8Array) || blocks.length !== 16 * 16 * 128) fail('blocks array shape');
    if (!(colors instanceof Uint8Array) || colors.length !== 256 * 9) fail('colors array shape');
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const col = lx | (lz << 4);
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (blocks[col] !== B.BEDROCK) badBedrock++;
      const h = gen.heightAt(wx, wz);
      // The top terrain block must be solid ground unless carved by a cave mouth.
      const top = blocks[col | (h << 8)];
      if (top === 0 || top === B.WATER) { if (top === B.WATER) badHeight++; }
      const above = blocks[col | ((h + 1) << 8)];
      if (h + 1 <= WATER_TOP && above !== 0 && above !== B.WATER && above !== B.ICE && above !== B.PACKED_ICE) badHeight++;
      for (let y = 0; y < HEIGHT; y++) {
        const id = blocks[col | (y << 8)];
        if (id >= NUM_BLOCKS) badId++;
        if (id === B.WATER && y > WATER_TOP) badWater++;
        if (id === B.LAVA && y > 10) badLava++;
        world[idxW(wx, y, wz)] = id;
      }
      const c = colors.subarray(col * 9, col * 9 + 9);
      if (c[1] < 100 || c[8] < 100) badColor++;
    }
  }
  console.log(`invariants: bedrock ${badBedrock}, height mismatch ${badHeight}, water above top ${badWater}, lava above 10 ${badLava}, bad ids ${badId}, odd colours ${badColor}`);
  if (badBedrock || badHeight || badWater || badLava || badId || badColor) fail('invariants');

  // Water must never touch a carved cave cell sideways/below (no floating water walls).
  let wallCells = 0;
  for (let z = bcz * 16 + 1; z < bcz * 16 + S - 1; z++) for (let x = bcx * 16 + 1; x < bcx * 16 + S - 1; x++) {
    for (let y = 1; y < WATER_TOP; y++) {
      if (world[idxW(x, y, z)] !== B.WATER) continue;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
        if (world[idxW(x + dx, y + dy, z + dz)] === 0) wallCells++;
      }
    }
  }
  console.log(`water faces open to air below/beside: ${wallCells}`);
  if (wallCells) fail('water walls');

  // Tree continuity: reconstruct each tree log column and canopy from its trunk in the stitched
  // world: every log column must reach its canopy and every leaf block must connect (6-neighbour
  // flood fill through leaves/logs) to some log within 6 blocks.
  const isLog = (id) => id === B.OAK_LOG || id === B.BIRCH_LOG || id === B.SPRUCE_LOG;
  const isLeaf = (id) => id === B.OAK_LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES;
  let leaves = 0, orphan = 0, borderLeaves = 0;
  const x0 = bcx * 16 + 8, x1 = bcx * 16 + S - 8, z0 = bcz * 16 + 8, z1 = bcz * 16 + S - 8;
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) for (let y = 40; y < HEIGHT; y++) {
    const id = world[idxW(x, y, z)];
    if (!isLeaf(id)) continue;
    leaves++;
    if ((x & 15) === 0 || (x & 15) === 15 || (z & 15) === 0 || (z & 15) === 15) borderLeaves++;
    // BFS limited to radius 6.
    const seen = new Set([`${x},${y},${z}`]);
    const q = [[x, y, z]];
    let found = false;
    while (q.length && !found) {
      const [a, b, c] = q.shift();
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = a + dx, ny = b + dy, nz = c + dz;
        if (Math.abs(nx - x) > 6 || Math.abs(nz - z) > 6 || Math.abs(ny - y) > 6 || ny < 0 || ny >= HEIGHT) continue;
        const k = `${nx},${ny},${nz}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const nid = world[idxW(nx, ny, nz)];
        if (isLog(nid)) { found = true; break; }
        if (isLeaf(nid)) q.push([nx, ny, nz]);
      }
    }
    if (!found) orphan++;
  }
  // Every log column above ground must continue to leaves (no trunk cut at a border).
  let trunks = 0, cutTrunks = 0;
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    for (let y = 40; y < HEIGHT - 1; y++) {
      const id = world[idxW(x, y, z)];
      if (!isLog(id)) continue;
      const below = world[idxW(x, y - 1, z)];
      if (isLog(below)) continue;
      if (below !== B.DIRT && below !== B.GRASS && below !== B.SNOWY_GRASS) continue; // branch
      trunks++;
      let yy = y; while (isLog(world[idxW(x, yy, z)])) yy++;
      if (!isLeaf(world[idxW(x, yy, z)]) && !isLeaf(world[idxW(x + 1, yy - 1, z)]) && !isLeaf(world[idxW(x - 1, yy - 1, z)])) cutTrunks++;
    }
  }
  console.log(`trees: ${trunks} trunks (${cutTrunks} without canopy), ${leaves} leaves (${borderLeaves} on chunk borders), ${orphan} orphan leaves`);
  if (orphan || cutTrunks || trunks === 0) fail('tree continuity');

  // Cross-check border trees exactly: regenerate each chunk in a different generator instance
  // after generating its neighbours, compare the edge columns.
  const g4 = new WorldGen(seed);
  let edgeMismatch = 0;
  for (let j = 1; j < 2 * R - 1; j += 3) for (let i = 1; i < 2 * R - 1; i += 3) {
    g4.generateChunk(bcx + i + 1, bcz + j); g4.generateChunk(bcx + i, bcz + j + 1);
    const c = g4.generateChunk(bcx + i, bcz + j).blocks;
    for (let y = 0; y < HEIGHT; y++) for (let k = 0; k < 16; k++) {
      for (const [lx, lz] of [[0, k], [15, k], [k, 0], [k, 15]]) {
        if (c[lx | (lz << 4) | (y << 8)] !== world[idxW((bcx + i) * 16 + lx, y, (bcz + j) * 16 + lz)]) edgeMismatch++;
      }
    }
  }
  console.log(`edge columns regenerated in another order: ${edgeMismatch} mismatches`);
  if (edgeMismatch) fail('edge mismatch');

  // Tree decisions must agree wherever two chunks' margin regions overlap, and no tree may
  // write farther from its trunk than the margin every chunk scans.
  const g5 = new WorldGen(seed);
  const PADR = (g5.cols.tree.length ** 0.5 - 16) / 2;
  const RWR = 16 + 2 * PADR;
  const decisions = new Map();
  let decisionMismatch = 0, decided = 0;
  let reach = 0, tx = 0, tz = 0, inTree = false;
  const put0 = g5._put.bind(g5);
  g5._put = (blocks, x0, z0, x, y, z, id, isLogB) => {
    if (inTree) reach = Math.max(reach, Math.abs(x - tx), Math.abs(z - tz));
    put0(blocks, x0, z0, x, y, z, id, isLogB);
  };
  for (const name of ['_oak', '_spruce', '_bigOak', '_boulder']) {
    const f = g5[name].bind(g5);
    g5[name] = (blocks, x0, z0, x, y, z, ...rest) => { tx = x; tz = z; inTree = true; f(blocks, x0, z0, x, y, z, ...rest); inTree = false; };
  }
  for (let j = 0; j < 2 * R; j++) for (let i = 0; i < 2 * R; i++) {
    const cx = bcx + i, cz = bcz + j;
    g5.generateChunk(cx, cz);
    const t = g5.cols.tree;
    for (let rz = 1; rz < RWR - 1; rz++) for (let rx = 1; rx < RWR - 1; rx++) {
      const k = `${cx * 16 - PADR + rx},${cz * 16 - PADR + rz}`;
      const v = t[rx + rz * RWR];
      if (decisions.has(k)) { if (decisions.get(k) !== v) decisionMismatch++; } else decisions.set(k, v);
      if (v) decided++;
    }
  }
  console.log(`tree decisions in overlapping margins: ${decisionMismatch} mismatches (${decided} feature hits), max reach from trunk ${reach} (margin ${PADR - 1})`);
  if (decisionMismatch || reach > PADR - 1) fail('tree decisions / reach');

  // Chunk carving must agree exactly with the single-point cave test used by tree placement.
  const g6 = new WorldGen(seed);
  let carveChecked = 0, carveMismatch = 0;
  for (let k = 0; k < 12; k++) {
    const cx = bcx + (k * 5) % (2 * R), cz = bcz + (k * 7) % (2 * R);
    const { blocks } = g6.generateChunk(cx, cz);
    const PADC = (g6.cols.tree.length ** 0.5 - 16) / 2, RWC = 16 + 2 * PADC;
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const i = (lx + PADC) + (lz + PADC) * RWC;
      const h = g6.cols.h[i];
      for (let y = 1; y <= h; y++) {
        const id = blocks[lx | (lz << 4) | (y << 8)];
        if (id === B.BEDROCK || id === B.WATER || id === B.ICE || id === B.PACKED_ICE) continue;
        const expect = g6._carvedAt(cx * 16 + lx, y, cz * 16 + lz, i);
        const got = id === 0 || id === B.LAVA;
        carveChecked++;
        if (expect !== got) carveMismatch++;
      }
    }
  }
  console.log(`carve decisions chunk vs point: ${carveMismatch} mismatches of ${carveChecked}`);
  if (carveMismatch) fail('carve mismatch');

  // Spawn sanity.
  const sx = Math.floor(spawn.x), sy = spawn.y, sz = Math.floor(spawn.z);
  const under = world[idxW(sx, sy - 1, sz)], feet = world[idxW(sx, sy, sz)], head = world[idxW(sx, sy + 1, sz)];
  const passable = (id) => id === 0 || id === B.TALL_GRASS || id === B.FERN || id === B.POPPY || id === B.DANDELION || id === B.CORNFLOWER;
  console.log(`spawn ${JSON.stringify(spawn)} biome ${BIOMES[gen.biomeAt(sx, sz)].name}: ground ${under}, feet ${feet}, head ${head}`);
  if (!(under === B.GRASS || under === B.SNOWY_GRASS) || !passable(feet) || !passable(head) || sy - 1 < SEA) fail('spawn');

  // 4. Timing.
  const gt = new WorldGen(seed);
  for (let k = 0; k < 30; k++) gt.generateChunk(k, -k); // warm-up
  const times = [];
  for (let k = 0; k < NCH; k++) {
    const cx = (k % 20) - 10 + Math.floor(spawn.x / 16), cz = Math.floor(k / 20) - 5 + Math.floor(spawn.z / 16);
    const t = performance.now();
    gt.generateChunk(cx, cz);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`generateChunk: mean ${mean.toFixed(2)} ms, median ${times[times.length >> 1].toFixed(2)}, p95 ${times[Math.floor(times.length * 0.95)].toFixed(2)}, max ${times[times.length - 1].toFixed(2)} (${NCH} chunks)`);
  if (mean > 5) fail('too slow');
  let t = performance.now();
  for (let k = 0; k < 2000; k++) gt.heightAt(k * 13, k * 7);
  const hat = (performance.now() - t) / 2000;
  t = performance.now();
  const sp = new WorldGen(seed).findSpawn();
  console.log(`heightAt ${(hat * 1000).toFixed(1)} us, findSpawn ${(performance.now() - t).toFixed(1)} ms -> ${JSON.stringify(sp)}`);
}
console.log(failures ? `FAILED (${failures})` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
