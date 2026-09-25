// Review check: same as evict-edited.mjs, but with edited chunks evictable; verifies edits survive revisit.
import { WorldService, chunkKey } from '../../../src/worker.js';
import { NUM_BLOCKS, B } from '../../../src/blocks.js';
const svc = new WorldService({ post: () => {}, schedule: () => {} });
const orig = svc._evict.bind(svc);
svc._evict = function () { for (const c of this.chunks.values()) c.edited = false; orig(); };
svc.handle({ type: 'init', seed: 1, faceLayers: new Uint16Array(NUM_BLOCKS * 6), edits: [] });
const RD = 4;
let held = [];
function goTo(cx) {
  const keys = [];
  for (let dz = -RD; dz <= RD; dz++) for (let dx = -RD; dx <= RD; dx++) if (dx * dx + dz * dz <= (RD + 0.5) ** 2) keys.push([cx + dx, dz]);
  const drop = held.filter(([x]) => Math.abs(x - cx) > RD + 2);
  svc.handle({ type: 'unload', keys: drop });
  held = held.filter(([x]) => Math.abs(x - cx) <= RD + 2);
  svc.handle({ type: 'want', keys });
  svc.drain();
  for (const k of keys) if (!held.some(([a, b]) => a === k[0] && b === k[1])) held.push(k);
}
for (let cx = 0; cx < 300; cx++) {
  goTo(cx);
  svc.handle({ type: 'set', x: cx * 16 + 3, y: 70, z: 5, id: B.STONE });
  svc.drain();
}
console.log(`cached after flight: ${svc.chunks.size}`);
// go back to chunk 10 and check edit present
for (let cx = 299; cx >= 10; cx -= 1) goTo(cx);
const c = svc.chunks.get(chunkKey(10, 0));
const idx = 3 | (5 << 4) | (70 << 8);
console.log(`chunk 10 cached=${!!c} block=${c && c.blocks[idx]} expected=${B.STONE}`);
