// Per-stage timing of generateChunk (monkeypatched wrappers).
import { WorldGen } from '../../../src/worldgen.js';
const gen = new WorldGen(Number(process.argv[2] || 12345));
const stages = ['_fillColumns', '_surfaces', '_ores', '_caves', '_trees', '_plants'];
const acc = {};
for (const s of stages) {
  const f = gen[s].bind(gen); acc[s] = 0;
  gen[s] = (...a) => { const t = performance.now(); const r = f(...a); acc[s] += performance.now() - t; return r; };
}
for (let k = 0; k < 50; k++) gen.generateChunk(k, 3 * k);
for (const s of stages) acc[s] = 0;
const N = 400;
const t0 = performance.now();
for (let k = 0; k < N; k++) gen.generateChunk((k % 20) - 10, Math.floor(k / 20) - 10);
const total = (performance.now() - t0) / N;
let staged = 0;
for (const s of stages) { staged += acc[s] / N; console.log(s.padEnd(14), (acc[s] / N).toFixed(3), 'ms'); }
console.log('terrain+colors', (total - staged).toFixed(3), 'ms');
console.log('total         ', total.toFixed(3), 'ms');
