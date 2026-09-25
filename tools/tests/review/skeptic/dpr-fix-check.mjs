// Checks which notification mechanisms fire when DPR changes but CSS size does not.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.setContent('<canvas id=c style="width:100vw;height:100vh;display:block"></canvas>');
await page.evaluate(() => {
  const c = document.getElementById('c');
  window.log = { resize: 0, roContent: 0, roDevice: [], mq: 0 };
  addEventListener('resize', () => log.resize++);
  new ResizeObserver(() => log.roContent++).observe(c);
  new ResizeObserver((e) => { const d = e[0].devicePixelContentBoxSize; log.roDevice.push(d ? [d[0].inlineSize, d[0].blockSize] : null); }).observe(c, { box: 'device-pixel-content-box' });
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => log.mq++);
});
await page.waitForTimeout(300);
const before = await page.evaluate(() => JSON.parse(JSON.stringify(log)));
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 180, deviceScaleFactor: 2, mobile: false });
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({ dpr: devicePixelRatio, mq2: matchMedia("(resolution: 2dppx)").matches, clientW: document.getElementById("c").clientWidth, ...log }));
console.log(JSON.stringify({ before, after }));
await browser.close();
