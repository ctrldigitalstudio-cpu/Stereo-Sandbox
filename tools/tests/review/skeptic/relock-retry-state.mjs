// Skeptic check: does Input's delayed cooldown retry lock the pointer after the game state changed?
import { Input } from '../../../../src/input.js';

const t0 = Date.now();
const now = () => Date.now() - t0;
const listeners = {};
const doc = {
  pointerLockElement: null, hidden: false, activeElement: null, body: {},
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  removeEventListener() {},
  exitPointerLock() { this.pointerLockElement = null; setTimeout(() => fire('pointerlockchange'), 0); },
};
function fire(type) { for (const f of listeners[type] || []) f({}); }
let userUnlockAt = -1e9;
const calls = [];
const el = {
  addEventListener() {}, removeEventListener() {},
  requestPointerLock(opts) {
    calls.push(now());
    if (now() - userUnlockAt < 1250) {
      setTimeout(() => fire('pointerlockerror'), 0);
      return Promise.reject(Object.assign(new Error('The user has exited the lock before this request was completed.'), { name: 'NotAllowedError' }));
    }
    return new Promise((res) => setTimeout(() => { doc.pointerLockElement = el; fire('pointerlockchange'); res(); }, 5));
  },
};
globalThis.document = doc;
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const input = new Input(el);
input.now = now;
input.doc = doc;
// main.js state machine (relevant parts)
let state = 'playing', screen = null;
input.onLockChange = (locked) => { if (!locked && state === 'playing') { state = 'paused'; screen = 'pause'; } };

// Start locked
doc.pointerLockElement = el; fire('pointerlockchange');
// user presses Esc -> browser unlocks
userUnlockAt = now(); doc.pointerLockElement = null; fire('pointerlockchange');
console.log('after Esc', { state, screen, locked: input.locked });
await new Promise((r) => setTimeout(r, 300));
// Resume
state = 'playing'; screen = null;
const p = input.requestLock();
await new Promise((r) => setTimeout(r, 300));
console.log('+600 before 2nd Esc', { state, screen, locked: input.locked, dragLook: input.dragLook });
// 2nd Esc (unlocked, reaches keydown -> handleKeys -> pause())
state = 'paused'; screen = 'pause';
await new Promise((r) => setTimeout(r, 1000));
console.log('+1600', { state, screen, locked: input.locked, domLocked: doc.pointerLockElement === el, calls, promise: await Promise.race([p, new Promise(r => setTimeout(() => r('pending'), 10))]) });
