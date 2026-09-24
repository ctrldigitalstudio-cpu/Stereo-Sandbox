// Browser test for the world worker + mesher. ?mode=module (dev module worker) or ?mode=blob
// (esbuild IIFE from a Blob URL, like the single-file build; run bundle-worker.mjs first).
// Streams chunks around spawn, checks the protocol and MessageChannel interleaving in a real
// worker, builds a showcase with 'set' edits and renders everything with the shared vertex decoder.
//   node tools/tests/mesher/bundle-worker.mjs
//   node tools/run-page.mjs tools/tests/mesher/page.html?mode=blob --until window.__done --wait 120000 --shot tools/out/mesher-blob.png --size 800x450
import { B, SEA } from '../../../src/blocks.js';
import { GLSL_BLOCK_VERTEX } from '../../../src/render/common.js';
import { mat4 } from '../../../src/math.js';
import { buildTextures } from '../../../src/textures.js';
import { WorldGen } from '../../../src/worldgen.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') || 'module';
const R = Number(params.get('r') || 3);
const VIEW = params.get('view') || 'showcase';
const log = (...a) => console.log('[mesher-test]', ...a);
const fail = (m) => { console.error('[mesher-test] FAIL: ' + m); window.__failed = (window.__failed || 0) + 1; };

async function createWorker() {
  if (MODE === 'blob') {
    const src = await (await fetch('../../out/mesher-worker.iife.js')).text();
    return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  }
  return new Worker(new URL('../../../src/worker.js', import.meta.url), { type: 'module' });
}

const tex = buildTextures();
const seed = 12345;
const gen = new WorldGen(seed);
const spawn = gen.findSpawn();
const scx = Math.floor(spawn.x / 16), scz = Math.floor(spawn.z / 16);
log(`mode=${MODE} spawn`, JSON.stringify(spawn));

const worker = await createWorker();
const meshes = new Map();      // key -> msg
const order = [];
let waiters = [];
worker.onerror = (e) => fail('worker error ' + (e.message || e));
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ready') { order.push('ready'); }
  if (m.type === 'mesh') {
    if (!(m.blocks instanceof Uint8Array) || !(m.opaque instanceof Uint32Array) || !(m.water instanceof Uint32Array)) fail('mesh message types');
    if (m.opaque.length !== m.opaqueQuads * 16 || m.water.length !== m.waterQuads * 16) fail('mesh sizes');
    meshes.set(`${m.cx},${m.cz}`, m);
    order.push(`${m.cx},${m.cz}`);
  }
  for (const w of waiters) w();
};
const until = (pred, ms = 60000) => new Promise((resolve, reject) => {
  const t0 = performance.now();
  const check = () => {
    if (pred()) { waiters = waiters.filter((w) => w !== check); resolve(); }
    else if (performance.now() - t0 > ms) { waiters = waiters.filter((w) => w !== check); reject(new Error('timeout')); }
  };
  waiters.push(check);
  setTimeout(function poll() { check(); if (waiters.includes(check)) setTimeout(poll, 50); }, 50);
});

// --- protocol ------------------------------------------------------------------------------
worker.postMessage({ type: 'init', seed, faceLayers: tex.faceLayers, edits: [] });
await until(() => order[0] === 'ready');
const want = [];
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) want.push([dx * dx + dz * dz, scx + dx, scz + dz]);
want.sort((a, b) => a[0] - b[0]);
const keys = want.map((w) => [w[1], w[2]]);
const t0 = performance.now();
worker.postMessage({ type: 'want', keys });

// Interleaving: an edit posted while the worker is busy must be served within the next couple of meshes.
await until(() => meshes.size >= 3);
const first = keys[0];
const setIndex = order.length;
worker.postMessage({ type: 'set', x: first[0] * 16 + 5, y: 120, z: first[1] * 16 + 5, id: B.GLOWSTONE });
await until(() => order.length >= setIndex + 3);
const after = order.slice(setIndex, setIndex + 2);
if (!after.includes(`${first[0]},${first[1]}`)) fail(`set not served promptly: next meshes ${after}`);
else log(`set served promptly: next meshes after set = ${after.join(' ')}`);

await until(() => keys.every(([x, z]) => meshes.has(`${x},${z}`)), 120000);
const streamMs = performance.now() - t0;
log(`${keys.length} chunks streamed in ${streamMs.toFixed(0)} ms (${(streamMs / keys.length).toFixed(1)} ms/chunk incl. generation of ${(2 * R + 3) ** 2} chunks)`);
// Re-sending the same want must not produce anything (all held).
const before = order.length;
worker.postMessage({ type: 'want', keys });
await new Promise((r) => setTimeout(r, 300));
if (order.length !== before) fail('held chunks were re-meshed on repeated want');
worker.postMessage({ type: 'set', x: first[0] * 16 + 5, y: 120, z: first[1] * 16 + 5, id: B.AIR });

