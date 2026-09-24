// Times the startup noise generation (budget < 300 ms) and writes PNG previews.
import { generateNoise2D, generateNoise3D } from '../../../src/render/atmosphere.js';
import zlib from 'node:zlib';
import fs from 'node:fs';

function png(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (let run = 0; run < 2; run++) {
  let t = performance.now();
  const n2 = generateNoise2D();
  const t2 = performance.now() - t;
  t = performance.now();
  const n3 = generateNoise3D();
  const t3 = performance.now() - t;
  console.log(`noise2D ${t2.toFixed(1)} ms, noise3D ${t3.toFixed(1)} ms, total ${(t2 + t3).toFixed(1)} ms`);
  if (run === 0) {
    // 2x2 tiled channels side by side (checks tiling), + 3D slices
    const W = 256 * 4, H = 512;
    const img = new Uint8Array(W * H * 4);
    for (let ch = 0; ch < 4; ch++) for (let y = 0; y < H; y++) for (let x = 0; x < 256; x++) {
      const v = n2[(((y % 256) * 256 + (x % 256)) * 4) + ch];
      const o = (y * W + ch * 256 + x) * 4; img[o] = img[o + 1] = img[o + 2] = v; img[o + 3] = 255;
    }
    fs.writeFileSync('tools/out/sky-post-noise2d.png', png(W, H, img));
    const S = 64, img3 = new Uint8Array(S * 4 * S * 2 * 4);
    for (let y = 0; y < S * 2; y++) for (let x = 0; x < S * 4; x++) {
      const z = Math.floor(x / S) * 16; const v = n3[((z * S) + (y % S)) * S + (x % S)];
      const o = (y * S * 4 + x) * 4; img3[o] = img3[o + 1] = img3[o + 2] = v; img3[o + 3] = 255;
    }
    fs.writeFileSync('tools/out/sky-post-noise3d.png', png(S * 4, S * 2, img3));
    // histogram check
    for (let ch = 0; ch < 4; ch++) { let mn = 255, mx = 0, s = 0; for (let i = ch; i < n2.length; i += 4) { mn = Math.min(mn, n2[i]); mx = Math.max(mx, n2[i]); s += n2[i]; } console.log(`2D ch${ch}: min ${mn} max ${mx} mean ${(s / (n2.length / 4)).toFixed(1)}`); }
    let mn = 255, mx = 0, s = 0; for (const v of n3) { mn = Math.min(mn, v); mx = Math.max(mx, v); s += v; } console.log(`3D: min ${mn} max ${mx} mean ${(s / n3.length).toFixed(1)}`);
  }
}
