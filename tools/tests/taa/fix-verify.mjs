// Re-check of the TAA review findings after the fixes: one browser session at 640x360 on a 60 Hz
// virtual clock (tools/tests/taa/verify-visual/harness.mjs), the same poses as the reviewers'
// vv1.mjs / vv2.mjs so their images (tools/out/taa-verify-visual/r1, r2) are the "before".
// Segments: forest static / strafe / turn at TAA 1, 0.75, 0.5 (waving plants, 0.5 fringe, mip bias,
// motion softness); block-break particles at 1 and 0.5; the 3.5-block hop; held torch at night;
// stars; forward flight; sideways flight under clouds.
//   node tools/tests/taa/fix-verify.mjs [--only forest,part,hop,torch,stars,fly,clouds] [--tag r1]
// Output: tools/out/taa-fix/<tag>/.
import { boot } from './verify-visual/harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', 'forest,part,hop,torch,stars,fly,clouds').split(',');
const g = await boot({ tag: `../taa-fix/${opt('tag', 'r1')}`, size: opt('size', '640x360') });
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
const stats = () => g.ev(() => { const s = window.__game.renderer.stats; return `${s.renderWidth}x${s.renderHeight}->${s.width}x${s.height} aa=${s.aa} cuts=${s.taaCuts} motion=${!!window.__game.renderer.motionTex}`; });
const T = () => Date.now();
const secs = (t) => `${((Date.now() - t) / 1000).toFixed(0)}s`;

const forest = await g.scene('forest');

// ---- Forest: static, strafe 0.1 b/frame (grab 4, 8), turn 0.035 rad/frame (grab 6) + refs ------
if (only.includes('forest')) {
  await g.ev(() => { window.__game.player.selected = 0; });
  const base = forest;
  for (const vs of ['taa@1', 'taa@0.5', 'taa@0.75']) {
    const v = V(vs), id = `forest-${v.aa}-${v.scale}`, t1 = T();
    await start(v, base, 18);
    await g.save(`${id}-s`);
    const sx = Math.cos(base.yaw) * 0.1, sz = -Math.sin(base.yaw) * 0.1;
    for (let k = 1; k <= 8; k++) {
      await tp(base, sx * k, 0, sz * k);
      if (k === 4 || k === 8) await g.save(`${id}-strafe${k}`); else await g.frames(1);
    }
    if (v.scale !== 0.75) {
      const b2 = { pos: [base.pos[0] + sx * 8, base.pos[1], base.pos[2] + sz * 8], yaw: base.yaw, pitch: base.pitch };
      for (let k = 1; k <= 6; k++) {
        await tp(b2, 0, 0, 0, 0.035 * k);
        if (k === 6) await g.save(`${id}-yaw6`); else await g.frames(1);
      }
      await g.frames(15);
      await g.save(`${id}-yaw6-ref`);
    }
    g.log(`${id} ${await stats()} ${secs(t1)}`);
    await g.setRender(false);
  }
}

// ---- Daylight block-break particles (vv2 pose: the forest spot) ---------------------------------
if (only.includes('part')) {
  const spawn = () => g.ev(() => {
    const G = window.__game, c = G.camera;
    const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
    G.particles.spawnBlockBreak(Math.floor(c.pos[0] + fx * 2.5), Math.floor(c.pos[1]) - 1, Math.floor(c.pos[2] + fz * 2.5), 1, [1, 0]);
    G.particles.spawnBlockBreak(Math.floor(c.pos[0] + fx * 3 + 1), Math.floor(c.pos[1]), Math.floor(c.pos[2] + fz * 3), 3, [1, 0]);
  });
  for (const vs of ['taa@0.5', 'taa@1']) {
    const v = V(vs), id = `part-${v.aa}-${v.scale}`, t1 = T();
    await start(v, forest, 18);
    await spawn();
    await g.frames(3);
    await g.save(`${id}-4`);
    await g.save(`${id}-5`);
    g.log(`${id} ${await stats()} ${secs(t1)}`);
    await g.setRender(false);
    await g.frames(90);
  }
}

