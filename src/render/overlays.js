// Overlays drawn around the terrain: block selection outline, particles and the first-person
// held block. See SPEC.md "Overlays and particles".

import { Program } from '../gl.js';
import { GLSL_COMMON, GLSL_BLOCK_VERTEX } from './common.js';
import { setupVertexAttribs, createQuadIndices, packVertex, FACES, QUAD_UV, WORDS_PER_VERTEX } from '../vertex.js';
import { GLSL_LIGHTING } from './terrain.js';
import { PARTICLE_FLOATS, MAX_PARTICLES } from '../particles.js';
import { BLOCKS, SHAPE, SHAPE_CUBE, SHAPE_CROSS, SHAPE_TORCH } from '../blocks.js';
import { defaultTint } from '../textures.js';

const FS_DEFS = `
const vec3 FACE_N[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
`;

// ---------------------------------------------------------------------------------------------
// Selection outline: 12 edges expanded to screen-space quads of constant pixel width.
// ---------------------------------------------------------------------------------------------
const SELECTION_VS = GLSL_COMMON + `
layout(location = 0) in vec3 aA;    // edge endpoints in unit-box coordinates
layout(location = 1) in vec3 aB;
layout(location = 2) in vec2 aSE;   // x = side (-1/+1), y = end (0 = A, 1 = B)
uniform vec3 uBoxMin;               // camera-relative box corner (computed in doubles)
uniform vec3 uBoxSize;
uniform float uWidth;               // pixels
void main() {
  vec4 va = uView * vec4(uBoxMin + aA * uBoxSize, 1.0);
  vec4 vb = uView * vec4(uBoxMin + aB * uBoxSize, 1.0);
  // Clip the edge against the near plane so edges passing beside the camera stay stable.
  float nz = -uCam.x * 1.05;
  if (va.z > nz && vb.z > nz) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  if (va.z > nz) va = mix(va, vb, (va.z - nz) / (va.z - vb.z));
  if (vb.z > nz) vb = mix(vb, va, (vb.z - nz) / (vb.z - va.z));
  // Pull slightly toward the eye so the outline wins against the block faces it hugs.
  va.xyz *= 0.996; vb.xyz *= 0.996;
  vec4 ca = uProj * va, cb = uProj * vb;
  vec2 half_ = uRes.xy * 0.5;
  vec2 sa = ca.xy / ca.w * half_, sb = cb.xy / cb.w * half_;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = aSE.y < 0.5 ? ca : cb;
  vec2 off = (nrm * aSE.x + dir * (aSE.y * 2.0 - 1.0)) * (uWidth * 0.5);
  c.xy += off / half_ * c.w;
  gl_Position = c;
}
`;
const SELECTION_FS = GLSL_COMMON + `
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }
`;

