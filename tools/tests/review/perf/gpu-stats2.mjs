#!/usr/bin/env node
// Review scratch (performance), read-only: opaque-pass overdraw split by cutout/non-cutout and
// the shadow pass's rasterized fragment counts (no culling vs light-facing only).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = await startStaticServer(root);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test&preset=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.evaluate(() => { window.__game.setRender(false); window.__game.play(); });
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
const frames = (n) => page.evaluate((n) => new Promise((res) => { const s = window.__game.frame; const t = () => (window.__game.frame - s >= n ? res() : requestAnimationFrame(t)); t(); }), n);
const scenes = [
  { name: 'afternoon-walk', time: 0.4, pos: [spawn.x, spawn.y, spawn.z], yaw: 0.6, pitch: -0.05 },
  { name: 'noon-look-down', time: 0.25, pos: [spawn.x, spawn.y + 20, spawn.z], yaw: 0.6, pitch: -0.6 },
];
for (const s of scenes) {
  await page.evaluate((s) => { const g = window.__game; g.teleport(...s.pos, s.yaw, s.pitch); g.setTime(s.time); }, s);
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
  await frames(5);
  await page.evaluate(() => window.__game.capture());
  const r = await page.evaluate(async () => {
    const g = window.__game, R = g.renderer, T = R.terrain, gl = R.gl;
    const { Program } = await import('/src/gl.js');
    const { GLSL_COMMON } = await import('/src/render/common.js');
    const view = R.viewInfo, cam = view.camPos;
    const bits = new Uint32Array(8);
    const cut = R.textureSet.cutout;
    for (let i = 0; i < Math.min(cut.length, 256); i++) if (cut[i]) bits[i >> 5] |= 1 << (i & 31);
    const src = (p) => gl.getAttachedShaders(p).map((s) => gl.getShaderSource(s));
    const mkTarget = (W, H) => {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, H);
      const dep = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dep); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, W, H);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dep, 0);
      return { fb, W, H, del() { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.deleteTexture(dep); } };
    };
    const readSum = (t) => {
      const px = new Float32Array(t.W * t.H * 4);
      gl.readPixels(0, 0, t.W, t.H, gl.RGBA, gl.FLOAT, px);
      const s = [0, 0, 0, 0]; let cov = 0;
      for (let i = 0; i < t.W * t.H; i++) { for (let k = 0; k < 4; k++) s[k] += px[i * 4 + k]; if (px[i * 4 + 3] > 0) cov++; }
      return { r: s[0], g: s[1], b: s[2], a: s[3], covered: cov };
    };
    const out = {};
    // ---- Opaque pass: split by layer kind ----
    {
      const vs = src(T.terrain.program).find((s) => s.includes('uTwoSided'));
      const FS = GLSL_COMMON + `
in vec2 vUV; flat in uint vLayer; flat in uint vFlags;
uniform uvec4 uCut[2];
uniform int uMode; // 0 all, 1 non-cutout only, 2 cutout only
out vec4 o;
void main() {
  bool isCut = ((uCut[int(vLayer >> 7u)][int((vLayer >> 5u) & 3u)] >> (vLayer & 31u)) & 1u) != 0u || (vFlags & 8u) != 0u;
  if (uMode == 1 && isCut) discard;
  if (uMode == 2 && !isCut) discard;
  if ((vFlags & 8u) != 0u && !gl_FrontFacing) discard;
  vec4 a = textureGrad(uAlbedo, vec3(pixelArtUV(vUV, true), float(vLayer)), dFdx(vUV), dFdy(vUV));
  if (a.a < 0.5) discard;
  o = vec4(isCut ? 0.0 : 1.0, isCut ? 1.0 : 0.0, gl_FrontFacing ? 0.0 : 1.0, 1.0);
}`;
      const P = new Program(gl, vs, FS, 'count-opaque');
      P.use();
      gl.uniform4uiv(P.u('uTwoSided[0]'), bits);
      gl.uniform4uiv(P.u('uCut[0]'), bits);
      const list = T._collect(view, 'opaque', false).slice();
      const t = mkTarget(R.renderWidth, R.renderHeight);
      const draw = (mode) => {
        gl.uniform1i(P.u('uMode'), mode);
        for (const c of list) {
          const ox = c.cx * 16, oz = c.cz * 16;
          gl.uniform3f(P.u('uChunkOffset'), ox - cam[0], -cam[1], oz - cam[2]);
          gl.uniform3f(P.u('uChunkWorld'), ox, 0, oz);
          gl.bindVertexArray(c.opaque.vao);
          gl.drawElements(gl.TRIANGLES, c.opaque.quads * 6, gl.UNSIGNED_INT, 0);
        }
      };
      const begin = () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, t.W, t.H);
        gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); P.use();
      };
      begin(); draw(0); const asIs = readSum(t);
      begin(); draw(1); draw(2); const split = readSum(t);
      gl.disable(gl.BLEND); gl.bindVertexArray(null);
      out.opaque = {
        pixels: t.W * t.H, covered: asIs.covered,
        asIs: { nonCutoutFrags: asIs.r, cutoutFrags: asIs.g, backFacing: asIs.b, total: asIs.a, perCovered: +(asIs.a / asIs.covered).toFixed(2) },
        opaqueFirstThenCutout: { total: split.a, perCovered: +(split.a / split.covered).toFixed(2) },
      };
      t.del(); gl.deleteProgram(P.program);
    }
    // ---- Shadow pass fragments ----
    {
      const vs = src(T.shadow.program).find((s) => s.includes('shadowDistort(p.xy)'));
      const FS = GLSL_COMMON + `
in vec2 vUV; flat in uint vLayer;
out vec4 o;
void main() {
  if (textureGrad(uAlbedo, vec3(pixelArtUV(vUV, true), float(vLayer)), dFdx(vUV), dFdy(vUV)).a < 0.5) discard;
  o = vec4(1.0, gl_FrontFacing ? 0.0 : 1.0, 0.0, 1.0);
}`;
      const P = new Program(gl, vs, FS, 'count-shadow');
      const res = R.shadowRes;
      const t = mkTarget(res, res);
      // same caster list as drawShadow: re-run its collection by calling it with a no-op draw
      const saved = T._drawList; let list = null;
      T._drawList = (l) => { list = l.slice(); return 0; };
      const fb0 = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      T.drawShadow(view);
      T._drawList = saved;
      const run = (depth, cull) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, res, res);
        gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS); gl.depthMask(true);
        if (cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); P.use();
        for (const c of list) {
          const ox = c.cx * 16, oz = c.cz * 16;
          gl.uniform3f(P.u('uChunkOffset'), ox - cam[0], -cam[1], oz - cam[2]);
          gl.uniform3f(P.u('uChunkWorld'), ox, 0, oz);
          gl.bindVertexArray(c.opaque.vao);
          gl.drawElements(gl.TRIANGLES, c.opaque.quads * 6, gl.UNSIGNED_INT, 0);
        }
        gl.bindVertexArray(null); gl.disable(gl.BLEND);
        return readSum(t);
      };
      const noDepth = run(false, false);
      const inOrder = run(true, false);
      out.shadow = {
        res, casters: list.length, texels: res * res, coveredTexels: inOrder.covered,
        rasterizedFragsNoCull: noDepth.a, ofWhichBackFacing: noDepth.g,
        fragsPassingDepthInOrder: inOrder.a, perCoveredTexel: +(inOrder.a / inOrder.covered).toFixed(2),
      };
      t.del(); gl.deleteProgram(P.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb0);
    }
    return out;
  });
  console.log(s.name, JSON.stringify(r, null, 1));
}
await browser.close();
server.close();
