#!/usr/bin/env node
// Runs every gameplay test in sequence (each is also runnable on its own) and prints a summary.
//   node tools/tests/gameplay/run-all.mjs [--skip name,name]
// Software rendering is slow and shared: expect 20-40 minutes for the whole set.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf('--skip');
const skip = new Set(i >= 0 ? args[i + 1].split(',') : []);
const tests = [
  'world-sync.test.mjs',   // node only: World <-> worker protocol under message races
  'input.test.mjs',        // node only: wheel, flicks, click guards, lock cancel, refocus
  'titlecam.mjs',          // title camera never inside terrain, several seeds and saves
  'persistence.mjs',       // autosave, reload, quit to title, new world, legacy save key
  'chunks.mjs',            // border edits re-mesh exactly, after unload and reload
  'soak.mjs',              // long session: nothing accumulates (chunks, GPU meshes, DOM, heap)
  'journey.mjs',           // the play-through with real input (drag-look and pointer lock)
  'settings.mjs',          // every setting through the settings screen, applied live
  'embed.mjs',             // sandboxed iframes (same-origin and opaque), dev and dist
  'portability.mjs',       // dist over http / file://, artifact.html, no WebGL2, sizes, focus
  'resilience.mjs',        // blob: workers blocked, fonts hanging, touch-only, adaptive res, motion
  'title-layout.mjs',      // the title screen fits at every size (screenshots)
];
const results = [];
for (const t of tests) {
  const name = t.replace(/\.(test\.)?mjs$/, '');
  if (skip.has(name)) continue;
  console.log(`\n===== ${t} =====`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, t)], { stdio: 'inherit' });
  results.push([t, r.status === 0, ((Date.now() - t0) / 1000).toFixed(0)]);
}
console.log('\n===== summary =====');
for (const [t, ok, s] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${t}  (${s} s)`);
const failed = results.filter((r) => !r[1]).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
