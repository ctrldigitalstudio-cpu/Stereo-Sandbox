// Browser harness for src/audio.js:
//  1. calls every API on a live AudioContext (no exceptions allowed),
//  2. renders every kind x material offline and measures peak / RMS / length / spectral centroid,
//  3. draws a spectrogram sheet for eyeballing, and checks the numbers make sense.

import { Sound } from '../../../src/audio.js';

const KINDS = ['break', 'place', 'step'];
const MATERIALS = ['stone', 'wood', 'grass', 'gravel', 'sand', 'snow', 'glass', 'wool', 'water'];
const RATE = 48000;
const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

// ---- 1. live context smoke test -----------------------------------------------------------------
async function liveSmoke() {
  const s = new Sound();
  s.setVolume(0.5);
  s.enabled = true;
  s.setListener([0, 70, 0], 0.3);
  s.ambient(0.3, false, 1);             // before resume: must be a no-op
  await s.resume();
  check(s.ctx && s.ctx.state === 'running', `live context state ${s.ctx && s.ctx.state}`);
  for (const k of [...KINDS, 'splash', 'click']) {
    for (const m of [...MATERIALS, 'dirt', 'lava', 'none', 'unknown-material', undefined]) {
      s.play(k, m);
      s.play(k, m, [3, 71, -2]);
    }
  }
  s.play('bogus-kind', 'stone', [0, 0, 0]);
  s.ambientLevel = 1;
  s.ambient(0.3, false, 1);
  s.ambient(0.8, true, 0.2);
  s.ambient(0.8, false, 0);
  s.enabled = false;
  s.play('break', 'stone');
  s.ambient(0.3, false, 1);
  s.enabled = true;
  s.setVolume(0);
  s.play('break', 'stone');
  s.setVolume(2);
  check(s.volume === 1, 'volume clamps to 1');
  s.setVolume('0.4');
  s.ambientLevel = 0;
  for (let i = 0; i < 10; i++) s.ambient(0.3, false, 1);
  // Voice cap: a burst of 200 plays must not explode.
  for (let i = 0; i < 200; i++) s.play('step', 'grass');
  check(s._voices.length <= 28, `voices ${s._voices.length}`);
  await new Promise((r) => setTimeout(r, 300));

  // Without WebAudio everything is a silent no-op.
  const AC = window.AudioContext, WAC = window.webkitAudioContext;
  window.AudioContext = undefined;
  window.webkitAudioContext = undefined;
  const dead = new Sound();
  await dead.resume();
  dead.play('break', 'stone', [0, 0, 0]);
  dead.setListener([0, 0, 0], 0);
  dead.ambient(0.2, true, 1);
  dead.setVolume(0.3);
  dead.enabled = false;
  check(dead.ctx === null, 'no context without WebAudio');
  window.AudioContext = AC;
  window.webkitAudioContext = WAC;
  // A constructor that throws is also survived.
  window.AudioContext = function () { throw new Error('nope'); };
  const broken = new Sound();
  await broken.resume();
  broken.play('place', 'wood');
  window.AudioContext = AC;
}

// ---- 2. offline renders -------------------------------------------------------------------------
async function render(fn, seconds = 1, channels = 1, opts = {}) {
  const ctx = new OfflineAudioContext(channels, Math.round(RATE * seconds), RATE);
  const s = new Sound({ context: ctx, ...opts });
  s.setVolume(1);
  await s.resume();
  fn(s, ctx);
  const buf = await ctx.startRendering();
  return buf;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const N = 1024, HOP = 256;
function analyse(data) {
  let peak = 0, sum = 0, last = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    if (a > 0.003) last = i;
  }
  const active = Math.max(1, last);
  for (let i = 0; i < active; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / active);
  // Spectrogram (power) + energy-weighted spectral centroid.
  const frames = [];
  let cNum = 0, cDen = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f + N <= data.length; f += HOP) {
    for (let i = 0; i < N; i++) { re[i] = data[f + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      mag[k] = p;
      cNum += p * (k * RATE / N);
      cDen += p;
    }
    frames.push(mag);
  }
  // Loudness: A-weighted power, averaged over ~100 ms windows, max over time (dB, arbitrary ref).
  const aw = A_WEIGHT;
  const fp = frames.map((fr) => { let s = 0; for (let k = 1; k < N / 2; k++) s += fr[k] * aw[k]; return s; });
  const W = Math.round(0.1 * RATE / HOP);
  let best = 0;
  for (let i = 0; i < fp.length; i++) {
    let s = 0;
    for (let j = i; j < Math.min(fp.length, i + W); j++) s += fp[j];
    best = Math.max(best, s / W);
  }
  const loud = 10 * Math.log10(best + 1e-20);
  return { peak, rms, dur: last / RATE, centroid: cDen > 0 ? cNum / cDen : 0, frames, loud };
}

const A_WEIGHT = new Float64Array(N / 2).map((_, k) => {
  const f = Math.max(1, (k * RATE) / N), f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return (ra * 1.2589) ** 2;   // +2 dB normalises to 0 dB at 1 kHz; squared: applied to power
});

