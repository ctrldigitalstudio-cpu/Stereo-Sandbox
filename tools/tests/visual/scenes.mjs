// Scene catalogue for the visual-tuning captures (seed 12345, as in ?test mode).
// pos: camera feet position (the eye is 1.62 above); ground: snap feet to the terrain height.
// edits(x, y, z) -> [[x, y, z, id], ...] placed relative to the (floored) feet position and
// restored after the capture. Locations were found with scout.mjs / scout-cave.mjs.

// Brick wall + torch + glowstone in front of the camera (same layout as the smoke test).
export function torchWall(x, y, z) {
  const e = [];
  for (let dx = -3; dx <= 3; dx++) for (let dy = 0; dy < 4; dy++) e.push([x + dx, y + dy, z - 6, 26]);
  e.push([x - 2, y, z - 5, 30], [x + 2, y, z - 5, 29]);
  return e;
}

// Texture bench: planks floor, glass, leaves, tall grass and flowers, dirt, stone.
export function bench(x, y, z) {
  const e = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -4; dz <= -2; dz++) e.push([x + dx, y - 1, z + dz, 5]);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -4; dz <= -2; dz++) for (let dy = 0; dy < 3; dy++) e.push([x + dx, y + dy, z + dz, 0]);
  e.push([x - 2, y, z - 3, 10], [x - 2, y + 1, z - 3, 10]);
  e.push([x - 1, y, z - 4, 9], [x, y, z - 4, 9], [x, y + 1, z - 4, 9]);
  e.push([x + 1, y, z - 3, 21], [x + 2, y, z - 3, 22], [x + 1, y, z - 2, 23]);
  e.push([x + 2, y, z - 4, 3], [x + 2, y + 1, z - 4, 1]);
  return e;
}

export function sceneList(sp, shore) {
  return [
    { name: 'noon', time: 0.25, pos: [sp.x, sp.y + 22, sp.z], yaw: 0.6, pitch: -0.3, far: true },
    { name: 'afternoon', time: 0.41, pos: [sp.x, sp.y + 6, sp.z], yaw: -1.2, pitch: -0.08, far: true },
    { name: 'golden', time: 0.455, pos: [sp.x + 4, sp.y + 14, sp.z - 20], yaw: Math.PI / 2 + 0.5, pitch: -0.12, far: true },
    { name: 'sunset', time: 0.485, pos: [sp.x, sp.y + 12, sp.z], yaw: -Math.PI / 2 + 0.3, pitch: 0.02, far: true },
    { name: 'dusk', time: 0.51, pos: [sp.x, sp.y + 12, sp.z], yaw: -Math.PI / 2 + 0.3, pitch: 0.06, far: true },
    { name: 'night', time: 0.78, pos: [sp.x, sp.y + 10, sp.z], yaw: 0.6, pitch: 0.1, far: true },
    { name: 'overcast', time: 0.3, pos: [sp.x, sp.y + 10, sp.z], yaw: 2.2, pitch: -0.05, settings: { cloudCoverage: 0.8 }, far: true },
    { name: 'bench', time: 0.3, pos: [sp.x, sp.y, sp.z + 4], yaw: 0, pitch: -0.35, edits: bench, ground: true },
    // Same view and wall as the smoke test's 'torches' scene (edits based on the spawn height).
    { name: 'torches', time: 0.8, pos: [sp.x, sp.y + 1, sp.z + 4], yaw: 0, pitch: -0.25, edits: torchWall, editBase: [sp.x, sp.y, sp.z + 4] },
    { name: 'torches-close', time: 0.8, pos: [sp.x + 0.5, sp.y + 1, sp.z + 1], yaw: 0.35, pitch: -0.1, edits: torchWall, editBase: [sp.x, sp.y, sp.z + 4] },
    { name: 'forest', time: 0.36, pos: [15.5, 62, 28.5], yaw: 2.5, pitch: 0.05, ground: true },
    { name: 'desert', time: 0.3, pos: [19, 84, -61], yaw: 0.5, pitch: -0.15, far: true },
    { name: 'beach-sunset', time: 0.49, pos: [59, 60, -68], yaw: 1.2, pitch: -0.05, far: true },
    { name: 'cave', time: 0.3, pos: [-46.5, 12.2, -34.5], yaw: 0.8, pitch: -0.35, settle: 40 },
    { name: 'water', time: 0.33, pos: [shore.x, 64, shore.z], yaw: 0.3, pitch: -0.35, far: true },
    { name: 'water-flat', time: 0.36, pos: [shore.x, 60, shore.z], yaw: 0.3, pitch: -0.05, far: true },
    { name: 'underwater', time: 0.3, pos: [shore.x, 50, shore.z], yaw: 0.3, pitch: -0.2 },
    { name: 'underwater-up', time: 0.3, pos: [shore.x, 49, shore.z], yaw: 0.3, pitch: 0.7 },
    { name: 'snow', time: 0.3, pos: [334, 126, 70], yaw: 0.2, pitch: -0.2, far: true },
  ];
}

// Same search as tools/smoke-test.mjs, so 'water'/'underwater' match its shots.
export function findShore(g, x, z) {
  for (let r = 16; r < 900; r += 16) {
    for (let a = 0; a < 32; a++) {
      const px = Math.round(x + Math.cos(a / 32 * Math.PI * 2) * r), pz = Math.round(z + Math.sin(a / 32 * Math.PI * 2) * r);
      if (g.heightAt(px, pz) < 44) return { x: px, z: pz };
    }
  }
  return { x: -176, z: -45 };
}
