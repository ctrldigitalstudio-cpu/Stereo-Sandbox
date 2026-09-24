// Input tests (node) against a fake DOM. Run: node tools/tests/player/input.test.mjs

import { installDom, uninstallDom, makeEvent } from './mock.mjs';
import { Input } from '../../../src/input.js';
import { Player } from '../../../src/player.js';
import { MockWorld } from './mock.mjs';

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ok    ${name}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${e.stack.split('\n').slice(0, 2).join('\n        ')}`);
  } finally {
    uninstallDom();
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key(target, type, code, extra = {}) {
  const e = makeEvent(type, { code, key: extra.key ?? code, ...extra });
  target.dispatchEvent(e);
  return e;
}
function mouse(target, type, props) {
  const e = makeEvent(type, props);
  target.dispatchEvent(e);
  return e;
}

await test('keys: down/up/pressed edges, repeats, same-frame taps', () => {
  const { win, el } = installDom();
  const input = new Input(el);
  key(win, 'keydown', 'KeyW');
  assert(input.isDown('KeyW') && input.pressed('KeyW'), 'W down + pressed');
  input.endFrame();
  assert(input.isDown('KeyW') && !input.pressed('KeyW'), 'pressed clears at endFrame');
  key(win, 'keydown', 'KeyW', { repeat: true });
  assert(!input.pressed('KeyW'), 'auto-repeat is not a press');
  key(win, 'keyup', 'KeyW');
  assert(!input.isDown('KeyW'), 'released');
  key(win, 'keydown', 'KeyE');
  key(win, 'keyup', 'KeyE');
  assert(input.pressed('KeyE') && !input.isDown('KeyE'), 'tap within one frame still counts');
  // No `code` (some virtual keyboards): falls back to the key.
  key(win, 'keydown', '', { key: ' ' });
  assert(input.isDown('Space'), 'fallback code from key');
});

await test('keys: Ctrl/Cmd shortcuts are ignored and never blocked; blur and hidden release all', () => {
  const { win, doc, el } = installDom();
  const input = new Input(el);
  input.locked = true;
  let e = key(win, 'keydown', 'KeyW', { ctrlKey: true });
  assert(!input.isDown('KeyW') && !e.defaultPrevented, 'Ctrl+W untouched');
  e = key(win, 'keydown', 'KeyR', { metaKey: true });
  assert(!input.isDown('KeyR') && !e.defaultPrevented, 'Cmd+R untouched');
  key(win, 'keydown', 'KeyA');
  key(win, 'keydown', 'ShiftLeft');
  win.dispatchEvent(makeEvent('blur'));
  assert(!input.isDown('KeyA') && !input.isDown('ShiftLeft'), 'blur releases keys');
  key(win, 'keydown', 'KeyD');
  doc.hidden = true;
  doc.dispatchEvent(makeEvent('visibilitychange'));
  assert(!input.isDown('KeyD'), 'hidden tab releases keys');
});

await test('keys: default actions are blocked only while the game owns the mouse', () => {
  const { win, el } = installDom();
  const input = new Input(el);
  const body = { tagName: 'BODY' };
  const button = { tagName: 'BUTTON' };
  const text = { tagName: 'INPUT', type: 'text' };
  const range = { tagName: 'INPUT', type: 'range' };
  let e = key(win, 'keydown', 'Space', { target: body });
  assert(!e.defaultPrevented, 'menus: Space not blocked');
  input.locked = true;
  for (const code of ['Space', 'Tab', 'F1', 'F3', 'ArrowUp', 'KeyW', 'Digit1', 'Slash']) {
    e = key(win, 'keydown', code);
    assert(e.defaultPrevented, `locked: ${code} should be blocked`);
    key(win, 'keyup', code);
  }
  for (const code of ['Escape', 'F5', 'F11', 'F12', 'ShiftLeft']) {
    e = key(win, 'keydown', code);
    assert(!e.defaultPrevented, `locked: ${code} must not be blocked`);
    key(win, 'keyup', code);
  }
  e = key(win, 'keydown', 'KeyW', { altKey: true });
  assert(!e.defaultPrevented, 'Alt combos not blocked');
  input.locked = false;
  input.dragLook = true;
  e = key(win, 'keydown', 'Space', { target: body });
  assert(e.defaultPrevented, 'drag-look: Space on the page blocked');
  key(win, 'keyup', 'Space');
  e = key(win, 'keydown', 'Space', { target: button });
  assert(!e.defaultPrevented, 'drag-look: Space on a focused button left alone');
  e = key(win, 'keydown', 'Tab', { target: body });
  assert(!e.defaultPrevented, 'drag-look: Tab keeps keyboard navigation');
  e = key(win, 'keydown', 'ArrowLeft', { target: range });
  assert(!e.defaultPrevented, 'drag-look: arrows on a slider left alone');
  key(win, 'keyup', 'KeyQ');
  e = key(win, 'keydown', 'KeyQ', { target: text });
  assert(!input.isDown('KeyQ') && !e.defaultPrevented, 'typing into a text field is not game input');
});

await test('mouse buttons, context menu, middle-click autoscroll', () => {
  const { win, el } = installDom();
  const input = new Input(el);
  mouse(el, 'mousedown', { button: 0 });
  assert(input.buttonPressed(0) && input.buttonDown(0), 'left down');
  input.endFrame();
  assert(!input.buttonPressed(0) && input.buttonDown(0), 'held');
  mouse(win, 'mouseup', { button: 0 });
  assert(!input.buttonDown(0), 'released (mouseup anywhere)');
  const m = mouse(el, 'mousedown', { button: 1 });
  assert(m.defaultPrevented && input.buttonPressed(1), 'middle: pressed, autoscroll blocked');
  mouse(win, 'mouseup', { button: 1 });
  const c = mouse(el, 'contextmenu', { button: 2 });
  assert(c.defaultPrevented, 'context menu blocked');
  mouse(el, 'mousedown', { button: 2 });
  mouse(win, 'mouseup', { button: 2 });
  assert(input.buttonPressed(2) && !input.buttonDown(2), 'right click within a frame');
});

await test('wheel: one step per notch in every delta mode, trackpads accumulate, Ctrl+wheel zooms', () => {
  const { el } = installDom();
  const input = new Input(el);
  let t = 0;
  input.now = () => t;
  const wheel = (deltaY, deltaMode = 0, extra = {}) => { t += 400; return mouse(el, 'wheel', { deltaY, deltaMode, ...extra }); };
  const steps = (fn) => { input.endFrame(); fn(); return input.wheel(); };
  assert(steps(() => wheel(100)) === 1, 'Chrome notch');
  assert(steps(() => wheel(-100)) === -1, 'Chrome notch up');
  assert(steps(() => wheel(125)) === 1, '125% scaled notch');
  assert(steps(() => wheel(53)) === 1, 'Linux/Firefox pixel notch');
  assert(steps(() => wheel(240)) === 2, 'two coalesced notches');
  assert(steps(() => wheel(3, 1)) === 1, 'Firefox line mode');
  assert(steps(() => wheel(-1, 2)) === -1, 'page mode');
  assert(steps(() => { for (let i = 0; i < 12; i++) { t += 16; mouse(el, 'wheel', { deltaY: 10, deltaMode: 0 }); } }) === 2, 'trackpad swipe of 120 px');
  input.endFrame();
  const e = wheel(100, 0, { ctrlKey: true });
  assert(input.wheel() === 0 && !e.defaultPrevented, 'Ctrl+wheel left to the browser');
  const e2 = wheel(100);
  assert(e2.defaultPrevented, 'wheel scroll blocked on the canvas');
});

await test('pointer lock: promise API with unadjustedMovement, movement deltas, spike filter, unlock', async () => {
  const { doc, el, win } = installDom({ lockMode: 'promise' });
  const input = new Input(el);
  const changes = [];
  input.onLockChange = (l) => changes.push(l);
  const ok = await input.requestLock();
  assert(ok === true && input.locked && !input.dragLook, 'locked');
  assert(el.lockCalls.length === 1 && el.lockCalls[0] && el.lockCalls[0].unadjustedMovement, 'asked for raw input');
  assert(changes.join() === 'true', `onLockChange ${changes}`);
  mouse(win, 'mousemove', { movementX: 500, movementY: 0 });       // first event after locking: skipped
  mouse(win, 'mousemove', { movementX: 10, movementY: -4 });
  mouse(win, 'mousemove', { movementX: 20, movementY: 2 });
  assert(input.mouseDelta().join() === '30,-2', `delta ${input.mouseDelta()}`);
  mouse(win, 'mousemove', { movementX: 3000, movementY: 0 });      // bogus spike
  assert(input.mouseDelta().join() === '30,-2', 'spike ignored');
  input.endFrame();
  assert(input.mouseDelta().join() === '0,0', 'cleared');
  // A genuine fast flick ramps up and is kept.
  for (const dx of [40, 120, 300, 600]) mouse(win, 'mousemove', { movementX: dx, movementY: 0 });
  assert(input.mouseDelta()[0] === 1060, `fast flick ${input.mouseDelta()}`);
  mouse(el, 'mousedown', { button: 0 });
  doc.exitPointerLock();
  await sleep(1);
  assert(!input.locked && changes.join() === 'true,false', `unlock ${changes}`);
  assert(!input.buttonDown(0), 'buttons released on unlock');
  assert(await input.requestLock() === true, 're-lock');
});

await test('pointer lock: concurrent requests share one attempt; already locked resolves at once', async () => {
  const { el } = installDom({ lockMode: 'promise' });
  const input = new Input(el);
  const a = input.requestLock(), b = input.requestLock();
  assert(a === b, 'same promise');
  assert(await a && el.lockCalls.length === 1, 'one call');
  assert(await input.requestLock() && el.lockCalls.length === 1, 'no new call when locked');
});

await test('pointer lock: unadjustedMovement unsupported -> plain lock', async () => {
  const { el } = installDom({ lockMode: 'reject-raw' });
  const input = new Input(el);
  assert(await input.requestLock() === true, 'locked');
  assert(el.lockCalls.length === 2 && el.lockCalls[1] === null, `calls ${JSON.stringify(el.lockCalls)}`);
  assert(input.rawInput === false, 'remembers');
});

await test('pointer lock: legacy (no promise) success and pointerlockerror', async () => {
  let { el } = installDom({ lockMode: 'legacy' });
  let input = new Input(el);
  assert(await input.requestLock() === true && input.locked, 'legacy lock');
  uninstallDom();
  ({ el } = installDom({ lockMode: 'legacy-deny' }));
  input = new Input(el);
  assert(await input.requestLock() === false && input.dragLook && !input.locked, 'legacy error -> drag look');
});

await test('pointer lock: denied, missing API, or no answer -> false + drag-look', async () => {
  let { el } = installDom({ lockMode: 'reject' });
  let input = new Input(el);
  assert(await input.requestLock() === false && input.dragLook, 'rejected');
  uninstallDom();
  ({ el } = installDom({ lockMode: 'none' }));
  input = new Input(el);
  assert(await input.requestLock() === false && input.dragLook, 'no API');
  uninstallDom();
  ({ el } = installDom({ lockMode: 'silent' }));
  input = new Input(el);
  const t0 = Date.now();
  assert(await input.requestLock() === false && input.dragLook, 'timed out');
  const ms = Date.now() - t0;
  assert(ms >= 1400 && ms < 2500, `timeout after ${ms} ms`);
});

await test('pointer lock: denied inside the Esc cooldown -> retried once, then locks', async () => {
  const { el } = installDom({ lockMode: 'error-then-ok' });
  const input = new Input(el);
  input._unlockTime = input.now() - 300;       // the user pressed Esc 0.3 s ago
  const t0 = Date.now();
  const ok = await input.requestLock();
  const ms = Date.now() - t0;
  assert(ok === true && input.locked && !input.dragLook, 'locked after retry');
  assert(ms > 800 && ms < 1400, `retried after ${ms} ms`);
  assert(el.lockCalls.length === 2, `calls ${el.lockCalls.length}`);
});

await test('pointer lock: a later successful lock turns drag-look off', async () => {
  const { el, doc } = installDom({ lockMode: 'reject' });
  const input = new Input(el);
  await input.requestLock();
  assert(input.dragLook, 'drag look on');
  doc.pointerLockElement = el;
  doc.dispatchEvent(makeEvent('pointerlockchange'));
  assert(input.locked && !input.dragLook, 'locked, drag look off');
});

await test('drag-look: still click = click, drag = look without click, still hold = held button', () => {
  const { el, win } = installDom();
  const input = new Input(el);
  let t = 0;
  input.now = () => t;
  input.dragLook = true;
  // Click with a 2 px wobble.
  const d = mouse(el, 'mousedown', { button: 0, clientX: 100, clientY: 100 });
  assert(d.defaultPrevented, 'no text selection');
  mouse(win, 'mousemove', { clientX: 102, clientY: 101 });
  assert(!input.buttonPressed(0) && !input.buttonDown(0), 'undecided while pressed');
  t += 90;
  mouse(win, 'mouseup', { button: 0 });
  assert(input.buttonPressed(0) && !input.buttonDown(0), 'click on release');
  assert(input.mouseDelta().join() === '0,0', 'no look for a click');
  input.endFrame();
  // Drag: rotates by the full movement since the press, swallows the click.
  mouse(el, 'mousedown', { button: 2, clientX: 100, clientY: 100 });
  mouse(win, 'mousemove', { clientX: 103, clientY: 100 });
  mouse(win, 'mousemove', { clientX: 110, clientY: 100 });
  assert(input.mouseDelta().join() === '10,0', `drag delta ${input.mouseDelta()}`);
  input.endFrame();
  mouse(win, 'mousemove', { clientX: 130, clientY: 105 });
  assert(input.mouseDelta().join() === '20,5', `drag delta 2 ${input.mouseDelta()}`);
  t += 1000;
  mouse(win, 'mouseup', { button: 2 });
  assert(!input.buttonPressed(2) && !input.buttonDown(2), 'drag swallows the click');
  input.endFrame();
  // Hold still: becomes a held button (hold-to-break), pressed exactly once.
  mouse(el, 'mousedown', { button: 0, clientX: 50, clientY: 50 });
  t += 100;
  assert(!input.buttonDown(0), 'not yet held');
  t += 250;
  assert(input.buttonPressed(0) && input.buttonDown(0), 'held after 280 ms');
  input.endFrame();
  assert(!input.buttonPressed(0) && input.buttonDown(0), 'pressed only once');
  mouse(win, 'mousemove', { clientX: 80, clientY: 50 });
  assert(input.mouseDelta()[0] === 30 && input.buttonDown(0), 'can look around while holding');
  mouse(win, 'mouseup', { button: 0 });
  assert(!input.buttonDown(0) && !input.buttonPressed(0), 'release ends the hold, no extra click');
  // Not locked and not drag-look: plain movement is ignored.
  input.dragLook = false;
  input.endFrame();
  mouse(win, 'mousemove', { clientX: 300, clientY: 300, movementX: 50, movementY: 50 });
  assert(input.mouseDelta().join() === '0,0', 'no look from a free cursor');
});

await test('requestLock blurs a focused menu button (Space must not re-click it)', async () => {
  const { el, doc } = installDom({ lockMode: 'promise' });
  let blurred = false;
  doc.activeElement = { tagName: 'BUTTON', blur() { blurred = true; } };
  const input = new Input(el);
  await input.requestLock();
  assert(blurred, 'focused button blurred');
});

await test('Input + Player: keyboard walks, locked mouse turns the camera', async () => {
  const { el, win } = installDom({ lockMode: 'promise' });
  const input = new Input(el);
  await input.requestLock();
  const player = new Player(new MockWorld(), input, null);
  player.pos = [0.5, 61, -0.5];
  player.yaw = 0;
  key(win, 'keydown', 'KeyW');
  for (let i = 0; i < 60; i++) { player.update(1 / 60, {}, true); input.endFrame(); }
  assert(player.pos[2] < -3.5, `walked to z ${player.pos[2]}`);
  mouse(win, 'mousemove', { movementX: 1, movementY: 0 });  // skipped (first after lock)
  mouse(win, 'mousemove', { movementX: 100, movementY: 0 });
  player.update(1 / 60, { sensitivity: 1 }, true);
  input.endFrame();
  assert(Math.abs(player.yaw + 0.22) < 1e-9, `yaw ${player.yaw}`);
  key(win, 'keydown', 'Digit4');
  player.update(1 / 60, {}, true);
  input.endFrame();
  assert(player.selected === 3, 'hotbar key');
  input.destroy();
  key(win, 'keydown', 'KeyS');
  assert(!input.isDown('KeyS'), 'destroy removes listeners');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
