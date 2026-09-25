// Synthesized sound effects. There are no audio assets: every sound is built on the fly from
// filtered noise bursts and short tones with envelopes, voiced differently per block material
// (the `sound` field of BLOCKS). WebAudio is created lazily and everything fails silently when it
// is unavailable, so audio can never break the game.

const MAX_VOICES = 28;
const OPEN_FREQ = 20000;       // effects low-pass when not underwater (effectively bypassed)
const MUFFLED_FREQ = 520;      // underwater: everything sounds dull and distant (24 dB/oct)

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const R = Math.random;

// level: loudness; len: envelope length scale; vary: random pitch spread.
const KINDS = {
  break: { level: 1.0, len: 1.35, vary: 0.08 },
  place: { level: 0.75, len: 1.0, vary: 0.06 },
  step: { level: 0.3, len: 0.75, vary: 0.14 },
  splash: { level: 0.85, len: 1.0, vary: 0.08 },
  click: { level: 0.45, len: 1.0, vary: 0.02 },
};

// Loudness trims [break, place, step] per material (and splash / click), measured with the
// A-weighted loudness harness in tools/tests/player/audio-page.js (?calibrate) so every material
// is equally loud for the same action: break +2 dB over place, footsteps -11 dB.
const TRIM = {
  stone: [1.05, 2.28, 1.94], wood: [0.75, 1.81, 1.45], grass: [0.25, 0.47, 0.47], gravel: [1.23, 1.71, 1.6],
  sand: [1.01, 1.25, 1.04], snow: [1.26, 1.78, 1.52], glass: [0.33, 2.01, 3.33], wool: [0.95, 2.2, 1.67],
  water: [0.5, 0.78, 0.65], splash: 0.37, click: 1.1,
};
TRIM.dirt = TRIM.gravel;
TRIM.lava = TRIM.water;
const KIND_SLOT = { break: 0, place: 1, step: 2 };

// One sound being assembled: schedules sources into `out` and tracks when the last one ends.
class Voice {
  constructor(sound, out) {
    this.ctx = sound.ctx;
    this.buffers = sound._buffers;
    this.out = out;
    this.end = 0;
  }

  // Filtered noise burst. o: { buf, type, f, f2, sweep, q, a, d, g, rate }
  noise(t, o) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[o.buf || 'white'];
    if (o.rate) src.playbackRate.value = o.rate;
    let node = src;
    if (o.type) {
      const f = ctx.createBiquadFilter();
      f.type = o.type;
      f.frequency.setValueAtTime(o.f, t);
      if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + (o.sweep || o.a + o.d));
      f.Q.value = o.q ?? 0.707;
      node.connect(f);
      node = f;
    }
    const g = ctx.createGain();
    envelope(g.gain, t, o.a, o.d, o.g);
    node.connect(g);
    g.connect(this.out);
    const dur = o.a + o.d + 0.02;
    const room = Math.max(0, src.buffer.duration - dur * (o.rate || 1) - 0.05);
    src.start(t, R() * room);
    src.stop(t + dur);
    this.end = Math.max(this.end, t + dur);
  }

  // Enveloped oscillator, optionally gliding to f2. o: { type, f, f2, sweep, a, d, g }
  tone(t, o) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.sweep || o.a + o.d));
    const g = ctx.createGain();
    envelope(g.gain, t, o.a, o.d, o.g);
    osc.connect(g);
    g.connect(this.out);
    const dur = o.a + o.d + 0.02;
    osc.start(t);
    osc.stop(t + dur);
    this.end = Math.max(this.end, t + dur);
  }

  // n short events scattered over `spread` seconds (crunches, rustles, debris).
  grains(t, n, spread, fn) {
    for (let i = 0; i < n; i++) fn(t + (n > 1 ? (i / (n - 1)) * spread * (0.6 + 0.4 * R()) : 0), i);
  }
}

