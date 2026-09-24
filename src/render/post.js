// Post-processing chain: half-res volumetric light + volumetric clouds, composite into the HDR
// target, bloom, auto exposure, tone mapping and FXAA to the canvas. Every pass leaves the GL
// state clean (depth test on, depth write on, blend off, back-face culling) and sets its own viewport.

import { Program, createTexture2D, createFramebuffer, createDepthRenderbuffer, drawFullscreen, UNIT } from '../gl.js';
import { GLSL_COMMON, FULLSCREEN_VS } from './common.js';

export const BLOOM_LEVELS = 6;
const P0 = UNIT.PASS0;

// ---------------------------------------------------------------------------------------------
// Half-res pass: out0 = volumetric in-scatter (rgb) + linear depth / far (a),
//                out1 = clouds: in-scattered radiance (rgb) + transmittance (a).
// ---------------------------------------------------------------------------------------------
const HALF_FS = GLSL_COMMON + `
in vec2 vUV;
layout(location = 0) out vec4 oVol;
layout(location = 1) out vec4 oCloud;
uniform sampler2D uDepth;        // unit 10: full-res scene depth
uniform float uVolStrength;
const float CLOUD_MAX_DIST = 3600.0;

// ---- Volumetric light ----------------------------------------------------------------------
float shadowTap(vec3 posRel) {
  vec4 c = uShadowMat * vec4(posRel, 1.0);
  if (max(abs(c.x), abs(c.y)) > 0.995) return 1.0;
  vec3 sc = shadowCoord(posRel);
  return texture(uShadowCmp, vec3(sc.xy, min(sc.z, 1.0) - 0.0008));
}

vec3 volumetricLight(vec3 dir, float sceneDist) {
  int n = int(uQuality.y + 0.5);
  if (n <= 0 || uLightDir.y < -0.02) return vec3(0.0);
  bool water = uEnv.x > 0.5;
  bool shadows = uShadow.x > 0.5;
  float maxDist = water ? 40.0 : (shadows ? max(uShadow.y * 0.95, 48.0) : 96.0);
  float tEnd = min(sceneDist, maxDist);
  float stepLen = tEnd / float(n);
  float jit = ignFrame(gl_FragCoord.xy);
  vec3 L = uLightDir.xyz;
  float mu = dot(dir, L);
  float fogMul = uWind.w;
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    float t = (float(i) + jit) * stepLen;
    vec3 p = dir * t;
    vec3 wp = p + uCamPos.xyz;
    float vis = shadows ? shadowTap(p) : 1.0;
    float dens;
    vec3 tint = vec3(1.0);
    if (water) {
      // Light shafts below the waves: the refracted surface pattern, absorbed on its way down.
      float depth = max(SEA_LEVEL - wp.y, 0.0);
      vec2 sp = wp.xz + L.xz / max(L.y, 0.2) * depth;
      float shaft = textureLod(uNoise2D, sp * 0.045 + uCamPos.w * vec2(0.011, 0.007), 0.0).a;
      vis *= 0.25 + 1.5 * shaft * shaft;
      tint = exp(-vec3(0.34, 0.075, 0.05) * (depth / max(L.y, 0.2)));
      dens = 0.028;
    } else {
      // Height fog: dense in the valleys, thinning with altitude, never quite zero.
      dens = 0.0011 * fogMul * (exp(-max(wp.y - SEA_LEVEL, 0.0) / 34.0) * 0.85 + 0.15);
    }
    vis *= cloudShadow(wp);
    acc += tint * (trans * dens * vis * stepLen);
    trans *= exp(-dens * stepLen);
  }
  float phase;
  if (water) phase = mix(henyeyGreenstein(mu, 0.8), 1.0 / (4.0 * PI), 0.25) * 4.0 * PI;
  else phase = mix(henyeyGreenstein(mu, 0.65), 1.0 / (4.0 * PI), 0.3) * 4.0 * PI;
  vec3 col = acc * phase * lightColor();
  if (water) col *= vec3(0.3, 0.8, 0.95);
  // Eye sky light keeps caves from glowing where the shadow map can't see.
  return col * uVolStrength * smoothstep(0.05, 0.5, uCam.w);
}

// ---- Volumetric clouds ---------------------------------------------------------------------
// Same coverage as cloudCoverage() in common.js but at mip 0: implicit derivatives are undefined
// inside the divergent march loop.
float coverageLod(vec2 xz) {
  vec2 p = xz + uWind.xy * uCamPos.w;
  float nz = textureLod(uNoise2D, p / 3072.0, 0.0).r * 0.65 + textureLod(uNoise2D, p / 1100.0 + 0.37, 0.0).g * 0.35;
  float c = uEnv.z;
  return smoothstep(1.0 - c, 1.0 - c + 0.35, nz);
}

float cloudDensity(vec3 p, float detail) {
  float h = (p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  float cov = coverageLod(p.xz);
  if (cov <= 0.01) return 0.0;
  // Flat-ish bases, towers that grow taller where coverage is high.
  float top = 0.3 + 0.7 * cov;
  float prof = smoothstep(0.0, 0.14, h) * (1.0 - smoothstep(top * 0.55, top, h));
  float base = cov * prof;
  if (base <= 0.02) return 0.0;
  vec3 q = p + vec3(uWind.x, 0.0, uWind.y) * (uCamPos.w * 1.15);
  float n = textureLod(uNoise3D, q / 150.0, 0.0).r;
  if (detail > 0.0) n = mix(n, n * 0.68 + textureLod(uNoise3D, q / 47.0 + 0.31, 0.0).r * 0.32, detail);
  // Erode the edges with the billowy noise (less erosion in the dense cores).
  float d = base * 1.35 - (1.0 - n) * (0.62 - 0.25 * base);
  return clamp(d, 0.0, 1.0);
}

vec4 volumetricClouds(vec3 dir, float sceneDist) {
  int n = int(uQuality.z + 0.5);
  if (n <= 0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 ro = uCamPos.xyz;
  float t0, t1;
  if (abs(dir.y) < 1e-4) {
    if (ro.y < CLOUD_BOTTOM || ro.y > CLOUD_TOP) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = 0.0; t1 = CLOUD_MAX_DIST;
  } else {
    float ta = (CLOUD_BOTTOM - ro.y) / dir.y, tb = (CLOUD_TOP - ro.y) / dir.y;
    t0 = max(min(ta, tb), 0.0);
    t1 = max(ta, tb);
  }
  t1 = min(t1, min(sceneDist, CLOUD_MAX_DIST));
  // Grazing rays (and rays inside the layer): the far part is fogged out anyway.
  t1 = min(t1, t0 + (t0 > 0.0 ? 900.0 : 520.0));
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);

  float stepLen = (t1 - t0) / float(n);
  float jit = ign(gl_FragCoord.xy + 0.37);
  vec3 L = uLightDir.xyz;
  float mu = dot(dir, L);
  // Dual-lobe phase: a strong forward lobe for silver linings plus some back scatter.
  float phase = mix(henyeyGreenstein(mu, 0.72), henyeyGreenstein(mu, -0.2), 0.32) * 4.0 * PI;
  vec3 sun = lightColor();
  vec3 skyAmb = skyIrradiance();
  vec3 groundAmb = groundIrradiance();
  float lightUp = smoothstep(-0.05, 0.1, L.y);
  float powderMix = 0.55 * saturate(0.6 - 0.4 * mu);
  // Detail erosion only where the steps are short enough to resolve it (otherwise it aliases into grain).
  float detail = 1.0 - smoothstep(10.0, 30.0, stepLen);

  vec3 col = vec3(0.0);
  float trans = 1.0;
  float dSum = 0.0, wSum = 0.0;
  for (int i = 0; i < 48; i++) {
    if (i >= n) break;
    float t = t0 + (float(i) + jit) * stepLen;
    vec3 p = ro + dir * t;
    float d = cloudDensity(p, detail);
    if (d <= 0.0) continue;
    float sigma = d * 0.13;
    // Two light samples toward the light for self shadowing.
    float od = cloudDensity(p + L * 7.0, 0.0) * 14.0 + cloudDensity(p + L * 26.0, 0.0) * 24.0;
    od *= 0.13;
    // Beer + a multiple-scattering floor, darkened on the lit side by the powder term.
    float beer = max(exp(-od), exp(-od * 0.22) * 0.38);
    float powder = 1.0 - exp(-sigma * 22.0);
    float direct = beer * mix(1.0, powder, powderMix) * lightUp;
    float h = (p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
    vec3 amb = skyAmb * mix(0.42, 0.95, h) + groundAmb * (0.35 * (1.0 - h));
    vec3 S = sun * (direct * phase) + amb;
    float a = 1.0 - exp(-sigma * stepLen);
    col += trans * S * a;
    dSum += trans * a * t;
    wSum += trans * a;
    trans *= 1.0 - a;
    if (trans < 0.015) break;
  }
  if (wSum <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  // Aerial perspective: distant clouds dissolve into the sky haze behind them.
  float dist = dSum / wSum;
  float fade = exp(-max(dist - 700.0, 0.0) / 1500.0);
  if (ro.y < CLOUD_BOTTOM) fade *= smoothstep(0.0, 0.06, dir.y);
  trans = mix(1.0, trans, fade);
  return vec4(col * fade, trans);
}

void main() {
  ivec2 fp = min(ivec2(gl_FragCoord.xy) * 2, ivec2(uRes.xy) - 1);
  float depth = texelFetch(uDepth, fp, 0).r;
  vec2 uv = (vec2(fp) + 0.5) * uRes.zw;
  vec3 posRel = positionFromDepth(uv, depth);
  float dist = length(posRel);
  vec3 dir = posRel / max(dist, 1e-4);
  bool sky = depth >= 1.0;
  oVol = vec4(volumetricLight(dir, sky ? 1e6 : dist), linearDepth(depth) / uCam.y);
  oCloud = volumetricClouds(dir, sky ? 1e9 : dist);
}
`;

