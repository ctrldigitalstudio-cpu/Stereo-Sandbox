// First-person player: Minecraft-style movement with swept AABB collision, swimming and creative
// flight, the block-targeting raycast, break / place / pick interaction and the hotbar.
//
// Velocities are integrated in closed form (exponential approach toward a wish velocity, exact
// parabolas under gravity) inside small sub-steps, so movement feels the same at any frame rate
// and fast motion can never tunnel through blocks.

import {
  B, BLOCKS, SOLID, SHAPE, REPLACEABLE, SHAPE_CROSS, SHAPE_TORCH, SHAPE_FLUID, HEIGHT, DEFAULT_HOTBAR,
} from './blocks.js';
import { forwardFromYawPitch } from './math.js';

// Body: 0.6 x 1.8 x 0.6 box, feet at pos.
const HALF = 0.3;
const TALL = 1.8;
const EYE = 1.62;
const EYE_SNEAK = 1.27;

// Walking (m/s). Rates (1/s) say how fast velocity approaches the wish velocity.
const WALK = 4.317;
const SPRINT = 5.612;
const SNEAK = 1.31;
const GRAVITY = 32;
const JUMP = 9;                  // apex 81 / 64 ≈ 1.27 blocks
const TERMINAL = 60;
const SPRINT_JUMP_BOOST = 1.8;   // sprint-jumping carries you further, as in Minecraft
const AIR_K = 2.0;               // reduced air control
const groundRate = (slip) => -Math.log(slip * 0.91) * 20;   // Minecraft friction per tick -> rate
const GROUND_K = groundRate(0.6);                          // ≈ 12: snappy
const ICE_K = groundRate(0.98);                            // ≈ 2.3: slippery

// Creative flight.
const FLY = 10.9;
const FLY_SPRINT = 21;
const FLY_VERT = 8;
const FLY_K = 3.2;
const FLY_VK = 8;

// Fluids: horizontal speed / sprint speed / rate, vertical sink / Shift sink / swim-up / rate.
const WATER = { speed: 2.0, sprint: 2.9, k: 4.46, sink: -1.6, sinkFast: -3.2, up: 2.6, kv: 4.46 };
const LAVA = { speed: 1.0, sprint: 1.3, k: 9, sink: -1.0, sinkFast: -2.0, up: 1.6, kv: 9 };
const SWIM_DEPTH = 0.4;          // deeper than this, Space swims up instead of jumping
const EDGE_HOP = 6.5;            // upward kick when swimming against a ledge at the surface
const SURFACE = 14 / 16;         // fluid top when no fluid above (matches the mesher)
const SPLASH_SPEED = 4.5;        // entering water falling faster than this splashes

// Interaction.
const REACH = 6;
const REPEAT = 0.25;             // break / place repeat while the button is held
const SWING_TIME = 0.25;
const EQUIP_TIME = 0.3;
const DOUBLE_TAP = 0.3;
const LOOK = 0.0022;             // radians per mouse count at sensitivity 1
const PITCH_LIMIT = (89.9 * Math.PI) / 180;

// Integration.
const MAX_DT = 0.1;
const SUB_DT = 0.02;
const SUB_MOVE = 0.4;
const EPS = 1e-7;
const STRIDE = 0.6;              // walk-cycle units per metre: a footstep every 1 / 0.6 m (Minecraft)
const SWIM_STROKE = 1.8;         // metres swum per swim sound

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];
const NUMPAD = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9'];

const noop = () => {};

// Closed-form v' = k (target - v) over h: returns the displacement, leaves the new velocity in _v.
let _v = 0;
function approach(v0, target, k, h) {
  const e = Math.exp(-k * h);
  _v = target + (v0 - target) * e;
  return target * h + ((v0 - target) * (1 - e)) / k;
}

// Free fall over h with the terminal-velocity clamp; new velocity in _v.
function fall(v0, h) {
  if (v0 <= -TERMINAL) { _v = -TERMINAL; return -TERMINAL * h; }
  const v1 = v0 - GRAVITY * h;
  if (v1 >= -TERMINAL) { _v = v1; return (v0 + v1) * 0.5 * h; }
  const t1 = (v0 + TERMINAL) / GRAVITY;
  _v = -TERMINAL;
  return v0 * t1 - 0.5 * GRAVITY * t1 * t1 - TERMINAL * (h - t1);
}

