#!/usr/bin/env node
// Review scratch (performance), read-only: effect of the mesher's bottom-up (y = 0 first) quad order
// on fragments shaded in submission order. Re-meshes the same chunks in the page (same seed, no
// edits), then counts depth-passing fragments with the original quad order vs. quads sorted top-down.
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
    const g = window.__game, R = g.renderer, T = R.terrain, gl = R.gl, view = R.viewInfo, cam = view.camPos;
    const { Program } = await import('/src/gl.js');
    const { GLSL_COMMON } = await import('/src/render/common.js');
    const { meshChunk } = await import('/src/mesher.js');
    const { WorldGen } = await import('/src/worldgen.js');
    const { setupVertexAttribs } = await import('/src/vertex.js');
    const wg = new WorldGen(12345);
    const cache = new Map();
    const chunk = (cx, cz) => { const k = cx + ',' + cz; let c = cache.get(k); if (!c) { c = wg.generateChunk(cx, cz); cache.set(k, c); } return c; };
    const meshes = new Map();
    const remesh = (c) => {
      const k = c.cx + ',' + c.cz;
      if (meshes.has(k)) return meshes.get(k);
      const nb = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) nb.push(chunk(c.cx + dx, c.cz + dz));
      const m = meshChunk(nb, R.textureSet.faceLayers, c.cx, c.cz);
      const n = m.opaqueQuads, src = m.opaque;
      const order = Array.from({ length: n }, (_, i) => i);
      const qy = new Float32Array(n);
      for (let q = 0; q < n; q++) { let y = 0; for (let v = 0; v < 4; v++) y = Math.max(y, (src[q * 16 + v * 4] >>> 16) & 4095); qy[q] = y; }
      order.sort((a, b) => qy[b] - qy[a]);
      const sorted = new Uint32Array(n * 16);
      order.forEach((q, i) => sorted.set(src.subarray(q * 16, q * 16 + 16), i * 16));
      const mk = (data) => { const vao = gl.createVertexArray(), vbo = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); setupVertexAttribs(gl); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, T.ibo); gl.bindVertexArray(null); return { vao, vbo }; };
      const e = { quads: n, gpuQuads: c.opaque.quads, orig: mk(src.subarray(0, n * 16)), top: mk(sorted) };
      meshes.set(k, e);
      return e;
    };
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
    const count = (P, t, list, which, cull) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, t.W, t.H);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
      if (cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); P.use();
      for (const c of list) {
        const m = remesh(c);
        const ox = c.cx * 16, oz = c.cz * 16;
        gl.uniform3f(P.u('uChunkOffset'), ox - cam[0], -cam[1], oz - cam[2]);
        gl.uniform3f(P.u('uChunkWorld'), ox, 0, oz);
        gl.bindVertexArray(m[which].vao);
        gl.drawElements(gl.TRIANGLES, m.quads * 6, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null); gl.disable(gl.BLEND);
      const px = new Float32Array(t.W * t.H * 4);
      gl.readPixels(0, 0, t.W, t.H, gl.RGBA, gl.FLOAT, px);
      let s = 0, cov = 0; for (let i = 0; i < t.W * t.H; i++) { s += px[i * 4]; if (px[i * 4] > 0) cov++; }
      return { frags: s, covered: cov, perCovered: +(s / cov).toFixed(2) };
    };
    const out = {};
    // opaque pass
    {
      const vs = src(T.terrain.program).find((s) => s.includes('uTwoSided'));
      const P = new Program(gl, vs, GLSL_COMMON + `
in vec2 vUV; flat in uint vLayer; flat in uint vFlags; out vec4 o;
void main() {
  if ((vFlags & 8u) != 0u && !gl_FrontFacing) discard;
  float a = textureGrad(uAlbedo, vec3(pixelArtUV(vUV, true), float(vLayer)), dFdx(vUV), dFdy(vUV)).a;
  bool leafHole = (vFlags & 1u) != 0u && !gl_FrontFacing && a < 0.5;   // current terrain FS: leaf back-face holes are shaded
  if (a < 0.5 && !leafHole) discard;
  o = vec4(1.0);
}`, 'count-o');
      P.use(); gl.uniform4uiv(P.u('uTwoSided[0]'), bits);
      const list = T._collect(view, 'opaque', false).slice();
      const t = mkTarget(R.renderWidth, R.renderHeight);
      const a = count(P, t, list, 'orig', false), b = count(P, t, list, 'top', false);
      let mismatch = 0; for (const c of list) { const m = remesh(c); if (m.quads !== m.gpuQuads) mismatch++; }
      out.opaque = { chunks: list.length, remeshMismatch: mismatch, bottomUp_asShipped: a, topDown: b };
      t.del(); gl.deleteProgram(P.program);
    }
    // shadow pass
    {
      const vs = src(T.shadow.program).find((s) => s.includes('shadowDistort(p.xy)'));
      const P = new Program(gl, vs, GLSL_COMMON + `
in vec2 vUV; flat in uint vLayer; out vec4 o;
void main() {
  if (textureGrad(uAlbedo, vec3(pixelArtUV(vUV, true), float(vLayer)), dFdx(vUV), dFdy(vUV)).a < 0.5) discard;
  o = vec4(1.0);
}`, 'count-s');
      const saved = T._drawList; let list = null;
      T._drawList = (l) => { list = l.slice(); return 0; };
      T.drawShadow(view);
      T._drawList = saved;
      const t = mkTarget(R.shadowRes, R.shadowRes);
      const a = count(P, t, list, 'orig', false), b = count(P, t, list, 'top', false);
      const c2 = count(P, t, list, 'top', true);
      out.shadow = { casters: list.length, bottomUp_noCull_asShipped: a, topDown_noCull: b, topDown_backfaceCull: c2 };
      t.del(); gl.deleteProgram(P.program);
    }
    for (const m of meshes.values()) for (const k of ['orig', 'top']) { gl.deleteVertexArray(m[k].vao); gl.deleteBuffer(m[k].vbo); }
    return out;
  });
  console.log(s.name, JSON.stringify(r, null, 1));
}
await browser.close();
server.close();
