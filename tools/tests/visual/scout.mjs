// Find representative locations for the visual captures (seed 12345, same as ?test).
import { WorldGen, BIOMES } from '../../../src/worldgen.js';
import { B } from '../../../src/blocks.js';
const g = new WorldGen(12345);
const sp = g.findSpawn();
console.log('spawn', sp);
const found = {};
for (let r = 0; r < 1600; r += 24) {
  for (let a = 0; a < 48; a++) {
    const x = Math.round(sp.x + Math.cos(a / 48 * 6.283) * r), z = Math.round(sp.z + Math.sin(a / 48 * 6.283) * r);
    const b = BIOMES[g.biomeAt(x, z)].key;
    if (!found[b]) found[b] = { x, z, h: g.heightAt(x, z), r };
  }
}
console.log(found);