// ---- 3. drawing ---------------------------------------------------------------------------------
const CW = 190, SH = 64, WH = 22, CH = SH + WH + 16;
function drawCell(ctx, x0, y0, label, a, data, span) {
  const img = ctx.createImageData(CW - 6, SH);
  const nf = Math.max(1, Math.min(a.frames.length, Math.ceil((span * RATE) / HOP)));
  let top = 1e-20;
  for (let i = 0; i < nf; i++) for (const v of a.frames[i]) top = Math.max(top, v);
  const topDb = 10 * Math.log10(top);
  const fmin = 40, fmax = 20000;
  for (let px = 0; px < img.width; px++) {
    const fr = a.frames[Math.min(nf - 1, Math.floor((px / img.width) * nf))];
    for (let py = 0; py < SH; py++) {
      const f = fmin * Math.pow(fmax / fmin, 1 - py / (SH - 1));
      const k = Math.min(N / 2 - 1, Math.round((f * N) / RATE));
      const db = 10 * Math.log10(fr[k] + 1e-12);
      const v = Math.max(0, Math.min(1, (db - topDb + 60) / 60));
      const o = (py * img.width + px) * 4;
      img.data[o] = 255 * Math.min(1, v * 1.6);
      img.data[o + 1] = 255 * Math.max(0, Math.min(1, v * 1.8 - 0.55));
      img.data[o + 2] = 255 * Math.max(0, 0.45 - v) + 60 * v * v;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, y0 + 12);
  // Waveform envelope.
  ctx.fillStyle = '#1b2230';
  ctx.fillRect(x0, y0 + 12 + SH, CW - 6, WH);
  ctx.fillStyle = '#7fd1ff';
  const per = Math.max(1, Math.floor(Math.min(data.length, span * RATE) / (CW - 6)));
  for (let px = 0; px < CW - 6; px++) {
    let m = 0;
    for (let i = px * per; i < (px + 1) * per; i++) m = Math.max(m, Math.abs(data[i]));
    const h = Math.min(WH, m * WH);
    ctx.fillRect(x0 + px, y0 + 12 + SH + (WH - h) / 2, 1, Math.max(1, h));
  }
  ctx.fillStyle = '#e8e2d0';
  ctx.fillText(`${label} ${a.loud.toFixed(1)}dB pk${a.peak.toFixed(2)} ${Math.round(a.dur * 1000)}ms`, x0, y0 + 9);
}

async function offline() {
  const cells = [];
  for (const m of MATERIALS) {
    for (const k of KINDS) {
      const buf = await render((s) => s.play(k, m));
      const data = buf.getChannelData(0);
      cells.push({ label: `${k} ${m}`, k, m, a: analyse(data), data });
    }
  }
  const extra = [
    ['splash', (s) => s.play('splash', 'water'), 1],
    ['click', (s) => s.play('click', 'none'), 1],   // as ui.js calls it
    ['muffled break stone', (s, ctx) => {
      s.ambient(0.3, true, 1);                      // eye goes under; the filter glides down
      ctx.suspend(0.4).then(() => { s.play('break', 'stone'); ctx.resume(); });
    }, 1],
    ['wind bed (level 1)', (s) => { s.ambientLevel = 1; s.ambient(0.3, false, 1); }, 4],
    ['underwater bed', (s) => { s.ambientLevel = 1; s.ambient(0.3, true, 1); }, 2],
    ['beds off (default)', (s) => { s.ambient(0.3, false, 1); s.ambient(0.3, true, 1); }, 2],
  ];
  for (const [label, fn, secs] of extra) {
    const buf = await render(fn, secs);
    const full = buf.getChannelData(0);
    const data = secs > 1 ? full.slice(full.length - RATE) : label.startsWith('muffled') ? full.slice(Math.round(0.4 * RATE)) : full;
    cells.push({ label, a: analyse(data), data });
  }

  // Stereo placement: a block to the listener's right is louder on the right.
  const pan = await render((s) => { s.setListener([0, 0, 0], 0); s.play('place', 'stone', [4, 0, 0]); }, 0.5, 2);
  const e = (ch) => { const d = pan.getChannelData(ch); let s = 0; for (const v of d) s += v * v; return s; };
  const panRatio = e(1) / Math.max(1e-12, e(0));
  check(panRatio > 2 && panRatio < 6, `pan: right/left energy ${panRatio.toFixed(2)} (light spatialisation)`);
  const far = await render((s) => { s.setListener([0, 0, 0], 0); s.play('place', 'stone', [0, 0, -30]); }, 0.5, 1);
  const farPeak = analyse(far.getChannelData(0)).peak;

  // Draw.
  const cols = 3, rows = Math.ceil(cells.length / cols);
  const cv = document.getElementById('c');
  cv.width = cols * CW + 8;
  cv.height = rows * CH + 8;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#11141a';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = '9px monospace';
  cells.forEach((c, i) => drawCell(ctx, 6 + (i % cols) * CW, 4 + Math.floor(i / cols) * CH, c.label, c.a, c.data, c.k || c.label === 'click' ? 0.45 : 1));

  // Sanity checks.
  const get = (k, m) => cells.find((c) => c.k === k && c.m === m).a;
  for (const c of cells) {
    if (c.label === 'beds off (default)') { check(c.a.peak < 1e-4, `beds should be silent by default: ${c.a.peak}`); continue; }
    check(c.a.peak > 0.02, `${c.label}: too quiet (peak ${c.a.peak.toFixed(3)})`);
    check(c.a.peak < 1.0, `${c.label}: clipping (peak ${c.a.peak.toFixed(3)})`);
    check(!Number.isNaN(c.a.rms), `${c.label}: NaN`);
  }
  for (const m of MATERIALS) {
    const b = get('break', m), p = get('place', m), s = get('step', m);
    check(b.dur >= p.dur * 0.95, `${m}: break (${b.dur.toFixed(3)} s) should last at least as long as place (${p.dur.toFixed(3)} s)`);
    check(b.rms * b.dur > p.rms * p.dur, `${m}: break should carry more energy than place`);
    check(s.loud < p.loud - 5, `${m}: step (${s.loud.toFixed(1)} dB) should be quieter than place (${p.loud.toFixed(1)} dB)`);
    check(b.dur < 0.9, `${m}: break too long ${b.dur}`);
  }
  // Calibrated loudness: every material within 4 dB (single render; calibrated on averages) of its action's target (see ?calibrate).
  for (const m of MATERIALS) {
    [22, 20, 9].forEach((target, i) => {
      const a = get(KINDS[i], m);
      check(Math.abs(a.loud - target) < 4, `${KINDS[i]} ${m}: loudness ${a.loud.toFixed(1)} dB, target ${target}`);
    });
  }
  const cen = (m) => get('place', m).centroid;
  check(cen('wool') < cen('wood') && cen('wood') < cen('stone'), `centroids wool ${cen('wool')} < wood ${cen('wood')} < stone ${cen('stone')}`);
  check(cen('gravel') < cen('snow') && cen('snow') < cen('grass'), `centroids gravel ${cen('gravel')} < snow ${cen('snow')} < grass ${cen('grass')}`);
  check(cen('glass') > cen('stone') && cen('sand') > cen('gravel'), `glass ${cen('glass')} > stone, sand ${cen('sand')} > gravel`);
  const muffled = cells.find((c) => c.label === 'muffled break stone').a;
  check(muffled.centroid < get('break', 'stone').centroid * 0.5, `underwater muffling: ${muffled.centroid} vs ${get('break', 'stone').centroid}`);
  check(farPeak < get('place', 'stone').peak * 0.6, `distance attenuation: far ${farPeak}`);
  const wind = cells.find((c) => c.label === 'wind bed (level 1)').a;
  check(wind.rms > 0.004 && wind.rms < 0.05, `wind bed level ${wind.rms}`);

  const table = cells.map((c) => `${c.label.padEnd(22)} loud ${c.a.loud.toFixed(1).padStart(6)}dB peak ${c.a.peak.toFixed(3)} rms ${c.a.rms.toFixed(3)} dur ${(c.a.dur * 1000).toFixed(0).padStart(4)}ms centroid ${c.a.centroid.toFixed(0).padStart(5)}Hz`);
  console.log(table.join('\n'));
  console.log(`pan right/left ${panRatio.toFixed(2)}, far peak ${farPeak.toFixed(3)}`);
}

// ?calibrate: average loudness of each sound at unit trim, and the trims that reach the targets.
async function calibrate() {
  const REPS = 8;
  const out = {};
  const loud = {};
  for (const m of MATERIALS) {
    loud[m] = [];
    for (const k of KINDS) {
      let sum = 0;
      for (let r = 0; r < REPS; r++) sum += analyse((await render((s) => s.play(k, m), 1, 1, { trim: false })).getChannelData(0)).loud;
      loud[m].push(sum / REPS);
    }
  }
  const T = Number(new URLSearchParams(location.search).get('target') || -18);
  const target = [T + 2, T, T - 11];   // break, place, step
  for (const m of MATERIALS) out[m] = loud[m].map((l, i) => +Math.pow(10, (target[i] - l) / 20).toFixed(2));
  for (const [name, fn, t] of [['splash', (s) => s.play('splash', 'water'), T + 1], ['click', (s) => s.play('click'), T - 8]]) {
    let sum = 0;
    for (let r = 0; r < REPS; r++) sum += analyse((await render(fn, 1, 1, { trim: false })).getChannelData(0)).loud;
    out[name] = +Math.pow(10, (t - sum / REPS) / 20).toFixed(2);
  }
  console.log('untrimmed loudness ' + JSON.stringify(loud, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v)));
  console.log('TRIM ' + JSON.stringify(out));
}

(async () => {
  try {
    if (location.search.includes('calibrate')) { await calibrate(); window.__done = true; return; }
    await liveSmoke();
    await offline();
  } catch (e) {
    problems.push(`exception: ${e.stack || e}`);
  }
  if (problems.length) console.error('PROBLEMS:\n' + problems.join('\n'));
  else console.log('AUDIO OK');
  window.__done = true;
})();
