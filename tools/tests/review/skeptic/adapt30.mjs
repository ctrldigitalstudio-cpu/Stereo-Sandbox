// Replays main.js adaptResolution()/frameMs logic (lines 333-344, 352) at fixed rAF cadences.
function run(intervalMs, seconds, start = 1) {
  const settings = { autoResolution: true, renderScale: start };
  let dynScale = start, slowTime = 0, fastTime = 0, frameMs = 16.7;
  const steps = Math.round(seconds * 1000 / intervalMs);
  for (let i = 0; i < steps; i++) {
    const dt = Math.min(Math.max(intervalMs / 1000, 0), 0.1);
    frameMs += ((dt * 1000) - frameMs) * 0.1;
    if (frameMs > 22) { slowTime += dt; fastTime = 0; } else if (frameMs < 18) { fastTime += dt; slowTime = 0; } else { slowTime = fastTime = 0; }
    let next = dynScale;
    if (slowTime > 1.0) { next = Math.max(0.5, dynScale - 0.1); slowTime = 0; }
    if (fastTime > 4.0) { next = Math.min(settings.renderScale, dynScale + 0.05); fastTime = 0; }
    if (Math.abs(next - dynScale) > 1e-3) dynScale = next;
  }
  return dynScale.toFixed(2);
}
for (const hz of [144, 120, 60, 50, 48, 40, 30, 24]) console.log(`${hz} Hz idle GPU, 60 s -> renderScale ${run(1000 / hz, 60)}`);
