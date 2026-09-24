#!/usr/bin/env node
// Review scratch (performance): boots the game with the High preset in headless Chromium, waits for
// the full render distance, then measures per-frame geometry work (main vs shadow pass) and the
// opaque-pass fragment overdraw in submission order, using a counting program built from the
// terrain program's own vertex shader. Read-only: nothing in the repo is modified.
//
//   node tools/tests/review/perf/gpu-stats.mjs [--size 1280x720]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { startStaticServer } from '../../../static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const [W, H] = opt('size', '1280x720').split('x').map(Number);

const server = await startStaticServer(root);
const url = `http://127.0.0.1:${server.address().port}/index.html?test&preset=high`;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 400)}`); });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.evaluate(() => window.__game.setRender(false));
await page.evaluate(() => window.__game.play());
const spawn = await page.evaluate(() => window.__game.gen.findSpawn());
log(`spawn ${JSON.stringify(spawn)}`);

const frames = (n) => page.evaluate((n) => new Promise((res) => {
  const start = window.__game.frame;
  const tick = () => (window.__game.frame - start >= n ? res() : requestAnimationFrame(tick));
  tick();
}), n);

const scenes = [
  { name: 'afternoon-walk', time: 0.4, pos: [spawn.x, spawn.y, spawn.z], yaw: 0.6, pitch: -0.05 },
  { name: 'sunset-walk', time: 0.47, pos: [spawn.x, spawn.y, spawn.z], yaw: 0.6, pitch: -0.05 },
  { name: 'noon-look-down', time: 0.25, pos: [spawn.x, spawn.y + 20, spawn.z], yaw: 0.6, pitch: -0.6 },
];

for (const s of scenes) {
  await page.evaluate((s) => { const g = window.__game; g.teleport(...s.pos, s.yaw, s.pitch); g.player.flying = true; g.setTime(s.time); }, s);
  await frames(3);
  await page.waitForFunction(() => window.__game.loaded(10) >= 1, null, { timeout: 600000, polling: 500 });
  await frames(5);
  await page.evaluate(() => window.__game.capture());   // renders one real frame
  const r = await page.evaluate(async () => {
    const g = window.__game, R = g.renderer, T = R.terrain, gl = R.gl;
    const out = { stats: { ...R.stats }, loaded: T.chunks.size };
    let quadsAll = 0; for (const c of T.chunks.values()) if (c.opaque) quadsAll += c.opaque.quads;
    out.loadedOpaqueQuads = quadsAll;
    // ---- Opaque overdraw in submission order (what early-Z / Apple HSR-without-discard sees) ----
    const view = R.viewInfo;
    const list = T._collect(view, 'opaque', false).slice();
    const { Program } = await import('/src/gl.js');
    const { GLSL_COMMON } = await import('/src/render/common.js');
    const shaders = gl.getAttachedShaders(T.terrain.program);
    const vsSrc = shaders.map((s) => gl.getShaderSource(s)).find((s) => s.includes('uTwoSided'));
    const FS = GLSL_COMMON + `
