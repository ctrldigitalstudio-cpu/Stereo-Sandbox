// Test harness for TerrainRenderer / Overlays / ParticleSystem: a minimal frame graph around
// the real textures, world generator, mesher and atmosphere. Renders one scene chosen by URL
// params, then sets window.__done (and window.__report with stats / GL errors).
//
//   page.html?scene=noon&w=640&h=360&pcss=1&ssr=24&shadows=1

import { createGL, UNIT, Program, createTexture2D, createDepthTexture, createFramebuffer, drawFullscreen } from '../../../src/gl.js';
import { FrameUniforms, computeShadowMatrix, FULLSCREEN_VS, GLSL_COMMON } from '../../../src/render/common.js';
import { mat4, frustumPlanes, forwardFromYawPitch } from '../../../src/math.js';
import { B, SEA } from '../../../src/blocks.js';
import { buildTextures } from '../../../src/textures.js';
import { WorldGen } from '../../../src/worldgen.js';
import { meshChunk } from '../../../src/mesher.js';
import { Atmosphere } from '../../../src/render/atmosphere.js';
import { TerrainRenderer } from '../../../src/render/terrain.js';
import { Overlays } from '../../../src/render/overlays.js';
import { ParticleSystem } from '../../../src/particles.js';

const q = new URLSearchParams(location.search);
const W = +(q.get('w') || 640), H = +(q.get('h') || 360);
const SCENE = q.get('scene') || 'noon';
const log = (...a) => console.log('[harness]', ...a);

// ---------------------------------------------------------------------------------------------
// World: generate, edit, mesh.
// ---------------------------------------------------------------------------------------------
const gen = new WorldGen(12345);
const chunkData = new Map();
function chunk(cx, cz) {
  const k = cx + ',' + cz;
  let c = chunkData.get(k);
  if (!c) { c = gen.generateChunk(cx, cz); chunkData.set(k, c); }
  return c;
}
function setBlock(x, y, z, id) {
  const c = chunk(Math.floor(x / 16), Math.floor(z / 16));
  c.blocks[(x & 15) | ((z & 15) << 4) | (y << 8)] = id;
}
function getBlock(x, y, z) {
  if (y < 0) return B.BEDROCK;
  if (y >= 128) return 0;
  const c = chunk(Math.floor(x / 16), Math.floor(z / 16));
  return c.blocks[(Math.floor(x) & 15) | ((Math.floor(z) & 15) << 4) | (Math.floor(y) << 8)];
}
const worldView = {
  getBlock,
  isSolid: (x, y, z) => { const id = getBlock(Math.floor(x), Math.floor(y), Math.floor(z)); return id !== 0 && id !== B.WATER && id !== B.TALL_GRASS && id !== B.TORCH && id !== B.POPPY && id !== B.FERN; },
};
const surface = (x, z) => { for (let y = 127; y > 0; y--) { const id = getBlock(x, y, z); if (id && id !== B.WATER && id !== B.OAK_LEAVES && id !== B.TALL_GRASS) return y; } return 0; };

function findShore(x, z) {
  for (let r = 16; r < 900; r += 16) {
    for (let a = 0; a < 32; a++) {
      const px = Math.round(x + Math.cos(a / 32 * Math.PI * 2) * r), pz = Math.round(z + Math.sin(a / 32 * Math.PI * 2) * r);
      if (gen.heightAt(px, pz) < 44) return { x: px, z: pz };
    }
  }
  return { x, z };
}

// Test props next to spawn: materials, lights, lava, glass.
function buildProps(sx, sz) {
  const y0 = surface(sx, sz);
  const pad = (x0, z0, w, d, y) => { for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + d; z++) { setBlock(x, y, z, B.STONE_BRICKS); for (let yy = y + 1; yy < y + 7; yy++) setBlock(x, yy, z, 0); } };
  pad(sx - 6, sz - 12, 13, 9, y0);
  const y = y0 + 1;
  const row = [B.GOLD_BLOCK, B.IRON_BLOCK, B.DIAMOND_BLOCK, B.GLASS, B.ICE, B.GLOWSTONE, B.OBSIDIAN, B.SEA_LANTERN, B.OAK_LEAVES];
  row.forEach((id, i) => setBlock(sx - 5 + i + (i > 4 ? 1 : 0), y, sz - 11, id));
  setBlock(sx - 4, y + 1, sz - 11, B.GLASS);
  // lava pool
  for (let x = sx + 1; x < sx + 4; x++) for (let z = sz - 8; z < sz - 6; z++) setBlock(x, y0, z, B.LAVA);
  // torches and plants
  setBlock(sx - 5, y, sz - 7, B.TORCH);
  setBlock(sx + 5, y, sz - 5, B.TORCH);
  setBlock(sx - 2, y, sz - 6, B.POPPY);
  setBlock(sx - 1, y, sz - 6, B.TALL_GRASS);
  setBlock(sx, y, sz - 6, B.DANDELION);
  // a little wall with a window
  for (let x = sx - 5; x <= sx - 2; x++) for (let yy = y; yy < y + 3; yy++) setBlock(x, yy, sz - 4, yy === y + 1 && x > sx - 5 && x < sx - 2 ? B.GLASS : B.OAK_PLANKS);
  return { x: sx, y: y, z: sz - 8 };
}

