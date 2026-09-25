// Review check: generateChunk must be a pure function of (seed, cx, cz), independent of what the
// same WorldGen instance generated before (scratch reuse) and of heightAt/biomeAt calls in between.
import { WorldGen } from '../../../src/worldgen.js';
import crypto from 'node:crypto';
const h = (a) => crypto.createHash('sha1').update(a).digest('hex').slice(0, 12);
const seed = 12345;
const targets = [];
for (let cz = -3; cz <= 3; cz++) for (let cx = -3; cx <= 3; cx++) targets.push([cx * 7 - 2, cz * 5 + 1]);
const ref = new Map();
for (const [cx, cz] of targets) {
  const g = new WorldGen(seed);
  const { blocks, colors } = g.generateChunk(cx, cz);
  ref.set(`${cx},${cz}`, h(blocks) + h(colors));
}
const g = new WorldGen(seed);
let bad = 0;
const order = targets.slice().sort(() => Math.random() - 0.5);
for (const [cx, cz] of order) {
  g.heightAt(cx * 16 + 3, cz * 16 - 9); g.biomeAt(-cx * 31, cz * 17);
  const { blocks, colors } = g.generateChunk(cx, cz);
  if (h(blocks) + h(colors) !== ref.get(`${cx},${cz}`)) { bad++; console.log('mismatch', cx, cz); }
}
console.log(`purity: ${targets.length - bad}/${targets.length} identical`);
