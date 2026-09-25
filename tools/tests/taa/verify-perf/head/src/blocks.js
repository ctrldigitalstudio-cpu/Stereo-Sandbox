// Block registry. Every block id maps to rendering, lighting and physics properties.
// Texture names refer to generators in textures.js.

export const CHUNK = 16;
export const HEIGHT = 128;
export const SEA = 56;

export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
export const SHAPE_CROSS = 2;
export const SHAPE_TORCH = 3;
export const SHAPE_FLUID = 4;

export const TINT_NONE = 0;
export const TINT_GRASS = 1;
export const TINT_FOLIAGE = 2;
export const TINT_BIRCH = 3;
export const TINT_SPRUCE = 4;
export const TINT_WATER = 5;

const defs = [];
export const B = {};

function def(name, o) {
  const id = defs.length;
  const d = {
    id, name,
    label: o.label || name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    shape: o.shape ?? SHAPE_CUBE,
    tex: o.tex ?? name,
    opaque: o.opaque ?? true,
    solid: o.solid ?? true,
    cutout: o.cutout ?? false,
    cullSame: o.cullSame ?? false,
    lightOpacity: o.lightOpacity ?? ((o.opaque ?? true) ? 15 : 0),
    emit: o.emit ?? 0,
    tint: o.tint ?? TINT_NONE,
    wave: o.wave ?? 0,
    sound: o.sound ?? 'stone',
    replaceable: o.replaceable ?? false,
    placeable: o.placeable ?? true,
    unbreakable: o.unbreakable ?? false,
  };
  defs.push(d);
  B[name.toUpperCase()] = id;
  return id;
}

