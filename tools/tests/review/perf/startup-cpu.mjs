// Review scratch: time main-thread startup CPU work (textures + noise) and worker gen/mesh in node.
import { buildTextures } from '../../../../src/textures.js';
import { generateNoise2D, generateNoise3D } from '../../../../src/render/atmosphere.js';
import { WorldGen } from '../../../../src/worldgen.js';
import { meshChunk } from '../../../../src/mesher.js';
const t = (f) => { const a = performance.now(); const r = f(); return [performance.now() - a, r]; };
let [ms, tex] = t(() => buildTextures());
console.log('buildTextures ms', ms.toFixed(1), 'layers', tex.layers);
[ms] = t(() => buildTextures()); console.log('buildTextures (warm) ms', ms.toFixed(1));
[ms] = t(() => generateNoise2D(256)); console.log('noise2D ms', ms.toFixed(1));
[ms] = t(() => generateNoise3D(64)); console.log('noise3D ms', ms.toFixed(1));
const gen = new WorldGen(12345);
const sp = gen.findSpawn();
const ccx = Math.floor(sp.x / 16), ccz = Math.floor(sp.z / 16);
const chunks = new Map();
let genMs = 0, genN = 0;
const get = (cx, cz) => { const k = cx + ',' + cz; let c = chunks.get(k); if (!c) { const a = performance.now(); c = gen.generateChunk(cx, cz); genMs += performance.now() - a; genN++; chunks.set(k, c); } return c; };
let meshMs = 0, meshN = 0, quads = 0, maxQ = 0, bytes = 0, water = 0;
const R = 10;
const times = [];
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
  if (dx * dx + dz * dz > (R + 0.5) ** 2) continue;
  const nb = [];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) nb.push(get(ccx + dx + i, ccz + dz + j));
  const a = performance.now();
  const m = meshChunk(nb, tex.faceLayers, ccx + dx, ccz + dz);
  const d = performance.now() - a; times.push(d);
  meshMs += d; meshN++;
  quads += m.opaqueQuads; water += m.waterQuads; maxQ = Math.max(maxQ, m.opaqueQuads);
  bytes += m.opaque.byteLength + m.water.byteLength;
}
times.sort((a, b) => a - b);
console.log(`chunks meshed ${meshN}, generated ${genN}: gen avg ${(genMs / genN).toFixed(2)} ms, mesh avg ${(meshMs / meshN).toFixed(2)} ms (p50 ${times[meshN >> 1].toFixed(2)}, p95 ${times[Math.floor(meshN * 0.95)].toFixed(2)})`);
console.log(`total worker time for R=${R}: ${((genMs + meshMs) / 1000).toFixed(2)} s`);
console.log(`opaque quads total ${quads}, avg ${(quads / meshN) | 0}, max ${maxQ}, water quads ${water}, GPU bytes ${(bytes / 1e6).toFixed(1)} MB`);
