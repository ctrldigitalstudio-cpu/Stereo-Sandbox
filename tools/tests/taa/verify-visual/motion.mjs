// Moving camera: converge at a static pose, then move a little every frame (60 Hz virtual time)
// and grab frames mid-motion; then stop and grab the recovery.
//   --motion strafe|yaw|yawfast|forward|pitch|fall  --speed k
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'motion');
const sceneNames = opt('scenes', 'forest').split(',');
const variants = opt('variants', 'taa@1,taa@0.75,fxaa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
const motions = opt('motion', 'strafe').split(',');
const steps = Number(opt('steps', '12'));
const grab = opt('grab', '4,12').split(',').map(Number);
const after = opt('after', '').split(',').filter(Boolean).map(Number);   // frames after stopping
const speed = Number(opt('speed', '1'));
const settle = Number(opt('settle', '24'));

const EXTRA = {
  canopy: { name: 'canopy', time: 0.3, pos: [15.5, 62, 28.5], yaw: 2.5, pitch: 0.35, ground: true },
  ridges: { name: 'ridges', time: 0.36, pos: [-40, 100, 40], yaw: 0.9, pitch: -0.12, far: true },
  stars: { name: 'stars', time: 0.8, pos: [0, 110, 0], yaw: 0.6, pitch: 0.6 },
  shafts: { name: 'shafts', time: 0.47, pos: [15.5, 62, 28.5], yaw: -1.2, pitch: 0.05, ground: true },
};

// Per-frame deltas at speed 1 (60 Hz): strafe 0.1 b/f (6 b/s), forward 0.18 b/f (creative flight
// ~11 b/s), yaw 0.026 rad/f (90 deg/s), yawfast 0.07 rad/f (240 deg/s flick), pitch 0.02 rad/f.
function poseAt(base, k, motion) {
  const p = { ...base, pos: base.pos.slice() };
  const f = k * speed;
  if (motion === 'strafe') { p.pos[0] += Math.cos(base.yaw) * 0.1 * f; p.pos[2] -= Math.sin(base.yaw) * 0.1 * f; }
  else if (motion === 'forward') { p.pos[0] -= Math.sin(base.yaw) * 0.18 * f; p.pos[2] -= Math.cos(base.yaw) * 0.18 * f; }
  else if (motion === 'yaw') p.yaw += 0.026 * f;
  else if (motion === 'yawfast') p.yaw += 0.07 * f;
  else if (motion === 'pitch') p.pitch += 0.02 * f;
  else if (motion === 'fall') p.pos[1] -= 0.25 * f;
  else if (motion === 'still') {}
  return p;
}

const g = await boot({ tag, size: opt('size', '800x450') });
for (const name of sceneNames) {
  const s = EXTRA[name] || name;
  const base = await g.scene(s);
  for (const motion of motions) {
    for (const v of variants) {
      const t1 = Date.now();
      await g.setAA(v.aa, v.scale);
      await g.teleport(base);
      await g.setRender(true);
      await g.frames(1);
      await g.ev(() => { window.__game.renderer.post.resetExposure = true; });
      await g.frames(settle - 1);
      const id = `${name}-${v.aa}-${v.scale}`;
      await g.save(`${id}-${motion}0`);
      let last = base;
      for (let k = 1; k <= steps; k++) {
        last = poseAt(base, k, motion);
        await g.teleport(last);
        if (grab.includes(k)) await g.save(`${id}-${motion}${k}`);
        else await g.frames(1);
      }
      for (const a of after) {
        await g.frames(Math.max(0, a - 1));
        await g.save(`${id}-${motion}${steps}-stop${a}`);
      }
      // Reference: the final pose, converged (static).
      if (opt('ref', '1') === '1') {
        await g.frames(24);
        await g.save(`${id}-${motion}${steps}-ref`);
      }
      g.log(`${id} ${motion} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
      await g.setRender(false);
    }
  }
}
await g.close();
