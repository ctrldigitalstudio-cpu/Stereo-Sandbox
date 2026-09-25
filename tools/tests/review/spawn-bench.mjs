// Review check: WorldGen.findSpawn() runs on the main thread during boot; how long does it take?
import { WorldGen } from '../../../src/worldgen.js';
const N = Number(process.argv[2] || 150);
const times = [];
let s0 = 1;
for (let i = 0; i < N; i++) {
  const seed = (Math.imul(i + 1, 2654435761) >>> 1) | 0;
  const t0 = performance.now();
  const g = new WorldGen(seed);
  const sp = g.findSpawn();
  const dt = performance.now() - t0;
  times.push([dt, seed, sp]);
}
times.sort((a, b) => b[0] - a[0]);
const med = times[Math.floor(N / 2)][0];
console.log(`median ${med.toFixed(0)} ms; worst:`);
for (const [dt, seed, sp] of times.slice(0, 6)) console.log(`  seed ${seed}: ${dt.toFixed(0)} ms -> ${JSON.stringify(sp)}`);
