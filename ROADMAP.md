# Roadmap: possible upgrades

Ordered roughly by how much each one improves the game per unit of work. Effort: S (hours),
M (a day or two), L (several days), XL (a week or more).

## Graphics
| Upgrade | What it adds | Effort |
| --- | --- | --- |
| Temporal anti-aliasing + temporal upscaling | Stable edges without FXAA blur, noise-free clouds and light shafts, and ~30–50% more fps by rendering below native resolution and reconstructing | M |
| Weather: rain, snow, thunderstorms | Rain streaks and splashes, wet darkened surfaces with puddle reflections, ripples on water, lightning flashes, snow accumulating in cold biomes | M |
| Coloured block light | RGB light propagation: tinted light through stained glass, coloured lamps, blue soul-fire, red redstone glow | M |
| Parallax occlusion mapping | Real surface depth on stone, bricks, planks and ores using the height maps the textures already have | S–M |
| Screen-space ambient occlusion (GTAO) | Soft contact shadows in corners and under plants beyond the per-vertex voxel AO | S |
| Voxel path-traced global illumination | Bounced sunlight and coloured light bleeding (SEUS PTGI style) by ray-marching a 3D texture of nearby blocks; the biggest realism jump, GPU-heavy | XL |
| Distant-horizon LOD terrain | Mountains visible 1000+ blocks away through simplified far chunks | L |
| Photo mode | Free camera, depth of field, adjustable time/weather/exposure, high-resolution capture | S–M |
| WebGPU renderer | Compute shaders for GI, culling and meshing on the GPU; better performance on modern browsers | XL |

## Gameplay
| Upgrade | What it adds | Effort |
| --- | --- | --- |
| Touch controls and gamepad | Play on phones/tablets (virtual stick + buttons) and with controllers | M |
| More block shapes | Slabs, stairs, fences, doors, trapdoors, lanterns, stained glass, flower pots | M |
| Flowing water and lava, falling sand/gravel | Minecraft-style fluid spreading and gravity blocks | M |
| Multiple worlds + IndexedDB storage | Named worlds, bigger saves than localStorage allows, export/import a world file to share builds | S–M |
| Animals and mobs | Cows, sheep, pigs with simple AI; zombies and skeletons at night | L |
| Survival mode | Health, hunger, mining time by tool, item drops, crafting, a real inventory | L |
| Structures and more biomes | Villages, ruins, dungeons; jungle, swamp, savanna, cherry grove | L |
| Music and ambience | Procedural ambient music, birds by day, crickets at night, cave drips | S–M |
| Multiplayer | Shared worlds through a small WebSocket server (needs hosting) | XL |

## Engine / performance
| Upgrade | What it adds | Effort |
| --- | --- | --- |
| Cave (occlusion) culling | Skip hidden underground geometry: far fewer quads drawn on the surface | M |
| Several world workers | Faster chunk loading when flying or at long render distances | S |
| GPU timing overlay | Per-pass GPU milliseconds in the F3 screen to tune presets on real hardware | S |
