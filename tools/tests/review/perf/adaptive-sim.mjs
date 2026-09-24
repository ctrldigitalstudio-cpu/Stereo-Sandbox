// Review scratch (performance): replays main.js adaptResolution() (copied logic, lines 313-324)
// against a GPU whose frame cost scales with pixel count, on a 60 Hz vsync display.
const gpuAtFull = Number(process.argv[2] || 18);   // ms per frame at renderScale 1
const settings = { autoResolution: true, renderScale: 1 };
let dynScale = 1, slowTime = 0, fastTime = 0, frameMs = 16.7, t = 0, realloc = 0, slowFrames = 0, frames = 0;
const changes = [];
while (t < 60) {
  const gpu = gpuAtFull * dynScale * dynScale;
  const dt = Math.ceil(gpu / 16.667) * 16.667 / 1000;   // vsync-quantized rAF interval
  t += dt; frames++; if (dt > 0.02) slowFrames++;
  frameMs += ((dt * 1000) - frameMs) * 0.1;
  if (frameMs > 22) { slowTime += dt; fastTime = 0; } else if (frameMs < 18) { fastTime += dt; slowTime = 0; } else { slowTime = fastTime = 0; }
  let next = dynScale;
  if (slowTime > 1.0) { next = Math.max(0.5, dynScale - 0.1); slowTime = 0; }
  if (fastTime > 4.0) { next = Math.min(settings.renderScale, dynScale + 0.05); fastTime = 0; }
  if (Math.abs(next - dynScale) > 1e-3) { dynScale = next; realloc++; changes.push(`${t.toFixed(1)}s->${dynScale.toFixed(2)}`); }
}
console.log(`GPU ${gpuAtFull} ms at full res: ${realloc} target reallocations in 60 s, ${slowFrames}/${frames} frames at 30 fps`);
console.log(changes.join('  '));
