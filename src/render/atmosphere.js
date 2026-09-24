// Physically based sky: the sky-view LUT (single scattering: Rayleigh + Mie + ozone, sun plus a
// faint moon-lit sky), the 4x1 irradiance texture every shader lights with, the sky pass (sun disk,
// moon with phases, stars) and the shared noise textures. Also derives the per-frame celestial
// state (which light casts shadows, visibilities, moon phase, star rotation, fog density).

import { Program, createTexture2D, createFramebuffer, drawFullscreen } from '../gl.js';
import { GLSL_COMMON, FULLSCREEN_VS, FULLSCREEN_FAR_VS, SKY_LUT_W, SKY_LUT_H } from './common.js';
import { mulberry32 } from '../noise.js';
import { smoothstep } from '../math.js';

export const SUN_TILT = (25 * Math.PI) / 180;
// Shadows follow the sun while it is above -3 degrees, then the moon.
const LIGHT_SWITCH_Y = Math.sin((-3 * Math.PI) / 180);
const MOON_CYCLE_DAYS = 8;
// Constant wind: cloud offsets are wind * time, so a changing wind would make clouds jump.
export const WIND = [5.2, 1.7];

// Intensities (HDR units, see SPEC "HDR units").
const SUN_SKY = 36.0;                     // sun intensity driving sky scattering (zenith at noon ~1.2)
const SUN_LIGHT = [3.35, 3.3, 3.25];      // sun illuminance at the top of the atmosphere (noon ground ~3)
const SUN_DISK = 90.0;                    // radiance of the sun disk (very bright so it blooms)
const MOON_SKY = 0.00045;                 // moon-lit scattering (relative to the sun's SUN_SKY)
const MOON_LIGHT = [0.25 * 0.12, 0.32 * 0.12, 0.45 * 0.12];
const NIGHT_FLOOR = [0.0022, 0.0038, 0.0085]; // airglow + starlight: nights are deep blue, never black

// Rayleigh / Mie / ozone, per km; shared by the LUT and irradiance programs.
const ATMOSPHERE_GLSL = `
const float R_GROUND = 6360.0;
const float R_TOP = 6460.0;
const vec3 BETA_R = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float BETA_MS = 3.996e-3;
const float BETA_ME = 4.4e-3;
const vec3 BETA_O = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float SUN_ANGULAR_RADIUS = 0.0093;

vec3 atmoDensity(float h) {
  h = max(h, 0.0);
  return vec3(exp(-h / 8.0), exp(-h / 1.2), max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}
vec3 atmoExtinction(vec3 d) { return BETA_R * d.x + BETA_ME * d.y + BETA_O * d.z; }

// Far intersection with a sphere around the planet centre (origin inside the sphere).
float raySphereFar(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  return -b + sqrt(max(b * b - c, 0.0));
}

// Transmittance from p toward a light. The planet's shadow edge is softened over the width the
// sun's disk subtends at the tangent point, so twilight has no hard terminator.
vec3 lightTransmittance(vec3 p, vec3 l) {
  float r = length(p);
  float mu = dot(p, l) / r;
  float vis = 1.0;
  if (mu < 0.0) {
    float rMin = r * sqrt(max(1.0 - mu * mu, 0.0));
    float w = max(-mu * r * SUN_ANGULAR_RADIUS, 0.05);
    vis = smoothstep(-w, w, rMin - R_GROUND);
    if (vis <= 0.0) return vec3(0.0);
  }
  float tTop = raySphereFar(p, l, R_TOP);
  vec3 od = vec3(0.0);
  float prev = 0.0;
  for (int i = 0; i < 8; i++) {
    float f = float(i + 1) / 8.0;
    float t1 = tTop * f * f;
    float ds = t1 - prev;
    vec3 q = p + l * (prev + 0.5 * ds);
    prev = t1;
    od += atmoExtinction(atmoDensity(length(q) - R_GROUND)) * ds;
  }
  return exp(-od) * vis;
}

float phaseRayleigh(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float phaseMie(float c) {
  const float g = 0.8;
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
`;

