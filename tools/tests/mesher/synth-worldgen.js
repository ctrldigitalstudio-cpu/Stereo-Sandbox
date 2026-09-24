// Synthetic but realistic terrain with the WorldGen interface, used to test/benchmark the mesher and
// the worker independently of src/worldgen.js: rolling hills, a sea, tunnels + caverns with lava
// lakes, torches and glowstone in caves, trees crossing chunk borders, grass and flowers.

import { Simplex, hash2, hash3 } from '../../../src/noise.js';
import { B, SEA } from '../../../src/blocks.js';

export const BIOMES = [{ id: 0, name: 'Synthetic' }];

export class WorldGen {
  constructor(seed) {
    this.seed = seed | 0;
    this.noise = new Simplex(this.seed);
    this.cave = new Simplex(this.seed ^ 0x5bd1e995);
  }

  heightAt(x, z) {
    const n = this.noise;
    return Math.floor(60 + 16 * n.fbm2(x / 110, z / 110, 4) + 5 * n.noise2(x / 23, z / 23));
  }

  climateAt() { return { temperature: 0.6, humidity: 0.5 }; }
  biomeAt() { return 0; }
  findSpawn() { return { x: 0.5, y: this.heightAt(0, 0) + 1, z: 0.5 }; }

  generateChunk(cx, cz) {
    const blocks = new Uint8Array(16 * 16 * 128);
    const colors = new Uint8Array(256 * 9);
    const set = (x, y, z, id) => { blocks[x | (z << 4) | (y << 8)] = id; };
    const heights = new Int32Array(256);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = cx * 16 + x, wz = cz * 16 + z, col = x | (z << 4);
        const h = this.heightAt(wx, wz);
        heights[col] = h;
        const beach = h <= SEA + 1;
        for (let y = 0; y <= h; y++) {
          let id = y === 0 ? B.BEDROCK : y < h - 3 ? B.STONE : y < h ? (beach ? B.SAND : B.DIRT) : (beach ? B.SAND : B.GRASS);
          if (id === B.STONE && hash3(wx, y, wz, this.seed) < 0.012) id = B.COAL_ORE;
          set(x, y, z, id);
        }
        for (let y = h + 1; y <= SEA; y++) set(x, y, z, B.WATER);
        // Caves: spaghetti tunnels (two noise zero-crossings) + a few caverns, lava below y = 10.
        for (let y = 2; y < h - 4; y++) {
          const a = this.cave.noise3(wx / 28, y / 18, wz / 28), b = this.cave.noise3(wx / 28 + 91, y / 18, wz / 28 - 37);
          const cavern = this.cave.noise3(wx / 50 - 11, y / 25, wz / 50 + 5) > 0.55;
          if ((a * a + b * b < 0.012) || cavern) set(x, y, z, y < 10 ? B.LAVA : B.AIR);
        }
        // Colours vary smoothly with position (like climate-driven biome colours).
        const t = 0.5 + 0.5 * this.noise.noise2(wx / 200, wz / 200);
        const o = col * 9;
        colors[o] = 90 + 60 * t; colors[o + 1] = 170 + 20 * t; colors[o + 2] = 70;
        colors[o + 3] = 70 + 50 * t; colors[o + 4] = 150 + 20 * t; colors[o + 5] = 50;
        colors[o + 6] = 50; colors[o + 7] = 100 + 40 * t; colors[o + 8] = 200;
      }
    }
    // Cave decorations: torches on cave floors, glowstone in ceilings.
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = cx * 16 + x, wz = cz * 16 + z;
        for (let y = 11; y < heights[x | (z << 4)] - 4; y++) {
          const i = x | (z << 4) | (y << 8);
          if (blocks[i] !== B.AIR) continue;
          if (blocks[i - 256] === B.STONE && hash3(wx, y, wz, this.seed + 1) < 0.02) blocks[i] = B.TORCH;
          else if (blocks[i + 256] === B.STONE && hash3(wx, y, wz, this.seed + 2) < 0.01) blocks[i + 256] = B.GLOWSTONE;
        }
      }
    }
    // Trees: decided per world column, so the parts crossing into this chunk match its neighbours.
    for (let tz = -3; tz < 19; tz++) {
      for (let tx = -3; tx < 19; tx++) {
        const wx = cx * 16 + tx, wz = cz * 16 + tz;
        if (hash2(wx, wz, this.seed) > 0.018) continue;
        const h = this.heightAt(wx, wz);
        if (h <= SEA + 1) continue;
        const birch = hash2(wx, wz, this.seed + 7) < 0.3;
        const log = birch ? B.BIRCH_LOG : B.OAK_LOG, leaves = birch ? B.BIRCH_LEAVES : B.OAK_LEAVES;
        const trunk = 4 + Math.floor(hash2(wx, wz, this.seed + 3) * 3);
        const top = h + trunk;
        for (let dy = -2; dy <= 1; dy++) {
          const r = dy >= 0 ? 1 : 2;
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2 && hash3(wx + dx, top + dy, wz + dz, this.seed) < 0.6) continue;
              const x = tx + dx, z = tz + dz, y = top + dy;
              if (x < 0 || x > 15 || z < 0 || z > 15 || y > 127) continue;
              if (blocks[x | (z << 4) | (y << 8)] === B.AIR) set(x, y, z, leaves);
            }
          }
        }
        if (tx >= 0 && tx < 16 && tz >= 0 && tz < 16) {
          for (let y = h + 1; y < top; y++) set(tx, y, tz, log);
          set(tx, h, tz, B.DIRT);
        }
      }
    }
    // Ground cover.
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const h = heights[x | (z << 4)];
        const i = x | (z << 4) | ((h + 1) << 8);
        if (h + 1 > 127 || blocks[i - 256] !== B.GRASS || blocks[i] !== B.AIR) continue;
        const r = hash2(cx * 16 + x, cz * 16 + z, this.seed + 11);
        if (r < 0.14) blocks[i] = B.TALL_GRASS;
        else if (r < 0.16) blocks[i] = B.POPPY;
        else if (r < 0.18) blocks[i] = B.DANDELION;
      }
    }
    return { blocks, colors };
  }
}
