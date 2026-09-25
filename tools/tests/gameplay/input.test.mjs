#!/usr/bin/env node
// Input edge cases (node, fake DOM objects, fake clock):
//   macOS wheel notches (~4 px each) move one slot per notch; trackpad swipes still accumulate
//   a genuine fast flick under pointer lock is not swallowed by the spike filter (one spike is)
//   clicks are ignored right after Play / Resume, while a lock request is pending, and when they
//   are the mouse events a touch screen synthesizes from a tap
//   cancelLock abandons a pending request (and its delayed retry) without switching to drag-look
//   a mousedown in a frame that lost focus takes the keyboard focus back
//   node tools/tests/gameplay/input.test.mjs

import { Input } from '../../../src/input.js';

let failures = 0;
const check = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };

function make() {
  const listeners = {};
  const target = () => ({ addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, removeEventListener() {} });
  const el = target();
  const input = new Input(el);
  let t = 1000;
  input.now = () => t;
  input.win = { focused: 0, focus() { this.focused++; } };
  input.doc = { pointerLockElement: null, activeElement: null, body: {}, hasFocus: () => true };
  return { input, el, advance: (ms) => { t += ms; } };
}
const ev = (o) => ({ preventDefault() { this.defaultPrevented = true; }, ...o });

// Wheel.
{
  const { input, advance } = make();
  let steps = 0;
  for (let i = 0; i < 5; i++) { advance(400); input._onWheel(ev({ deltaY: 4.000244140625, deltaMode: 0 })); steps += input.wheel(); input.endFrame(); }
  check(steps === 5, `macOS: five slow wheel notches (4 px each) move five slots (${steps})`);
  advance(400);
  for (let i = 0; i < 12; i++) { advance(16); input._onWheel(ev({ deltaY: 10, deltaMode: 0 })); }
  check(input.wheel() === 2, `trackpad swipe of 120 px still moves 2 slots (${input.wheel()})`);
  input.endFrame();
  advance(400);
  input._onWheel(ev({ deltaY: 100, deltaMode: 0 }));
  check(input.wheel() === 1, 'Windows notch (100 px) is one slot');
  input.endFrame();
  advance(50);
  input._onWheel(ev({ deltaY: -4, deltaMode: 0 }));
  check(input.wheel() === -1, 'reversing direction is a new gesture: one slot back');
}

// Pointer-lock spike filter.
{
  const { input } = make();
  input.locked = true;
  input._skipMoves = 0;
  for (const d of [10, 6, 3]) input._onMouseMove(ev({ movementX: d, movementY: 0 }));
  input.endFrame();
  let total = 0;
  for (const d of [320, 480, 600, 520, 400, 300]) { input._onMouseMove(ev({ movementX: d, movementY: 0 })); total += input.mouseDelta()[0]; input.endFrame(); }
  check(total >= 2620 - 320, `fast flick from rest: ${total} of 2620 counts reach the camera (only the first frame may drop)`);
  input._onMouseMove(ev({ movementX: 2, movementY: 0 }));
  input.endFrame();
  input._onMouseMove(ev({ movementX: 4000, movementY: 0 }));
  const spike = input.mouseDelta()[0];
  input.endFrame();
  input._onMouseMove(ev({ movementX: 3, movementY: 1 }));
  check(spike === 0 && input.mouseDelta()[0] === 3, 'an isolated bogus spike is still dropped');
  input.endFrame();
  input._onMouseMove(ev({ movementX: 240, movementY: 151 }));
  input._onMouseMove(ev({ movementX: -240, movementY: -151 }));
  check(input.mouseDelta()[0] === 0 && input.mouseDelta()[1] === 0, 'a bogus jump and its jump back are both dropped');
}

// Clicks that must not reach the game.
{
  const { input, advance } = make();
  input.dragLook = false;
  input.suppressClicks(400);
  const e1 = ev({ button: 0, clientX: 5, clientY: 5 });
  input._onMouseDown(e1);
  check(!input.buttonPressed(0) && e1.defaultPrevented, 'click right after Play / Resume is ignored');
  advance(450);
  input._onMouseDown(ev({ button: 0 }));
  check(input.buttonPressed(0), 'a click after the guard counts');
  input._onMouseUp(ev({ button: 0 }));
  input.endFrame();
  input._onPointerDown(ev({ pointerType: 'touch' }));
  input._onMouseDown(ev({ button: 0 }));
  check(!input.buttonPressed(0), 'the mouse event a tap synthesizes is ignored');
  advance(900);
  input._lockPending = Promise.resolve(false);
  input._onMouseDown(ev({ button: 0 }));
  check(!input.buttonPressed(0), 'a click while pointer capture is pending is ignored');
  input._lockPending = null;
}

// cancelLock: pending request with a delayed retry (Chrome's re-lock cooldown).
{
  const { input } = make();
  const el = input.element;
  let requests = 0;
  el.requestPointerLock = () => { requests++; return Promise.reject(Object.assign(new Error('cooldown'), { name: 'NotAllowedError' })); };
  input._unlockTime = input.now();         // the user just pressed Esc
  const p = input.requestLock();
  await new Promise((r) => setTimeout(r, 20));
  input.cancelLock();
  const ok = await p;
  await new Promise((r) => setTimeout(r, 1400));
  check(ok === false && !input.dragLook && requests === 1, `cancelLock: resolves false, no drag-look, no retry afterwards (requests ${requests})`);
  check(!input._lockPending, 'no lock request left pending');
}

// A sandbox refusal is remembered; drag-look without asking again.
{
  const { input } = make();
  let requests = 0;
  input.element.requestPointerLock = () => { requests++; return Promise.reject(Object.assign(new Error("Blocked pointer lock on an element because the element's frame is sandboxed"), { name: 'SecurityError' })); };
  const a = await input.requestLock();
  const b = await input.requestLock();
  check(!a && !b && input.dragLook && requests === 1, `sandboxed frame: one request, then drag-look without asking (${requests})`);
}

// Focus comes back to a frame whose host page took it.
{
  const { input } = make();
  input.dragLook = true;
  input.doc.hasFocus = () => false;
  input._onMouseDown(ev({ button: 0, clientX: 1, clientY: 1 }));
  check(input.win.focused === 1, 'mousedown in an unfocused frame focuses it (keys reach the game again)');
}

console.log(failures ? `input: FAILED (${failures})` : 'input: PASSED');
process.exit(failures ? 1 : 0);
