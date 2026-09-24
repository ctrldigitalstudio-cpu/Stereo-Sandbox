// Bundle src/worker.js exactly like build.mjs does (IIFE, minified) for the Blob-URL browser test.
//   node tools/tests/mesher/bundle-worker.mjs  ->  tools/out/mesher-worker.iife.js
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const res = await build({
  entryPoints: [path.join(root, 'src/worker.js')], bundle: true, minify: true, write: false,
  target: 'es2020', legalComments: 'none', logLevel: 'warning', format: 'iife',
});
const src = res.outputFiles[0].text;
if (/import\.meta/.test(src)) throw new Error('bundled worker references import.meta');
fs.mkdirSync(path.join(root, 'tools/out'), { recursive: true });
fs.writeFileSync(path.join(root, 'tools/out/mesher-worker.iife.js'), src);
console.log(`tools/out/mesher-worker.iife.js ${(src.length / 1024).toFixed(0)} KB`);