// ---------------------------------------------------------------------------------------------
// Particles: camera-facing billboards, instanced.
// ---------------------------------------------------------------------------------------------
const PARTICLE_VS = GLSL_COMMON + `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aPosSize;
layout(location = 2) in vec4 aTex;
layout(location = 3) in vec4 aTint;
layout(location = 4) in vec4 aLight;
uniform vec3 uOriginRel;            // particle origin - camera (computed in doubles)
out vec3 vPosRel;
out vec3 vUV;
out vec3 vTint;
out vec2 vLight;
out float vWater;
flat out vec3 vCenter;
void main() {
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
  vec3 up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vec3 center = uOriginRel + aPosSize.xyz;
  vec2 o = aCorner - 0.5;
  vec3 p = center + (right * o.x + up * o.y) * aPosSize.w;
  vPosRel = p;
  vCenter = center;
  vUV = vec3(aTex.xy + vec2(aCorner.x, 1.0 - aCorner.y) * aTex.z, aTex.w);
  vTint = pow(aTint.rgb, vec3(2.2));
  vWater = aTint.w;
  vLight = aLight.xy;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;
const PARTICLE_FS = GLSL_COMMON + FS_DEFS + GLSL_LIGHTING + `
in vec3 vPosRel;
in vec3 vUV;
in vec3 vTint;
in vec2 vLight;
in float vWater;
flat in vec3 vCenter;
layout(location = 0) out vec4 fragColor;
// TAA: particles move on their own (no motion vectors): z = reactive, the resolve keeps little
// history there instead of smearing them.
layout(location = 1) out vec4 fragMotion;
void main() {
  fragMotion = vec4(0.0, 0.0, 1.0, 0.0);
  vec3 tc = vec3(pixelArtUVOut(vUV.xy, false), vUV.z);
  vec2 gx = dFdx(vUV.xy) * footprintScale(), gy = dFdy(vUV.xy) * footprintScale();
  vec4 albedo = textureGrad(uAlbedo, tc, gx, gy);
  if (albedo.a < 0.5) discard;
  vec4 spec = textureGrad(uSpecular, tc, gx, gy);
  vec3 base = albedo.rgb * mix(vec3(1.0), vTint, max(spec.a, vWater));
  vec3 world = uCamPos.xyz + vCenter;
  vec3 L = uLightDir.xyz;
  float sky = vLight.x;
  float caveGate = smoothstep(0.1, 0.45, sky);
  float sh = shadowSimple(vCenter, L, smoothstep(0.8, 0.97, sky));
  vec3 sunE = lightColor() * cloudShadow(world) * caveGate * sh;
  // A tiny tumbling cube: average of its lit faces
  vec3 V = normalize(-vPosRel);
  float diff = 0.3 + 0.45 * saturate(L.y) + 0.25 * saturate(dot(V, L));
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 color = base * (sunE * diff + ambientLight(up) * (sky * sky) * 0.85 + blockLightColor(vLight.y, world) + 0.004);
  color += base * spec.b * 4.0;
  if (vWater > 0.5) color += sunE * 0.04 + sampleSky(reflect(-V, up)) * 0.06 * sky;
  fragColor = vec4(uEnv.x < 0.5 ? applyFog(color, vPosRel, sky) : color, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Held block: own projection, lit like the world at the eye. It is drawn after the TAA resolve
// (never jittered, never accumulated), so its outline is anti-aliased analytically instead: each
// cube face is pushed out by one pixel across its silhouette edges (edges whose other face looks
// away from the eye) and fades from full to zero coverage over the pixel either side of the true
// edge; the front and back planes of flat sprites get a one-pixel alpha coverage ramp, and their
// 1/16-deep side walls (seen at a grazing angle they are thinner than a pixel, bright with Fresnel,
// and rasterise as a dotted line) have their silhouette edge pushed out on screen, perpendicular
// to the wall, to at least two pixels and are box-filtered back to their true width. The result
// is alpha-blended over the scene.
// ---------------------------------------------------------------------------------------------
const HELD_VS = GLSL_COMMON + GLSL_BLOCK_VERTEX + `
uniform mat4 uModelView;   // block-local (0..1) -> camera view space
uniform vec4 uProjParams;  // x = f / aspect, y = f, z = near, w = far
uniform float uEdgeAA;     // 1: cube mesh (silhouette edge fade)
uniform vec2 uScreen;      // target size in pixels
out vec2 vFaceUV;          // position on the face along its two edge axes (0..1 on the face)
flat out vec4 vSil;        // 1 where the edge (+A, -A, +B, -B) is a silhouette edge
flat out float vPlane;     // 1 on sprite front/back planes (alpha coverage ramp)
flat out float vWall;      // 1 on sprite side walls (coverage across the extrusion)
out float vExtr;           // across a side wall: 0 at its true silhouette edge, 1 where it meets the visible plane
out vec3 vUV;
out vec3 vTv;
out vec3 vBv;
out vec3 vNv;
out vec3 vPosV;
out vec3 vTint;
out float vAO;
vec4 heldClip(vec3 p) {
  vec4 v = uModelView * vec4(p, 1.0);
  float n = uProjParams.z, f = uProjParams.w;
  return vec4(v.x * uProjParams.x, v.y * uProjParams.y, (v.z * (f + n) + 2.0 * f * n) / (n - f), -v.z);
}
vec2 heldScreen(vec3 p) { vec4 c = heldClip(p); return c.xy / c.w * 0.5 * uScreen; }

void main() {
  vec3 local = blockLocalPos();
  uint face = blockNormal();
  vec3 A = abs(FACE_T[face]), B = abs(FACE_B[face]);
  vec2 fuv = vec2(dot(local, A), dot(local, B));
  vec4 sil = vec4(0.0);
  if (uEdgeAA > 0.5) {
    mat3 mv = mat3(uModelView);
    // The neighbour face across each edge: silhouette if it faces away from the eye (origin).
    vec3 dirs[4] = vec3[4](A, -A, B, -B);
    for (int i = 0; i < 4; i++) {
      vec3 c = (uModelView * vec4(0.5 + 0.5 * dirs[i], 1.0)).xyz;
      if (dot(mv * dirs[i], -c) <= 0.0) sil += vec4(i == 0, i == 1, i == 2, i == 3);
    }
    // Push vertices on silhouette edges out by 1.5 pixels (the fade covers [-0.5, 0.5] px around
    // the true edge). The texture coordinates stay: the face is stretched by a pixel, invisibly.
    vec2 s0 = heldScreen(local);
    float ea = 0.015 / max(length(heldScreen(local + A * 0.01) - s0), 1e-4);
    float eb = 0.015 / max(length(heldScreen(local + B * 0.01) - s0), 1e-4);
    if (fuv.x > 0.5 && sil.x > 0.5) local += A * ea;
    if (fuv.x < 0.5 && sil.y > 0.5) local -= A * ea;
    if (fuv.y > 0.5 && sil.z > 0.5) local += B * eb;
    if (fuv.y < 0.5 && sil.w > 0.5) local -= B * eb;
  }
  // Sprite side walls run from the back plane (z = 7/16) to the front plane (z = 8/16). The edge
  // shared with the plane that faces the eye is covered by that plane; the other one is the
  // silhouette: only it is moved and faded. It is pushed along the wall's normal (outward, and
  // across the wall on screen) until the wall is 2 px wide; vExtr is set so that it stays linear
  // across the drawn wall with 0 on the true silhouette.
  vWall = 0.0;
  vExtr = 1.0;
  if (uEdgeAA < 0.5 && face < 4u) {
    vWall = 1.0;
    vec3 cv = (uModelView * vec4(local, 1.0)).xyz;
    float front = dot(mat3(uModelView) * vec3(0.0, 0.0, 1.0), -cv) > 0.0 ? 1.0 : -1.0;  // +1: front plane visible
    float side = local.z < 7.5 / 16.0 ? -1.0 : 1.0;                   // this vertex: back or front edge
    if (side == -front) {
      vec3 L = face < 2u ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);  // along the wall
      vec2 s0 = heldScreen(local);
      vec2 ext = heldScreen(local - vec3(0.0, 0.0, side / 16.0)) - s0;  // to the shared edge, on screen
      vec2 run = heldScreen(local + L * (1.0 / 16.0)) - s0;
      vec2 perp = normalize(vec2(-run.y, run.x) + vec2(1e-6));
      float wv = dot(ext, perp);
      vec2 outward = wv > 0.0 ? -perp : perp;                          // away from the shared edge
      float w = abs(wv);                                               // wall width in pixels
      float extra = max(2.0 - w, 0.0);
      float dp = dot(heldScreen(local + FACE_N[face] * 0.01) - s0, outward);   // px per 0.01 along the normal
      vExtr = 0.0;
      if (extra > 0.0 && dp > 0.05) {
        local += FACE_N[face] * min(0.01 * extra / dp, 0.1);
        vExtr = -min(extra / max(w, 1e-3), 1e4);
      }
    }
  }
  vSil = sil;
  vFaceUV = vec2(dot(local, A), dot(local, B));
  vPlane = face >= 4u ? 1.0 : 0.0;
  vec4 pv = uModelView * vec4(local, 1.0);
  mat3 m = mat3(uModelView);
  vTv = m * FACE_T[face];
  vBv = m * FACE_B[face];
  vNv = m * FACE_N[face];
  vUV = vec3(blockUV(), float(blockLayer()));
  vTint = pow(blockTint(), vec3(2.2));
  vAO = blockAO();
  vPosV = pv.xyz;
  gl_Position = heldClip(local);
}
`;
const HELD_FS = GLSL_COMMON + FS_DEFS + GLSL_LIGHTING + `
uniform vec2 uHeldLight;   // x = eye sky exposure 0..1, y = block light 0..1
uniform float uEdgeAA;
in vec2 vFaceUV;
flat in vec4 vSil;
flat in float vPlane;
flat in float vWall;
in float vExtr;
in vec3 vUV;
in vec3 vTv;
in vec3 vBv;
in vec3 vNv;
in vec3 vPosV;
in vec3 vTint;
in float vAO;
out vec4 fragColor;
void main() {
  vec3 tc = vec3(pixelArtUV(vUV.xy, true), vUV.z);
  vec2 gx = dFdx(vUV.xy), gy = dFdy(vUV.xy);
  vec4 albedo = textureGrad(uAlbedo, tc, gx, gy);
  // Coverage: on sprite planes the magnified alpha crosses 0.5 over one pixel (pixelArtUV leaves
  // a one-pixel seam), so it ramps; cube faces fade across their silhouette edges.
  float cover = albedo.a < 0.5 ? 0.0 : 1.0;
  if (uEdgeAA < 0.5 && vPlane > 0.5) cover = saturate((albedo.a - 0.5) / max(fwidth(albedo.a), 1e-3) + 0.5);
  // Side wall: box filter across its silhouette edge (vExtr = 0), and at most its true width in
  // pixels (1 / (2 hw)): a sub-pixel wall adds only the light it really covers.
  float hw = 0.5 * length(vec2(dFdx(vExtr), dFdy(vExtr)));
  if (vWall > 0.5) cover *= saturate((vExtr + hw) / max(2.0 * hw, 1e-4)) * saturate(0.5 / max(hw, 1e-4));
  if (uEdgeAA > 0.5) {
    vec2 fw = max(fwidth(vFaceUV), vec2(1e-5));
    vec4 d = vec4(1.0 - vFaceUV.x, vFaceUV.x, 1.0 - vFaceUV.y, vFaceUV.y) / fw.xxyy;
    vec4 c = mix(vec4(1.0), clamp(d + 0.5, 0.0, 1.0), vSil);
    cover *= min(min(c.x, c.y), min(c.z, c.w));
  }
  if (cover <= 0.004) discard;
  vec4 spec = textureGrad(uSpecular, tc, gx, gy);
  vec3 base = albedo.rgb * mix(vec3(1.0), vTint, spec.a);
  vec3 nt = textureGrad(uNormals, tc, gx, gy).xyz * 2.0 - 1.0;
  vec3 Nv = normalize(normalize(vTv) * nt.x + normalize(vBv) * nt.y + normalize(vNv) * max(nt.z, 0.05));
  mat3 viewToWorld = transpose(mat3(uView));
  vec3 N = viewToWorld * Nv;
  vec3 V = viewToWorld * normalize(-vPosV);
  vec3 L = uLightDir.xyz;
  float sky = uHeldLight.x, blk = uHeldLight.y;
  // The eye's sky exposure is a coarser measure than per-vertex sky light: map it gently.
  float gate = smoothstep(0.05, 0.4, sky);
  float sh = shadowSimple(vec3(0.0, -0.3, 0.0), L, smoothstep(0.5, 0.95, sky));
  vec3 sunE = lightColor() * cloudShadow(uCamPos.xyz) * gate * sh;
  float ao = 0.55 + 0.45 * vAO;
  float metal = spec.g, smoothness = spec.r;
  vec3 color = base * (1.0 - metal) * (sunE * max(dot(N, L), 0.0) + ambientLight(N) * sky * ao
    + blockLightColor(blk, uCamPos.xyz) + 0.006);
  float rough = 1.0 - smoothness;
  vec3 F0 = mix(vec3(0.04), base, metal);
  color += sunE * specularGGX(N, V, L, F0, max(rough * rough, 0.03));
  color += (envReflection(reflect(-V, N), rough) * sky + blockLightColor(blk, uCamPos.xyz) * 0.3) * envBRDF(F0, rough, max(dot(N, V), 1e-3));
  color += base * spec.b * 4.0;
  fragColor = vec4(color, cover);
}
`;

// Bounds (in blocks) of the outline for shapes that don't fill their cell.
function shapeBounds(id) {
  const s = id > 0 ? SHAPE[id] : SHAPE_CUBE;
  if (s === SHAPE_TORCH) return [6 / 16, 0, 6 / 16, 10 / 16, 10 / 16, 10 / 16];
  if (s === SHAPE_CROSS) return [2 / 16, 0, 2 / 16, 14 / 16, 13 / 16, 14 / 16];
  return [0, 0, 0, 1, 1, 1];
}

// Small column-major matrix helpers for the held-block transform.
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function translate(x, y, z) { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; }
function scale(s) { const m = ident(); m[0] = m[5] = m[10] = s; return m; }
function ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
function rotX(a) { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
function rotY(a) { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
function rotZ(a) { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
const DEG = Math.PI / 180;

export class Overlays {
  constructor(gl, textureSet) {
    this.gl = gl;
    this.textureSet = textureSet;
    this.selection = new Program(gl, SELECTION_VS, SELECTION_FS, 'selection');
    this.particles = new Program(gl, PARTICLE_VS, PARTICLE_FS, 'particles');
    this.held = new Program(gl, HELD_VS, HELD_FS, 'held');
    this._initSelection();
    this._initParticles();
    this.heldMeshes = new Map();
    this.heldIbo = gl.createBuffer();
    this.heldIndexQuads = 0;
    this._lastHeld = -1;
    this._equipStart = -1;
    this._lastTime = 0;
  }

  _initSelection() {
    const gl = this.gl;
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
    const edges = [];
    for (let i = 0; i < 8; i++) for (let b = 0; b < 3; b++) if (!(i & (1 << b))) edges.push([corners[i], corners[i | (1 << b)]]);
    const data = new Float32Array(edges.length * 4 * 8);
    const idx = new Uint16Array(edges.length * 6);
    let o = 0;
    edges.forEach(([a, b], e) => {
      for (const [side, end] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
        data.set([...a, ...b, side, end], o);
        o += 8;
      }
      idx.set([e * 4, e * 4 + 1, e * 4 + 2, e * 4, e * 4 + 2, e * 4 + 3], e * 6);
    });
    this.selVao = gl.createVertexArray();
    gl.bindVertexArray(this.selVao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.selCount = idx.length;
    const p = this.selection;
    this.selLoc = { min: p.u('uBoxMin'), size: p.u('uBoxSize'), width: p.u('uWidth'), color: p.u('uColor') };
  }

  _initParticles() {
    const gl = this.gl;
    this.partVao = gl.createVertexArray();
    gl.bindVertexArray(this.partVao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.partBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_PARTICLES * PARTICLE_FLOATS * 4, gl.DYNAMIC_DRAW);
    const stride = PARTICLE_FLOATS * 4;
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.partLoc = { origin: this.particles.u('uOriginRel') };
  }

  // Thin dark outline around the targeted block, drawn in the scene FBO after water.
  drawSelection(view, block) {
    if (!block) return;
    const gl = this.gl;
    const cam = view.camPos;
    const b = shapeBounds(block.id);
    const e = 0.002;
    const p = this.selection;
    p.use();
    gl.uniform3f(this.selLoc.min, block.x + b[0] - e - cam[0], block.y + b[1] - e - cam[1], block.z + b[2] - e - cam[2]);
    gl.uniform3f(this.selLoc.size, b[3] - b[0] + 2 * e, b[4] - b[1] + 2 * e, b[5] - b[2] + 2 * e);
    const rh = view.height || gl.getParameter(gl.VIEWPORT)[3] || 720;
    // Width in pixels of the image the player sees: with temporal upscaling that is the output
    // (view.outputHeight), converted to render pixels, at least one render pixel.
    const oh = view.outputHeight || rh;
    gl.uniform1f(this.selLoc.width, Math.max(Math.max(1.6, 2.4 * oh / 1080) * rh / oh, 1));
    gl.uniform4f(this.selLoc.color, 0.0, 0.0, 0.0, 0.62);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.bindVertexArray(this.selVao);
    gl.drawElements(gl.TRIANGLES, this.selCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  // Lit, alpha-tested debris in the opaque scene pass. particles = ParticleSystem.
  drawParticles(view, particles) {
    if (!particles || !particles.count) return;
    const gl = this.gl;
    const n = Math.min(particles.count, MAX_PARTICLES);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, particles.gpu, 0, n * PARTICLE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const cam = view.camPos, o = particles.origin;
    this.particles.use();
    gl.uniform3f(this.partLoc.origin, o[0] - cam[0], o[1] - cam[1], o[2] - cam[2]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.partVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  _heldMesh(id) {
    let m = this.heldMeshes.get(id);
    if (m !== undefined) return m;
    const data = buildHeldMesh(this.textureSet, id);
    if (!data) { this.heldMeshes.set(id, null); return null; }
    const gl = this.gl;
    if (data.quads > this.heldIndexQuads) {
      this.heldIndexQuads = Math.max(2048, data.quads);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.heldIbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, createQuadIndices(this.heldIndexQuads), gl.STATIC_DRAW);
    }
    m = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), quads: data.quads, sprite: data.sprite };
    gl.bindVertexArray(m.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.verts, gl.STATIC_DRAW);
    setupVertexAttribs(gl);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.heldIbo);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.heldMeshes.set(id, m);
    return m;
  }

  // First-person held block in the lower right, into whichever FBO is bound (depth already cleared).
  // held = { blockId, swing 0..1, equip 0..1, bobX, bobY, light: [sky, block] }
  drawHeld(view, held) {
    if (!held || !(held.blockId > 0)) { this._lastHeld = -1; return; }
    const gl = this.gl;
    const mesh = this._heldMesh(held.blockId);
    if (!mesh) return;

    // Hotbar switch: the new block rises in from below (Minecraft's equip animation).
    const now = Number.isFinite(view.time) ? view.time : performance.now() / 1000;
    if (now < this._lastTime) this._equipStart = -1; // time restarted
    this._lastTime = now;
    if (held.blockId !== this._lastHeld) {
      if (this._lastHeld !== -1) this._equipStart = now;
      this._lastHeld = held.blockId;
    }
    let lower = 0;
    if (this._equipStart >= 0) {
      const k = Math.min(1, (now - this._equipStart) / 0.22);
      lower = 1 - k * k * (3 - 2 * k);
      if (k >= 1) this._equipStart = -1;
    }
    // held.equip: 1 right after a switch (lowered) easing back to 0. The local switch detection
    // above covers callers that don't animate it.
    if (Number.isFinite(held.equip)) lower = Math.max(lower, Math.min(1, Math.max(0, held.equip)));

    const sw = Number.isFinite(held.swing) ? Math.min(1, Math.max(0, held.swing)) : 0;
    const sr = Math.sin(Math.sqrt(sw) * Math.PI);  // fast out, slow return
    const sq = Math.sin(sw * sw * Math.PI);
    const bx = held.bobX || 0, by = held.bobY || 0;

    // Placement follows Minecraft's first-person item: the block sits low in the lower-right
    // corner, turned 45 degrees so the top and both inner faces show, about a fifth of the
    // screen wide; plants/torches are held as a flat, slightly tilted sprite.
    let model;
    if (mesh.sprite) {
      model = mul(translate(0.7 - 0.34 * sr + bx * 0.6, -0.5 + 0.16 * Math.sin(Math.sqrt(sw) * Math.PI * 2) - 0.7 * lower + by * 0.6, -1.05 - 0.18 * Math.sin(sw * Math.PI)),
        mul(rotY((-12 - 18 * sq) * DEG), mul(rotX((-8 - 45 * sr) * DEG), mul(rotZ((18 - 10 * sr) * DEG), mul(scale(0.56), translate(-0.5, -0.3, -7.5 / 16))))));
    } else {
      model = mul(translate(0.8 - 0.4 * sr + bx * 0.6, -0.64 + 0.16 * Math.sin(Math.sqrt(sw) * Math.PI * 2) - 0.7 * lower + by * 0.6, -1.1 - 0.2 * Math.sin(sw * Math.PI)),
        mul(rotY((45 - 20 * sq) * DEG), mul(rotX((6 - 40 * sr) * DEG), mul(rotZ(-12 * sr * DEG), mul(scale(0.34), translate(-0.5, -0.5, -0.5))))));
    }

    let aspect = view.aspect;
    if (!(aspect > 0)) {
      const vp = gl.getParameter(gl.VIEWPORT);
      aspect = vp && vp[3] > 0 ? vp[2] / vp[3] : 16 / 9;
    }
    const f = 1 / Math.tan(35 * DEG);
    const p = this.held;
    p.use();
    gl.uniformMatrix4fv(p.u('uModelView'), false, model);
    gl.uniform4f(p.u('uProjParams'), f / aspect, f, 0.05, 10);
    const light = held.light || [1, 0];
    gl.uniform2f(p.u('uHeldLight'), light[0] ?? 1, light[1] ?? 0);
    gl.uniform1f(p.u('uEdgeAA'), mesh.sprite ? 0 : 1);
    let size = view.targetSize;
    if (!size) { const vp = gl.getParameter(gl.VIEWPORT); size = [vp[2], vp[3]]; }
    gl.uniform2f(p.u('uScreen'), size[0], size[1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    // Edge coverage is blended over the scene; alpha (1 - self-emission, for exposure metering)
    // becomes the coverage-weighted mix with the scene's.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.quads * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    for (const m of this.heldMeshes.values()) {
      if (!m) continue;
      gl.deleteVertexArray(m.vao);
      gl.deleteBuffer(m.vbo);
    }
    this.heldMeshes.clear();
    gl.deleteProgram(this.selection.program);
    gl.deleteProgram(this.particles.program);
    gl.deleteProgram(this.held.program);
  }
}

// Mesh for the held block, in block-local 1/16 units: a cube with its six face textures, or for
// plants and torches an extruded 1/16-thick sprite (front, back, and a side wall along every
// opaque texel edge), like Minecraft's item models.
export function buildHeldMesh(tex, id) {
  const def = BLOCKS[id];
  if (!def || !tex || !tex.faceLayers) return null;
  const shape = SHAPE[id];
  const tint = defaultTint(id) || [255, 255, 255];
  const quads = [];
  // quad: [corner base (1/16 units), face index, cell size (1/16 units), uv origin (texels), uv span (texels), layer]
  if (shape === SHAPE_CUBE) {
    for (let f = 0; f < 6; f++) quads.push({ base: [0, 0, 0], f, s: 16, u0: 0, v0: 0, span: 16, layer: tex.faceLayers[id * 6 + f] });
  } else if (shape === SHAPE_CROSS || shape === SHAPE_TORCH) {
    const layer = tex.faceLayers[id * 6];
    const size = tex.size || 16;
    quads.push({ base: [0, 0, 0], f: 4, s: 16, u0: 0, v0: 0, span: 16, layer, z: 8 });
    quads.push({ base: [0, 0, 0], f: 5, s: 16, u0: 0, v0: 0, span: 16, layer, z: 7 });
    const al = tex.albedo && tex.albedo[0];
    if (al && size === 16) {
      const o = layer * 256 * 4;
      const opaque = (x, y) => x >= 0 && y >= 0 && x < 16 && y < 16 && al[o + (y * 16 + x) * 4 + 3] >= 128;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (!opaque(x, y)) continue;
          const cell = [x, 15 - y, 7]; // texel row y is counted from the top of the image
          if (!opaque(x + 1, y)) quads.push({ base: cell, f: 0, s: 1, u0: x, v0: y, span: 1, layer });
          if (!opaque(x - 1, y)) quads.push({ base: cell, f: 1, s: 1, u0: x, v0: y, span: 1, layer });
          if (!opaque(x, y - 1)) quads.push({ base: cell, f: 2, s: 1, u0: x, v0: y, span: 1, layer });
          if (!opaque(x, y + 1)) quads.push({ base: cell, f: 3, s: 1, u0: x, v0: y, span: 1, layer });
        }
      }
    }
  } else {
    return null;
  }
  const verts = new Uint32Array(quads.length * 4 * WORDS_PER_VERTEX);
  let o = 0;
  for (const q of quads) {
    const F = FACES[q.f];
    for (const [cu, cv] of QUAD_UV) {
      let x = q.base[0] + (F.base[0] + cu * F.U[0] + cv * F.V[0]) * q.s;
      let y = q.base[1] + (F.base[1] + cu * F.U[1] + cv * F.V[1]) * q.s;
      let z = q.base[2] + (F.base[2] + cu * F.U[2] + cv * F.V[2]) * q.s;
      if (q.z !== undefined) z = q.z; // sprite front/back planes
      o = packVertex(verts, o, x, y, z, q.u0 + cu * q.span, q.v0 + cv * q.span, q.layer, q.f, 3, 255, 0, 0, tint[0], tint[1], tint[2]);
    }
  }
  return { verts, quads: quads.length, sprite: shape !== SHAPE_CUBE };
}
