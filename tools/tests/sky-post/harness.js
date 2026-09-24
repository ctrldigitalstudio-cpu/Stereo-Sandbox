// sky-post harness: renders a scene through the full Renderer frame graph.
//
// Query flags: scene=none|boxes|world, time (0..1), pos=x,y,z, yaw, pitch, fov (deg), scale,
// frames, dt, clouds, vol, ssr, shadows, pcss, bloom, fxaa, cov, uw (underwater), eyesky, seed,
// radius (chunks), held (block id), test=resize (settings/resize robustness run), mock (see index.html).

import { Renderer } from '../../../src/renderer.js';
import { DEFAULT_SETTINGS } from '../../../src/config.js';
import { B, CHUNK, HEIGHT } from '../../../src/blocks.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const log = (...a) => console.log(...a);

const SUN_TILT = (25 * Math.PI) / 180;
function sunDirection(t) {
  const a = t * Math.PI * 2;
  return [Math.cos(a), Math.sin(a) * Math.cos(SUN_TILT), Math.sin(a) * Math.sin(SUN_TILT)];
}

// ---- scenes -------------------------------------------------------------------------------------
const idx = (x, y, z) => x | (z << 4) | (y << 8);

function emptyChunk() {
  const colors = new Uint8Array(256 * 9);
  for (let c = 0; c < 256; c++) colors.set([121, 192, 90, 96, 168, 62, 44, 118, 170], c * 9);
  return { blocks: new Uint8Array(CHUNK * CHUNK * HEIGHT), colors };
}

// Synthetic test world: grass plain at y = 60, a pond, stone pillars, a floating slab with holes
// (light shafts), a glowstone + torch corner, a few trees.
function boxesBlock(x, y, z) {
  const ground = 60;
  const inPond = x >= 6 && x < 22 && z >= -30 && z < -12;
  if (inPond) {
    if (y <= 50) return B.SAND;
    if (y <= 55) return B.WATER;
    return B.AIR;
  }
  if (y < ground - 4) return B.STONE;
  if (y < ground) return B.DIRT;
  if (y === ground) return B.GRASS;
  // pillars
  for (const [px, pz, h] of [[-8, -20, 12], [-2, -28, 9], [3, -40, 16], [-14, -34, 20]]) {
    if (x >= px && x < px + 2 && z >= pz && z < pz + 2 && y <= ground + h) return B.STONE_BRICKS;
  }
  // floating slab with a grid of holes (god rays)
  if (y === 78 && x >= -24 && x < 4 && z >= -48 && z < -16) {
    // 3x3 holes every 7 blocks: wide enough for light at a ~30 degree sun to pass the 1-block slab
    if ((x + 24) % 7 >= 2 && (x + 24) % 7 < 5 && (z + 48) % 7 >= 2 && (z + 48) % 7 < 5) return B.AIR;
    return B.OAK_PLANKS;
  }
  // trees
  for (const [tx, tz] of [[12, -44], [18, -6], [-20, -8]]) {
    const dx = x - tx, dz = z - tz, dy = y - ground;
    if (dx === 0 && dz === 0 && dy >= 1 && dy <= 5) return B.OAK_LOG;
    if (dy >= 4 && dy <= 7 && Math.abs(dx) <= (dy >= 6 ? 1 : 2) && Math.abs(dz) <= (dy >= 6 ? 1 : 2)) return B.OAK_LEAVES;
  }
  // a small lit corner
  if (x === 0 && z === -6 && y === ground + 1) return B.GLOWSTONE;
  if (x === -3 && z === -6 && y === ground + 1) return B.TORCH;
  return B.AIR;
}

function boxesChunk(cx, cz) {
  const c = emptyChunk();
  for (let y = 0; y < 90; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) c.blocks[idx(x, y, z)] = y === 0 ? B.BEDROCK : boxesBlock(cx * 16 + x, y, cz * 16 + z);
    }
  }
  return c;
}