// Linear attack, exponential decay reaching -60 dB `d` seconds later, then cut.
function envelope(param, t, a, d, g) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(g, t + a);
  param.exponentialRampToValueAtTime(g * 1e-3 + 1e-6, t + a + d);
  param.linearRampToValueAtTime(0, t + a + d + 0.01);
}

const count = (p, step, place, brk) => (p.kind === 'step' ? step : p.kind === 'place' ? place : brk);

// Material recipes: (voice, t, p) with p = { kind, level, len, pitch }.
const MATERIALS = {
  // Sharp mid-high click with a stony knock; breaking adds crumbling fragments.
  stone(v, t, p) {
    const { level: L, len, pitch: P } = p;
    v.noise(t, { type: 'bandpass', f: 2700 * P, q: 0.9, a: 0.001, d: 0.06 * len, g: 0.9 * L });
    v.noise(t, { type: 'bandpass', f: 720 * P, q: 2.2, a: 0.001, d: 0.12 * len, g: 0.8 * L });
    v.noise(t, { buf: 'brown', type: 'lowpass', f: 320 * P, a: 0.002, d: 0.09 * len, g: 0.55 * L });
    v.grains(t + 0.01, count(p, 2, 3, 3), 0.05, (tt) => v.noise(tt, {
      type: 'bandpass', f: (1200 + R() * 1600) * P, q: 2, a: 0.001, d: 0.02 + R() * 0.02, g: (0.2 + R() * 0.2) * L,
    }));
    if (p.kind === 'break') {
      v.grains(t + 0.015, 6, 0.16, (tt) => v.noise(tt, {
        type: 'bandpass', f: (1600 + R() * 2800) * P, q: 1.8, a: 0.001, d: 0.02 + R() * 0.035, g: (0.25 + R() * 0.3) * L,
      }));
      v.noise(t + 0.02, { buf: 'pink', type: 'lowpass', f: 1500, a: 0.01, d: 0.2, g: 0.28 * L });
    }
  },

  // Hollow knock: a noise impulse ringing a resonant band-pass around 400-800 Hz.
  wood(v, t, p) {
    const { level: L, len, pitch: P } = p;
    const knock = (tt, f0, g) => {
      v.noise(tt, { type: 'bandpass', f: f0, q: 11, a: 0.001, d: 0.12 * len, g: 2.6 * g });
      v.tone(tt, { f: f0, f2: f0 * 0.96, a: 0.001, d: 0.08 * len, g: 0.3 * g });
      v.tone(tt, { f: f0 * 2.61, a: 0.001, d: 0.035 * len, g: 0.1 * g });
      v.noise(tt, { type: 'bandpass', f: 3000, q: 1, a: 0.0005, d: 0.012, g: 0.3 * g });
    };
    const f0 = (430 + R() * 300) * P;
    knock(t, f0, L);
    if (p.kind === 'break') {
      knock(t + 0.055, f0 * 0.8, 0.7 * L);
      v.grains(t + 0.02, 4, 0.14, (tt) => v.noise(tt, {
        type: 'bandpass', f: 1800 + R() * 2400, q: 2, a: 0.001, d: 0.018 + R() * 0.02, g: (0.15 + R() * 0.2) * L,
      }));
    }
  },

  // Soft rustle: overlapping high-passed noise swishes.
  grass(v, t, p) {
    const { level: L, len, pitch: P } = p;
    v.grains(t, count(p, 3, 5, 9), count(p, 0.06, 0.09, 0.2), (tt) => v.noise(tt, {
      buf: 'pink', type: 'highpass', f: (2200 + R() * 2200) * P, q: 0.6, a: 0.006 + R() * 0.012, d: (0.045 + R() * 0.05) * len, g: (0.55 + R() * 0.35) * L,
    }));
    v.noise(t, { type: 'bandpass', f: 950 * P, q: 0.8, a: 0.008, d: 0.08 * len, g: 0.22 * L });
  },

  // Crunchy low-mid grains with a dull thump (dirt, gravel, clay).
  gravel(v, t, p) {
    const { level: L, len, pitch: P } = p;
    v.grains(t, count(p, 6, 8, 12), count(p, 0.08, 0.1, 0.19), (tt) => v.noise(tt, {
      type: 'bandpass', f: (320 + R() * 850) * P, q: 1.6, a: 0.001, d: 0.022 + R() * 0.024, g: (0.6 + R() * 0.4) * L,
    }));
    v.noise(t, { buf: 'brown', type: 'lowpass', f: 260 * P, a: 0.002, d: 0.07 * len, g: 0.6 * L });
  },

  // Soft hiss with a few fine grains.
  sand(v, t, p) {
    const { level: L, len, pitch: P } = p;
    v.noise(t, { type: 'bandpass', f: 3800 * P, q: 0.6, a: 0.02, d: 0.13 * len, g: 0.5 * L });
    v.grains(t + 0.01, count(p, 3, 5, 8), count(p, 0.06, 0.09, 0.16), (tt) => v.noise(tt, {
      type: 'bandpass', f: (1500 + R() * 1500) * P, q: 1, a: 0.004, d: 0.03, g: 0.22 * L,
    }));
    v.noise(t, { buf: 'brown', type: 'lowpass', f: 420 * P, a: 0.01, d: 0.06 * len, g: 0.25 * L });
  },

  // Soft, dense, squeaky crunch.
  snow(v, t, p) {
    const { level: L, len, pitch: P } = p;
    v.grains(t, count(p, 8, 10, 16), count(p, 0.09, 0.11, 0.2), (tt) => v.noise(tt, {
      type: 'bandpass', f: (1000 + R() * 1800) * P, q: 2.2, a: 0.002, d: 0.014 + R() * 0.016, g: (0.35 + R() * 0.25) * L,
    }));
    v.noise(t, { type: 'lowpass', f: 700 * P, a: 0.005, d: 0.08 * len, g: 0.35 * L });
  },

  // Bright tinkle: decaying inharmonic sine partials; breaking adds a shatter of noise.
  glass(v, t, p) {
    const { level: L, len, pitch: P } = p;
    if (p.kind === 'break') {
      v.noise(t, { type: 'bandpass', f: 1900 * P, q: 1.2, a: 0.001, d: 0.05, g: 0.6 * L });
      v.noise(t, { type: 'highpass', f: 3500, q: 0.7, a: 0.001, d: 0.18, g: 0.5 * L });
      v.grains(t, 8, 0.1, (tt) => v.tone(tt, {
        f: (2200 + R() * 5200) * P, a: 0.001, d: 0.15 + R() * 0.3, g: (0.05 + R() * 0.07) * L,
      }));
      return;
    }
    v.noise(t, { type: 'bandpass', f: 3000 * P, q: 1.4, a: 0.0008, d: 0.025 * len, g: 0.6 * L });
    v.noise(t, { type: 'lowpass', f: 900 * P, a: 0.001, d: 0.04 * len, g: 0.35 * L });
    v.grains(t, count(p, 1, 2, 2), 0.02, (tt) => v.tone(tt, {
      f: (2500 + R() * 2500) * P, a: 0.001, d: (0.06 + R() * 0.1) * len, g: 0.07 * L,
    }));
  },

  // Muffled thump (wool, cactus).
  wool(v, t, p) {
    const { level: L, len, pitch: P } = p;
    const thump = (tt, g) => {
      v.noise(tt, { buf: 'pink', type: 'lowpass', f: 480 * P, q: 0.8, a: 0.006, d: 0.1 * len, g: 1.3 * g });
      v.tone(tt, { f: 125 * P, f2: 70 * P, a: 0.003, d: 0.08 * len, g: 0.3 * g });
      v.noise(tt, { type: 'bandpass', f: 1300 * P, q: 0.7, a: 0.01, d: 0.05 * len, g: 0.12 * g });
    };
    thump(t, L);
    if (p.kind === 'break') thump(t + 0.06, 0.6 * L);
  },

  // Bubbly slosh: swept noise plus a few pitch-falling "bloop" sines.
  water(v, t, p) {
    const { level: L, len, pitch: P } = p;
    v.noise(t, { type: 'bandpass', f: 2200 * P, f2: 700 * P, sweep: 0.2, q: 0.9, a: 0.006, d: 0.2 * len, g: 0.55 * L });
    v.grains(t, count(p, 2, 3, 5), count(p, 0.08, 0.12, 0.18), (tt) => {
      const f = (500 + R() * 900) * P;
      v.tone(tt, { f, f2: f * 0.45, sweep: 0.06, a: 0.002, d: 0.05 + R() * 0.04, g: (0.1 + R() * 0.1) * L });
    });
  },
};
MATERIALS.dirt = MATERIALS.gravel;
MATERIALS.lava = MATERIALS.water;

