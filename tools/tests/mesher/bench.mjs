// Mesher benchmark: light + mesh time per chunk on synthetic terrain and (if present) the real
// generator.  Run: node tools/tests/mesher/bench.mjs [--real-only] [--synth-only]
import fs from 'node:fs';
import { meshChunk } from '../../../src/mesher.js';
import { WorldGen as SynthGen } from './synth-worldgen.js';

const args = process.argv.slice(2);
const realPath = new URL('../../../src/worldgen.js', import.meta.url);

function grid(gen, r) {
  const map = new Map();
  for (let cz = -r - 1; cz <= r + 1; cz++) for (let cx = -r - 1; cx <= r + 1; cx++) map.set(`${cx},${cz}`, gen.generateChunk(cx, cz));
  return map;
}

function bench(name, gen, r = 4, reps = 3) {
  const t0 = performance.now();
  const map = grid(gen, r);
  const genMs = (performance.now() - t0) / map.size;
  const jobs = [];
  for (let cz = -r; cz <= r; cz++) for (let cx = -r; cx <= r; cx++) {
    const nb = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(map.get(`${cx + dx},${cz + dz}`));
    jobs.push([cx, cz, nb]);
  }
  const layers = new Uint16Array(256 * 6);
  for (const [cx, cz, nb] of jobs) meshChunk(nb, layers, cx, cz); // warm up the JIT
  const times = [];
  let quads = 0, water = 0;
  for (let rep = 0; rep < reps; rep++) {
    for (const [cx, cz, nb] of jobs) {
      const t = performance.now();
      const m = meshChunk(nb, layers, cx, cz);
      times.push(performance.now() - t);
      if (rep === 0) { quads += m.opaqueQuads; water += m.waterQuads; }
    }
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const pct = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  console.log(`${name}: ${jobs.length} chunks x ${reps}  mesh avg ${avg.toFixed(2)} ms  median ${pct(0.5).toFixed(2)}  p90 ${pct(0.9).toFixed(2)}  max ${pct(1).toFixed(2)}  ` +
    `| ${(quads / jobs.length).toFixed(0)} opaque + ${(water / jobs.length).toFixed(0)} water quads/chunk | gen ${genMs.toFixed(2)} ms/chunk`);
  return avg;
}

if (!args.includes('--real-only')) bench('synthetic', new SynthGen(4242));
if (!args.includes('--synth-only')) {
  if (fs.existsSync(realPath)) {
    try {
      const { WorldGen } = await import(realPath.href);
      for (const seed of [12345, 777]) bench(`worldgen seed ${seed}`, new WorldGen(seed));
      const far = new WorldGen(12345);
      // Somewhere else in the world (other biomes).
      const shifted = { generateChunk: (cx, cz) => far.generateChunk(cx + 40, cz - 25) };
      bench('worldgen seed 12345 @ (40,-25)', shifted);
    } catch (e) {
      console.log('real worldgen failed:', e.message);
    }
  } else {
    console.log('src/worldgen.js not present; skipped real-chunk benchmark');
  }
}
