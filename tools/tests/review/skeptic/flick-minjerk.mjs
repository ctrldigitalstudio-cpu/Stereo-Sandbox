// Skeptic check: minimum-jerk flick sampled per 60 Hz frame (Chrome rAF-aligned coalesced mousemove),
// with the flick starting at an arbitrary phase inside a frame. Measures counts that reach Input.dx.
import { Input } from '../../../../src/input.js';
const pos = (t) => { const u = Math.min(1, Math.max(0, t)); return 10*u**3 - 15*u**4 + 6*u**5; };
function run(total, durMs, frameMs, phase, lastMove = 3, fix = null) {
  const inp = new Input(null);
  inp.locked = true; inp._skipMoves = 0; inp._lastMove = lastMove;
  if (fix) fix(inp);
  let got = 0, sent = 0, dropped = 0;
  let prev = 0;
  for (let k = 0; ; k++) {
    const tEnd = (k + 1) * frameMs - phase * frameMs;
    const p = Math.round(total * pos(tEnd / durMs));
    const d = p - prev; prev = p;
    if (d) { const before = inp.dx; inp._onMouseMove({ movementX: d, movementY: 0 }); if (inp.dx === before) dropped++; sent += d; }
    got += inp.dx; inp.endFrame();
    if (tEnd >= durMs) break;
  }
  return { sent, got, dropped };
}
const LOOK = 0.0022;
for (const [label, dpi, sens, deg, durMs, frameMs] of [
  ['800 DPI, sens 1.0, 90 deg in 120 ms @60Hz', 800, 1.0, 90, 120, 16.67],
  ['800 DPI, sens 1.0, 180 deg in 150 ms @60Hz', 800, 1.0, 180, 150, 16.67],
  ['1600 DPI, sens 0.5, 180 deg in 150 ms @60Hz', 1600, 0.5, 180, 150, 16.67],
  ['1600 DPI, sens 0.3, 180 deg in 150 ms @60Hz', 1600, 0.3, 180, 150, 16.67],
  ['1600 DPI, sens 0.3, 90 deg in 120 ms @60Hz', 1600, 0.3, 90, 120, 16.67],
  ['3200 DPI, sens 0.2, 90 deg in 120 ms @60Hz', 3200, 0.2, 90, 120, 16.67],
  ['1600 DPI, sens 0.3, 180 deg in 150 ms @144Hz', 1600, 0.3, 180, 150, 6.94],
  ['800 DPI, sens 1.0, 180 deg in 150 ms @30fps', 800, 1.0, 180, 150, 33.3],
]) {
  const total = Math.round((deg * Math.PI / 180) / (LOOK * sens));
  const rows = [];
  for (const phase of [0, 0.25, 0.5, 0.75]) {
    const r = run(total, durMs, frameMs, phase);
    rows.push(`phase ${phase}: ${r.got}/${r.sent} (${(r.got/r.sent*100).toFixed(0)}%)`);
  }
  console.log(`${label} [${total} counts]: ` + rows.join(' | '));
}