// ---- 3.5-block hop (below the 4-block cut) ------------------------------------------------------
if (only.includes('hop')) {
  const A = forest, t1 = T();
  await start(V('taa@1'), A, 18);
  await g.save('hop-before');
  await tp(A, -Math.sin(A.yaw) * 3.5, 0, -Math.cos(A.yaw) * 3.5);
  await g.save('hop-after1');
  await g.save('hop-after2');
  await g.frames(14);
  await g.save('hop-ref');
  g.log(`hop ${await stats()} ${secs(t1)}`);
  await g.setRender(false);
}

// ---- Held torch at night (torches-close), consecutive frames -------------------------------------
if (only.includes('torch')) {
  const base = await g.scene('torches-close');
  for (const vs of ['taa@1', 'taa@0.5']) {
    const v = V(vs), id = `torch-${v.aa}-${v.scale}`, t1 = T();
    await g.ev(() => { window.__game.player.selected = 6; });
    await start(v, base, 18);
    await g.save(`${id}-s`);
    await g.save(`${id}-s2`);
    g.log(`${id} ${await stats()} ${secs(t1)}`);
    await g.setRender(false);
  }
}

// ---- Night stars: converged, consecutive, slow turn ---------------------------------------------
if (only.includes('stars')) {
  const base = await g.scene({ name: 'stars', time: 0.8, pos: [0.5, 110, 0.5], yaw: 0.6, pitch: 0.45 }, { settle: 2 });
  for (const vs of ['taa@1', 'taa@0.75']) {
    const v = V(vs), id = `stars-${v.aa}-${v.scale}`, t1 = T();
    await start(v, base, 18);
    await g.save(`${id}-f0`);
    await g.save(`${id}-f1`);
    if (v.scale === 1) {
      for (let k = 1; k <= 5; k++) {
        await tp(base, 0, 0, 0, 0.02 * k);
        if (k === 5) await g.save(`${id}-yaw5`); else await g.frames(1);
      }
    }
    g.log(`${id} ${await stats()} ${secs(t1)}`);
    await g.setRender(false);
  }
}

// ---- Forward flight over the forest (~11 b/s) -----------------------------------------------------
if (only.includes('fly')) {
  const base = { pos: [forest.pos[0], forest.pos[1] + 9, forest.pos[2]], yaw: forest.yaw + 0.4, pitch: -0.22 };
  await g.teleport(base);
  const fx = -Math.sin(base.yaw) * 0.18, fz = -Math.cos(base.yaw) * 0.18;
  const v = V('taa@1'), id = 'fly-taa-1', t1 = T();
  await start(v, base, 18);
  for (let k = 1; k <= 10; k++) {
    await tp(base, fx * k, 0, fz * k);
    if (k === 10) await g.save(`${id}-fwd10`); else await g.frames(1);
  }
  await g.frames(15);
  await g.save(`${id}-fwd10-ref`);
  g.log(`${id} ${await stats()} ${secs(t1)}`);
  await g.setRender(false);
}

// ---- Sideways flight at sprint-flying speed (0.35 b/frame) under the clouds, looking up ----------
if (only.includes('clouds')) {
  const base = { pos: [forest.pos[0], forest.pos[1] + 30, forest.pos[2]], yaw: forest.yaw, pitch: 0.75 };
  await g.setTime(0.3);
  await g.teleport(base);
  await g.setRender(true);
  await g.frames(2);
  const t1 = T();
  await start(V('taa@1'), base, 18);
  await g.save('clouds-s');
  const sx = Math.cos(base.yaw) * 0.35, sz = -Math.sin(base.yaw) * 0.35;
  for (let k = 1; k <= 8; k++) {
    await tp(base, sx * k, 0, sz * k);
    if (k === 8) await g.save('clouds-strafe8'); else await g.frames(1);
  }
  await g.frames(15);
  await g.save('clouds-strafe8-ref');
  g.log(`clouds ${await stats()} ${secs(t1)}`);
  await g.setRender(false);
}
await g.close();