async function loadScene(renderer, textures, kind, center, radius) {
  if (kind === 'none') return 0;
  const { meshChunk } = await import('../../../src/mesher.js');
  let gen = null;
  if (kind === 'world') {
    const { WorldGen } = await import('../../../src/worldgen.js');
    gen = new WorldGen(num('seed', 12345));
  }
  const ccx = Math.floor(center[0] / 16), ccz = Math.floor(center[2] / 16);
  const data = new Map();
  const get = (cx, cz) => {
    const k = `${cx},${cz}`;
    if (!data.has(k)) data.set(k, gen ? gen.generateChunk(cx, cz) : boxesChunk(cx, cz));
    return data.get(k);
  };
  let n = 0;
  const t0 = performance.now();
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dz * dz > (radius + 0.5) ** 2) continue;
      const cx = ccx + dx, cz = ccz + dz;
      const nb = [];
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) nb.push(get(cx + ox, cz + oz));
      const m = meshChunk(nb, textures.faceLayers, cx, cz);
      renderer.terrain.upload(cx, cz, { cx, cz, blocks: get(cx, cz).blocks, ...m });
      n++;
    }
  }
  log(`[harness] scene ${kind}: ${n} chunks meshed in ${(performance.now() - t0).toFixed(0)} ms`);
  return n;
}

// ---- readbacks ----------------------------------------------------------------------------------
function readFloat(gl, fb, x, y, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const out = new Float32Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return out;
}
const fmt = (a, o = 0) => `(${[a[o], a[o + 1], a[o + 2]].map((v) => v.toFixed(3)).join(', ')})`;

function report(renderer) {
  const gl = renderer.gl;
  const a = renderer.atmosphere;
  const irr = readFloat(gl, a.irrFB, 0, 0, 4, 1);
  log(`[irradiance] sky ${fmt(irr, 0)} ground ${fmt(irr, 4)} light ${fmt(irr, 8)} disk ${fmt(irr, 12)}`);
  const lut = readFloat(gl, a.lutFB, 0, 0, 256, 128);
  const at = (u, v) => { const x = Math.min(255, Math.floor(u * 256)), y = Math.min(127, Math.floor(v * 128)); return (y * 256 + x) * 4; };
  const sun = renderer.atmosphere.state.sunDir;
  const az = Math.atan2(sun[2], sun[0]) / (2 * Math.PI) + 0.5;
  log(`[sky] zenith ${fmt(lut, at(0.5, 0.999))} horizon@sun ${fmt(lut, at(az, 0.52))} horizon@anti ${fmt(lut, at((az + 0.5) % 1, 0.52))} 30deg@anti ${fmt(lut, at((az + 0.5) % 1, 0.5 + 0.5 * Math.sqrt(1 / 3)))} below ${fmt(lut, at(az, 0.2))}`);
  const post = renderer.post;
  const e = readFloat(gl, post.exposure[post.exposureIndex].fb, 0, 0, 1, 1);
  log(`[exposure] exposure ${Math.pow(2, e[0] * 10 - 5).toFixed(3)} avgLum ${Math.pow(2, e[1]).toFixed(4)}`);
}

