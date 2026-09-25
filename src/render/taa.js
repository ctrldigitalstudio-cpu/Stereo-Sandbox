// Temporal anti-aliasing with temporal upscaling (TAAU).
//
// Every frame the renderer offsets the projection by a sub-pixel Halton(2,3) jitter (render
// pixels), so the scene, sky, clouds, light shafts, SSR and composite all sample slightly
// different points of each pixel. The resolve pass (after the composite, before bloom) runs at the
// OUTPUT resolution: it reconstructs the current frame at the output pixel centre from the 3x3
// jittered render texels around it, reprojects the output-resolution history with the camera
// motion (depth -> camera-relative position -> previous unjittered view-projection; plus the motion
// vectors the terrain writes for waving plants and leaves; sky pixels at the distance of the cloud
// layer / far-terrain plane where those cover them, else by direction), clips the history against
// the current neighbourhood and blends. When renderScale < 1 the result is a temporally upscaled
// image at the canvas resolution. See SPEC.md "Temporal anti-aliasing".

import { Program, createTexture2D, createDepthTexture, createFramebuffer, drawFullscreen, UNIT } from '../gl.js';
import { GLSL_COMMON, FULLSCREEN_VS } from './common.js';

const P0 = UNIT.PASS0;

// Camera cuts: a frame that moves the eye further than this, turns the view further than this or
// jumps the sun (setTime) starts a fresh history instead of reprojecting the old one.
const CUT_DISTANCE = 4;                              // blocks in one frame (a teleport)
const CUT_COS = Math.cos((60 * Math.PI) / 180);      // view rotation in one frame
const SUN_JUMP_COS = Math.cos((2 * Math.PI) / 180);  // sun direction change in one frame

// Accumulated history weight (in "frames of full-confidence samples"): the steady-state blend
// factor is about confidence / (MAX_WEIGHT + confidence), i.e. ~0.1 at native resolution.
// Upscaling keeps more history (up to MAX_WEIGHT_UPSCALED at renderScale 0.5): fewer frames put
// a render sample close to a given output pixel, and the confidence weighting already lowers the
// per-frame weight of the others.
const MAX_WEIGHT = 8;
const MAX_WEIGHT_UPSCALED = 12;
const MAX_WEIGHT_RGBA8 = 4;     // 8-bit history: faster blend so quantisation can't stall it
const REACTIVE_WEIGHT = 1;      // history cap around reactive pixels (particles: no motion vectors)
const W_SCALE = 32;             // aux.b = weight / W_SCALE
const DEPTH_SCALE = 2048;       // aux.rg = sqrt(linear depth / DEPTH_SCALE), 16-bit fixed point (hi, lo)

// Radical inverse in base b (Halton sequence), i >= 1.
export function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

// Jitter sequence length: 8 at native resolution; 16 when upscaling (each output pixel needs more
// frames before a render sample lands close to it).
export function jitterPhases(scale) { return scale > 0.99 ? 8 : 16; }

