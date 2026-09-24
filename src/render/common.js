// Shared rendering contract: GLSL header, the Frame uniform block, shared GLSL helpers,
// the JS writer for the Frame block, and the shadow-matrix builder.
// Every render module composes its shaders as GLSL_COMMON + its own code.

import { mat4 } from '../math.js';
import { SEA } from '../blocks.js';

export const SHADOW_DISTORT = 0.85;
export const SHADOW_DEPTH_RANGE = 512; // world units covered by the shadow map depth range
export const CLOUD_BOTTOM = 190;
export const CLOUD_TOP = 250;
export const SKY_LUT_W = 256;
export const SKY_LUT_H = 128;
// uIrradiance layout: IRRADIANCE_TEXELS lighting texels rendered by the atmosphere, then
// 2 x EDGE_BINS texels of far-terrain summary per azimuth uploaded by the renderer.
export const IRRADIANCE_TEXELS = 8;
export const EDGE_BINS = 64;

// ---------------------------------------------------------------------------------------------
// Frame uniform block (std140, binding point 0). Offsets are in floats.
// ---------------------------------------------------------------------------------------------
export const FRAME_OFFSETS = {
  uView: 0,          // mat4 camera-relative view (rotation only; camera sits at the origin)
  uProj: 16,         // mat4 projection
  uViewProj: 32,     // mat4 uProj * uView
  uInvViewProj: 48,  // mat4 inverse(uViewProj): NDC -> camera-relative world position
  uShadowMat: 64,    // mat4 camera-relative world -> light clip space (orthographic, undistorted)
  uCamPos: 80,       // vec4 xyz = camera (eye) world position, w = time in seconds
  uSunDir: 84,       // vec4 xyz = unit vector toward the sun, w = sun visibility 0..1
  uMoonDir: 88,      // vec4 xyz = unit vector toward the moon, w = moon visibility 0..1
  uLightDir: 92,     // vec4 xyz = unit vector toward the shadow-casting light, w = 1 sun / 0 moon
  uRes: 96,          // vec4 xy = current render-target size in pixels, zw = 1 / size
  uCam: 100,         // vec4 x = near, y = far, z = fog end distance (blocks), w = eye sky light 0..1
  uShadow: 104,      // vec4 x = shadows enabled 0/1, y = shadow radius (blocks), z = map size (texels), w = light angular size (tan)
  uEnv: 108,         // vec4 x = camera underwater 0/1, y = frame index, z = cloud coverage 0..1, w = time of day 0..1
  uWind: 112,        // vec4 xy = cloud wind velocity (blocks/s), z = star-field rotation (radians), w = fog density multiplier
  uQuality: 116,     // vec4 x = SSR steps (0 = off), y = volumetric steps (0 = off), z = cloud steps (0 = off), w = PCSS 0/1
};
export const FRAME_FLOATS = 120;

export class FrameUniforms {
  constructor(gl) {
    this.gl = gl;
    this.data = new Float32Array(FRAME_FLOATS);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer);
    gl.bufferData(gl.UNIFORM_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  }

  mat(name, m) { this.data.set(m, FRAME_OFFSETS[name]); }

  vec(name, x = 0, y = 0, z = 0, w = 0) {
    const o = FRAME_OFFSETS[name];
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = w;
  }

  get(name, i = 0) { return this.data[FRAME_OFFSETS[name] + i]; }

  upload() {
    const gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.data);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.buffer);
  }
}

