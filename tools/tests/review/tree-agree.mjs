// Review check: tree decisions for a world column must agree between every chunk whose margin
// contains it (otherwise canopies get cut at chunk borders).
import { WorldGen } from '../../../src/worldgen.js';
const PAD = 5, RW = 26;
let disagree = 0, compared = 0, trees = 0;
for (const seed of [12345, 777, 42]) {
  const g = new WorldGen(seed);
  const maps = new Map();
  const N = 6;
  for (let cz = -N; cz <= N; cz++) for (let cx = -N; cx <= N; cx++) {
    g.generateChunk(cx, cz);
    maps.set(`${cx},${cz}`, g.cols.tree.slice());
  }
  // world column -> decision per chunk
  const seen = new Map();
  for (let cz = -N; cz <= N; cz++) for (let cx = -N; cx <= N; cx++) {
    const t = maps.get(`${cx},${cz}`);
    for (let rz = 1; rz < RW - 1; rz++) for (let rx = 1; rx < RW - 1; rx++) {
      const x = cx * 16 - PAD + rx, z = cz * 16 - PAD + rz;
      const k = x + ',' + z, v = t[rx + rz * RW];
      if (seen.has(k)) { compared++; if (seen.get(k) !== v) { disagree++; if (disagree < 5) console.log('disagree at', k, seen.get(k), v); } }
      else { seen.set(k, v); if (v) trees++; }
    }
  }
}
console.log(`compared ${compared} overlapping column decisions, ${disagree} disagreements, ${trees} trees`);
