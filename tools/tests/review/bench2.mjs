import { WorldGen } from '../../../src/worldgen.js';
import { meshChunk } from '../../../src/mesher.js';
import { NUM_BLOCKS } from '../../../src/blocks.js';
const g = new WorldGen(12345);
const L = new Uint16Array(NUM_BLOCKS * 6);
// Find mountainous chunks.
const cands = [];
for (let cz = -150; cz < 150; cz += 3) for (let cx = -150; cx < 150; cx += 3) cands.push([g.heightAt(cx * 16 + 8, cz * 16 + 8), cx, cz]);
cands.sort((a, b) => b[0] - a[0]);
const cache = new Map();
const get = (cx, cz) => { const k = cx + ',' + cz; let c = cache.get(k); if (!c) { c = g.generateChunk(cx, cz); cache.set(k, c); } return c; };
// warm up
for (let i = 0; i < 20; i++) { const nb = []; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(get(dx + 100, dz)); meshChunk(nb, L); }
let worst = 0, sum = 0, n = 0, gsum = 0, gn = 0, gworst = 0;
for (const [h, cx, cz] of cands.slice(0, 40)) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const k = (cx + dx) + ',' + (cz + dz); if (!cache.has(k)) { const t = performance.now(); get(cx + dx, cz + dz); const d = performance.now() - t; gsum += d; gn++; if (d > gworst) gworst = d; } }
  const nb = []; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(get(cx + dx, cz + dz));
  const t = performance.now(); const m = meshChunk(nb, L, cx, cz); const d = performance.now() - t;
  sum += d; n++; if (d > worst) worst = d;
}
console.log(`mountain chunks: mesh avg ${(sum / n).toFixed(2)} ms worst ${worst.toFixed(1)}; gen avg ${(gsum / gn).toFixed(2)} worst ${gworst.toFixed(1)}; top height ${cands[0][0]}`);
