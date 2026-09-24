// Bootstrap and main loop: wires textures, renderer, world streaming, player, UI and audio.

import { buildTextures } from './textures.js';
import { Renderer } from './renderer.js';
import { World } from './world.js';
import { WorldGen, BIOMES } from './worldgen.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { UI } from './ui.js';
import { ParticleSystem } from './particles.js';
import { loadSettings, saveSettings } from './config.js';
import { B, BLOCKS, DEFAULT_HOTBAR, OPAQUE, EMIT, HEIGHT } from './blocks.js';
import { clamp } from './math.js';

const SAVE_KEY = 'blockvale.save.v1';
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const SUN_TILT = (25 * Math.PI) / 180;
const START_TIME = 0.4; // mid-afternoon: the first sunset arrives a couple of minutes in

function sunDirection(timeOfDay) {
  const a = timeOfDay * Math.PI * 2;
  return [Math.cos(a), Math.sin(a) * Math.cos(SUN_TILT), Math.sin(a) * Math.sin(SUN_TILT)];
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeSave(data) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (e) { /* storage full or blocked: the game keeps running */ }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
}

function fatal(message, detail) {
  const el = document.createElement('div');
  el.className = 'fatal-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = '<h1>Blockvale can\'t start</h1><p></p><pre></pre>';
  el.querySelector('p').textContent = message;
  el.querySelector('pre').textContent = detail || '';
  Object.assign(el.style, {
    position: 'fixed', inset: '0', display: 'grid', placeContent: 'center', gap: '12px', padding: '24px',
    background: '#0b0f16', color: '#f3eee3', font: '16px/1.5 system-ui, sans-serif', textAlign: 'center', zIndex: '100',
  });
  el.querySelector('pre').style.cssText = 'max-width:80ch;white-space:pre-wrap;opacity:.6;font-size:12px;text-align:left;overflow:auto;max-height:40vh';
  document.body.appendChild(el);
}

// Fraction of sky visible from p (0 = sealed cave, 1 = open sky), from a few upward rays.
const SKY_RAYS = [[0, 1, 0], [0.5, 0.866, 0], [-0.5, 0.866, 0], [0, 0.866, 0.5], [0, 0.866, -0.5]];
function skyExposure(world, p) {
  let open = 0;
  for (const d of SKY_RAYS) {
    let blocked = false;
    for (let t = 0.5; t < 48; t += 0.5) {
      const y = p[1] + d[1] * t;
      if (y >= HEIGHT) break;
      const id = world.getBlock(p[0] + d[0] * t, y, p[2] + d[2] * t);
      if (id > 0 && OPAQUE[id]) { blocked = true; break; }
    }
    if (!blocked) open++;
  }
  return open / SKY_RAYS.length;
}

// Brightest block light reaching p from emitters within 7 blocks (Minecraft falloff: -1 per block).
function nearbyBlockLight(world, p) {
  const x0 = Math.floor(p[0]), y0 = Math.floor(p[1]), z0 = Math.floor(p[2]);
  let best = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dz = -7; dz <= 7; dz++) {
      for (let dx = -7; dx <= 7; dx++) {
        const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (d > 14) continue;
        const id = world.getBlock(x0 + dx, y0 + dy, z0 + dz);
        if (id > 0 && EMIT[id] - d > best) best = EMIT[id] - d;
      }
    }
  }
  return best / 15;
}