// ---- main ---------------------------------------------------------------------------------------
async function main() {
  const canvas = document.getElementById('game');
  let textures;
  try {
    textures = (await import('../../../src/textures.js')).buildTextures();
  } catch (e) {
    console.warn('textures.js unavailable, using a flat stub', e);
    const L = 64, s = 16, levels = 5;
    const mk = (fill) => Array.from({ length: levels }, (_, l) => {
      const n = Math.max(1, s >> l);
      const d = new Uint8Array(L * n * n * 4);
      for (let i = 0; i < d.length; i += 4) d.set(fill, i);
      return d;
    });
    textures = { size: s, layers: L, levels, albedo: mk([140, 140, 140, 255]), normal: mk([128, 128, 255, 255]), spec: mk([20, 0, 0, 0]), layerOf: {}, faceLayers: new Uint16Array(64 * 6), cutout: new Uint8Array(L) };
  }

  const settings = { ...DEFAULT_SETTINGS };
  const set = (k, key, conv = Number) => { if (q.has(k)) settings[key] = conv(q.get(k)); };
  const bool = (v) => v === '1' || v === 'true';
  set('scale', 'renderScale'); set('clouds', 'clouds'); set('vol', 'volumetrics'); set('ssr', 'ssr');
  set('shadows', 'shadows', bool); set('pcss', 'pcss', bool); set('bloom', 'bloom', bool); set('fxaa', 'fxaa', bool);
  set('shadowRes', 'shadowRes'); set('shadowRadius', 'shadowRadius'); set('rd', 'renderDistance');

  const t0 = performance.now();
  const renderer = new Renderer(canvas, textures, settings);
  log(`[harness] Renderer constructed in ${(performance.now() - t0).toFixed(0)} ms; canvas ${canvas.width}x${canvas.height}, render ${renderer.renderWidth}x${renderer.renderHeight}, hdr ${renderer.hdr.internal === renderer.gl.RGBA16F ? 'RGBA16F' : 'RGBA8'}`);
  window.__renderer = renderer;
  if (q.has('volk')) renderer.volumetricStrength = num('volk', 1);

  const pos = (q.get('pos') || '0.5,70,0.5').split(',').map(Number);
  const kind = q.get('scene') || 'none';
  await loadScene(renderer, textures, kind, pos, num('radius', 3));

  const timeOfDay = num('time', 0.25);
  const sunDir = sunDirection(timeOfDay);
  const frame = {
    camPos: pos, yaw: num('yaw', 0), pitch: num('pitch', 0), fov: num('fov', 75) * Math.PI / 180,
    time: num('t', 10), dt: num('dt', 1 / 60), timeOfDay, sunDir, moonDir: sunDir.map((v) => -v),
    underwater: q.has('uw'), eyeSkyLight: num('eyesky', 1), selection: null, particles: null,
    held: q.has('held') ? { blockId: num('held', 1), swing: 0, equip: 0, bobX: 0, bobY: 0, light: [1, 0] } : null,
    cloudCoverage: num('cov', 0.45),
  };
  if (q.has('sel')) frame.selection = { x: Math.floor(pos[0]) + 2, y: Math.floor(pos[1]) - 3, z: Math.floor(pos[2]) - 4, id: B.STONE };

  const gl = renderer.gl;
  const errors = [];
  const check = (label) => {
    const e = gl.getError();
    if (e !== gl.NO_ERROR) { errors.push(`${label}: 0x${e.toString(16)}`); console.error(`[harness] GL error after ${label}: 0x${e.toString(16)}`); }
  };
  check('construct');

  const frames = num('frames', 3);
  const times = [];
  for (let i = 0; i < frames; i++) {
    const ts = performance.now();
    renderer.render(frame);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    times.push(performance.now() - ts);
    check(`frame ${i}`);
    frame.time += frame.dt;
    await new Promise((r) => requestAnimationFrame(r));
  }
  log(`[harness] frame ms: ${times.map((t) => t.toFixed(0)).join(' ')}`);
  log(`[harness] stats ${JSON.stringify(renderer.stats)}`);

  if (q.get('test') === 'resize') {
    const step = async (label, fn) => {
      fn();
      renderer.render(frame);
      await new Promise((r) => requestAnimationFrame(r));
      check(label);
      log(`[resize] ${label}: canvas ${canvas.width}x${canvas.height} render ${renderer.renderWidth}x${renderer.renderHeight} shadowRes ${renderer.shadowRes}`);
    };
    const shadowTex0 = renderer.shadowTex;
    const programs0 = renderer.post.tonemapProgram;
    await step('scale 0.5', () => renderer.applySettings({ ...settings, renderScale: 0.5 }));
    if (renderer.shadowTex !== shadowTex0 || renderer.post.tonemapProgram !== programs0) console.error('[resize] renderScale change rebuilt the shadow map or programs');
    await step('scale 1', () => renderer.applySettings({ ...settings, renderScale: 1 }));
    await step('css resize 500x300', () => { canvas.style.width = '500px'; canvas.style.height = '300px'; renderer.resize(); });
    await step('css resize back', () => { canvas.style.width = ''; canvas.style.height = ''; renderer.resize(); });
    await step('shadows off', () => renderer.applySettings({ ...settings, shadows: false }));
    await step('shadows 1024', () => renderer.applySettings({ ...settings, shadows: true, shadowRes: 1024 }));
    await step('all effects off', () => renderer.applySettings({ ...settings, volumetrics: 0, clouds: 0, ssr: 0, bloom: false, fxaa: false }));
    await step('fxaa off + scale 0.75', () => renderer.applySettings({ ...settings, fxaa: false, renderScale: 0.75 }));
    await step('ultra', () => renderer.applySettings({ ...settings, shadowRes: 4096, shadowRadius: 160, volumetrics: 24, clouds: 24, ssr: 32 }));
    await step('back to test settings', () => renderer.applySettings(settings));
  }

  if (q.get('test') === 'adapt') {
    // Eye adaptation: jump from the current scene to night and back, logging exposure per step.
    const post = renderer.post;
    const readE = () => { const e = readFloat(gl, post.exposure[post.exposureIndex].fb, 0, 0, 1, 1); return Math.pow(2, e[0] * 10 - 5); };
    const seq = [];
    const run = (tod, n, dt) => {
      frame.timeOfDay = tod; frame.sunDir = sunDirection(tod); frame.moonDir = frame.sunDir.map((v) => -v); frame.dt = dt;
      for (let i = 0; i < n; i++) { renderer.render(frame); frame.time += dt; seq.push(readE().toFixed(2)); }
    };
    run(0.8, 12, 0.25);
    seq.push('|');
    run(0.3, 8, 0.25);
    log(`[adapt] exposure: ${seq.join(' ')}`);
    check('adapt');
  }

  if (q.get('test') === 'shadowbench') {
    const px = new Uint8Array(4);
    const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const view = renderer.viewInfo;
    for (const res of [1024, 2048]) {
      renderer.applySettings({ ...settings, shadowRes: res });
      renderer.render(frame);
      sync();
      let ts = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.shadowFB);
      gl.viewport(0, 0, res, res);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      sync();
      log(`[shadowbench] ${res}: clear ${(performance.now() - ts).toFixed(0)} ms`);
      ts = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.shadowFB);
      gl.viewport(0, 0, res, res);
      renderer.terrain.drawShadow(view);
      sync();
      log(`[shadowbench] ${res}: drawShadow ${(performance.now() - ts).toFixed(0)} ms (${renderer.terrain.stats.drawCalls} draws, ${renderer.terrain.stats.quads} quads)`);
      ts = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.sceneFB);
      gl.viewport(0, 0, renderer.renderWidth, renderer.renderHeight);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      renderer.terrain.drawOpaque(view);
      sync();
      log(`[shadowbench] ${res}: drawOpaque ${(performance.now() - ts).toFixed(0)} ms`);
    }
  }

  if (q.get('test') === 'bench') {
    // Synchronous timing (readPixels forces the GPU work to finish) per configuration.
    const px = new Uint8Array(4);
    const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const timeIt = (label, n, before) => {
      sync();
      let total = 0;
      for (let i = 0; i < n; i++) {
        if (before) before();
        const ts = performance.now();
        renderer.render(frame);
        sync();
        total += performance.now() - ts;
        frame.time += 0.016;
      }
      log(`[bench] ${label}: ${(total / n).toFixed(1)} ms/frame`);
    };
    const base = { ...settings };
    const cfg = (patch) => () => renderer.applySettings({ ...base, ...patch });
    cfg({})(); timeIt('full (LUT cached)', 4);
    timeIt('full + LUT update every frame', 3, () => { renderer.atmosphere.lutKey = null; });
    cfg({ volumetrics: 0 })(); timeIt('no volumetrics', 4);
    cfg({ clouds: 0 })(); timeIt('no clouds (flat layer)', 4);
    cfg({ volumetrics: 0, clouds: 0 })(); timeIt('no vol, no clouds', 4);
    cfg({ shadows: false })(); timeIt('no shadows', 4);
    cfg({ shadows: false, volumetrics: 0, clouds: 0, bloom: false, fxaa: false })(); timeIt('minimal', 4);
    renderer.applySettings(base);
  }

  if (!q.has('noreport')) report(renderer);
  check('readback');
  // Drain the GPU queue (gl.finish does not block in Chromium) so the screenshot is immediate.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  renderer.render(frame);
  window.__result = { errors, stats: renderer.stats, times };
  window.__done = true;
}

main().catch((e) => { console.error(e && e.stack || String(e)); window.__done = true; });
