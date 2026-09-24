// Repro helper: double-click Play with the double-click guard disabled vs enabled.
import { startServer, launch, newGamePage, waitReady, frames, LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY, sleep } from './lib.mjs';
import { WorldGen } from '../../../src/worldgen.js';
const server = await startServer();
const browser = await launch();
const spawn = new WorldGen(12345).findSpawn();
for (const guard of [false, true]) {
  for (const lock of [false, true]) {
    const init = lock ? null : () => { Element.prototype.requestPointerLock = function () { return Promise.reject(new DOMException('denied', 'NotAllowedError')); }; };
    const { page, ctx } = await newGamePage(browser, { width: 480, height: 270, init, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 12345, player: { x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0.6, pitch: -1.2 } } } });
    await page.goto(server.base + '/index.html', { waitUntil: 'load' });
    await waitReady(page, 2);
    await page.waitForFunction(() => !document.querySelector('.btn-play').disabled);
    await page.evaluate((guard) => { window.__game.setRender(false); if (!guard) window.__game.player.input.suppressClicks = () => {}; }, guard);
    await page.dblclick('.btn-play');
    await sleep(800);
    console.log(`guard ${guard} lock ${lock}:`, await page.evaluate(() => ({ edits: window.__game.world.edits.size, state: window.__game.state, target: window.__game.player.target && window.__game.player.target.id })));
    await ctx.close();
  }
}
await browser.close(); server.close();
