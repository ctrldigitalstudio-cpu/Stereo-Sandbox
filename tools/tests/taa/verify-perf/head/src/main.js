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
import { loadSettings, QUALITY_PRESETS } from './config.js';
import { B, BLOCKS, DEFAULT_HOTBAR, OPAQUE, EMIT, HEIGHT } from './blocks.js';
import { clamp } from './math.js';

const SAVE_KEY = 'stereo-sandbox.save.v1';
const LEGACY_SAVE_KEY = 'blockvale.save.v1';   // saves from before the rename to Stereo Sandbox (read-only)
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const SUN_TILT = (25 * Math.PI) / 180;
const START_TIME = 0.4; // mid-afternoon: the first sunset arrives a couple of minutes in
const media = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
// No mouse or trackpad at all (phones, tablets): there are no touch controls yet.
const TOUCH_ONLY = media('(any-pointer: coarse)') && !media('(any-pointer: fine)');
const REDUCED_MOTION = media('(prefers-reduced-motion: reduce)');
const SESSION = Math.random().toString(36).slice(2, 10);   // tells this tab's saves from other tabs'

function sunDirection(timeOfDay) {
  const a = timeOfDay * Math.PI * 2;
  return [Math.cos(a), Math.sin(a) * Math.cos(SUN_TILT), Math.sin(a) * Math.sin(SUN_TILT)];
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY) || localStorage.getItem(LEGACY_SAVE_KEY);
    const save = raw ? JSON.parse(raw) : null;
    return save && typeof save === 'object' ? save : null;
  } catch (e) {
    return null;
  }
}

// Returns null when saved, else the error (storage full, or blocked in an opaque sandbox).
function writeSave(data) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return null;
  } catch (e) {
    return e || new Error('save failed');   // the game keeps running either way
  }
}

function clearSave() {
  // Both keys: a leftover legacy save would otherwise be picked up again as the "new" world.
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  try { localStorage.removeItem(LEGACY_SAVE_KEY); } catch (e) { /* ignore */ }
}

