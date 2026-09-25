// Targeted checks on a flat test site built in front of the camera (seed 12345, near spawn):
// selection outline on an opaque block, block-break particles, held torch sprite, held block while
// strafing. Each variant: converge, grab; spawn particles, grab frames; strafe, grab mid-motion.
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'targeted');
const variants = opt('variants', 'taa@1,taa@0.75,fxaa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
const g = await boot({ tag, size: opt('size', '800x450') });

// Site: a platform of stone at y0, a stone pillar 3 blocks ahead (selection target at eye level),
// a column of bricks and a glowstone to the side, sky behind.
function site(x, y, z) {
  const e = [];
  for (let dx = -6; dx <= 6; dx++) for (let dz = -10; dz <= 2; dz++) {
    e.push([x + dx, y - 1, z + dz, 3]);            // stone floor
    for (let dy = 0; dy < 6; dy++) e.push([x + dx, y + dy, z + dz, 0]);
  }
  e.push([x, y, z - 3, 3], [x, y + 1, z - 3, 3]);   // pillar in front (eye level: y + 1.62)
  for (let dy = 0; dy < 4; dy++) e.push([x - 3, y + dy, z - 6, 26]);
  e.push([x + 3, y, z - 5, 30]);
  return e;
}
const sp = g.sp;
const base = await g.scene({ name: 'site', time: 0.3, pos: [sp.x + 0.5, sp.y + 3, sp.z + 0.5], yaw: 0, pitch: -0.05, edits: site, editBase: [sp.x, sp.y + 3, sp.z] });

for (const v of variants) {
  const id = `${v.aa}-${v.scale}`;
  await g.setAA(v.aa, v.scale);
  await g.teleport(base);
  await g.ev(() => { window.__game.player.selected = 1; });
  await g.setRender(true);
  await g.frames(1);
  await g.ev(() => { window.__game.renderer.post.resetExposure = true; });
  await g.frames(23);
  const tgt = await g.ev(() => JSON.stringify(window.__game.player.target && { x: window.__game.player.target.x, y: window.__game.player.target.y, z: window.__game.player.target.z }));
  g.log(`${id} target ${tgt}`);
  await g.save(`sel-${id}`);
  await g.save(`sel-${id}-next`);
  // Particles: break debris from a block 2.5 blocks ahead, grabbed 4 and 10 frames later.
  await g.ev(() => { const G = window.__game, c = G.camera; G.particles.spawnBlockBreak(Math.floor(c.pos[0]) + 1, Math.floor(c.pos[1]) - 1, Math.floor(c.pos[2]) - 3, 1, [1, 0]); });
  await g.frames(3);
  await g.save(`part-${id}-4`);
  await g.frames(5);
  await g.save(`part-${id}-10`);
  // Held torch sprite, converged.
  await g.ev(() => { window.__game.player.selected = 6; });
  await g.frames(24);
  await g.save(`torch-${id}`);
  // Strafe with the torch in hand, grab mid-motion.
  for (let k = 1; k <= 8; k++) {
    const p = { ...base, pos: [base.pos[0] + 0.1 * k, base.pos[1], base.pos[2]] };
    await g.teleport(p);
    if (k === 8) await g.save(`torch-${id}-strafe8`);
    else await g.frames(1);
  }
  await g.setRender(false);
}
await g.close();