// 3x3 depth-aware box filter of the half-res buffers: IGN spreads its dither values evenly over
// every 3x3 neighbourhood, so this turns the per-pixel ray-march jitter into smooth gradients.
const DENOISE_FS = GLSL_COMMON + `
layout(location = 0) out vec4 oVol;
layout(location = 1) out vec4 oCloud;
uniform sampler2D uVol;      // unit 10
uniform sampler2D uCloud;    // unit 11
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hmax = textureSize(uVol, 0) - 1;
  float z0 = texelFetch(uVol, p, 0).a;
  vec3 vs = vec3(0.0);
  vec4 cs = vec4(0.0);
  float ws = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 q = clamp(p + ivec2(x, y), ivec2(0), hmax);
      vec4 v = texelFetch(uVol, q, 0);
      float w = exp(-abs(v.a - z0) / max(z0, 1e-4) * 30.0);
      vs += v.rgb * w;
      cs += texelFetch(uCloud, q, 0) * w;
      ws += w;
    }
  }
  oVol = vec4(vs / ws, z0);
  oCloud = cs / ws;
}
`;

// ---------------------------------------------------------------------------------------------
// Composite: scene + depth-aware upsampled volumetrics and clouds (or a cheap 2D cloud layer),
// underwater absorption and wobble.
// ---------------------------------------------------------------------------------------------
const COMPOSITE_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform sampler2D uScene;   // unit 10
uniform sampler2D uDepth;   // unit 11
uniform sampler2D uVol;     // unit 12 (half res)
uniform sampler2D uCloud;   // unit 13 (half res)
uniform float uHalfOn;      // half-res pass ran this frame
uniform float uFlatClouds;  // cheap 2D cloud layer when volumetric clouds are off
uniform vec2 uHalfSize;

