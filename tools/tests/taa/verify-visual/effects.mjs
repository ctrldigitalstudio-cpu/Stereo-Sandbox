// Static camera, animated content (60 Hz virtual time): converge, then grab K consecutive frames.
// Optional particles: --particles break|splash (spawned in front of the camera each few frames).
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'effects');
const sceneNames = opt('scenes', 'water').split(',');
const variants = opt('variants', 'taa@1,fxaa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
const K = Number(opt('count', '3'));
const settle = Number(opt('settle', '24'));
const particles = opt('particles', null);
const selected = opt('selected', null);

const EXTRA = {
  canopy: { name: 'canopy', time: 0.3, pos: [15.5, 62, 28.5], yaw: 2.5, pitch: 0.35, ground: true },
  ridges: { name: 'ridges', time: 0.36, pos: [-40, 100, 40], yaw: 0.9, pitch: -0.12, far: true },
  // Night sky, looking up (stars + moon), high above ground.
  stars: { name: 'stars', time: 0.8, pos: [0, 110, 0], yaw: 0.6, pitch: 0.6 },
  // Sunset light shafts through the forest.
  shafts: { name: 'shafts', time: 0.47, pos: [15.5, 62, 28.5], yaw: -1.2, pitch: 0.05, ground: true },
};

const g = await boot({ tag, size: opt('size', '800x450') });
for (const name of sceneNames) {
  const s = EXTRA[name] || name;
  const base = await g.scene(s);
  if (selected !== null) await g.ev((k) => { window.__game.player.selected = k; }, Number(selected));
  for (const v of variants) {
    const t1 = Date.now();
    await g.setAA(v.aa, v.scale);
    await g.teleport(base);
    if (opt('time', null)) await g.setTime(Number(opt('time')));
    else await g.setTime(base.time);
    await g.setRender(true);
    await g.frames(1);
    await g.ev(() => { window.__game.renderer.post.resetExposure = true; });
    const spawn = () => g.ev((kind) => {
      const G = window.__game, c = G.camera;
      const fx = -Math.sin(c.yaw) * Math.cos(c.pitch), fy = Math.sin(c.pitch), fz = -Math.cos(c.yaw) * Math.cos(c.pitch);
      const x = c.pos[0] + fx * 3, y = c.pos[1] + fy * 3 - 0.5, z = c.pos[2] + fz * 3;
      if (kind === 'splash') G.particles.spawnSplash(x, y, z, [1, 0]);
      else G.particles.spawnBlockBreak(Math.floor(x), Math.floor(y), Math.floor(z), 1, [1, 0]);
    }, particles);
    for (let f = 1; f < settle; f++) {
      if (particles && f >= settle - 12 && f % 6 === 0) await spawn();
      await g.frames(1);
    }
    const id = `${name}-${v.aa}-${v.scale}`;
    for (let k = 0; k < K; k++) await g.save(`${id}-f${k}`);
    g.log(`${id} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}
await g.close();