in vec2 vUV; flat in uint vLayer; flat in uint vFlags;
uniform float uIsCut;
out vec4 o;
void main() {
  if ((vFlags & 8u) != 0u && !gl_FrontFacing) discard;
  vec4 a = textureGrad(uAlbedo, vec3(pixelArtUV(vUV, true), float(vLayer)), dFdx(vUV), dFdy(vUV));
  if (a.a < 0.5) discard;
  o = vec4(1.0, gl_FrontFacing ? 0.0 : 1.0, 0.0, 1.0);
}`;
    const P = new Program(gl, vsSrc, FS, 'count');
    P.use();
    const bits = new Uint32Array(8);
    const cut = R.textureSet.cutout;
    for (let i = 0; i < Math.min(cut.length, 256); i++) if (cut[i]) bits[i >> 5] |= 1 << (i & 31);
    gl.uniform4uiv(P.u('uTwoSided[0]'), bits);
    const W = R.renderWidth, H = R.renderHeight;
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, H);
    const dep = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dep);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, W, H);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dep, 0);
    const blendOk = !!gl.getExtension('EXT_float_blend');
    const run = (depthTest) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS); gl.depthMask(true);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      P.use();
      const cam = view.camPos;
      for (const c of list) {
        const ox = c.cx * 16, oz = c.cz * 16;
        gl.uniform3f(P.u('uChunkOffset'), ox - cam[0], -cam[1], oz - cam[2]);
        gl.uniform3f(P.u('uChunkWorld'), ox, 0, oz);
        gl.bindVertexArray(c.opaque.vao);
        gl.drawElements(gl.TRIANGLES, c.opaque.quads * 6, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      const px = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
      let frags = 0, back = 0, covered = 0, maxc = 0;
      for (let i = 0; i < W * H; i++) { const v = px[i * 4]; frags += v; back += px[i * 4 + 1]; if (v > 0) covered++; if (v > maxc) maxc = v; }
      return { frags, back, covered, maxc };
    };
    const dt = run(true);
    const nd = run(false);
    out.overdraw = {
      blendOk, W, H, pixels: W * H, chunksDrawn: list.length,
      coveredPixels: dt.covered,
      fragsPassingDepthInOrder: dt.frags, perCoveredPixel: +(dt.frags / dt.covered).toFixed(2),
      backFaceFragsPassingDepth: dt.back,
      fragsRasterizedNoDepth: nd.frags, rasterPerCoveredPixel: +(nd.frags / dt.covered).toFixed(2),
      maxDepthComplexity: nd.maxc,
    };
    gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.deleteTexture(dep); gl.deleteProgram(P.program);
    // ---- Shadow casters that cannot shadow anything in the camera frustum ----
    // Sweep each shadow-pass chunk's AABB along the light's travel direction (-L) down to y = 0
    // and test the swept box against the camera frustum.
    const { aabbInFrustum } = await import('/src/math.js');
    const L = view.lightDir, cam = view.camPos, fr = view.frustum;
    const center = view.shadowCenter, radius = view.shadowRadius, m = view.shadowMatrix;
    const sinEl = Math.abs(m[6]) / (Math.hypot(m[2], m[6], m[10]) || 1);
    const reach = Math.min(radius / Math.max(sinEl, 0.3), radius * 2) + 16;
    let sc = 0, sq = 0, useless = 0, uselessQ = 0;
    for (const c of T.chunks.values()) {
      if (!c.opaque) continue;
      const x0 = c.cx * 16, z0 = c.cz * 16;
      const dx = Math.max(x0 - center[0], 0, center[0] - (x0 + 16));
      const dz = Math.max(z0 - center[2], 0, center[2] - (z0 + 16));
      if (dx * dx + dz * dz > reach * reach) continue;
      sc++; sq += c.opaque.quads;
      const len = c.maxY / Math.max(L[1], 0.05);
      const ex = -L[0] * len, ey = -L[1] * len, ez = -L[2] * len;
      const bx0 = x0 - cam[0], by0 = c.minY - cam[1], bz0 = z0 - cam[2];
      const bx1 = bx0 + 16, by1 = c.maxY - cam[1], bz1 = bz0 + 16;
      const vis = aabbInFrustum(fr, Math.min(bx0, bx0 + ex), Math.min(by0, by0 + ey), Math.min(bz0, bz0 + ez),
        Math.max(bx1, bx1 + ex), Math.max(by1, by1 + ey), Math.max(bz1, bz1 + ez));
      if (!vis) { useless++; uselessQ += c.opaque.quads; }
    }
    out.shadowCasters = { reach: Math.round(reach), chunksInReach: sc, quadsInReach: sq, sweptOutsideFrustumChunks: useless, sweptOutsideFrustumQuads: uselessQ };
    return out;
  });
  log(`${s.name}: ${JSON.stringify(r, null, 1)}`);
}
await browser.close();
server.close();