const LUT_FS = GLSL_COMMON + ATMOSPHERE_GLSL + `
in vec2 vUV;
out vec4 o;
uniform float uAlt;     // observer altitude (km)
uniform vec3 uSunI;     // sun scattering intensity
uniform vec3 uMoonI;    // moon scattering intensity (0 skips the moon integral)
uniform vec3 uNight;    // night-sky floor

vec3 scatter(vec3 ro, vec3 rd) {
  float tMax = raySphereFar(ro, rd, R_TOP);
  vec3 S = uSunDir.xyz, M = uMoonDir.xyz;
  float cs = dot(rd, S), cm = dot(rd, M);
  float pRs = phaseRayleigh(cs), pMs = phaseMie(cs);
  float pRm = phaseRayleigh(cm), pMm = phaseMie(cm);
  bool moon = uMoonI.b > 0.0;
  vec3 od = vec3(0.0), sun = vec3(0.0), ms = vec3(0.0), mo = vec3(0.0);
  float prev = 0.0;
  for (int i = 0; i < 16; i++) {
    // Quadratic step distribution: dense air near the observer gets the most samples.
    float f = float(i + 1) / 16.0;
    float t1 = tMax * f * f;
    float ds = t1 - prev;
    vec3 p = ro + rd * (prev + 0.5 * ds);
    prev = t1;
    vec3 dens = atmoDensity(length(p) - R_GROUND);
    vec3 ext = atmoExtinction(dens);
    vec3 tv = exp(-(od + 0.5 * ext * ds));
    od += ext * ds;
    vec3 sR = BETA_R * dens.x;
    float sM = BETA_MS * dens.y;
    vec3 ts = lightTransmittance(p, S);
    sun += tv * ts * (sR * pRs + sM * pMs) * ds;
    // Isotropic proxy for higher scattering orders: lifts and softens the horizon and twilight.
    ms += tv * ts * (sR + sM) * ds;
    if (moon) mo += tv * lightTransmittance(p, M) * (sR * pRm + sM * pMm) * ds;
  }
  return uSunI * (sun + ms * (0.25 / (4.0 * PI))) + uMoonI * mo;
}

void main() {
  vec3 rd = skyLutDir(vUV);
  float below = max(-rd.y, 0.0);
  vec3 d = rd;
  // Below the horizon the LUT continues the colour applyFog() fades distant terrain into (the sky at
  // elevation +0.02), so the void past the render distance matches fogged terrain; it only darkens
  // toward a dim ground when looking steeply down.
  if (d.y < 0.02) { d.y = 0.02; d = normalize(d); }
  vec3 c = scatter(vec3(0.0, R_GROUND + uAlt, 0.0), d);
  // Airglow floor, a little brighter toward the horizon (longer path through the glowing layer).
  c += uNight * (0.75 + 0.6 * exp(-d.y * 6.0));
  if (below > 0.0) c *= mix(1.0, 0.4, smoothstep(0.25, 1.0, below));
  o = vec4(c, 1.0);
}
`;

const IRRADIANCE_FS = GLSL_COMMON + ATMOSPHERE_GLSL + `
out vec4 o;
uniform float uAlt;
uniform vec3 uSunLight;   // sun illuminance above the atmosphere
uniform float uSunDisk;   // sun disk radiance above the atmosphere
uniform vec3 uMoonLight;  // moonlight (already faded + phased)
void main() {
  int i = int(gl_FragCoord.x);
  vec3 ro = vec3(0.0, R_GROUND + uAlt, 0.0);
  vec3 sunT = lightTransmittance(ro, uSunDir.xyz);
  vec3 light = uLightDir.w > 0.5 ? sunT * uSunLight : uMoonLight;
  if (i == 2) { o = vec4(light, 1.0); return; }
  if (i == 3) { o = vec4(sunT * uSunDisk, 1.0); return; }
  // Cosine-weighted hemisphere integral of the LUT (golden-angle spiral, 64 directions).
  vec3 sky = vec3(0.0);
  for (int k = 0; k < 64; k++) {
    float u = (float(k) + 0.5) / 64.0;
    float r = sqrt(u);
    float a = float(k) * 2.39996323;
    vec3 d = vec3(r * cos(a), sqrt(1.0 - u), r * sin(a));
    sky += texture(uSkyLUT, skyLutUV(d)).rgb;
  }
  sky /= 64.0;
  if (i == 0) { o = vec4(sky, 1.0); return; }
  // Ground bounce: albedo ~0.2 lit by the sky and the direct light (part of the ground is shadowed).
  o = vec4(vec3(0.21, 0.2, 0.17) * (light * (max(uLightDir.y, 0.0) * 0.8) + sky), 1.0);
}
`;