// Orthographic light matrix centred near the camera, in camera-relative space.
// The centre snaps to a 2-block grid so the (distorted) shadow map stays stable while walking.
export function computeShadowMatrix(camPos, lightDir, radius) {
  const cx = Math.floor(camPos[0] / 2) * 2, cy = Math.floor(camPos[1] / 2) * 2, cz = Math.floor(camPos[2] / 2) * 2;
  const centerRel = [cx - camPos[0], cy - camPos[1], cz - camPos[2]];
  const half = SHADOW_DEPTH_RANGE / 2;
  const eye = [centerRel[0] + lightDir[0] * half, centerRel[1] + lightDir[1] * half, centerRel[2] + lightDir[2] * half];
  const up = Math.abs(lightDir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const view = mat4.lookAt(mat4.create(), eye, centerRel, up);
  const proj = mat4.ortho(mat4.create(), -radius, radius, -radius, radius, 0, SHADOW_DEPTH_RANGE);
  return { matrix: mat4.multiply(mat4.create(), proj, view), center: [cx, cy, cz] };
}

// ---------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------
export const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler2DShadow;
precision highp sampler3D;
`;

export const GLSL_FRAME = `
layout(std140) uniform Frame {
  mat4 uView;
  mat4 uProj;
  mat4 uViewProj;
  mat4 uInvViewProj;
  mat4 uShadowMat;
  vec4 uCamPos;
  vec4 uSunDir;
  vec4 uMoonDir;
  vec4 uLightDir;
  vec4 uRes;
  vec4 uCam;
  vec4 uShadow;
  vec4 uEnv;
  vec4 uWind;
  vec4 uQuality;
};
`;

export const GLSL_SAMPLERS = `
uniform sampler2DArray uAlbedo;    // unit 0: sRGB albedo, alpha = cutout
uniform sampler2DArray uNormals;   // unit 1: tangent-space normal (xyz * 0.5 + 0.5)
uniform sampler2DArray uSpecular;  // unit 2: r = smoothness, g = metalness, b = emissive, a = tint mask
uniform sampler2DShadow uShadowCmp;// unit 3: shadow depth (hardware compare, linear)
uniform sampler2D uShadowRaw;      // unit 4: shadow depth (raw, nearest)
uniform sampler2D uSkyLUT;         // unit 5: sky radiance by direction (see skyLutUV)
uniform sampler2D uIrradiance;     // unit 6: 8x1 lighting texels (see helpers below)
uniform sampler2D uNoise2D;        // unit 7: 256^2 tileable noise, rgba = fbm (4, 8, 16 cells), worley
uniform sampler3D uNoise3D;        // unit 8: 64^3 tileable cloud detail noise (r)
`;

export const GLSL_FUNCTIONS = `
#define PI 3.14159265359
const float SEA_LEVEL = ${SEA.toFixed(1)};
const float SHADOW_DISTORT = ${SHADOW_DISTORT};
const float SHADOW_DEPTH_RANGE = ${SHADOW_DEPTH_RANGE.toFixed(1)};
const float CLOUD_BOTTOM = ${CLOUD_BOTTOM.toFixed(1)};
const float CLOUD_TOP = ${CLOUD_TOP.toFixed(1)};
const int IRRADIANCE_TEXELS = ${IRRADIANCE_TEXELS};
const int EDGE_BINS = ${EDGE_BINS};

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Interleaved gradient noise, animated per frame (for dithering ray marches)
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float ignFrame(vec2 p) { return ign(p + 5.588238 * mod(uEnv.y, 64.0)); }

// ---- Pixel-art texturing -----------------------------------------------------------------
// Block textures use LINEAR magnification + anisotropic minification. D3D11 (Chrome on Windows)
// and some Vulkan drivers can't combine NEAREST magnification with anisotropy (they silently
// switch to bilinear), so crispness is produced here instead: when a texel covers more than a
// pixel, snap the lookup to the texel centre, leaving a one-pixel anti-aliased seam between
// texels. Pass the ORIGINAL uv gradients to textureGrad so mip/anisotropy selection is unchanged.
// clampTexels keeps magnified lookups inside the 16x16 tile (no bleed from the opposite edge).
// (A macro so fwidth only expands in fragment shaders; GLSL_COMMON is shared with vertex shaders.)
vec2 pixelArtUVd(vec2 uv, vec2 dTexels, bool clampTexels) {
  vec2 t = uv * 16.0;
  vec2 d = max(dTexels, vec2(1e-5));
  vec2 seam = floor(t + 0.5);
  vec2 s = seam + clamp((t - seam) / min(d, vec2(1.0)), -0.5, 0.5);
  if (clampTexels) s = mix(s, clamp(s, vec2(0.5), vec2(15.5)), step(d, vec2(1.0)));
  return s / 16.0;
}
#define pixelArtUV(uv, clampTexels) pixelArtUVd((uv), fwidth((uv) * 16.0), (clampTexels))

// ---- Depth -------------------------------------------------------------------------------
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  float n = uCam.x, f = uCam.y;
  return 2.0 * n * f / (f + n - z * (f - n));
}
// Camera-relative world position from screen uv (0..1) and depth-buffer value (0..1)
vec3 positionFromDepth(vec2 uv, float depth) {
  vec4 p = uInvViewProj * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

// ---- Shadows -----------------------------------------------------------------------------
// The shadow map is distorted around its centre so texels are densest near the player.
float shadowDistortFactor(vec2 p) { return length(p) * SHADOW_DISTORT + (1.0 - SHADOW_DISTORT); }
vec2 shadowDistort(vec2 p) { return p / shadowDistortFactor(p); }
// Approximate world-space size of one shadow texel at undistorted light-clip xy
float shadowTexelWorld(vec2 p) {
  float f = shadowDistortFactor(p);
  return (2.0 * uShadow.y / uShadow.z) * f * f / (1.0 - SHADOW_DISTORT);
}
// Shadow-map uv (xy) and depth (z), all 0..1, for a camera-relative position
vec3 shadowCoord(vec3 posRel) {
  vec4 c = uShadowMat * vec4(posRel, 1.0);
  c.xy = shadowDistort(c.xy);
  return c.xyz * 0.5 + 0.5;
}

// ---- Sky ---------------------------------------------------------------------------------
// Sky-view LUT: u = azimuth, v = elevation with more resolution near the horizon.
vec2 skyLutUV(vec3 d) {
  float az = atan(d.z, d.x);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI));
  return vec2(az / (2.0 * PI) + 0.5, v);
}
vec3 skyLutDir(vec2 uv) {
  float az = (uv.x - 0.5) * 2.0 * PI;
  float t = uv.y * 2.0 - 1.0;
  float el = sign(t) * t * t * 0.5 * PI;
  return vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
}
vec3 sampleSky(vec3 d) { return textureLod(uSkyLUT, skyLutUV(normalize(d)), 0.0).rgb; } // single level: safe in branches