vec4 flatClouds(vec3 dir) {
  if (dir.y <= 0.015 || uCamPos.y > CLOUD_BOTTOM) return vec4(0.0);
  float mid = 0.5 * (CLOUD_BOTTOM + CLOUD_TOP);
  float t = (mid - uCamPos.y) / dir.y;
  vec3 p = uCamPos.xyz + dir * t;
  float cov = cloudCoverage(p.xz);
  vec2 q = p.xz + uWind.xy * uCamPos.w * 1.15;
  float detail = texture(uNoise2D, q / 260.0).a * 0.6 + texture(uNoise2D, q / 90.0 + 0.3).b * 0.4;
  float a = saturate(cov * 1.25 - (1.0 - detail) * 0.45);
  float fade = exp(-max(t - 600.0, 0.0) / 1600.0) * smoothstep(0.015, 0.1, dir.y);
  float mu = dot(dir, uLightDir.xyz);
  float phase = mix(henyeyGreenstein(mu, 0.6), 1.0 / (4.0 * PI), 0.5) * 4.0 * PI;
  vec3 c = lightColor() * (0.5 * phase * (1.0 - 0.45 * a)) * smoothstep(-0.05, 0.1, uLightDir.y) + skyIrradiance() * 0.85;
  return vec4(c, a * fade);
}