const RESOLVE_FS = GLSL_COMMON + `
layout(location = 0) out vec4 oHistory;   // resolved colour: next frame's history
layout(location = 1) out vec4 oAux;       // rg = dilated depth (16-bit), b = accumulated weight, a = sharpen multiplier / 2
layout(location = 2) out vec4 oColor;     // resolved colour + alpha (1 - self-emission): post chain input
uniform sampler2D uColor;      // unit 10: composite (render resolution, jittered)
uniform sampler2D uDepth;      // unit 11: scene depth (render resolution, jittered)
uniform sampler2D uHistory;    // unit 12: previous resolved colour (output resolution, linear filter)
uniform sampler2D uAux;        // unit 13: previous aux (output resolution)
uniform sampler2D uExposure;   // unit 14: auto exposure of the previous frame (1x1)
uniform sampler2D uMotion;     // unit 15: scene motion attachment (render resolution): xy = NDC motion
                               //          beyond the static-world reprojection, z = reactive
uniform float uHasMotion;      // uMotion holds this frame's motion vectors
uniform vec4 uOut;             // output size, 1 / size
uniform float uMaxWeight;      // cap of the accumulated history weight
uniform float uGamma;          // variance clipping box half-size (standard deviations)
uniform float uHistoryOk;      // the history targets hold a previous frame
uniform float uLowPrecision;   // 8-bit history: dither what is stored
uniform int uDebug;            // 1: history weight (green), rejected (magenta) / off-screen (blue); 2: raw current texel

const float W_SCALE = ${W_SCALE.toFixed(1)};
const float DEPTH_SCALE = ${DEPTH_SCALE.toFixed(1)};
const float REACTIVE_WEIGHT = ${REACTIVE_WEIGHT.toFixed(1)};

vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
float max3(vec3 c) { return max(c.r, max(c.g, c.b)); }
// Reversible tone map (Karis): the neighbourhood statistics and the clip happen in this bounded,
// roughly perceptual space, so a few very bright texels (sun, lava, torch) can't blow the box up.
vec3 compress(vec3 c) { return c / (1.0 + max3(c)); }
vec3 expand(vec3 t) { t = clamp(t, 0.0, 0.998); return t / (1.0 - max3(t)); }

vec2 packDepth(float v) { float x = v * 255.0; float hi = floor(x); return vec2(hi / 255.0, x - hi); }
float unpackDepth(vec2 p) { return (floor(p.x * 255.0 + 0.5) + p.y) / 255.0; }

// Sky pixels also hold finite-distance content: the cloud layer (volumetric or flat) and, below the
// horizon, the flat far-terrain plane of voidColor(). Returns its distance along dir and in w how
// much of the pixel it covers (0: nothing finite, reproject by direction only).
float skyDistance(vec3 dir, out float w) {
  w = 0.0;
  float mid = 0.5 * (CLOUD_BOTTOM + CLOUD_TOP);
  float hc = mid - uCamPos.y;
  // Cloud layer, where it has cover (seen from below or above; not from inside it).
  if (uEnv.z > 0.0 && abs(hc) > 0.5 * (CLOUD_TOP - CLOUD_BOTTOM) && hc * dir.y > 0.0) {
    float t = hc / dir.y;
    if (t < 3600.0) {
      vec2 p = uCamPos.xz + dir.xz * t + uWind.xy * uCamPos.w;
      float n = textureLod(uNoise2D, p / 3072.0, 0.0).r * 0.65 + textureLod(uNoise2D, p / 1100.0 + 0.37, 0.0).g * 0.35;
      w = saturate(smoothstep(1.0 - uEnv.z, 1.0 - uEnv.z + 0.35, n) * 4.0);
      if (w > 0.0) return t;
    }
  }
  // Far-terrain plane (same height as voidColor uses).
  if (dir.y < 0.0) {
    vec4 e;
    float landY;
    if (!edgeSummary(dir, e, landY)) { e = vec4(0.0, 0.0, 0.0, 1.0); landY = SEA_LEVEL; }
    float h = uCamPos.y - mix(landY, SEA_LEVEL + 0.9, e.a);
    if (h >= 0.5) { w = 1.0; return min(h / max(-dir.y, 1e-4), 1e5); }
  }
  return 0.0;
}

// 5-tap Catmull-Rom (bicubic with the four corner taps dropped, renormalised).
vec3 sampleHistory(vec2 uv) {
  vec2 pos = uv * uOut.xy;
  vec2 t1 = floor(pos - 0.5) + 0.5;
  vec2 f = pos - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t12 = (t1 + w2 / w12) * uOut.zw;
  vec2 t0 = (t1 - 1.0) * uOut.zw;
  vec2 t3 = (t1 + 2.0) * uOut.zw;
  float a = w12.x * w0.y, b = w0.x * w12.y, c = w12.x * w12.y, d = w3.x * w12.y, e = w12.x * w3.y;
  vec3 s = textureLod(uHistory, vec2(t12.x, t0.y), 0.0).rgb * a
         + textureLod(uHistory, vec2(t0.x, t12.y), 0.0).rgb * b
         + textureLod(uHistory, t12, 0.0).rgb * c
         + textureLod(uHistory, vec2(t3.x, t12.y), 0.0).rgb * d
         + textureLod(uHistory, vec2(t12.x, t3.y), 0.0).rgb * e;
  return max(s / (a + b + c + d + e), vec3(0.0));
}

void main() {
  vec2 uvOut = gl_FragCoord.xy * uOut.zw;          // output pixel centre (unjittered screen uv)
  vec2 pj = uvOut * uRes.xy + uTAA.xy;             // the same point in the jittered render image (render px)
  ivec2 c = ivec2(floor(pj));
  ivec2 rmax = ivec2(uRes.xy) - 1;
  float outPerRender = uOut.x * uRes.z;            // output pixels per render pixel (1 native, 2 at scale 0.5)
  vec4 et = texelFetch(uExposure, ivec2(0), 0);
  float ex = exp2(((floor(et.r * 255.0 + 0.5) + et.g) / 255.0) * 10.0 - 5.0);
  if (isnan(ex) || isinf(ex) || ex <= 0.0) ex = 1.0;

  // ---- Current frame: 3x3 render texels around the output pixel -------------------------------
  // Two reconstructions: a narrow Blackman-Harris-like kernel in OUTPUT pixels (sharp, the one
  // accumulated over time: frames whose samples fall far from this pixel get little weight) and a
  // wide one in RENDER pixels (smooth upscale, used alone when there is no usable history).
  vec3 sumN = vec3(0.0), sumW = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0);
  float wN = 0.0, wW = 0.0, aN = 0.0, aW = 0.0, kN = 0.0, kW = 0.0, conf = 0.0;
  float closest = 1.0, react = 0.0;
  ivec2 cp = clamp(c, ivec2(0), rmax);
  float linMin = 1e9, linMax = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 q = clamp(c + ivec2(x, y), ivec2(0), rmax);
      vec4 s = texelFetch(uColor, q, 0);
      vec3 col = s.rgb;
      if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
      col = max(col, vec3(0.0));
      float d = texelFetch(uDepth, q, 0).r;
      if (d < closest) { closest = d; cp = q; }
      if (uHasMotion > 0.5) react = max(react, texelFetch(uMotion, q, 0).z);
      if (d < 1.0) { float l = linearDepth(d); linMin = min(linMin, l); linMax = max(linMax, l); }
      vec2 off = vec2(q) + 0.5 - pj;
      float d2 = dot(off, off);
      float kn = exp(-2.29 * d2 * outPerRender * outPerRender);
      float kw = exp(-2.29 * d2);
      // Luminance weighting (1 / (1 + luma)): a lone bright texel can't flash the whole pixel.
      float kl = 1.0 / (1.0 + luminance(col * ex));
      sumN += col * (kn * kl); wN += kn * kl; aN += s.a * kn; kN += kn;
      sumW += col * (kw * kl); wW += kw * kl; aW += s.a * kw; kW += kw;
      conf = max(conf, kn);
      vec3 t = toYCoCg(compress(col * ex));
      m1 += t;
      m2 += t * t;
    }
  }

  // ---- Reprojection --------------------------------------------------------------------------
  // Motion of the front-most surface in the neighbourhood (depth dilation keeps edges attached to
  // the foreground). Geometry: camera-relative position + camera translation, projected with the
  // previous unjittered view-projection, plus the motion vector the scene pass wrote for it (waving
  // plants and leaves; 0 for the static world). Sky: by direction (infinitely far), or at the
  // distance of the clouds / far-terrain plane where they cover it.
  bool sky = closest >= 1.0;
  vec2 uvC = (vec2(cp) + 0.5) * uRes.zw;          // jittered uv of that texel
  vec3 pos = positionFromDepth(uvC, closest);
  vec2 prevUV;
  float prevDepth = 0.0;                          // previous view depth of the surface (geometry)
  bool inFront;
  if (sky) {
    vec3 dir = normalize(pos);
    vec4 pi = uPrevViewProj * vec4(dir, 0.0);
    prevUV = pi.xy / max(pi.w, 1e-6) * 0.5 + 0.5;
    inFront = pi.w > 1e-4;
    float cw;
    float t = skyDistance(dir, cw);
    if (cw > 0.0) {
      vec4 pf = uPrevViewProj * vec4(dir * t + uCamDelta.xyz, 1.0);
      if (pf.w > 1e-4) prevUV = mix(prevUV, pf.xy / pf.w * 0.5 + 0.5, cw);
    }
  } else {
    vec4 pc = uPrevViewProj * vec4(pos + uCamDelta.xyz, 1.0);
    prevUV = pc.xy / max(pc.w, 1e-6) * 0.5 + 0.5;
    prevDepth = pc.w;
    inFront = pc.w > 1e-4;
  }
  if (uHasMotion > 0.5) prevUV += texelFetch(uMotion, cp, 0).xy * 0.5;
  vec2 histUV = uvOut + (prevUV - (uvC - uTAA.xy * uRes.zw));
  float lin = sky ? 0.0 : linearDepth(closest);
  float speed = length((histUV - uvOut) * uOut.xy);   // output pixels per frame
  // History magnification: a surface that came closer (moving toward it) covers more pixels now
  // than it did in the history, which holds less detail than this frame needs.
  float mag = sky ? 1.0 : saturate(lin / max(prevDepth, 1e-4));

  float Wh = 0.0, sharp = 0.0, trust = 0.0;
  vec3 hist = vec3(0.0);
  bool onScreen = inFront && histUV.x >= 0.0 && histUV.y >= 0.0 && histUV.x <= 1.0 && histUV.y <= 1.0;
  if (uTAA.w > 0.5 && uHistoryOk > 0.5 && onScreen) {
    // Disocclusion: the history there must have seen the same surface. Compare its stored
    // (dilated) depth with where this surface was last frame, over the 2x2 bilinear footprint.
    vec2 hp = histUV * uOut.xy - 0.5;
    ivec2 h0 = ivec2(floor(hp));
    ivec2 omax = ivec2(uOut.xy) - 1;
    float expected = prevDepth;
    float best = 1e9, bestW = 0.0;
    for (int k = 0; k < 4; k++) {
      ivec2 q = clamp(h0 + ivec2(k & 1, k >> 1), ivec2(0), omax);
      vec4 a = texelFetch(uAux, q, 0);
      float v = unpackDepth(a.rg);
      bool hsky = v > 0.999;
      float diff = sky ? (hsky ? 0.0 : 1e9) : (hsky ? 1e9 : abs(v * v * DEPTH_SCALE - expected));
      if (diff < best) { best = diff; bestW = a.b * W_SCALE; }
    }
    // Tolerance: a few percent, plus the depth spread of the neighbourhood (slanted surfaces).
    float tol = sky ? 0.5 : 0.04 * expected + 0.05 + (linMax - linMin);
    if (best <= tol) {
      Wh = bestW;
      hist = sampleHistory(histUV);
    }
  }

  // ---- Neighbourhood clip + blend --------------------------------------------------------------
  vec3 cur, res;
  float alpha, Wn;
  if (Wh > 0.0) {
    // Variance clipping in YCoCg (of the compressed, exposed colour) on the current 3x3.
    vec3 mu = m1 * (1.0 / 9.0);
    vec3 sigma = sqrt(max(m2 * (1.0 / 9.0) - mu * mu, 0.0));
    vec3 th = toYCoCg(compress(hist * ex));
    // Reactive pixels (particles, no motion vectors): a tighter box.
    vec3 extent = mix(uGamma, 0.75, react) * sigma + vec3(0.0005, 0.0003, 0.0003);
    vec3 dv = th - mu;
    float outside = max3(abs(dv) / extent);
    if (outside > 1.0) th = mu + dv / outside;
    hist = expand(fromYCoCg(th)) / ex;
    // History far outside the neighbourhood (lighting change, a disocclusion the depth test
    // missed, animation without motion vectors): trust it less so the new state takes over
    // within a few frames.
    Wh *= min(2.0 / outside, 1.0);
    // Magnified history (see mag) has less detail than this frame: keep much less of it.
    float m2 = mag * mag;
    Wh *= m2 * m2;
    // Moving camera: the history is resampled every frame, which softens it; keep fewer frames.
    Wh = min(Wh, uMaxWeight * mix(1.0, 0.3, saturate(speed / 5.0)));
    // Around particles keep only a frame or so.
    Wh = min(Wh, mix(uMaxWeight, REACTIVE_WEIGHT, react));
    // Sharp (output-pixel) reconstruction where there is history to refine; the smooth one where
    // there is little or it had to be clipped (identical at native resolution). With the sharp
    // one only the output pixels that have a jittered sample close by this frame are refreshed,
    // which on a changing image (animation, a disocclusion the depth test missed) leaves a
    // checkerboard of updated / stale pixels when upscaling; the smooth one refreshes them evenly.
    trust = saturate(Wh * 0.5) * (1.0 - saturate(outside - 1.0)) * (1.0 - react);
    // Upscaling in fast motion: the capped history holds only a few frames, too few for the
    // narrow kernel's sparse samples (at renderScale 0.5 an output pixel gets a close sample about
    // every 4th frame) to average out, which prints dotted edges; the wide kernel is steady (the
    // sharpen pass gives moving pixels more contrast back).
    sharp = trust * (1.0 - saturate(speed / 6.0) * saturate(outPerRender - 1.0));
    cur = mix(sumW / max(wW, 1e-6), sumN / max(wN, 1e-6), sharp);
    alpha = mix(aW / max(kW, 1e-6), aN / max(kN, 1e-6), sharp);
    // Current-frame weight = reconstruction confidence (how close the nearest jittered sample is),
    // both weighted by 1 / (1 + luma) against fireflies.
    float wc = mix(1.0, conf, sharp);
    float ac = wc / (1.0 + luminance(cur * ex));
    float ah = Wh / (1.0 + luminance(hist * ex));
    res = (cur * ac + hist * ah) / max(ac + ah, 1e-6);
    Wn = min(Wh + wc * mix(1.0, 0.5, 1.0 - sharp), uMaxWeight);
  } else {
    // No usable history (first frame, camera cut, disocclusion, off-screen): current frame only.
    // When upscaling it is the smooth reconstruction everywhere, worth about half a frame (conf
    // would vary pixel to pixel with the jitter and print the sample grid into the next frames).
    cur = sumW / max(wW, 1e-6);
    alpha = aW / max(kW, 1e-6);
    res = cur;
    Wn = mix(conf, 0.5, saturate(outPerRender - 1.0));
  }
  // Sharpen multiplier for the final RCAS pass: less on a fresh current-frame reconstruction
  // (aliased at native, a soft upscale otherwise: sharpening would only amplify its artefacts),
  // more on accumulated history that is being resampled every frame by camera motion.
  float sharpMul = mix(0.6, 1.0 + 0.6 * saturate(speed * 0.5), trust);
  if (any(isnan(res)) || any(isinf(res))) res = vec3(0.0);
  if (uLowPrecision > 0.5) res = max(res + (ignFrame(gl_FragCoord.xy) - 0.5) / 255.0, vec3(0.0));

  oHistory = vec4(res, 1.0);
  oAux = vec4(packDepth(sky ? 1.0 : min(sqrt(lin / DEPTH_SCALE), 0.998)), Wn / W_SCALE, sharpMul * 0.5);
  oColor = vec4(res, saturate(alpha));
  if (uDebug == 2) oColor = vec4(texelFetch(uColor, clamp(ivec2(gl_FragCoord.xy), ivec2(0), rmax), 0).rgb, 1.0);
  if (uDebug == 1) oColor = vec4(Wh > 0.0 ? vec3(0.0, Wh / uMaxWeight, 0.0) : vec3(onScreen ? 1.0 : 0.0, 0.0, 1.0), 1.0) * 0.25 / ex;
}
`;

