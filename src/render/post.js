// Post-processing chain: half-res volumetric light + volumetric clouds, composite into the HDR
// target, the temporal anti-aliasing resolve (taa.js), bloom, auto exposure, tone mapping and the
// final pass to the canvas (TAA sharpening, FXAA or a copy). Every pass leaves the GL state clean
// (depth test on, depth write on, blend off, back-face culling) and sets its own viewport.
//
// Sizes: the half-res buffers and the composite follow the render size (canvas x renderScale).
// With TAA the resolve reconstructs at the output (canvas) size and everything after it (held
// item, bloom, exposure, tone map, final pass) runs at that size; without TAA they run at the
// render size and the final pass upscales.

import { Program, createTexture2D, createFramebuffer, createDepthRenderbuffer, drawFullscreen, UNIT } from '../gl.js';
import { GLSL_COMMON, FULLSCREEN_VS } from './common.js';
import { TemporalAA } from './taa.js';

export const BLOOM_LEVELS = 6;
const METER_LEVEL = 4;          // bloom level the exposure meters (1/32 of the size the post chain runs at)
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
  // (Off, light below the horizon, or deep in a cave where the result is faded out anyway.)
  if (n <= 0 || uLightDir.y < -0.02 || uCam.w <= 0.05 || uVolStrength <= 0.0) return vec3(0.0);
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
      // Light shafts below the waves: the refracted surface pattern, absorbed on its way down
      // and on its way to the eye.
      float depth = max(SEA_LEVEL - wp.y, 0.0);
      vec2 sp = wp.xz + L.xz / max(L.y, 0.2) * depth;
      float shaft = textureLod(uNoise2D, sp * 0.045 + uCamPos.w * vec2(0.011, 0.007), 0.0).a;
      vis *= 0.15 + 1.7 * shaft * shaft;
      tint = exp(-WATER_EXT * (depth / max(L.y, 0.2) + t));
      dens = 0.02;
    } else {
      // Height fog: dense in the valleys, thinning with altitude, never quite zero.
      dens = 0.0011 * fogMul * (exp(-max(wp.y - SEA_LEVEL, 0.0) / 34.0) * 0.85 + 0.15);
    }
    vis *= cloudShadow(wp);
    acc += tint * (trans * dens * vis * stepLen);
    if (!water) trans *= exp(-dens * stepLen);   // (under water the tint carries the extinction)
  }
  float phase;
  if (water) phase = mix(henyeyGreenstein(mu, 0.8), 1.0 / (4.0 * PI), 0.25) * 4.0 * PI;
  else phase = mix(henyeyGreenstein(mu, 0.65), 1.0 / (4.0 * PI), 0.15) * 4.0 * PI;
  vec3 col = acc * phase * lightColor();
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
  // Static dither without TAA (a moving one would crawl); per frame with it (accumulated away).
  float jit = ignTemporal(gl_FragCoord.xy + 0.37);
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

