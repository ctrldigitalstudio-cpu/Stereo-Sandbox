// Skeptic check: compare the current spike filter with two fixes on flicks and on a lone bogus spike.
import { Input } from '../../../../src/input.js';
const pos = (t) => { const u = Math.min(1, Math.max(0, t)); return 10*u**3 - 15*u**4 + 6*u**5; };
class FixA extends Input {   // record the magnitude even when dropping -> only one event lost
  _onMouseMove(e) {
    if (!this.locked) return super._onMouseMove(e);
    const dx = e.movementX || 0, dy = e.movementY || 0;
    if (this._skipMoves > 0) { this._skipMoves--; return; }
    const m = Math.abs(dx) + Math.abs(dy);
    const spike = m > 250 && m > 6 * (this._lastMove + 25);
    this._lastMove = m;
    if (spike) return;
    this.dx += dx; this.dy += dy;
  }
}
class FixC extends Input {   // hold a suspicious delta one event; keep it if the next one continues the motion
  _onMouseMove(e) {
    if (!this.locked) return super._onMouseMove(e);
    const dx = e.movementX || 0, dy = e.movementY || 0;
    if (this._skipMoves > 0) { this._skipMoves--; return; }
    const m = Math.abs(dx) + Math.abs(dy);
    const p = this._held; this._held = null;
    if (p) {
      // continues in the same general direction with a plausible size -> the held one was real
      if (dx * p.dx + dy * p.dy > 0 && m * 6 + 150 >= p.m) { this.dx += p.dx; this.dy += p.dy; this._lastMove = p.m; }
    }
    if (m > 250 && m > 6 * (this._lastMove + 25)) { this._held = { dx, dy, m }; return; }
    this._lastMove = m;
    this.dx += dx; this.dy += dy;
  }
}
function flick(Cls, total, durMs, frameMs, phase) {
  const inp = new Cls(null); inp.locked = true; inp._skipMoves = 0; inp._lastMove = 3;
  let got = 0, prev = 0;
  for (let k = 0; ; k++) {
    const tEnd = (k + 1 - phase) * frameMs;
    const p = Math.round(total * pos(tEnd / durMs)); const d = p - prev; prev = p;
    if (d) inp._onMouseMove({ movementX: d, movementY: 0 });
    got += inp.dx; inp.endFrame();
    if (tEnd >= durMs) break;
  }
  inp._onMouseMove({ movementX: 0, movementY: 1 }); got += inp.dx; // a trailing tiny event flushes held state
  return got / total;
}
function spike(Cls, seq) {
  const inp = new Cls(null); inp.locked = true; inp._skipMoves = 0; inp._lastMove = 3;
  let got = 0; for (const d of seq) { inp._onMouseMove({ movementX: d, movementY: 0 }); got += inp.dx; inp.endFrame(); }
  return got;
}
for (const [name, Cls] of [['current', Input], ['fixA', FixA], ['fixC', FixC]]) {
  const res = [];
  for (const [counts, dur, fm] of [[3000, 100, 16.67], [4500, 130, 16.67], [1500, 100, 33.3], [2000, 130, 33.3]]) {
    let s = 0; for (let i = 0; i < 10; i++) s += flick(Cls, counts, dur, fm, i / 10);
    res.push(`${counts}c/${dur}ms/${fm}ms avg ${(s * 10).toFixed(0)}%`);
  }
  console.log(name.padEnd(8), res.join('  '),
    '| lone spike [5,5,-1800,5,5] ->', spike(Cls, [5, 5, -1800, 5, 5]),
    '| spike mid-turn [60,60,2400,60,60] ->', spike(Cls, [60, 60, 2400, 60, 60]));
}
