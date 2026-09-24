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
uniform sampler2D uIrradiance;     // unit 6: 4x1 lighting texels (see helpers below)
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
vec2 pixelArtUV(vec2 uv, bool clampTexels) {
  vec2 t = uv * 16.0;
  vec2 d = max(fwidth(t), vec2(1e-5));
  vec2 seam = floor(t + 0.5);
  vec2 s = seam + clamp((t - seam) / min(d, vec2(1.0)), -0.5, 0.5);
  if (clampTexels) s = mix(s, clamp(s, vec2(0.5), vec2(15.5)), step(d, vec2(1.0)));
  return s / 16.0;
}

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
vec3 sampleSky(vec3 d) { return texture(uSkyLUT, skyLutUV(normalize(d))).rgb; }

vec3 skyIrradiance()    { return texelFetch(uIrradiance, ivec2(0, 0), 0).rgb; } // hemisphere above
vec3 groundIrradiance() { return texelFetch(uIrradiance, ivec2(1, 0), 0).rgb; } // bounce from below
vec3 lightColor()       { return texelFetch(uIrradiance, ivec2(2, 0), 0).rgb; } // sun or moon illuminance at the ground
vec3 sunDiskRadiance()  { return texelFetch(uIrradiance, ivec2(3, 0), 0).rgb; } // radiance of the visible sun disk

// Ambient light arriving at a surface with normal n (hemisphere blend)
vec3 ambientLight(vec3 n) {
  float up = n.y * 0.5 + 0.5;
  return skyIrradiance() * up + groundIrradiance() * (1.0 - up);
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

// ---- Fog / aerial perspective --------------------------------------------------------------
// Exponential height fog toward the sky colour, plus a hard fade near the render distance so
// chunk loading is hidden. skyLight (0..1) of the shaded point keeps cave fog dark.
float heightFogAmount(float dist, float dirY) {
  float a = 0.0017 * uWind.w;
  float b = 0.035;
  float camH = max(uCamPos.y - SEA_LEVEL, -20.0);
  float k = dirY * b * dist;
  float f = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
  return a * exp(-camH * b) * dist * f;
}
vec3 fogColor(vec3 dir, float skyLight) {
  vec3 c = sampleSky(vec3(dir.x, max(dir.y, 0.0) + 0.02, dir.z));
  return c * mix(0.03, 1.0, max(uCam.w, skyLight));
}
vec3 applyFog(vec3 color, vec3 posRel, float skyLight) {
  float dist = length(posRel);
  vec3 dir = posRel / max(dist, 1e-4);
  float fog = 1.0 - exp(-heightFogAmount(dist, dir.y));
  float edge = smoothstep(uCam.z * 0.72, uCam.z * 0.98, dist);
  fog = max(fog, edge);
  return mix(color, fogColor(dir, skyLight), saturate(fog));
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
