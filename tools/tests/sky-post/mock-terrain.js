// Harness-only stand-in for src/render/terrain.js: draws the packed chunk meshes with a simple
// lit shader (sun x N.L x shadow + ambient), a shadow pass and a basic reflective water, so the
// renderer / atmosphere / post chain can be tested independently of the real terrain renderer.

import { Program } from '../../../src/gl.js';
import { GLSL_COMMON, GLSL_BLOCK_VERTEX } from '../../../src/render/common.js';
import { setupVertexAttribs, createQuadIndices } from '../../../src/vertex.js';
import { aabbInFrustum } from '../../../src/math.js';

const VS = GLSL_COMMON + GLSL_BLOCK_VERTEX + `
uniform vec3 uChunkOffset;
uniform int uShadowPass;
out vec3 vPos;
out vec3 vN;
out vec2 vUV;
flat out float vLayer;
out vec2 vLight;
out vec3 vTint;
out float vAO;
void main() {
  vec3 p = blockLocalPos() + uChunkOffset;
  vPos = p;
  vN = FACE_N[blockNormal()];
  vUV = blockUV();
  vLayer = float(blockLayer());
  vLight = blockLight();
  vTint = blockTint();
  vAO = blockAO();
  if (uShadowPass == 1) {
    vec4 c = uShadowMat * vec4(p, 1.0);
    c.xy = shadowDistort(c.xy);
    gl_Position = c;
  } else {
    gl_Position = uViewProj * vec4(p, 1.0);
  }
}`;

const FS = GLSL_COMMON + `
in vec3 vPos; in vec3 vN; in vec2 vUV; flat in float vLayer; in vec2 vLight; in vec3 vTint; in float vAO;
out vec4 o;
void main() {
  vec4 a = texture(uAlbedo, vec3(vUV, vLayer));
  if (a.a < 0.5) discard;
  vec4 sp = texture(uSpecular, vec3(vUV, vLayer));
  vec3 alb = a.rgb * mix(vec3(1.0), vTint, sp.a);
  vec3 N = vN;
  vec3 L = uLightDir.xyz;
  float sh = vLight.x;
  if (uShadow.x > 0.5) {
    vec3 sc = shadowCoord(vPos + N * 0.06);
    sh = texture(uShadowCmp, vec3(sc.xy, sc.z - 0.0004));
  }
  vec3 direct = lightColor() * max(dot(N, L), 0.0) * sh * cloudShadow(vPos + uCamPos.xyz) * smoothstep(0.1, 0.45, vLight.x);
  vec3 amb = ambientLight(N) * vLight.x * vLight.x * (0.35 + 0.65 * vAO) + 0.004;
  vec3 blk = vec3(1.0, 0.62, 0.32) * vLight.y * vLight.y * 2.5 * vAO;
  vec3 col = alb * (direct + amb + blk) + alb * sp.b * 4.0;
  o = vec4(applyFog(col, vPos, vLight.x), 1.0);
}`;

const SHADOW_FS = GLSL_COMMON + `
in vec3 vPos; in vec3 vN; in vec2 vUV; flat in float vLayer; in vec2 vLight; in vec3 vTint; in float vAO;
out vec4 o;
void main() {
  if (texture(uAlbedo, vec3(vUV, vLayer)).a < 0.5) discard;
  o = vec4(1.0);
}`;

