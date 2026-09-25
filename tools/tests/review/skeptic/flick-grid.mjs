// Skeptic check: grid of minimum-jerk flicks (60 Hz coalesced), share of flicks losing >50% of counts.
import { Input } from '../../../../src/input.js';
const pos = (t) => { const u = Math.min(1, Math.max(0, t)); return 10*u**3 - 15*u**4 + 6*u**5; };
function run(total, durMs, frameMs, phase, lastMove = 3) {
  const inp = new Input(null);
  inp.locked = true; inp._skipMoves = 0; inp._lastMove = lastMove;
  let got = 0, sent = 0, prev = 0;
  for (let k = 0; ; k++) {
    const tEnd = (k + 1 - phase) * frameMs;
    const p = Math.round(total * pos(tEnd / durMs));
    const d = p - prev; prev = p;
    if (d) { inp._onMouseMove({ movementX: d, movementY: 0 }); sent += d; }
    got += inp.dx; inp.endFrame();
    if (tEnd >= durMs) break;
  }
  return got / sent;
}
const LOOK = 0.0022;
const phases = [...Array(10)].map((_, i) => i / 10);
for (const frameMs of [16.67, 33.3]) {
  console.log(`--- frame ${frameMs} ms`);
  for (const counts of [700, 1000, 1500, 2000, 3000, 4500]) {
    const cells = [];
    for (const dur of [80, 100, 130, 160, 200, 250]) {
      const fr = phases.map(ph => run(counts, dur, frameMs, ph));
      const bad = fr.filter(f => f < 0.5).length;
      const mean = fr.reduce((a, b) => a + b) / fr.length;
      cells.push(`${dur}ms:${bad}/10 bad avg ${(mean*100).toFixed(0)}%`);
    }
    console.log(`${counts} counts (${(counts*LOOK*180/Math.PI).toFixed(0)} deg @sens1, ${(counts*LOOK*0.3*180/Math.PI).toFixed(0)} deg @0.3): ` + cells.join('  '));
  }
}
