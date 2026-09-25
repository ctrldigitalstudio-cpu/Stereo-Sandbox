// Review check: "Save and quit to title" after travelling, then Play: are the player's chunks loaded?
import { serve, launch, gamePage, frames } from './harness.mjs';
const server = await serve();
const browser = await launch();
const { page } = await gamePage(browser);
await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !window.__game.ui.el.play.disabled, null, { polling: 250 });
await page.evaluate(() => { window.__game.setRender(false); window.__game.ui.opts.onPlay(); });
const chunkOf = () => page.evaluate(() => { const p = window.__game.player.pos; return [Math.floor(p[0] / 16), Math.floor(p[2] / 16)]; });
// Travel ~480 blocks east (like a long walk), wait until the area around the player is streamed in.
await page.evaluate(() => { const g = window.__game, p = g.player.pos; g.teleport(p[0] + 480, 110, p[2]); });
await page.waitForFunction(() => window.__game.world.loadedFraction(3) >= 1, null, { polling: 250 });
console.log('travelled; player chunk', JSON.stringify(await chunkOf()), 'loaded(3) =', await page.evaluate(() => window.__game.world.loadedFraction(3)));
await page.evaluate(() => { window.__game.ui.showPause(); });   // any pause
await page.evaluate(() => window.__game.ui.opts.onQuit());
await frames(page, 30); await page.waitForFunction(() => !window.__game.ui.el.play.disabled && window.__game.state === 'title', null, { polling: 100 });
const r = await page.evaluate(() => {
  const g = window.__game, p = g.player.pos, w = g.world;
  const cx = Math.floor(p[0] / 16), cz = Math.floor(p[2] / 16);
  let have = 0, total = 0;
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) { total++; if (w.chunks.has(`${cx + dx},${cz + dz}`)) have++; }
  return { state: g.state, playEnabled: !g.ui.el.play.disabled, titleCamera: g.camera.pos.map(Math.round), playerPos: p.map(Math.round), playerAreaChunksLoaded: `${have}/${total}` };
});
console.log('on title after quit:', JSON.stringify(r));
await page.evaluate(() => window.__game.ui.opts.onPlay());
await frames(page, 2);
const r2 = await page.evaluate(() => { const g = window.__game, p = g.player.pos; return { state: g.state, blockUnderFeet: g.world.getBlock(p[0], p[1] - 1, p[2]), target: g.player.target }; });
console.log('right after Play:', JSON.stringify(r2), '(-1 = chunk not loaded)');
await browser.close(); server.close();