export class TemporalAA {
  constructor(gl, hdrFormat = gl.hdrFormat) {
    this.gl = gl;
    this.hdr = hdrFormat;
    this.lowPrecision = hdrFormat.type === gl.UNSIGNED_BYTE;
    this.program = new Program(gl, FULLSCREEN_VS, RESOLVE_FS, 'taa-resolve');
    this.program.samplers({ uColor: P0, uDepth: P0 + 1, uHistory: P0 + 2, uAux: P0 + 3, uExposure: P0 + 4, uMotion: P0 + 5 });
    gl.useProgram(null);
    this.width = 0;
    this.height = 0;
    this.targets = null;
    this.index = 0;            // history[index] = last frame's result
    this.historyOk = false;    // history targets hold a frame
    this.gamma = 1.25;
    this.frame = 0;
    this.prev = null;          // previous frame's camera: { camPos, viewProj, fwd, sun }
    this.jitter = [0, 0];
    this._prevVP = new Float32Array(16);
    this.valid = false;
    this.cuts = 0;             // camera cuts detected (stats / tests)
    this.debug = 0;            // 1: visualise the history weight (see RESOLVE_FS)
  }

  // Output-resolution targets. A new size starts a fresh history.
  resize(w, h) {
    if (this.targets && w === this.width && h === this.height) return;
    const gl = this.gl;
    this._deleteTargets();
    this.width = w;
    this.height = h;
    // All three resolve outputs share the HDR format (some implementations dislike mixed formats
    // in one framebuffer); the aux packing below is exact in both RGBA16F and RGBA8.
    const history = [0, 1].map(() => createTexture2D(gl, w, h, { ...this.hdr, filter: gl.LINEAR }));
    const aux = [0, 1].map(() => createTexture2D(gl, w, h, { ...this.hdr, filter: gl.NEAREST }));
    const outTex = createTexture2D(gl, w, h, { ...this.hdr, filter: gl.LINEAR });
    // Held-item depth: a texture, so the sharpen pass can leave the held item alone.
    const outDepth = createDepthTexture(gl, w, h);
    const fb = [0, 1].map((i) => createFramebuffer(gl, [history[i], aux[i], outTex]));
    const heldFB = createFramebuffer(gl, [outTex], outDepth);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.targets = { history, aux, outTex, outDepth, fb, heldFB };
    this.historyOk = false;
  }

