#!/usr/bin/env node
// The title screen at the sizes people actually use: the "Stereo Sandbox" wordmark, tagline,
// Play and the menu fit on screen (no clipping, no horizontal scroll), with the web fonts and
// with the fallback fonts (offline). Screenshots in tools/out/gameplay-title-WxH.png.
//   node tools/tests/gameplay/title-layout.mjs

import { startServer, launch, newGamePage, waitReady, frames, reporter, sleep, outDir, LIGHT_SETTINGS, SETTINGS_KEY, SAVE_KEY } from './lib.mjs';
import path from 'node:path';

const { log, check, finish } = reporter('title-layout');
const server = await startServer();
const browser = await launch();
const sizes = [[1280, 720], [400, 800], [640, 360], [960, 540], [320, 568], [1920, 1080], [480, 270], [320, 200], [800, 300]];

for (const offline of [false, true]) {
  for (const [w, h] of offline ? [[1280, 720], [400, 800]] : sizes) {
    const { page, ctx, errors } = await newGamePage(browser, { width: w, height: h, storage: { [SETTINGS_KEY]: LIGHT_SETTINGS, [SAVE_KEY]: { seed: 12345 } } });
    if (offline) await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.goto(`${server.base}/index.html`, { waitUntil: 'load' });
    await waitReady(page, 2);
    await page.waitForFunction(() => !document.querySelector('.btn-play').disabled, null, { polling: 250 });
    await page.evaluate(() => document.fonts.ready);
    await frames(page, 2);
    await page.evaluate(() => window.__game.setRender(false));
    await sleep(700);   // boot splash cross-fade
    const m = await page.evaluate(() => {
      const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
      const logo = document.querySelector('.title-screen:not(.boot) .logo');
      const words = [...logo.querySelectorAll('.logo-word')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; });
      return {
        logo: box('.title-screen:not(.boot) .logo'), logoScroll: logo.scrollWidth, logoClient: logo.clientWidth,
        text: logo.textContent, words, tagline: box('.title-screen:not(.boot) .tagline'), play: box('.btn-play'),
        menu: box('.title-screen:not(.boot) .title-menu'), footer: box('.title-footer'),
        scrollW: document.scrollingElement.scrollWidth, scrollH: document.scrollingElement.scrollHeight,
        silkscreen: document.fonts.check('16px Silkscreen'), fontSize: getComputedStyle(logo).fontSize,
      };
    });
    const tag = `${w}x${h}${offline ? ' offline' : ''}`;
    log(`${tag}: font ${m.fontSize} (Silkscreen ${m.silkscreen}), logo ${Math.round(m.logo.w)}x${Math.round(m.logo.h)} at ${Math.round(m.logo.l)},${Math.round(m.logo.t)} words ${JSON.stringify(m.words)}`);
    const inside = (b) => b && b.l >= 0 && b.r <= w + 0.5 && b.t >= 0 && b.b <= h + 0.5;
    check(m.text.replace(/\s+/g, ' ').trim() === 'Stereo Sandbox', `${tag}: wordmark reads "Stereo Sandbox"`);
    check(inside(m.logo) && m.logoScroll <= m.logoClient + 1, `${tag}: wordmark fits (${Math.round(m.logo.l)}..${Math.round(m.logo.r)} of ${w})`);
    check(inside(m.tagline) && inside(m.play) && inside(m.menu), `${tag}: tagline, Play and menu on screen`);
    check(!m.menu || !m.logo || m.menu.t >= m.tagline.b, `${tag}: menu below the tagline (no overlap)`);
    check(m.scrollW <= w && m.scrollH <= h, `${tag}: no page scroll (${m.scrollW}x${m.scrollH})`);
    if (w <= 560 && h > 480) check(m.words.length === 2 && m.words[1][1] > m.words[0][1], `${tag}: words stack on narrow screens`);
    else check(m.words.length === 2 && m.words[1][1] === m.words[0][1], `${tag}: one line on wide screens`);
    const file = path.join(outDir, `gameplay-title-${w}x${h}${offline ? '-offline' : ''}.png`);
    await page.screenshot({ path: file, timeout: 120000 });
    log(`shot ${path.relative(path.join(outDir, '../..'), file)}`);
    check(errors.length === 0, `${tag}: no page errors ${errors.slice(0, 2).join(' | ')}`);
    await ctx.close();
  }
}

await browser.close();
server.close();
process.exit(finish());
