// Harness-only stand-in for src/render/overlays.js (records calls, draws nothing).
export class Overlays {
  constructor(gl, textureSet) {
    this.gl = gl;
    this.textureSet = textureSet;
    this.calls = { selection: 0, particles: 0, held: 0 };
  }
  drawSelection() { this.calls.selection++; }
  drawParticles() { this.calls.particles++; }
  drawHeld() { this.calls.held++; }
}
