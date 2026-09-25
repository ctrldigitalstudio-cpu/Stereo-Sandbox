// Review (build/portability): pointer-locked mouse deltas for a fast flick that starts from rest
// (high-DPI gaming mouse, raw input via unadjustedMovement, Chrome's per-frame coalesced mousemove).
import { Input } from '../../../../src/input.js';
const inp = new Input(null);
inp.locked = true; inp._skipMoves = 0; inp._lastMove = 2;   // mouse at rest (tiny jitter last)
// Per-frame deltas (counts) of a quick 180-degree flick: accelerate, cruise, decelerate.
const flick = [320, 640, 900, 900, 700, 420, 180, 60];
let turned = 0;
for (const dx of flick) { inp._onMouseMove({ movementX: dx, movementY: 0 }); turned += inp.dx; inp.endFrame(); }
console.log(`flick of ${flick.reduce((a, b) => a + b)} counts -> ${turned} counts reach the camera`);
// Same flick with a gentler first frame
const inp2 = new Input(null); inp2.locked = true; inp2._skipMoves = 0; inp2._lastMove = 2;
let t2 = 0; for (const dx of [120, ...flick]) { inp2._onMouseMove({ movementX: dx, movementY: 0 }); t2 += inp2.dx; inp2.endFrame(); }
console.log(`same flick with a 120-count first frame -> ${t2} of ${120 + flick.reduce((a, b) => a + b)} counts`);
