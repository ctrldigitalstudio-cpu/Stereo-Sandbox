// Runs probe.html in cost mode for the working tree and the HEAD tree; prints per-pass tables.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const time = process.argv.includes('--time');
const q = { vol: { volumetrics: 16, clouds: 16, ssr: 24, shadows: true, pcss: true } };
const cur = [
  { _label: 'NEW High: taa 0.85', aa: 'taa', renderScale: 0.85, ...q.vol },
  { _label: 'NEW Medium: taa 0.75', aa: 'taa', renderScale: 0.75, ...q.vol },
  { _label: 'NEW taa 1.0', aa: 'taa', renderScale: 1, ...q.vol },
  { _label: 'NEW taa 0.5', aa: 'taa', renderScale: 0.5, ...q.vol },
  { _label: 'NEW fxaa 1.0', aa: 'fxaa', renderScale: 1, ...q.vol },
  { _label: 'NEW fxaa 0.85', aa: 'fxaa', renderScale: 0.85, ...q.vol },
  { _label: 'NEW Low: fxaa 0.75', aa: 'fxaa', renderScale: 0.75, shadows: false, pcss: false, volumetrics: 0, clouds: 0, ssr: 0 },
  { _label: 'NEW off 1.0', aa: 'off', renderScale: 1, ...q.vol },
];
const head = [
  { _label: 'OLD High: fxaa 1.0', fxaa: true, renderScale: 1, ...q.vol },
  { _label: 'OLD fxaa 0.85', fxaa: true, renderScale: 0.85, ...q.vol },
  { _label: 'OLD Low: fxaa 0.75', fxaa: true, renderScale: 0.75, shadows: false, pcss: false, volumetrics: 0, clouds: 0, ssr: 0 },
  { _label: 'OLD off 1.0', fxaa: false, renderScale: 1, ...q.vol },
];
const res = {};
for (const [src, cfgs] of [['cur', cur], ['head', head]]) {
  const url = `tools/tests/taa/verify-perf/probe.html?mode=cost&src=${src}${time ? '&time=1' : ''}&cfgs=${encodeURIComponent(JSON.stringify(cfgs))}`;
  let txt;
  try { txt = execFileSync('node', ['tools/run-page.mjs', url, '--until', 'window.__done', '--wait', '1500000', '--size', '900x500', '--eval', 'window.__out'], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1600000 }); }
  catch (e) { txt = (e.stdout || '') + (e.stderr || ''); }
  const line = txt.split('\n').find((l) => l.startsWith('[eval] '));
  if (!line) { console.log(txt); continue; }
  res[src] = JSON.parse(line.slice(7));
}
fs.writeFileSync(`tools/out/taa-verify-perf/cost${time ? '-time' : ''}.json`, JSON.stringify(res, null, 1));
for (const src in res) {
  const o = res[src];
  if (o.errors.length) console.log(src, 'ERRORS', o.errors);
  for (const r of o.results) {
    const canvasPx = r.w * r.h; // output size of the post chain in NEW, or canvas
    let fsPx = 0, fsN = 0;
    const rows = [];
    for (const [k, a] of Object.entries(r.agg)) { fsPx += a.px; fsN += a.n; rows.push(`   ${k.padEnd(34)} n=${String(a.n).padStart(3)} px=${String(a.px).padStart(8)}${a.ms !== undefined ? ' ms=' + a.ms : ''}`); }
    console.log(`\n== ${src} ${r.cfg}  aa=${r.aa} render ${r.rw}x${r.rh} canvas ${r.w}x${r.h} stats.passes=${r.passes} err=${JSON.stringify(r.err)}`);
    console.log(`   mem ${JSON.stringify(r.mem)}`);
    console.log(`   fullscreen pixels ${fsPx} = ${(fsPx / 360000).toFixed(2)} x canvas(800x450)`);
    console.log(rows.join('\n'));
  }
}
