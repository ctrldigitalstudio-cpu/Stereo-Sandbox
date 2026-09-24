// Player physics + interaction tests (node). Run: node tools/tests/player/player.test.mjs

import { Player } from '../../../src/player.js';
import { B, BLOCKS, DEFAULT_HOTBAR } from '../../../src/blocks.js';
import { MockWorld, RandomWorld } from './mock.mjs';

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  ok    ${name}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: got ${a}, want ${b} ± ${tol}`); }

// Scriptable input with the same API as src/input.js.
class FakeInput {
  constructor() { this.reset(); }
  reset() {
    this.keys = new Set(); this.kp = new Set();
    this.btn = [false, false, false]; this.bp = [false, false, false];
    this.dx = 0; this.dy = 0; this.w = 0;
  }
  down(code) { if (!this.keys.has(code)) this.kp.add(code); this.keys.add(code); }
  up(code) { this.keys.delete(code); }
  tap(code) { this.down(code); this.keys.delete(code); }
  press(b) { if (!this.btn[b]) this.bp[b] = true; this.btn[b] = true; }
  release(b) { this.btn[b] = false; }
  isDown(c) { return this.keys.has(c); }
  pressed(c) { return this.kp.has(c); }
  mouseDelta() { return [this.dx, this.dy]; }
  buttonPressed(i) { return this.bp[i]; }
  buttonDown(i) { return this.btn[i]; }
  wheel() { return this.w; }
  endFrame() { this.kp.clear(); this.bp = [false, false, false]; this.dx = this.dy = 0; this.w = 0; }
}

const SETTINGS = { sensitivity: 1, invertY: false, viewBobbing: true };
const FACE_PX = -Math.PI / 2;   // yaw looking toward +X
const FACE_NZ = 0;              // yaw looking toward -Z

function setup(pos, yaw = 0, pitch = 0) {
  const world = new MockWorld();
  const input = new FakeInput();
  const p = new Player(world, input, null);
  p.pos = pos.slice();
  p.yaw = yaw;
  p.pitch = pitch;
  return { world, input, p };
}

// Run for `seconds` at a fixed dt; cb(frameIndex, time) runs before each update.
function run(p, input, seconds, dt, cb) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    if (cb) cb(i, i * dt);
    p.update(dt, SETTINGS, true);
    input.endFrame();
  }
}

const DTS = [0.005, 1 / 144, 1 / 60, 1 / 30, 0.05, 0.1];

// ---- standing, falling, jumping ------------------------------------------------------------------

test('standing still stays exactly put (fixed and random frame times)', () => {
  const { p, input } = setup([0.5, 61, 0.5]);
  let maxDev = 0;
  run(p, input, 5, 1 / 60, () => { maxDev = Math.max(maxDev, Math.abs(p.pos[0] - 0.5), Math.abs(p.pos[1] - 61), Math.abs(p.pos[2] - 0.5)); });
  let seed = 1;
  for (let i = 0; i < 300; i++) {
    seed = (seed * 16807) % 2147483647;
    p.update(0.005 + (seed / 2147483647) * 0.095, SETTINGS, true);
    input.endFrame();
    maxDev = Math.max(maxDev, Math.abs(p.pos[0] - 0.5), Math.abs(p.pos[1] - 61), Math.abs(p.pos[2] - 0.5));
  }
  assert(maxDev === 0, `position drifted by ${maxDev}`);
  assert(p.onGround, 'should be on ground');
  assert(p.vel.every((v) => v === 0), `velocity not zero: ${p.vel}`);
});

test('dropping onto the floor settles exactly on its surface', () => {
  for (const dt of DTS) {
    const { p, input } = setup([0.5, 63.37, 0.5]);
    run(p, input, 2, dt);
    assert(p.pos[1] === 61, `dt ${dt}: feet at ${p.pos[1]}`);
    assert(p.onGround, `dt ${dt}: not on ground`);
  }
});

test('jump apex ≈ 1.27 blocks at every frame rate, lands back on the floor', () => {
  for (const dt of DTS) {
    const { p, input } = setup([0.5, 61, 0.5]);
    run(p, input, 0.2, dt);               // settle
    let apex = 0, tookOff = false, landedAt = -1;
    run(p, input, 1.2, dt, (i, t) => {
      if (i === 0) input.down('Space');
      if (i === 1) input.up('Space');
      apex = Math.max(apex, p.pos[1] - 61);
      if (p.pos[1] > 61) tookOff = true;
      if (tookOff && landedAt < 0 && p.onGround) landedAt = t;
    });
    assert(tookOff, `dt ${dt}: never left the ground`);
    near(apex, 81 / 64, 0.02, `dt ${dt}: apex`);
    assert(p.pos[1] === 61 && p.onGround, `dt ${dt}: did not land (y ${p.pos[1]})`);
    near(landedAt, 2 * 9 / 32, dt + 0.021, `dt ${dt}: air time`);
  }
});

test('holding Space keeps bunny-hopping (auto re-jump on landing)', () => {
  const { p, input } = setup([0.5, 61, 0.5]);
  input.down('Space');
  let jumps = 0, wasGround = true;
  run(p, input, 2.0, 1 / 60, () => {
    if (wasGround && !p.onGround) jumps++;
    wasGround = p.onGround;
    input.kp.clear(); // no double-tap: only the initial press counts
  });
  assert(!p.flying, 'held Space must not toggle flight');
  assert(jumps >= 3, `only ${jumps} jumps in 2 s`);
});

test('falling at terminal velocity never goes through the floor', () => {
  for (const dt of DTS) {
    const { p, input } = setup([0.5, 125, 0.5]);
    p.vel = [0, -60, 0];
    let minY = Infinity, maxSpeed = 0;
    run(p, input, 4, dt, () => { minY = Math.min(minY, p.pos[1]); maxSpeed = Math.max(maxSpeed, -p.vel[1]); });
    assert(minY >= 61 - 1e-9, `dt ${dt}: went below floor (${minY})`);
    assert(p.pos[1] === 61, `dt ${dt}: ended at ${p.pos[1]}`);
    assert(maxSpeed <= 60 + 1e-9, `dt ${dt}: exceeded terminal velocity ${maxSpeed}`);
  }
  // Absurd velocity (e.g. from a buggy teleport) still can't tunnel.
  const { p, input } = setup([0.5, 70, 0.5]);
  p.vel = [0, -5000, 0];
  run(p, input, 0.3, 0.1);
  assert(p.pos[1] === 61, `absurd velocity: ended at ${p.pos[1]}`);
});

test('terminal velocity ≈ 60 m/s', () => {
  const { p, input } = setup([0.5, 127, 0.5]);
  let vmax = 0;
  run(p, input, 2.5, 1 / 60, () => { vmax = Math.max(vmax, -p.vel[1]); });
  near(vmax, 60, 1e-6, 'terminal speed');
});

test('ceiling stops upward velocity (head bump) at every frame rate', () => {
  for (const dt of DTS) {
    const { p, input } = setup([25.5, 61, 0.5]);
    run(p, input, 0.1, dt);
    let maxY = 0, bumped = false;
    run(p, input, 0.6, dt, (i) => {
      if (i === 0) input.down('Space');
      if (i === 1) input.up('Space');
      maxY = Math.max(maxY, p.pos[1]);
      if (p.pos[1] > 61 + (dt >= 0.05 ? 0.05 : 0.19)) bumped = true;   // coarse frames sample the bump late
    });
    assert(maxY <= 61.2 + 1e-9, `dt ${dt}: head went into ceiling (feet ${maxY})`);
    assert(bumped, `dt ${dt}: never reached the ceiling`);
    assert(p.pos[1] === 61 && p.onGround, `dt ${dt}: did not come back down`);
  }
});

// ---- walls, steps, unloaded chunks ---------------------------------------------------------------

test('cannot walk, sprint or fly through a wall at any frame rate', () => {
  for (const dt of DTS) {
    for (const mode of ['walk', 'sprint', 'fly', 'flysprint']) {
      const { p, input } = setup([5.5, 61, 0.5], FACE_PX);
      if (mode.startsWith('fly')) p.flying = true;
      input.down('KeyW');
      if (mode.includes('sprint')) input.down('KeyR');
      let maxX = 0;
      run(p, input, 2.5, dt, () => { maxX = Math.max(maxX, p.pos[0]); });
      assert(maxX <= 9.7 + 1e-9, `${mode} dt ${dt}: penetrated wall (x ${maxX})`);
      near(p.pos[0], 9.7, 1e-9, `${mode} dt ${dt}: should rest against the wall`);
    }
  }
});

test('absurd horizontal speed cannot tunnel through a 1-block wall', () => {
  const { p, input } = setup([5.5, 61, 0.5], FACE_PX);
  p.flying = true;
  p.vel = [3000, 0, 0];
  run(p, input, 0.2, 0.1);
  assert(p.pos[0] <= 9.7 + 1e-9, `tunnelled to x ${p.pos[0]}`);
});

test('sliding along a wall diagonally keeps the along-wall motion', () => {
  const { p, input } = setup([8.5, 61, 0.5], -Math.PI / 4 - Math.PI / 2); // facing +x, +z (south-east)
  input.down('KeyW');
  run(p, input, 1.0, 1 / 60);
  near(p.pos[0], 9.7, 1e-9, 'x pinned to wall');
  assert(p.pos[2] > 2.5, `should slide along +z, z = ${p.pos[2]}`);
});

test('a 1-block step blocks walking (no auto step-up) but can be jumped', () => {
  const { p, input } = setup([-6.5, 61, 0.5], Math.PI / 2); // facing -x
  input.down('KeyW');
  run(p, input, 1.5, 1 / 60);
  near(p.pos[0], -8.7, 1e-9, 'stopped at step');
  input.down('Space');
  let top = 0;
  run(p, input, 1.0, 1 / 60, () => { input.kp.clear(); if (p.onGround) top = Math.max(top, p.pos[1]); });
  assert(top === 62 && p.pos[0] < -9.7, `jump onto step failed: stood at ${top}, x ${p.pos[0]}`);
});

test('unloaded chunks are solid walls', () => {
  const { p, input } = setup([95.5, 61, 10.5], FACE_PX);
  p.flying = true;
  input.down('KeyW');
  input.down('KeyR');
  run(p, input, 2, 1 / 30);
  near(p.pos[0], 99.7, 1e-9, 'stopped at unloaded boundary');
});

test('player stuck inside a block can still move out', () => {
  const { p, input } = setup([10.5, 61, 0.5], Math.PI / 2); // inside the wall, facing -x
  input.down('KeyW');
  run(p, input, 1, 1 / 60);
  assert(p.pos[0] < 9.7, `could not escape: x ${p.pos[0]}`);
});

// ---- speeds ---------------------------------------------------------------------------------------

function steadySpeed(keys, opts = {}) {
  const { p, input } = setup([0.5, 61, -10.5], FACE_NZ);
  if (opts.flying) { p.flying = true; p.pos[1] = 80; }
  for (const k of keys) input.down(k);
  run(p, input, 3, 1 / 60, (i) => { if (opts.clear) input.kp.clear(); });
  return Math.hypot(p.vel[0], p.vel[2]);
}

test('walk / sprint / sneak / fly / fly-sprint speeds', () => {
  near(steadySpeed(['KeyW']), 4.317, 0.02, 'walk');
  near(steadySpeed(['KeyW', 'KeyR']), 5.612, 0.02, 'sprint (R)');
  near(steadySpeed(['KeyW', 'ShiftLeft']), 1.31, 0.02, 'sneak');
  near(steadySpeed(['KeyW', 'KeyD']), 4.317, 0.02, 'diagonal walk is normalised');
  near(steadySpeed(['KeyW'], { flying: true }), 10.9, 0.05, 'fly');
  near(steadySpeed(['KeyW', 'KeyR'], { flying: true }), 21, 0.1, 'fly sprint');
});

test('double-tap W starts sprinting; releasing W ends it; fov kicks and relaxes', () => {
  const { p, input } = setup([0.5, 61, -10.5], FACE_NZ);
  run(p, input, 0.3, 1 / 60, (i) => {
    if (i === 0) input.down('KeyW');
    if (i === 3) input.up('KeyW');
    if (i === 10) input.down('KeyW');     // second tap 0.17 s after the first
  });
  assert(p.sprinting, 'double tap should sprint');
  run(p, input, 1.5, 1 / 60);
  near(Math.hypot(p.vel[0], p.vel[2]), 5.612, 0.03, 'sprint speed');
  near(p.fovScale(), 1.12, 0.01, 'fov kick');
  input.up('KeyW');
  run(p, input, 1.0, 1 / 60);
  assert(!p.sprinting, 'sprint should end with W released');
  near(p.fovScale(), 1, 0.01, 'fov back to 1');
  // Slow double tap (0.5 s apart) does not sprint.
  const b = setup([0.5, 61, -10.5], FACE_NZ);
  run(b.p, b.input, 1, 1 / 60, (i) => {
    if (i === 0) b.input.down('KeyW');
    if (i === 3) b.input.up('KeyW');
    if (i === 33) b.input.down('KeyW');
  });
  assert(!b.p.sprinting, 'slow double tap should not sprint');
});

test('sprinting into a wall stops the sprint', () => {
  const { p, input } = setup([5.5, 61, 0.5], FACE_PX);
  input.down('KeyW');
  input.down('KeyR');
  run(p, input, 0.3, 1 / 60);
  assert(p.sprinting, 'should sprint');
  input.up('KeyR');
  run(p, input, 1.5, 1 / 60);
  assert(!p.sprinting, 'sprint should stop at the wall');
});

test('movement is frame-rate independent', () => {
  const ends = DTS.map((dt) => {
    const { p, input } = setup([0.5, 61, -0.5], FACE_NZ);
    run(p, input, 0.2, dt);   // settle onto the ground first
    input.down('KeyW');
    input.down('KeyD');
    run(p, input, 1.5, dt);
    return p.pos;
  });
  for (const e of ends) {
    near(e[0], ends[0][0], 0.01, 'x');
    near(e[2], ends[0][2], 0.01, 'z');
  }
});

test('sprint-jump carries further than a standing-sprint jump would', () => {
  const { p, input } = setup([0.5, 61, -2.5], FACE_NZ);
  input.down('KeyW');
  input.down('KeyR');
  run(p, input, 1.0, 1 / 60);
  const z0 = p.pos[2];
  input.down('Space');
  let air = 0;
  run(p, input, 0.7, 1 / 60, (i) => { if (i === 1) input.up('Space'); if (!p.onGround) air += 1 / 60; });
  const dist = z0 - p.pos[2];
  assert(dist > 0.7 * 5.612 + 0.3, `sprint jump travelled ${dist.toFixed(2)} m`);
});

// ---- sneaking --------------------------------------------------------------------------------------

test('sneaking never walks off an edge (all directions, any frame rate)', () => {
  const dirs = [[FACE_PX, 46.3, 'x'], [Math.PI / 2, 39.7, 'x'], [0, -5.3, 'z'], [Math.PI, 6.3, 'z'], [-Math.PI * 0.75, null, 'd']];
  for (const dt of DTS) {
    for (const [yaw, limit, axis] of dirs) {
      const { p, input } = setup([42.5, 63, 0.5], yaw);
      run(p, input, 0.1, dt);
      input.down('ShiftLeft');
      input.down('KeyW');
      let minY = Infinity;
      run(p, input, 6, dt, () => { minY = Math.min(minY, p.pos[1]); });
      assert(minY >= 63 - 1e-9, `dt ${dt} yaw ${yaw.toFixed(2)}: fell off (y ${minY})`);
      assert(p.onGround, `dt ${dt} yaw ${yaw.toFixed(2)}: not on ground`);
      if (axis === 'x') assert(Math.abs(p.pos[0] - limit) < 0.06, `dt ${dt}: stopped at x ${p.pos[0]} (edge ${limit})`);
      if (axis === 'z') assert(Math.abs(p.pos[2] - limit) < 0.06, `dt ${dt}: stopped at z ${p.pos[2]} (edge ${limit})`);
    }
  }
  // Without sneaking the same walk goes over the edge.
  const { p, input } = setup([42.5, 63, 0.5], FACE_PX);
  input.down('KeyW');
  run(p, input, 3, 1 / 60);
  assert(p.pos[1] === 61, `should have dropped off: y ${p.pos[1]}`);
});

test('sneaking lowers the eye smoothly to 1.27', () => {
  const { p, input } = setup([0.5, 61, 0.5]);
  near(p.eye()[1] - 61, 1.62, 1e-9, 'standing eye');
  input.down('ShiftLeft');
  run(p, input, 0.03, 0.01);
  const mid = p.eye()[1] - 61;
  assert(mid < 1.62 && mid > 1.27, `eye should be moving, got ${mid}`);
  run(p, input, 1, 1 / 60);
  near(p.eye()[1] - 61, 1.27, 1e-3, 'sneaking eye');
});

// ---- flying ----------------------------------------------------------------------------------------

test('double-tap Space toggles flying; Space rises, Shift descends; F toggles; landing ends flight', () => {
  const { p, input } = setup([0.5, 61, 0.5]);
  run(p, input, 0.1, 1 / 60);
  run(p, input, 0.25, 1 / 60, (i) => {
    if (i === 0) input.down('Space');
    if (i === 2) input.up('Space');
    if (i === 9) input.down('Space');
  });
  assert(p.flying, 'double tap should start flying');
  const y0 = p.pos[1];
  run(p, input, 1.5, 1 / 60, () => input.kp.clear());
  assert(p.pos[1] - y0 > 9, `holding Space should climb (rose ${(p.pos[1] - y0).toFixed(2)})`);
  input.up('Space');
  run(p, input, 1.0, 1 / 60);
  near(p.vel[1], 0, 0.01, 'hover when no vertical input');
  const hover = p.pos[1];
  run(p, input, 1.0, 1 / 60);
  near(p.pos[1], hover, 1e-3, 'stays put in the air');
  // F toggles off -> falls.
  input.tap('KeyF');
  run(p, input, 3, 1 / 60);
  assert(!p.flying && p.pos[1] === 61, `F should stop flight and fall: flying ${p.flying} y ${p.pos[1]}`);
  // F on, Shift down to the ground: auto-lands.
  input.tap('KeyF');
  run(p, input, 0.1, 1 / 60);
  assert(p.flying, 'F should start flight');
  input.down('Space');
  run(p, input, 0.5, 1 / 60);
  input.up('Space');
  input.down('ShiftLeft');
  run(p, input, 3, 1 / 60);
  assert(!p.flying && p.onGround && p.pos[1] === 61, `should auto-land: flying ${p.flying} y ${p.pos[1]}`);
  // Double-tap while flying stops flying.
  input.up('ShiftLeft');
  input.tap('KeyF');
  run(p, input, 0.5, 1 / 60, (i) => {
    if (i === 0) input.down('Space');
    if (i === 20) input.up('Space');
  });
  assert(p.flying && p.pos[1] > 61.5, 'flying again');
  run(p, input, 0.2, 1 / 60, (i) => {
    if (i === 0) input.tap('Space');
    if (i === 5) input.tap('Space');
  });
  assert(!p.flying, 'double tap while flying should stop flying');
});

test('flight accelerates and decelerates smoothly', () => {
  const { p, input } = setup([0.5, 80, -10.5], FACE_NZ);
  p.flying = true;
  input.down('KeyW');
  const speeds = [];
  run(p, input, 1.5, 1 / 60, () => speeds.push(Math.hypot(p.vel[0], p.vel[2])));
  for (let i = 1; i < speeds.length; i++) assert(speeds[i] >= speeds[i - 1] - 1e-9, 'speed should rise monotonically');
  assert(speeds[6] < 5, `too abrupt: ${speeds[6]} m/s after 0.1 s`);
  input.up('KeyW');
  run(p, input, 0.1, 1 / 60);
  const v = Math.hypot(p.vel[0], p.vel[2]);
  assert(v > 4 && v < 10, `should coast when released: ${v}`);
  run(p, input, 2, 1 / 60);
  assert(Math.hypot(p.vel[0], p.vel[2]) < 0.05, 'should come to rest');
});

// ---- water -----------------------------------------------------------------------------------------

test('water: slow sinking to the bottom, drag, inWater/eyeInWater flags', () => {
  const { p, input } = setup([4.5, 58, 24.5]);
  run(p, input, 0.05, 1 / 60);
  assert(p.inWater && p.eyeInWater, 'should be in water with the eye under');
  run(p, input, 1.0, 1 / 60);
  near(p.vel[1], -1.6, 0.1, 'sink speed');
  run(p, input, 3, 1 / 60);
  assert(p.pos[1] === 55 && p.onGround, `should rest on the pool floor, y ${p.pos[1]}`);
  // Horizontal swimming is slow.
  input.down('KeyW');
  run(p, input, 2, 1 / 60);
  const hs = Math.hypot(p.vel[0], p.vel[2]);
  assert(hs > 1.5 && hs < 2.3, `swim speed ${hs}`);
});

test('water: Space swims up and bobs at the surface with the head out', () => {
  const { p, input } = setup([4.5, 55, 24.5]);
  input.down('Space');
  let t = 0, reached = -1;
  run(p, input, 4, 1 / 60, () => {
    input.kp.clear();
    t += 1 / 60;
    if (reached < 0 && p.pos[1] > 59.8) reached = t;
  });
  assert(reached > 0 && reached < 3, `took ${reached} s to reach the surface`);
  let lo = Infinity, hi = -Infinity, headOut = 0, frames = 0;
  run(p, input, 3, 1 / 60, () => {
    input.kp.clear();
    lo = Math.min(lo, p.pos[1]); hi = Math.max(hi, p.pos[1]);
    frames++;
    if (!p.eyeInWater) headOut++;
  });
  assert(lo > 59.6 && hi < 61.0, `bobbing range ${lo.toFixed(3)}..${hi.toFixed(3)}`);
  assert(headOut / frames > 0.9, `head should stay above water (${headOut}/${frames})`);
  assert(!p.flying, 'must not toggle flight');
});

test('water: swimming into the shore with Space held climbs out', () => {
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.1]) {
    const { p, input } = setup([6.5, 58, 24.5], FACE_PX);
    input.down('Space');
    run(p, input, 2.5, dt, () => input.kp.clear());
    input.down('KeyW');
    run(p, input, 4, dt, () => input.kp.clear());
    assert(p.pos[0] > 9.3 && p.pos[1] >= 61 - 1e-9 && !p.inWater, `dt ${dt}: did not climb out: ${p.pos.map((v) => v.toFixed(2))}`);
  }
});

test('water: without the ledge hop the shore is not climbable by swimming alone', () => {
  const { p, input } = setup([6.5, 58, 24.5], FACE_PX);
  input.down('KeyW');  // no Space
  run(p, input, 4, 1 / 60);
  assert(p.pos[0] < 8.8, `should not get out without swimming up: x ${p.pos[0]}`);
});

test('water: falling in splashes once; walking in does not', () => {
  const { p, input } = setup([4.5, 68, 24.5]);
  let splashes = 0;
  p.onSplash = () => splashes++;
  run(p, input, 3, 1 / 60);
  assert(splashes === 1, `expected 1 splash, got ${splashes}`);
  assert(p.inWater, 'should be in the water');
  const b = setup([10.5, 61, 24.5], Math.PI / 2);
  let s2 = 0;
  b.p.onSplash = () => s2++;
  b.input.down('KeyW');
  run(b.p, b.input, 2, 1 / 60);
  assert(b.p.inWater && s2 === 0, `walking in: inWater ${b.p.inWater}, splashes ${s2}`);
});

test('lava slows like water', () => {
  const { world, p, input } = setup([60.5, 61, 0.5], FACE_NZ);
  world.fill(58, 61, -10, 63, 62, 3, B.LAVA);
  input.down('KeyW');
  run(p, input, 2, 1 / 60);
  assert(p.inLava && !p.inWater, 'should be in lava');
  const hs = Math.hypot(p.vel[0], p.vel[2]);
  assert(hs < 1.4, `lava speed ${hs}`);
});

// ---- raycast ---------------------------------------------------------------------------------------

test('raycast: axis-aligned hits with the right face', () => {
  const { p } = setup([5.5, 61, 0.5], FACE_PX);
  let r = p.raycast(p.eye(), [1, 0, 0]);
  assert(r && r.x === 10 && r.y === 62 && r.z === 0, `wall hit ${JSON.stringify(r)}`);
  assert(r.nx === -1 && r.ny === 0 && r.nz === 0, `wall normal ${JSON.stringify(r)}`);
  near(r.dist, 4.5, 1e-9, 'distance');
  r = p.raycast(p.eye(), [0, -1, 0]);
  assert(r && r.x === 5 && r.y === 60 && r.z === 0 && r.ny === 1, `floor hit ${JSON.stringify(r)}`);
  r = p.raycast([5.5, 61.5, 0.5], [0, 1, 0]);
  assert(r === null, 'nothing above within reach');
  r = p.raycast([0.5, 62.62, 0.5], [1, 0, 0]);
  assert(r === null, 'wall 9.5 away is beyond reach 6');
  r = p.raycast([25.5, 61.5, 0.5], [0, 1, 0]);
  assert(r && r.y === 63 && r.ny === -1, `ceiling from below ${JSON.stringify(r)}`);
});

test('raycast: rays starting exactly on a block face or inside a block', () => {
  const { p } = setup([0, 61, 0]);
  let r = p.raycast([11, 62.5, 0.5], [-1, 0, 0]);
  assert(r && r.x === 10 && r.nx === 1 && r.dist === 0, `touching face, looking in: ${JSON.stringify(r)}`);
  r = p.raycast([11, 62.5, 0.5], [1, 0, 0]);
  assert(r === null, `touching face, looking away must not hit it: ${JSON.stringify(r)}`);
  r = p.raycast([9, 62, 0], [1, 0, 0]);   // corner of 4 cells
  assert(r && r.x === 10 && r.nx === -1, `on an edge: ${JSON.stringify(r)}`);
  r = p.raycast([10.5, 62.5, 0.5], [1, 0.2, 0]);
  assert(r && r.x === 10 && r.y === 62 && r.nx === -1 && r.dist === 0, `inside a block: ${JSON.stringify(r)}`);
  r = p.raycast([5.5, 61, 0.5], [0, -1, 0]); // feet exactly on the floor, looking down
  assert(r && r.y === 60 && r.ny === 1 && r.dist === 0, `standing on floor: ${JSON.stringify(r)}`);
});

test('raycast: skips water, stops at unloaded chunks, hits plants', () => {
  const { world, p } = setup([0, 61, 0]);
  let r = p.raycast([4.5, 60.5, 24.5], [0, -1, 0]);
  assert(r && r.y === 54 && r.ny === 1, `through water: ${JSON.stringify(r)}`);
  r = p.raycast([97.5, 62, 10.5], [1, 0, 0]);
  assert(r === null, `unloaded: ${JSON.stringify(r)}`);
  world.fill(3, 61, 0, 3, 61, 0, B.TALL_GRASS);
  r = p.raycast([0.5, 61.5, 0.5], [1, 0, 0]);
  assert(r && r.x === 3 && r.id === B.TALL_GRASS, `plant: ${JSON.stringify(r)}`);
});

// Reference: march the ray in tiny steps and report the first non-air, non-fluid cell and the axis
// crossed to enter it. Rays whose answer depends on sub-step precision are skipped.
function marchRef(world, o, d, reach) {
  const step = 2e-4;
  const cell = (t) => [0, 1, 2].map((a) => {
    const v = o[a] + d[a] * t;
    return d[a] < 0 ? Math.ceil(v) - 1 : Math.floor(v);
  });
  let prev = cell(0);
  const hit = (c) => {
    const id = c[1] >= 128 ? 0 : world.getBlock(c[0], c[1], c[2]);
    return id > 0 && id !== B.WATER && id !== B.LAVA ? id : 0;
  };
  if (prev[1] >= 0 && hit(prev)) return { cell: prev, n: null, t: 0 };
  for (let t = step; t <= reach + step; t += step) {
    const c = cell(t);
    if (c[0] === prev[0] && c[1] === prev[1] && c[2] === prev[2]) continue;
    const changed = [0, 1, 2].filter((a) => c[a] !== prev[a]);
    if (changed.length !== 1 || Math.abs(c[changed[0]] - prev[changed[0]]) !== 1) return { ambiguous: true };
    if (c[1] < 0) return null;
    // Entry distance of this cell (exact, along the changed axis).
    const a = changed[0];
    const bound = d[a] > 0 ? c[a] : c[a] + 1;
    const te = (bound - o[a]) / d[a];
    if (Math.abs(te - reach) < 1e-3) return { ambiguous: true };
    if (te > reach) return null;
    if (hit(c)) {
      const n = [0, 0, 0];
      n[a] = -Math.sign(d[a]);
      return { cell: c, n, t: te };
    }
    prev = c;
  }
  return null;
}

test('raycast: matches a brute-force march for 3000 random rays (incl. boundary origins, diagonals)', () => {
  let checked = 0, seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 3000; i++) {
    const world = new RandomWorld(i % 7, 0.1 + 0.2 * rnd());
    const p = new Player(world, null, null);
    const o = [rnd() * 40 - 20, 30 + rnd() * 20, rnd() * 40 - 20];
    if (i % 3 === 0) for (let a = 0; a < 3; a++) if (rnd() < 0.6) o[a] = Math.round(o[a]);   // on faces / edges / corners
    let d;
    const kind = i % 5;
    if (kind === 0) { d = [0, 0, 0]; d[Math.floor(rnd() * 3)] = rnd() < 0.5 ? -1 : 1; }  // axis-aligned
    else if (kind === 1) d = [rnd() < 0.5 ? -1 : 1, rnd() < 0.5 ? -1 : 1, 0];            // 45° diagonal
    else d = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const l = Math.hypot(...d);
    d = d.map((v) => v / l);
    const ref = marchRef(world, o, d, 6);
    if (ref && ref.ambiguous) continue;
    const r = p.raycast(o, d, 6);
    const tag = `o=${o.map((v) => v.toFixed(3))} d=${d.map((v) => v.toFixed(3))}`;
    if (!ref) { assert(r === null, `expected miss, got ${JSON.stringify(r)} ${tag}`); checked++; continue; }
    assert(r, `expected hit ${ref.cell} ${tag}`);
    assert(r.x === ref.cell[0] && r.y === ref.cell[1] && r.z === ref.cell[2], `cell ${[r.x, r.y, r.z]} vs ${ref.cell} ${tag}`);
    if (ref.n) {
      assert(r.nx === ref.n[0] && r.ny === ref.n[1] && r.nz === ref.n[2], `normal ${[r.nx, r.ny, r.nz]} vs ${ref.n} ${tag}`);
      near(r.dist, ref.t, 1e-9, `dist ${tag}`);
    }
    checked++;
  }
  assert(checked > 2700, `only ${checked} rays were unambiguous`);
});

// ---- placing + breaking ----------------------------------------------------------------------------

function aim(p, x, y, z) {
  // Point the camera from the eye at (x, y, z).
  const e = p.eye();
  const dx = x - e[0], dy = y - e[1], dz = z - e[2];
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

function frame(p, input, dt = 1 / 60) {
  p.update(dt, SETTINGS, true);
  input.endFrame();
}

test('placing a solid block inside the player is refused; non-solid blocks are fine', () => {
  const { world, p, input } = setup([0.5, 61, 0.5]);
  p.pitch = -Math.PI / 2 + 0.001;
  frame(p, input);
  assert(p.target && p.target.y === 60 && p.target.ny === 1, `target ${JSON.stringify(p.target)}`);
  p.selected = DEFAULT_HOTBAR.indexOf(B.STONE);
  input.press(2);
  frame(p, input);
  input.release(2);
  assert(world.getBlock(0, 61, 0) === B.AIR, 'stone placed inside the player');
  p.selected = DEFAULT_HOTBAR.indexOf(B.TORCH);
  input.press(2);
  frame(p, input);
  input.release(2);
  assert(world.getBlock(0, 61, 0) === B.TORCH, 'torch should be placeable at the feet');
  // Right next to the player's box is fine (box spans x 0.4..1.0 - EPS; cell 1 starts at x = 1).
  p.pos = [0.7, 61, 0.5];
  aim(p, 1.5, 61.0, 0.5);
  frame(p, input);
  assert(p.target && p.target.x === 1 && p.target.y === 60, `target ${JSON.stringify(p.target)}`);
  p.selected = DEFAULT_HOTBAR.indexOf(B.STONE);
  input.press(2);
  frame(p, input);
  input.release(2);
  assert(world.getBlock(1, 61, 0) === B.STONE, 'adjacent placement should work');
});

test('placing onto the targeted face; replaceable blocks are replaced in place', () => {
  const { world, p, input } = setup([7.5, 61, 0.5], FACE_PX);
  frame(p, input);
  assert(p.target && p.target.x === 10 && p.target.nx === -1, `target ${JSON.stringify(p.target)}`);
  p.selected = DEFAULT_HOTBAR.indexOf(B.OAK_PLANKS);
  input.press(2);
  frame(p, input);
  input.release(2);
  assert(world.getBlock(9, 62, 0) === B.OAK_PLANKS, 'should place on the wall face');
  // Tall grass is replaced, not built upon.
  const b = setup([3.5, 61, 3.5], FACE_PX);
  b.world.fill(5, 61, 3, 5, 61, 3, B.TALL_GRASS);
  aim(b.p, 5.5, 61.3, 3.5);
  frame(b.p, b.input);
  assert(b.p.target && b.p.target.id === B.TALL_GRASS, `target ${JSON.stringify(b.p.target)}`);
  b.p.selected = DEFAULT_HOTBAR.indexOf(B.STONE);
  b.input.press(2);
  frame(b.p, b.input);
  assert(b.world.getBlock(5, 61, 3) === B.STONE && b.world.getBlock(4, 61, 3) === B.AIR, 'grass should be replaced');
});

test('torches and plants need a solid block below', () => {
  const { world, p, input } = setup([7.5, 61, 0.5], FACE_PX);
  p.selected = DEFAULT_HOTBAR.indexOf(B.TORCH);
  aim(p, 10, 62.5, 0.5);    // upper wall block: the cell in front has air below
  frame(p, input);
  assert(p.target && p.target.y === 62 && p.target.nx === -1, `target ${JSON.stringify(p.target)}`);
  input.press(2);
  frame(p, input);
  input.release(2);
  assert(world.getBlock(9, 62, 0) === B.AIR, 'torch without support must be refused');
  aim(p, 10, 61.5, 0.5);    // lower wall block: the cell in front stands on the floor
  frame(p, input);
  input.press(2);
  frame(p, input);
  input.release(2);
  assert(world.getBlock(9, 61, 0) === B.TORCH, 'torch in front of the wall, on the floor');
  // Plants can't go into water, blocks can.
  const b = setup([4.5, 57, 24.5]);
  b.p.flying = true;
  b.p.hotbar[0] = B.POPPY;
  b.p.selected = 0;
  aim(b.p, 4.5, 54.95, 26.5);
  frame(b.p, b.input);
  assert(b.p.target && b.p.target.y === 54 && b.p.target.z === 26, `target ${JSON.stringify(b.p.target)}`);
  b.input.press(2); frame(b.p, b.input); b.input.release(2);
  assert(b.world.getBlock(4, 55, 26) === B.WATER, 'no flowers in water');
  b.p.hotbar[0] = B.STONE;
  frame(b.p, b.input);
  b.input.press(2); frame(b.p, b.input); b.input.release(2);
  assert(b.world.getBlock(4, 55, 26) === B.STONE, 'blocks replace water');
});

test('breaking: bedrock is unbreakable, water flows into holes next to water, plants above pop off', () => {
  const { world, p, input } = setup([0.5, 61, 0.5]);
  const broken = [];
  p.onBreak = (x, y, z, id) => broken.push([x, y, z, id]);
  world.fill(3, 61, 0, 3, 61, 0, B.BEDROCK);
  aim(p, 3.5, 61.5, 0.5);
  frame(p, input);
  input.press(0);
  frame(p, input);
  input.release(0);
  assert(world.getBlock(3, 61, 0) === B.BEDROCK && broken.length === 0, 'bedrock broke');
  // Shore block next to the pool fills with water.
  const b = setup([10.5, 61, 24.5], Math.PI / 2);
  aim(b.p, 9.5, 60.5, 24.5);
  frame(b.p, b.input);
  assert(b.p.target && b.p.target.x === 9 && b.p.target.y === 60, `target ${JSON.stringify(b.p.target)}`);
  b.input.press(0);
  frame(b.p, b.input);
  assert(b.world.getBlock(9, 60, 24) === B.WATER, 'hole next to water should fill');
  // Normal hole stays air; the poppy on top pops off with its own onBreak.
  const c = setup([0.5, 61, 0.5]);
  const cb = [];
  c.p.onBreak = (x, y, z, id) => cb.push(id);
  c.world.fill(2, 61, 0, 2, 61, 0, B.DIRT);
  c.world.fill(2, 62, 0, 2, 62, 0, B.POPPY);
  aim(c.p, 2.2, 61.5, 0.5);
  frame(c.p, c.input);
  assert(c.p.target && c.p.target.id === B.DIRT, `target ${JSON.stringify(c.p.target)}`);
  c.input.press(0);
  frame(c.p, c.input);
  assert(c.world.getBlock(2, 61, 0) === B.AIR && c.world.getBlock(2, 62, 0) === B.AIR, 'dirt and poppy gone');
  assert(cb.join() === [B.DIRT, B.POPPY].join(), `onBreak ids ${cb}`);
});

test('break repeats every 0.25 s while held (any frame rate); a click breaks once', () => {
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.05, 0.1]) {
    const { world, p, input } = setup([0.5, 61, 0.5], FACE_PX);
    world.fill(2, 62, 0, 5, 62, 0, B.DIRT);   // a row of 4 targets at eye height
    world.fill(2, 61, 0, 5, 61, 0, B.DIRT);
    let breaks = 0;
    p.onBreak = () => breaks++;
    frame(p, input, dt);
    input.press(0);
    const frames = Math.round(0.9 / dt);
    for (let i = 0; i <= frames; i++) frame(p, input, dt);
    input.release(0);
    for (let i = 0; i < 10; i++) frame(p, input, dt);
    const expect = Math.floor(frames * dt / 0.25 + 1e-6) + 1;
    assert(breaks === expect, `dt ${dt.toFixed(4)}: ${breaks} breaks in ${(frames * dt).toFixed(3)} s, want ${expect}`);
  }
  const { world, p, input } = setup([0.5, 61, 0.5], FACE_PX);
  world.fill(2, 62, 0, 5, 62, 0, B.DIRT);
  let breaks = 0;
  p.onBreak = () => breaks++;
  input.press(0);
  input.release(0);            // click inside one frame (drag-look click semantics)
  for (let i = 0; i < 60; i++) frame(p, input);
  assert(breaks === 1, `click broke ${breaks} blocks`);
});

test('place repeats every 0.25 s while held, and stops at the player', () => {
  const { world, p, input } = setup([4.5, 61, 0.5], FACE_PX);
  const placed = [];
  p.onPlace = (x, y, z) => placed.push(x);
  p.selected = DEFAULT_HOTBAR.indexOf(B.STONE);
  frame(p, input);
  input.press(2);
  for (let i = 0; i <= 90; i++) frame(p, input);   // 1.5 s
  input.release(2);
  assert(placed.join() === '9,8,7,6,5', `placed at x ${placed}`);
  assert(world.getBlock(4, 62, 0) === B.AIR, 'must not place into the player');
});

test('middle click picks blocks; hotbar keys and wheel (wrapping)', () => {
  const { world, p, input } = setup([7.5, 61, 0.5], FACE_PX);
  frame(p, input);
  p.selected = 5;
  input.press(1); frame(p, input); input.release(1);
  assert(p.selected === DEFAULT_HOTBAR.indexOf(B.STONE), `pick existing -> select slot, got ${p.selected}`);
  world.fill(10, 62, 0, 10, 62, 0, B.GOLD_BLOCK);
  frame(p, input);
  p.selected = 4;
  input.press(1); frame(p, input); input.release(1);
  assert(p.hotbar[4] === B.GOLD_BLOCK && p.selected === 4, `pick new -> current slot: ${p.hotbar}`);
  world.fill(10, 62, 0, 10, 62, 0, B.BEDROCK);
  frame(p, input);
  input.press(1); frame(p, input); input.release(1);
  assert(!p.hotbar.includes(B.BEDROCK), 'bedrock is not placeable, must not be picked');
  input.tap('Digit3'); frame(p, input);
  assert(p.selected === 2, `Digit3 -> ${p.selected}`);
  input.w = 1; frame(p, input);
  assert(p.selected === 3, `wheel +1 -> ${p.selected}`);
  input.w = -5; frame(p, input);
  assert(p.selected === 7, `wheel -5 wraps -> ${p.selected}`);
  input.w = 2; frame(p, input);
  assert(p.selected === 0, `wheel +2 wraps -> ${p.selected}`);
});

test('swing and equip animations', () => {
  const { world, p, input } = setup([0.5, 61, 0.5], FACE_PX);
  world.fill(3, 62, 0, 3, 62, 0, B.DIRT);
  frame(p, input);
  assert(p.swing === 0 && p.equip === 0, 'at rest');
  input.press(0); frame(p, input); input.release(0);
  assert(p.swing > 0 && p.swing < 0.2, `swing started: ${p.swing}`);
  let last = p.swing;
  for (let i = 0; i < 10; i++) { frame(p, input); assert(p.swing > last, 'swing increases'); last = p.swing; }
  for (let i = 0; i < 10; i++) frame(p, input);
  assert(p.swing === 0, 'swing back at rest after 0.25 s');
  input.tap('Digit5'); frame(p, input);
  assert(p.equip > 0.8, `equip starts lowered: ${p.equip}`);
  for (let i = 0; i < 30; i++) frame(p, input);
  assert(p.equip === 0, 'equip back at rest');
  // Selecting a slot with the same block doesn't re-trigger.
  p.hotbar[6] = p.hotbar[4];
  input.tap('Digit7'); frame(p, input);
  assert(p.equip === 0, 'same block, no equip animation');
});

test('footsteps every ~1.67 m on the ground with the block below; landing thud; bobbing', () => {
  const { p, input } = setup([0.5, 61, -0.5], FACE_NZ);
  const steps = [];
  p.onStep = (id) => steps.push(id);
  input.down('KeyW');
  let maxBob = 0;
  run(p, input, 10 / 4.317 + 0.1, 1 / 60, () => { const b = p.bob(); maxBob = Math.max(maxBob, Math.abs(b.y)); });
  assert(steps.length >= 5 && steps.length <= 7, `${steps.length} steps over ~10 m`);
  assert(steps.every((id) => id === B.STONE), `step ids ${steps}`);
  assert(maxBob > 0.08 && maxBob <= 0.121, `bob amplitude ${maxBob}`);
  input.up('KeyW');
  run(p, input, 1, 1 / 60);
  const b = p.bob();
  assert(Math.abs(b.x) < 1e-3 && Math.abs(b.y) < 1e-3, `bob settles when standing: ${JSON.stringify(b)}`);
  p.update(1 / 60, { ...SETTINGS, viewBobbing: false }, true);
  steps.length = 0;
  p.pos = [0.5, 64, -20.5];
  run(p, input, 1, 1 / 60);
  assert(steps.length === 1, `landing thud: ${steps.length}`);
  p.flying = true;
  assert(p.bob().x === 0 && p.bob().y === 0, 'no bob when flying');
});

test('mouse look: right decreases yaw, pitch clamps at ±89.9°, sensitivity and invertY', () => {
  const { p, input } = setup([0.5, 61, 0.5]);
  input.dx = 100;
  frame(p, input);
  near(p.yaw, -0.22, 1e-12, 'yaw after 100 px right');
  input.dy = -100000;
  frame(p, input);
  near(p.pitch, 89.9 * Math.PI / 180, 1e-12, 'pitch clamp up');
  input.dy = 100000;
  frame(p, input);
  near(p.pitch, -89.9 * Math.PI / 180, 1e-12, 'pitch clamp down');
  p.pitch = 0;
  input.dy = 50;
  p.update(1 / 60, { sensitivity: 2, invertY: true }, true);
  input.endFrame();
  near(p.pitch, 50 * 0.0022 * 2, 1e-12, 'inverted, 2x sensitivity');
  p.pitch = 0;
  input.dx = 100;
  p.update(1 / 60, SETTINGS, false);
  input.endFrame();
  near(p.pitch, 0, 0, 'no look when input not allowed');
});

test('no input when allowInput is false (physics still runs)', () => {
  const { p, input } = setup([0.5, 64, 0.5]);
  input.down('KeyW');
  input.press(0);
  for (let i = 0; i < 60; i++) { p.update(1 / 60, SETTINGS, false); input.endFrame(); }
  assert(p.pos[1] === 61, 'gravity still applies');
  near(p.pos[2], 0.5, 1e-12, 'no walking');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