function fatal(message, detail) {
  const el = document.createElement('div');
  el.className = 'fatal-error';
  el.setAttribute('role', 'alert');
  el.innerHTML = '<h1>Stereo Sandbox can\'t start</h1><p></p><pre></pre>';
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
  // Headless tests render in software: default to settings that keep a frame under a few seconds.
  // ?test&preset=high (etc.) tests a real preset instead.
  if (TEST) {
    const preset = QUALITY_PRESETS[params.get('preset')];
    settings = preset
      ? { ...settings, ...preset, preset: params.get('preset'), autoResolution: false }
      : { ...settings, autoResolution: false, renderDistance: 6, shadowRes: 1024, shadowRadius: 64, volumetrics: 12, clouds: 10, ssr: 16 };
  }

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
    onFallback: () => console.warn('World worker unavailable here: generating terrain on the page instead (slower).'),
  });

  const input = new Input(canvas);
  const sound = new Sound();
  const player = new Player(world, input, sound);
  const particles = new ParticleSystem(textures);

  const spawn = gen.findSpawn();
  const sp = save && save.player;
  if (sp && [sp.x, sp.y, sp.z].every(Number.isFinite)) {
    player.pos = [sp.x, clamp(sp.y, 1, HEIGHT + 64), sp.z];
    player.yaw = Number.isFinite(sp.yaw) ? sp.yaw : 0;
    player.pitch = Number.isFinite(sp.pitch) ? clamp(sp.pitch, -1.57, 1.57) : 0;
    player.flying = !!sp.flying;
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
  let redraw = true, lastDraw = -1;   // paused: draw only now and then
  let probe = null, holdUntil = 0, holdoff = 0;   // adaptive resolution (see adaptResolution)
  let slowTime = 0, fastTime = 0;
  let saveTimer = 0;
  let discarded = false;          // "New world": nothing may re-save the old world while the page unloads
  let biomeName = '';
  let lastHotbarSig = '';
  const captureWaiters = [];      // pending __game.capture() calls (tests)
  let skipRender = false;         // tests: simulate without drawing (software GL takes seconds per frame)
  const lastCam = { pos: [0, 0, 0], yaw: 0, pitch: 0 };

  // Title-screen camera: a slow pan above the player's area (spawn in a new world), starting just
  // left of the sun so the golden-hour light rakes across the terrain and swings past the sun
  // after ~40 s. Re-aimed when the player quits to the title, so the world there is already loaded.
  const anchor = { x: 0, y: 0, z: 0 };
  let sunYaw = 0, titleT0 = 0;
  function aimTitleCamera() {
    anchor.x = player.pos[0];
    anchor.z = player.pos[2];
    let top = player.pos[1];
    for (let dz = -24; dz <= 24; dz += 3) {
      for (let dx = -24; dx <= 24; dx += 3) top = Math.max(top, gen.heightAt(Math.floor(anchor.x + dx), Math.floor(anchor.z + dz)) + 1);
    }
    anchor.y = Math.min(HEIGHT + 24, top + 14); // clears the tallest trees (~12 blocks)
    const sun = sunDirection(timeOfDay);
    sunYaw = Math.atan2(-sun[0], -sun[2]);     // yaw whose forward vector points at the sun
  }
  aimTitleCamera();
  function titleCameraAt(t) {
    return {
      // Reduced motion: only the slow pan remains (no bobbing, no pitch sway).
      pos: [anchor.x + Math.sin(t * 0.011) * 5, anchor.y + (REDUCED_MOTION ? 0 : Math.sin(t * 0.07) * 0.6), anchor.z + Math.cos(t * 0.009) * 5],
      yaw: sunYaw - 0.75 + t * 0.018,
      pitch: -0.15 + (REDUCED_MOTION ? 0 : 0.035 * Math.sin(t * 0.05)),
    };
  }

  // Two tabs with the same world would overwrite each other's edits (last writer wins). Every
  // save carries a revision and this tab's id; a tab that finds a newer revision from another tab
  // stops saving instead of clobbering it, and says so. Unchanged state isn't rewritten, so a tab
  // merely left open in the background never takes over the save.
  let saveRev = save && Number.isFinite(save.rev) ? save.rev : 0;
  let lastSaved = null, saveFullWarned = false, saveConflict = false;
  function saveGame() {
    if (TEST || discarded || saveConflict) return;
    const data = {
      seed,
      time: timeOfDay,
      player: { x: player.pos[0], y: player.pos[1], z: player.pos[2], yaw: player.yaw, pitch: player.pitch, flying: player.flying },
      hotbar: player.hotbar,
      selected: player.selected,
      edits: world.exportEdits(),
    };
    const sig = JSON.stringify({ ...data, time: 0 });
    if (sig === lastSaved) return;
    const stored = loadSave();
    if (stored && stored.sid !== SESSION && ((stored.rev || 0) > saveRev || stored.seed !== seed)) {
      saveConflict = true;
      ui.toast('This world was saved from another tab or window. Reload to continue from there; this tab won\'t save over it.', 10000);
      return;
    }
    data.rev = saveRev + 1;
    data.sid = SESSION;
    const err = writeSave(data);
    if (!err) { saveRev = data.rev; lastSaved = sig; }
    // Blocked storage (sandbox) means saving is simply off; a full one would lose work silently.
    if (err && /quota/i.test(`${err.name} ${err.message}`) && !saveFullWarned) {
      saveFullWarned = true;
      ui.toast('This browser\'s storage is full, so the world can\'t be saved right now.', 8000);
    }
  }

  let lockHintShown = false;
  function requestPlayLock() {
    sound.resume();
    input.requestLock().then((ok) => {
      // Once per session: in a sandboxed frame every resume fails the same way.
      if (!ok && !TEST && !input.locked && !lockHintShown) {
        lockHintShown = true;
        ui.toast('Mouse capture is blocked here. Drag with the mouse to look around.');
      }
    });
  }

  // The second click of a double-clicked Play / Resume / Done lands on the canvas once the menu is
  // gone: don't let it break a block the moment the game starts.
  const DOUBLE_CLICK_MS = 400;

  function startPlaying() {
    if (TOUCH_ONLY && !TEST) {
      ui.toast('Stereo Sandbox needs a keyboard and mouse to play. Until then, enjoy the view.');
      return;
    }
    input.suppressClicks(DOUBLE_CLICK_MS);
    state = 'playing';
    ui.hideTitle();
    ui.hidePause();
    requestPlayLock();
  }

  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    input.cancelLock();          // a delayed lock retry must not capture the mouse over the menu
    if (document.pointerLockElement) document.exitPointerLock();
    if (ui.inventoryOpen) ui.toggleInventory(false);
    ui.showPause();
    saveGame();
  }

  function openInventory() {
    ignoreUnlock = true;
    input.cancelLock();
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
    seed,
    version: '1.0',
    onSettingsChange(next) {
      const scaleChanged = next.renderScale !== settings.renderScale;
      settings = TEST ? { ...next, autoResolution: false } : next; // the UI persists `next` itself
      if (scaleChanged || !settings.autoResolution) { dynScale = settings.renderScale; probe = null; }
      renderer.applySettings({ ...settings, renderScale: Math.min(dynScale, settings.renderScale) });
      applyAudioSettings();
      redraw = true;
    },
    onPlay: startPlaying,
    onResume: startPlaying,
    onNewWorld() {
      discarded = true;             // pagehide / visibilitychange during the reload would write it back
      clearSave();
      world.terminate();
      location.reload();
    },
    onQuit() {
      input.cancelLock();
      saveGame();
      aimTitleCamera();
      titleT0 = time;
      state = 'title';
      ui.hidePause();
      ui.showTitle();
    },
    onInventoryClose: () => { input.suppressClicks(DOUBLE_CLICK_MS); closeInventory(); },   // Done button
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
    // A lock granted late (after a retry) while a menu is up would hide the cursor over it.
    if (locked && (state !== 'playing' || ui.menuOpen)) { document.exitPointerLock(); return; }
    if (!locked && state === 'playing' && !ignoreUnlock) pause();
  };
  // Without pointer lock nothing else notices the player leaving (e.g. clicking the page around
  // an embedded game): pause, so the keys they type elsewhere don't matter and Resume takes them back.
  addEventListener('blur', () => { if (state === 'playing' && !input.locked && !TEST) pause(); });

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

  addEventListener('resize', () => { renderer.resize(); redraw = true; });
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

  // Adaptive resolution from the rAF interval, the only portable cost signal. It is capped by
  // vsync, and not always at 60 Hz (battery savers, some displays and remote sessions cap rAF at
  // 30 Hz with the GPU half idle), so every step down is a probe: when the faster recent frames
  // (a low percentile of the interval, immune to streaming hitches) don't get faster within 2 s,
  // resolution wasn't the bottleneck; the step is undone and probing backs off.
  const recentMs = new Float32Array(32);
  const fastestRecent = () => {
    const v = Array.from(recentMs).filter((x) => x > 0).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 4)] : Infinity;
  };
  function adaptResolution(dt) {
    recentMs[frameIndex % recentMs.length] = dt * 1000;
    if (!settings.autoResolution || state === 'paused') return;
    if (state === 'title' && world.loadedFraction(2) < 1) return;   // streaming spikes
    if (probe) {
      probe.t += dt;
      if (probe.t < 2) return;
      if (fastestRecent() > probe.ms * 0.9) {
        if (probe.steps < 2 && dynScale > 0.5 + 1e-3) {
          // Intervals come in whole vsync periods: one step may not cross one. Try a second.
          probe.steps++;
          probe.t = 0;
          dynScale = Math.max(0.5, dynScale - 0.1);
          renderer.applySettings({ ...settings, renderScale: dynScale });
          return;
        }
        dynScale = probe.from;
        renderer.applySettings({ ...settings, renderScale: dynScale });
        holdoff = Math.min(300, holdoff * 2 || 30);
        holdUntil = time + holdoff;
      }
      probe = null;
      slowTime = fastTime = 0;
      return;
    }
    if (time < holdUntil) return;
    // ~16.7 ms means "keeping up" at 60 Hz; step down quickly, recover slowly.
    if (frameMs > 22) { slowTime += dt; fastTime = 0; } else if (frameMs < 18) { fastTime += dt; slowTime = 0; } else { slowTime = fastTime = 0; }
    let next = dynScale;
    if (slowTime > 1.0 && dynScale > 0.5 + 1e-3) {
      next = Math.max(0.5, dynScale - 0.1);
      probe = { from: dynScale, ms: fastestRecent(), t: 0, steps: 1 };
      slowTime = 0;
    }
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
      ({ pos: camPos, yaw, pitch } = titleCameraAt(time - titleT0));
    } else {
      if (state === 'playing') player.update(dt, settings, allowInput);
      const eye = player.eye();
      if (settings.viewBobbing && state === 'playing') bob = player.bob();
      const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
      camPos = [eye[0] + rx * bob.x, eye[1] + bob.y, eye[2] + rz * bob.x];
      yaw = player.yaw;
      pitch = player.pitch;
      // Reduced motion: no sprint / flight FOV kick (the underwater narrowing stays).
      fovScale = REDUCED_MOTION ? (player.eyeInWater ? 0.94 : 1) : player.fovScale();
    }

    lastCam.pos = camPos;
    lastCam.yaw = yaw;
    lastCam.pitch = pitch;
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
    // Paused, the view hardly changes under the menu's blur: draw ~10 times a second (and right
    // after a setting or the window size changed) instead of keeping the GPU at full load.
    const idle = state === 'paused' && !redraw && time - lastDraw < 0.1;
    if ((!skipRender && !idle) || captureWaiters.length) {
      lastDraw = time;
      redraw = false;
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
    }

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
    get renderScale() { return dynScale; },
    get adaptive() { return { probe: probe && { ...probe }, holdUntil, time, fastest: fastestRecent(), frameMs }; },
    get camera() { return { pos: lastCam.pos.slice(), yaw: lastCam.yaw, pitch: lastCam.pitch }; },
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
      ui.setSettings(settings);
      renderer.applySettings({ ...settings, renderScale: patch.renderScale ?? dynScale });
      if (patch.renderScale) dynScale = patch.renderScale;
      probe = null;
      holdUntil = holdoff = 0;
      recentMs.fill(0);
      redraw = true;
    },
    loaded: (r = 3) => world.loadedFraction(r),
    capture: () => new Promise((resolve) => captureWaiters.push(resolve)),
    setRender(on) { skipRender = !on; },
    titleCameraAt,
  };

  requestAnimationFrame(frame);
}

boot();
