// CLI: node mont.mjs out.png x y w h zoom [--cols n] in1.png in2.png ...   (+ prints sharpness,
// and consecutive-pair diffs when --pairs is given: in1 vs in2, in3 vs in4 ...)
import { montage, sharpness, diff, decode } from './png.mjs';
const a = process.argv.slice(2);
let cols = null, pairs = false;
const rest = [];
for (let i = 0; i < a.length; i++) {
  if (a[i] === '--cols') cols = Number(a[++i]);
  else if (a[i] === '--pairs') pairs = true;
  else rest.push(a[i]);
}
const [out, X, Y, W, H, Z, ...ins] = rest;
const r = { x: +X, y: +Y, w: +W, h: +H };
const imgs = ins.map((f) => ({ file: f, img: decode(f) }));
montage(out, imgs, { ...r, zoom: +Z, cols: cols || ins.length });
for (const it of imgs) console.log(`${it.file.split('/').slice(-1)[0]}  sharp=${sharpness(it.img, r).toFixed(2)}`);
if (pairs) for (let i = 0; i + 1 < imgs.length; i += 2) {
  const d = diff(imgs[i].img, imgs[i + 1].img, r);
  console.log(`diff ${imgs[i].file.split('/').slice(-1)[0]} vs next: mean=${d.mean.toFixed(2)} big=${(d.bigFrac * 100).toFixed(2)}%`);
}
