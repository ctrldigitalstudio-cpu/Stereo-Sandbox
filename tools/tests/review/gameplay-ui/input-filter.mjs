// Review check (read-only): Input's bogus-delta filter and wheel accumulation, driven from node
// with the fake DOM from tools/tests/player/mock.mjs.
import { installDom, makeEvent } from '../../player/mock.mjs';
import { Input } from '../../../../src/input.js';

const { win, el } = installDom();
const input = new Input(el);
input.locked = true;          // pretend the pointer is locked
input._skipMoves = 0;
const move = (dx) => win.dispatchEvent(makeEvent('mousemove', { movementX: dx, movementY: 0 }));

// Slow aim, then the mouse rests (last accepted |delta| = 3).
for (const d of [10, 6, 3]) move(d);
input.endFrame();
// A sustained fast turn: several consecutive frames of 300..600 counts (not one spike).
const turn = [320, 480, 600, 520, 400, 300];
let seen = 0;
for (const d of turn) { move(d); seen += input.mouseDelta()[0]; input.endFrame(); }
console.log(`sustained turn: sent ${turn.reduce((a, b) => a + b)} counts over ${turn.length} frames, accepted ${seen}`);

// Wheel: one notch at a time, 400 ms apart, with the small pixel deltas macOS Chrome reports for a mouse wheel.
let t = 0;
input.now = () => t;
let steps = 0;
for (let i = 0; i < 10; i++) {
  t += 400;
  el.dispatchEvent(makeEvent('wheel', { deltaY: 4.000244140625, deltaMode: 0 }));
  steps += input.wheel();
  input.endFrame();
}
console.log(`10 separate 4px wheel notches -> ${steps} hotbar steps`);
