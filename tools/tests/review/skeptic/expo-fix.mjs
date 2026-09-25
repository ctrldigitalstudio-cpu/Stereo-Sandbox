// Proposed hi/lo fix under fp16 storage: decode with and without round() on the hi channel.
const f16 = (x) => { if (x === 0) return 0; const e = Math.floor(Math.log2(Math.abs(x)));
  const ulp = Math.pow(2, Math.max(e, -14) - 10); const q = x / ulp; let r = Math.round(q);
  if (Math.abs(q - Math.trunc(q)) === 0.5) r = 2 * Math.round(q / 2); return r * ulp; };
const u8 = (x) => Math.round(Math.min(Math.max(x, 0), 1) * 255) / 255;
const enc = (l) => Math.min(Math.max((l + 5) / 10, 0), 1);
const run = (q, useRound, hz, from, to) => {
  const store = (l) => { const u = enc(l) * 255; return [q(Math.floor(u) / 255), q(u - Math.floor(u))]; };
  const load = ([r, g]) => ((useRound ? Math.round(r * 255) : r * 255) + g) / 255 * 10 - 5;
  let s = store(from);
  for (let i = 0; i < hz * 30; i++) { const prev = load(s); const speed = to > prev ? 1.1 : 2.6;
    s = store(prev + (to - prev) * (1 - Math.exp(-(1 / hz) * speed))); }
  return load(s) - to;
};
for (const [n, q] of [['fp16', f16], ['rgba8', u8]]) for (const rnd of [false, true]) for (const hz of [60, 144, 240]) {
  let worst = 0; for (let a = -3; a <= 3; a += 0.37) for (const d of [-1, -0.5, 0.5, 1]) { const b = a + d; if (b < -3.3 || b > 3.17) continue;
    const err = run(q, rnd, hz, a, b); if (Math.abs(err) > Math.abs(worst)) worst = err; }
  console.log(n, rnd ? 'round-decode' : 'plain-decode', hz + 'Hz worst residual (stops):', worst.toFixed(4));
}
