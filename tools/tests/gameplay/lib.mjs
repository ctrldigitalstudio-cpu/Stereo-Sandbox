// Shared harness for the gameplay tests: a static server (with CORS, so opaque-origin iframes can
// load the dev modules), headless Chromium on SwiftShader, Google Fonts served from a local cache
// (headless Chromium here doesn't trust the sandbox proxy's certificate), error collection,
// frame-synchronised waits and a tiny check/report helper.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

export { chromium };
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const outDir = path.join(root, 'tools/out');
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
export const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
export const flag = (n) => args.includes('--' + n);

// Light settings for pure gameplay tests (normal mode honours them; ?test overrides a few).
export const LIGHT_SETTINGS = {
  preset: 'custom', renderDistance: 4, renderScale: 0.5, autoResolution: false, shadows: false, pcss: false,
  volumetrics: 0, clouds: 0, ssr: 0, bloom: true, fxaa: false, dayLength: 1200,
};
export const SETTINGS_KEY = 'stereo-sandbox.settings.v1';
export const SAVE_KEY = 'stereo-sandbox.save.v1';
export const LEGACY_SAVE_KEY = 'blockvale.save.v1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// Serves the repo; `pages` maps extra URL paths to generated HTML (harness pages).
export function startServer(pages = {}) {
  const server = http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (pages[url] != null) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(typeof pages[url] === 'function' ? pages[url](req) : pages[url]);
      return;
    }
    let file = path.join(root, url);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, headers); res.end('not found'); return; }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    server.base = `http://127.0.0.1:${server.address().port}`;
    resolve(server);
  }));
}

export async function launch(extraArgs = []) {
  return chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
}

// Google Fonts through curl (which trusts the proxy CA) with an on-disk cache.
export async function routeFonts(ctx) {
  const cache = path.join(outDir, 'fontcache');
  fs.mkdirSync(cache, { recursive: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    const url = route.request().url();
    const file = path.join(cache, url.replace(/[^a-z0-9]+/gi, '_').slice(-180));
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, execFileSync('curl', ['-sSfL', '-A', route.request().headers()['user-agent'] || 'Mozilla/5.0', url], { timeout: 20000 }));
      await route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': url.includes('/css') ? 'text/css' : 'font/woff2', 'access-control-allow-origin': '*' } });
    } catch (e) { await route.abort(); }
  });
}

// New context + page with fonts routed, optional localStorage seeding and error collection.
// storage: { key: value-object } written before any page script runs (once per context).
export async function newGamePage(browser, { width = 480, height = 270, dpr = 1, storage = null, init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  await routeFonts(ctx);
  if (storage) {
    await ctx.addInitScript((storage) => {
      try {
        if (sessionStorage.getItem('__seeded')) return;
        sessionStorage.setItem('__seeded', '1');
        for (const k in storage) localStorage.setItem(k, typeof storage[k] === 'string' ? storage[k] : JSON.stringify(storage[k]));
      } catch (e) { /* opaque origins */ }
    }, storage);
  }
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  const errors = watchErrors(page);
  return { ctx, page, errors };
}

const external = (t) => /fonts\.(googleapis|gstatic)\.com|net::ERR_(CERT|NAME|CONNECTION|INTERNET|TUNNEL|PROXY|ABORTED|FAILED)/.test(t);

export function watchErrors(page, label = '') {
  const errors = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t !== 'error' && t !== 'warning') return;
    const text = `${m.text()} ${m.location()?.url || ''}`;
    if (!/GPU stall due to ReadPixels|GL_CLOSE_PATH_NV|Automatic fallback to software WebGL/.test(text)) console.log(`${label}[console.${t}] ${m.text().slice(0, 400)}`);
    if (t === 'error' && !external(text)) errors.push(m.text());
  });
  page.on('pageerror', (e) => { errors.push(e.message); console.log(`${label}[pageerror] ${e.stack || e.message}`); });
  page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') { errors.push(`worker: ${m.text()}`); console.log(`${label}[worker.error] ${m.text()}`); } }));
  return errors;
}

export function reporter(name) {
  const t0 = Date.now();
  const failures = [];
  const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  const check = (c, msg) => {
    if (c) log(`ok   ${msg}`);
    else { failures.push(msg); log(`FAIL ${msg}`); }
    return !!c;
  };
  const finish = () => {
    console.log(failures.length ? `${name}: FAILED (${failures.length})\n  - ${failures.join('\n  - ')}` : `${name}: PASSED`);
    return failures.length ? 1 : 0;
  };
  return { log, check, failures, finish };
}

// Wait for n rendered frames of the game in `target` (a Page or Frame).
export const frames = (target, n = 1) => target.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);

// Wait until the player's simulated time advanced by `sec` seconds (dt is clamped to 0.1 s per frame).
export const gameSeconds = async (target, sec) => {
  const t0 = await target.evaluate(() => window.__game.player.time);
  await target.waitForFunction(([t0, sec]) => window.__game.player.time - t0 >= sec, [t0, sec], { polling: 50 });
};

export async function waitReady(target, radius = 2, timeout = 300000) {
  await target.waitForFunction(() => window.__game, null, { timeout: 120000 });
  await target.waitForFunction((r) => window.__game.loaded(r) >= 1, radius, { timeout, polling: 250 });
}

export const state = (target) => target.evaluate(() => {
  const g = window.__game;
  return { state: g.state, screen: g.ui.screen, inv: g.ui.inventoryOpen, menu: g.ui.menuOpen, locked: !!document.pointerLockElement };
});

export const playerState = (target) => target.evaluate(() => {
  const p = window.__game.player;
  return {
    pos: p.pos.slice(), vel: p.vel.slice(), yaw: p.yaw, pitch: p.pitch, flying: p.flying, onGround: p.onGround,
    inWater: p.inWater, eyeInWater: p.eyeInWater, sprinting: p.sprinting, sneaking: p.sneaking,
    selected: p.selected, hotbar: p.hotbar.slice(), target: p.target, time: p.time,
  };
});

// Lighter rendering for pure gameplay checks.
export const lighten = (target, extra = {}) => target.evaluate((extra) => {
  window.__game.setSettings({ shadows: false, volumetrics: 0, clouds: 0, ssr: 0, renderDistance: 4, renderScale: 0.5, fxaa: false, ...extra });
}, extra);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Canvas grab right after a frame (page screenshots can time out when a frame takes seconds).
export async function grab(target, file) {
  const url = await target.evaluate(() => window.__game.capture());
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}
