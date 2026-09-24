// Page-side helpers for live.mjs /eval: exposure readback and irradiance texels.
window.__probe = {
  exposure() {
    const r = window.__game.renderer, R = r.__impl || r, gl = R.gl, p = R.post;
    const t = p.exposure[p.exposureIndex];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    const px = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return { exposure: Math.pow(2, px[0] * 10 - 5), avgLog: px[1], g: px[2], a: px[3] };
  },
  irradiance() {
    const r = window.__game.renderer, R = r.__impl || r, gl = R.gl, a = R.atmosphere;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a.irradiance, 0);
    const w = 8, px = new Float32Array(4 * w);
    gl.readPixels(0, 0, w, 1, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    const out = [];
    for (let i = 0; i < w; i++) out.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]].map((v) => +v.toFixed(4)));
    return out;
  },
};
// Sky LUT radiance for a direction given by azimuth (radians, atan2(z, x)) and elevation (radians).
window.__probe.sky = function (az, el) {
  const r = window.__game.renderer, R = r.__impl || r, gl = R.gl, a = R.atmosphere;
  const W = 256, H = 128;
  const u = az / (2 * Math.PI) + 0.5, v = 0.5 + 0.5 * Math.sign(el) * Math.sqrt(Math.abs(el) / (0.5 * Math.PI));
  const x = Math.min(W - 1, Math.max(0, Math.floor(u * W))), y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a.skyLUT, 0);
  const px = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  return [px[0], px[1], px[2]].map((v) => +v.toFixed(3));
};
window.__probe.skyRow = function (el) {
  const out = [];
  for (let k = 0; k < 8; k++) { const az = -Math.PI + k * Math.PI / 4; out.push(`${(az * 180 / Math.PI).toFixed(0)}:${window.__probe.sky(az, el).join(',')}`); }
  return out.join('  ');
};