vec3 skyIrradiance()    { return texelFetch(uIrradiance, ivec2(0, 0), 0).rgb; } // hemisphere above
vec3 groundIrradiance() { return texelFetch(uIrradiance, ivec2(1, 0), 0).rgb; } // bounce from below
vec3 lightColor()       { return texelFetch(uIrradiance, ivec2(2, 0), 0).rgb; } // sun or moon illuminance at the ground
vec3 sunDiskRadiance()  { return texelFetch(uIrradiance, ivec2(3, 0), 0).rgb; } // radiance of the visible sun disk
// Texels 4..7: irradiance of vertical faces toward +X, -X, +Z, -Z (sky side + ground bounce).

// Ambient light arriving at a surface with normal n: an "ambient cube" (squared normal components
// weight the up/down/side irradiances), so faces toward a low sun get its warm sky and the others
// the cool sky opposite.
vec3 ambientLight(vec3 n) {
  vec3 n2 = n * n;
  vec3 ex = texelFetch(uIrradiance, ivec2(n.x >= 0.0 ? 4 : 5, 0), 0).rgb;
  vec3 ez = texelFetch(uIrradiance, ivec2(n.z >= 0.0 ? 6 : 7, 0), 0).rgb;
  vec3 ey = n.y >= 0.0 ? skyIrradiance() : groundIrradiance();
  return (ex * n2.x + ey * n2.y + ez * n2.z) / max(n2.x + n2.y + n2.z, 1e-4);
}

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

// ---- Clouds (coverage shared by volumetric clouds, cloud shadows and reflections) ----------
float cloudCoverage(vec2 xz) {
  vec2 p = xz + uWind.xy * uCamPos.w;
  float n = texture(uNoise2D, p / 3072.0).r * 0.65 + texture(uNoise2D, p / 1100.0 + 0.37).g * 0.35;
  float c = uEnv.z;
  return smoothstep(1.0 - c, 1.0 - c + 0.35, n);
}
// Fraction of direct light that reaches worldPos through the cloud layer (1 = clear)
float cloudShadow(vec3 worldPos) {
  if (uEnv.z <= 0.0 || uLightDir.y < 0.03) return 1.0;
  float mid = 0.5 * (CLOUD_BOTTOM + CLOUD_TOP);
  vec2 p = worldPos.xz + uLightDir.xz / uLightDir.y * (mid - worldPos.y);
  return 1.0 - 0.72 * cloudCoverage(p);
}

// ---- Water optics (per block), shared by the terrain (light reaching underwater faces), the
// underwater view (composite), the water surface seen from below and the underwater light shafts.
// Red is absorbed within a few blocks, green within ~20, blue carries ~30 blocks.
const vec3 WATER_EXT = vec3(0.30, 0.048, 0.03);
// Single-scattering albedo: the colour the water column converges to, per unit of light.
const vec3 WATER_SCATTER = vec3(0.04, 0.3, 0.52);
// Light available for in-scattering at the given depth below the surface (sun + sky, attenuated).
vec3 underwaterLight(float depth) {
  vec3 E = lightColor() * max(uLightDir.y, 0.0) * 0.55 + skyIrradiance() * 0.6;
  return E * exp(-WATER_EXT * depth * 1.2);
}

