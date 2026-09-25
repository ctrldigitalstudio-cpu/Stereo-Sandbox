// Review scratch: main.js adaptResolution() (lines 333-344, copied) driven by a vsync-aligned rAF
// with a frame queue of depth Q (Q=1: no pipelining == ceil-quantised; Q>=2: GPU runs back to back,
// as in Chrome/ANGLE D3D11 (DXGI frame latency), Metal (3 drawables), Firefox).
// Cost model: fixed part (shadow/vertex) + pixel part * scale^2, with per-frame noise.
const V = 1000 / 60;
function run(gpuFull, Q, fixedFrac, noise, seed = 1) {
  let rnd = seed; const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  const settings = { autoResolution: true, renderScale: 1 };
  let dynScale = 1, slowTime = 0, fastTime = 0, frameMs = 16.7, realloc = 0, slow = 0, frames = 0;
  let t = 0; const done = []; const changes = [];
  while (t < 60000) {
    const cost = gpuFull * (fixedFrac + (1 - fixedFrac) * dynScale * dynScale) * (1 + (rand() * 2 - 1) * noise);
    const start = t + 2; // 2 ms of CPU
    const prev = done.length ? done[done.length - 1] : 0;
    done.push(Math.max(prev, start) + cost);
    // next rAF: first vsync >= t+V such that at most Q frames are in flight
    let gate = done.length >= Q ? done[done.length - Q] : 0;
    let next = Math.ceil(Math.max(t + V, gate) / V - 1e-9) * V;
    const dt = (next - t) / 1000; t = next; frames++; if (dt > 0.02) slow++;
    frameMs += ((dt * 1000) - frameMs) * 0.1;
    if (frameMs > 22) { slowTime += dt; fastTime = 0; } else if (frameMs < 18) { fastTime += dt; slowTime = 0; } else { slowTime = fastTime = 0; }
    let n = dynScale;
    if (slowTime > 1.0) { n = Math.max(0.5, dynScale - 0.1); slowTime = 0; }
    if (fastTime > 4.0) { n = Math.min(settings.renderScale, dynScale + 0.05); fastTime = 0; }
    if (Math.abs(n - dynScale) > 1e-3) { dynScale = n; realloc++; changes.push(`${(t/1000).toFixed(1)}:${dynScale.toFixed(2)}`); }
  }
  return { realloc, slow, frames, final: dynScale.toFixed(2), tail: changes.slice(-6).join(' ') };
}
for (const Q of [1, 2, 3]) for (const fixed of [0, 0.3]) for (const noise of [0, 0.15]) {
  const rows = [];
  for (const g of [18, 20, 24, 30, 40, 50, 66]) { const r = run(g, Q, fixed, noise); rows.push(`${g}ms:${r.realloc}r/${r.slow}s@${r.final}`); }
  console.log(`Q=${Q} fixed=${fixed} noise=${noise}  ` + rows.join('  '));
}
