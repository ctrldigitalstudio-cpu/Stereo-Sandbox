#!/usr/bin/env node
// Screenshots every UI harness screen at desktop and phone sizes in one browser session.
//   node tools/tests/ui/shoot.mjs [--only title,pause] [--sizes 1280x720,400x800] [--nofonts] [--stub] [--extra "&bg=bright"]
// Phone sizes (width < 600) use a touch/mobile context so the phone-only note shows.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const screens = (opt('only', 'title,loading,pause,confirm,settings,controls,inventory,search,hud,debug,underwater')).split(',');
const sizes = opt('sizes', '1280x720,400x800').split(',').map((s) => s.split('x').map(Number));
const noFonts = args.includes('--nofonts');
const extra = opt('extra', '') + (args.includes('--stub') ? '&stub' : '');
const tag = opt('tag', '');
const outDir = path.join(root, 'tools/out');
fs.mkdirSync(outDir, { recursive: true });

const server = await startStaticServer(root);
const port = server.address().port;
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-proxy-server'],
});

// Headless Chromium here doesn't trust the egress proxy's CA, so Google Fonts requests are fetched
// with curl (which does) and fulfilled from a small on-disk cache.
const fontCache = path.join(outDir, 'fontcache');
fs.mkdirSync(fontCache, { recursive: true });
async function serveFont(route) {
  const req = route.request();
  const url = req.url();
  const file = path.join(fontCache, url.replace(/[^a-z0-9]+/gi, '_').slice(-180));
  try {
    if (!fs.existsSync(file)) {
      const body = execFileSync('curl', ['-sSfL', '-A', req.headers()['user-agent'] || 'Mozilla/5.0 Chrome/120', url], { maxBuffer: 1 << 24 });
      fs.writeFileSync(file, body);
    }
    const type = url.includes('googleapis.com/css') ? 'text/css' : 'font/woff2';
    await route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
  } catch (e) {
    await route.abort();
  }
}

let failed = false;
for (const [w, h] of sizes) {
  const mobile = w < 600;
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => (noFonts || !proxy ? r.abort() : serveFont(r)));
  for (const s of screens) {
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') { failed = true; console.log(`[${s} ${w}x${h}] console.error ${m.text()}`); }
      else if (m.type() === 'warning') console.log(`[${s} ${w}x${h}] warn ${m.text()}`);
    });
    page.on('pageerror', (e) => { failed = true; console.log(`[${s} ${w}x${h}] pageerror ${e.stack || e.message}`); });
    const [name, query] = s.split('?');
    await page.goto(`http://127.0.0.1:${port}/tools/tests/ui/index.html?screen=${name}${query ? '&' + query : ''}${extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__done, null, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      const bad = [];
      for (const el of document.querySelectorAll('#ui *')) {
        if (el.closest('[hidden], .screen:not(.is-open)')) continue;
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > innerWidth + 0.5 || r.left < -0.5)) bad.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
      }
      return { scrollW: d.scrollWidth, w: innerWidth, bad: bad.slice(0, 5) };
    });
    if (overflow.bad.length || overflow.scrollW > overflow.w) {
      console.log(`[${s} ${w}x${h}] horizontal overflow: ${JSON.stringify(overflow)}`);
    }
    const file = path.join(outDir, `ui-${name}${query ? '-' + query.replace(/[^a-z0-9]+/gi, '-') : ''}${tag}-${w}x${h}.png`);
    await page.screenshot({ path: file });
    console.log(`shot ${path.relative(root, file)}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