// ---- Fog / aerial perspective --------------------------------------------------------------
// Haze is an optical depth along the view ray. Its density is concentrated near the ground
// (exponential in altitude, averaged analytically along the ray: valleys are hazy, views from a
// mountain top or straight down are clear) and grows with the horizontal distance relative to the
// render distance (uCam.z = distance at which the loaded area may end): clear foreground, hazy
// distance, whatever the render distance. uWind.w thickens it at dawn/dusk and at night.
// Blue scatters more than red (FOG_SPECTRAL): partly hazed terrain turns blue before it reaches
// the sky colour. The in-scatter colour is the sky right above the horizon at that azimuth (the
// colour an infinitely long ray converges to) or the sky behind the point when looking up.
// Past the loaded area the sky pass draws voidColor(): a virtual sea at sea level seen through
// the same haze. Terrain near the edge dissolves into exactly that colour, so the border of the
// loaded area is invisible at any render distance.
const vec3 FOG_SPECTRAL = vec3(0.7, 0.9, 1.3);
// Mean relative haze density (1 at sea level) along a ray of length dist with direction.y = dirY.
float hazeDensityAlong(float dist, float dirY) {
  const float b = 0.022;
  float camH = max(uCamPos.y - SEA_LEVEL, -20.0);
  float k = dirY * b * dist;
  float f = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
  return exp(-camH * b) * f;
}
float hazeOD(float dist, float horizDist, float dirY) {
  // Quadratic up to the loaded-area edge, linear beyond it (the far sea plane keeps fading
  // gently toward the horizon instead of vanishing at once), plus a little true distance fog.
  float x = horizDist / uCam.z;
  float shape = x < 1.0 ? x * x : x;
  return hazeDensityAlong(dist, dirY) * ((0.5 + 0.25 * uWind.w) * shape + 0.0012 * uWind.w * dist);
}
// Horizontal direction with the same azimuth (safe for straight up/down).
vec3 horizonDir(vec3 d) { return normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5, 0.0, 0.0)); }
// Colour distant terrain fades into: the sky just above the horizon at that azimuth (so the far
// landscape melts into the sky behind it), a little darker (haze in front of the brighter far
// horizon), and greyer under cloud cover.
vec3 hazeColor(vec3 dir) {
  vec3 h = horizonDir(dir);
  vec3 c = sampleSky(vec3(h.x, 0.035, h.z)) * 0.82;
  return mix(c, vec3(luminance(c)) * 0.85, uEnv.z * 0.5);
}
vec3 fogColor(vec3 dir, float skyLight) { return hazeColor(dir) * mix(0.03, 1.0, max(uCam.w, skyLight)); }
// The sky seen through the ground haze layer: thick right at the horizon (where it meets the
// hazed terrain and the void), gone a few degrees up; thinner from high altitude.
float skyHazeT(float dirY) {
  return exp(-0.025 * uWind.w * exp(-max(uCamPos.y - SEA_LEVEL, 0.0) * 0.022) / max(dirY, 1e-3));
}
vec3 hazedSky(vec3 dir) { return mix(hazeColor(dir), sampleSky(dir), skyHazeT(dir.y)); }

// Far-terrain summary at the azimuth of dir (texels after the lighting ones, see EDGE_BINS):
// rgb = mean top albedo of the land near the loaded-area edge, a = ocean fraction; landY = mean
// land height; returns false while there is no data yet.
bool edgeSummary(vec3 dir, out vec4 s, out float landY) {
  float a = atan(dir.z, dir.x) * (float(EDGE_BINS) / (2.0 * PI)) - 0.5;
  float f = fract(a);
  int i0 = int(floor(a)) & (EDGE_BINS - 1), i1 = (i0 + 1) & (EDGE_BINS - 1);
  const int T0 = IRRADIANCE_TEXELS, T1 = IRRADIANCE_TEXELS + EDGE_BINS;
  s = mix(texelFetch(uIrradiance, ivec2(T0 + i0, 0), 0), texelFetch(uIrradiance, ivec2(T0 + i1, 0), 0), f);
  vec4 h = mix(texelFetch(uIrradiance, ivec2(T1 + i0, 0), 0), texelFetch(uIrradiance, ivec2(T1 + i1, 0), 0), f);
  landY = h.r;
  return h.a > 0.5;
}

