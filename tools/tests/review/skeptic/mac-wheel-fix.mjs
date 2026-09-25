// Standalone model of the proposed _onWheel fix (not wired into src/).
const NOTCH = 100, DISCRETE = 50, IDLE = 200;
function make() {
  const s = { steps: 0, acc: 0, time: -1e9 };
  s.on = (d, mode, now) => {
    if (!d) return;
    const burstStart = now - s.time > IDLE || Math.sign(d) !== Math.sign(s.acc || d);
    s.time = now;
    if (mode === 2) { s.steps += Math.sign(d); s.acc = 0; return; }
    if (mode === 1) d *= NOTCH / 3;
    if (Math.abs(d) >= DISCRETE) { s.steps += Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / NOTCH)); s.acc = 0; return; }
    if (burstStart) { s.steps += Math.sign(d); s.acc = Math.sign(d) * 1e-9; return; } // first small event of a burst = one step
    s.acc += d;
    while (Math.abs(s.acc) >= DISCRETE) { const g = Math.sign(s.acc); s.steps += g; s.acc -= g * DISCRETE; }
  };
  return s;
}
let s = make(), t = 0;
for (let i = 0; i < 10; i++) s.on(4.000244140625, 0, t += 400);
console.log('mac slow notches 400ms:', s.steps);
s = make(); t = 0;
for (let i = 0; i < 10; i++) s.on(4.000244140625, 0, t += 250);
console.log('mac notches 250ms:', s.steps);
s = make(); t = 0;
for (let i = 0; i < 12; i++) s.on(10, 0, t += 16);
console.log('trackpad 120px swipe:', s.steps);
s = make(); t = 0;
for (const d of [100, 100, -100]) s.on(d, 0, t += 400);
console.log('windows notches +,+,-:', s.steps);