  _deleteTargets() {
    const t = this.targets;
    if (!t) return;
    const gl = this.gl;
    for (const tex of [...t.history, ...t.aux, t.outTex, t.outDepth]) gl.deleteTexture(tex);
    for (const f of [...t.fb, t.heldFB]) gl.deleteFramebuffer(f);
    this.targets = null;
    this.historyOk = false;
  }

  // TAA switched off: free the targets and forget the camera.
  release() {
    this._deleteTargets();
    this.width = this.height = 0;
    this.reset();
  }

  // Next frame starts a fresh history.
  reset() {
    this.historyOk = false;
    this.prev = null;
  }

  // Once per frame, before the Frame UBO is written. viewProj: this frame's UNJITTERED
  // view-projection (camera-relative). Returns the jitter (render pixels) and what the resolve
  // needs to reproject; `valid` is false when the history must not be used (first frame, cut).
  begin({ camPos, fwd, sunDir, viewProj, scale }) {
    const n = jitterPhases(scale);
    this.frame++;
    const i = (this.frame % n) + 1;
    this.jitter[0] = halton(i, 2) - 0.5;
    this.jitter[1] = halton(i, 3) - 0.5;
    const p = this.prev;
    let valid = this.historyOk && !!p;
    const delta = [0, 0, 0];
    if (p) {
      delta[0] = camPos[0] - p.camPos[0];
      delta[1] = camPos[1] - p.camPos[1];
      delta[2] = camPos[2] - p.camPos[2];
      const moved = Math.hypot(delta[0], delta[1], delta[2]);
      const turn = fwd[0] * p.fwd[0] + fwd[1] * p.fwd[1] + fwd[2] * p.fwd[2];
      const sun = sunDir ? sunDir[0] * p.sun[0] + sunDir[1] * p.sun[1] + sunDir[2] * p.sun[2] : 1;
      if (valid && (moved > CUT_DISTANCE || turn < CUT_COS || sun < SUN_JUMP_COS || !Number.isFinite(moved))) {
        valid = false;
        this.cuts++;
      }
    }
    if (!valid) delta[0] = delta[1] = delta[2] = 0;
    // Copy before the previous camera is overwritten with this frame's.
    this._prevVP.set(valid ? p.viewProj : viewProj);
    const q = this.prev || (this.prev = { camPos: [0, 0, 0], fwd: [0, 0, -1], sun: [0, 1, 0], viewProj: new Float32Array(16) });
    for (let k = 0; k < 3; k++) {
      q.camPos[k] = camPos[k];
      q.fwd[k] = fwd[k];
      q.sun[k] = sunDir ? sunDir[k] : k === 1 ? 1 : 0;
    }
    q.viewProj.set(viewProj);
    this.valid = valid;
    return { jitter: this.jitter, prevViewProj: this._prevVP, camDelta: delta, valid };
  }