// ---------------------------------------------------------------------------------------------
const spawn = gen.findSpawn();
const shore = findShore(spawn.x, spawn.z);
const scenes = {
  noon: { time: 0.25, pos: [spawn.x, spawn.y + 22, spawn.z], yaw: 0.6, pitch: -0.3 },
  afternoon: { time: 0.41, pos: [spawn.x, spawn.y + 6, spawn.z], yaw: -1.2, pitch: -0.08 },
  sunset: { time: 0.485, pos: [spawn.x, spawn.y + 12, spawn.z], yaw: -Math.PI / 2 + 0.3, pitch: 0.02 },
  night: { time: 0.78, pos: [spawn.x, spawn.y + 3, spawn.z + 2], yaw: 0.0, pitch: -0.25, props: true },
  props: { time: 0.3, pos: [spawn.x, spawn.y + 4, spawn.z + 1], yaw: 0.0, pitch: -0.4, props: true },
  propslow: { time: 0.44, pos: [spawn.x + 1, spawn.y + 3, spawn.z], yaw: 0.25, pitch: -0.35, props: true },
  water: { time: 0.33, pos: [shore.x, 64, shore.z], yaw: 0.3, pitch: -0.35 },
  waterlow: { time: 0.46, pos: [shore.x, 60, shore.z], yaw: -Math.PI / 2 + 0.2, pitch: -0.12 },
  underwater: { time: 0.3, pos: [shore.x, 50, shore.z], yaw: 0.3, pitch: 0.25, underwater: true },
  held: { time: 0.3, pos: [spawn.x, spawn.y + 1.62, spawn.z + 1], yaw: 0.0, pitch: -0.5, props: true, held: true },
  backlit: { time: 0.44, pos: [spawn.x + 6, spawn.y + 2, spawn.z], yaw: Math.PI / 2, pitch: 0.05 },
  shallow: { time: 0.3, pos: [shore.x, 60, shore.z], yaw: -Math.PI / 2 + 0.2, pitch: -0.6 },
  mats: { time: 0.36, pos: [spawn.x - 1, spawn.y + 2.6, spawn.z - 7.5], yaw: 0.35, pitch: -0.42, props: true, held: true },
  held2: { time: 0.3, pos: [spawn.x + 2, spawn.y + 3.2, spawn.z - 6], yaw: 0.2, pitch: -0.45, props: true, held: true },
};
const sc = { ...scenes[SCENE] || scenes.noon };
if (q.get('time')) sc.time = +q.get('time');
if (q.get('yaw')) sc.yaw = +q.get('yaw');
if (q.get('pitch')) sc.pitch = +q.get('pitch');
if (q.get('y')) sc.pos = [sc.pos[0], +q.get('y'), sc.pos[2]];
const props = sc.props ? buildProps(Math.floor(spawn.x), Math.floor(spawn.z)) : null;

const settings = {
  shadows: q.get('shadows') !== '0', shadowRes: +(q.get('shadowRes') || 2048), shadowRadius: +(q.get('radius') || 128),
  pcss: q.get('pcss') !== '0', ssr: +(q.get('ssr') ?? 24), renderDistance: +(q.get('rd') || 4), clouds: 16,
};

// ---------------------------------------------------------------------------------------------
// GL setup
// ---------------------------------------------------------------------------------------------
const canvas = document.getElementById('c');
canvas.width = W; canvas.height = H;
const gl = createGL(canvas);
const report = { errors: [], stats: null, glErrors: [] };
window.__report = report;
function glCheck(where) {
  const e = gl.getError();
  if (e) { report.glErrors.push(`${where}: 0x${e.toString(16)}`); console.error(`GL error at ${where}: 0x${e.toString(16)}`); }
}

