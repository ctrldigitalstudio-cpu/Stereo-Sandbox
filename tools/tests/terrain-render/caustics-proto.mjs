// Offline prototype of caustic patterns from the real uNoise2D texture -> PNG grid.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { generateNoise2D } from '../../../src/render/atmosphere.js';

const N = 256;
const tex = generateNoise2D(N);
function sample(u, v, ch) {
  u = u * N - 0.5; v = v * N - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const g = (x, y) => tex[((((y % N) + N) % N) * N + (((x % N) + N) % N)) * 4 + ch] / 255;
  return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
}
const sat = (x) => Math.min(1, Math.max(0, x));
const variants = {
  worleyPow(px, pz, t) {
    const q = [px / 20, pz / 20];
    const w = [sample(q[0] * 0.31 + t * 0.0043, q[1] * 0.31 + t * 0.0029, 0) - 0.5, sample(q[0] * 0.31 + t * 0.0043, q[1] * 0.31 + t * 0.0029, 1) - 0.5];
    const a = sample(q[0] + w[0] * 0.22 + t * 0.011, q[1] + w[1] * 0.22 + t * 0.0063, 3);
    const b = sample(q[0] * 1.29 - w[0] * 0.19 + 0.37 - t * 0.0079, q[1] * 1.29 - w[1] * 0.19 + 0.71 - t * 0.0107, 3);
    return ((1 - a) ** 3 + (1 - b) ** 3) * 1.6;
  },
  crossing(px, pz, t) {
    const q = [px / 16, pz / 16];
    const w = [sample(q[0] * 0.3 + t * 0.004, q[1] * 0.3 + t * 0.003, 0) - 0.5, sample(q[0] * 0.3 + t * 0.004, q[1] * 0.3 + t * 0.003, 1) - 0.5];
    const n1 = sample(q[0] + w[0] * 0.3 + t * 0.012, q[1] + w[1] * 0.3 + t * 0.007, 1);
    const n2 = sample(q[0] * 1.21 - w[0] * 0.3 + 0.37 - t * 0.009, q[1] * 1.21 - w[1] * 0.3 + 0.71 - t * 0.011, 1);
    return sat(1 - Math.abs(n1 - n2) * 4) ** 6 * 2.5;
  },
  worleyEdge(px, pz, t) {
    // Distance-to-feature is largest along cell borders: a sharp high band traces the network
    const q = [px / 22, pz / 22];
    const w = [sample(q[0] * 0.3 + t * 0.004, q[1] * 0.3 + t * 0.003, 0) - 0.5, sample(q[0] * 0.3 + t * 0.004, q[1] * 0.3 + t * 0.003, 2) - 0.5];
    const a = 1 - sample(q[0] + w[0] * 0.35 + t * 0.01, q[1] + w[1] * 0.35 + t * 0.006, 3);
    const b = 1 - sample(q[0] * 1.37 - w[0] * 0.3 + 0.37 - t * 0.008, q[1] * 1.37 - w[1] * 0.3 + 0.71 - t * 0.01, 3);
    return (sat((a - 0.45) * 2.2) ** 2 + sat((b - 0.45) * 2.2) ** 2) * 1.4;
  },
  ridged(px, pz, t) {
    const q = [px / 12, pz / 12];
    const w = [sample(q[0] * 0.3 + t * 0.004, q[1] * 0.3 + t * 0.003, 0) - 0.5, sample(q[0] * 0.3 + t * 0.004, q[1] * 0.3 + t * 0.003, 2) - 0.5];
    const n1 = sample(q[0] + w[0] * 0.4 + t * 0.012, q[1] + w[1] * 0.4 + t * 0.007, 1);
    const n2 = sample(q[0] * 0.83 - w[0] * 0.4 + 0.37 - t * 0.009, q[1] * 0.83 - w[1] * 0.4 + 0.71 - t * 0.011, 2);
    const r1 = sat(1 - Math.abs(n1 - 0.5) * 7) ** 3, r2 = sat(1 - Math.abs(n2 - 0.5) * 7) ** 3;
    return (r1 + r2) * 1.3;
  },
};
const names = Object.keys(variants);
const S = 200; // pixels per tile (covers 40 blocks)
const Wd = S * names.length, Ht = S;
const img = Buffer.alloc((Wd * 3 + 1) * Ht);
for (let y = 0; y < Ht; y++) {
  img[y * (Wd * 3 + 1)] = 0;
  names.forEach((n, k) => {
    for (let x = 0; x < S; x++) {
      const v = variants[n](x * 0.2, y * 0.2, 100);
      const c = Math.round(sat(v / 2.5) * 255);
      const o = y * (Wd * 3 + 1) + 1 + (k * S + x) * 3;
      img[o] = c; img[o + 1] = c; img[o + 2] = c;
    }
  });
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td));
  return Buffer.concat([len, td, crc]);
};
function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(Wd, 0); ihdr.writeUInt32BE(Ht, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(process.argv[2] || 'caustics.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(img)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', names.join(', '));
for (const n of names) {
  let s = 0, s2 = 0, mx = 0, cnt = 0;
  for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) { const v = variants[n](x * 0.37, y * 0.41, 50); s += v; s2 += v * v; mx = Math.max(mx, v); cnt++; }
  console.log(n, 'mean', (s / cnt).toFixed(3), 'std', Math.sqrt(s2 / cnt - (s / cnt) ** 2).toFixed(3), 'max', mx.toFixed(2));
}
