// Chunk meshes on the GPU and the three world programs: terrain (opaque + cutout + lava),
// shadow (depth only) and water. See SPEC.md "Terrain renderer".

import { Program } from '../gl.js';
import { GLSL_COMMON, GLSL_BLOCK_VERTEX } from './common.js';
import { setupVertexAttribs, createQuadIndices, WORDS_PER_VERTEX } from '../vertex.js';
import { aabbInFrustum } from '../math.js';
import { CHUNK, HEIGHT } from '../blocks.js';

const WORDS_PER_QUAD = WORDS_PER_VERTEX * 4;
const INITIAL_INDEX_QUADS = 196608;
const WAVE_MARGIN = 0.25; // waving geometry can leave the chunk AABB by this much

// Vogel (golden-angle) disk: n points evenly covering the unit disk.
function vogelGLSL(name, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n), t = i * 2.39996323;
    pts.push(`vec2(${(r * Math.cos(t)).toFixed(4)}, ${(r * Math.sin(t)).toFixed(4)})`);
  }
  return `const vec2 ${name}[${n}] = vec2[${n}](${pts.join(', ')});\n`;
}

// ---------------------------------------------------------------------------------------------
// Shared GLSL (also used by the overlays): wind, block light, GGX, shadows, caustics.
// ---------------------------------------------------------------------------------------------

// Wind sway. Must be identical in the terrain and shadow programs so shadows move with leaves.
export const GLSL_WAVE = `
vec3 waveOffset(vec3 wp, uint flags, float t) {
  if ((flags & (FLAG_WAVE_LEAVES | FLAG_WAVE_PLANT)) == 0u) return vec3(0.0);
  vec3 p = mod(wp, 512.0);
  // Slow gusts travelling across the landscape
  float gust = 0.6 + 0.4 * sin(t * 0.43 + p.x * 0.031 + p.z * 0.023) * sin(t * 0.17 + p.z * 0.011);
  vec3 off = vec3(0.0);
  if ((flags & FLAG_WAVE_LEAVES) != 0u) {
    float ph = dot(p, vec3(0.93, 0.61, 0.77));
    off.x = sin(t * 1.63 + ph) * 0.032 + sin(t * 2.71 + ph * 1.73) * 0.014;
    off.y = sin(t * 2.17 + ph * 1.31) * 0.018;
    off.z = sin(t * 1.91 + ph * 0.83 + 1.3) * 0.032 + sin(t * 3.13 + ph * 1.37) * 0.012;
    off *= gust;
  }
  if ((flags & FLAG_WAVE_PLANT) != 0u) {
    float ph = dot(p.xz, vec2(0.71, 0.53));
    off.x += (sin(t * 1.87 + ph) * 0.075 + sin(t * 3.61 + ph * 2.1) * 0.025 + 0.03) * gust;
    off.z += (sin(t * 1.49 + ph * 1.17 + 0.7) * 0.06 + sin(t * 3.09 + ph * 1.9) * 0.02 + 0.015) * gust;
  }
  return off;
}
`;