  // Resolve into the next history slot and the output colour target. colorTex / depthTex: this
  // frame's composite and scene depth (render resolution); exposureTex: last frame's exposure;
  // motionTex: the scene's motion attachment (null: static world, no reactive pixels).
  resolve(colorTex, depthTex, exposureTex, scale = 1, motionTex = null) {
    const gl = this.gl;
    const t = this.targets;
    if (!t) return false;
    const next = 1 - this.index;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb[next]);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const bind = (u, tex) => { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, tex); };
    bind(P0, colorTex);
    bind(P0 + 1, depthTex);
    bind(P0 + 2, t.history[this.index]);
    bind(P0 + 3, t.aux[this.index]);
    bind(P0 + 4, exposureTex);
    bind(P0 + 5, motionTex || colorTex);   // (never sampled without motion; any 2D texture keeps the unit valid)
    const p = this.program.use();
    gl.uniform4f(p.u('uOut'), this.width, this.height, 1 / this.width, 1 / this.height);
    const up = Math.min(Math.max((1 - scale) / 0.5, 0), 1);
    const maxW = this.lowPrecision ? MAX_WEIGHT_RGBA8 : MAX_WEIGHT + (MAX_WEIGHT_UPSCALED - MAX_WEIGHT) * up;
    gl.uniform1f(p.u('uMaxWeight'), maxW);
    gl.uniform1f(p.u('uGamma'), this.gamma);
    gl.uniform1f(p.u('uHistoryOk'), this.historyOk ? 1 : 0);
    gl.uniform1f(p.u('uLowPrecision'), this.lowPrecision ? 1 : 0);
    gl.uniform1i(p.u('uDebug'), this.debug | 0);
    gl.uniform1f(p.u('uHasMotion'), motionTex ? 1 : 0);
    drawFullscreen(gl);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    // The history textures are inputs next frame (and the motion texture a scene target): unbind
    // them from the pass units now.
    bind(P0 + 2, null);
    bind(P0 + 3, null);
    bind(P0 + 5, null);
    this.index = next;
    this.historyOk = true;
    return true;
  }

  get outputTexture() { return this.targets ? this.targets.outTex : null; }
  // This frame's aux (after resolve()): a = sharpen multiplier / 2 for the final pass.
  get auxTexture() { return this.targets ? this.targets.aux[this.index] : null; }
  // Depth of the held item drawn over the output (1 where there is none).
  get heldDepthTexture() { return this.targets ? this.targets.outDepth : null; }

  // Bind the output colour target with its own depth cleared (for the held item).
  beginHeld() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.heldFB);
    gl.viewport(0, 0, this.width, this.height);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  dispose() {
    this._deleteTargets();
    this.gl.deleteProgram(this.program.program);
  }
}
