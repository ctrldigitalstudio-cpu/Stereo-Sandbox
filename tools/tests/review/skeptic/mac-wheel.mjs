import { installDom, uninstallDom, makeEvent } from '../../player/mock.mjs';
import { Input } from '../../../../src/input.js';
const { el } = installDom();
const input = new Input(el);
let t = 0;
input.now = () => t;
function wheel(deltaY, gap) { t += gap; const e = makeEvent('wheel', { deltaY, deltaMode: 0 }); el.dispatchEvent(e); }
const N = 4.000244140625;
// slow single notches, 400 ms apart
input.endFrame(); let total = 0;
for (let i = 0; i < 10; i++) { wheel(N, 400); total += input.wheel(); input.endFrame(); }
console.log('10 slow notches 400ms apart ->', total);
// notches 250ms apart (steady slow turning)
t += 1000; total = 0;
for (let i = 0; i < 10; i++) { wheel(N, 250); total += input.wheel(); input.endFrame(); }
console.log('10 notches 250ms apart ->', total);
// accelerated sequence typical of a quick flick: 4,4,8,12,20,40,80,...
t += 1000; total = 0;
for (const d of [4, 4, 8, 12, 20, 32, 48, 80, 120]) { wheel(d * 1.000061, 30); total += input.wheel(); input.endFrame(); }
console.log('quick flick of 9 notches ->', total);
uninstallDom();
