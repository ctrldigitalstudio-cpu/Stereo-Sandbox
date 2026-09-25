// Frame graph. Owns the GL context, the Frame UBO, the standard textures (block arrays, shadow
// map + samplers, sky LUT, irradiance, noise), the scene targets, and runs every pass in the
// order SPEC.md "Sky + post" lays out. Terrain/overlays draw into targets this module binds.

import { createGL, createTexture2D, createDepthTexture, createFramebuffer, UNIT } from './gl.js';
import { mat4, forwardFromYawPitch, frustumPlanes } from './math.js';
import { FrameUniforms, computeShadowMatrix, IRRADIANCE_TEXELS, EDGE_BINS } from './render/common.js';
import { TerrainRenderer } from './render/terrain.js';
import { Overlays } from './render/overlays.js';
import { Atmosphere } from './render/atmosphere.js';
import { PostProcess } from './render/post.js';
import { DEFAULT_SETTINGS, AA_MODES } from './config.js';

const NEAR = 0.08;
const LIGHT_ANGULAR_SIZE = 0.012;   // tan of the light's angular radius (PCSS penumbra)
const MAX_DPR = 1.5;
// RCAS strength after TAA (0..1): light at native resolution, a little more when upscaling.
const SHARPEN_NATIVE = 0.5;
const SHARPEN_UPSCALED = 0.8;        // at renderScale 0.5 (interpolated in between)

const DEFAULTS = DEFAULT_SETTINGS;

// Offset a projection matrix in NDC by (ox, oy): clip.xy += offset * clip.w, i.e. the rendered
// image moves by (ox, oy) * size / 2 pixels. Column-major.
function jitterProjection(m, ox, oy) {
  for (let c = 0; c < 4; c++) {
    m[c * 4] += ox * m[c * 4 + 3];
    m[c * 4 + 1] += oy * m[c * 4 + 3];
  }
  return m;
}

// Upload the TextureSet as 2D texture arrays with every mip level.
function createBlockArray(gl, set, levelsData, internal) {
  const levels = Math.min(set.levels || levelsData.length, levelsData.length);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internal, set.size, set.size, set.layers);
  for (let l = 0; l < levels; l++) {
    const s = Math.max(1, set.size >> l);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, 0, s, s, set.layers, gl.RGBA, gl.UNSIGNED_BYTE, levelsData[l]);
  }
  // LINEAR on purpose: shaders snap magnified lookups themselves (pixelArtUV in common.js),
  // because NEAREST magnification is ignored by some drivers once anisotropy is enabled.
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BASE_LEVEL, 0);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, levels - 1);
  // REPEAT: block faces tile, and lava/water scroll their UVs.
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const aniso = gl.ext && gl.ext.aniso;
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return tex;
}