const WATER_FS = GLSL_COMMON + `
in vec3 vPos; in vec3 vN; in vec2 vUV; flat in float vLayer; in vec2 vLight; in vec3 vTint; in float vAO;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
out vec4 o;
void main() {
  vec3 V = normalize(-vPos);
  vec2 w = (texture(uNoise2D, (vPos.xz + uCamPos.xz) / 40.0 + uCamPos.w * 0.01).rg - 0.5) * 0.08;
  vec3 N = normalize(vec3(w.x, 1.0, w.y));
  if (!gl_FrontFacing) N = -N;
  vec2 suv = gl_FragCoord.xy * uRes.zw;
  float sceneZ = linearDepth(texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r);
  float thick = max(sceneZ - linearDepth(gl_FragCoord.z), 0.0);
  vec3 refr = texture(uSceneColor, suv + N.xz * 0.02).rgb * exp(-vec3(0.3, 0.09, 0.06) * thick);
  vec3 R = reflect(-V, N);
  vec3 refl = sampleSky(vec3(R.x, abs(R.y), R.z)) * vLight.x;
  float f = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 H = normalize(uLightDir.xyz + V);
  vec3 glint = lightColor() * pow(max(dot(N, H), 0.0), 600.0) * 20.0;
  vec3 col = mix(refr, refl, f) + glint * f;
  o = vec4(applyFog(col, vPos, vLight.x), 1.0);
}`;

export class TerrainRenderer {
  constructor(gl, textureSet) {
    this.gl = gl;
    this.textureSet = textureSet;
    this.chunks = new Map();
    this.stats = { chunks: 0, drawCalls: 0, quads: 0 };
    this.opaque = new Program(gl, VS, FS, 'mock-terrain');
    this.shadow = new Program(gl, VS, SHADOW_FS, 'mock-shadow');
    this.water = new Program(gl, VS, WATER_FS, 'mock-water');
    this.water.samplers({ uSceneColor: 10, uSceneDepth: 11 });
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, createQuadIndices(65536), gl.STATIC_DRAW);
  }

  _mesh(data, quads) {
    if (!quads) return null;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, quads * 16), gl.STATIC_DRAW);
    setupVertexAttribs(gl);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
    return { vao, vbo, quads };
  }

  upload(cx, cz, msg) {
    this.remove(cx, cz);
    this.chunks.set(`${cx},${cz}`, {
      cx, cz, minY: msg.minY, maxY: msg.maxY,
      opaque: this._mesh(msg.opaque, msg.opaqueQuads), water: this._mesh(msg.water, msg.waterQuads),
    });
  }

  remove(cx, cz) {
    const c = this.chunks.get(`${cx},${cz}`);
    if (!c) return;
    for (const m of [c.opaque, c.water]) if (m) { this.gl.deleteVertexArray(m.vao); this.gl.deleteBuffer(m.vbo); }
    this.chunks.delete(`${cx},${cz}`);
  }

  _draw(program, view, kind, cull) {
    const gl = this.gl;
    const cam = view.camPos;
    program.use();
    let n = 0;
    for (const c of this.chunks.values()) {
      const m = c[kind];
      if (!m) continue;
      const x0 = c.cx * 16 - cam[0], z0 = c.cz * 16 - cam[2];
      if (cull && !aabbInFrustum(view.frustum, x0, c.minY - cam[1], z0, x0 + 16, c.maxY + 1 - cam[1], z0 + 16)) continue;
      gl.uniform3f(program.u('uChunkOffset'), x0, -cam[1], z0);
      gl.uniform1i(program.u('uShadowPass'), program === this.shadow ? 1 : 0);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.quads * 6, gl.UNSIGNED_INT, 0);
      this.stats.drawCalls++;
      this.stats.quads += m.quads;
      n++;
    }
    gl.bindVertexArray(null);
    return n;
  }

  drawShadow(view) {
    const gl = this.gl;
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    this._draw(this.shadow, view, 'opaque', false);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.CULL_FACE);
  }

  drawOpaque(view) {
    const gl = this.gl;
    gl.disable(gl.CULL_FACE);
    this.stats.chunks = this._draw(this.opaque, view, 'opaque', true);
    gl.enable(gl.CULL_FACE);
  }

  drawWater(view) {
    const gl = this.gl;
    gl.disable(gl.CULL_FACE);
    this._draw(this.water, view, 'water', true);
    gl.enable(gl.CULL_FACE);
  }
}
