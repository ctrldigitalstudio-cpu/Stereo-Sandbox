// Independent visual verification run 2 (scratch, follow-up to vv1): 640x360, 60 Hz virtual clock.
// A. forest strafe at the preset scales 0.85 / 0.75 (and 0.5), each with a converged reference at
//    the final pose, then daylight block-break particles; TAA 1 and FXAA particles for comparison.
// B. selection outline on the ground while turning (1 / 0.75 / 0.5 / FXAA).
// C. low sun in view through the forest (light shafts, clouds): TAA 1 / 0.85 / FXAA.
// Output: tools/out/taa-verify-visual/r2/.
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', 'strafe,sel,sun').split(',');
const g = await boot({ tag: opt('tag', 'r2'), size: opt('size', '640x360') });
const V = (s) => { const [aa, sc] = s.split('@'); return { aa, scale: Number(sc || 1) }; };
async function start(v, base, settle) {
  await g.setAA(v.aa, v.scale);
  await g.teleport(base);
  await g.setRender(true);
  await g.frames(1);
  await g.ev(() => { window.__game.renderer.post.resetExposure = true; });
  await g.frames(settle - 1);
}
const tp = (b, dx = 0, dy = 0, dz = 0, dyaw = 0, dpitch = 0) => g.teleport({ pos: [b.pos[0] + dx, b.pos[1] + dy, b.pos[2] + dz], yaw: b.yaw + dyaw, pitch: b.pitch + dpitch });
const stats = () => g.ev(() => { const s = window.__game.renderer.stats; return `${s.renderWidth}x${s.renderHeight}->${s.width}x${s.height} aa=${s.aa} cuts=${s.taaCuts}`; });
// Daylight debris ~2.5 blocks ahead (grass + stone), lit by the sky.
const spawn = () => g.ev(() => {
  const G = window.__game, c = G.camera;
  const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
  G.particles.spawnBlockBreak(Math.floor(c.pos[0] + fx * 2.5), Math.floor(c.pos[1]) - 1, Math.floor(c.pos[2] + fz * 2.5), 1, [1, 0]);
  G.particles.spawnBlockBreak(Math.floor(c.pos[0] + fx * 3 + 1), Math.floor(c.pos[1]), Math.floor(c.pos[2] + fz * 3), 3, [1, 0]);
});

const forest = await g.scene('forest');

if (only.includes('strafe')) {
  const base = forest;
  const sx = Math.cos(base.yaw) * 0.1, sz = -Math.sin(base.yaw) * 0.1;
  for (const vs of ['taa@0.85', 'taa@0.75', 'taa@0.5', 'taa@1', 'fxaa@1']) {
    const v = V(vs), id = `forest-${v.aa}-${v.scale}`, t1 = Date.now();
    const taa = v.aa === 'taa';
    await start(v, base, taa ? 18 : 4);
    if (v.scale < 1) {
      for (let k = 1; k <= 8; k++) {
        await tp(base, sx * k, 0, sz * k);
        if (k === 8) await g.save(`${id}-strafe8`); else await g.frames(1);
      }
      await g.frames(17);
      await g.save(`${id}-strafe8-ref`);
    }
    // Particles at the current pose.
    await spawn();
    await g.frames(3);
    await g.save(`${id}-part4`);
    await g.save(`${id}-part5`);
    g.log(`${id} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
    await g.frames(90);   // let the debris settle / expire before the next variant
  }
}

if (only.includes('sel')) {
  const base = { pos: forest.pos.slice(), yaw: forest.yaw - 0.6, pitch: -0.75 };
  for (const vs of ['taa@1', 'taa@0.75', 'taa@0.5', 'fxaa@1']) {
    const v = V(vs), id = `sel-${v.aa}-${v.scale}`, t1 = Date.now();
    await start(v, base, v.aa === 'taa' ? 18 : 4);
    const tg = await g.ev(() => { const t = window.__game.player.target; return t ? `${t.x},${t.y},${t.z}` : 'none'; });
    await g.save(`${id}-s`);
    for (let k = 1; k <= 6; k++) {
      await tp(base, 0, 0, 0, 0.035 * k);
      if (k === 6) await g.save(`${id}-yaw6`); else await g.frames(1);
    }
    g.log(`${id} target ${tg} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}

if (only.includes('sun')) {
  await g.setTime(0.478);
  await g.setRender(true);
  await g.frames(2);
  const sd = await g.ev(() => Array.from(window.__game.renderer.viewInfo.sunDir));
  await g.setRender(false);
  const yaw = Math.atan2(-sd[0], -sd[2]);
  const pitch = Math.asin(sd[1]) - 0.12;
  const base = { pos: forest.pos.slice(), yaw, pitch };
  g.log(`sun ${sd.map((x) => x.toFixed(3))} yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}`);
  for (const vs of ['taa@1', 'taa@0.85', 'fxaa@1']) {
    const v = V(vs), id = `sun-${v.aa}-${v.scale}`, t1 = Date.now();
    await start(v, base, v.aa === 'taa' ? 18 : 4);
    await g.save(`${id}-f0`);
    await g.save(`${id}-f1`);
    if (v.scale === 1) {
      for (let k = 1; k <= 6; k++) {
        await tp(base, 0, 0, 0, 0.035 * k);
        if (k === 6) await g.save(`${id}-yaw6`); else await g.frames(1);
      }
    }
    g.log(`${id} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}
await g.close();
