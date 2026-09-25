// PNG decode/encode + image helpers for the verification scripts (scratch).
import fs from 'node:fs';
import zlib from 'node:zlib';

export function decode(file) {
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

export function encode(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Side-by-side crops with nearest zoom. items: [{file, x, y}] (x,y optional per item), same w/h.
export function montage(out, items, { x = 0, y = 0, w, h, zoom = 1, gap = 4, cols = items.length } = {}) {
  const rows = Math.ceil(items.length / cols);
  const OW = cols * w * zoom + (cols - 1) * gap, OH = rows * h * zoom + (rows - 1) * gap;
  const img = new Uint8Array(OW * OH * 4).fill(255);
  items.forEach((it, k) => {
    const s = typeof it === 'string' ? decode(it) : it.img || decode(it.file);
    const ox = (it.x ?? x), oy = (it.y ?? y);
    const cx = (k % cols) * (w * zoom + gap), cy = Math.floor(k / cols) * (h * zoom + gap);
    for (let yy = 0; yy < h * zoom; yy++) for (let xx = 0; xx < w * zoom; xx++) {
      const sx = Math.min(s.w - 1, ox + Math.floor(xx / zoom)), sy = Math.min(s.h - 1, oy + Math.floor(yy / zoom));
      const si = (sy * s.w + sx) * 4, di = ((cy + yy) * OW + cx + xx) * 4;
      img[di] = s.data[si]; img[di + 1] = s.data[si + 1]; img[di + 2] = s.data[si + 2]; img[di + 3] = 255;
    }
  });
  fs.writeFileSync(out, encode(OW, OH, img));
  return out;
}

// Mean absolute difference (0..255) over a region, and optional amplified diff image.
export function diff(a, b, { x = 0, y = 0, w, h, out = null, gain = 4 } = {}) {
  const A = typeof a === 'string' ? decode(a) : a, B = typeof b === 'string' ? decode(b) : b;
  w = w ?? A.w; h = h ?? A.h;
  let sum = 0, big = 0;
  const img = out ? new Uint8Array(w * h * 4) : null;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const i = ((y + yy) * A.w + x + xx) * 4;
    const d = (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2])) / 3;
    sum += d;
    if (d > 24) big++;
    if (img) { const j = (yy * w + xx) * 4; const v = Math.min(255, d * gain); img[j] = v; img[j + 1] = v; img[j + 2] = v; img[j + 3] = 255; }
  }
  if (out) fs.writeFileSync(out, encode(w, h, img));
  return { mean: sum / (w * h), bigFrac: big / (w * h) };
}

// Mean luminance-gradient energy (sharpness proxy) over a region.
export function sharpness(a, { x = 0, y = 0, w, h } = {}) {
  const A = typeof a === 'string' ? decode(a) : a;
  w = w ?? A.w; h = h ?? A.h;
  const L = (xx, yy) => { const i = (yy * A.w + xx) * 4; return 0.2126 * A.data[i] + 0.7152 * A.data[i + 1] + 0.0722 * A.data[i + 2]; };
  let s = 0, n = 0;
  for (let yy = y; yy < y + h - 1; yy++) for (let xx = x; xx < x + w - 1; xx++) {
    const gx = L(xx + 1, yy) - L(xx, yy), gy = L(xx, yy + 1) - L(xx, yy);
    s += Math.abs(gx) + Math.abs(gy); n++;
  }
  return s / n;
}