// --- showcase built with edits -----------------------------------------------------------------
let px = Math.floor(spawn.x) + 4, pz = Math.floor(spawn.z) - 6;
let top = 0;
for (let z = pz - 2; z < pz + 16; z++) for (let x = px - 2; x < px + 16; x++) top = Math.max(top, gen.heightAt(x, z));
const py = Math.max(top, SEA) + 4;
const edits = [];
const put = (x, y, z, id) => edits.push([px + x, py + y, pz + z, id]);
const box = (x0, y0, z0, x1, y1, z1, id) => { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, y, z, id); };
if (VIEW === 'showcase') {
  box(0, 0, 0, 13, 0, 13, B.STONE_BRICKS);             // floating platform: shaded underside
  box(0, 1, 0, 0, 3, 13, B.COBBLESTONE);               // L-shaped walls: inside-corner AO
  box(1, 1, 0, 13, 3, 0, B.COBBLESTONE);
  box(2, 1, 2, 3, 2, 3, B.GLASS);                      // glass box (internal faces culled)
  box(9, 1, 2, 11, 2, 4, B.OAK_LEAVES);                // leaf blob
  box(5, 1, 1, 6, 1, 1, B.BIRCH_LEAVES);
  box(1, 1, 6, 4, 1, 12, B.GRASS);                     // grass bed with plants
  put(1, 2, 7, B.TALL_GRASS); put(2, 2, 8, B.TALL_GRASS); put(3, 2, 7, B.FERN); put(1, 2, 10, B.POPPY);
  put(3, 2, 10, B.DANDELION); put(2, 2, 11, B.CORNFLOWER); put(4, 2, 12, B.TALL_GRASS); put(4, 2, 9, B.DEAD_BUSH);
  box(6, 1, 6, 10, 1, 10, B.BRICKS); box(7, 1, 7, 9, 1, 9, B.WATER);   // pool: surface at 14/16
  put(12, 1, 12, B.WATER); put(12, 2, 12, B.WATER);                     // free water column: clipped sides
  box(6, 1, 12, 7, 1, 12, B.LAVA);                                        // lava strip
  box(10, 1, 7, 13, 3, 11, B.OAK_PLANKS); box(11, 1, 8, 12, 2, 10, B.AIR); // dark hut, open on +X side
  box(13, 1, 8, 13, 2, 10, B.AIR);
  put(11, 1, 9, B.TORCH); put(12, 3, 9, B.GLOWSTONE);
  put(5, 1, 4, B.TORCH);                               // torch in daylight
  put(7, 1, 3, B.GLOWSTONE);
}
const heldBefore = order.length;
for (const [x, y, z, id] of edits) worker.postMessage({ type: 'set', x, y, z, id });
// Wait until the remesh burst settles.
let last = order.length, stable = 0;
while (edits.length && stable < 6) {
  await new Promise((r) => setTimeout(r, 100));
  if (order.length === last) stable++; else { stable = 0; last = order.length; }
}
log(`${edits.length} edits -> ${order.length - heldBefore} remeshes`);
// The latest mesh of every edited chunk must carry the final edited block data.
const finalEdits = new Map();
for (const [x, y, z, id] of edits) finalEdits.set(`${x},${y},${z}`, [x, y, z, id]);
for (const [x, y, z, id] of finalEdits.values()) {
  const m = meshes.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
  if (!m || m.blocks[(x & 15) | ((z & 15) << 4) | (y << 8)] !== id) { fail(`edit ${x},${y},${z} missing from remeshed chunk data`); break; }
}

