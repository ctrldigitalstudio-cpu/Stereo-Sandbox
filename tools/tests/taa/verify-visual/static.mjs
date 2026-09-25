// Static-camera convergence: each scene x variant, N frames at 60 Hz virtual time, then two
// consecutive captures (stability) .
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tag = opt('tag', 'static');
const sceneNames = opt('scenes', 'forest').split(',');
const variants = opt('variants', 'taa@1,taa@0.75,taa@0.5,fxaa@1').split(',').map((v) => { const [aa, s] = v.split('@'); return { aa, scale: Number(s || 1) }; });
const N = Number(opt('frames', '28'));
const pair = opt('pair', '1') === '1';

const EXTRA = {
  canopy: { name: 'canopy', time: 0.3, pos: [15.5, 62, 28.5], yaw: 2.5, pitch: 0.35, ground: true },
  ridges: { name: 'ridges', time: 0.36, pos: [-40, 100, 40], yaw: 0.9, pitch: -0.12, far: true },
};
const g = await boot({ tag, size: opt('size', '800x450') });
for (const name of sceneNames) {
  const s = EXTRA[name] || name;
  const base = await g.scene(s);
  for (const v of variants) {
    const t1 = Date.now();
    await g.setAA(v.aa, v.scale);
    await g.teleport(base);
    await g.setRender(true);
    await g.frames(1);
    await g.ev(() => { window.__game.renderer.post.resetExposure = true; });
    await g.frames(N - 1);
    const id = `${name}-${v.aa}-${v.scale}`;
    await g.save(id);
    if (pair) await g.save(id + '-next');
    const st = await g.ev(() => { const s = window.__game.renderer.stats; return `${s.renderWidth}x${s.renderHeight}->${s.width}x${s.height} aa=${s.aa}`; });
    g.log(`${id} ${st} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    await g.setRender(false);
  }
}
await g.close();