export class Player {
  constructor(world, input, sound) {
    this.world = world;
    this.input = input || null;
    this.sound = sound || null;

    this.pos = [0, 80, 0];         // feet centre
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.flying = false;
    this.onGround = false;
    this.inWater = false;
    this.inLava = false;
    this.eyeInWater = false;
    this.eyeInLava = false;
    this.waterDepth = 0;           // how deep the body is in fluid (0..1.8 blocks)
    this.sprinting = false;
    this.sneaking = false;

    this.target = null;
    this.reach = REACH;
    this.hotbar = DEFAULT_HOTBAR.slice();
    this.selected = 0;
    this.swing = 0;
    this.equip = 0;

    this.onBreak = noop;
    this.onPlace = noop;
    this.onStep = noop;
    this.onSplash = noop;

    this.time = 0;
    this._eyeH = EYE;
    this._groundK = GROUND_K;
    this._walk = 0;                // walk cycle (footsteps)
    this._nextStep = 1;
    this._swim = 0;
    this._bobAmp = 0;
    this._fov = 1;
    this._viewBob = true;
    this._lastSpace = -Infinity;
    this._lastFwd = -Infinity;
    this._breakT = 0;
    this._placeT = 0;
    this._swingT = -1;
    this._equipT = -1;
    this._held = undefined;
    this._splashT = -Infinity;
    this._fx = 0;
    this._fz = -1;
    this._q = [0, 0, 0];
  }

  eye() {
    return [this.pos[0], this.pos[1] + this._eyeH, this.pos[2]];
  }

  // View-bob offsets (blocks): x along the camera's right vector, y vertical.
  bob() {
    if (!this._viewBob || this.flying || this._bobAmp < 1e-4) return { x: 0, y: 0 };
    const ph = this._walk * Math.PI, a = this._bobAmp;
    return { x: Math.sin(ph) * a * 0.6, y: -Math.abs(Math.cos(ph)) * a * 1.2 };
  }

  fovScale() {
    return this._fov;
  }

