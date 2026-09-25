// Camera cuts and near-cuts: converge at A, jump to B, grab the frames right after.
//   cases: far (teleport across the map), near3 (3.5 blocks: under the 4-block cut), turn50 (50 deg
//   in one frame: under the 60 deg cut), time (setTime jump), scale (renderScale change mid-play)
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'teleport');
const cases = opt('cases', 'far,near3,turn50,time,scale').split(',');
const variants = opt('variants', 'taa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
const grab = opt('grab', '1,2,3,6').split(',').map(Number);

const g = await boot({ tag, size: opt('size', '800x450') });
const A = await g.scene('forest');
// Preload destination B (the 'afternoon' view) so the teleport lands on loaded chunks, then return.
const B = await g.scene('afternoon');
await g.scene('forest');
for (const v of variants) {
  for (const c of cases) {
    const t1 = Date.now();
    await g.setAA(v.aa, v.scale);
    await g.teleport(A);
    await g.setTime(A.time);
    await g.setRender(true);
    await g.frames(1);
    await g.ev(() => { window.__game.renderer.post.resetExposure = true; });
    await g.frames(23);
    const id = `${c}-${v.aa}-${v.scale}`;
    await g.save(`${id}-before`);
    const cuts0 = await g.ev(() => window.__game.renderer.stats.taaCuts);
    if (c === 'far') await g.teleport(B);
    else if (c === 'near3') await g.teleport({ ...A, pos: [A.pos[0] - Math.sin(A.yaw) * 3.5, A.pos[1], A.pos[2] - Math.cos(A.yaw) * 3.5] });
    else if (c === 'turn50') await g.teleport({ ...A, yaw: A.yaw + (50 * Math.PI) / 180 });
    else if (c === 'time') await g.setTime(0.47);
    else if (c === 'scale') await g.ev((s) => window.__game.setSettings({ renderScale: s }), v.scale > 0.6 ? 0.5 : 1);
    let n = 0;
    for (const k of grab) {
      if (k - 1 > n) { await g.frames(k - 1 - n); }
      await g.save(`${id}-after${k}`);
      n = k;
    }
    const cuts1 = await g.ev(() => window.__game.renderer.stats.taaCuts);
    g.log(`${id} cuts ${cuts0}->${cuts1} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
    if (c === 'far') { await g.teleport(A); await g.frames(3); }
  }
}
await g.close();
