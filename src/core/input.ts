export type Action =
  | 'roll'
  | 'light'
  | 'heavy'
  | 'lock'
  | 'lockNext'
  | 'swap1'
  | 'swap2'
  | 'swap3'
  | 'swap4'
  | 'swapNext'
  | 'swapPrev'
  | 'heal'
  | 'allout'
  | 'pause'
  | 'confirm'
  | 'debug';

const KEY_ACTIONS: Record<string, Action> = {
  Space: 'roll',
  KeyQ: 'lock',
  Tab: 'lockNext',
  Digit1: 'swap1',
  Digit2: 'swap2',
  Digit3: 'swap3',
  Digit4: 'swap4',
  KeyE: 'swapNext',
  KeyR: 'heal',
  KeyF: 'allout',
  Escape: 'pause',
  Enter: 'confirm',
  Backquote: 'debug',
};

// Standard gamepad mapping.
const PAD_ACTIONS: Record<number, Action> = {
  1: 'roll', // B / Circle
  5: 'light', // RB / R1
  7: 'heavy', // RT / R2
  11: 'lock', // R3
  4: 'lockNext', // LB / L1
  2: 'heal', // X / Square
  3: 'allout', // Y / Triangle
  12: 'swap1', // d-pad up
  15: 'swap2', // d-pad right
  13: 'swap3', // d-pad down
  14: 'swap4', // d-pad left
  9: 'pause', // Start
  0: 'confirm', // A / Cross
};

/**
 * Collects keyboard, mouse and gamepad into game actions. Presses are time-stamped so
 * the game can buffer them (a press slightly before an animation ends still counts).
 */
export class Input {
  move = { x: 0, y: 0 };
  look = { x: 0, y: 0 };
  sprint = false;
  heavyHeld = false;
  /** Advanced by the game with unscaled time so buffering also works in fast-forward. */
  time = 0;
  pointerLocked = false;
  lastDevice: 'kbm' | 'pad' = 'kbm';
  /** Optional override used by the autoplay bot: a world-space move direction. */
  worldMove: { x: number; z: number } | null = null;
  enabled = true;
  /** Set by the game: whether a click should capture the mouse right now. */
  wantLock: () => boolean = () => false;

  private keys = new Set<string>();
  private pressed = new Map<Action, number>();
  private mouseDX = 0;
  private mouseDY = 0;
  private padPrev: boolean[] = [];
  private padLook = { x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.lastDevice = 'kbm';
      const a = KEY_ACTIONS[e.code];
      if (a) this.press(a);
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.lastDevice = 'kbm';
      if (!this.pointerLocked) {
        // Ask for the mouse inside the click itself, while the browser still allows it.
        if (this.wantLock()) this.requestPointerLock();
        this.press('confirm');
        return;
      }
      if (e.button === 0) this.press('light');
      if (e.button === 2) {
        this.press('heavy');
        this.heavyHeld = true;
      }
      if (e.button === 1) this.press('lock');
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.heavyHeld = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.pointerLocked) return;
        this.press(e.deltaY > 0 ? 'swapNext' : 'swapPrev');
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
  }

  requestPointerLock() {
    if (this.lastDevice === 'pad') return;
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch {
      /* pointer lock unavailable (e.g. automated browser): play continues without mouse look */
    }
  }

  press(a: Action) {
    this.pressed.set(a, this.time);
  }

  /** True once per press, if it happened within the buffer window. */
  consume(a: Action, buffer = 0.2): boolean {
    const t = this.pressed.get(a);
    if (t === undefined) return false;
    this.pressed.delete(a);
    return this.enabled && this.time - t <= buffer;
  }

  peek(a: Action, buffer = 0.2): boolean {
    const t = this.pressed.get(a);
    return this.enabled && t !== undefined && this.time - t <= buffer;
  }

  clear() {
    this.pressed.clear();
  }

  /** Call once per rendered frame. */
  poll() {
    let x = 0;
    let y = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    let sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    this.padLook.x = 0;
    this.padLook.y = 0;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || pad.mapping !== 'standard') continue;
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
      const ax = dz(pad.axes[0] ?? 0);
      const ay = dz(pad.axes[1] ?? 0);
      if (ax || ay) {
        x += ax;
        y -= ay;
        this.lastDevice = 'pad';
      }
      this.padLook.x += dz(pad.axes[2] ?? 0);
      this.padLook.y += dz(pad.axes[3] ?? 0);
      pad.buttons.forEach((b, i) => {
        const down = b.pressed || b.value > 0.5;
        if (down && !this.padPrev[i]) {
          this.lastDevice = 'pad';
          const a = PAD_ACTIONS[i];
          if (a) this.press(a);
        }
        this.padPrev[i] = down;
      });
      if (pad.buttons[10]?.pressed || pad.buttons[0]?.pressed) sprint = true;
      break;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.move.x = x;
    this.move.y = y;
    this.sprint = sprint;
    this.look.x = this.mouseDX * 0.0024 + this.padLook.x * 0.045;
    this.look.y = this.mouseDY * 0.0024 + this.padLook.y * 0.03;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
