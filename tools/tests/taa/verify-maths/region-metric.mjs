import { decode } from '../verify-visual/png.mjs';
const dir = 'tools/out/taa-verify-maths/';
const files = ['mip-shipped-s1.png', 'mip-patched-s1.png', 'mip-shipped-s0.5.png', 'mip-patched-s0.5.png'];
const regions = { ground: [0, 150, 140, 75], distant: [220, 20, 90, 60], birch: [0, 20, 60, 110], hillTop: [300, 40, 100, 50] };
for (const f of files) {
  const img = decode(dir + f);
  const d = img.data || img.pixels || img;
  const w = img.w, h = img.h;
  const px = img.data ? img.data : img.rgba;
  const L = (i, j) => { const k = (j * w + i) * 4; return 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2]; };
  const out = {};
  for (const [name, [x0, y0, rw, rh]] of Object.entries(regions)) {
    let s = 0, n = 0;
    for (let j = y0 + 1; j < y0 + rh - 1; j++) for (let i = x0 + 1; i < x0 + rw - 1; i++) {
      s += Math.abs(4 * L(i, j) - L(i - 1, j) - L(i + 1, j) - L(i, j - 1) - L(i, j + 1)); n++;
    }
    out[name] = +(s / n).toFixed(2);
  }
  console.log(f.padEnd(24), JSON.stringify(out));
}
