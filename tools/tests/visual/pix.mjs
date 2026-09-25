// Print sRGB pixel values (and a 5x5 mean) at given points of a PNG: node pix.mjs file.png x,y x,y ...
import fs from 'node:fs';
import zlib from 'node:zlib';
function decode(file) {
  const b = fs.readFileSync(file);
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const out = new Uint8Array(w * h * 3), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i], a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + up; else if (f === 3) v = x + ((a + up) >> 1);
      else { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = cur[x * bpp + k];
    prev.set(cur);
  }
  return { w, h, data: out };
}
const [file, ...pts] = process.argv.slice(2);
const img = decode(file);
for (const p of pts) {
  const [x, y] = p.split(',').map(Number);
  const m = [0, 0, 0]; let n = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = Math.min(img.w - 1, Math.max(0, x + dx)), yy = Math.min(img.h - 1, Math.max(0, y + dy));
    for (let k = 0; k < 3; k++) m[k] += img.data[(yy * img.w + xx) * 3 + k];
    n++;
  }
  console.log(`${x},${y}: ${m.map((v) => Math.round(v / n)).join(' ')}`);
}
