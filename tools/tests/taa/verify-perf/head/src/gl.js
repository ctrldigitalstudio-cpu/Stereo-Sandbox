// Thin WebGL2 helpers shared by every render module.

// Fixed texture units. Every Program auto-binds these sampler names at creation, so a
// module only has to bind the right texture to the unit (the renderer does it once per frame).
export const UNIT = {
  ALBEDO: 0,      // sampler2DArray uAlbedo
  NORMALS: 1,     // sampler2DArray uNormals
  SPECULAR: 2,    // sampler2DArray uSpecular
  SHADOW_CMP: 3,  // sampler2DShadow uShadowCmp (shadow depth, compare sampler object)
  SHADOW_RAW: 4,  // sampler2D uShadowRaw (same depth texture, raw NEAREST sampler object)
  SKY_LUT: 5,     // sampler2D uSkyLUT
  IRRADIANCE: 6,  // sampler2D uIrradiance (4x1)
  NOISE2D: 7,     // sampler2D uNoise2D
  NOISE3D: 8,     // sampler3D uNoise3D
  PASS0: 10,      // pass-specific inputs start here (10..15)
};

const STANDARD_SAMPLERS = {
  uAlbedo: UNIT.ALBEDO, uNormals: UNIT.NORMALS, uSpecular: UNIT.SPECULAR,
  uShadowCmp: UNIT.SHADOW_CMP, uShadowRaw: UNIT.SHADOW_RAW, uSkyLUT: UNIT.SKY_LUT,
  uIrradiance: UNIT.IRRADIANCE, uNoise2D: UNIT.NOISE2D, uNoise3D: UNIT.NOISE3D,
};

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false, // every pass renders into its own targets; the canvas only receives the final image
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;
  const ext = {
    colorBufferFloat: gl.getExtension('EXT_color_buffer_float'),
    floatLinear: gl.getExtension('OES_texture_float_linear'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
    timer: gl.getExtension('EXT_disjoint_timer_query_webgl2'),
  };
  gl.ext = ext;
  // Formats for HDR render targets. RGBA16F needs EXT_color_buffer_float to be renderable.
  gl.hdrFormat = ext.colorBufferFloat
    ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
    : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  return gl;
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    gl.deleteShader(sh);
    throw new Error(`[${label}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed:\n${log}\n${numbered}`);
  }
  return sh;
}

// Program wrapper with cached uniform locations.
// Usage: const p = new Program(gl, vs, fs, 'terrain'); p.use(); gl.uniform1f(p.u('uFoo'), 1);
export class Program {
  constructor(gl, vsSrc, fsSrc, label = 'program') {
    this.gl = gl;
    this.label = label;
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`[${label}] link failed: ${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = p;
    this.locs = new Map();
    // Bind the shared Frame uniform block (binding point 0) if the program declares it.
    const blockIndex = gl.getUniformBlockIndex(p, 'Frame');
    if (blockIndex !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, blockIndex, 0);
    this.samplers(STANDARD_SAMPLERS);
    gl.useProgram(null);
  }

  use() { this.gl.useProgram(this.program); return this; }

  u(name) {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.locs.set(name, l);
    }
    return l;
  }

  // Bind sampler uniforms to texture units: p.samplers({ uAlbedo: 0, uSceneColor: 10 })
  samplers(map) {
    const gl = this.gl;
    this.use();
    for (const k in map) {
      const l = this.u(k);
      if (l) gl.uniform1i(l, map[k]);
    }
    return this;
  }
}

export function createTexture2D(gl, w, h, { internal, format, type, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, data = null }) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return t;
}

export function createDepthTexture(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// Framebuffer from color textures (array) and an optional depth texture or renderbuffer.
export function createFramebuffer(gl, colors, depth = null, depthIsRenderbuffer = false) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const bufs = [];
  colors.forEach((tex, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  if (depth) {
    if (depthIsRenderbuffer) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  }
  gl.drawBuffers(bufs.length ? bufs : [gl.NONE]);
  if (!bufs.length) gl.readBuffer(gl.NONE);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
  return fb;
}

export function createDepthRenderbuffer(gl, w, h) {
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  return rb;
}

// Full-screen triangle: draw with gl.drawArrays(gl.TRIANGLES, 0, 3) using FULLSCREEN_VS (no attributes needed).
let emptyVAO = null;
export function drawFullscreen(gl) {
  if (!emptyVAO) emptyVAO = gl.createVertexArray();
  gl.bindVertexArray(emptyVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}
