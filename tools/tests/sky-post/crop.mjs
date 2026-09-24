// Crop + nearest-neighbour zoom of PNG screenshots for close inspection; several inputs are
// placed side by side. Usage: node crop.mjs out.png x y w h zoom in1.png [in2.png ...]
import fs from 'node:fs';
import zlib from 'node:zlib';

function decode(file) {
  const b = fs.readFileSync(file);
  let o = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  const stride = w * bpp;
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + up;
      else if (f === 3) v = x + ((a + up) >> 1);
      else { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = cur[x * bpp]; out[(y * w + x) * 4 + 1] = cur[x * bpp + 1]; out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = 255;
    }
    prev.set(cur);
  }
  return { w, h, data: out };
}

function encode(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const [out, X, Y, W, H, Z, ...ins] = process.argv.slice(2);
const x0 = +X, y0 = +Y, cw = +W, ch = +H, z = +Z;
const gap = 4, OW = ins.length * cw * z + (ins.length - 1) * gap, OH = ch * z;
const img = new Uint8Array(OW * OH * 4).fill(255);
ins.forEach((f, k) => {
  const s = decode(f);
  for (let y = 0; y < OH; y++) for (let x = 0; x < cw * z; x++) {
    const sx = Math.min(s.w - 1, x0 + Math.floor(x / z)), sy = Math.min(s.h - 1, y0 + Math.floor(y / z));
    const si = (sy * s.w + sx) * 4, di = (y * OW + k * (cw * z + gap) + x) * 4;
    img[di] = s.data[si]; img[di + 1] = s.data[si + 1]; img[di + 2] = s.data[si + 2]; img[di + 3] = 255;
  }
});
fs.writeFileSync(out, encode(OW, OH, img));
console.log(`${out}: ${OW}x${OH}`);
