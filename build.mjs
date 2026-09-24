#!/usr/bin/env node
// Single-file build: bundles the game (and its world worker) into dist/index.html, which runs
// from any static host or straight from disk. Also writes dist/artifact.html, the same page
// without the document wrapper tags, for hosts that supply their own <html>/<head>/<body>.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, minify: true, write: false, target: 'es2020', legalComments: 'none', logLevel: 'warning' };

const worker = await build({ ...common, entryPoints: [path.join(root, 'src/worker.js')], format: 'iife' });
const game = await build({ ...common, entryPoints: [path.join(root, 'src/main.js')], format: 'esm' });

const workerSrc = worker.outputFiles[0].text;
const gameSrc = game.outputFiles[0].text;
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Inline text must not close the surrounding <script>/<style> element early.
const safeScript = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeStyle = (s) => s.replace(/<\/style/gi, '<\\/style');

const stylesheet = /<link[^>]+href=["']style\.css["'][^>]*>/i;
const entry = /<script[^>]+src=["']src\/main\.js["'][^>]*>\s*<\/script>/i;
if (!stylesheet.test(html)) throw new Error('index.html: <link href="style.css"> not found');
if (!entry.test(html)) throw new Error('index.html: <script src="src/main.js"> not found');

html = html
  .replace(stylesheet, () => `<style>\n${safeStyle(css)}\n</style>`)
  .replace(entry, () =>
    `<script>window.__WORKER_SRC__ = ${safeScript(JSON.stringify(workerSrc))};</script>\n` +
    `<script type="module">\n${safeScript(gameSrc)}\n</script>`);

fs.writeFileSync(path.join(out, 'index.html'), html);

// Artifact variant: keep <title>, font links, <style>, markup and scripts; drop the wrappers.
const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
const keepHead = head
  .replace(/<meta[^>]+charset[^>]*>\s*/gi, '')
  .replace(/<meta[^>]+name=["']viewport["'][^>]*>\s*/gi, '');
fs.writeFileSync(path.join(out, 'artifact.html'), `${keepHead.trim()}\n${body.trim()}\n`);

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;
console.log(`dist/index.html     ${kb(html)}  (game ${kb(gameSrc)}, worker ${kb(workerSrc)}, css ${kb(css)})`);
console.log(`dist/artifact.html  ${kb(fs.readFileSync(path.join(out, 'artifact.html'), 'utf8'))}`);