// What the sky pass shows in direction dir: the sky above the horizon; below it the world past
// the loaded area continued as a flat plane at the height of the terrain near the edge in that
// direction (land with its mean colour, or sea: sky mirror with Fresnel over deep water), fading
// into the horizon haze with distance.
vec3 voidColor(vec3 dir) {
  if (dir.y >= 0.0) return hazedSky(dir);
  vec3 horizon = hazeColor(dir);
  vec4 e;
  float landY;
  if (!edgeSummary(dir, e, landY)) { e = vec4(0.0, 0.0, 0.0, 1.0); landY = SEA_LEVEL; }
  float h = uCamPos.y - mix(landY, SEA_LEVEL + 0.9, e.a);
  if (h < 0.5) return horizon;
  float s = -dir.y;
  float t = h / max(s, 1e-4);
  vec3 T = exp(-hazeOD(t, t * sqrt(max(1.0 - s * s, 0.0)), dir.y) * FOG_SPECTRAL);
  vec3 sunE = lightColor() * max(uLightDir.y, 0.0);
  // Land: lit like rough terrain (part of it in shadow); sea: wave slopes keep grazing
  // reflectance below a mirror's.
  vec3 land = e.rgb * (sunE * 0.6 + skyIrradiance() * 0.8);
  float F = 0.02 + 0.8 * pow(1.0 - s, 5.0);
  vec3 refl = hazedSky(vec3(dir.x, s, dir.z));
  vec3 sea = mix((skyIrradiance() + sunE * 0.8) * vec3(0.004, 0.022, 0.05), refl, F);
  return mix(land, sea, e.a) * T + horizon * (1.0 - T);
}

vec3 applyFog(vec3 color, vec3 posRel, float skyLight) {
  float dist = length(posRel);
  vec3 dir = posRel / max(dist, 1e-4);
  float hd = length(posRel.xz);
  vec3 T = exp(-hazeOD(dist, hd, dir.y) * FOG_SPECTRAL);
  float dark = mix(0.03, 1.0, max(uCam.w, skyLight));
  vec3 c = color * T + hazeColor(dir) * dark * (1.0 - T);
  // Border of the loaded area: dissolve into the colour the sky pass draws behind it.
  float edge = smoothstep(0.84, 1.0, hd / uCam.z);
  if (edge > 0.0) c = mix(c, voidColor(dir) * dark, edge);
  return c;
}
`;

export const GLSL_COMMON = GLSL_HEADER + GLSL_FRAME + GLSL_SAMPLERS + GLSL_FUNCTIONS;

// Vertex inputs + decoder for packed chunk vertices (see src/vertex.js).
export const GLSL_BLOCK_VERTEX = `
layout(location = 0) in uvec4 aPos;
layout(location = 1) in uvec4 aData;
layout(location = 2) in uvec4 aTint;

const vec3 FACE_N[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
const vec3 FACE_T[6] = vec3[6](vec3(0,0,-1), vec3(0,0,1), vec3(1,0,0), vec3(1,0,0), vec3(1,0,0), vec3(-1,0,0));
const vec3 FACE_B[6] = vec3[6](vec3(0,-1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1), vec3(0,-1,0), vec3(0,-1,0));

const uint FLAG_WAVE_LEAVES = 1u;
const uint FLAG_WAVE_PLANT = 2u;
const uint FLAG_UNDERWATER = 4u;
const uint FLAG_PLANT = 8u;

vec3 blockLocalPos() { return vec3(float(aPos.x & 511u), float(aPos.y & 4095u), float(aPos.z & 511u)) * (1.0 / 16.0); }
vec2 blockUV()       { return vec2(float(aPos.x >> 9u), float(aPos.z >> 9u)) * (1.0 / 16.0); }
uint blockFlags()    { return aPos.y >> 12u; }
uint blockLayer()    { return aPos.w; }
uint blockNormal()   { return aData.x & 7u; }
float blockAO()      { return float((aData.x >> 3u) & 3u) / 3.0; }
vec2 blockLight()    { return vec2(aData.yz) / 255.0; } // x = sky, y = block light
vec3 blockTint()     { return vec3(aTint.rgb) / 255.0; }
`;

export const FULLSCREEN_VS = GLSL_COMMON + `
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Same triangle placed on the far plane (depth 1): draw with depthFunc(LEQUAL) to touch only sky pixels.
export const FULLSCREEN_FAR_VS = GLSL_COMMON + `
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}
`;