// Plunge into water: a big low-passed sweep, a low "gloop" and a burst of bubbles.
function splash(v, t, p) {
  const { level: L, pitch: P } = p;
  v.noise(t, { type: 'lowpass', f: 5000 * P, f2: 450, sweep: 0.5, q: 0.6, a: 0.004, d: 0.5, g: 0.9 * L });
  v.noise(t + 0.02, { buf: 'pink', type: 'bandpass', f: 1200 * P, q: 0.7, a: 0.01, d: 0.3, g: 0.4 * L });
  v.tone(t, { f: 190 * P, f2: 70, sweep: 0.15, a: 0.005, d: 0.16, g: 0.3 * L });
  v.grains(t + 0.03, 9, 0.45, (tt) => {
    const f = (450 + R() * 1100) * P;
    v.tone(tt, { f, f2: f * 0.45, sweep: 0.06, a: 0.002, d: 0.05 + R() * 0.05, g: (0.06 + R() * 0.1) * L });
  });
}

// UI tick.
function click(v, t, p) {
  v.tone(t, { f: 1850, f2: 1300, a: 0.001, d: 0.04, g: 0.35 * p.level });
  v.noise(t, { type: 'highpass', f: 5000, a: 0.0005, d: 0.006, g: 0.2 * p.level });
}

