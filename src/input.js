// Keyboard, mouse and pointer-lock input. Keys are tracked by KeyboardEvent.code so the physical
// layout is what matters (WASD stays WASD on AZERTY). Edges (pressed keys, clicks, mouse and wheel
// deltas) accumulate between endFrame() calls, which the game loop makes once per frame.
//
// When pointer lock is unavailable (sandboxed iframes, some embedded browsers) requestLock()
// resolves false and switches on drag-to-look: dragging with a button held turns the camera and
// swallows that button's click, a still click is still a click, and a still hold acts as a held
// button (so hold-to-break keeps working).

const DRAG_THRESHOLD = 4;          // px of movement before a pressed button becomes a drag-look
const HOLD_MS = 280;               // drag-look mode: a still press this long becomes a held button
const LOCK_TIMEOUT_MS = 1500;      // give up waiting for pointerlockchange after this long
const UNLOCK_COOLDOWN_MS = 1250;   // Chrome refuses to re-lock for ~1 s after the user pressed Esc
const WHEEL_NOTCH = 100;           // pixel-mode wheel delta that counts as one notch
const WHEEL_DISCRETE = 50;         // a single event this large is a mouse-wheel notch, not a trackpad

// Keys whose default action (page scroll, help, find, focus moves) interferes with play. Blocked
// only while the game owns the mouse, never together with Ctrl/Meta/Alt (browser shortcuts).
const BLOCK_KEYS = new Set([
  'Space', 'Tab', 'F1', 'F3', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Slash', 'Quote',
]);

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

function isTextField(t) {
  if (!t || typeof t.tagName !== 'string') return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(String(t.type || 'text').toLowerCase());
}

function isInteractive(t) {
  if (!t || typeof t.tagName !== 'string') return false;
  return t.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON|A|SUMMARY)$/.test(t.tagName);
}