// --- render -------------------------------------------------------------------------------
const canvas = document.getElementById('c');
canvas.width = innerWidth; canvas.height = innerHeight;
const gl = canvas.getContext('webgl2', { antialias: true });
const VS = `#version 300 es
precision highp float; precision highp int;
${GLSL_BLOCK_VERTEX}
uniform mat4 uViewProj; uniform vec3 uOffset;
out vec3 vUV; out vec3 vN; out float vAO; out vec2 vLight; out vec3 vTint; out float vDist; flat out uint vFlags;
void main() {
  vec3 p = blockLocalPos() + uOffset;
  vUV = vec3(blockUV(), float(blockLayer()));
  vFlags = blockFlags();
  vN = (vFlags & FLAG_PLANT) != 0u ? vec3(0, 1, 0) : FACE_N[blockNormal()];
  vAO = blockAO(); vLight = blockLight(); vTint = blockTint(); vDist = length(p);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;
const FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2DArray;
uniform sampler2DArray uAlbedo, uSpec; uniform float uWater;
in vec3 vUV; in vec3 vN; in float vAO; in vec2 vLight; in vec3 vTint; in float vDist; flat in uint vFlags;
out vec4 o;
void main() {
  vec4 a = texture(uAlbedo, vUV);
  if (uWater < 0.5 && a.a < 0.5) discard;
  float mask = texture(uSpec, vUV).a;
  vec3 alb = a.rgb * mix(vec3(1.0), vTint, uWater > 0.5 ? 1.0 : mask);
  float emissive = texture(uSpec, vUV).b;
  float sky = vLight.x, blk = vLight.y;
  vec3 L = normalize(vec3(0.5, 0.75, 0.35));
  float sun = max(dot(vN, L), 0.0) * smoothstep(0.6, 0.95, sky);
  vec3 light = vec3(1.9, 1.75, 1.5) * sun
             + vec3(0.42, 0.52, 0.7) * (sky * sky * 0.9 + 0.02) * (0.25 + 0.75 * vAO)
             + vec3(1.0, 0.62, 0.32) * pow(blk, 2.2) * 1.6 * (0.5 + 0.5 * vAO);
  vec3 c = alb * light + alb * emissive * 2.0;
  c = mix(c, vec3(0.55, 0.7, 0.9), clamp(vDist / 110.0, 0.0, 1.0) * 0.6);
  c = c / (1.0 + c * 0.35);
  o = vec4(pow(c, vec3(1.0 / 2.2)), uWater > 0.5 ? 0.75 : 1.0);
}`;
function shader(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);

function texArray(levels, unit, srgb) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels.length, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, tex.size, tex.size, tex.layers);
  levels.forEach((d, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, 0, tex.size >> l, tex.size >> l, tex.layers, gl.RGBA, gl.UNSIGNED_BYTE, d));
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}
texArray(tex.albedo, 0, true);
texArray(tex.spec, 1, false);
gl.uniform1i(gl.getUniformLocation(prog, 'uAlbedo'), 0);
gl.uniform1i(gl.getUniformLocation(prog, 'uSpec'), 1);

const maxQuads = Math.max(...[...meshes.values()].map((m) => Math.max(m.opaqueQuads, m.waterQuads)), 1);
const idx = new Uint32Array(maxQuads * 6);
for (let q = 0; q < maxQuads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
const ibo = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
function vao(words) {
  const v = gl.createVertexArray(); gl.bindVertexArray(v);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, words, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_SHORT, 16, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_BYTE, 16, 8);
  gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 4, gl.UNSIGNED_BYTE, 16, 12);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bindVertexArray(null);
  return v;
}
const draws = [...meshes.values()].map((m) => ({ cx: m.cx, cz: m.cz, o: vao(m.opaque), on: m.opaqueQuads, w: vao(m.water), wn: m.waterQuads }));

// eye/at are relative to the showcase origin (px, py, pz).
const rel = (v) => v.split(',').map(Number).map((c, i) => c + [px, py, pz][i]);
const eye = params.get('eye') ? rel(params.get('eye'))
  : VIEW === 'showcase' ? [px + 21, py + 11, pz + 21] : [spawn.x + 30, spawn.y + 25, spawn.z + 30];
const at = params.get('at') ? rel(params.get('at'))
  : VIEW === 'showcase' ? [px + 6, py + 1, pz + 6] : [spawn.x, spawn.y, spawn.z];
const view = mat4.lookAt(mat4.create(), [0, 0, 0], [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]], [0, 1, 0]);
const proj = mat4.perspective(mat4.create(), (Number(params.get('fov') || 60) * Math.PI) / 180, canvas.width / canvas.height, 0.1, 400);
const vp = mat4.multiply(mat4.create(), proj, view);
gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uViewProj'), false, vp);
const uOff = gl.getUniformLocation(prog, 'uOffset'), uWater = gl.getUniformLocation(prog, 'uWater');
gl.viewport(0, 0, canvas.width, canvas.height);
gl.clearColor(0.55, 0.7, 0.9, 1);
gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
gl.uniform1f(uWater, 0);
let quads = 0;
for (const d of draws) {
  gl.uniform3f(uOff, d.cx * 16 - eye[0], -eye[1], d.cz * 16 - eye[2]);
  gl.bindVertexArray(d.o); gl.drawElements(gl.TRIANGLES, d.on * 6, gl.UNSIGNED_INT, 0); quads += d.on;
}
gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); gl.disable(gl.CULL_FACE);
gl.uniform1f(uWater, 1);
for (const d of draws) {
  if (!d.wn) continue;
  gl.uniform3f(uOff, d.cx * 16 - eye[0], -eye[1], d.cz * 16 - eye[2]);
  gl.bindVertexArray(d.w); gl.drawElements(gl.TRIANGLES, d.wn * 6, gl.UNSIGNED_INT, 0); quads += d.wn;
}
gl.finish();
log(`rendered ${draws.length} chunks, ${quads} quads; errors ${gl.getError()}`);
window.__result = { chunks: meshes.size, quads, streamMs, failed: window.__failed || 0 };
window.__done = true;