// Looping noise buffers (tail cross-faded into the head so loops don't click), normalised to
// the same RMS so recipes can mix them freely.
function makeNoise(ctx, kind, seconds) {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds), fade = Math.floor(rate * 0.05);
  const raw = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = R() * 2 - 1;
    if (kind === 'white') raw[i] = w;
    else if (kind === 'pink') {
      // Paul Kellet's refined pink filter.
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last;
    }
  }
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = raw[i];
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = raw[i] * k + raw[n + i] * (1 - k);
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += d[i] * d[i];
  const scale = 0.3 / Math.max(1e-9, Math.sqrt(sum / n));
  for (let i = 0; i < n; i++) d[i] = clamp(d[i] * scale, -1, 1);
  return buf;
}

export class Sound {
  // options.context: render into an existing (e.g. Offline) AudioContext instead of creating one.
  constructor(options = {}) {
    this.ctx = null;
    this._external = options.context || null;
    this._trim = options.trim !== false;   // tests measure raw recipe loudness with trim: false
    this._failed = false;
    this._enabled = true;
    this.volume = 0.6;
    this.ambientLevel = 0;         // wind / underwater beds: off by default; ~1 = subtle
    this.listener = null;
    this.listenerYaw = 0;
    this._voices = [];             // end times of sounds still playing
    this._underwater = false;
    this._beds = null;
    this._bedsIdle = 0;
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this._applyGain();
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    this._applyGain();
  }

  // Create/unlock the context; call from a user gesture (autoplay policies).
  resume() {
    const ctx = this._init();
    if (!ctx || this._external) return Promise.resolve(!!ctx);
    try {
      if (ctx.state !== 'running' && typeof ctx.resume === 'function') return ctx.resume().then(() => true, () => false);
    } catch (e) { /* ignore */ }
    return Promise.resolve(true);
  }

