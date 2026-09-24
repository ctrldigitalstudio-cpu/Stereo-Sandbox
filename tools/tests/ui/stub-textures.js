// Harness-only stand-in for src/textures.js (used with ?stub or when the real module is missing):
// flat-shaded isometric cubes / sprites in a per-block colour so the UI can be laid out and tested.
import { BLOCKS, NUM_BLOCKS, SHAPE_CROSS, SHAPE_TORCH } from '../../../src/blocks.js';

export function buildTextures() {
  return { size: 16, layers: 1, levels: 1, albedo: [], normal: [], spec: [], layerOf: {}, faceLayers: new Uint16Array(NUM_BLOCKS * 6), cutout: new Uint8Array(1), stub: true };
}

function colorOf(id) {
  const h = (id * 137.508) % 360;
  return [h, 45, 52];
}

export function makeBlockIcon(tex, id, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const d = BLOCKS[id];
  if (!d || !tex) return c;
  const g = c.getContext('2d');
  const [hh, s, l] = colorOf(id);
  const u = size / 16;
  if (d.shape === SHAPE_CROSS || d.shape === SHAPE_TORCH) {
    g.fillStyle = `hsl(${hh} ${s}% ${l}%)`;
    g.fillRect(7 * u, 4 * u, 2 * u, 11 * u);
    g.fillRect(4 * u, 3 * u, 8 * u, 4 * u);
    return c;
  }
  const cx = size / 2, top = size * 0.03, w = size * 0.47, hq = size * 0.235, side = size * 0.5;
  const face = (pts, light) => {
    g.fillStyle = `hsl(${hh} ${s}% ${l * light}%)`;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
  };
  face([[cx, top], [cx + w, top + hq], [cx, top + 2 * hq], [cx - w, top + hq]], 1.25);
  face([[cx - w, top + hq], [cx, top + 2 * hq], [cx, top + 2 * hq + side], [cx - w, top + hq + side]], 0.85);
  face([[cx + w, top + hq], [cx, top + 2 * hq], [cx, top + 2 * hq + side], [cx + w, top + hq + side]], 0.65);
  return c;
}
