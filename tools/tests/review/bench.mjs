import { WorldGen } from '../../../src/worldgen.js';
import { meshChunk } from '../../../src/mesher.js';
import { NUM_BLOCKS } from '../../../src/blocks.js';
const g = new WorldGen(12345);
const L = new Uint16Array(NUM_BLOCKS * 6);
const cache = new Map();
const get = (cx, cz) => { const k = cx + ',' + cz; let c = cache.get(k); if (!c) { c = g.generateChunk(cx, cz); cache.set(k, c); } return c; };
let t0 = performance.now(), n = 0;
for (let cz = -8; cz < 8; cz++) for (let cx = -8; cx < 8; cx++) { get(cx, cz); n++; }
const gen = (performance.now() - t0) / n;
t0 = performance.now(); let m = 0, worst = 0;
for (let cz = -7; cz < 7; cz++) for (let cx = -7; cx < 7; cx++) {
  const nb = []; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(get(cx + dx, cz + dz));
  const a = performance.now(); meshChunk(nb, L, cx, cz); const d = performance.now() - a; if (d > worst) worst = d; m++;
}
console.log(`gen ${gen.toFixed(2)} ms/chunk, mesh ${((performance.now() - t0) / m).toFixed(2)} ms/chunk (worst ${worst.toFixed(1)})`);