  setListener(pos, yaw) {
    this.listener = pos;
    this.listenerYaw = yaw || 0;
  }

  play(kind, material, pos) {
    // Air has no sound; UI clicks and splashes ignore the material (ui.js plays ('click', 'none')).
    if (!this._enabled || this.volume <= 0 || (material === 'none' && kind !== 'click' && kind !== 'splash')) return;
    if (!this.ctx) {
      // Before any user gesture a new context would start suspended (and log a warning).
      const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
      if (!this._external && ua && !ua.hasBeenActive) return;
      if (!this._init()) return;
    }
    try {
      this._play(kind, material, pos);
    } catch (e) { /* audio must never break the game */ }
  }

  _play(kind, material, pos) {
    const ctx = this.ctx;
    if (!this._external && ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    this._voices = this._voices.filter((e) => e > now);
    const busy = this._voices.length;
    if (busy >= MAX_VOICES || (kind === 'step' && busy >= MAX_VOICES / 2)) return;

    const k = KINDS[kind] || KINDS.place;
    const mat = MATERIALS[material] ? material : 'stone';
    const recipe = kind === 'click' ? click : kind === 'splash' ? splash : MATERIALS[mat];
    let trim = 1;
    if (this._trim) trim = kind === 'click' || kind === 'splash' ? TRIM[kind] : TRIM[mat][KIND_SLOT[kind] ?? 1];
    const p = { kind, level: k.level * trim, len: k.len, pitch: 1 + (R() * 2 - 1) * k.vary };
    const t = now + 0.005;
    const out = this._output(pos);
    const v = new Voice(this, out);
    recipe(v, t, p);
    this._voices.push(v.end);
    if (!this._external) setTimeout(() => { try { out.disconnect(); } catch (e) { /* gone */ } }, (v.end - now) * 1000 + 250);
  }

  // Per-voice gain (+ light distance attenuation and stereo pan when positioned).
  _output(pos) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    let gain = 1, pan = 0;
    const L = this.listener;
    if (pos && L) {
      const dx = pos[0] - L[0], dy = pos[1] - L[1], dz = pos[2] - L[2];
      const d = Math.hypot(dx, dy, dz);
      gain = 1 / (1 + 0.07 * Math.max(0, d - 2));
      if (d > 0.25) {
        const rx = Math.cos(this.listenerYaw), rz = -Math.sin(this.listenerYaw);
        pan = clamp((dx * rx + dz * rz) / d, -1, 1) * 0.45 * Math.min(1, d / 2);
      }
    }
    g.gain.value = gain;
    if (pan && typeof ctx.createStereoPanner === 'function') {
      const sp = ctx.createStereoPanner();
      sp.pan.value = pan;
      g.connect(sp);
      sp.connect(this.sfx);
    } else {
      g.connect(this.sfx);
    }
    return g;
  }

