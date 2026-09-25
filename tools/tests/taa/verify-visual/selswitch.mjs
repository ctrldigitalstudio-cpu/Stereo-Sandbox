// Selection outline switching to the adjacent block with a tiny aim change (~4 px of camera
// rotation), as when the player sweeps the crosshair over a wall. Grabs the frames right after.
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'selswitch');
const variants = opt('variants', 'taa@1,taa@0.75,fxaa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
const grab = opt('grab', '1,2,4,8,16').split(',').map(Number);
const g = await boot({ tag, size: opt('size', '800x450') });

// A 5-wide, 2-high stone wall 2.5 blocks in front of the eye, clear air around, stone floor.
function site(x, y, z) {
  const e = [];
  for (let dx = -6; dx <= 6; dx++) for (let dz = -8; dz <= 2; dz++) {
    e.push([x + dx, y - 1, z + dz, 3]);
    for (let dy = 0; dy < 6; dy++) e.push([x + dx, y + dy, z + dz, 0]);
  }
  for (let dx = -2; dx <= 2; dx++) { e.push([x + dx, y, z - 3, 3]); e.push([x + dx, y + 1, z - 3, 3]); }
  return e;
}
const sp = g.sp;
const fx = Math.floor(sp.x), fz = Math.floor(sp.z), fy = Math.floor(sp.y) + 3;
const base = await g.scene({ name: 'wall', time: 0.3, pos: [fx + 0.5, fy, fz + 0.5], yaw: 0, pitch: 0, edits: site, editBase: [fx, fy, fz] });
// Eye at z + 0.5, wall front face at z - 2: distance 2.5. Boundary between the centre block and
// the one to its right is at x + 1 (dx = +0.5 from the eye).
const yawA = -Math.atan2(0.47, 2.5), yawB = -Math.atan2(0.53, 2.5);
const pitch = -Math.atan2(0.12, 2.5);   // eye at y + 1.62: aim at y + 1.5 (upper block)
for (const v of variants) {
  const id = `${v.aa}-${v.scale}`;
  await g.setAA(v.aa, v.scale);
  await g.teleport({ ...base, yaw: yawA, pitch });
  await g.setRender(true);
  await g.frames(1);
  await g.ev(() => { window.__game.renderer.post.resetExposure = true; });
  await g.frames(23);
  const tA = await g.ev(() => JSON.stringify(window.__game.player.target && [window.__game.player.target.x, window.__game.player.target.y, window.__game.player.target.z]));
  await g.save(`${id}-before`);
  await g.teleport({ ...base, yaw: yawB, pitch });
  let n = 0;
  for (const k of grab) {
    if (k - 1 > n) await g.frames(k - 1 - n);
    await g.save(`${id}-after${k}`);
    n = k;
  }
  const tB = await g.ev(() => JSON.stringify(window.__game.player.target && [window.__game.player.target.x, window.__game.player.target.y, window.__game.player.target.z]));
  g.log(`${id} target ${tA} -> ${tB}`);
  await g.setRender(false);
}
await g.close();
