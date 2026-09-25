const handlers = {};
const mk = (name) => ({ addEventListener(t, f) { (handlers[name + ':' + t] ||= []).push(f); }, removeEventListener() {} });
globalThis.window = mk('win');
const el = { ...mk('el') };
globalThis.document = { ...mk('doc'), pointerLockElement: el, body: {}, activeElement: null };
const { Input } = await import('../../../../src/input.js');
const inp = new Input(el);
handlers['doc:pointerlockchange'][0]();
const move = (dx) => handlers['win:mousemove'][0]({ movementX: dx, movementY: 0 });
move(5); // skipped
function run(label, seq) {
  let acc = 0; const out = [];
  for (const d of seq) { inp.endFrame(); move(d); out.push(inp.dx); acc += inp.dx; }
  console.log(label, 'sent', seq.reduce((a, b) => a + b, 0), 'accepted', acc, out.join(','));
}
run('slow aim', [10, 6, 3]);
run('30fps flick 1600dpi', [320, 480, 600, 520, 400, 300, 120, 20]);
run('slow aim', [10, 6, 3]);
run('60fps ramp', [150, 437, 800, 1000, 700, 300, 100]);
run('single spike', [3, 2000, 4, 3]);