def('air', { shape: SHAPE_NONE, opaque: false, solid: false, replaceable: true, placeable: false, sound: 'none' });
def('stone', {});
def('grass', { tex: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, tint: TINT_GRASS, sound: 'grass', label: 'Grass Block' });
def('dirt', { sound: 'gravel' });
def('cobblestone', {});
def('oak_planks', { sound: 'wood' });
def('sand', { sound: 'sand' });
def('gravel', { sound: 'gravel' });
def('oak_log', { tex: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log' }, sound: 'wood' });
def('oak_leaves', { opaque: false, cutout: true, cullSame: true, lightOpacity: 1, tint: TINT_FOLIAGE, wave: 1, sound: 'grass' });
def('glass', { opaque: false, cutout: true, cullSame: true, lightOpacity: 0, sound: 'glass' });
def('water', { shape: SHAPE_FLUID, opaque: false, solid: false, cullSame: true, lightOpacity: 1, tint: TINT_WATER, replaceable: true, placeable: false, sound: 'water' });
def('bedrock', { unbreakable: true, placeable: false });
def('birch_log', { tex: { top: 'birch_log_top', bottom: 'birch_log_top', side: 'birch_log' }, sound: 'wood' });
def('birch_leaves', { opaque: false, cutout: true, cullSame: true, lightOpacity: 1, tint: TINT_BIRCH, wave: 1, sound: 'grass' });
def('spruce_log', { tex: { top: 'spruce_log_top', bottom: 'spruce_log_top', side: 'spruce_log' }, sound: 'wood' });
def('spruce_leaves', { opaque: false, cutout: true, cullSame: true, lightOpacity: 1, tint: TINT_SPRUCE, wave: 1, sound: 'grass' });
def('snowy_grass', { tex: { top: 'snow', bottom: 'dirt', side: 'snowy_grass_side' }, sound: 'snow', label: 'Snowy Grass' });
def('snow', { sound: 'snow', label: 'Snow Block' });
def('ice', { sound: 'glass' });
def('sandstone', { tex: { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone_side' } });
def('cactus', { tex: { top: 'cactus_top', bottom: 'cactus_top', side: 'cactus_side' }, sound: 'wool' });
def('tall_grass', { shape: SHAPE_CROSS, opaque: false, solid: false, cutout: true, lightOpacity: 0, tint: TINT_GRASS, wave: 2, replaceable: true, sound: 'grass' });
def('poppy', { shape: SHAPE_CROSS, opaque: false, solid: false, cutout: true, lightOpacity: 0, wave: 2, sound: 'grass' });
def('dandelion', { shape: SHAPE_CROSS, opaque: false, solid: false, cutout: true, lightOpacity: 0, wave: 2, sound: 'grass' });
def('dead_bush', { shape: SHAPE_CROSS, opaque: false, solid: false, cutout: true, lightOpacity: 0, wave: 2, replaceable: true, sound: 'grass' });
def('bricks', {});
def('stone_bricks', {});
def('mossy_cobblestone', {});
def('glowstone', { emit: 15, sound: 'glass' });
def('torch', { shape: SHAPE_TORCH, opaque: false, solid: false, cutout: true, lightOpacity: 0, emit: 14, sound: 'wood' });
def('coal_ore', {});
def('iron_ore', {});
def('gold_ore', {});
def('diamond_ore', {});
def('redstone_ore', {});
def('obsidian', {});
def('lava', { shape: SHAPE_FLUID, opaque: false, solid: false, cullSame: true, lightOpacity: 0, emit: 15, replaceable: true, placeable: false, sound: 'water' });
def('bookshelf', { tex: { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' }, sound: 'wood' });
def('crafting_table', { tex: { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side' }, sound: 'wood' });
def('birch_planks', { sound: 'wood' });
def('spruce_planks', { sound: 'wood' });
def('sea_lantern', { emit: 15, sound: 'glass' });
def('white_wool', { sound: 'wool' });
def('red_wool', { sound: 'wool' });
def('blue_wool', { sound: 'wool' });
def('yellow_wool', { sound: 'wool' });
def('green_wool', { sound: 'wool' });
def('black_wool', { sound: 'wool' });
def('clay', { sound: 'gravel' });
def('cornflower', { shape: SHAPE_CROSS, opaque: false, solid: false, cutout: true, lightOpacity: 0, wave: 2, sound: 'grass' });
def('fern', { shape: SHAPE_CROSS, opaque: false, solid: false, cutout: true, lightOpacity: 0, tint: TINT_GRASS, wave: 2, replaceable: true, sound: 'grass' });
def('gold_block', { label: 'Block of Gold' });
def('iron_block', { label: 'Block of Iron' });
def('diamond_block', { label: 'Block of Diamond' });
def('terracotta', {});
def('packed_ice', { sound: 'glass' });

export const BLOCKS = defs;
export const NUM_BLOCKS = defs.length;

// Flat lookup tables for hot loops (worker mesher + physics).
export const OPAQUE = new Uint8Array(256);
export const SOLID = new Uint8Array(256);
export const SHAPE = new Uint8Array(256);
export const LIGHT_OPACITY = new Uint8Array(256);
export const EMIT = new Uint8Array(256);
export const CULL_SAME = new Uint8Array(256);
export const TINT = new Uint8Array(256);
export const WAVE = new Uint8Array(256);
export const REPLACEABLE = new Uint8Array(256);
for (const d of defs) {
  OPAQUE[d.id] = d.opaque ? 1 : 0;
  SOLID[d.id] = d.solid ? 1 : 0;
  SHAPE[d.id] = d.shape;
  LIGHT_OPACITY[d.id] = d.lightOpacity;
  EMIT[d.id] = d.emit;
  CULL_SAME[d.id] = d.cullSame ? 1 : 0;
  TINT[d.id] = d.tint;
  WAVE[d.id] = d.wave;
  REPLACEABLE[d.id] = d.replaceable ? 1 : 0;
}

// Face order: +X, -X, +Y, -Y, +Z, -Z
export function faceTextures(d) {
  const t = d.tex;
  if (typeof t === 'string') return [t, t, t, t, t, t];
  return [t.side, t.side, t.top, t.bottom, t.side, t.side];
}

// Blocks offered in the creative inventory, in display order.
export const INVENTORY = [
  'grass', 'dirt', 'stone', 'cobblestone', 'mossy_cobblestone', 'stone_bricks', 'bricks', 'sand',
  'sandstone', 'gravel', 'clay', 'terracotta', 'oak_log', 'birch_log', 'spruce_log', 'oak_planks',
  'birch_planks', 'spruce_planks', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'glass', 'ice', 'packed_ice',
  'snow', 'snowy_grass', 'cactus', 'bookshelf', 'crafting_table', 'torch', 'glowstone', 'sea_lantern',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'obsidian', 'gold_block', 'iron_block',
  'diamond_block', 'white_wool', 'red_wool', 'yellow_wool', 'green_wool', 'blue_wool', 'black_wool', 'tall_grass',
  'fern', 'poppy', 'dandelion', 'cornflower', 'dead_bush',
].map((n) => B[n.toUpperCase()]);

export const DEFAULT_HOTBAR = ['grass', 'stone', 'cobblestone', 'oak_planks', 'oak_log', 'glass', 'torch', 'glowstone', 'bricks']
  .map((n) => B[n.toUpperCase()]);