// Fallback for events without `code` (a few virtual keyboards): map the key to its usual code.
function codeOf(e) {
  if (e.code) return e.code;
  const k = e.key;
  if (!k) return '';
  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (k === 'Shift') return 'ShiftLeft';
  if (k === 'Control') return 'ControlLeft';
  if (k === 'Alt') return 'AltLeft';
  if (k === 'Esc') return 'Escape';
  return k;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Input {
  constructor(element) {
    this.element = element || null;
    this.win = typeof window !== 'undefined' ? window : null;
    this.doc = typeof document !== 'undefined' ? document : null;
    this.now = nowMs;                 // injectable clock (tests)

    this.keys = new Set();            // codes currently held
    this.keysPressed = new Set();     // codes that went down since endFrame()
    this.buttons = [false, false, false];
    this.buttonsPressed = [false, false, false];
    this.dx = 0;
    this.dy = 0;
    this.wheelSteps = 0;
    this.wheelAcc = 0;
    this.wheelTime = 0;

    this.locked = false;
    this.dragLook = false;
    this.onLockChange = null;
    this.rawInput = true;             // ask for unadjustedMovement (no OS acceleration) when possible

    this._gesture = null;             // drag-look press being classified (click / drag / hold)
    this._unlockTime = -1e9;
    this._skipMoves = 0;
    this._lastMove = 0;
    this._lockPending = null;
    this._lockWaiter = null;

    this._listeners = [];
    const on = (target, type, fn, opts) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      const bound = fn.bind(this);
      target.addEventListener(type, bound, opts);
      this._listeners.push([target, type, bound, opts]);
    };
    on(this.win, 'keydown', this._onKeyDown);
    on(this.win, 'keyup', this._onKeyUp);
    on(this.win, 'blur', this.releaseAll);
    on(this.win, 'mousemove', this._onMouseMove);
    on(this.win, 'mouseup', this._onMouseUp);
    on(this.doc, 'pointerlockchange', this._onLockChange);
    on(this.doc, 'pointerlockerror', this._onLockError);
    on(this.doc, 'visibilitychange', this._onVisibility);
    on(this.element, 'mousedown', this._onMouseDown);
    on(this.element, 'contextmenu', this._onContextMenu);
    on(this.element, 'wheel', this._onWheel, { passive: false });
  }

  // ---- queries -------------------------------------------------------------------------------

  isDown(code) { return this.keys.has(code); }
  pressed(code) { return this.keysPressed.has(code); }
  mouseDelta() { return [this.dx, this.dy]; }
  wheel() { return this.wheelSteps; }

  buttonPressed(i) {
    this._pollGesture();
    return !!this.buttonsPressed[i];
  }

  buttonDown(i) {
    this._pollGesture();
    return !!this.buttons[i];
  }

  endFrame() {
    this.keysPressed.clear();
    this.buttonsPressed[0] = this.buttonsPressed[1] = this.buttonsPressed[2] = false;
    this.dx = 0;
    this.dy = 0;
    this.wheelSteps = 0;
  }

  releaseAll() {
    this.keys.clear();
    this.buttons[0] = this.buttons[1] = this.buttons[2] = false;
    this._gesture = null;
    this.wheelAcc = 0;
  }

  destroy() {
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners.length = 0;
    this.releaseAll();
  }

  // ---- pointer lock --------------------------------------------------------------------------

  // Resolves true once the pointer is locked to the element. On failure (denied, unsupported,
  // timed out) drag-to-look is switched on and it resolves false. Call from a user gesture.
  requestLock() {
    if (this.locked) return Promise.resolve(true);
    if (this._lockPending) return this._lockPending;
    const el = this.element, doc = this.doc;
    this._blurFocused();
    if (!el || !doc || typeof el.requestPointerLock !== 'function') {
      this.dragLook = true;
      return Promise.resolve(false);
    }

    this._lockPending = new Promise((resolve) => {
      let settled = false, retried = false, attemptId = 0, timer = 0;
      const clear = () => { if (timer) clearTimeout(timer); timer = 0; };
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        clear();
        this._lockWaiter = null;
        this._lockPending = null;
        if (!ok) this.dragLook = true;
        resolve(ok);
      };
      const isLocked = () => doc.pointerLockElement === el;
      const failed = () => {
        // Denied right after the user left pointer lock with Esc: Chrome's re-lock cooldown.
        // Retry once when it has passed instead of dropping to drag-look for the whole session.
        const since = this.now() - this._unlockTime;
        if (!retried && since < UNLOCK_COOLDOWN_MS + 250) {
          retried = true;
          clear();
          timer = setTimeout(() => attempt(this.rawInput), Math.max(30, UNLOCK_COOLDOWN_MS - since));
          return;
        }
        settle(false);
      };
      const attempt = (raw) => {
        if (settled) return;
        const id = ++attemptId;
        let usesPromise = false;
        const onFail = (err) => {
          if (settled || id !== attemptId) return;
          if (raw && (!err || err.name === 'NotSupportedError' || err.name === 'TypeError')) {
            // unadjustedMovement isn't available on this platform: plain lock instead.
            this.rawInput = false;
            attempt(false);
            return;
          }
          failed();
        };
        this._lockWaiter = {
          locked: () => settle(true),
          // The promise form also fires pointerlockerror; let the rejection (with its reason) decide.
          error: () => { if (!usesPromise) onFail({ name: 'Error' }); },
        };
        clear();
        timer = setTimeout(() => {
          if (isLocked()) this._onLockChange();   // locked without our having seen the event
          settle(isLocked());
        }, LOCK_TIMEOUT_MS);
        let r;
        try {
          r = raw ? el.requestPointerLock({ unadjustedMovement: true }) : el.requestPointerLock();
        } catch (e) {
          if (raw) { this.rawInput = false; attempt(false); } else failed();
          return;
        }
        if (r && typeof r.then === 'function') {
          usesPromise = true;
          r.then(() => {
            if (id !== attemptId) return;
            if (isLocked()) { this._onLockChange(); settle(true); }
          }, onFail);
        }
      };
      attempt(this.rawInput);
    });
    return this._lockPending;
  }

  _onLockChange() {
    const locked = !!this.doc && !!this.element && this.doc.pointerLockElement === this.element;
    if (locked !== this.locked) {
      this.locked = locked;
      this._gesture = null;
      this.buttons[0] = this.buttons[1] = this.buttons[2] = false;
      this.dx = this.dy = 0;
      if (locked) {
        this.dragLook = false;
        this._skipMoves = 1;          // the first movement after locking is often a jump
        this._lastMove = 0;
      } else {
        this._unlockTime = this.now();
      }
      if (typeof this.onLockChange === 'function') this.onLockChange(locked);
    }
    if (locked && this._lockWaiter) this._lockWaiter.locked();
  }

  _onLockError() {
    if (this._lockWaiter) this._lockWaiter.error();
  }

  _onVisibility() {
    if (this.doc && this.doc.hidden) this.releaseAll();
  }

  _blurFocused() {
    const doc = this.doc;
    const a = doc && doc.activeElement;
    // A menu button that keeps focus would be "clicked" again by Space.
    if (a && a !== doc.body && a !== this.element && typeof a.blur === 'function') a.blur();
  }

  // ---- keyboard ------------------------------------------------------------------------------

  _onKeyDown(e) {
    const code = codeOf(e);
    if (!code || isTextField(e.target)) return;
    const modifier = code.startsWith('Control') || code.startsWith('Meta') || code.startsWith('Alt') || code.startsWith('Shift');
    // Ctrl/Cmd combinations belong to the browser (and macOS never sends keyup for Cmd+key).
    if ((e.ctrlKey || e.metaKey) && !modifier) return;
    if (!e.repeat) this.keysPressed.add(code);
    this.keys.add(code);
    if (!e.altKey && this._blocks(code, e.target) && typeof e.preventDefault === 'function') e.preventDefault();
  }

  _onKeyUp(e) {
    const code = codeOf(e);
    if (!code) return;
    this.keys.delete(code);
    if (code.startsWith('Meta')) this.keys.clear();
  }

  _blocks(code, target) {
    const gameKey = BLOCK_KEYS.has(code) || code.startsWith('Key') || code.startsWith('Digit');
    if (this.locked) return gameKey;
    // Drag-look mode: the page itself is the game, but leave focused controls (menus) alone
    // and keep Tab for keyboard navigation.
    if (this.dragLook) return gameKey && code !== 'Tab' && !isInteractive(target);
    return false;
  }

  // ---- mouse ---------------------------------------------------------------------------------

  _onMouseDown(e) {
    const b = e.button;
    if (!(b >= 0 && b <= 2)) return;
    // No middle-click autoscroll, no text selection while drag-looking.
    if ((b === 1 || this.locked || this.dragLook) && typeof e.preventDefault === 'function') e.preventDefault();
    this._blurFocused();
    if (!this.locked && this.dragLook && !this._gesture) {
      const x = e.clientX || 0, y = e.clientY || 0;
      this._gesture = { button: b, x0: x, y0: y, lastX: x, lastY: y, t0: this.now(), dragging: false, holding: false };
      return;
    }
    this._press(b);
  }

  _press(b) {
    if (!this.buttons[b]) this.buttonsPressed[b] = true;
    this.buttons[b] = true;
  }

  _onMouseUp(e) {
    const b = e.button;
    if (!(b >= 0 && b <= 2)) return;
    const g = this._gesture;
    if (g && g.button === b) {
      this._pollGesture();
      this._gesture = null;
      if (g.holding) this.buttons[b] = false;
      else if (!g.dragging) this.buttonsPressed[b] = true;   // a still click is a click
      return;
    }
    this.buttons[b] = false;
  }

  _pollGesture() {
    const g = this._gesture;
    if (g && !g.dragging && !g.holding && this.now() - g.t0 >= HOLD_MS) {
      g.holding = true;
      this._press(g.button);
    }
  }

  _onMouseMove(e) {
    if (this.locked) {
      const dx = e.movementX || 0, dy = e.movementY || 0;
      if (this._skipMoves > 0) { this._skipMoves--; return; }
      // Some browser/OS combinations report a single huge bogus delta; real flicks ramp up.
      const m = Math.abs(dx) + Math.abs(dy);
      if (m > 250 && m > 6 * (this._lastMove + 25)) return;
      this._lastMove = m;
      this.dx += dx;
      this.dy += dy;
      return;
    }
    const g = this._gesture;
    if (!g) return;
    const x = e.clientX || 0, y = e.clientY || 0;
    if (!g.dragging) {
      if (Math.hypot(x - g.x0, y - g.y0) <= DRAG_THRESHOLD) return;
      g.dragging = true;               // the click is swallowed; movement since the press counts
    }
    this.dx += x - g.lastX;
    this.dy += y - g.lastY;
    g.lastX = x;
    g.lastY = y;
  }

  _onContextMenu(e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  _onWheel(e) {
    if (e.ctrlKey) return;             // pinch / browser zoom
    if (typeof e.preventDefault === 'function') e.preventDefault();
    let d = e.deltaY || 0;
    if (!d) d = e.deltaX || 0;         // Shift+wheel arrives as horizontal on some systems
    if (!d) return;
    const now = this.now();
    if (now - this.wheelTime > 300 || Math.sign(d) !== Math.sign(this.wheelAcc)) this.wheelAcc = 0;
    this.wheelTime = now;
    if (e.deltaMode === 2) { this.wheelSteps += Math.sign(d); return; }     // pages
    if (e.deltaMode === 1) d *= WHEEL_NOTCH / 3;                            // lines (3 per notch)
    if (Math.abs(d) >= WHEEL_DISCRETE) {
      // A wheel notch (or a few coalesced ones): one slot each, however large the OS makes it.
      this.wheelSteps += Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / WHEEL_NOTCH));
      this.wheelAcc = 0;
      return;
    }
    // Trackpads and high-resolution wheels: many small deltas add up to steps.
    this.wheelAcc += d;
    while (Math.abs(this.wheelAcc) >= WHEEL_DISCRETE) {
      const s = Math.sign(this.wheelAcc);
      this.wheelSteps += s;
      this.wheelAcc -= s * WHEEL_DISCRETE;
    }
  }
}