const SKY_FS = GLSL_COMMON + `
in vec2 vUV;
out vec4 o;
uniform float uMoonPhase;   // radians: 0 = full, PI = new
uniform float uMoonBright;  // moon disk radiance scale
uniform vec3 uMoonTint;     // atmospheric transmittance toward the moon
const float SUN_R = 0.0093;   // tan(0.53 deg)
const float MOON_R = 0.0165;  // a stylised, slightly large moon
const float TILT = ${SUN_TILT.toFixed(6)};

vec3 rotateAxis(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec3 stars(vec3 dir, float pixAngle) {
  // Star-fixed frame: undo the daily rotation about the celestial pole (normal of the sun's orbit).
  vec3 axis = vec3(0.0, -sin(TILT), cos(TILT));
  vec3 sd = rotateAxis(dir, axis, -uWind.z);
  const float SCALE = 170.0;
  vec3 g = sd * SCALE;
  vec3 cell = floor(g);
  float h = hash13(cell);
  if (h < 0.986) return vec3(0.0);
  vec3 r = hash33(cell + 19.19);
  vec3 sp = normalize(cell + 0.3 + 0.4 * r);
  float d = length(sd - sp) * SCALE;
  // Stars are points: draw them about a pixel wide (no sparkle aliasing) at a fixed peak brightness,
  // shrinking the energy only when a very high resolution would make them sub-pixel.
  float px = pixAngle * SCALE * 0.7;
  float rad = max(px, 0.05);
  float core = exp(-d * d / (rad * rad)) * min(1.0, (px * px) / (rad * rad) * 4.0);
  float mag = pow(fract(h * 37.3 + r.z * 3.1), 5.0) * 0.9 + 0.06;
  float twinkle = 0.7 + 0.3 * sin(uCamPos.w * (2.0 + 4.0 * r.x) + h * 91.0);
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.7), r.y);
  return tint * core * mag * twinkle * 0.3;
}

void main() {
  vec3 dir = normalize(positionFromDepth(vUV, 1.0));
  vec3 col = sampleSky(dir);
  float horizon = smoothstep(-0.012, 0.012, dir.y);
  float pixAngle = 2.0 / (uProj[1][1] * uRes.y);

  // Stars fade in as the sky darkens and are dimmed by extinction near the horizon.
  float starVis = (1.0 - smoothstep(0.006, 0.04, luminance(col))) * smoothstep(0.0, 0.25, dir.y);
  vec3 starCol = starVis > 0.0 ? stars(dir, pixAngle) * starVis : vec3(0.0);

  // Moon: a lit sphere with maria and craters; the terminator follows the phase angle.
  vec3 M = uMoonDir.xyz;
  float cm = dot(dir, M);
  float moonMask = 0.0;
  vec3 moonCol = vec3(0.0);
  if (cm > 0.99) {
    vec3 right = normalize(cross(M, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, M);
    vec2 q = vec2(dot(dir, right), dot(dir, up)) / MOON_R;
    float r2 = dot(q, q);
    float aa = pixAngle / MOON_R;
    moonMask = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, sqrt(r2));
    if (moonMask > 0.0) {
      vec3 n = vec3(q, sqrt(max(1.0 - r2, 0.0)));
      vec3 ls = vec3(sin(uMoonPhase) * 0.94, sin(uMoonPhase) * 0.34, cos(uMoonPhase));
      float lit = smoothstep(-0.03, 0.12, dot(n, ls));
      vec2 tuv = q * 0.16 + vec2(0.37, 0.61);
      vec4 nz = textureLod(uNoise2D, tuv, 0.0);
      vec4 nz2 = textureLod(uNoise2D, tuv * 2.7 + 0.13, 0.0);
      float maria = smoothstep(0.42, 0.68, nz.g);
      float craters = smoothstep(0.62, 0.9, nz2.a) * 0.6 + smoothstep(0.7, 0.95, nz.a) * 0.4;
      float albedo = 0.78 - 0.3 * maria - 0.16 * craters + 0.08 * nz2.r;
      float limb = 0.82 + 0.18 * n.z;
      moonCol = uMoonTint * uMoonBright * albedo * limb * (lit + 0.012);
    }
  }
  col = mix(col + starCol * horizon, col + moonCol * horizon, moonMask);

  // Sun disk with limb darkening; sunDiskRadiance() already carries the atmospheric reddening.
  vec3 S = uSunDir.xyz;
  float cs = dot(dir, S);
  if (cs > 0.999) {
    float r = length(cross(dir, S)) / SUN_R;
    float aa = pixAngle / SUN_R;
    float disk = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
    float mu = sqrt(max(1.0 - r * r, 0.0));
    float limb = 1.0 - 0.56 * (1.0 - mu) - 0.2 * (1.0 - mu * mu);
    col += sunDiskRadiance() * limb * disk * horizon;
  }

  // Tiny multiplicative dither against banding in the smooth gradient.
  col *= 1.0 + (ign(gl_FragCoord.xy) - 0.5) * 0.006;
  o = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Noise textures (generated once at startup)
// ---------------------------------------------------------------------------------------------

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function gradTable2(P, rand) {
  const g = new Float32Array(P * P * 2);
  for (let i = 0; i < P * P; i++) {
    const a = rand() * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
}

// Tileable 2D gradient noise, (x, y) in lattice units, period P; roughly [-0.7, 0.7].
function perlin2(g, P, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P;
  const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
  const a = (y0 * P + x0) * 2, b = (y0 * P + x1) * 2, c = (y1 * P + x0) * 2, d = (y1 * P + x1) * 2;
  const n00 = g[a] * fx + g[a + 1] * fy;
  const n10 = g[b] * (fx - 1) + g[b + 1] * fy;
  const n01 = g[c] * fx + g[c + 1] * (fy - 1);
  const n11 = g[d] * (fx - 1) + g[d + 1] * (fy - 1);
  const u = fade(fx), v = fade(fy);
  const nx0 = n00 + (n10 - n00) * u, nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

function gradTable3(P, rand) {
  const g = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) {
    // Uniform direction on the sphere
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    g[i * 3] = r * Math.cos(a); g[i * 3 + 1] = r * Math.sin(a); g[i * 3 + 2] = z;
  }
  return g;
}

function perlin3(g, P, x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P, z0 = ((zi % P) + P) % P;
  const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P, z1 = (z0 + 1) % P;
  const gx = fx - 1, gy = fy - 1, gz = fz - 1;
  const r00 = (z0 * P + y0) * P, r10 = (z0 * P + y1) * P, r01 = (z1 * P + y0) * P, r11 = (z1 * P + y1) * P;
  let i = (r00 + x0) * 3; const n000 = g[i] * fx + g[i + 1] * fy + g[i + 2] * fz;
  i = (r00 + x1) * 3; const n100 = g[i] * gx + g[i + 1] * fy + g[i + 2] * fz;
  i = (r10 + x0) * 3; const n010 = g[i] * fx + g[i + 1] * gy + g[i + 2] * fz;
  i = (r10 + x1) * 3; const n110 = g[i] * gx + g[i + 1] * gy + g[i + 2] * fz;
  i = (r01 + x0) * 3; const n001 = g[i] * fx + g[i + 1] * fy + g[i + 2] * gz;
  i = (r01 + x1) * 3; const n101 = g[i] * gx + g[i + 1] * fy + g[i + 2] * gz;
  i = (r11 + x0) * 3; const n011 = g[i] * fx + g[i + 1] * gy + g[i + 2] * gz;
  i = (r11 + x1) * 3; const n111 = g[i] * gx + g[i + 1] * gy + g[i + 2] * gz;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const a0 = n000 + (n100 - n000) * u, a1 = n010 + (n110 - n010) * u;
  const b0 = n001 + (n101 - n001) * u, b1 = n011 + (n111 - n011) * u;
  const c0 = a0 + (a1 - a0) * v, c1 = b0 + (b1 - b0) * v;
  return c0 + (c1 - c0) * w;
}

// Map values to the full 0..1 range.
function stretch(values) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const s = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < values.length; i++) values[i] = (values[i] - lo) * s;
  return values;
}

// Distance to the nearest feature point (cell units) on a tileable C x C grid, sampled N x N.
function worley2(N, C, rand) {
  const pts = new Float32Array(C * C * 2);
  for (let i = 0; i < pts.length; i++) pts[i] = rand();
  const out = new Float32Array(N * N);
  const cs = N / C;
  for (let y = 0; y < N; y++) {
    const fy = (y + 0.5) / cs, cy = Math.floor(fy), ly = fy - cy;
    for (let x = 0; x < N; x++) {
      const fx = (x + 0.5) / cs, cx = Math.floor(fx), lx = fx - cx;
      let best = 9;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = (cy + dy + C) % C;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = (cx + dx + C) % C;
          const pi = (ny * C + nx) * 2;
          const ex = dx + pts[pi] - lx, ey = dy + pts[pi + 1] - ly;
          const d2 = ex * ex + ey * ey;
          if (d2 < best) best = d2;
        }
      }
      out[y * N + x] = Math.sqrt(best);
    }
  }
  return out;
}

function worley3(N, C, rand) {
  const pts = new Float32Array(C * C * C * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = rand();
  const out = new Float32Array(N * N * N);
  const cs = N / C, inv = 1 / cs;
  const near = new Float32Array(27 * 3); // feature points of the 27 neighbour cells, relative to the cell
  // Cell by cell, so the neighbour gather runs once per cell rather than once per voxel.
  for (let cz = 0; cz < C; cz++) {
    for (let cy = 0; cy < C; cy++) {
      for (let cx = 0; cx < C; cx++) {
        let k = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = (cz + dz + C) % C;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = (cy + dy + C) % C;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = (cx + dx + C) % C;
              const pi = ((nz * C + ny) * C + nx) * 3;
              near[k++] = dx + pts[pi]; near[k++] = dy + pts[pi + 1]; near[k++] = dz + pts[pi + 2];
            }
          }
        }
        for (let vz = 0; vz < cs; vz++) {
          const lz = (vz + 0.5) * inv, z = cz * cs + vz;
          for (let vy = 0; vy < cs; vy++) {
            const ly = (vy + 0.5) * inv, row = (z * N + cy * cs + vy) * N + cx * cs;
            for (let vx = 0; vx < cs; vx++) {
              const lx = (vx + 0.5) * inv;
              let best = 9;
              for (let j = 0; j < 81; j += 3) {
                const ex = near[j] - lx, ey = near[j + 1] - ly, ez = near[j + 2] - lz;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < best) best = d2;
              }
              out[row + vx] = Math.sqrt(best);
            }
          }
        }
      }
    }
  }
  return out;
}

// uNoise2D: 256^2 RGBA8. r, g, b = tileable fbm with base periods 4, 8, 16 cells; a = inverted Worley (8 cells).
export function generateNoise2D(N = 256, seed = 1337) {
  const rand = mulberry32(seed);
  const out = new Uint8Array(N * N * 4);
  const bases = [4, 8, 16];
  for (let ch = 0; ch < 3; ch++) {
    const octaves = [];
    for (let P = bases[ch], amp = 1; P <= 64; P *= 2, amp *= 0.5) octaves.push({ P, amp, g: gradTable2(P, rand) });
    const v = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0;
        for (const o of octaves) s += perlin2(o.g, o.P, (x + 0.5) / N * o.P, (y + 0.5) / N * o.P) * o.amp;
        v[y * N + x] = s;
      }
    }
    stretch(v);
    for (let i = 0; i < N * N; i++) out[i * 4 + ch] = Math.round(v[i] * 255);
  }
  const w = worley2(N, 8, rand);
  for (let i = 0; i < w.length; i++) w[i] = -w[i];
  stretch(w);
  for (let i = 0; i < N * N; i++) out[i * 4 + 3] = Math.round(w[i] * 255);
  return out;
}

// uNoise3D: 64^3 R8 tileable Perlin-Worley (billowy Worley fbm dilated by Perlin fbm) for cloud erosion.
export function generateNoise3D(N = 64, seed = 4242) {
  const rand = mulberry32(seed);
  const n = N * N * N;
  // Two Worley octaves: the cloud shader samples this texture at two scales, which supplies the
  // finer detail (and a third octave would blow the startup budget).
  const w1 = worley3(N, 4, rand), w2 = worley3(N, 8, rand);
  const g1 = gradTable3(4, rand), g2 = gradTable3(8, rand), g3 = gradTable3(16, rand);
  const v = new Float32Array(n);
  for (let z = 0, i = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++, i++) {
        const px = (x + 0.5) / N, py = (y + 0.5) / N, pz = (z + 0.5) / N;
        const p = perlin3(g1, 4, px * 4, py * 4, pz * 4) + perlin3(g2, 8, px * 8, py * 8, pz * 8) * 0.5 +
          perlin3(g3, 16, px * 16, py * 16, pz * 16) * 0.25;
        const perlin01 = Math.min(1, Math.max(0, p * 0.8 + 0.5));
        const worley = 1 - Math.min(1, w1[i] * 0.7 + w2[i] * 0.3);
        // Perlin-Worley remap: perlin01 remapped from [worley - 1, 1] to [0, 1]
        v[i] = (perlin01 - (worley - 1)) / (2 - worley);
      }
    }
  }
  stretch(v);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(v[i] * 255);
  return out;
}

function createNoise2DTexture(gl) {
  const N = 256;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, generateNoise2D(N));
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return t;
}

function createNoise3DTexture(gl) {
  const N = 64;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, N, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, generateNoise3D(N));
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  return t;
}

// Relative air mass toward elevation `sinEl` (Kasten & Young), used for the moon's reddening.
function airMass(sinEl) {
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl))) * 180 / Math.PI;
  if (el < -2) return 60;
  const e = Math.max(el, 0);
  return 1 / (Math.sin(e * Math.PI / 180) + 0.50572 * Math.pow(e + 6.07995, -1.6364));
}

// ---------------------------------------------------------------------------------------------

export class Atmosphere {
  constructor(gl, hdrFormat = gl.hdrFormat) {
    this.gl = gl;
    this.skyLUT = createTexture2D(gl, SKY_LUT_W, SKY_LUT_H, { ...hdrFormat, filter: gl.LINEAR });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); // azimuth wraps around
    this.lutFB = createFramebuffer(gl, [this.skyLUT]);
    this.irradiance = createTexture2D(gl, 4, 1, { ...hdrFormat, filter: gl.NEAREST });
    this.irrFB = createFramebuffer(gl, [this.irradiance]);
    this.noise2D = createNoise2DTexture(gl);
    this.noise3D = createNoise3DTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_3D, null);

    this.lutProgram = new Program(gl, FULLSCREEN_VS, LUT_FS, 'sky-lut');
    this.irrProgram = new Program(gl, FULLSCREEN_VS, IRRADIANCE_FS, 'irradiance');
    this.skyProgram = new Program(gl, FULLSCREEN_FAR_VS, SKY_FS, 'sky');

    this.day = 0;
    this.lastTimeOfDay = null;
    this.lightQ = null;       // quantised shadow-light direction
    this.lutKey = null;       // inputs the LUT was last rendered with
    this.state = null;
  }

  // Derive the per-frame celestial state from the frame. Cheap; runs every frame.
  prepare(frame) {
    const t = Number.isFinite(frame.timeOfDay) ? frame.timeOfDay : 0.25;
    // Count days (wraps of timeOfDay) so the moon runs through its phases night after night.
    if (this.lastTimeOfDay !== null && t < this.lastTimeOfDay - 0.5) this.day++;
    this.lastTimeOfDay = t;

    let sun = frame.sunDir;
    if (!sun) {
      const a = t * Math.PI * 2;
      sun = [Math.cos(a), Math.sin(a) * Math.cos(SUN_TILT), Math.sin(a) * Math.sin(SUN_TILT)];
    }
    const moon = frame.moonDir || [-sun[0], -sun[1], -sun[2]];
    const sunIsLight = sun[1] > LIGHT_SWITCH_Y;
    const L = sunIsLight ? sun : moon;

    // Move the shadow light in small steps (< 0.07 degrees) so shadow edges don't crawl every frame.
    const q = this.lightQ;
    if (!q || q.sun !== sunIsLight || q.dir[0] * L[0] + q.dir[1] * L[1] + q.dir[2] * L[2] < 0.9999993) {
      this.lightQ = { dir: [L[0], L[1], L[2]], sun: sunIsLight };
    }

    const phase = (((0.06 + (this.day + t) / MOON_CYCLE_DAYS) % 1) + 1) % 1;
    const moonPhase = phase * Math.PI * 2;
    const illum = 0.5 + 0.5 * Math.cos(moonPhase);
    const moonStrength = 0.3 + 0.7 * illum;
    const moonFade = smoothstep(-LIGHT_SWITCH_Y, 0.2, moon[1]);
    const moonLight = MOON_LIGHT.map((c) => c * moonFade * moonStrength);

    const m = airMass(moon[1]);
    const moonTint = [Math.exp(-0.06 * m), Math.exp(-0.12 * m), Math.exp(-0.24 * m)];

    // Fog: a little denser at dawn/dusk (morning haze) and at night.
    const dawnDusk = Math.exp(-((sun[1] / 0.2) ** 2));
    const night = smoothstep(0.05, -0.25, sun[1]);
    const fogDensity = 1.0 + 1.1 * dawnDusk + 0.5 * night;

    this.state = {
      timeOfDay: t,
      sunDir: sun,
      moonDir: moon,
      sunVisibility: smoothstep(-0.02, 0.02, sun[1]),
      moonVisibility: smoothstep(-0.02, 0.02, moon[1]),
      lightDir: this.lightQ.dir,
      lightIsSun: this.lightQ.sun,
      moonPhase,
      moonStrength,
      moonLight,
      moonTint,
      starRotation: t * Math.PI * 2,
      fogDensity,
      night,
      wind: WIND,
    };
    return this.state;
  }

  // Re-render the sky LUT + irradiance when their inputs changed noticeably. The Frame UBO must
  // already hold this frame's sun/moon/light directions.
  update(camY, force = false) {
    const gl = this.gl;
    const s = this.state;
    const alt = 0.2 + Math.max(camY, 0) / 1000;
    const k = this.lutKey;
    const moved = !k || force || k.sunIsLight !== s.lightIsSun ||
      k.sun[0] * s.sunDir[0] + k.sun[1] * s.sunDir[1] + k.sun[2] * s.sunDir[2] < 0.9999985 ||
      Math.abs(k.alt - alt) > 0.02 || Math.abs(k.moonStrength - s.moonStrength) > 0.02 ||
      Math.abs(k.moonLight - s.moonLight[2]) > 0.0004 ||
      k.light[0] * s.lightDir[0] + k.light[1] * s.lightDir[1] + k.light[2] * s.lightDir[2] < 0.9999985;
    if (!moved) return false;
    this.lutKey = {
      sun: s.sunDir.slice(), alt, sunIsLight: s.lightIsSun, moonStrength: s.moonStrength,
      moonLight: s.moonLight[2], light: s.lightDir.slice(),
    };

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lutFB);
    gl.viewport(0, 0, SKY_LUT_W, SKY_LUT_H);
    const p = this.lutProgram.use();
    gl.uniform1f(p.u('uAlt'), alt);
    gl.uniform3f(p.u('uSunI'), SUN_SKY, SUN_SKY, SUN_SKY);
    // The moon-lit sky only matters once the sun is well down; skipping it saves half the work by day.
    const mi = s.sunDir[1] < 0.05 ? SUN_SKY * MOON_SKY * s.moonStrength : 0;
    gl.uniform3f(p.u('uMoonI'), mi, mi, mi);
    gl.uniform3f(p.u('uNight'), NIGHT_FLOOR[0], NIGHT_FLOOR[1], NIGHT_FLOOR[2]);
    drawFullscreen(gl);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.irrFB);
    gl.viewport(0, 0, 4, 1);
    const q = this.irrProgram.use();
    gl.uniform1f(q.u('uAlt'), alt);
    gl.uniform3f(q.u('uSunLight'), SUN_LIGHT[0], SUN_LIGHT[1], SUN_LIGHT[2]);
    gl.uniform1f(q.u('uSunDisk'), SUN_DISK);
    gl.uniform3f(q.u('uMoonLight'), s.moonLight[0], s.moonLight[1], s.moonLight[2]);
    drawFullscreen(gl);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    return true;
  }

  // Full-screen sky on the far plane into the bound scene FBO (touches only pixels at depth 1).
  drawSky() {
    const gl = this.gl;
    const s = this.state;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const p = this.skyProgram.use();
    gl.uniform1f(p.u('uMoonPhase'), s.moonPhase);
    gl.uniform1f(p.u('uMoonBright'), 0.55 * (0.55 + 0.45 * s.moonStrength));
    gl.uniform3f(p.u('uMoonTint'), s.moonTint[0], s.moonTint[1], s.moonTint[2]);
    drawFullscreen(gl);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  dispose() {
    const gl = this.gl;
    for (const t of [this.skyLUT, this.irradiance, this.noise2D, this.noise3D]) gl.deleteTexture(t);
    for (const f of [this.lutFB, this.irrFB]) gl.deleteFramebuffer(f);
    for (const p of [this.lutProgram, this.irrProgram, this.skyProgram]) gl.deleteProgram(p.program);
  }
}