// 3x3 depth-aware filter of the half-res buffers: IGN spreads its dither values evenly over
// every 3x3 neighbourhood, so a box turns the per-pixel ray-march jitter into smooth gradients.
// With TAA the dither changes every frame and the resolve averages it over time, so a lighter
// kernel (neighbours weighted uSpread, corners uSpread^2) keeps the shafts and cloud edges sharper.
const DENOISE_FS = GLSL_COMMON + `
layout(location = 0) out vec4 oVol;
layout(location = 1) out vec4 oCloud;
uniform sampler2D uVol;      // unit 10
uniform sampler2D uCloud;    // unit 11
uniform float uSpread;       // 1 = 3x3 box, smaller = more weight on the centre texel
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
      float w = exp(-abs(v.a - z0) / max(z0, 1e-4) * 30.0) * (x == 0 ? 1.0 : uSpread) * (y == 0 ? 1.0 : uSpread);
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

// q: world xz where the view ray meets the middle of the cloud layer; gx/gy: its screen-space
// derivatives (taken in uniform control flow by the caller, so this can run for sky pixels only).
vec4 flatClouds(vec3 dir, vec2 q0, vec2 gx, vec2 gy, float t) {
  vec2 p = q0 + uWind.xy * uCamPos.w;
  float cov = textureGrad(uNoise2D, p / 3072.0, gx / 3072.0, gy / 3072.0).r * 0.65 +
    textureGrad(uNoise2D, p / 1100.0 + 0.37, gx / 1100.0, gy / 1100.0).g * 0.35;
  cov = smoothstep(1.0 - uEnv.z, 1.0 - uEnv.z + 0.35, cov);
  vec2 q = q0 + uWind.xy * uCamPos.w * 1.15;
  float detail = textureGrad(uNoise2D, q / 260.0, gx / 260.0, gy / 260.0).a * 0.6 +
    textureGrad(uNoise2D, q / 90.0 + 0.3, gx / 90.0, gy / 90.0).b * 0.4;
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
  vec4 scene = texture(uScene, uv);
  vec3 c = scene.rgb;
  // Sanitize: a NaN/Inf here would spread through bloom and poison auto exposure.
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = max(c, vec3(0.0));
  float depth = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
  bool sky = depth >= 1.0;
  float lin = linearDepth(depth) / uCam.y;
  vec3 volWater = vec3(0.0);

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
    if (water) volWater = vol; else c += vol;
  }

  vec3 posRel = positionFromDepth(vUV, depth);
  vec3 dir = normalize(posRel);
  if (uFlatClouds > 0.5) {
    // Cloud-plane hit and its derivatives for every pixel (uniform control flow keeps them
    // defined at silhouettes); the texture work only runs for sky pixels below the layer.
    float cy = max(dir.y, 0.015);
    float tc = (0.5 * (CLOUD_BOTTOM + CLOUD_TOP) - uCamPos.y) / cy;
    vec2 q0 = uCamPos.xz + dir.xz / cy * (0.5 * (CLOUD_BOTTOM + CLOUD_TOP) - uCamPos.y);
    vec2 gx = dFdx(q0), gy = dFdy(q0);
    if (sky && !water && dir.y > 0.015 && uCamPos.y < CLOUD_BOTTOM) {
      vec4 fc = flatClouds(dir, q0, gx, gy, tc);
      c = mix(c, fc.rgb, fc.a);
    }
  }

  if (water) {
    // Underwater: Beer-Lambert along the view path (red first, then green), in-scattered light of
    // the water column at the camera's depth, plus the marched light shafts (already absorbed).
    float dist = sky ? 400.0 : length(posRel);
    vec3 tr = exp(-WATER_EXT * dist);
    float camDepth = max(SEA_LEVEL - uCamPos.y, 0.0);
    // Brighter toward the surface above, darker looking down into the deep.
    float up = dir.y * 0.5 + 0.5;
    vec3 inscatter = underwaterLight(max(camDepth + (0.5 - up) * 12.0, 0.0)) * WATER_SCATTER * (0.35 + 0.3 * up) * max(uCam.w, 0.06);
    c = c * tr + inscatter * (1.0 - tr) + volWater;
  }
  // Alpha: 1 - self-emission (from the terrain pass), carried down the bloom chain for metering.
  o = vec4(c, saturate(scene.a));
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
// Alpha (non-emissive coverage, for exposure metering): plain 4-tap average.
float alphaAvg() {
  return 0.25 * (texture(uSrc, vUV + vec2(-1.0, -1.0) * uSrcTexel).a + texture(uSrc, vUV + vec2(1.0, -1.0) * uSrcTexel).a +
    texture(uSrc, vUV + vec2(-1.0, 1.0) * uSrcTexel).a + texture(uSrc, vUV + vec2(1.0, 1.0) * uSrcTexel).a);
}
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
  o = vec4(min(r, vec3(60000.0)), alphaAvg());
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
// Auto exposure, adapted over time in a 1x1 ping-pong target (stores log2(exposure) remapped to
// 0..1 as hi/lo channels, works in RGBA8 too). Metering: 16x9 samples of a 1/32-res bloom level (before the bloom
// upsample adds into it), weighted toward the centre and lower half, with sky pixels (from the
// scene depth) counting for little so a bright sunset sky doesn't plunge the terrain into black.
//  - key: the mid-grey target follows the ambient light of the surroundings (sky irradiance x eye
//    sky light), so nights and caves stay dark and moody instead of being metered up to grey;
//  - highlight protection: the brighter half of the non-sky samples may not exceed a ceiling
//    (low at night), so a torch-lit wall in a dark scene isn't blown out.
// ---------------------------------------------------------------------------------------------
const EXPOSURE_FS = GLSL_COMMON + `
out vec4 o;
uniform sampler2D uMeter;    // unit 10: bloom level (1/32 res), plain downsample
uniform sampler2D uPrev;     // unit 11: previous exposure
uniform sampler2D uDepth;    // unit 12: scene depth
uniform float uDt;
uniform float uReset;
float decodeE(float v) { return exp2(v * 10.0 - 5.0); }
float encodeE(float e) { return clamp((log2(e) + 5.0) / 10.0, 0.0, 1.0); }
// Stored split into hi/lo channels (r = 8-bit steps, g = fraction): one channel's quantum
// (fp16 ~0.003 stops, RGBA8 0.04) exceeds a frame's adaptation step at high refresh rates, which
// would round the update away and leave the exposure stuck short of its target.
float loadU(vec4 t) { return (floor(t.r * 255.0 + 0.5) + t.g) / 255.0; }
const int NX = 16, NY = 9;
void main() {
  float lg[NX * NY];
  float wt[NX * NY];
  float wg[NX * NY];
  float sum = 0.0, wsum = 0.0;
  for (int y = 0; y < NY; y++) {
    for (int x = 0; x < NX; x++) {
      int i = y * NX + x;
      vec2 uv = (vec2(x, y) + 0.5) / vec2(NX, NY);
      vec4 m = textureLod(uMeter, uv, 0.0);
      float l = luminance(m.rgb);
      float lit = saturate(m.a);       // share of the area that is not a light source
      float sky = 0.0;
      for (int k = 0; k < 4; k++) {
        vec2 off = (vec2(k & 1, k >> 1) - 0.5) * vec2(0.5 / float(NX), 0.5 / float(NY));
        sky += step(1.0, textureLod(uDepth, uv + off, 0.0).r) * 0.25;
      }
      vec2 d = (uv - vec2(0.5, 0.45)) * vec2(1.0, 1.4);
      float wPos = exp(-dot(d, d) * 3.0) * mix(1.25, 0.75, uv.y);
      lg[i] = log2(max(l, 1e-6));
      wg[i] = (1.0 - sky) * lit;      // lit ground share (no sky, no lava or glowstone)
      wt[i] = wPos * mix(1.0, 0.2, sky) * mix(0.6, 1.0, lit);
      sum += lg[i] * wt[i];
      wsum += wt[i];
    }
  }
  float mean = sum / wsum;
  // Winsorised mean (a sun or a lava pool can't drag it), and the mean of the brighter half of
  // the ground samples for highlight protection.
  float s2 = 0.0, hs = 0.0, hw = 0.0;
  for (int i = 0; i < NX * NY; i++) {
    float v = clamp(lg[i], mean - 4.0, mean + 2.5);
    s2 += v * wt[i];
    if (lg[i] > mean) { hs += lg[i] * wt[i] * wg[i]; hw += wt[i] * wg[i]; }
  }
  float avgLog = s2 / wsum;
  float hiLog = hw > 1e-3 ? hs / hw : avgLog;
  // Ambient light of the surroundings: ~0 at noon, -3 at sunset, -8 at night, lower in caves.
  float envLog = log2(max(luminance(skyIrradiance()) * uCam.w * uCam.w, 1e-7));
  float day = smoothstep(-8.0, -2.5, envLog);
  float key = mix(0.07, 0.22, day);
  float ceilingHi = mix(0.32, 2.8, day);
  float target = clamp(min(key / exp2(avgLog), ceilingHi / exp2(hiLog)), 0.1, 9.0);
  float prev = decodeE(loadU(texelFetch(uPrev, ivec2(0), 0)));
  float e;
  if (uReset > 0.5 || isnan(prev) || isinf(prev)) {
    e = target;
  } else {
    // Adapting to darkness (exposure rising) is slower than adapting to brightness.
    float speed = target > prev ? 1.1 : 2.6;
    e = exp2(mix(log2(prev), log2(target), 1.0 - exp(-uDt * speed)));
  }
  if (isnan(e) || isinf(e)) e = 1.0;
  float u = encodeE(e) * 255.0;
  float hi = floor(u);
  o = vec4(hi / 255.0, u - hi, avgLog, 1.0);   // b: metered log luminance (debug)
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
uniform float uDither;        // 1: +-1 LSB dither here (8-bit target); 0: the final pass dithers

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
  vec4 et = texelFetch(uExposure, ivec2(0), 0);
  float e = exp2(((floor(et.r * 255.0 + 0.5) + et.g) / 255.0) * 10.0 - 5.0);
  vec3 hdr = texture(uHDR, vUV).rgb;
  vec3 c = hdr;
  // The additive upsample sums every level, so normalise by the level count.
  if (uBloomStrength > 0.0) c = mix(c, texture(uBloom, vUV).rgb * ${(1 / BLOOM_LEVELS).toFixed(6)}, uBloomStrength);
  // Blue shift in genuinely dim light (scotopic vision): judged on the scene radiance before
  // exposure, so moonlit nights and dark caves turn cool while daytime shadows keep their colour.
  float lumScene = luminance(c);
  c *= e;
  float lum = luminance(c);
  float scot = (1.0 - smoothstep(0.002, 0.05, lumScene)) * 0.4;
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
  s += r / 255.0 * uDither;
  o = vec4(s, dot(s, vec3(0.299, 0.587, 0.114)));
}
`;

// FXAA 3.11 (quality preset 12) reading luma from alpha, upscaling from render size to the canvas.
const FXAA_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform sampler2D uTex;   // unit 10
uniform vec2 uRcp;        // 1 / source size
// Low sub-pixel blending: FXAA only smooths geometric edges and must not smear the pixel-art texels.
const float SUBPIX = 0.3;
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

// Final pass after TAA: robust contrast-adaptive sharpening (AMD FidelityFX FSR1 RCAS) on the
// tone-mapped, sRGB-encoded image (perceptual space, as RCAS expects) to give the pixel-art texels
// back the crispness the temporal filter takes, then the +-1 LSB dither. The lobe is limited so
// the result never leaves the min/max of the 4 neighbours (no ringing) and is reduced where the
// centre looks like noise. The strength is scaled per pixel by the resolve (TAA aux alpha: more on
// history resampled by camera motion, less on fresh current-frame pixels), and the held item
// (drawn after the resolve, anti-aliased on its own, never softened) is left alone.
const SHARPEN_FS = GLSL_COMMON + `
out vec4 o;
uniform sampler2D uTex;       // unit 10 (same size as the target)
uniform sampler2D uAux;       // unit 11: TAA aux of this frame (a = sharpen multiplier / 2)
uniform sampler2D uHeldDepth; // unit 12: held-item depth (1 = no held item)
uniform float uHeld;          // the held item was drawn this frame
uniform float uSharpness;     // 0 = off .. 1 = RCAS maximum
uniform float uDither;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 m = textureSize(uTex, 0) - 1;
  vec3 b = texelFetch(uTex, clamp(p + ivec2(0, 1), ivec2(0), m), 0).rgb;
  vec3 d = texelFetch(uTex, clamp(p + ivec2(-1, 0), ivec2(0), m), 0).rgb;
  vec3 e = texelFetch(uTex, p, 0).rgb;
  vec3 f = texelFetch(uTex, clamp(p + ivec2(1, 0), ivec2(0), m), 0).rgb;
  vec3 h = texelFetch(uTex, clamp(p + ivec2(0, -1), ivec2(0), m), 0).rgb;
  vec3 c = e;
  float sharpness = min(uSharpness * texelFetch(uAux, p, 0).a * 2.0, 1.0);
  if (uHeld > 0.5 && texelFetch(uHeldDepth, p, 0).r < 1.0) sharpness = 0.0;
  if (sharpness > 0.0) {
    vec3 mn = min(min(b, d), min(f, h)), mx = max(max(b, d), max(f, h));
    vec3 hitMin = min(mn, e) / (4.0 * mx + 1e-5);
    vec3 hitMax = (1.0 - max(mx, e)) / (4.0 * min(mn, e) - 4.0 - 1e-5);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharpness;
    // Noise detection on luma: an isolated centre (dither, sparkle) is sharpened less.
    float bL = b.g + 0.5 * (b.r + b.b), dL = d.g + 0.5 * (d.r + d.b), eL = e.g + 0.5 * (e.r + e.b);
    float fL = f.g + 0.5 * (f.r + f.b), hL = h.g + 0.5 * (h.r + h.b);
    float nz = 0.25 * (bL + dL + fL + hL) - eL;
    float range = max(max(max(bL, dL), max(fL, hL)), eL) - min(min(min(bL, dL), min(fL, hL)), eL);
    nz = saturate(abs(nz) / max(range, 1e-5));
    lobe *= 1.0 - 0.5 * nz;
    c = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  }
  float r = hash12(gl_FragCoord.xy + fract(uCamPos.w) * 61.0) + hash12(gl_FragCoord.yx * 1.37 + 17.0) - 1.0;
  o = vec4(saturate(c) + r / 255.0 * uDither, 1.0);
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
    // Float targets: the tone-mapped image before the TAA sharpen pass can stay unquantised (the
    // sharpen pass dithers once, at the end); otherwise the tone map dithers into 8 bits.
    this.floatTargets = hdrFormat.type !== gl.UNSIGNED_BYTE;
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
    this.exposureProgram = mk(EXPOSURE_FS, 'exposure', { uMeter: P0, uPrev: P0 + 1, uDepth: P0 + 2 });
    this.tonemapProgram = mk(TONEMAP_FS, 'tonemap', { uHDR: P0, uBloom: P0 + 1, uExposure: P0 + 2 });
    this.fxaaProgram = mk(FXAA_FS, 'fxaa', { uTex: P0 });
    this.sharpenProgram = mk(SHARPEN_FS, 'sharpen', { uTex: P0, uAux: P0 + 1, uHeldDepth: P0 + 2 });
    this.copyProgram = mk(COPY_FS, 'copy', { uTex: P0 });
    gl.useProgram(null);
    this.taa = new TemporalAA(gl, hdrFormat);

    // Exposure ping-pong (1x1, never resized)
    this.exposure = [0, 1].map(() => {
      const tex = colorTarget(gl, 1, 1, this.hdr, gl.NEAREST);
      return { tex, fb: createFramebuffer(gl, [tex]) };
    });
    this.exposureIndex = 0;
    this.resetExposure = true;
    this.passes = 0;
    this.width = 0;          // render size (half-res buffers, composite)
    this.height = 0;
    this.postWidth = 0;      // size of everything after the composite / TAA resolve
    this.postHeight = 0;
    this.temporal = false;   // TAA: resolve to the output size
    // Denoise kernel of the half-res buffers (see DENOISE_FS): box without TAA, lighter with it.
    this.denoiseSpread = 1;
    this.denoiseSpreadTAA = 0.35;
  }

  _deleteTargets() {
    this._deleteRenderTargets();
    this._deletePostTargets();
  }

  _deleteRenderTargets() {
    const gl = this.gl;
    if (!this.targets) return;
    const t = this.targets;
    for (const tex of [t.volTex, t.cloudTex, t.volTex2, t.cloudTex2, t.compTex]) gl.deleteTexture(tex);
    for (const fb of [t.halfFB, t.halfFB2, t.compFB]) gl.deleteFramebuffer(fb);
    gl.deleteRenderbuffer(t.compDepth);
    this.targets = null;
  }

  _deletePostTargets() {
    const gl = this.gl;
    if (!this.postTargets) return;
    const t = this.postTargets;
    for (const tex of [t.ldrTex, ...t.bloom.map((b) => b.tex)]) gl.deleteTexture(tex);
    for (const fb of [t.ldrFB, ...t.bloom.map((b) => b.fb)]) gl.deleteFramebuffer(fb);
    this.postTargets = null;
  }

  // (Re)create the size-dependent targets: render size w x h, output size outW x outH (the canvas).
  // temporal: TAA on (resolve + everything after it at the output size). Only what changed is
  // rebuilt, so a renderScale change keeps the (output-sized) TAA history.
  resize(w, h, outW = w, outH = h, temporal = false) {
    const gl = this.gl;
    if (w !== this.width || h !== this.height || !this.targets) {
      this._deleteRenderTargets();
      this.width = w;
      this.height = h;
      const hw = Math.max(1, (w + 1) >> 1), hh = Math.max(1, (h + 1) >> 1);
      const volTex = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
      const cloudTex = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
      const halfFB = createFramebuffer(gl, [volTex, cloudTex]);
      const volTex2 = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
      const cloudTex2 = colorTarget(gl, hw, hh, this.hdr, gl.NEAREST);
      const halfFB2 = createFramebuffer(gl, [volTex2, cloudTex2]);
      const compTex = colorTarget(gl, w, h, this.hdr, gl.LINEAR);
      const compDepth = createDepthRenderbuffer(gl, w, h);
      const compFB = createFramebuffer(gl, [compTex], compDepth, true);
      this.targets = { volTex, cloudTex, halfFB, volTex2, cloudTex2, halfFB2, halfW: hw, halfH: hh, compTex, compDepth, compFB };
    }
    const pw = temporal ? outW : w, ph = temporal ? outH : h;
    const ldrFloat = temporal && this.floatTargets;
    const pt = this.postTargets;
    if (!pt || pt.w !== pw || pt.h !== ph || pt.ldrFloat !== ldrFloat) {
      this._deletePostTargets();
      const ldrTex = colorTarget(gl, pw, ph, ldrFloat ? this.hdr : this.ldr, gl.LINEAR);
      const ldrFB = createFramebuffer(gl, [ldrTex]);
      const bloom = [];
      let bw = pw, bh = ph;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        bw = Math.max(1, (bw + 1) >> 1);
        bh = Math.max(1, (bh + 1) >> 1);
        const tex = colorTarget(gl, bw, bh, this.hdr, gl.LINEAR);
        bloom.push({ tex, fb: createFramebuffer(gl, [tex]), w: bw, h: bh });
      }
      this.postTargets = { w: pw, h: ph, ldrFloat, ldrTex, ldrFB, bloom };
    }
    this.postWidth = pw;
    this.postHeight = ph;
    if (temporal) this.taa.resize(outW, outH);
    else if (this.taa.targets) this.taa.release();
    this.temporal = temporal;
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
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
    const d = this.denoiseProgram.use();
    gl.uniform1f(d.u('uSpread'), this.temporal ? this.denoiseSpreadTAA : this.denoiseSpread);
    drawFullscreen(gl);
    this._end();
    return true;
  }

  // Scene + volumetrics + clouds -> the composite target (render size).
  composite(sceneColor, sceneDepth, { halfOn, flatClouds }) {
    const gl = this.gl;
    const t = this.targets;
    this._begin(t.compFB, this.width, this.height);
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

  // TAA resolve of the composite into the output-size HDR target (no-op without TAA). motionTex:
  // the scene's motion attachment (null when there is none).
  resolve(sceneDepth, motionTex = null) {
    if (!this.temporal) return false;
    this.passes++;
    return this.taa.resolve(this.targets.compTex, sceneDepth, this.exposureTexture, this.width / this.postWidth, motionTex);
  }

  // The HDR image the bloom / exposure / tone map read: the TAA output, or the composite.
  get source() { return this.temporal ? this.taa.outputTexture : this.targets.compTex; }

  // Bind the HDR target the held item goes into (after the TAA resolve: never jittered, never in
  // the history), with its own depth cleared.
  beginHeld() {
    const gl = this.gl;
    if (this.temporal) { this.taa.beginHeld(); return; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.compFB);
    gl.viewport(0, 0, this.width, this.height);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  // Downsample chain (always: exposure meters one of its levels). Only as deep as bloom needs;
  // without bloom the chain stops at the metering level.
  downsample(enabled) {
    const gl = this.gl;
    const levels = this.postTargets.bloom;
    const n = enabled ? levels.length : METER_LEVEL + 1;
    const down = this.downProgram.use();
    let srcTex = this.source, sw = this.postWidth, sh = this.postHeight;
    for (let i = 0; i < n; i++) {
      const L = levels[i];
      this._begin(L.fb, L.w, L.h);
      this._bind(P0, srcTex);
      down.use();
      gl.uniform2f(down.u('uSrcTexel'), 1 / sw, 1 / sh);
      gl.uniform1f(down.u('uKaris'), i === 0 ? 1 : 0);
      drawFullscreen(gl);
      srcTex = L.tex; sw = L.w; sh = L.h;
    }
    this._end();
  }

  // Tent upsample back up the chain (additive), after exposure has metered the plain levels.
  upsample() {
    const gl = this.gl;
    const levels = this.postTargets.bloom;
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
    this._end();
  }

  bloom(enabled) {
    this.downsample(enabled);
    if (enabled) this.upsample();
  }

  exposureUpdate(dt, sceneDepth) {
    const gl = this.gl;
    const prev = this.exposure[this.exposureIndex];
    const next = this.exposure[1 - this.exposureIndex];
    this._begin(next.fb, 1, 1);
    this._bind(P0, this.postTargets.bloom[METER_LEVEL].tex);
    this._bind(P0 + 1, prev.tex);
    this._bind(P0 + 2, sceneDepth);
    const p = this.exposureProgram.use();
    gl.uniform1f(p.u('uDt'), Math.min(Math.max(dt || 0, 0), 0.25));
    gl.uniform1f(p.u('uReset'), this.resetExposure ? 1 : 0);
    drawFullscreen(gl);
    this._end();
    this.resetExposure = false;
    this.exposureIndex = 1 - this.exposureIndex;
  }

  get exposureTexture() { return this.exposure[this.exposureIndex].tex; }

  // Tone map, then the final pass to the canvas at canvasW x canvasH: with TAA a light RCAS
  // sharpen (same size), else FXAA or a straight copy (upscaling from the render size).
  // aa: 'taa' | 'fxaa' | 'off'; sharpness 0..1 (TAA only); held: the held item was drawn this frame.
  finish(canvasW, canvasH, { aa = 'off', fxaa, bloomStrength, saturation = 1.1, vignette = 0.22, sharpness = 0.5, held = false }) {
    const gl = this.gl;
    const t = this.postTargets;
    if (fxaa !== undefined && aa === 'off') aa = fxaa ? 'fxaa' : 'off';   // legacy option
    const temporal = this.temporal;
    const mode = temporal ? 'taa' : aa === 'fxaa' ? 'fxaa' : 'off';
    const pw = this.postWidth, ph = this.postHeight;
    const direct = mode === 'off' && canvasW === pw && canvasH === ph;
    // The tone map dithers into 8 bits, unless the sharpen pass follows on a float target.
    const ditherLater = mode === 'taa' && t.ldrFloat;
    if (direct) this._begin(null, canvasW, canvasH);
    else this._begin(t.ldrFB, pw, ph);
    this._bind(P0, this.source);
    this._bind(P0 + 1, t.bloom[0].tex);
    this._bind(P0 + 2, this.exposureTexture);
    const p = this.tonemapProgram.use();
    gl.uniform1f(p.u('uBloomStrength'), bloomStrength);
    gl.uniform1f(p.u('uSaturation'), saturation);
    gl.uniform1f(p.u('uVignette'), vignette);
    gl.uniform1f(p.u('uDither'), ditherLater ? 0 : 1);
    drawFullscreen(gl);
    if (!direct) {
      this._begin(null, canvasW, canvasH);
      this._bind(P0, t.ldrTex);
      if (mode === 'taa' && canvasW === pw && canvasH === ph) {
        this._bind(P0 + 1, this.taa.auxTexture);
        this._bind(P0 + 2, this.taa.heldDepthTexture);
        const q = this.sharpenProgram.use();
        gl.uniform1f(q.u('uSharpness'), sharpness);
        gl.uniform1f(q.u('uDither'), ditherLater ? 1 : 0);
        gl.uniform1f(q.u('uHeld'), held ? 1 : 0);
      } else if (mode === 'fxaa') {
        const q = this.fxaaProgram.use();
        gl.uniform2f(q.u('uRcp'), 1 / pw, 1 / ph);
      } else {
        this.copyProgram.use();
      }
      drawFullscreen(gl);
    }
    this._end();
  }

  dispose() {
    const gl = this.gl;
    this._deleteTargets();
    this.taa.dispose();
    for (const e of this.exposure) { gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fb); }
    for (const p of [this.halfProgram, this.denoiseProgram, this.compositeProgram, this.downProgram, this.upProgram,
      this.exposureProgram, this.tonemapProgram, this.fxaaProgram, this.sharpenProgram, this.copyProgram]) gl.deleteProgram(p.program);
  }
}
