// Review (build/portability): main.js adaptResolution() fed with a vsync-capped 30 Hz rAF
// (browser energy saver / Low Power Mode / 30 Hz display) and a GPU that is otherwise idle.
// Mirrors src/main.js lines 313-324 and 328-333.
const settings = { autoResolution: true, renderScale: 1 };
let dynScale = 1, slowTime = 0, fastTime = 0, frameMs = 16.7;
const log = [];
for (let f = 0, t = 0; t < 60; f++) {
  const dt = 1 / 30; t += dt;
  frameMs += ((dt * 1000) - frameMs) * 0.1;
  if (frameMs > 22) { slowTime += dt; fastTime = 0; } else if (frameMs < 18) { fastTime += dt; slowTime = 0; } else { slowTime = fastTime = 0; }
  let next = dynScale;
  if (slowTime > 1.0) { next = Math.max(0.5, dynScale - 0.1); slowTime = 0; }
  if (fastTime > 4.0) { next = Math.min(settings.renderScale, dynScale + 0.05); fastTime = 0; }
  if (Math.abs(next - dynScale) > 1e-3) { dynScale = next; log.push(`${t.toFixed(1)}s -> renderScale ${dynScale.toFixed(2)}`); }
}
console.log(log.join('\n'));
console.log('after 60 s at a steady 30 fps: renderScale', dynScale.toFixed(2));
