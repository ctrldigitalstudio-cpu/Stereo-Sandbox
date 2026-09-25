// Review check: worker chunk cache after the player edits one block in many chunks and moves on.
import { WorldService } from '../../../src/worker.js';
import { NUM_BLOCKS, B } from '../../../src/blocks.js';
const svc = new WorldService({ post: () => {}, schedule: () => {} });
svc.handle({ type: 'init', seed: 1, faceLayers: new Uint16Array(NUM_BLOCKS * 6), edits: [] });
const RD = 4;
let held = [];
for (let step = 0; step < 300; step++) {
  const cx = step, cz = 0;                       // fly east one chunk per step
  const keys = [];
  for (let dz = -RD; dz <= RD; dz++) for (let dx = -RD; dx <= RD; dx++) if (dx * dx + dz * dz <= (RD + 0.5) ** 2) keys.push([cx + dx, cz + dz]);
  svc.handle({ type: 'unload', keys: held.filter(([x]) => x < cx - RD - 2) });
  held = held.filter(([x]) => x >= cx - RD - 2);
  svc.handle({ type: 'want', keys });
  svc.drain();
  for (const k of keys) if (!held.some(([a, b]) => a === k[0] && b === k[1])) held.push(k);
  svc.handle({ type: 'set', x: cx * 16 + 3, y: 70, z: 5, id: B.STONE }); // break/place one block per chunk flown over
  svc.drain();
}
const edited = [...svc.chunks.values()].filter((c) => c.edited).length;
console.log(`worker chunks cached: ${svc.chunks.size} (edited, never evicted: ${edited}); main holds ~${held.length}; ~${(svc.chunks.size * 34.3 / 1024).toFixed(1)} MB`);
