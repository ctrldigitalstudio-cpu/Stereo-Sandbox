#!/usr/bin/env node
// Serve the repo over HTTP and open a page in headless Chromium (SwiftShader WebGL2).
// Prints console output + page errors, optionally saves a screenshot.
//
//   node tools/run-page.mjs <page relative to repo root> [--shot out.png] [--wait 8000]
//        [--until "expression"] [--size 960x540] [--eval "expression printed at the end"]
//
// --until polls the JS expression (e.g. "window.__done") until truthy or --wait ms elapse.
// Exit code 1 if the page threw an uncaught error or logged console.error.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const page0 = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
if (!page0) {
  console.error('usage: node tools/run-page.mjs <page> [--shot out.png] [--wait ms] [--until expr] [--size WxH] [--eval expr]');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(root, url);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const [w, h] = opt('size', '960x540').split('x').map(Number);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
let failed = false;
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') failed = true;
  console.log(`[console.${t}] ${m.text()}`);
});
page.on('pageerror', (e) => { failed = true; console.log(`[pageerror] ${e.stack || e.message}`); });
page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

const url = `http://127.0.0.1:${port}/${page0.replace(/^\//, '')}`;
console.log(`[run-page] ${url}`);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
const wait = Number(opt('wait', '5000'));
const until = opt('until', null);
if (until) {
  try {
    await page.waitForFunction(until, null, { timeout: wait, polling: 250 });
  } catch (e) {
    console.log(`[run-page] --until not satisfied after ${wait} ms`);
  }
} else {
  await page.waitForTimeout(wait);
}
const ev = opt('eval', null);
if (ev) {
  try {
    const v = await page.evaluate(ev);
    console.log(`[eval] ${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`);
  } catch (e) { console.log(`[eval error] ${e.message}`); failed = true; }
}
const shot = opt('shot', null);
if (shot) {
  await page.screenshot({ path: shot });
  console.log(`[run-page] screenshot -> ${shot}`);
}
console.log(`[run-page] done in ${Date.now() - t0} ms${failed ? ' (errors)' : ''}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
