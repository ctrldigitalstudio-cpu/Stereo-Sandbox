// Packed chunk-vertex format shared by the mesher (worker) and anything else that builds
// block geometry (held item). 16 bytes per vertex, 4 vertices per quad, drawn with a shared
// quad index buffer (0,1,2, 0,2,3). See SPEC.md "Vertex format".
//
//   word0 = (x16 | u << 9) | ((y16 | flags << 12) << 16)
//   word1 = (z16 | v << 9) | (layer << 16)
//   word2 = normal | ao << 3 | sky << 8 | blockLight << 16
//   word3 = r | g << 8 | b << 16
//
// x16/y16/z16: position relative to the chunk origin in 1/16 block units (x,z 0..256, y 0..2048).
// u, v: texel coordinates 0..16 in the 16x16 face texture (v = 0 is the top row of the image).
// layer: texture-array layer. normal: face index 0..5. ao: 0 (dark) .. 3 (open).
// sky / blockLight: smoothed light level scaled to 0..255. rgb: tint (255,255,255 = none).

export const BYTES_PER_VERTEX = 16;
export const WORDS_PER_VERTEX = 4;

export const FLAG_WAVE_LEAVES = 1; // whole vertex sways (leaves)
export const FLAG_WAVE_PLANT = 2;  // top vertices of plants sway, bottoms stay planted
export const FLAG_UNDERWATER = 4;  // face touches water: caustics + underwater sunlight
export const FLAG_PLANT = 8;       // cross/torch lighting: up normal, no normal map, translucency

// Faces in order +X, -X, +Y, -Y, +Z, -Z.
// A face's corner (u, v) in {0,1}^2 sits at block + base + u*U + v*V.
// U = direction of increasing texture u (tangent), V = direction of increasing v (bitangent,
// "down" on side faces). Corners in QUAD_UV order are counter-clockwise seen from outside.
export const FACES = [
  { n: [1, 0, 0], base: [1, 1, 1], U: [0, 0, -1], V: [0, -1, 0] },
  { n: [-1, 0, 0], base: [0, 1, 0], U: [0, 0, 1], V: [0, -1, 0] },
  { n: [0, 1, 0], base: [0, 1, 0], U: [1, 0, 0], V: [0, 0, 1] },
  { n: [0, -1, 0], base: [0, 0, 1], U: [1, 0, 0], V: [0, 0, -1] },
  { n: [0, 0, 1], base: [0, 1, 1], U: [1, 0, 0], V: [0, -1, 0] },
  { n: [0, 0, -1], base: [1, 1, 0], U: [-1, 0, 0], V: [0, -1, 0] },
];

export const QUAD_UV = [[0, 0], [0, 1], [1, 1], [1, 0]];

export function packVertex(out, o, x16, y16, z16, u, v, layer, normal, ao, sky, blk, flags, r, g, b) {
  out[o] = (x16 | (u << 9)) | ((y16 | (flags << 12)) << 16);
  out[o + 1] = (z16 | (v << 9)) | (layer << 16);
  out[o + 2] = normal | (ao << 3) | (sky << 8) | (blk << 16);
  out[o + 3] = r | (g << 8) | (b << 16);
  return o + 4;
}

// Index buffer for `quads` quads: (0,1,2, 0,2,3) + 4k
export function createQuadIndices(quads) {
  const idx = new Uint32Array(quads * 6);
  for (let q = 0, i = 0, v = 0; q < quads; q++, v += 4) {
    idx[i++] = v; idx[i++] = v + 1; idx[i++] = v + 2;
    idx[i++] = v; idx[i++] = v + 2; idx[i++] = v + 3;
  }
  return idx;
}

// Configure attributes for a VAO whose ARRAY_BUFFER holds packed vertices.
export function setupVertexAttribs(gl) {
  gl.enableVertexAttribArray(0);
  gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_SHORT, BYTES_PER_VERTEX, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_BYTE, BYTES_PER_VERTEX, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribIPointer(2, 4, gl.UNSIGNED_BYTE, BYTES_PER_VERTEX, 12);
}