export const GLSL_LIGHTING = `
const vec3 TORCH_COLOR = vec3(1.0, 0.62, 0.32);
${vogelGLSL('VOGEL12', 12)}${vogelGLSL('VOGEL10', 10)}${vogelGLSL('VOGEL8', 8)}
// Block light: inverse-square-like falloff over Minecraft light levels (bl = level / 15).
vec3 blockLightColor(float bl, vec3 worldPos) {
  float d = 15.0 * (1.0 - bl);
  float I = bl / (1.0 + 0.08 * d * d) * 3.0;
  float t = uCamPos.w;
  float ph = dot(worldPos, vec3(0.37, 0.21, 0.29));
  float flicker = 1.0 + 0.05 * sin(t * 9.7 + ph) + 0.035 * sin(t * 23.3 + ph * 1.7) + 0.02 * sin(t * 41.0 + ph * 0.6);
  return TORCH_COLOR * (I * flicker);
}

vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }

float ggxD(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
float smithVis(float NdotV, float NdotL, float a) {
  float k = a * 0.5;
  return 0.25 / ((NdotV * (1.0 - k) + k) * (NdotL * (1.0 - k) + k));
}
vec3 fresnelSchlick(vec3 F0, float c) { return F0 + (1.0 - F0) * pow(1.0 - saturate(c), 5.0); }
// GGX specular BRDF * N.L for a directional light (multiply by its illuminance)
vec3 specularGGX(vec3 N, vec3 V, vec3 L, vec3 F0, float a) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-3);
  float NdotH = max(dot(N, H), 0.0);
  return ggxD(NdotH, a) * smithVis(NdotV, NdotL, a) * fresnelSchlick(F0, dot(V, H)) * NdotL;
}

// Split-sum environment BRDF, analytic fit (Karis, "Physically Based Shading on Mobile")
vec3 envBRDF(vec3 F0, float rough, float NdotV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * AB.x + AB.y;
}
// Radiance reflected toward R: the sky above, dim ground bounce below, blurred toward the
// ambient hemisphere as roughness grows.
vec3 envReflection(vec3 R, float rough) {
  vec3 skyC = sampleSky(vec3(R.x, max(R.y, 0.0) + 0.02, R.z));
  vec3 sharp = mix(groundIrradiance() * 0.8, skyC, smoothstep(-0.2, 0.05, R.y));
  return mix(sharp, ambientLight(R), saturate(rough * 1.5));
}

// Visibility of the shadow-casting light (1 = lit) at a camera-relative position.
// offsetDir: direction of the normal offset (geometric normal, or the light direction for thin
// plants). fallback is used outside the shadow map, with a fade near its border.
// sss receives the fraction of light that makes it through thin foliage (1 = unoccluded).
float shadowVisibility(vec3 posRel, vec3 offsetDir, float fallback, bool soft, out float sss) {
  sss = fallback;
  vec4 lc = uShadowMat * vec4(posRel, 1.0);
  float edge = max(abs(lc.x), abs(lc.y));
  if (edge > 0.99 || abs(lc.z) > 0.999) return fallback;
  float f = shadowDistortFactor(lc.xy);
  float texelWorld = (2.0 * uShadow.y / uShadow.z) * f * f / (1.0 - SHADOW_DISTORT);
  vec3 sc = shadowCoord(posRel + offsetDir * (texelWorld * 1.5 + 0.02));
  sc.z -= 0.00005;
  float texel = 1.0 / uShadow.z;
  float uvPerBlock = (1.0 - SHADOW_DISTORT) / (2.0 * uShadow.y * f * f);
  float a = ignFrame(gl_FragCoord.xy) * 6.2831853;
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  float vis = 0.0;
  float thickness;
  if (soft) {
    // PCSS: average blocker depth -> penumbra width from the light's angular size.
    float searchR = max(0.9 * uvPerBlock, 3.0 * texel);
    float sum = 0.0, n = 0.0;
    float d0 = textureLod(uShadowRaw, sc.xy, 0.0).r;
    if (d0 < sc.z) { sum += d0; n += 1.0; }
    for (int i = 0; i < 10; i++) {
      float d = textureLod(uShadowRaw, sc.xy + rot * VOGEL10[i] * searchR, 0.0).r;
      if (d < sc.z) { sum += d; n += 1.0; }
    }
    if (n < 0.5) { vis = 1.0; thickness = 0.0; }
    else {
      float blocker = sum / n;
      thickness = (sc.z - blocker) * SHADOW_DEPTH_RANGE;
      float pen = clamp(thickness * uShadow.w * uvPerBlock, texel, 1.5 * uvPerBlock);
      for (int i = 0; i < 12; i++) vis += texture(uShadowCmp, vec3(sc.xy + rot * VOGEL12[i] * pen, sc.z));
      vis *= 1.0 / 12.0;
    }
  } else {
    float r = 1.6 * texel;
    for (int i = 0; i < 8; i++) vis += texture(uShadowCmp, vec3(sc.xy + rot * VOGEL8[i] * r, sc.z));
    vis *= 0.125;
    thickness = max(sc.z - textureLod(uShadowRaw, sc.xy, 0.0).r, 0.0) * SHADOW_DEPTH_RANGE;
  }
  // Light scattered through a few blocks of foliage (thickness = distance to the first occluder)
  float trans = max(vis, exp(-max(thickness - 0.3, 0.0) * 0.9));
  float fade = smoothstep(0.85, 0.98, edge);
  sss = mix(trans, fallback, fade);
  return mix(vis, fallback, fade);
}

// Cheap single-sample-ring shadow (water surface, particles, held block)
float shadowSimple(vec3 posRel, vec3 offsetDir, float fallback) {
  vec4 lc = uShadowMat * vec4(posRel, 1.0);
  float edge = max(abs(lc.x), abs(lc.y));
  if (uShadow.x < 0.5 || edge > 0.99 || abs(lc.z) > 0.999) return fallback;
  float f = shadowDistortFactor(lc.xy);
  float texelWorld = (2.0 * uShadow.y / uShadow.z) * f * f / (1.0 - SHADOW_DISTORT);
  vec3 sc = shadowCoord(posRel + offsetDir * (texelWorld * 1.5 + 0.02));
  sc.z -= 0.00005;
  float r = 1.5 / uShadow.z;
  float vis = 0.0;
  for (int i = 0; i < 4; i++) vis += texture(uShadowCmp, vec3(sc.xy + VOGEL8[i * 2] * r, sc.z));
  return mix(vis * 0.25, fallback, smoothstep(0.85, 0.98, edge));
}

// Underwater caustics: two drifting, mutually distorted Worley layers. Distance-to-feature peaks
// along cell borders, so a narrow high band of it traces the bright caustic network. Mean ~1.
float caustics(vec2 p, float t) {
  vec2 q = p * (1.0 / 22.0);
  vec2 w = vec2(texture(uNoise2D, q * 0.3 + t * vec2(0.0041, 0.0029)).r, texture(uNoise2D, q * 0.3 + t * vec2(0.0041, 0.0029) + 0.5).b) - 0.5;
  float a = 1.0 - texture(uNoise2D, q + w * 0.35 + t * vec2(0.010, 0.0061)).a;
  float b = 1.0 - texture(uNoise2D, q * 1.37 - w * 0.3 + vec2(0.37, 0.71) - t * vec2(0.0083, 0.0102)).a;
  float ea = saturate((a - 0.45) * 2.2), eb = saturate((b - 0.45) * 2.2);
  return 0.4 + 3.2 * (ea * ea + eb * eb) * 0.7;
}
`;

