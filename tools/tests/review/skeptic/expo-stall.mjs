// Model of EXPOSURE_FS update + storage quantisation (fp16 RNE, or unorm8 round).
const f16 = (x) => { // round to nearest-even fp16
  const b = new Float32Array(1); b[0] = x; const e = Math.floor(Math.log2(Math.abs(x)));
  const ulp = Math.pow(2, Math.max(e, -14) - 10); const q = x / ulp; let r = Math.round(q);
  if (Math.abs(q - Math.trunc(q)) === 0.5) r = 2 * Math.round(q / 2);
  return r * ulp;
};
const u8 = (x) => Math.round(Math.min(Math.max(x, 0), 1) * 255) / 255;
const enc = (l) => Math.min(Math.max((l + 5) / 10, 0), 1);
const run = (q, hz, from, to) => {
  let u = q(enc(from));
  for (let i = 0; i < hz * 30; i++) {
    const prev = u * 10 - 5; const speed = to > prev ? 1.1 : 2.6;
    const l = prev + (to - prev) * (1 - Math.exp(-(1 / hz) * speed));
    u = q(enc(l));
  }
  return (u * 10 - 5) - to;
};
for (const [name, q] of [['fp16', f16], ['rgba8', u8]]) for (const hz of [60, 144, 240]) {
  const cases = [[-2, -1], [-1, -2], [1, Math.log2(9)], [Math.log2(9), 1], [0, 2], [-0.5, 0.5], [0.5, -0.5]];
  console.log(name, hz + 'Hz', cases.map(([a, b]) => `${a.toFixed(2)}->${b.toFixed(2)}: ${run(q, hz, a, b).toFixed(3)}`).join('  '));
}
