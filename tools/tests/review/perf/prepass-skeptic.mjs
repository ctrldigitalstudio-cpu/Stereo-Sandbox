#!/usr/bin/env node
// Review scratch (skeptic, read-only): time the shipped opaque pass against a depth pre-pass +
// shading pass (same VS with `invariant gl_Position`, alpha test moved to the pre-pass), and
// compare the resulting scene colour, in SwiftShader.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test&preset=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
console.log('boot', new Date().toISOString());
await page.evaluate(() => { window.__game.setRender(false); window.__game.play(); });
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
const scenes = [
  { name: 'afternoon-walk', time: 0.4, pos: [spawn.x, spawn.y, spawn.z], yaw: 0.6, pitch: -0.05 },
  { name: 'noon-look-down', time: 0.25, pos: [spawn.x, spawn.y + 20, spawn.z], yaw: 0.6, pitch: -0.6 },
];
for (const s of scenes) {
  console.log('scene', s.name, new Date().toISOString());
  await page.evaluate((s) => { const g = window.__game; g.teleport(...s.pos, s.yaw, s.pitch); g.setTime(s.time); }, s);
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
  await frames(5);
  console.log('loaded', new Date().toISOString());
  await page.evaluate(() => window.__game.capture());
  const r = await page.evaluate(async () => {
    const g = window.__game, R = g.renderer, T = R.terrain, gl = R.gl, view = R.viewInfo, cam = view.camPos;
    const { Program } = await import('/src/gl.js');
    const src = (p) => gl.getAttachedShaders(p).map((s) => ({ type: gl.getShaderParameter(s, gl.SHADER_TYPE), src: gl.getShaderSource(s) }));
    const sh = src(T.terrain.program);
    const VS = sh.find((x) => x.type === gl.VERTEX_SHADER).src;
    const FS = sh.find((x) => x.type === gl.FRAGMENT_SHADER).src;
    const at = VS.lastIndexOf('void main()');
    const VSi = VS.slice(0, at) + 'invariant gl_Position;\n' + VS.slice(at);
    const alphaLine = 'if (albedo.a < 0.5 && !leafHole) discard;';
    if (!FS.includes(alphaLine)) return { error: 'alpha line not found' };
    const FSmain = FS.replace(alphaLine, '');
    const hdrEnd = FS.indexOf('\n', FS.indexOf('#version')) + 1;
    // GLSL_COMMON prefix = everything before the FS's own constants
    const common = FS.slice(0, FS.indexOf('const uint FLAG_WAVE_LEAVES = 1u;'));
    const FSpre = common + `
in vec2 vUV; flat in uint vLayer; flat in uint vFlags; out vec4 o;
void main() {
  if ((vFlags & 8u) != 0u && !gl_FrontFacing) discard;
  float a = textureGrad(uAlbedo, vec3(pixelArtUV(vUV, int(vLayer) != uLavaLayer), float(vLayer)), dFdx(vUV), dFdy(vUV)).a;
  bool leafHole = (vFlags & 1u) != 0u && !gl_FrontFacing && a < 0.5;
  if (a < 0.5 && !leafHole) discard;
  o = vec4(0.0);
}`.replace('in vec2 vUV;', 'uniform int uLavaLayer;\nin vec2 vUV;');
    const lava = T.textureSet.layerOf && T.textureSet.layerOf.lava;
    const bits = new Uint32Array(8);
    const cut = T.textureSet.cutout;
    for (let i = 0; i < Math.min(cut.length, 256); i++) if (cut[i]) bits[i >> 5] |= 1 << (i & 31);
    const mk = (vs, fs, label) => { const P = new Program(gl, vs, fs, label); P.use(); gl.uniform1i(P.u('uLavaLayer'), Number.isInteger(lava) ? lava : -1); gl.uniform4uiv(P.u('uTwoSided[0]'), bits); return P; };
    const Pre = mk(VSi, FSpre, 'pre');
    const Main = mk(VSi, FSmain, 'mainNoAlpha');
    const list = T._collect(view, 'opaque', false).slice();
    const W = R.renderWidth, H = R.renderHeight;
    const drawWith = (P) => {
      P.use();
      const off = P.u('uChunkOffset'), world = P.u('uChunkWorld');
      for (const c of list) {
        const ox = c.cx * 16, oz = c.cz * 16;
        gl.uniform3f(off, ox - cam[0], -cam[1], oz - cam[2]);
        gl.uniform3f(world, ox, 0, oz);
        gl.bindVertexArray(c.opaque.vao);
        gl.drawElements(gl.TRIANGLES, c.opaque.quads * 6, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
    };
    const begin = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.sceneFB); gl.viewport(0, 0, W, H);
      gl.colorMask(true, true, true, true); gl.depthMask(true);
      gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    };
    const shipped = () => { begin(); T.drawOpaque(view); };
    const prepass = (func) => () => {
      begin();
      gl.colorMask(false, false, false, false);
      drawWith(Pre);
      gl.colorMask(true, true, true, true);
      gl.depthMask(false); gl.depthFunc(func);
      drawWith(Main);
      gl.depthMask(true); gl.depthFunc(gl.LESS);
    };
    const shadowOnly = () => { begin(); gl.colorMask(false, false, false, false); drawWith(Pre); gl.colorMask(true, true, true, true); };
    const time = (fn, n = 3) => {
      fn(); gl.finish();
      const ts = [];
      for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); gl.finish(); ts.push(performance.now() - t0); }
      ts.sort((a, b) => a - b);
      return +ts[n >> 1].toFixed(1);
    };
    const read = () => { const px = new Float32Array(W * H * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, R.sceneFB); gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px); return px; };
    const out = { W, H, chunks: list.length, quads: list.reduce((a, c) => a + c.opaque.quads, 0) };
    out.ms_shipped = time(shipped);
    out.ms_prepass_equal = time(prepass(gl.EQUAL));
    out.ms_prepass_lequal = time(prepass(gl.LEQUAL));
    out.ms_prepassOnly = time(shadowOnly);
    out.ms_shipped_again = time(shipped);
    // full frame for context
    out.ms_shadowPass = time(() => { gl.bindFramebuffer(gl.FRAMEBUFFER, R.shadowFB); gl.viewport(0, 0, R.shadowRes, R.shadowRes); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT); R._bindShadow(R.dummyDepth); T.drawShadow(view); R._bindShadow(R.shadowTex); }, 3);
    shipped(); const A = read();
    prepass(gl.EQUAL)(); const B = read();
    prepass(gl.LEQUAL)(); const C = read();
    const cmp = (X, Y) => { let maxd = 0, n = 0, holes = 0; for (let i = 0; i < W * H; i++) { let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(X[i * 4 + k] - Y[i * 4 + k])); if (d > maxd) maxd = d; if (d > 1e-3) n++; if (X[i*4]+X[i*4+1]+X[i*4+2] > 0 && Y[i*4]+Y[i*4+1]+Y[i*4+2] === 0) holes++; } return { maxAbsDiff: +maxd.toFixed(5), pixelsDiff: n, holes }; };
    out.diff_equal = cmp(A, B);
    out.diff_lequal = cmp(A, C);
    gl.deleteProgram(Pre.program); gl.deleteProgram(Main.program);
    R._defaultState && R._defaultState();
    return out;
  });
  console.log(s.name, JSON.stringify(r));
}
await browser.close();
server.close();