// ---------------------------------------------------------------------------------------------
// Terrain program
// ---------------------------------------------------------------------------------------------
const TERRAIN_VS = GLSL_COMMON + GLSL_BLOCK_VERTEX + GLSL_WAVE + `
uniform vec3 uChunkOffset;   // chunk origin - camera (computed in doubles)
uniform vec3 uChunkWorld;    // chunk origin in world blocks (exact)
uniform uvec4 uTwoSided[2];  // bit per texture layer: cutout layers are drawn double-sided

out vec3 vPosRel;
out vec3 vWorld;
out vec2 vUV;
out float vAO;
out vec2 vLight;
out vec3 vTint;
flat out uint vLayer;
flat out uint vFace;
flat out uint vFlags;

void main() {
  vec3 local = blockLocalPos();
  uint flags = blockFlags();
  uint face = blockNormal();
  uint layer = blockLayer();
  vec3 world = uChunkWorld + local;
  vec3 posRel = uChunkOffset + local;

  // Face culling happens here instead of in the rasterizer so cutout faces (leaves, glass) can be
  // seen from behind. A face is planar, so all four vertices agree on the facing test.
  float facing = dot(FACE_N[face], posRel);
  bool plant = (flags & FLAG_PLANT) != 0u;
  bool twoSided = plant || (flags & FLAG_WAVE_LEAVES) != 0u || (layer < 256u &&
    ((uTwoSided[int(layer >> 7u)][int((layer >> 5u) & 3u)] >> (layer & 31u)) & 1u) != 0u);
  if (facing > 0.0 && !twoSided) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // outside the clip volume: the whole quad is dropped
    return;
  }
  // Seen from behind, push the face back a hair so a coplanar neighbour face wins the depth test.
  if (facing > 0.0 && !plant) posRel += FACE_N[face] * 0.004;

  vec3 wave = waveOffset(world, flags, uCamPos.w);
  posRel += wave;
  world += wave;

  vPosRel = posRel;
  vWorld = world;
  vUV = blockUV();
  vAO = blockAO();
  vLight = blockLight();
  vTint = pow(blockTint(), vec3(2.2)); // tints are sRGB; multiply in linear like vanilla does in sRGB
  vLayer = layer;
  vFace = face;
  vFlags = flags;
  gl_Position = uViewProj * vec4(posRel, 1.0);
}
`;

