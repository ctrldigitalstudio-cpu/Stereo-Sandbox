// Downstream cost of generated terrain: quads and meshChunk time on real chunks (uses the mesher
// and textures modules read-only).
import { WorldGen } from '../../../src/worldgen.js';
import { meshChunk } from '../../../src/mesher.js';
import { buildTextures } from '../../../src/textures.js';
const tex = buildTextures();
const gen = new WorldGen(Number(process.argv[2] || 12345));
const cache = new Map();
const get = (cx, cz) => { const k = cx + ',' + cz; if (!cache.has(k)) cache.set(k, gen.generateChunk(cx, cz)); return cache.get(k); };
const times = [], quads = [], water = [];
for (let k = 0; k < 2; k++) for (let cz = -6; cz < 6; cz++) for (let cx = -6; cx < 6; cx++) {
  if (k === 0) { const n = []; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) n.push(get(cx + dx + 40, cz + dz)); meshChunk(n, tex.faceLayers); continue; }
  const n = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) n.push(get(cx + dx, cz + dz));
  const t = performance.now();
  const m = meshChunk(n, tex.faceLayers);
  times.push(performance.now() - t); quads.push(m.opaqueQuads); water.push(m.waterQuads);
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
times.sort((a, b) => a - b); quads.sort((a, b) => a - b);
console.log(`meshChunk over ${times.length} real chunks: mean ${avg(times).toFixed(2)} ms, median ${times[times.length >> 1].toFixed(2)}, p95 ${times[Math.floor(times.length * 0.95)].toFixed(2)}`);
console.log(`opaque quads mean ${avg(quads).toFixed(0)}, median ${quads[quads.length >> 1]}, max ${quads[quads.length - 1]}; water quads mean ${avg(water).toFixed(0)}`);