function boot() {
  const canvas = document.getElementById('game');
  let settings = loadSettings();
  if (TEST) settings = { ...settings, autoResolution: false };

  const textures = buildTextures();
  let renderer;
  try {
    renderer = new Renderer(canvas, textures, settings);
  } catch (e) {
    fatal('Your browser or GPU does not support WebGL2, which this game needs. Try a recent Chrome, Edge, Firefox or Safari on a desktop computer.', String(e && e.stack || e));
    throw e;
  }

  const save = TEST ? null : loadSave();
  const seed = TEST ? 12345 : (save && Number.isFinite(save.seed) ? save.seed : (Math.random() * 2 ** 31) | 0);
  const gen = new WorldGen(seed);

  const world = new World({
    seed,
    faceLayers: textures.faceLayers,
    edits: save ? World.importEdits(save.edits) : new Map(),
    onMesh: (cx, cz, msg) => renderer.terrain.upload(cx, cz, msg),
    onUnload: (cx, cz) => renderer.terrain.remove(cx, cz),
  });

  const input = new Input(canvas);
  const sound = new Sound();
  const player = new Player(world, input, sound);
  const particles = new ParticleSystem(textures);

  const spawn = gen.findSpawn();
  if (save && save.player) {
    const s = save.player;
    player.pos = [s.x, s.y, s.z];
    player.yaw = s.yaw || 0;
    player.pitch = s.pitch || 0;
    player.flying = !!s.flying;
  } else {
    player.pos = [spawn.x, spawn.y, spawn.z];
    player.yaw = 0.6;
    player.pitch = 0;
  }
  const savedHotbar = save && Array.isArray(save.hotbar) && save.hotbar.length === 9 ? save.hotbar : null;
  player.hotbar = (savedHotbar || DEFAULT_HOTBAR).map((id) => (BLOCKS[id] ? id : B.STONE));
  player.selected = save && Number.isInteger(save.selected) ? clamp(save.selected, 0, 8) : 0;

  let timeOfDay = save && Number.isFinite(save.time) ? save.time : START_TIME;
  let state = 'title';          // 'title' | 'playing' | 'paused'
  let hudHidden = false;
  let debug = false;
  let ignoreUnlock = false;     // pointer lock released on purpose (inventory)
  let time = 0;
  let last = performance.now();
  let fps = 60, frameMs = 16.7;
  let frameIndex = 0;
  let eyeSkyLight = 1, eyeSkyTarget = 1, blockLight = 0;
  let dynScale = settings.renderScale;
  let slowTime = 0, fastTime = 0;
  let saveTimer = 0;
  let biomeName = '';
  let lastHotbarSig = '';
  const captureWaiters = [];      // pending __game.capture() calls (tests)

  // Title-screen camera: a slow drift above the spawn area.
  const anchor = { x: player.pos[0], z: player.pos[2], y: player.pos[1] };
  let top = anchor.y;
  for (let dz = -16; dz <= 16; dz += 4) {
    for (let dx = -16; dx <= 16; dx += 4) top = Math.max(top, gen.heightAt(Math.floor(anchor.x + dx), Math.floor(anchor.z + dz)) + 1);
  }
  anchor.y = Math.min(HEIGHT + 20, Math.max(anchor.y + 9, top + 5));
  const titleCam = { pos: [anchor.x, anchor.y, anchor.z], yaw: player.yaw, pitch: -0.12 };
  function updateTitleCamera(t) {
    titleCam.yaw = player.yaw + t * 0.018;
    titleCam.pitch = -0.13 + 0.035 * Math.sin(t * 0.05);
    titleCam.pos = [anchor.x + Math.sin(t * 0.011) * 5, anchor.y + Math.sin(t * 0.07) * 0.6, anchor.z + Math.cos(t * 0.009) * 5];
  }

  function saveGame() {
    if (TEST) return;
    writeSave({
      seed,
      time: timeOfDay,
      player: { x: player.pos[0], y: player.pos[1], z: player.pos[2], yaw: player.yaw, pitch: player.pitch, flying: player.flying },
      hotbar: player.hotbar,
      selected: player.selected,
      edits: world.exportEdits(),
    });
  }

  function requestPlayLock() {
    sound.resume();
    input.requestLock().then((ok) => {
      if (!ok && !TEST && !input.locked) ui.toast('Mouse capture is blocked here. Drag with the mouse to look around.');
    });
  }

  function startPlaying() {
    state = 'playing';
    ui.hideTitle();
    ui.hidePause();
    requestPlayLock();
  }

  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    if (ui.inventoryOpen) ui.toggleInventory(false);
    ui.showPause();
    saveGame();
  }

  function openInventory() {
    ignoreUnlock = true;
    ui.toggleInventory(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function closeInventory() {
    ui.toggleInventory(false);
    ignoreUnlock = false;
    requestPlayLock();
  }

  const ui = new UI({
    textures,
    settings,
    sound,
    onSettingsChange(next) {
      const scaleChanged = next.renderScale !== settings.renderScale;
      settings = TEST ? { ...next, autoResolution: false } : next;
      saveSettings(next);
      if (scaleChanged || !settings.autoResolution) dynScale = settings.renderScale;
      renderer.applySettings({ ...settings, renderScale: Math.min(dynScale, settings.renderScale) });
      applyAudioSettings();
    },
    onPlay: startPlaying,
    onResume: startPlaying,
    onNewWorld() {
      clearSave();
      world.terminate();
      location.reload();
    },
    onQuit() {
      saveGame();
      state = 'title';
      ui.hidePause();
      ui.showTitle();
    },
    onHotbarChange(ids, selected) {
      player.hotbar = ids.slice(0, 9);
      if (Number.isInteger(selected)) player.selected = clamp(selected, 0, 8);
    },
  });

  function applyAudioSettings() {
    sound.enabled = !!settings.sound;
    sound.setVolume(settings.volume);
  }
  applyAudioSettings();

  input.onLockChange = (locked) => {
    if (!locked && state === 'playing' && !ignoreUnlock) pause();
  };

  player.onBreak = (x, y, z, id) => {
    particles.spawnBlockBreak(x, y, z, id);
    sound.play('break', BLOCKS[id].sound, [x + 0.5, y + 0.5, z + 0.5]);
  };
  player.onPlace = (x, y, z, id) => sound.play('place', BLOCKS[id].sound, [x + 0.5, y + 0.5, z + 0.5]);
  player.onStep = (id) => { if (BLOCKS[id]) sound.play('step', BLOCKS[id].sound); };
  player.onSplash = () => {
    sound.play('splash', 'water');
    if (particles.spawnSplash) particles.spawnSplash(player.pos[0], player.pos[1] + 0.5, player.pos[2]);
  };

  ui.showTitle();
  ui.setHotbar(player.hotbar, player.selected);
  renderer.applySettings({ ...settings, renderScale: dynScale });

  addEventListener('resize', () => renderer.resize());
  addEventListener('pagehide', saveGame);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveGame(); });

  function handleKeys() {
    if (state !== 'playing') return;
    if (ui.inventoryOpen) {
      if (input.pressed('KeyE') || input.pressed('Escape')) closeInventory();
      return;
    }
    if (input.pressed('KeyE')) { openInventory(); return; }
    // With pointer lock, Escape arrives as a lock loss instead of a key press.
    if (input.pressed('Escape')) { pause(); return; }
    if (input.pressed('F1')) hudHidden = !hudHidden;
    if (input.pressed('F3')) debug = !debug;
  }

  function adaptResolution(dt) {
    if (!settings.autoResolution || state === 'title') return;
    // rAF is vsync-capped, so ~16.7 ms means "keeping up"; step down quickly, recover slowly.
    if (frameMs > 22) { slowTime += dt; fastTime = 0; } else if (frameMs < 18) { fastTime += dt; slowTime = 0; } else { slowTime = fastTime = 0; }
    let next = dynScale;
    if (slowTime > 1.0) { next = Math.max(0.5, dynScale - 0.1); slowTime = 0; }
    if (fastTime > 4.0) { next = Math.min(settings.renderScale, dynScale + 0.05); fastTime = 0; }
    if (Math.abs(next - dynScale) > 1e-3) {
      dynScale = next;
      renderer.applySettings({ ...settings, renderScale: dynScale });
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
    last = now;
    time += dt;
    frameIndex++;
    frameMs += ((dt * 1000) - frameMs) * 0.1;
    fps = frameMs > 0 ? 1000 / frameMs : 0;

    handleKeys();

    const allowInput = state === 'playing' && !ui.menuOpen;
    let camPos, yaw, pitch, fovScale = 1, bob = { x: 0, y: 0 };
    if (state === 'title') {
      updateTitleCamera(time);
      camPos = titleCam.pos;
      yaw = titleCam.yaw;
      pitch = titleCam.pitch;
    } else {
      if (state === 'playing') player.update(dt, settings, allowInput);
      const eye = player.eye();
      if (settings.viewBobbing && state === 'playing') bob = player.bob();
      const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
      camPos = [eye[0] + rx * bob.x, eye[1] + bob.y, eye[2] + rz * bob.x];
      yaw = player.yaw;
      pitch = player.pitch;
      fovScale = player.fovScale();
    }

    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    world.update(camPos[0], camPos[2], settings.renderDistance, fx, fz);

    if (state !== 'paused' && settings.dayLength > 0) timeOfDay = (timeOfDay + dt / settings.dayLength) % 1;
    const sunDir = sunDirection(timeOfDay);
    const moonDir = [-sunDir[0], -sunDir[1], -sunDir[2]];

    if (frameIndex % 4 === 0) eyeSkyTarget = skyExposure(world, camPos);
    if (frameIndex % 8 === 0 && state !== 'title') blockLight = nearbyBlockLight(world, camPos);
    eyeSkyLight += (eyeSkyTarget - eyeSkyLight) * (1 - Math.exp(-dt * 1.5));

    const underwater = state !== 'title' && !!player.eyeInWater;
    particles.update(dt, world);

    const playingView = state !== 'title' && !hudHidden;
    renderer.render({
      camPos, yaw, pitch,
      fov: (settings.fov * Math.PI / 180) * fovScale,
      time, dt, timeOfDay, sunDir, moonDir,
      underwater,
      eyeSkyLight,
      selection: playingView && state === 'playing' ? player.target : null,
      particles,
      held: playingView ? {
        blockId: player.hotbar[player.selected],
        swing: player.swing || 0,
        equip: player.equip || 0,
        bobX: bob.x, bobY: bob.y,
        light: [eyeSkyLight, blockLight],
      } : null,
      cloudCoverage: settings.cloudCoverage,
    });

    if (captureWaiters.length) {
      // Read the canvas in the same task as the draw (no preserveDrawingBuffer needed).
      const url = canvas.toDataURL('image/png');
      for (const resolve of captureWaiters.splice(0)) resolve(url);
    }

    if (sound.setListener) sound.setListener(camPos, yaw);
    if (sound.ambient && frameIndex % 15 === 0) sound.ambient(timeOfDay, underwater, eyeSkyLight);

    if (state === 'title') {
      const radius = Math.min(4, settings.renderDistance);
      const f = world.loadedFraction(radius);
      ui.setLoading(f, f >= 1 ? 'World ready' : `Generating terrain · ${Math.round(f * 100)}%`);
    }

    const sig = player.hotbar.join(',') + '|' + player.selected;
    if (sig !== lastHotbarSig) {
      lastHotbarSig = sig;
      ui.setHotbar(player.hotbar, player.selected);
    }

    if (debug && frameIndex % 10 === 0) {
      const b = gen.biomeAt(Math.floor(camPos[0]), Math.floor(camPos[2]));
      biomeName = (BIOMES[b] && BIOMES[b].name) || '';
    }
    const t = player.target;
    ui.update({
      fps,
      pos: state === 'title' ? camPos : player.pos,
      yaw, pitch,
      biome: biomeName,
      chunks: world.loadedCount,
      drawCalls: renderer.stats ? renderer.stats.drawCalls : 0,
      quads: renderer.stats ? renderer.stats.quads : 0,
      time: timeOfDay,
      flying: !!player.flying,
      underwater,
      target: t && BLOCKS[t.id] ? BLOCKS[t.id].label : null,
      debug,
      hideHud: hudHidden,
      showFps: settings.showFps,
      renderScale: dynScale,
      state,
    });

    adaptResolution(dt);
    if (state === 'playing') {
      saveTimer += dt;
      if (saveTimer > 10) { saveTimer = 0; saveGame(); }
    }
    input.endFrame();
  }

  window.__game = {
    player, world, renderer, ui, gen, particles,
    get settings() { return settings; },
    get state() { return state; },
    get timeOfDay() { return timeOfDay; },
    get frame() { return frameIndex; },
    setTime(t) { timeOfDay = ((t % 1) + 1) % 1; },
    teleport(x, y, z, yaw = player.yaw, pitch = player.pitch) {
      player.pos = [x, y, z];
      if (player.vel) player.vel = [0, 0, 0];
      player.yaw = yaw;
      player.pitch = pitch;
      player.flying = true;
    },
    play() {
      if (TEST) { state = 'playing'; ui.hideTitle(); ui.hidePause(); } else startPlaying();
    },
    setSettings(patch) {
      settings = { ...settings, ...patch };
      renderer.applySettings({ ...settings, renderScale: patch.renderScale ?? dynScale });
      if (patch.renderScale) dynScale = patch.renderScale;
    },
    loaded: (r = 3) => world.loadedFraction(r),
    capture: () => new Promise((resolve) => captureWaiters.push(resolve)),
  };

  requestAnimationFrame(frame);
}

boot();
