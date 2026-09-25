// Independent visual verification run 1 (scratch): one browser session at 640x360, 60 Hz virtual
// clock. Segments (in priority order): forest static/strafe/turn at TAA 1 / 0.75 / 0.5 vs FXAA with
// the held block in view; camera cuts (far teleport, 3.5-block hop); night stars + turn; torches with
// a held torch + strafe + block-break particles; water + underwater; sunset light shafts / clouds;
// forward flight. Output: tools/out/taa-verify-visual/r1/.
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', 'forest,cut,night,torches,water,shafts,fly').split(',');
const g = await boot({ tag: opt('tag', 'r1'), size: opt('size', '640x360') });
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

// ---- 1. Forest: static convergence, strafe, turn, per scale; held grass block in view ----------
if (only.includes('forest')) {
  const base = await g.scene('forest');
  await g.ev(() => { window.__game.player.selected = 0; });
  for (const vs of ['taa@1', 'taa@0.75', 'taa@0.5', 'fxaa@1']) {
    const v = V(vs), t1 = Date.now();
    const id = `forest-${v.aa}-${v.scale}`;
    await start(v, base, v.aa === 'taa' ? 18 : 4);
    await g.save(`${id}-s`);
    if (v.aa === 'taa') await g.save(`${id}-s2`);
    // Strafe right at 0.1 block / frame (6 b/s), grab at 4 and 8.
    const sx = Math.cos(base.yaw) * 0.1, sz = -Math.sin(base.yaw) * 0.1;
    for (let k = 1; k <= 8; k++) {
      await tp(base, sx * k, 0, sz * k);
      if (k === 4 || k === 8) await g.save(`${id}-strafe${k}`); else await g.frames(1);
    }
    // Then turn left at 0.035 rad / frame (120 deg/s) from the strafed spot, grab at 6.
    const b2 = { pos: [base.pos[0] + sx * 8, base.pos[1], base.pos[2] + sz * 8], yaw: base.yaw, pitch: base.pitch };
    for (let k = 1; k <= 6; k++) {
      await tp(b2, 0, 0, 0, 0.035 * k);
      if (k === 6) await g.save(`${id}-yaw6`); else await g.frames(1);
    }
    if (v.aa === 'taa' && v.scale === 1) {
      await g.frames(15);
      await g.save(`${id}-yaw6-ref`);
    }
    g.log(`${id} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}

// ---- 2. Camera cuts: far teleport inside the loaded area, and a 3.5-block hop (below the cut) --
if (only.includes('cut')) {
  const A = await g.scene('forest', { settle: 4 });
  const bx = A.pos[0] + 22, bz = A.pos[2] - 18;
  const by = await g.ev(([x, z]) => window.__game.gen.heightAt(Math.floor(x), Math.floor(z)) + 1.5, [bx, bz]);
  const B = { pos: [bx, by, bz], yaw: A.yaw + 1.6, pitch: -0.1 };
  const t1 = Date.now();
  await start(V('taa@1'), A, 18);
  await g.save('cut-far-before');
  await g.teleport(B);
  await g.save('cut-far-after1');
  await g.save('cut-far-after2');
  await g.frames(2);
  await g.save('cut-far-after5');
  await g.frames(14);
  await g.save('cut-far-ref');
  g.log(`cut far ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  // Hop 3.5 blocks forward (under the 4-block cut): reprojected, big disocclusions.
  await g.teleport(A);
  await g.frames(18);
  await g.save('cut-hop-before');
  await tp(A, -Math.sin(A.yaw) * 3.5, 0, -Math.cos(A.yaw) * 3.5);
  await g.save('cut-hop-after1');
  await g.save('cut-hop-after2');
  await g.frames(14);
  await g.save('cut-hop-ref');
  g.log(`cut hop ${await stats()}`);
  await g.setRender(false);
}

// ---- 3. Night sky: stars, converged + consecutive + slow turn ----------------------------------
if (only.includes('night')) {
  const base = await g.scene({ name: 'stars', time: 0.8, pos: [0.5, 110, 0.5], yaw: 0.6, pitch: 0.45 }, { settle: 2 });
  for (const vs of ['taa@1', 'taa@0.75', 'fxaa@1']) {
    const v = V(vs), id = `stars-${v.aa}-${v.scale}`, t1 = Date.now();
    await start(v, base, v.aa === 'taa' ? 18 : 4);
    await g.save(`${id}-f0`);
    await g.save(`${id}-f1`);
    await g.save(`${id}-f2`);
    if (v.scale === 1) {
      for (let k = 1; k <= 5; k++) {
        await tp(base, 0, 0, 0, 0.02 * k);
        if (k === 5) await g.save(`${id}-yaw5`); else await g.frames(1);
      }
    }
    g.log(`${id} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}

// ---- 4. Torches at night, held torch, strafe, block-break particles ----------------------------
if (only.includes('torches')) {
  const base = await g.scene('torches-close');
  for (const vs of ['taa@1', 'taa@0.5', 'fxaa@1']) {
    const v = V(vs), id = `torch-${v.aa}-${v.scale}`, t1 = Date.now();
    await g.ev(() => { window.__game.player.selected = 6; });
    await start(v, base, v.aa === 'taa' ? 18 : 4);
    await g.save(`${id}-s`);
    await g.save(`${id}-s2`);
    const sx = Math.cos(base.yaw) * 0.1, sz = -Math.sin(base.yaw) * 0.1;
    for (let k = 1; k <= 6; k++) {
      await tp(base, sx * k, 0, sz * k);
      if (k === 6) await g.save(`${id}-strafe6`); else await g.frames(1);
    }
    await tp(base);
    await g.frames(v.aa === 'taa' ? 10 : 2);
    await g.ev(() => {
      const G = window.__game, c = G.camera;
      const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
      G.particles.spawnBlockBreak(Math.floor(c.pos[0] + fx * 2.5), Math.floor(c.pos[1]) - 1, Math.floor(c.pos[2] + fz * 2.5), 3, [1, 0]);
      G.particles.spawnBlockBreak(Math.floor(c.pos[0] + fx * 3.5 + 1), Math.floor(c.pos[1]), Math.floor(c.pos[2] + fz * 3.5), 1, [1, 0]);
    });
    await g.frames(3);
    await g.save(`${id}-part4`);
    await g.save(`${id}-part5`);
    g.log(`${id} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}

// ---- 5. Water surface and underwater: converged + consecutive frames (animated waves) -----------
if (only.includes('water')) {
  for (const name of ['water', 'underwater']) {
    const s = { ...g.scenes.find((x) => x.name === name), far: false };
    const base = await g.scene(s);
    await g.ev(() => { window.__game.player.selected = 1; });
    for (const vs of ['taa@1', 'taa@0.75', 'fxaa@1']) {
      const v = V(vs), id = `${name}-${v.aa}-${v.scale}`, t1 = Date.now();
      await start(v, base, v.aa === 'taa' ? 18 : 4);
      await g.save(`${id}-f0`);
      await g.save(`${id}-f1`);
      if (v.scale === 1) {
        const sx = Math.cos(base.yaw) * 0.1, sz = -Math.sin(base.yaw) * 0.1;
        for (let k = 1; k <= 6; k++) {
          await tp(base, sx * k, 0, sz * k);
          if (k === 6) await g.save(`${id}-strafe6`); else await g.frames(1);
        }
      }
      g.log(`${id} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
      await g.setRender(false);
    }
  }
}

// ---- 6. Sunset light shafts through the forest + clouds ----------------------------------------
if (only.includes('shafts')) {
  const base = await g.scene({ name: 'shafts', time: 0.47, pos: [15.5, 62, 28.5], yaw: -1.2, pitch: 0.12, ground: true }, { settle: 2 });
  for (const vs of ['taa@1', 'taa@0.75', 'fxaa@1']) {
    const v = V(vs), id = `shafts-${v.aa}-${v.scale}`, t1 = Date.now();
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

// ---- 7. Forward flight over the forest (creative flight ~11 b/s) -------------------------------
if (only.includes('fly')) {
  const f = await g.scene('forest', { settle: 2 });
  const base = { pos: [f.pos[0], f.pos[1] + 9, f.pos[2]], yaw: f.yaw + 0.4, pitch: -0.22 };
  const fx = -Math.sin(base.yaw) * 0.18, fz = -Math.cos(base.yaw) * 0.18;
  for (const vs of ['taa@1', 'taa@0.75', 'fxaa@1']) {
    const v = V(vs), id = `fly-${v.aa}-${v.scale}`, t1 = Date.now();
    await start(v, base, v.aa === 'taa' ? 18 : 4);
    for (let k = 1; k <= 10; k++) {
      await tp(base, fx * k, 0, fz * k);
      if (k === 10) await g.save(`${id}-fwd10`); else await g.frames(1);
    }
    if (v.aa === 'taa' && v.scale === 1) { await g.frames(15); await g.save(`${id}-fwd10-ref`); }
    g.log(`${id} ${await stats()} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}
await g.close();