  update(dt, settings, allowInput = true) {
    dt = Math.min(Math.max(Number(dt) || 0, 0), MAX_DT);
    const s = settings || {};
    this.time += dt;
    this._viewBob = s.viewBobbing !== false;
    const inp = allowInput ? this.input : null;

    let fwd = 0, strafe = 0, jump = false, down = false, sprintKey = false;
    if (inp) {
      const [mx, my] = inp.mouseDelta();
      const sens = LOOK * (s.sensitivity > 0 ? s.sensitivity : 1);
      this.yaw -= mx * sens;
      this.pitch -= my * sens * (s.invertY ? -1 : 1);
      fwd = (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0);
      strafe = (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0);
      jump = inp.isDown('Space');
      down = inp.isDown('ShiftLeft') || inp.isDown('ShiftRight');
      if (inp.pressed('Space')) {
        if (this.time - this._lastSpace <= DOUBLE_TAP) { this.toggleFlying(); this._lastSpace = -Infinity; } else this._lastSpace = this.time;
      }
      if (inp.pressed('KeyF')) this.toggleFlying();
      if (inp.pressed('KeyW') || inp.pressed('ArrowUp')) {
        if (this.time - this._lastFwd <= DOUBLE_TAP) sprintKey = true;
        this._lastFwd = this.time;
      }
      if (inp.isDown('KeyR')) sprintKey = true;
      for (let i = 0; i < 9; i++) if (inp.pressed(DIGITS[i]) || inp.pressed(NUMPAD[i])) this.selected = i;
      const w = inp.wheel();
      if (w) this.selected = (((this.selected + Math.round(w)) % 9) + 9) % 9;
    }
    this.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, this.pitch));
    if (this.yaw > Math.PI || this.yaw < -Math.PI) this.yaw -= Math.round(this.yaw / (2 * Math.PI)) * 2 * Math.PI;

    this.sneaking = down && !this.flying;
    if (fwd <= 0 || this.sneaking) this.sprinting = false;
    else if (sprintKey) this.sprinting = true;

    // Wish direction in the horizontal plane: forward (-sin, -cos), right (cos, -sin).
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this._fx = -sy;
    this._fz = -cy;
    let wx = -sy * fwd + cy * strafe, wz = -cy * fwd - sy * strafe;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }

    if (dt > 0) {
      const v = this.vel;
      const speed = Math.hypot(v[0], v[1], v[2]) + GRAVITY * dt;
      const n = Math.min(64, Math.max(1, Math.ceil(dt / SUB_DT - 1e-9), Math.ceil((speed * dt) / SUB_MOVE)));
      const h = dt / n;
      for (let i = 0; i < n; i++) this._step(h, wx, wz, jump, down);
    }
    this._updateEye(dt);
    this._updateTarget();
    if (inp && this._interact(inp, dt)) this._updateTarget();
    this._animate(dt);                 // after interaction so a swing shows in the same frame
  }

  toggleFlying() {
    this.flying = !this.flying;
    if (this.flying) this.onGround = false;
  }

  // ---- physics -------------------------------------------------------------------------------

  _step(h, wx, wz, jump, down) {
    const v = this.vel;
    const fluid = this.flying ? null : this.inLava ? LAVA : this.inWater ? WATER : null;
    let dx, dy, dz;

    if (this.flying) {
      const sp = this.sprinting ? FLY_SPRINT : FLY;
      dx = approach(v[0], wx * sp, FLY_K, h); v[0] = _v;
      dz = approach(v[2], wz * sp, FLY_K, h); v[2] = _v;
      const vt = ((jump ? 1 : 0) - (down ? 1 : 0)) * FLY_VERT * (this.sprinting ? 1.25 : 1);
      dy = approach(v[1], vt, FLY_VK, h); v[1] = _v;
    } else if (fluid) {
      const sp = this.sprinting ? fluid.sprint : fluid.speed;
      dx = approach(v[0], wx * sp, fluid.k, h); v[0] = _v;
      dz = approach(v[2], wz * sp, fluid.k, h); v[2] = _v;
      const deep = this.waterDepth > SWIM_DEPTH;
      if (jump && this.onGround && !deep) { v[1] = JUMP; this.onGround = false; }
      const vt = down ? fluid.sinkFast : jump && deep ? fluid.up : fluid.sink;
      dy = approach(v[1], vt, fluid.kv, h); v[1] = _v;
    } else {
      if (jump && this.onGround) {
        v[1] = JUMP;
        this.onGround = false;
        if (this.sprinting) { v[0] += this._fx * SPRINT_JUMP_BOOST; v[2] += this._fz * SPRINT_JUMP_BOOST; }
      }
      const sp = this.sneaking ? SNEAK : this.sprinting ? SPRINT : WALK;
      const k = this.onGround ? this._groundK : AIR_K;
      dx = approach(v[0], wx * sp, k, h); v[0] = _v;
      dz = approach(v[2], wz * sp, k, h); v[2] = _v;
      dy = fall(v[1], h); v[1] = _v;
    }

    // Sneaking on the ground never walks off an edge (Minecraft's back-off-from-edge).
    if (this.sneaking && this.onGround && !fluid && dy <= 0) {
      const ex = this._edgeClamp(dx, dz);
      if (ex[0] !== dx) { dx = ex[0]; v[0] = 0; }
      if (ex[1] !== dz) { dz = ex[1]; v[2] = 0; }
    }

    const vyBefore = v[1];
    const ry = this._move(1, dy);
    let landed = false;
    if (ry !== dy) {
      landed = dy < 0;
      v[1] = 0;
    }
    const rx = this._move(0, dx);
    const rz = this._move(2, dz);
    let hcol = false;
    if (rx !== dx) { v[0] = 0; hcol = true; }
    if (rz !== dz) { v[2] = 0; hcol = true; }
    this.onGround = landed;
    for (let i = 0; i < 3; i++) if (Math.abs(v[i]) < 1e-6) v[i] = 0;

    const wasIn = this.inWater;
    this._updateFluids();
    const inFluid = this.inWater || this.inLava;

    if (landed) {
      if (this.flying) this.flying = false;          // creative-style: touching down ends flight
      if (vyBefore < -7 && !inFluid) {              // landing thud (a jump or a fall)
        this._stepSound();
        this._nextStep = Math.floor(this._walk) + 1;
      }
    }
    if (this.onGround) {
      const g = this._groundBlock();
      this._groundK = g === B.ICE || g === B.PACKED_ICE ? ICE_K : GROUND_K;
    }
    if (!wasIn && this.inWater && vyBefore < -SPLASH_SPEED && this.time - this._splashT > 0.4) {
      this._splashT = this.time;
      this.onSplash();
    }
    // Swimming into a ledge at the surface: hop out, like Minecraft.
    if (inFluid && jump && hcol && !this.flying && this._boxFree(dx, 0.6, dz)) v[1] = Math.max(v[1], EDGE_HOP);
    // Running head-on into a wall stops the sprint.
    if (hcol && this.sprinting && v[0] * this._fx + v[2] * this._fz < 1) this.sprinting = false;

    if (this.onGround && !this.flying && !inFluid) {
      this._walk += Math.hypot(rx, rz) * STRIDE;
      if (this._walk >= this._nextStep) {
        this._nextStep = Math.floor(this._walk) + 1;
        this._stepSound();
      }
    } else if (this.inWater && !this.flying) {
      this._swim += Math.hypot(rx, ry, rz);
      if (this._swim >= SWIM_STROKE) { this._swim = 0; this.onStep(B.WATER); }
    }
  }

  // Sweep the body along one axis through whole cell layers; stops flush against the first solid
  // layer. Cells the body already overlaps are ignored so a stuck player can still move out.
  _move(axis, d) {
    if (d === 0) return 0;
    const p = this.pos;
    const a1 = axis === 0 ? 1 : 0, a2 = axis === 2 ? 1 : 2;
    const lo = (a) => (a === 1 ? p[1] : p[a] - HALF);
    const hi = (a) => (a === 1 ? p[1] + TALL : p[a] + HALF);
    const i0 = Math.floor(lo(a1) + EPS), i1 = Math.ceil(hi(a1) - EPS) - 1;
    const j0 = Math.floor(lo(a2) + EPS), j1 = Math.ceil(hi(a2) - EPS) - 1;
    let moved = d;
    if (d > 0) {
      const edge = hi(axis);
      for (let c = Math.ceil(edge - EPS); c < edge + d - EPS; c++) {
        if (this._layerSolid(axis, c, a1, i0, i1, a2, j0, j1)) { moved = Math.min(d, c - edge); break; }
      }
    } else {
      const edge = lo(axis);
      for (let c = Math.floor(edge + EPS) - 1; c + 1 > edge + d + EPS; c--) {
        if (this._layerSolid(axis, c, a1, i0, i1, a2, j0, j1)) { moved = Math.max(d, c + 1 - edge); break; }
      }
    }
    p[axis] += moved;
    return moved;
  }

  _layerSolid(axis, c, a1, i0, i1, a2, j0, j1) {
    const q = this._q, w = this.world;
    q[axis] = c;
    for (let i = i0; i <= i1; i++) {
      q[a1] = i;
      for (let j = j0; j <= j1; j++) {
        q[a2] = j;
        if (w.isSolid(q[0], q[1], q[2])) return true;
      }
    }
    return false;
  }

  // Does the body, offset by (ox, oy, oz), overlap a solid cell (or, with fluids, a fluid cell)?
  _boxHits(ox, oy, oz, fluids) {
    const p = this.pos, w = this.world;
    const x0 = Math.floor(p[0] - HALF + ox + EPS), x1 = Math.ceil(p[0] + HALF + ox - EPS) - 1;
    const y0 = Math.floor(p[1] + oy + EPS), y1 = Math.ceil(p[1] + TALL + oy - EPS) - 1;
    const z0 = Math.floor(p[2] - HALF + oz + EPS), z1 = Math.ceil(p[2] + HALF + oz - EPS) - 1;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (w.isSolid(x, y, z)) return true;
          if (fluids) {
            const id = w.getBlock(x, y, z);
            if (id > 0 && SHAPE[id] === SHAPE_FLUID) return true;
          }
        }
      }
    }
    return false;
  }

  _boxFree(ox, oy, oz) {
    return !this._boxHits(ox, oy, oz, true);
  }

  // Minecraft's sneak edge guard: shrink the horizontal move while the body, moved by it and
  // lowered 0.6, would no longer rest on anything.
  _edgeClamp(dx, dz) {
    const S = 0.05;
    const shrink = (d) => (Math.abs(d) < S ? 0 : d - Math.sign(d) * S);
    while (dx !== 0 && !this._boxHits(dx, -0.6, 0)) dx = shrink(dx);
    while (dz !== 0 && !this._boxHits(0, -0.6, dz)) dz = shrink(dz);
    while (dx !== 0 && dz !== 0 && !this._boxHits(dx, -0.6, dz)) { dx = shrink(dx); dz = shrink(dz); }
    return [dx, dz];
  }

  _updateFluids() {
    const p = this.pos, w = this.world;
    const x0 = Math.floor(p[0] - HALF + EPS), x1 = Math.ceil(p[0] + HALF - EPS) - 1;
    const z0 = Math.floor(p[2] - HALF + EPS), z1 = Math.ceil(p[2] + HALF - EPS) - 1;
    const y0 = Math.floor(p[1] + EPS), y1 = Math.ceil(p[1] + TALL - EPS) - 1;
    let depth = 0, water = false, lava = false;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = w.getBlock(x, y, z);
          if (id !== B.WATER && id !== B.LAVA) continue;
          const top = y + (w.getBlock(x, y + 1, z) === id ? 1 : SURFACE);
          if (top <= p[1] + EPS) continue;
          if (top - p[1] > depth) depth = top - p[1];
          if (id === B.WATER) water = true; else lava = true;
        }
      }
    }
    this.waterDepth = Math.min(depth, TALL);
    this.inWater = water;
    this.inLava = lava;
  }

  _fluidAt(x, y, z, id) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    if (this.world.getBlock(bx, by, bz) !== id) return false;
    return y < by + (this.world.getBlock(bx, by + 1, bz) === id ? 1 : SURFACE);
  }

  // Id of the solid block the player stands on (centre first, then the footprint corners).
  _groundBlock() {
    const p = this.pos, w = this.world;
    const y = Math.floor(p[1] - 0.2);
    let id = w.getBlock(Math.floor(p[0]), y, Math.floor(p[2]));
    if (id > 0 && SOLID[id]) return id;
    for (let i = 0; i < 4; i++) {
      id = w.getBlock(Math.floor(p[0] + (i & 1 ? HALF : -HALF)), y, Math.floor(p[2] + (i & 2 ? HALF : -HALF)));
      if (id > 0 && SOLID[id]) return id;
    }
    return 0;
  }

  _stepSound() {
    const id = this._groundBlock();
    if (id > 0) this.onStep(id);
  }

  // ---- camera + animation ----------------------------------------------------------------------

  _updateEye(dt) {
    const target = this.sneaking ? EYE_SNEAK : EYE;
    this._eyeH += (target - this._eyeH) * (1 - Math.exp(-14 * dt));
    const e = this.eye();
    this.eyeInWater = this._fluidAt(e[0], e[1], e[2], B.WATER);
    this.eyeInLava = !this.eyeInWater && this._fluidAt(e[0], e[1], e[2], B.LAVA);
  }

  _animate(dt) {
    const v = this.vel;
    const hs = Math.hypot(v[0], v[2]);
    const walking = this.onGround && !this.flying && !this.inWater && !this.inLava;
    const bobTarget = walking ? Math.min(hs / 20, 0.1) : 0;
    this._bobAmp += (bobTarget - this._bobAmp) * (1 - Math.exp(-10 * dt));

    let fov = 1;
    if (this.flying) fov = 1 + 0.12 * Math.min(1, Math.max(0, (hs - FLY * 0.9) / (FLY_SPRINT - FLY * 0.9)));
    else if (this.sprinting && hs > 1) fov = 1.12;
    if (this.eyeInWater) fov *= 0.94;
    this._fov += (fov - this._fov) * (1 - Math.exp(-8 * dt));

    if (this._swingT >= 0) {
      this._swingT += dt;
      if (this._swingT >= SWING_TIME) this._swingT = -1;
    }
    this.swing = this._swingT >= 0 ? this._swingT / SWING_TIME : 0;

    // equip: 1 right after the held block changes (lowered), easing back to 0 (at rest).
    const held = this.hotbar[this.selected];
    if (held !== this._held) {
      if (this._held !== undefined) this._equipT = 0;
      this._held = held;
    }
    if (this._equipT >= 0) {
      this._equipT += dt;
      if (this._equipT >= EQUIP_TIME) this._equipT = -1;
    }
    const e = this._equipT >= 0 ? 1 - this._equipT / EQUIP_TIME : 0;
    this.equip = e * e;
  }

  // ---- targeting + interaction -------------------------------------------------------------------

  _updateTarget() {
    this.target = this.raycast(this.eye(), forwardFromYawPitch(this.yaw, this.pitch), this.reach);
  }

  // Voxel DDA (Amanatides & Woo). Hits any block that isn't air or fluid (plants and torches use
  // their full cell); returns the cell, the normal of the face the ray entered through, the id and
  // the distance. A ray starting inside a block hits it, facing back along the ray's major axis.
  raycast(origin, dir, reach = REACH) {
    const w = this.world;
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(len > 0)) return null;
    const dx = dir[0] / len, dy = dir[1] / len, dz = dir[2] / len;
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    // On an exact cell boundary, start in the cell the ray is heading into.
    let x = sx < 0 ? Math.ceil(ox) - 1 : Math.floor(ox);
    let y = sy < 0 ? Math.ceil(oy) - 1 : Math.floor(oy);
    let z = sz < 0 ? Math.ceil(oz) - 1 : Math.floor(oz);
    const tdx = sx ? Math.abs(1 / dx) : Infinity;
    const tdy = sy ? Math.abs(1 / dy) : Infinity;
    const tdz = sz ? Math.abs(1 / dz) : Infinity;
    let tmx = sx > 0 ? (x + 1 - ox) / dx : sx < 0 ? (x - ox) / dx : Infinity;
    let tmy = sy > 0 ? (y + 1 - oy) / dy : sy < 0 ? (y - oy) / dy : Infinity;
    let tmz = sz > 0 ? (z + 1 - oz) / dz : sz < 0 ? (z - oz) / dz : Infinity;
    let nx = 0, ny = 0, nz = 0, t = 0;
    for (let i = 0; i < 256; i++) {
      if (y < 0) return null;
      const id = y >= HEIGHT ? 0 : w.getBlock(x, y, z);
      if (id < 0) return null;                   // unloaded: nothing to target
      if (id > 0 && SHAPE[id] !== SHAPE_FLUID) {
        if (i === 0) {
          const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
          if (ax >= ay && ax >= az) nx = -sx || 1; else if (ay >= az) ny = -sy || 1; else nz = -sz || 1;
        }
        return { x, y, z, nx, ny, nz, id, dist: t };
      }
      if (tmx < tmy && tmx < tmz) {
        t = tmx; x += sx; tmx += tdx; nx = -sx; ny = 0; nz = 0;
      } else if (tmy < tmz) {
        t = tmy; y += sy; tmy += tdy; nx = 0; ny = -sy; nz = 0;
      } else {
        t = tmz; z += sz; tmz += tdz; nx = 0; ny = 0; nz = -sz;
      }
      if (t > reach) return null;
    }
    return null;
  }

  // Returns true when a block changed (so the target is re-cast).
  _interact(inp, dt) {
    let changed = false;

    const lp = inp.buttonPressed(0), ld = inp.buttonDown(0);
    if (lp) { this._breakT = 0; this._startSwing(); }
    if (lp || ld) {
      if (!lp) this._breakT -= dt;
      if (this._breakT <= 1e-6) {
        if (this.target && this.breakTarget()) {
          changed = true;
          this._breakT = Math.max(0, this._breakT + REPEAT);
          this._startSwing();
        } else {
          this._breakT = 0;
        }
      }
    }

    const rp = inp.buttonPressed(2), rd = inp.buttonDown(2);
    if (rp) this._placeT = 0;
    if (rp || rd) {
      if (!rp) this._placeT -= dt;
      if (this._placeT <= 1e-6) {
        if (!changed && this.target && this.placeTarget()) {
          changed = true;
          this._placeT = Math.max(0, this._placeT + REPEAT);
          this._startSwing();
        } else {
          this._placeT = 0;
        }
      }
    }

    if (inp.buttonPressed(1)) this.pickTarget();
    return changed;
  }

  _startSwing() {
    this._swingT = 0;
  }

  // Water flows into a hole next to water (sides or above).
  _fillFor(x, y, z) {
    const w = this.world, W = B.WATER;
    return w.getBlock(x + 1, y, z) === W || w.getBlock(x - 1, y, z) === W || w.getBlock(x, y, z + 1) === W
      || w.getBlock(x, y, z - 1) === W || w.getBlock(x, y + 1, z) === W ? W : B.AIR;
  }

  breakTarget() {
    const t = this.target;
    if (!t) return false;
    const def = BLOCKS[t.id];
    if (!def || def.unbreakable) return false;
    const w = this.world;
    if (w.setBlock(t.x, t.y, t.z, this._fillFor(t.x, t.y, t.z)) === false) return false;
    this.onBreak(t.x, t.y, t.z, t.id);
    // A plant or torch standing on the broken block loses its support.
    const above = w.getBlock(t.x, t.y + 1, t.z);
    if (above > 0 && (SHAPE[above] === SHAPE_CROSS || SHAPE[above] === SHAPE_TORCH)) {
      if (w.setBlock(t.x, t.y + 1, t.z, this._fillFor(t.x, t.y + 1, t.z)) !== false) this.onBreak(t.x, t.y + 1, t.z, above);
    }
    return true;
  }

  placeTarget() {
    const t = this.target;
    if (!t) return false;
    const id = this.hotbar[this.selected];
    const def = BLOCKS[id];
    if (!(id > 0) || !def || !def.placeable) return false;
    const w = this.world;
    let x = t.x, y = t.y, z = t.z;
    if (!REPLACEABLE[t.id]) { x += t.nx; y += t.ny; z += t.nz; }   // tall grass etc. is replaced in place
    if (y < 0 || y >= HEIGHT) return false;
    const cur = w.getBlock(x, y, z);
    if (cur < 0 || !REPLACEABLE[cur] || cur === id) return false;
    if (SHAPE[id] === SHAPE_CROSS || SHAPE[id] === SHAPE_TORCH) {
      // Plants and torches stand on a solid block; clicking a wall's side puts them on the floor
      // in front of it when there is one.
      if (SHAPE[cur] === SHAPE_FLUID) return false;
      const below = w.getBlock(x, y - 1, z);
      if (!(below > 0) || !SOLID[below]) return false;
    }
    if (SOLID[id] && this._overlapsCell(x, y, z)) return false;
    if (w.setBlock(x, y, z, id) === false) return false;
    this.onPlace(x, y, z, id);
    return true;
  }

  // Middle click: select the slot holding the targeted block, or put it in the current slot.
  pickTarget() {
    const t = this.target;
    if (!t) return false;
    const def = BLOCKS[t.id];
    if (!def || !def.placeable) return false;
    const i = this.hotbar.indexOf(t.id);
    if (i >= 0) this.selected = i;
    else this.hotbar[this.selected] = t.id;
    return true;
  }

  _overlapsCell(x, y, z) {
    const p = this.pos;
    return x < p[0] + HALF - EPS && x + 1 > p[0] - HALF + EPS
      && y < p[1] + TALL - EPS && y + 1 > p[1] + EPS
      && z < p[2] + HALF - EPS && z + 1 > p[2] - HALF + EPS;
  }
}