  // time: time of day 0..1; eyeSkyLight: 0 (cave) .. 1 (open sky). Called a few times a second.
  ambient(time, underwater, eyeSkyLight) {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const uw = !!underwater;
      if (uw !== this._underwater) {
        this._underwater = uw;
        for (const f of [this.muffle, this.muffle2]) f.frequency.setTargetAtTime(uw ? MUFFLED_FREQ : this._openFreq, now, 0.06);
        this.sfx.gain.setTargetAtTime(uw ? 0.75 : 1, now, 0.06);
      }
      const level = this._enabled ? clamp(Number(this.ambientLevel) || 0, 0, 2) : 0;
      if (level <= 0) {
        if (this._beds) {
          this._beds.wind.gain.setTargetAtTime(0, now, 0.4);
          this._beds.water.gain.setTargetAtTime(0, now, 0.2);
          if (now - this._bedsIdle > 3) this._stopBeds();
        }
        return;
      }
      this._bedsIdle = now;
      if (!this._beds) this._beds = this._makeBeds();
      const sky = clamp(eyeSkyLight ?? 1, 0, 1);
      const night = time > 0.52 && time < 0.98 ? 1.25 : 1;   // the night wind carries a bit more
      this._beds.wind.gain.setTargetAtTime(uw ? 0 : level * 0.045 * sky * sky * night, now, 1.2);
      this._beds.water.gain.setTargetAtTime(uw ? level * 0.09 : 0, now, 0.25);
      if (uw && R() < 0.06) this.play('step', 'water');     // the odd bubble drifting past
    } catch (e) { /* ignore */ }
  }

  _makeBeds() {
    const ctx = this.ctx;
    const loop = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = this._buffers[buf];
      s.loop = true;
      s.start(ctx.currentTime, R() * s.buffer.duration);
      return s;
    };
    const lfo = (freq, depth, param) => {
      const o = ctx.createOscillator();
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g);
      g.connect(param);
      o.start();
      return o;
    };
    // Wind: pink noise through a slowly wandering band-pass, with slow gusts.
    const windSrc = loop('pink');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 380;
    bp.Q.value = 0.9;
    const gust = ctx.createGain();
    gust.gain.value = 1;
    const wind = ctx.createGain();
    wind.gain.value = 0;
    windSrc.connect(bp);
    bp.connect(gust);
    gust.connect(wind);
    wind.connect(this.master);
    const lfos = [lfo(0.047, 170, bp.frequency), lfo(0.083, 0.45, gust.gain), lfo(0.131, 0.2, gust.gain)];
    // Underwater: a deep, soft rumble.
    const waterSrc = loop('brown');
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const water = ctx.createGain();
    water.gain.value = 0;
    waterSrc.connect(lp);
    lp.connect(water);
    water.connect(this.master);
    return { wind, water, sources: [windSrc, waterSrc, ...lfos] };
  }

  _stopBeds() {
    const b = this._beds;
    this._beds = null;
    if (!b) return;
    for (const s of b.sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
    try { b.wind.disconnect(); b.water.disconnect(); } catch (e) { /* ignore */ }
  }

  _init() {
    if (this.ctx || this._failed) return this.ctx;
    try {
      let ctx = this._external;
      if (!ctx) {
        const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
        if (!AC) { this._failed = true; return null; }
        ctx = new AC({ latencyHint: 'interactive' });
      }
      this._openFreq = Math.min(OPEN_FREQ, ctx.sampleRate * 0.45);
      const master = ctx.createGain();
      // Gentle limiter: many overlapping sounds must not clip.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      master.connect(limiter);
      limiter.connect(ctx.destination);
      const sfx = ctx.createGain();
      // Two cascaded low-passes (24 dB/oct) so the underwater muffle is clearly audible.
      const muffle = ctx.createBiquadFilter(), muffle2 = ctx.createBiquadFilter();
      for (const f of [muffle, muffle2]) {
        f.type = 'lowpass';
        f.frequency.value = this._openFreq;
        f.Q.value = 0.6;
      }
      sfx.connect(muffle);
      muffle.connect(muffle2);
      muffle2.connect(master);
      this.muffle2 = muffle2;
      this._buffers = {
        white: makeNoise(ctx, 'white', 2),
        pink: makeNoise(ctx, 'pink', 3),
        brown: makeNoise(ctx, 'brown', 3),
      };
      this.ctx = ctx;
      this.master = master;
      this.sfx = sfx;
      this.muffle = muffle;
      this._applyGain(true);
    } catch (e) {
      this._failed = true;
      this.ctx = null;
    }
    return this.ctx;
  }

  _applyGain(immediate) {
    if (!this.master) return;
    const g = this._enabled ? this.volume : 0;
    try {
      if (immediate) this.master.gain.value = g;
      else this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    } catch (e) { /* ignore */ }
  }
}