const t0 = performance.now();
const tex = buildTextures();
log('textures', (performance.now() - t0).toFixed(0), 'ms');

function createArray(levels, internal, data) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internal, tex.size, tex.size, tex.layers);
  for (let l = 0; l < levels; l++) {
    const s = tex.size >> l;
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, 0, s, s, tex.layers, gl.RGBA, gl.UNSIGNED_BYTE, data[l]);
  }
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  if (gl.ext.aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, gl.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return t;
}
const albedoTex = createArray(tex.levels, gl.SRGB8_ALPHA8, tex.albedo);
const normalTex = createArray(tex.levels, gl.RGBA8, tex.normal);
const specTex = createArray(tex.levels, gl.RGBA8, tex.spec);
glCheck('texture arrays');

const frameU = new FrameUniforms(gl);
const atmo = new Atmosphere(gl);
let terrain, overlays;
try {
  terrain = new TerrainRenderer(gl, tex);
  overlays = new Overlays(gl, tex);
  if (q.get('cull') === '1') terrain.cullOpaque = true;
} catch (e) {
  console.error(e.message);
  window.__done = true;
  throw e;
}
glCheck('programs');

// Shadow map + samplers
const shadowTex = createDepthTexture(gl, settings.shadowRes, settings.shadowRes);
const shadowFB = createFramebuffer(gl, [], shadowTex);
const dummyDepth = createDepthTexture(gl, 1, 1);
const dummyFB = createFramebuffer(gl, [], dummyDepth);
gl.bindFramebuffer(gl.FRAMEBUFFER, dummyFB); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
const cmpSampler = gl.createSampler();
gl.samplerParameteri(cmpSampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
gl.samplerParameteri(cmpSampler, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
gl.samplerParameteri(cmpSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.samplerParameteri(cmpSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.samplerParameteri(cmpSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.samplerParameteri(cmpSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
const rawSampler = gl.createSampler();
gl.samplerParameteri(rawSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.samplerParameteri(rawSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.samplerParameteri(rawSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.samplerParameteri(rawSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

// Scene targets
const hdr = gl.hdrFormat;
const sceneColor = createTexture2D(gl, W, H, { ...hdr });
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
const sceneDepth = createDepthTexture(gl, W, H);
const sceneFB = createFramebuffer(gl, [sceneColor], sceneDepth);
const copyColor = createTexture2D(gl, W, H, { ...hdr });
const copyDepth = createDepthTexture(gl, W, H);
const copyFB = createFramebuffer(gl, [copyColor], copyDepth);
glCheck('targets');

const tonemap = new Program(gl, FULLSCREEN_VS, GLSL_COMMON + `
uniform sampler2D uScene;
uniform float uExposureBias;
in vec2 vUV;
out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  float maxLod = floor(log2(max(uRes.x, uRes.y)));
  vec3 avg = textureLod(uScene, vec2(0.5), maxLod).rgb;
  float lum = max(luminance(avg), 1e-4);
  float exposure = clamp(0.2 / pow(lum, 0.85), 0.2, 14.0) * uExposureBias;
  vec3 c = aces(texture(uScene, vUV).rgb * exposure);
  c = pow(c, vec3(1.0 / 2.2));
  o = vec4(c, 1.0);
}`, 'tonemap');
tonemap.samplers({ uScene: 10 });

// ---------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------
function sunDirection(t) {
  const a = t * Math.PI * 2, phi = 25 * Math.PI / 180;
  return [Math.cos(a), Math.sin(a) * Math.cos(phi), Math.sin(a) * Math.sin(phi)];
}

function loadWorld(center, rd) {
  const ccx = Math.floor(center[0] / 16), ccz = Math.floor(center[2] / 16);
  let n = 0;
  const t1 = performance.now();
  for (let dz = -rd; dz <= rd; dz++) {
    for (let dx = -rd; dx <= rd; dx++) {
      if (dx * dx + dz * dz > (rd + 0.5) * (rd + 0.5)) continue;
      const cx = ccx + dx, cz = ccz + dz;
      const nb = [];
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) nb.push(chunk(cx + i, cz + j));
      const m = meshChunk(nb, tex.faceLayers, cx, cz);
      terrain.upload(cx, cz, { cx, cz, ...m });
      n++;
    }
  }
  log('meshed', n, 'chunks in', (performance.now() - t1).toFixed(0), 'ms');
}

function render(frame, opts = {}) {
  const camPos = frame.camPos;
  const far = settings.renderDistance * 16 * 1.6 + 64;
  const proj = mat4.perspective(mat4.create(), frame.fov, W / H, 0.08, far);
  const fwd = forwardFromYawPitch(frame.yaw, frame.pitch);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], fwd, [0, 1, 0]);
  const viewProj = mat4.multiply(mat4.create(), proj, view);
  const inv = mat4.invert(mat4.create(), viewProj);
  const st = atmo.prepare(frame);
  const L = st.lightDir;
  const sh = computeShadowMatrix(camPos, L, settings.shadowRadius);

  frameU.mat('uView', view);
  frameU.mat('uProj', proj);
  frameU.mat('uViewProj', viewProj);
  frameU.mat('uInvViewProj', inv);
  frameU.mat('uShadowMat', sh.matrix);
  frameU.vec('uCamPos', camPos[0], camPos[1], camPos[2], frame.time);
  frameU.vec('uSunDir', ...st.sunDir, st.sunVisibility);
  frameU.vec('uMoonDir', ...st.moonDir, st.moonVisibility);
  frameU.vec('uLightDir', ...L, st.lightIsSun ? 1 : 0);
  frameU.vec('uRes', W, H, 1 / W, 1 / H);
  frameU.vec('uCam', 0.08, far, settings.renderDistance * 16 - 8, frame.eyeSkyLight ?? 1);
  frameU.vec('uShadow', settings.shadows ? 1 : 0, settings.shadowRadius, settings.shadowRes, 0.012);
  frameU.vec('uEnv', frame.underwater ? 1 : 0, frame.index || 0, frame.cloudCoverage ?? 0.45, frame.timeOfDay);
  frameU.vec('uWind', 5.2, 1.7, st.starRotation, st.fogDensity);
  frameU.vec('uQuality', settings.ssr, 16, settings.clouds, settings.pcss ? 1 : 0);
  frameU.upload();

  atmo.update(camPos[1], true);
  glCheck('atmosphere');

  const bindStd = (shadowOn) => {
    const bind = (unit, target, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t); };
    bind(UNIT.ALBEDO, gl.TEXTURE_2D_ARRAY, albedoTex);
    bind(UNIT.NORMALS, gl.TEXTURE_2D_ARRAY, normalTex);
    bind(UNIT.SPECULAR, gl.TEXTURE_2D_ARRAY, specTex);
    bind(UNIT.SHADOW_CMP, gl.TEXTURE_2D, shadowOn ? shadowTex : dummyDepth);
    bind(UNIT.SHADOW_RAW, gl.TEXTURE_2D, shadowOn ? shadowTex : dummyDepth);
    gl.bindSampler(UNIT.SHADOW_CMP, cmpSampler);
    gl.bindSampler(UNIT.SHADOW_RAW, rawSampler);
    bind(UNIT.SKY_LUT, gl.TEXTURE_2D, atmo.skyLUT);
    bind(UNIT.IRRADIANCE, gl.TEXTURE_2D, atmo.irradiance);
    bind(UNIT.NOISE2D, gl.TEXTURE_2D, atmo.noise2D);
    bind(UNIT.NOISE3D, gl.TEXTURE_3D, atmo.noise3D);
  };

  // Shadow pass (the shadow texture is not bound for sampling while it is the render target)
  bindStd(false);
  if (settings.shadows) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
    gl.viewport(0, 0, settings.shadowRes, settings.shadowRes);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const cam = camPos;
    terrain.drawShadow({ camPos: cam, shadowCenter: sh.center, shadowRadius: settings.shadowRadius, time: frame.time, shadowMatrix: opts.shadowMatrix ? sh.matrix : undefined });
    glCheck('drawShadow');
  }
  bindStd(settings.shadows);

  // Scene
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFB);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  const frustum = frustumPlanes(new Float32Array(24), viewProj);
  const v = { camPos, frustum, time: frame.time, aspect: W / H, height: H, shadowMatrix: sh.matrix };
  terrain.drawOpaque(v);
  glCheck('drawOpaque');
  overlays.drawParticles(v, frame.particles);
  glCheck('drawParticles');
  atmo.drawSky();
  glCheck('drawSky');

  // Water: copies on units 10/11
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sceneFB);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, copyFB);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFB);
  gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, copyColor);
  gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_2D, copyDepth);
  terrain.drawWater(v);
  glCheck('drawWater');
  overlays.drawSelection(v, frame.selection);
  glCheck('drawSelection');
  if (frame.held) {
    gl.clear(gl.DEPTH_BUFFER_BIT);
    overlays.drawHeld(v, frame.held);
    glCheck('drawHeld');
  }

  // Tonemap to the canvas
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, sceneColor);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.viewport(0, 0, W, H);
  gl.disable(gl.DEPTH_TEST);
  tonemap.use();
  gl.uniform1f(tonemap.u('uExposureBias'), +(q.get('ev') || 1));
  drawFullscreen(gl);
  gl.enable(gl.DEPTH_TEST);
  glCheck('tonemap');
  if (q.get('debug') === 'shadow') {
    // Show the shadow map's raw depth around the player (zoomed on the centre) with particle positions.
    const dbg = new Program(gl, FULLSCREEN_VS, GLSL_COMMON + `
in vec2 vUV; out vec4 o;
uniform vec3 uMarks[4];
void main() {
  vec2 uv = 0.5 + (vUV - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 0.08;
  float d = textureLod(uShadowRaw, uv, 0.0).r;
  vec3 c = vec3(fract(d * 512.0));
  for (int i = 0; i < 4; i++) { vec3 sc = shadowCoord(uMarks[i]); if (length((sc.xy - uv) * uShadow.z) < 3.0) c = i < 2 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0); }
  o = vec4(c, 1.0);
}`, 'dbg');
    dbg.use();
    const P = frame.particles, o = P.origin, cam = camPos;
    const marks = [];
    for (const i of [0, 1, 40, 41]) marks.push(P.pos[i * 3] - cam[0], P.pos[i * 3 + 1] - cam[1], P.pos[i * 3 + 2] - cam[2]);
    gl.uniform3fv(dbg.u('uMarks[0]'), marks);
    drawFullscreen(gl);
    log('marks', JSON.stringify(marks.map((v) => +v.toFixed(2))), 'cam', JSON.stringify(camPos));
    const names = {};
    for (const k in B) names[B[k]] = k;
    const found = [];
    for (let y = 60; y < 80; y++) for (let z = -4; z <= 6; z++) for (let x = -12; x <= 2; x++) {
      const id = getBlock(x, y, z);
      if (id && id !== B.STONE_BRICKS && id !== B.DIRT && id !== B.STONE && id !== B.GRASS) found.push(`${names[id]}@${x},${y},${z}`);
    }
    log('blocks', found.join(' '));
  }
  report.stats = { ...terrain.stats };
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const particles = new ParticleSystem(tex);
  loadWorld(sc.pos, settings.renderDistance);
  let selection = null, held = null;
  if (sc.held) {
    const p = props;
    const so = (q.get('sel') || '-1,0,-3').split(',').map(Number);
    selection = { x: p.x + so[0], y: p.y + so[1], z: p.z + so[2], id: getBlock(p.x + so[0], p.y + so[1], p.z + so[2]) };
    held = { blockId: +(q.get('heldId') || B.GRASS), swing: +(q.get('swing') || 0), equip: 0, bobX: 0, bobY: 0, light: [1, 0] };
  }
  if (q.get('particles')) {
    const p = props || { x: Math.floor(sc.pos[0]), y: Math.floor(sc.pos[1]) - 2, z: Math.floor(sc.pos[2]) - 3 };
    particles.spawnBlockBreak(p.x - 2, p.y, p.z - 1, B.GRASS);
    particles.spawnBlockBreak(p.x + 1, p.y, p.z - 1, B.GOLD_BLOCK);
    particles.update(0.08, worldView);
  }
  const frame = {
    camPos: sc.pos, yaw: sc.yaw, pitch: sc.pitch, fov: 70 * Math.PI / 180, time: +(q.get('t') || 100),
    timeOfDay: sc.time, underwater: !!sc.underwater, eyeSkyLight: sc.underwater ? 0.6 : 1,
    selection, particles, held, cloudCoverage: 0.45, index: 0,
  };
  const frames = +(q.get('frames') || 1);
  const t1 = performance.now();
  for (let i = 0; i < frames; i++) {
    frame.index = i;
    render(frame, { shadowMatrix: q.get('lightcull') === '1' });
  }
  gl.finish();
  report.ms = (performance.now() - t1) / frames;
  report.scene = SCENE;
  report.spawn = spawn;
  report.shore = shore;
  log('render', report.ms.toFixed(0), 'ms/frame', JSON.stringify(report.stats));
  window.__done = true;
}
main().catch((e) => { console.error(e.stack || e.message); window.__done = true; });