void main() {
  vec2 uv = vUV;
  bool water = uEnv.x > 0.5;
  if (water) {
    // Gentle refraction wobble through the water between the eye and the scene.
    float t = uCamPos.w;
    uv += vec2(sin(uv.y * 22.0 + t * 1.9), cos(uv.x * 18.0 + t * 1.6)) * 0.0022;
  }
  vec3 c = texture(uScene, uv).rgb;
  // Sanitize: a NaN/Inf here would spread through bloom and poison auto exposure.
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = max(c, vec3(0.0));
  float depth = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
  bool sky = depth >= 1.0;
  float lin = linearDepth(depth) / uCam.y;

  if (uHalfOn > 0.5) {
    // Depth-aware bilinear upsample of the half-res buffers.
    vec2 hp = (gl_FragCoord.xy - 0.5) * 0.5;
    vec2 base = floor(hp);
    vec2 f = hp - base;
    ivec2 i0 = ivec2(base);
    ivec2 hmax = ivec2(uHalfSize) - 1;
    vec3 vol = vec3(0.0);
    vec4 cloud = vec4(0.0);
    float wsum = 0.0;
    float bestW = -1.0;
    vec3 bestVol = vec3(0.0);
    vec4 bestCloud = vec4(0.0, 0.0, 0.0, 1.0);
    for (int k = 0; k < 4; k++) {
      ivec2 off = ivec2(k & 1, k >> 1);
      ivec2 ic = clamp(i0 + off, ivec2(0), hmax);
      vec4 v = texelFetch(uVol, ic, 0);
      vec4 cl = texelFetch(uCloud, ic, 0);
      float bil = (off.x == 1 ? f.x : 1.0 - f.x) * (off.y == 1 ? f.y : 1.0 - f.y);
      float dz = abs(v.a - lin) / max(lin, 1e-4);
      float w = bil * exp(-dz * 25.0) + 1e-6 * bil;
      vol += v.rgb * w;
      cloud += cl * w;
      wsum += w;
      float closeness = 1.0 / (dz + 1e-4);
      if (closeness > bestW) { bestW = closeness; bestVol = v.rgb; bestCloud = cl; }
    }
    if (wsum > 1e-4) { vol /= wsum; cloud /= wsum; }
    else { vol = bestVol; cloud = bestCloud; }
    c = c * cloud.a + cloud.rgb;
    c += vol;
  }

  vec3 posRel = positionFromDepth(vUV, depth);
  vec3 dir = normalize(posRel);
  if (uFlatClouds > 0.5) {
    // Evaluated for every pixel (uniform control flow keeps the noise mip selection defined at
    // silhouettes), applied to sky pixels only.
    vec4 fc = flatClouds(dir);
    if (sky && !water) c = mix(c, fc.rgb, fc.a);
  }

  if (water) {
    // Underwater: red is absorbed first, then green; in-scatter toward a deep blue-green.
    float dist = sky ? 96.0 : length(posRel);
    vec3 tr = exp(-vec3(0.26, 0.068, 0.052) * dist);
    vec3 lit = lightColor() * max(uLightDir.y, 0.0) * 0.35 + skyIrradiance() * 0.55;
    vec3 inscatter = lit * vec3(0.035, 0.16, 0.2) * max(uCam.w, 0.06);
    c = c * tr + inscatter * (1.0 - exp(-0.085 * dist));
  }
  o = vec4(c, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Bloom: 13-tap downsample (Karis average on the first level), 9-tap tent upsample (additive).
// ---------------------------------------------------------------------------------------------
const DOWN_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform sampler2D uSrc;      // unit 10
uniform vec2 uSrcTexel;      // 1 / source size
uniform float uKaris;
vec3 tap(vec2 off) { return texture(uSrc, vUV + off * uSrcTexel).rgb; }
float karisW(vec3 c) { return 1.0 / (1.0 + luminance(c)); }
void main() {
  vec3 a = tap(vec2(-2.0, -2.0)), b = tap(vec2(0.0, -2.0)), c = tap(vec2(2.0, -2.0));
  vec3 d = tap(vec2(-1.0, -1.0)), e = tap(vec2(1.0, -1.0));
  vec3 f = tap(vec2(-2.0, 0.0)), g = tap(vec2(0.0, 0.0)), h = tap(vec2(2.0, 0.0));
  vec3 i = tap(vec2(-1.0, 1.0)), j = tap(vec2(1.0, 1.0));
  vec3 k = tap(vec2(-2.0, 2.0)), l = tap(vec2(0.0, 2.0)), m = tap(vec2(2.0, 2.0));
  vec3 g0 = (d + e + i + j) * 0.25;
  vec3 g1 = (a + b + f + g) * 0.25;
  vec3 g2 = (b + c + g + h) * 0.25;
  vec3 g3 = (f + g + k + l) * 0.25;
  vec3 g4 = (g + h + l + m) * 0.25;
  vec3 r;
  if (uKaris > 0.5) {
    // Karis average: weight each group by 1 / (1 + luma) so single hot pixels can't flicker.
    float w0 = 0.5 * karisW(g0), w1 = 0.125 * karisW(g1), w2 = 0.125 * karisW(g2);
    float w3 = 0.125 * karisW(g3), w4 = 0.125 * karisW(g4);
    r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    r = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
  }
  if (any(isnan(r)) || any(isinf(r))) r = vec3(0.0);
  o = vec4(min(r, vec3(60000.0)), 1.0);
}
`;

const UP_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform sampler2D uSrc;      // unit 10 (smaller level)
uniform vec2 uSrcTexel;
vec3 tap(vec2 off) { return texture(uSrc, vUV + off * uSrcTexel).rgb; }
void main() {
  vec3 s = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  s += (tap(vec2(0.0, -1.0)) + tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, 1.0))) * 2.0;
  s += tap(vec2(0.0)) * 4.0;
  o = vec4(s / 16.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Auto exposure: centre-weighted log-average luminance of the smallest bloom level, adapted over
// time in a 1x1 ping-pong target. Stores log2(exposure) remapped to 0..1 (works in RGBA8 too).
// ---------------------------------------------------------------------------------------------
const EXPOSURE_FS = GLSL_COMMON + `
out vec4 o;
uniform sampler2D uSmall;    // unit 10: smallest bloom level
uniform sampler2D uPrev;     // unit 11: previous exposure
uniform float uDt;
uniform float uReset;
float decodeE(float v) { return exp2(v * 10.0 - 5.0); }
float encodeE(float e) { return clamp((log2(e) + 5.0) / 10.0, 0.0, 1.0); }
void main() {
  float sum = 0.0, wsum = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      vec2 uv = (vec2(x, y) + 0.5) / 8.0;
      float l = luminance(textureLod(uSmall, uv, 0.0).rgb);
      vec2 d = uv - 0.5;
      float w = exp(-dot(d, d) * 5.0);
      sum += log2(max(l, 1e-5)) * w;
      wsum += w;
    }
  }
  float avgLog = sum / wsum;
  // Dim scenes get a lower key so nights read as night and caves stay dark, bright scenes a higher one.
  float key = mix(0.085, 0.26, smoothstep(-9.0, -1.5, avgLog));
  float target = clamp(key / exp2(avgLog), 0.3, 9.0);
  float prev = decodeE(texelFetch(uPrev, ivec2(0), 0).r);
  float e;
  if (uReset > 0.5 || isnan(prev) || isinf(prev)) {
    e = target;
  } else {
    // Adapting to darkness (exposure rising) is slower than adapting to brightness.
    float speed = target > prev ? 1.1 : 2.6;
    e = exp2(mix(log2(prev), log2(target), 1.0 - exp(-uDt * speed)));
  }
  if (isnan(e) || isinf(e)) e = 1.0;
  o = vec4(encodeE(e), avgLog, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Tone map: exposure, bloom, ACES (Hill fit), grade, vignette, sRGB, dither, luma -> alpha.
// ---------------------------------------------------------------------------------------------
const TONEMAP_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform sampler2D uHDR;       // unit 10
uniform sampler2D uBloom;     // unit 11
uniform sampler2D uExposure;  // unit 12
uniform float uBloomStrength;
uniform float uSaturation;
uniform float uVignette;

// Stephen Hill's ACES fit (sRGB -> AP1-ish -> RRT+ODT -> sRGB)
const mat3 ACES_IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) { return saturate(ACES_OUT * rrtOdt(ACES_IN * c)); }
vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float e = exp2(texelFetch(uExposure, ivec2(0), 0).r * 10.0 - 5.0);
  vec3 hdr = texture(uHDR, vUV).rgb;
  vec3 c = hdr;
  // The additive upsample sums every level, so normalise by the level count.
  if (uBloomStrength > 0.0) c = mix(c, texture(uBloom, vUV).rgb * ${(1 / BLOOM_LEVELS).toFixed(6)}, uBloomStrength);
  c *= e;
  // Faint blue shift in very dim light (scotopic vision) for moonlit nights.
  float lum = luminance(c);
  float scot = (1.0 - smoothstep(0.004, 0.12, lum)) * 0.35;
  c = mix(c, vec3(lum) * vec3(0.78, 0.9, 1.18), scot);
  c = aces(c * 1.12);
  // Grade: a touch of saturation, then a gentle S-curve for contrast.
  float l = luminance(c);
  c = max(mix(vec3(l), c, uSaturation), 0.0);
  vec3 s = srgbEncode(saturate(c));
  s = mix(s, s * s * (3.0 - 2.0 * s), 0.12);
  vec2 d = vUV - 0.5;
  s *= 1.0 - uVignette * dot(d, d) * 1.6;
  // Triangular dither of +-1 LSB hides banding in the sky gradients.
  float r = hash12(gl_FragCoord.xy + fract(uCamPos.w) * 61.0) + hash12(gl_FragCoord.yx * 1.37 + 17.0) - 1.0;
  s += r / 255.0;
  o = vec4(s, dot(s, vec3(0.299, 0.587, 0.114)));
}
`;

// FXAA 3.11 (quality preset 12) reading luma from alpha, upscaling from render size to the canvas.
const FXAA_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;   // unit 10
uniform vec2 uRcp;        // 1 / source size
const float SUBPIX = 0.75;
const float EDGE_THRESHOLD = 0.166;
const float EDGE_THRESHOLD_MIN = 0.0625;
float lumaAt(vec2 p) { return textureLod(uTex, p, 0.0).a; }
float lumaOff(vec2 p, float x, float y) { return textureLod(uTex, p + vec2(x, y) * uRcp, 0.0).a; }
void main() {
  vec2 posM = vUV;
  vec4 rgbyM = textureLod(uTex, posM, 0.0);
  float lumaM = rgbyM.a;
  float lumaS = lumaOff(posM, 0.0, 1.0);
  float lumaE = lumaOff(posM, 1.0, 0.0);
  float lumaN = lumaOff(posM, 0.0, -1.0);
  float lumaW = lumaOff(posM, -1.0, 0.0);
  float maxSM = max(lumaS, lumaM), minSM = min(lumaS, lumaM);
  float maxESM = max(lumaE, maxSM), minESM = min(lumaE, minSM);
  float maxWN = max(lumaN, lumaW), minWN = min(lumaN, lumaW);
  float rangeMax = max(maxWN, maxESM), rangeMin = min(minWN, minESM);
  float range = rangeMax - rangeMin;
  if (range < max(EDGE_THRESHOLD_MIN, rangeMax * EDGE_THRESHOLD)) { o = vec4(rgbyM.rgb, 1.0); return; }
  float lumaNW = lumaOff(posM, -1.0, -1.0);
  float lumaSE = lumaOff(posM, 1.0, 1.0);
  float lumaNE = lumaOff(posM, 1.0, -1.0);
  float lumaSW = lumaOff(posM, -1.0, 1.0);
  float lumaNS = lumaN + lumaS, lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = -2.0 * lumaM + lumaNS;
  float edgeVert1 = -2.0 * lumaM + lumaWE;
  float lumaNESE = lumaNE + lumaSE, lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = -2.0 * lumaE + lumaNESE;
  float edgeVert2 = -2.0 * lumaN + lumaNWNE;
  float lumaNWSW = lumaNW + lumaSW, lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = abs(edgeHorz1) * 2.0 + abs(edgeHorz2);
  float edgeVert4 = abs(edgeVert1) * 2.0 + abs(edgeVert2);
  float edgeHorz3 = -2.0 * lumaW + lumaNWSW;
  float edgeVert3 = -2.0 * lumaS + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4;
  float edgeVert = abs(edgeVert3) + edgeVert4;
  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  float lengthSign = uRcp.x;
  bool horzSpan = edgeHorz >= edgeVert;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) { lumaN = lumaW; lumaS = lumaE; }
  if (horzSpan) lengthSign = uRcp.y;
  float subpixB = subpixA * (1.0 / 12.0) - lumaM;
  float gradientN = lumaN - lumaM, gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM, lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = saturate(abs(subpixB) * subpixRcpRange);
  vec2 posB = posM;
  vec2 offNP = vec2(horzSpan ? uRcp.x : 0.0, horzSpan ? 0.0 : uRcp.y);
  if (!horzSpan) posB.x += lengthSign * 0.5;
  else posB.y += lengthSign * 0.5;
  vec2 posN = posB - offNP;
  vec2 posP = posB + offNP;
  float subpixD = -2.0 * subpixC + 3.0;
  float lumaEndN = lumaAt(posN);
  float subpixE = subpixC * subpixC;
  float lumaEndP = lumaAt(posP);
  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;
  lumaEndN -= lumaNN * 0.5;
  lumaEndP -= lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled;
  bool doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) posN -= offNP * 1.5;
  if (!doneP) posP += offNP * 1.5;
  bool doneNP = !doneN || !doneP;
  float steps[3] = float[3](2.0, 4.0, 12.0);
  for (int i = 0; i < 3; i++) {
    if (!doneNP) break;
    if (!doneN) lumaEndN = lumaAt(posN) - lumaNN * 0.5;
    if (!doneP) lumaEndP = lumaAt(posP) - lumaNN * 0.5;
    doneN = abs(lumaEndN) >= gradientScaled;
    doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) posN -= offNP * steps[i];
    if (!doneP) posP += offNP * steps[i];
    doneNP = !doneN || !doneP;
  }
  float dstN = horzSpan ? posM.x - posN.x : posM.y - posN.y;
  float dstP = horzSpan ? posP.x - posM.x : posP.y - posM.y;
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLengthRcp = 1.0 / (dstP + dstN);
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = dst * -spanLengthRcp + 0.5;
  float subpixH = subpixG * SUBPIX;
  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;
  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  if (!horzSpan) posM.x += pixelOffsetSubpix * lengthSign;
  else posM.y += pixelOffsetSubpix * lengthSign;
  o = vec4(textureLod(uTex, posM, 0.0).rgb, 1.0);
}
`;

