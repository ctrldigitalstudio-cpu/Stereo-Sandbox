// Find an open cavern with lava near spawn (seed 12345) for the cave capture.
import { WorldGen } from '../../../src/worldgen.js';
import { B } from '../../../src/blocks.js';
const g = new WorldGen(12345);
const chunks = new Map();
const get = (x, y, z) => {
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  const k = cx + ',' + cz;
  if (!chunks.has(k)) chunks.set(k, g.generateChunk(cx, cz).blocks);
  if (y < 0 || y > 127) return 0;
  return chunks.get(k)[(x - cx * 16) | ((z - cz * 16) << 4) | (y << 8)];
};
let best = null;
for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) {
  for (let lx = 0; lx < 16; lx += 2) for (let lz = 0; lz < 16; lz += 2) for (let y = 3; y < 40; y++) {
    const x = cx * 16 + lx, z = cz * 16 + lz;
    if (get(x, y, z) !== B.LAVA || get(x, y + 1, z) !== 0) continue;
    // Air volume above the lava: an open cavern.
    let air = 0;
    for (let dx = -5; dx <= 5; dx += 1) for (let dz = -5; dz <= 5; dz += 1) for (let dy = 1; dy <= 6; dy++) if (get(x + dx, y + dy, z + dz) === 0) air++;
    if (!best || air > best.air) best = { x, y, z, air };
  }
}
console.log('lava cavern', best);
// Also: deep open ocean spot with floor depth 20-30 below sea.
for (let r = 16; r < 600; r += 8) for (let a = 0; a < 64; a++) {
  const x = Math.round(Math.cos(a / 64 * 6.283) * r), z = Math.round(8 + Math.sin(a / 64 * 6.283) * r);
  let ok = true;
  for (let dx = -24; dx <= 24 && ok; dx += 8) for (let dz = -24; dz <= 24 && ok; dz += 8) { const h = g.heightAt(x + dx, z + dz); if (h > 46 || h < 28) ok = false; }
  if (ok) { console.log('ocean', { x, z, h: g.heightAt(x, z) }); r = 1e9; break; }
}