export class Renderer {
  constructor(canvas, textureSet, settings = {}) {
    const gl = createGL(canvas);
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    this.canvas = canvas;
    this.textureSet = textureSet;
    this.settings = { ...DEFAULTS, ...settings };

    // HDR targets need a renderable float format; half-float rendering is enough when full float isn't there.
    if (!gl.ext.colorBufferFloat && gl.getExtension('EXT_color_buffer_half_float')) {
      gl.hdrFormat = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    }
    this.hdr = gl.hdrFormat;
    // Capabilities the UI may report. hdr 'rgba8': no float render targets, so lighting clips and
    // night scenes band (the game still runs, at reduced quality).
    this.caps = { hdr: this.hdr.type === gl.UNSIGNED_BYTE ? 'rgba8' : this.hdr.internal === gl.RGBA16F ? 'rgba16f' : 'rgba32f' };
    if (this.caps.hdr === 'rgba8') console.warn('[renderer] no float render targets: reduced lighting quality (RGBA8 HDR fallback)');

    this.frameUniforms = new FrameUniforms(gl);
    this.albedoTex = createBlockArray(gl, textureSet, textureSet.albedo, gl.SRGB8_ALPHA8);
    this.normalTex = createBlockArray(gl, textureSet, textureSet.normal, gl.RGBA8);
    this.specTex = createBlockArray(gl, textureSet, textureSet.spec, gl.RGBA8);

    // Shadow samplers: hardware compare (PCF) on unit 3, raw depth (blocker search) on unit 4.
    this.cmpSampler = gl.createSampler();
    gl.samplerParameteri(this.cmpSampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.samplerParameteri(this.cmpSampler, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.samplerParameteri(this.cmpSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.cmpSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.rawSampler = gl.createSampler();
    gl.samplerParameteri(this.rawSampler, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    gl.samplerParameteri(this.rawSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(this.rawSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    for (const s of [this.cmpSampler, this.rawSampler]) {
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    // 1x1 depth texture cleared to 1 ("fully lit") for when shadows are off, and during the shadow pass.
    this.dummyDepth = createDepthTexture(gl, 1, 1);
    const dfb = createFramebuffer(gl, [], this.dummyDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dfb);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(dfb);
    this.shadowTex = null;
    this.shadowFB = null;
    this.shadowRes = 0;

    this.atmosphere = new Atmosphere(gl, this.hdr);
    this.post = new PostProcess(gl, this.hdr);
    this.terrain = new TerrainRenderer(gl, textureSet);
    this.overlays = new Overlays(gl, textureSet);

    this.view = mat4.create();
    this.proj = mat4.create();              // jittered when TAA is on (what every pass renders with)
    this.viewProj = mat4.create();
    this.invViewProj = mat4.create();
    this.projNoJitter = mat4.create();      // the plain camera (reprojection, stats)
    this.viewProjNoJitter = mat4.create();
    this.jitter = [0, 0];
    this.sharpen = [SHARPEN_NATIVE, SHARPEN_UPSCALED];   // RCAS strength after TAA: native, renderScale 0.5
    this.frustum = new Float32Array(24);
    this.viewInfo = {};             // the `view` object handed to terrain/overlays, reused every frame
    this.frameIndex = 0;
    this.volumetricStrength = 1;    // artistic scale of the light shafts
    this.stats = {
      drawCalls: 0, chunks: 0, quads: 0, shadowDrawCalls: 0, shadowQuads: 0, passes: 0,
      gpuMs: 0, width: 0, height: 0, renderWidth: 0, renderHeight: 0,
    };
    this._failed = new Set();
    this._timer = { pending: [], free: [] };

    this.width = 0;
    this.height = 0;
    this.renderWidth = 0;
    this.renderHeight = 0;
    this._sizeDirty = false;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => { this._sizeDirty = true; });
      this._resizeObserver.observe(canvas);
    }
    // Every GPU resource (including the chunk meshes owned elsewhere) is gone after a context loss;
    // the game autosaves on pagehide, so a reload is the reliable recovery.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[renderer] WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      if (typeof location !== 'undefined') location.reload();
    });
    this.applySettings(settings);
    this._defaultState();
  }

  // ---- settings / sizing ---------------------------------------------------------------------

  applySettings(settings = {}) {
    const s = { ...DEFAULTS, ...settings };
    // Values may arrive as strings from <select> elements.
    for (const k of ['renderDistance', 'renderScale', 'shadowRes', 'shadowRadius', 'volumetrics', 'clouds', 'ssr']) {
      const v = Number(s[k]);
      s[k] = Number.isFinite(v) ? v : DEFAULTS[k];
    }
    // Anti-aliasing: settings.aa ('taa' | 'fxaa' | 'off'). Older settings objects carry a boolean
    // `fxaa` instead; it is honoured when there is no valid `aa`.
    let aa = AA_MODES.includes(settings.aa) ? settings.aa : null;
    if (!aa && typeof settings.fxaa === 'boolean') aa = settings.fxaa ? 'fxaa' : 'off';
    s.aa = aa || (AA_MODES.includes(DEFAULTS.aa) ? DEFAULTS.aa : 'taa');
    delete s.fxaa;   // (renderer.settings may be handed back to applySettings / a new Renderer)
    this.settings = s;
    // While the context is lost GL calls fail (framebuffers come back incomplete); restoring the
    // context reloads the page, so there is nothing to replay.
    if (this.gl.isContextLost()) { this._sizeDirty = true; return; }
    const res = [1024, 2048, 4096].includes(Number(s.shadowRes)) ? Number(s.shadowRes) : 2048;
    const maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    const wantRes = Math.min(res, maxTex);
    // The shadow map is only rebuilt when shadows toggle or the resolution changes.
    if (s.shadows && (!this.shadowTex || this.shadowRes !== wantRes)) this._createShadowMap(wantRes);
    else if (!s.shadows && this.shadowTex) this._deleteShadowMap();
    // renderScale / canvas size: only the size-dependent targets are touched, and only if the size changed.
    this.resize();
  }

  _createShadowMap(res) {
    this._deleteShadowMap();
    const gl = this.gl;
    this.shadowTex = createDepthTexture(gl, res, res);
    this.shadowFB = createFramebuffer(gl, [], this.shadowTex);
    this.shadowRes = res;
  }

  _deleteShadowMap() {
    const gl = this.gl;
    if (this.shadowTex) gl.deleteTexture(this.shadowTex);
    if (this.shadowFB) gl.deleteFramebuffer(this.shadowFB);
    this.shadowTex = null;
    this.shadowFB = null;
    this.shadowRes = 0;
  }

  // Canvas backing size = CSS size x min(devicePixelRatio, 1.5); render size = canvas x renderScale.
  resize() {
    const c = this.canvas;
    if (this.gl.isContextLost()) { this._sizeDirty = true; return; }
    this._sizeDirty = false;
    const rawDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this._dpr = rawDpr;   // render() re-checks it: moving between displays changes no CSS size
    const dpr = Math.min(rawDpr, MAX_DPR);
    const cssW = c.clientWidth, cssH = c.clientHeight;
    let w = c.width, h = c.height;
    if (cssW > 0 && cssH > 0) {
      w = Math.max(1, Math.round(cssW * dpr));
      h = Math.max(1, Math.round(cssH * dpr));
    }
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    this.width = w;
    this.height = h;
    const scale = Math.min(Math.max(Number(this.settings.renderScale) || 1, 0.25), 1);
    const rw = Math.max(1, Math.round(w * scale)), rh = Math.max(1, Math.round(h * scale));
    // TAA with float targets: the scene pass also writes motion vectors (waving plants/leaves) and
    // a reactive flag (particles) into a second attachment for the resolve.
    const motion = this.settings.aa === 'taa' && this.hdr.type !== this.gl.UNSIGNED_BYTE;
    if (rw !== this.renderWidth || rh !== this.renderHeight || !this.sceneFB || !!this.motionTex !== motion) this._createSceneTargets(rw, rh, motion);
    // Post targets: render-size ones follow the scene; with TAA the history and everything after
    // the resolve are canvas-sized (a canvas size change restarts the history, a renderScale
    // change keeps it).
    this.post.resize(rw, rh, w, h, this.settings.aa === 'taa');
  }

  _createSceneTargets(w, h, motion = false) {
    const gl = this.gl;
    this._deleteSceneTargets();
    this.renderWidth = w;
    this.renderHeight = h;
    const color = () => createTexture2D(gl, w, h, { ...this.hdr, filter: gl.LINEAR });
    this.sceneColor = color();
    this.sceneDepth = createDepthTexture(gl, w, h);
    // Attachment 1 (TAA only): xy = NDC motion beyond the static-world reprojection, z = reactive.
    this.motionTex = motion ? createTexture2D(gl, w, h, { ...this.hdr, filter: gl.NEAREST }) : null;
    this.sceneFB = createFramebuffer(gl, motion ? [this.sceneColor, this.motionTex] : [this.sceneColor], this.sceneDepth);
    this.copyColor = color();
    this.copyDepth = createDepthTexture(gl, w, h);
    this.copyFB = createFramebuffer(gl, [this.copyColor], this.copyDepth);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _deleteSceneTargets() {
    const gl = this.gl;
    for (const t of [this.sceneColor, this.sceneDepth, this.motionTex, this.copyColor, this.copyDepth]) if (t) gl.deleteTexture(t);
    for (const f of [this.sceneFB, this.copyFB]) if (f) gl.deleteFramebuffer(f);
    this.sceneColor = this.sceneDepth = this.motionTex = this.copyColor = this.copyDepth = this.sceneFB = this.copyFB = null;
  }

  // ---- helpers -------------------------------------------------------------------------------

  // The state every module may assume between passes.
  _defaultState() {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.SCISSOR_TEST);
  }

  // Scene FBO draw buffers: with the motion attachment, passes that write motion vectors (terrain,
  // particles, water) draw into both; the others (sky, selection outline) leave it untouched.
  _sceneBuffers(withMotion) {
    if (!this.motionTex) return;
    const gl = this.gl;
    gl.drawBuffers(withMotion ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0, gl.NONE]);
  }

  _bindShadow(tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT.SHADOW_CMP);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindSampler(UNIT.SHADOW_CMP, this.cmpSampler);
    gl.activeTexture(gl.TEXTURE0 + UNIT.SHADOW_RAW);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindSampler(UNIT.SHADOW_RAW, this.rawSampler);
  }

  _bindStandardTextures() {
    const gl = this.gl;
    const a = this.atmosphere;
    const bind = (unit, target, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, tex); };
    bind(UNIT.ALBEDO, gl.TEXTURE_2D_ARRAY, this.albedoTex);
    bind(UNIT.NORMALS, gl.TEXTURE_2D_ARRAY, this.normalTex);
    bind(UNIT.SPECULAR, gl.TEXTURE_2D_ARRAY, this.specTex);
    bind(UNIT.SKY_LUT, gl.TEXTURE_2D, a.skyLUT);
    bind(UNIT.IRRADIANCE, gl.TEXTURE_2D, a.irradiance);
    bind(UNIT.NOISE2D, gl.TEXTURE_2D, a.noise2D);
    bind(UNIT.NOISE3D, gl.TEXTURE_3D, a.noise3D);
    this._bindShadow(this.dummyDepth);
  }