const COPY_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;   // unit 10
void main() { o = vec4(texture(uTex, vUV).rgb, 1.0); }
`;

function colorTarget(gl, w, h, fmt, filter) {
  const tex = createTexture2D(gl, w, h, { ...fmt, filter });
  return tex;
}

export class PostProcess {
  constructor(gl, hdrFormat = gl.hdrFormat) {
    this.gl = gl;
    this.hdr = hdrFormat;
    this.ldr = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const mk = (fs, label, samplers) => {
      const p = new Program(gl, FULLSCREEN_VS, fs, label);
      p.samplers(samplers);
      return p;
    };
    this.halfProgram = mk(HALF_FS, 'post-half', { uDepth: P0 });
    this.denoiseProgram = mk(DENOISE_FS, 'post-denoise', { uVol: P0, uCloud: P0 + 1 });
    this.compositeProgram = mk(COMPOSITE_FS, 'composite', { uScene: P0, uDepth: P0 + 1, uVol: P0 + 2, uCloud: P0 + 3 });
    this.downProgram = mk(DOWN_FS, 'bloom-down', { uSrc: P0 });
    this.upProgram = mk(UP_FS, 'bloom-up', { uSrc: P0 });
    this.exposureProgram = mk(EXPOSURE_FS, 'exposure', { uSmall: P0, uPrev: P0 + 1 });
    this.tonemapProgram = mk(TONEMAP_FS, 'tonemap', { uHDR: P0, uBloom: P0 + 1, uExposure: P0 + 2 });
    this.fxaaProgram = mk(FXAA_FS, 'fxaa', { uTex: P0 });
    this.copyProgram = mk(COPY_FS, 'copy', { uTex: P0 });
    gl.useProgram(null);

    // Exposure ping-pong (1x1, never resized)
    this.exposure = [0, 1].map(() => {
      const tex = colorTarget(gl, 1, 1, this.hdr, gl.NEAREST);
      return { tex, fb: createFramebuffer(gl, [tex]) };
    });
    this.exposureIndex = 0;
    this.resetExposure = true;
    this.passes = 0;
    this.width = 0;
    this.height = 0;
  }

  _deleteTargets() {
    const gl = this.gl;
    if (!this.targets) return;
    const t = this.targets;
    for (const tex of [t.volTex, t.cloudTex, t.volTex2, t.cloudTex2, t.hdrTex, t.ldrTex, ...t.bloom.map((b) => b.tex)]) gl.deleteTexture(tex);
    for (const fb of [t.halfFB, t.halfFB2, t.hdrFB, t.ldrFB, ...t.bloom.map((b) => b.fb)]) gl.deleteFramebuffer(fb);
    gl.deleteRenderbuffer(t.hdrDepth);
    this.targets = null;
  }

  // (Re)create every size-dependent target for a render size of w x h.
  resize(w, h) {
    if (w === this.width && h === this.height && this.targets) return;
    const gl = this.gl;
    this._deleteTargets();
    this.width = w;
    this.height = h;
    const hw = Math.max(1, (w + 1) >> 1), hh = Math.max(1, (h + 1) >> 1);
    const volTex = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
    const cloudTex = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
    const halfFB = createFramebuffer(gl, [volTex, cloudTex]);
    const volTex2 = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
    const cloudTex2 = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
    const halfFB2 = createFramebuffer(gl, [volTex2, cloudTex2]);
    const hdrTex = colorTarget(gl, w, h, this.hdr, gl.LINEAR);
    const hdrDepth = createDepthRenderbuffer(gl, w, h);
    const hdrFB = createFramebuffer(gl, [hdrTex], hdrDepth, true);
    const ldrTex = colorTarget(gl, w, h, this.ldr, gl.LINEAR);
    const ldrFB = createFramebuffer(gl, [ldrTex]);
    const bloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, (bw + 1) >> 1);
      bh = Math.max(1, (bh + 1) >> 1);
      const tex = colorTarget(gl, bw, bh, this.hdr, gl.LINEAR);
      bloom.push({ tex, fb: createFramebuffer(gl, [tex]), w: bw, h: bh });
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.targets = { volTex, cloudTex, halfFB, volTex2, cloudTex2, halfFB2, halfW: hw, halfH: hh, hdrTex, hdrDepth, hdrFB, ldrTex, ldrFB, bloom };
  }

  _begin(fb, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    this.passes++;
  }

  _end() {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  _bind(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // Half-res volumetric light and clouds. Returns false when both are off (nothing rendered).
  halfRes(sceneDepth, { volumetrics, clouds, volStrength = 1 }) {
    if (!volumetrics && !clouds) return false;
    const gl = this.gl;
    const t = this.targets;
    this._begin(t.halfFB, t.halfW, t.halfH);
    this._bind(P0, sceneDepth);
    const p = this.halfProgram.use();
    gl.uniform1f(p.u('uVolStrength'), volStrength);
    drawFullscreen(gl);
    this._begin(t.halfFB2, t.halfW, t.halfH);
    this._bind(P0, t.volTex);
    this._bind(P0 + 1, t.cloudTex);
    this.denoiseProgram.use();
    drawFullscreen(gl);
    this._end();
    return true;
  }

  // Scene + volumetrics + clouds -> HDR target. Leaves the HDR target bound (for the held item).
  composite(sceneColor, sceneDepth, { halfOn, flatClouds }) {
    const gl = this.gl;
    const t = this.targets;
    this._begin(t.hdrFB, this.width, this.height);
    this._bind(P0, sceneColor);
    this._bind(P0 + 1, sceneDepth);
    this._bind(P0 + 2, t.volTex2);
    this._bind(P0 + 3, t.cloudTex2);
    const p = this.compositeProgram.use();
    gl.uniform1f(p.u('uHalfOn'), halfOn ? 1 : 0);
    gl.uniform1f(p.u('uFlatClouds'), flatClouds ? 1 : 0);
    gl.uniform2f(p.u('uHalfSize'), t.halfW, t.halfH);
    drawFullscreen(gl);
    this._end();
  }

  // Bind the HDR target with its depth cleared, ready for the held item.
  beginHeld() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.hdrFB);
    gl.viewport(0, 0, this.width, this.height);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  // Downsample chain (always: exposure reads its smallest level) + upsample when bloom is on.
  bloom(enabled) {
    const gl = this.gl;
    const t = this.targets;
    const levels = t.bloom;
    const down = this.downProgram.use();
    let srcTex = t.hdrTex, sw = this.width, sh = this.height;
    for (let i = 0; i < levels.length; i++) {
      const L = levels[i];
      this._begin(L.fb, L.w, L.h);
      this._bind(P0, srcTex);
      down.use();
      gl.uniform2f(down.u('uSrcTexel'), 1 / sw, 1 / sh);
      gl.uniform1f(down.u('uKaris'), i === 0 ? 1 : 0);
      drawFullscreen(gl);
      srcTex = L.tex; sw = L.w; sh = L.h;
    }
    if (enabled) {
      const up = this.upProgram.use();
      for (let i = levels.length - 2; i >= 0; i--) {
        const L = levels[i], S = levels[i + 1];
        this._begin(L.fb, L.w, L.h);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        this._bind(P0, S.tex);
        up.use();
        gl.uniform2f(up.u('uSrcTexel'), 1 / S.w, 1 / S.h);
        drawFullscreen(gl);
      }
    }
    this._end();
  }

  exposureUpdate(dt) {
    const gl = this.gl;
    const prev = this.exposure[this.exposureIndex];
    const next = this.exposure[1 - this.exposureIndex];
    this._begin(next.fb, 1, 1);
    this._bind(P0, this.targets.bloom[this.targets.bloom.length - 1].tex);
    this._bind(P0 + 1, prev.tex);
    const p = this.exposureProgram.use();
    gl.uniform1f(p.u('uDt'), Math.min(Math.max(dt || 0, 0), 0.25));
    gl.uniform1f(p.u('uReset'), this.resetExposure ? 1 : 0);
    drawFullscreen(gl);
    this._end();
    this.resetExposure = false;
    this.exposureIndex = 1 - this.exposureIndex;
  }

  get exposureTexture() { return this.exposure[this.exposureIndex].tex; }

  // Tone map, then FXAA (or a straight copy) to the canvas at canvasW x canvasH.
  finish(canvasW, canvasH, { fxaa, bloomStrength, saturation = 1.08, vignette = 0.22 }) {
    const gl = this.gl;
    const t = this.targets;
    const direct = !fxaa && canvasW === this.width && canvasH === this.height;
    if (direct) this._begin(null, canvasW, canvasH);
    else this._begin(t.ldrFB, this.width, this.height);
    this._bind(P0, t.hdrTex);
    this._bind(P0 + 1, t.bloom[0].tex);
    this._bind(P0 + 2, this.exposureTexture);
    const p = this.tonemapProgram.use();
    gl.uniform1f(p.u('uBloomStrength'), bloomStrength);
    gl.uniform1f(p.u('uSaturation'), saturation);
    gl.uniform1f(p.u('uVignette'), vignette);
    drawFullscreen(gl);
    if (!direct) {
      this._begin(null, canvasW, canvasH);
      this._bind(P0, t.ldrTex);
      const q = fxaa ? this.fxaaProgram.use() : this.copyProgram.use();
      if (fxaa) gl.uniform2f(q.u('uRcp'), 1 / this.width, 1 / this.height);
      drawFullscreen(gl);
    }
    this._end();
  }

  dispose() {
    const gl = this.gl;
    this._deleteTargets();
    for (const e of this.exposure) { gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fb); }
  }
}
