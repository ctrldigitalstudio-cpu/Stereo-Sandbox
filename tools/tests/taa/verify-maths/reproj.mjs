// Mirrors the renderer's jitter + the resolve's reprojection in JS doubles to check signs/units.
import { mat4, forwardFromYawPitch } from '../../../../src/math.js';
import { halton } from '../../../../src/render/taa.js';

function jitterProjection(m, ox, oy) {
  for (let c = 0; c < 4; c++) { m[c * 4] += ox * m[c * 4 + 3]; m[c * 4 + 1] += oy * m[c * 4 + 3]; }
  return m;
}
const mulV = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
const W = 400, H = 225, OW = 800, OH = 450, NEAR = 0.08, FAR = 400;
function cam(camPos, yaw, pitch, jx, jy) {
  const fwd = forwardFromYawPitch(yaw, pitch);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], fwd, [0, 1, 0]);
  const proj = mat4.perspective(mat4.create(), 1.3, W / H, NEAR, FAR);
  const vpNJ = mat4.multiply(mat4.create(), proj, view);
  const pj = jitterProjection(Float32Array.from(proj), 2 * jx / W, 2 * jy / H);
  const vp = mat4.multiply(mat4.create(), pj, view);
  const inv = mat4.invert(mat4.create(), vp);
  return { camPos, vpNJ, vp, inv };
}
// world point -> pixel coordinates (render px) with a given viewProj
function toPx(c, P, vp) {
  const r = [P[0] - c.camPos[0], P[1] - c.camPos[1], P[2] - c.camPos[2], 1];
  const cl = mulV(vp, r);
  return { x: (cl[0] / cl[3] * 0.5 + 0.5) * W, y: (cl[1] / cl[3] * 0.5 + 0.5) * H, w: cl[3], zndc: cl[2] / cl[3] };
}
const P = [103.3, 71.2, -40.7];
const jx = halton(3, 2) - 0.5, jy = halton(3, 3) - 0.5;
const cur = cam([100.1, 70.5, 0.2], 0.12, -0.05, jx, jy);
const prev = cam([100.0, 70.5, 0.3], 0.10, -0.04, 0, 0);
const a = toPx(cur, P, cur.vpNJ), b = toPx(cur, P, cur.vp);
console.log('jitter', jx.toFixed(4), jy.toFixed(4), 'image shift px', (b.x - a.x).toFixed(4), (b.y - a.y).toFixed(4));
// Shader: texel cp containing P in jittered image; uvC = texel centre; pos = inv * (uvC, depth)
const cp = [Math.floor(b.x), Math.floor(b.y)];
// depth at texel centre: take P's depth (planar approx) -> reconstruct position at texel centre
const uvC = [(cp[0] + 0.5) / W, (cp[1] + 0.5) / H];
const d = b.zndc * 0.5 + 0.5;
const h = mulV(cur.inv, [uvC[0] * 2 - 1, uvC[1] * 2 - 1, d * 2 - 1, 1]);
const pos = [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
const delta = [cur.camPos[0] - prev.camPos[0], cur.camPos[1] - prev.camPos[1], cur.camPos[2] - prev.camPos[2]];
const pc = mulV(prev.vpNJ, [pos[0] + delta[0], pos[1] + delta[1], pos[2] + delta[2], 1]);
const prevUV = [pc[0] / pc[3] * 0.5 + 0.5, pc[1] / pc[3] * 0.5 + 0.5];
const unjUV = [uvC[0] - jx / W, uvC[1] - jy / H];
const motion = [prevUV[0] - unjUV[0], prevUV[1] - unjUV[1]];
// Ground truth: world point at unjittered texel direction: where was it last frame
const worldAtTexel = [pos[0] + cur.camPos[0], pos[1] + cur.camPos[1], pos[2] + cur.camPos[2]];
const gtPrev = toPx(prev, worldAtTexel, prev.vpNJ), gtCur = toPx(cur, worldAtTexel, cur.vpNJ);
console.log('motion (px) shader', (motion[0] * W).toFixed(4), (motion[1] * H).toFixed(4), ' truth', (gtPrev.x - gtCur.x).toFixed(4), (gtPrev.y - gtCur.y).toFixed(4));
// linear depth vs pc.w
const n = NEAR, f = FAR, z = d * 2 - 1;
const lin = 2 * n * f / (f + n - z * (f - n));
console.log('linearDepth(cur)', lin.toFixed(4), 'clip w cur', b.w.toFixed(4), 'pc.w(prev)', pc[3].toFixed(4), 'truth prev w', gtPrev.w.toFixed(4));
// Sky: direction only
const hs = mulV(cur.inv, [uvC[0] * 2 - 1, uvC[1] * 2 - 1, 1, 1]);
const dir = [hs[0] / hs[3], hs[1] / hs[3], hs[2] / hs[3]];
const pcs = mulV(prev.vpNJ, [dir[0], dir[1], dir[2], 0]);
const far = [dir[0] * 1e7 + cur.camPos[0], dir[1] * 1e7 + cur.camPos[1], dir[2] * 1e7 + cur.camPos[2]];
const gts = toPx(prev, far, prev.vpNJ), gtc = toPx(cur, far, cur.vpNJ);
console.log('sky motion shader', ((pcs[0] / pcs[3] * 0.5 + 0.5 - unjUV[0]) * W).toFixed(4), ((pcs[1] / pcs[3] * 0.5 + 0.5 - unjUV[1]) * H).toFixed(4), 'truth', (gts.x - gtc.x).toFixed(4), (gts.y - gtc.y).toFixed(4));
// Halton bias
for (const nph of [8, 16]) {
  let sx = 0, sy = 0;
  for (let i = 1; i <= nph; i++) { sx += halton(i, 2) - 0.5; sy += halton(i, 3) - 0.5; }
  console.log(`halton mean over ${nph}:`, (sx / nph).toFixed(4), (sy / nph).toFixed(4));
}
