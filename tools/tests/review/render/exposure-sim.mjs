// Simulates post.js exposure adaptation (EXPOSURE_FS) with the stored value quantised like the
// 1x1 target it lives in: RGBA16F (round-to-nearest half) or RGBA8 (unorm, 1/255).
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalfRNE(x) { // float32 -> nearest half -> back to number
  if (x === 0) return 0;
  const e = Math.floor(Math.log2(Math.abs(x)));
  const ulp = Math.pow(2, Math.max(e, -14) - 10);
  const q = x / ulp, r = Math.round(q);
  const rr = (Math.abs(q - Math.trunc(q)) === 0.5) ? (Math.trunc(q) % 2 === 0 ? Math.trunc(q) : Math.trunc(q) + Math.sign(q)) : r;
  return rr * ulp;
}
const toU8 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255) / 255;
const decodeE = (v) => 2 ** (v * 10 - 5);
const encodeE = (e) => Math.min(1, Math.max(0, (Math.log2(e) + 5) / 10));
function run(fmt, hz, startE, targetE, seconds = 30) {
  const q = fmt === 'rgba16f' ? toHalfRNE : toU8;
  let stored = q(encodeE(startE));
  const dt = 1 / hz;
  for (let t = 0; t < seconds; t += dt) {
    const prev = decodeE(stored);
    const speed = targetE > prev ? 1.1 : 2.6;
    const e = 2 ** (Math.log2(prev) + (Math.log2(targetE) - Math.log2(prev)) * (1 - Math.exp(-dt * speed)));
    stored = q(encodeE(e));
  }
  const final = decodeE(stored);
  return { final: +final.toFixed(4), target: targetE, errorStops: +Math.log2(targetE / final).toFixed(3) };
}
for (const fmt of ['rgba16f', 'rgba8']) {
  for (const hz of [60, 144, 240]) {
    // dark -> bright scene (exposure falls) and bright -> dark (exposure rises)
    console.log(fmt, hz + 'Hz', 'cave->day (9 -> 0.3):', JSON.stringify(run(fmt, hz, 9, 0.3)), ' day->dusk (0.3 -> 2):', JSON.stringify(run(fmt, hz, 0.3, 2)), ' night (2 -> 9):', JSON.stringify(run(fmt, hz, 2, 9)));
  }
}