const TERRAIN_FS = GLSL_COMMON + `
const uint FLAG_WAVE_LEAVES = 1u;
const uint FLAG_WAVE_PLANT = 2u;
const uint FLAG_UNDERWATER = 4u;
const uint FLAG_PLANT = 8u;
const vec3 FACE_N[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
const vec3 FACE_T[6] = vec3[6](vec3(0,0,-1), vec3(0,0,1), vec3(1,0,0), vec3(1,0,0), vec3(1,0,0), vec3(-1,0,0));
const vec3 FACE_B[6] = vec3[6](vec3(0,-1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1), vec3(0,-1,0), vec3(0,-1,0));
` + GLSL_LIGHTING + `
uniform int uLavaLayer;

in vec3 vPosRel;
in vec3 vWorld;
in vec2 vUV;
in float vAO;
in vec2 vLight;
in vec3 vTint;
flat in uint vLayer;
flat in uint vFace;
flat in uint vFlags;

out vec4 fragColor;

void main() {
  float t = uCamPos.w;
  bool plant = (vFlags & FLAG_PLANT) != 0u;
  bool leaves = (vFlags & FLAG_WAVE_LEAVES) != 0u;
  bool lava = int(vLayer) == uLavaLayer;
  // Plants come with both windings (and torches are closed boxes): shade only the copy facing us.
  if (plant && !gl_FrontFacing) discard;

  // ---- Material ----
  vec2 uv = vUV;
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  if (lava) {
    // Slow churning flow: world-space noise distortion (continuous across blocks) + drift
    vec2 wp = vWorld.xz + vWorld.y * 0.37;
    vec2 n1 = texture(uNoise2D, wp * 0.043 + t * vec2(0.0061, 0.0043)).rg - 0.5;
    vec2 n2 = texture(uNoise2D, wp * 0.11 - t * vec2(0.0093, 0.0071)).gb - 0.5;
    uv += n1 * 0.55 + n2 * 0.18 + vec2(t * 0.013, t * 0.021);
    uv = fract(uv); // derivatives come from the unwrapped uv, so no seams at the wrap
  }
  vec3 tc = vec3(pixelArtUV(uv, !lava), float(vLayer));
  vec4 albedo = textureGrad(uAlbedo, tc, gx, gy);
  if (albedo.a < 0.5) discard;
  vec4 spec = textureGrad(uSpecular, tc, gx, gy);
  vec3 base = albedo.rgb * mix(vec3(1.0), vTint, spec.a);
  float smoothness = spec.r, metal = spec.g, emissive = spec.b;

  // ---- Normals ----
  vec3 Ng = FACE_N[vFace];
  vec3 N;
  if (plant) {
    Ng = vec3(0.0, 1.0, 0.0);
    N = Ng;
  } else {
    if (!gl_FrontFacing) Ng = -Ng;
    if (lava) N = Ng;
    else {
      vec3 nt = textureGrad(uNormals, tc, gx, gy).xyz * 2.0 - 1.0;
      N = normalize(FACE_T[vFace] * nt.x + FACE_B[vFace] * nt.y + FACE_N[vFace] * max(nt.z, 0.05));
      if (!gl_FrontFacing) N = -N;
    }
  }

  vec3 posRel = vPosRel;
  float dist = length(posRel);
  vec3 V = -posRel / max(dist, 1e-4);
  vec3 L = uLightDir.xyz;
  float sky = vLight.x, blk = vLight.y;
  float ao = vAO;
  float aoCurve = ao * ao * 0.55 + ao * 0.35 + 0.1;

  // ---- Direct light (sun or moon) ----
  float caveGate = smoothstep(0.1, 0.45, sky);
  float skyFallback = smoothstep(0.8, 0.97, sky);
  float NdotLgeo = dot(Ng, L);
  float NdotL = plant ? saturate(L.y) * 0.55 + 0.3 : max(dot(N, L), 0.0) * smoothstep(0.0, 0.08, NdotLgeo);
  vec3 sunE = lightColor() * cloudShadow(vWorld) * caveGate;
  float shadow = 1.0, sss = 1.0;
  bool thin = plant || leaves;
  if (caveGate > 0.0 && (NdotL > 0.0 || thin)) {
    if (uShadow.x > 0.5) {
      shadow = shadowVisibility(posRel, plant ? L : Ng, skyFallback, uQuality.w > 0.5, sss);
    } else {
      shadow = skyFallback;
      sss = skyFallback;
    }
  }

  vec3 diffuse = base * (1.0 - metal);
  vec3 direct = sunE * (NdotL * shadow * mix(1.0, aoCurve, 0.35));

  // Foliage / plant translucency: light from behind glows through the leaves
  vec3 trans = vec3(0.0);
  if (thin) {
    float VdotL = saturate(dot(-V, L));
    float back = pow(VdotL, 4.0) * 1.6 + saturate(-NdotLgeo) * 0.35 + 0.12;
    trans = sunE * sss * back * (leaves ? 0.55 : 0.45);
  }

  // Underwater: caustics and wavelength-dependent absorption of sunlight on the way down
  vec3 ambientTint = vec3(1.0);
  if ((vFlags & FLAG_UNDERWATER) != 0u && vWorld.y < SEA_LEVEL) {
    float depth = SEA_LEVEL - vWorld.y;
    float Ly = max(L.y, 0.12);
    vec2 cp = vWorld.xz + L.xz / Ly * depth;
    float c = caustics(cp, t);
    vec3 absorb = exp(-vec3(0.33, 0.085, 0.045) * (depth / Ly + depth));
    direct *= absorb * mix(c, 1.0, saturate(depth * 0.035));
    trans *= absorb;
    ambientTint = exp(-vec3(0.22, 0.06, 0.035) * depth);
  }

  // ---- Ambient + block light ----
  vec3 ambient = ambientLight(N) * (sky * sky) * aoCurve * ambientTint + 0.004 * aoCurve;
  vec3 torch = blockLightColor(blk, vWorld) * aoCurve;

  vec3 color = diffuse * (direct + ambient + torch) + base * trans;

  // ---- Specular ----
  if (!plant && !lava) {
    float rough = 1.0 - smoothness;
    vec3 F0 = mix(vec3(0.04), base, metal);
    color += sunE * shadow * specularGGX(N, V, L, F0, max(rough * rough, 0.02)) * mix(1.0, aoCurve, 0.35) * step(0.0, NdotLgeo);
    // Environment reflection (sky, blurred with roughness); torch-lit surroundings in caves
    vec3 R = reflect(-V, N);
    vec3 env = envReflection(R, rough) * (sky * sky) + blockLightColor(blk, vWorld) * 0.3;
    color += env * envBRDF(F0, rough, max(dot(N, V), 1e-3)) * aoCurve;
  }

  // ---- Emission ----
  if (lava) {
    float pulse = 0.85 + 0.15 * sin(t * 1.3 + dot(vWorld.xz, vec2(0.35, 0.27)));
    color += base * (0.6 + 2.6 * emissive) * pulse;
  } else {
    color += base * emissive * 4.0;
  }

  // Under water the composite pass applies the water's own absorption/in-scatter instead.
  if (uEnv.x < 0.5) color = applyFog(color, posRel, max(sky, lava ? 0.6 : 0.0));
  fragColor = vec4(color, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Shadow program
// ---------------------------------------------------------------------------------------------
const SHADOW_VS = GLSL_COMMON + GLSL_BLOCK_VERTEX + GLSL_WAVE + `
uniform vec3 uChunkOffset;
uniform vec3 uChunkWorld;
out vec2 vUV;
flat out uint vLayer;
void main() {
  vec3 local = blockLocalPos();
  vec3 wave = waveOffset(uChunkWorld + local, blockFlags(), uCamPos.w);
  vec4 p = uShadowMat * vec4(uChunkOffset + local + wave, 1.0);
  p.xy = shadowDistort(p.xy);
  vUV = blockUV();
  vLayer = blockLayer();
  gl_Position = p;
}
`;

const SHADOW_FS = GLSL_COMMON + `
in vec2 vUV;
flat in uint vLayer;
out vec4 fragColor;
void main() {
  if (textureGrad(uAlbedo, vec3(pixelArtUV(vUV, true), float(vLayer)), dFdx(vUV), dFdy(vUV)).a < 0.5) discard;
  fragColor = vec4(1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Water program
// ---------------------------------------------------------------------------------------------
const WATER_VS = GLSL_COMMON + GLSL_BLOCK_VERTEX + `
uniform vec3 uChunkOffset;
uniform vec3 uChunkWorld;
out vec3 vPosRel;
out vec3 vWorld;
out vec2 vLight;
out vec3 vTint;
flat out uint vFace;
void main() {
  vec3 local = blockLocalPos();
  vPosRel = uChunkOffset + local;
  vWorld = uChunkWorld + local;
  vLight = blockLight();
  vTint = pow(blockTint(), vec3(2.2));
  vFace = blockNormal();
  gl_Position = uViewProj * vec4(vPosRel, 1.0);
}
`;

const WATER_FS = GLSL_COMMON + `
const vec3 FACE_N[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
const vec3 FACE_T[6] = vec3[6](vec3(0,0,-1), vec3(0,0,1), vec3(1,0,0), vec3(1,0,0), vec3(1,0,0), vec3(-1,0,0));
const vec3 FACE_B[6] = vec3[6](vec3(0,-1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1), vec3(0,-1,0), vec3(0,-1,0));
` + GLSL_LIGHTING + `
uniform sampler2D uSceneColor; // unit 10: opaque scene colour (HDR)
uniform sampler2D uSceneDepth; // unit 11: opaque scene depth

in vec3 vPosRel;
in vec3 vWorld;
in vec2 vLight;
in vec3 vTint;
flat in uint vFace;

out vec4 fragColor;

// Wave height field: three scrolled noise layers at different scales and directions.
float waveHeight(vec2 p, float t) {
  float h = texture(uNoise2D, p * 0.017 + t * vec2(0.0071, 0.0043)).r * 0.5;
  h += texture(uNoise2D, mat2(0.8, -0.6, 0.6, 0.8) * p * 0.041 + t * vec2(-0.0123, 0.0089)).g * 0.32;
  h += texture(uNoise2D, mat2(0.28, 0.96, -0.96, 0.28) * p * 0.093 + t * vec2(0.0171, -0.0197)).b * 0.18;
  return h;
}
// Returns the slope (dh/du, dh/dv)
vec2 waveSlope(vec2 p, float t) {
  const float e = 0.07;
  float h0 = waveHeight(p, t);
  return vec2(waveHeight(p + vec2(e, 0.0), t) - h0, waveHeight(p + vec2(0.0, e), t) - h0) / e;
}

// Clouds seen in a reflection: coverage where the ray crosses the middle of the cloud layer.
vec3 skyReflection(vec3 R, vec3 worldPos) {
  vec3 d = normalize(vec3(R.x, max(R.y, 0.02), R.z));
  vec3 s = sampleSky(d);
  if (uQuality.z > 0.5 && uEnv.z > 0.0 && d.y > 0.03) {
    float mid = 0.5 * (CLOUD_BOTTOM + CLOUD_TOP);
    float tHit = max(mid - worldPos.y, 10.0) / d.y;
    float cov = cloudCoverage(worldPos.xz + d.xz * tHit);
    float fade = exp(-tHit * 0.00035) * smoothstep(0.03, 0.2, d.y);
    float mu = dot(d, uLightDir.xyz);
    vec3 cloud = lightColor() * (0.35 + 0.8 * henyeyGreenstein(mu, 0.55)) * uLightDir.w + skyIrradiance() * 0.9 + lightColor() * 0.05;
    s = mix(s, cloud, cov * fade * 0.85);
  }
  return s;
}

vec2 projectUV(vec3 p, out float w) {
  vec4 c = uViewProj * vec4(p, 1.0);
  w = c.w;
  return c.xy / c.w * 0.5 + 0.5;
}

// Screen-space reflection in camera-relative space against the depth copy.
vec3 traceSSR(vec3 origin, vec3 R, float jitter, out float hit) {
  hit = 0.0;
  int steps = int(uQuality.x);
  float stepLen = 0.25 + length(origin) * 0.012;
  float t = stepLen * (0.3 + jitter);
  float prevT = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    vec3 q = origin + R * t;
    float w;
    vec2 uv = projectUV(q, w);
    if (w < uCam.x || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sd = textureLod(uSceneDepth, uv, 0.0).r;
    float diff = w - linearDepth(sd);
    if (sd < 1.0 && diff > 0.0 && diff < stepLen * 2.5 + 0.4) {
      float lo = prevT, hi = t;
      for (int j = 0; j < 5; j++) {
        float m = 0.5 * (lo + hi);
        float wm;
        vec2 um = projectUV(origin + R * m, wm);
        if (wm > linearDepth(textureLod(uSceneDepth, um, 0.0).r)) hi = m; else lo = m;
      }
      float wh;
      vec2 uh = projectUV(origin + R * hi, wh);
      vec2 e = smoothstep(0.0, 0.06, uh) * smoothstep(1.0, 0.94, uh);
      hit = e.x * e.y * (1.0 - smoothstep(0.55, 1.0, float(i + 1) / float(steps)));
      return textureLod(uSceneColor, uh, 0.0).rgb;
    }
    prevT = t;
    t += stepLen;
    stepLen *= 1.25;
  }
  return vec3(0.0);
}

void main() {
  float t = uCamPos.w;
  vec3 posRel = vPosRel;
  float dist = length(posRel);
  vec3 I = posRel / max(dist, 1e-4); // camera -> surface
  vec3 V = -I;
  float sky = vLight.x;
  bool below = !gl_FrontFacing;

  // ---- Wave normal (tangent frame of the face; sides flow downward) ----
  vec3 Ng = FACE_N[vFace], T = FACE_T[vFace], B = FACE_B[vFace];
  vec2 p = vec2(dot(vWorld, T), dot(vWorld, B));
  if (vFace != 2u && vFace != 3u) p = p * vec2(1.0, 0.5) - vec2(0.0, t * 0.9);
  float strength = 0.33 / (1.0 + dist * 0.018);
  vec2 slope = waveSlope(p, t) * strength;
  vec3 N = normalize(Ng - T * slope.x - B * slope.y);
  if (below) { N = -N; Ng = -Ng; }

  // ---- Light at the surface ----
  vec3 L = uLightDir.xyz;
  float caveGate = smoothstep(0.1, 0.45, sky);
  float fallback = smoothstep(0.8, 0.97, sky);
  float shadow = shadowSimple(posRel, below ? -Ng : Ng, fallback);
  vec3 sunE = lightColor() * cloudShadow(vWorld) * caveGate * shadow;
  vec3 skyE = skyIrradiance() * (sky * sky);
  vec3 inE = skyE + sunE * saturate(L.y) * 0.8 + blockLightColor(vLight.y, vWorld) * 0.5 + 0.002;

  // Water optics from the biome colour: red goes first, then green; blue travels far.
  vec3 tint = vTint;
  vec3 sigmaA = (vec3(1.0) - tint) * vec3(0.32, 0.16, 0.08) + vec3(0.075, 0.018, 0.009);
  vec3 scatterAlb = tint * vec3(0.04, 0.13, 0.15);
  vec3 deep = inE * scatterAlb;

  vec2 suv = gl_FragCoord.xy * uRes.zw;
  float waterZ = linearDepth(gl_FragCoord.z);
  float rayScale = dist / max(waterZ, 1e-3);
  vec3 nView = mat3(uView) * (N - Ng);

  vec3 color;
  if (!below) {
    // ---- Refraction + absorption ----
    float d0 = textureLod(uSceneDepth, suv, 0.0).r;
    float thick0 = max(linearDepth(d0) - waterZ, 0.0) * rayScale;
    vec2 ruv = suv + nView.xy * (0.09 * saturate(thick0 * 0.5)) / (1.0 + waterZ * 0.04);
    float rd = textureLod(uSceneDepth, ruv, 0.0).r;
    if (linearDepth(rd) < waterZ) { ruv = suv; rd = d0; }
    vec3 refr = textureLod(uSceneColor, ruv, 0.0).rgb;
    float path = rd >= 1.0 ? 1e4 : max(linearDepth(rd) - waterZ, 0.0) * rayScale;
    vec3 Tr = exp(-sigmaA * path);
    vec3 water = refr * Tr + deep * (1.0 - Tr);

    // Shoreline foam where the water is very thin
    float foamN = texture(uNoise2D, vWorld.xz * 0.21 + t * vec2(0.013, -0.009)).b;
    float foam = (1.0 - smoothstep(0.0, 0.35, path)) * smoothstep(0.35, 0.7, foamN + (0.35 - min(path, 0.35)));
    water = mix(water, inE * 0.7, foam * 0.55);

    // ---- Reflection ----
    vec3 R = reflect(I, N);
    if (R.y < 0.0 && vFace == 2u) R.y = -R.y;
    float skyVis = sky * sky;
    vec3 refl = skyReflection(R, vWorld) * skyVis;
    if (uQuality.x > 0.5) {
      float hit;
      vec3 ssr = traceSSR(posRel + Ng * 0.02, R, ign(gl_FragCoord.xy), hit);
      refl = mix(refl, ssr, hit);
    }
    float NdotV = max(dot(N, V), 0.0);
    float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
    F *= 1.0 - foam * 0.6;
    vec3 glint = sunE * specularGGX(N, V, L, vec3(0.02), 0.045) * step(0.0, dot(Ng, L));
    color = mix(water, refl, F) + glint;
  } else {
    // ---- Seen from below: Snell's window, total internal reflection outside it ----
    vec3 Tdir = refract(I, N, 1.333);
    vec3 above = textureLod(uSceneColor, suv + nView.xy * 0.04, 0.0).rgb;
    if (dot(Tdir, Tdir) < 1e-4) {
      color = deep;
    } else {
      float cosT = saturate(dot(Tdir, -N));
      float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
      color = mix(above, deep, F);
    }
  }

  if (uEnv.x < 0.5) color = applyFog(color, posRel, sky);
  fragColor = vec4(color, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------

export class TerrainRenderer {
  constructor(gl, textureSet) {
    this.gl = gl;
    this.textureSet = textureSet;
    this.chunks = new Map();   // key -> { cx, cz, minY, maxY, opaque, water }
    this.stats = { chunks: 0, drawCalls: 0, quads: 0, shadowChunks: 0, waterChunks: 0, loaded: 0 };
    this._phase = '';
    this._list = [];
    // Opaque pass face culling: false (default) culls in the vertex shader so cutout faces (leaves,
    // glass) are two-sided; true uses plain GL back-face culling (single-sided leaves, a bit cheaper).
    this.cullOpaque = false;

    this.terrain = new Program(gl, TERRAIN_VS, TERRAIN_FS, 'terrain');
    this.shadow = new Program(gl, SHADOW_VS, SHADOW_FS, 'shadow');
    this.water = new Program(gl, WATER_VS, WATER_FS, 'water');
    this.water.samplers({ uSceneColor: 10, uSceneDepth: 11 });

    const lava = textureSet && textureSet.layerOf && textureSet.layerOf.lava;
    this.terrain.use();
    gl.uniform1i(this.terrain.u('uLavaLayer'), Number.isInteger(lava) ? lava : -1);
    const bits = new Uint32Array(8);
    const cutout = textureSet && textureSet.cutout;
    if (cutout) for (let i = 0; i < Math.min(cutout.length, 256); i++) if (cutout[i]) bits[i >> 5] |= 1 << (i & 31);
    gl.uniform4uiv(this.terrain.u('uTwoSided[0]'), bits);
    gl.useProgram(null);

    this.loc = {
      terrain: { off: this.terrain.u('uChunkOffset'), world: this.terrain.u('uChunkWorld') },
      shadow: { off: this.shadow.u('uChunkOffset'), world: this.shadow.u('uChunkWorld') },
      water: { off: this.water.u('uChunkOffset'), world: this.water.u('uChunkWorld') },
    };

    this.indexQuads = 0;
    this.ibo = gl.createBuffer();
    this._ensureIndices(INITIAL_INDEX_QUADS);
  }

  // Shared quad index buffer; regrown in place when a mesh needs more quads (VAOs reference the
  // buffer object, so they pick up the new storage without re-binding).
  _ensureIndices(quads) {
    if (quads <= this.indexQuads) return;
    const gl = this.gl;
    let n = Math.max(INITIAL_INDEX_QUADS, this.indexQuads);
    while (n < quads) n *= 2;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, createQuadIndices(n), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    this.indexQuads = n;
  }

  _setMesh(mesh, data, quads) {
    const gl = this.gl;
    if (!quads || !data) {
      if (mesh) this._freeMesh(mesh);
      return null;
    }
    this._ensureIndices(quads);
    if (!mesh) {
      mesh = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), quads: 0 };
      gl.bindVertexArray(mesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      setupVertexAttribs(gl);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bindVertexArray(null);
    }
    const words = Math.min(data.length, quads * WORDS_PER_QUAD);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, words), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    mesh.quads = Math.floor(words / WORDS_PER_QUAD);
    return mesh;
  }

  _freeMesh(mesh) {
    this.gl.deleteVertexArray(mesh.vao);
    this.gl.deleteBuffer(mesh.vbo);
  }

  upload(cx, cz, msg) {
    const key = `${cx},${cz}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { cx, cz, minY: 0, maxY: HEIGHT, opaque: null, water: null, d2: 0 };
      this.chunks.set(key, c);
    }
    c.minY = Number.isFinite(msg.minY) ? msg.minY : 0;
    c.maxY = Number.isFinite(msg.maxY) ? msg.maxY : HEIGHT; // exclusive: top of the geometry
    c.opaque = this._setMesh(c.opaque, msg.opaque, msg.opaqueQuads);
    c.water = this._setMesh(c.water, msg.water, msg.waterQuads);
    this.stats.loaded = this.chunks.size;
  }

  remove(cx, cz) {
    const key = `${cx},${cz}`;
    const c = this.chunks.get(key);
    if (!c) return;
    if (c.opaque) this._freeMesh(c.opaque);
    if (c.water) this._freeMesh(c.water);
    this.chunks.delete(key);
    this.stats.loaded = this.chunks.size;
  }

  clear() {
    for (const c of this.chunks.values()) {
      if (c.opaque) this._freeMesh(c.opaque);
      if (c.water) this._freeMesh(c.water);
    }
    this.chunks.clear();
    this.stats.loaded = 0;
  }

  // Stats cover one frame: the first pass of a frame (shadow, or opaque when shadows are off) resets them.
  _beginPass(phase) {
    const s = this.stats;
    if (phase === 'shadow' || (phase === 'opaque' && this._phase !== 'shadow')) {
      s.chunks = 0; s.drawCalls = 0; s.quads = 0; s.shadowChunks = 0; s.waterChunks = 0;
    }
    this._phase = phase;
  }

  // Visible chunks that have the given mesh, sorted by distance (front-to-back, or back-to-front).
  _collect(view, kind, backToFront) {
    const cam = view.camPos, fr = view.frustum;
    const list = this._list;
    list.length = 0;
    for (const c of this.chunks.values()) {
      if (!c[kind]) continue;
      const x0 = c.cx * CHUNK - cam[0], z0 = c.cz * CHUNK - cam[2];
      const y0 = c.minY - cam[1], y1 = c.maxY - cam[1];
      if (fr && !aabbInFrustum(fr, x0 - WAVE_MARGIN, y0 - WAVE_MARGIN, z0 - WAVE_MARGIN,
        x0 + CHUNK + WAVE_MARGIN, y1 + WAVE_MARGIN, z0 + CHUNK + WAVE_MARGIN)) continue;
      const dx = x0 + CHUNK / 2, dz = z0 + CHUNK / 2;
      const dy = Math.max(y0, Math.min(0, y1));
      c.d2 = dx * dx + dz * dz + dy * dy;
      list.push(c);
    }
    list.sort(backToFront ? (a, b) => b.d2 - a.d2 : (a, b) => a.d2 - b.d2);
    return list;
  }

  _drawList(list, kind, loc, cam) {
    const gl = this.gl;
    let quads = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const m = c[kind];
      const ox = c.cx * CHUNK, oz = c.cz * CHUNK;
      gl.uniform3f(loc.off, ox - cam[0], -cam[1], oz - cam[2]);
      gl.uniform3f(loc.world, ox, 0, oz);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.quads * 6, gl.UNSIGNED_INT, 0);
      quads += m.quads;
    }
    gl.bindVertexArray(null);
    this.stats.drawCalls += list.length;
    this.stats.quads += quads;
    return quads;
  }

  _restoreState() {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  // Into the bound shadow FBO. view = { camPos, shadowCenter, shadowRadius, time, shadowMatrix? }
  drawShadow(view) {
    const gl = this.gl;
    this._beginPass('shadow');
    const cam = view.camPos;
    const center = view.shadowCenter || cam;
    const radius = view.shadowRadius || 128;
    const m = view.shadowMatrix; // optional: camera-relative light matrix for exact culling
    let reach = radius + 16;
    if (m) {
      // A low light stretches the map's footprint along its azimuth (radius / sin(elevation));
      // gather that far and let the exact light-space box test pick the casters.
      const sinEl = Math.abs(m[6]) / (Math.hypot(m[2], m[6], m[10]) || 1);
      reach = Math.min(radius / Math.max(sinEl, 0.3), radius * 2) + 16;
    }
    const list = this._list;
    list.length = 0;
    for (const c of this.chunks.values()) {
      if (!c.opaque) continue;
      const x0 = c.cx * CHUNK, z0 = c.cz * CHUNK;
      const dx = Math.max(x0 - center[0], 0, center[0] - (x0 + CHUNK));
      const dz = Math.max(z0 - center[2], 0, center[2] - (z0 + CHUNK));
      if (dx * dx + dz * dz > reach * reach) continue;
      if (m && !boxInLightClip(m, x0 - cam[0], c.minY - WAVE_MARGIN - cam[1], z0 - cam[2], CHUNK, c.maxY - c.minY + 2 * WAVE_MARGIN)) continue;
      list.push(c);
    }
    if (!list.length) return;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    this.shadow.use();
    this._drawList(list, 'opaque', this.loc.shadow, cam);
    this.stats.shadowChunks = list.length;
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    this._restoreState();
  }

  // Opaque + cutout + lava into the bound scene FBO. view = { camPos, frustum, time }
  drawOpaque(view) {
    const gl = this.gl;
    this._beginPass('opaque');
    const list = this._collect(view, 'opaque', false);
    this.stats.chunks = list.length;
    if (!list.length) return;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    if (this.cullOpaque) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    this.terrain.use();
    this._drawList(list, 'opaque', this.loc.terrain, view.camPos);
    this._restoreState();
  }

  // Water surfaces into the scene FBO; scene colour copy on unit 10, depth copy on unit 11.
  drawWater(view) {
    const gl = this.gl;
    this._beginPass('water');
    const list = this._collect(view, 'water', true);
    this.stats.waterChunks = list.length;
    if (!list.length) return;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    this.water.use();
    this._drawList(list, 'water', this.loc.water, view.camPos);
    this._restoreState();
  }

  dispose() {
    this.clear();
    const gl = this.gl;
    gl.deleteBuffer(this.ibo);
    gl.deleteProgram(this.terrain.program);
    gl.deleteProgram(this.shadow.program);
    gl.deleteProgram(this.water.program);
  }
}

// Does a camera-relative box (x0..x0+w, y0..y0+h, z0..z0+w) touch the light's clip volume?
function boxInLightClip(m, x0, y0, z0, w, h) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = x0 + (i & 1 ? w : 0), y = y0 + (i & 2 ? h : 0), z = z0 + (i & 4 ? w : 0);
    const px = m[0] * x + m[4] * y + m[8] * z + m[12];
    const py = m[1] * x + m[5] * y + m[9] * z + m[13];
    const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  return maxX >= -1 && minX <= 1 && maxY >= -1 && minY <= 1 && maxZ >= -1 && minZ <= 1;
}