  // Run a terrain/overlay call; a failing module is logged once and the frame carries on.
  _run(name, fn) {
    try {
      fn();
    } catch (e) {
      if (!this._failed.has(name)) {
        this._failed.add(name);
        console.error(`[renderer] ${name} failed:`, e);
      }
    }
    this._defaultState();
  }

  // Terrain call with per-call stats (reset draw/quad counters before, read after).
  _terrainCall(name, view, out) {
    const st = this.terrain.stats;
    if (st) { st.drawCalls = 0; st.quads = 0; }
    this._run(name, () => this.terrain[name](view));
    if (st && out) {
      out.drawCalls += st.drawCalls || 0;
      out.quads += st.quads || 0;
      if (name !== 'drawWater') out.chunks = st.chunks || 0;   // visible chunks of this pass
    }
  }

  _timerBegin() {
    const gl = this.gl, ext = gl.ext.timer, T = this._timer;
    if (!ext) return;
    // Collect finished queries (results arrive a few frames later).
    while (T.pending.length) {
      const q = T.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      T.pending.shift();
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.stats.gpuMs = this.stats.gpuMs ? this.stats.gpuMs * 0.9 + ms * 0.1 : ms;
      }
      T.free.push(q);
    }
    if (T.pending.length >= 4) { T.active = null; return; }
    const q = T.free.pop() || gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    T.active = q;
  }

  _timerEnd() {
    const gl = this.gl, ext = gl.ext.timer, T = this._timer;
    if (!ext || !T.active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    T.pending.push(T.active);
    T.active = null;
  }

  // ---- frame ---------------------------------------------------------------------------------

  render(frame) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const dprNow = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (this._sizeDirty || dprNow !== this._dpr) this.resize();
    const s = this.settings;
    const W = this.renderWidth, H = this.renderHeight;
    this.frameIndex++;
    this._timerBegin();
    this._defaultState();

    const camPos = frame.camPos;
    const time = frame.time || 0;
    const eyeSkyLight = Number.isFinite(frame.eyeSkyLight) ? Math.min(Math.max(frame.eyeSkyLight, 0), 1) : 1;
    const cloudCoverage = Number.isFinite(frame.cloudCoverage) ? frame.cloudCoverage : 0.45;
    const underwater = !!frame.underwater;

    const sky = this.atmosphere.prepare(frame);
    const post = this.post;

    // Camera: rotation-only view (camera-relative rendering), perspective with the far plane past the fog end.
    const fwd = forwardFromYawPitch(frame.yaw || 0, frame.pitch || 0);
    mat4.lookAt(this.view, [0, 0, 0], fwd, [0, 1, 0]);
    const far = s.renderDistance * 16 * 1.6 + 64;
    const fov = frame.fov || (75 * Math.PI) / 180;
    mat4.perspective(this.projNoJitter, fov, W / H, NEAR, far);
    mat4.multiply(this.viewProjNoJitter, this.projNoJitter, this.view);
    // TAA: a sub-pixel Halton jitter on the projection every geometry pass and every full-screen
    // pass that rebuilds view rays uses (through the Frame block), never on the shadow pass.
    const taaOn = s.aa === 'taa' && post.temporal;
    const taa = taaOn ? post.taa.begin({
      camPos, fwd, sunDir: sky.sunDir, viewProj: this.viewProjNoJitter, scale: W / Math.max(this.width, 1),
    }) : null;
    this.jitter[0] = taa ? taa.jitter[0] : 0;
    this.jitter[1] = taa ? taa.jitter[1] : 0;
    this.proj.set(this.projNoJitter);
    if (taa) jitterProjection(this.proj, (2 * this.jitter[0]) / W, (2 * this.jitter[1]) / H);
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.invert(this.invViewProj, this.viewProj);
    frustumPlanes(this.frustum, this.viewProj);

    const shadowsOn = !!(s.shadows && this.shadowTex);
    const shadow = computeShadowMatrix(camPos, sky.lightDir, s.shadowRadius);

    const U = this.frameUniforms;
    U.mat('uView', this.view);
    U.mat('uProj', this.proj);
    U.mat('uViewProj', this.viewProj);
    U.mat('uInvViewProj', this.invViewProj);
    U.mat('uShadowMat', shadow.matrix);
    U.mat('uPrevViewProj', taa ? taa.prevViewProj : this.viewProjNoJitter);
    U.vec('uTAA', this.jitter[0], this.jitter[1], taa ? 1 : 0, taa && taa.valid ? 1 : 0);
    if (taa) U.vec('uCamDelta', taa.camDelta[0], taa.camDelta[1], taa.camDelta[2], 0);
    else U.vec('uCamDelta', 0, 0, 0, 0);
    // Footprint scale (TAAU mip bias), previous frame's animation time (waving motion vectors),
    // motion vectors on/off.
    const motionOn = !!(taa && this.motionTex);
    const prevTime = taa && taa.valid && Number.isFinite(this._prevTime) ? this._prevTime : time;
    U.vec('uTAAInfo', taa ? W / Math.max(this.width, 1) : 1, prevTime, motionOn ? 1 : 0, 0);
    this._prevTime = time;
    U.vec('uCamPos', camPos[0], camPos[1], camPos[2], time);
    U.vec('uSunDir', sky.sunDir[0], sky.sunDir[1], sky.sunDir[2], sky.sunVisibility);
    U.vec('uMoonDir', sky.moonDir[0], sky.moonDir[1], sky.moonDir[2], sky.moonVisibility);
    U.vec('uLightDir', sky.lightDir[0], sky.lightDir[1], sky.lightDir[2], sky.lightIsSun ? 1 : 0);
    U.vec('uRes', W, H, 1 / W, 1 / H);
    // uCam.z: horizontal distance by which terrain must have dissolved into the void. World
    // streaming keeps chunks within renderDistance + 0.5 chunk rings of the camera's chunk, so an
    // unloaded chunk can come as close as ~renderDistance * 16 - 13 blocks.
    const edgeDist = Math.max(s.renderDistance * 16 - 14, 24);
    U.vec('uCam', NEAR, far, edgeDist, eyeSkyLight);
    U.vec('uShadow', shadowsOn ? 1 : 0, s.shadowRadius, shadowsOn ? this.shadowRes : 1, LIGHT_ANGULAR_SIZE);
    U.vec('uEnv', underwater ? 1 : 0, this.frameIndex % 65536, cloudCoverage, sky.timeOfDay);
    U.vec('uWind', sky.wind[0], sky.wind[1], sky.starRotation, sky.fogDensity);
    U.vec('uQuality', s.ssr || 0, s.volumetrics || 0, s.clouds || 0, s.pcss && shadowsOn ? 1 : 0);
    U.upload();

    const view = this.viewInfo;
    view.camPos = camPos;
    view.frustum = this.frustum;
    view.time = time;
    view.dt = frame.dt || 0;
    view.shadowCenter = shadow.center;
    view.shadowRadius = s.shadowRadius;
    view.shadowRes = this.shadowRes;
    view.shadowMatrix = shadow.matrix;
    view.lightDir = sky.lightDir;
    view.sunDir = sky.sunDir;
    view.moonDir = sky.moonDir;
    view.timeOfDay = sky.timeOfDay;
    view.fov = fov;
    view.aspect = W / H;
    view.width = W;
    view.height = H;
    // Size of the image the player sees (the TAA output; without TAA the render image is upscaled).
    view.outputWidth = taa ? this.width : W;
    view.outputHeight = taa ? this.height : H;
    view.near = NEAR;
    view.far = far;
    view.view = this.view;
    view.proj = this.proj;
    view.viewProj = this.viewProj;
    view.invViewProj = this.invViewProj;
    view.projNoJitter = this.projNoJitter;
    view.viewProjNoJitter = this.viewProjNoJitter;
    view.jitter = this.jitter;
    view.underwater = underwater;
    view.eyeSkyLight = eyeSkyLight;
    view.frameIndex = this.frameIndex;
    view.fogEnd = edgeDist;

    this._bindStandardTextures();

    // Far-terrain summary per azimuth (drawn past the loaded area by the sky pass and the fog),
    // stored after the lighting texels of the irradiance texture. Only uploaded when it changed.
    const edge = this.terrain.edgeMap && this.hdr.type !== gl.UNSIGNED_BYTE ? this.terrain.edgeMap(camPos, edgeDist) : null;
    if (edge) {
      gl.activeTexture(gl.TEXTURE0 + UNIT.IRRADIANCE);
      gl.bindTexture(gl.TEXTURE_2D, this.atmosphere.irradiance);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, IRRADIANCE_TEXELS, 0, 2 * EDGE_BINS, 1, gl.RGBA, gl.FLOAT, edge);
    }

    // 1. Sky LUT + irradiance (only re-rendered when the sun, moon or altitude moved enough).
    const lutUpdated = this.atmosphere.update(camPos[1]);
    this._defaultState();

    const st = { drawCalls: 0, quads: 0, chunks: 0 };
    const shadowSt = { drawCalls: 0, quads: 0, chunks: 0 };

    // 2. Shadow map. The dummy stays bound on units 3/4 so the map is never sampled while it is the target.
    if (shadowsOn) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFB);
      gl.viewport(0, 0, this.shadowRes, this.shadowRes);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      this._terrainCall('drawShadow', view, shadowSt);
    }
    this._bindShadow(shadowsOn ? this.shadowTex : this.dummyDepth);

    // 3. Opaque scene, particles, then the sky on the far plane.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFB);
    gl.viewport(0, 0, W, H);
    this._sceneBuffers(true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._terrainCall('drawOpaque', view, st);
    if (frame.particles && this.overlays.drawParticles) this._run('drawParticles', () => this.overlays.drawParticles(view, frame.particles));
    this._sceneBuffers(false);
    this.atmosphere.drawSky();
    this._defaultState();

    // 4. Copies of colour + depth for refraction/SSR, then water and the selection outline.
    // (Both skipped when no water mesh is in view: the copy is a full-resolution blit.)
    const water = !this.terrain.waterVisible || this.terrain.waterVisible(view);
    if (water) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFB);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFB);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFB);
      gl.viewport(0, 0, W, H);
      gl.activeTexture(gl.TEXTURE0 + UNIT.PASS0);
      gl.bindTexture(gl.TEXTURE_2D, this.copyColor);
      gl.activeTexture(gl.TEXTURE0 + UNIT.PASS0 + 1);
      gl.bindTexture(gl.TEXTURE_2D, this.copyDepth);
      this._sceneBuffers(true);
      this._terrainCall('drawWater', view, st);
    }
    if (frame.selection && this.overlays.drawSelection) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFB);
      gl.viewport(0, 0, W, H);
      this._sceneBuffers(false);
      this._run('drawSelection', () => this.overlays.drawSelection(view, frame.selection));
    }
    post.passes = 0;

    // 5. Half-res volumetric light + clouds.
    const halfOn = post.halfRes(this.sceneDepth, {
      volumetrics: (s.volumetrics || 0) > 0,
      clouds: (s.clouds || 0) > 0,
      volStrength: this.volumetricStrength,
    });

    // 6. Composite (render size), then with TAA the resolve into the output-size HDR target, then
    // the held item on top of whichever HDR target the post chain reads (own cleared depth; after
    // the resolve it is neither jittered nor part of the history).
    post.composite(this.sceneColor, this.sceneDepth, { halfOn, flatClouds: !(s.clouds > 0) && cloudCoverage > 0 });
    if (taa) post.resolve(this.sceneDepth, motionOn ? this.motionTex : null);
    const held = !!(frame.held && this.overlays.drawHeld);
    if (held) {
      post.beginHeld();
      view.aspect = post.postWidth / post.postHeight;
      view.targetSize = view.targetSize || [0, 0];
      view.targetSize[0] = post.postWidth;
      view.targetSize[1] = post.postHeight;
      this._run('drawHeld', () => this.overlays.drawHeld(view, frame.held));
    }

    // 7-10. Bloom downsample, exposure (meters a plain downsampled level + the scene depth),
    // bloom upsample, tone map, final pass to the canvas (TAA sharpen, FXAA or copy).
    post.downsample(!!s.bloom);
    post.exposureUpdate(frame.dt || 1 / 60, this.sceneDepth);
    if (s.bloom) post.upsample();
    const bloomStrength = s.bloom ? 0.05 + 0.035 * sky.night : 0;
    const upscale = Math.min(Math.max((1 - W / Math.max(this.width, 1)) / 0.5, 0), 1);
    const sharpness = this.sharpen[0] + (this.sharpen[1] - this.sharpen[0]) * upscale;
    post.finish(this.width, this.height, { aa: s.aa, bloomStrength, sharpness, held });

    // Leave no pass inputs bound (avoids accidental feedback loops next frame).
    for (let u = UNIT.PASS0; u < UNIT.PASS0 + 6; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._defaultState();
    this._timerEnd();

    const S = this.stats;
    S.chunks = st.chunks;
    S.quads = st.quads;
    S.shadowDrawCalls = shadowSt.drawCalls;
    S.shadowQuads = shadowSt.quads;
    S.passes = post.passes + (lutUpdated ? 2 : 0) + 1 + (water ? 1 : 0);   // + sky LUT/irradiance, sky, copy blit
    S.drawCalls = st.drawCalls + shadowSt.drawCalls + S.passes;
    S.width = this.width;
    S.height = this.height;
    S.renderWidth = W;
    S.renderHeight = H;
    S.aa = taa ? 'taa' : s.aa === 'fxaa' ? 'fxaa' : 'off';
    S.taaCuts = post.taa.cuts;
  }

  dispose() {
    const gl = this.gl;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._deleteShadowMap();
    this._deleteSceneTargets();
    this.post.dispose();
    this.atmosphere.dispose();
    if (this.terrain.dispose) this.terrain.dispose();
    if (this.overlays.dispose) this.overlays.dispose();
    for (const t of [this.albedoTex, this.normalTex, this.specTex, this.dummyDepth]) gl.deleteTexture(t);
    gl.deleteSampler(this.cmpSampler);
    gl.deleteSampler(this.rawSampler);
    gl.deleteBuffer(this.frameUniforms.buffer);
  }
}
