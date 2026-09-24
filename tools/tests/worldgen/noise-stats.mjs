import { Simplex } from '../../../src/noise.js';
const s = new Simplex(1234);
function stats(name, f, n = 200000) {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) { a[i] = f(Math.random() * 1000 - 500, Math.random() * 1000 - 500); }
  a.sort();
  const p = (q) => a[Math.floor(q * (n - 1))].toFixed(3);
  let m = 0; for (const v of a) m += v; m /= n;
  console.log(name, 'mean', m.toFixed(3), 'p1', p(0.01), 'p10', p(0.1), 'p25', p(0.25), 'p35', p(0.35), 'p50', p(0.5), 'p75', p(0.75), 'p90', p(0.9), 'p99', p(0.99));
}
stats('noise2', (x, z) => s.noise2(x, z));
stats('fbm3', (x, z) => s.fbm2(x, z, 3));
stats('fbm4', (x, z) => s.fbm2(x, z, 4));
stats('fbm5', (x, z) => s.fbm2(x, z, 5));
stats('ridged5', (x, z) => s.ridged2(x, z, 5));
stats('noise3', (x, z) => s.noise3(x, z, x * 0.37 + z));
// gradient magnitude of fbm4 per unit input
stats('grad fbm4', (x, z) => { const d = 1e-3; return Math.hypot(s.fbm2(x + d, z, 4) - s.fbm2(x, z, 4), s.fbm2(x, z + d, 4) - s.fbm2(x, z, 4)) / d; }, 50000);
stats('grad noise3', (x, z) => { const d = 1e-3, y = x * 0.37 + z; return Math.hypot(s.noise3(x + d, y, z) - s.noise3(x, y, z), s.noise3(x, y + d, z) - s.noise3(x, y, z), s.noise3(x, y, z + d) - s.noise3(x, y, z)) / d; }, 50000);
// timing
let t = performance.now(), acc = 0;
for (let i = 0; i < 1e6; i++) acc += s.noise2(i * 0.013, i * 0.007);
console.log('noise2 ns', ((performance.now() - t) * 1e6 / 1e6).toFixed(1));
t = performance.now();
for (let i = 0; i < 1e6; i++) acc += s.noise3(i * 0.013, i * 0.007, i * 0.011);
console.log('noise3 ns', ((performance.now() - t) * 1e6 / 1e6).toFixed(1), acc > 0);
