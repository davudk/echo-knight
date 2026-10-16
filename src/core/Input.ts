import { Vector2 } from 'three';
import { Bindings, MoveKeys, PadAxes, type Action } from '../config/bindings';
import { Tuning } from '../config/tuning';

export type Device = 'kbm' | 'pad';

const ACTIONS = Object.keys(Bindings) as Action[];
const STICK_DEADZONE = 0.18;

/**
 * Device-agnostic input. Call `update(now)` once per frame before gameplay.
 *
 * - `move`  : camera-space move intent, x = right, y = forward, |v| <= 1
 * - `look`  : camera rotation delta for this frame (radians)
 * - `pressed / held / released` : per-frame button edges
 * - `consume(action, window)` : buffered press — true if pressed in the last
 *   `window` seconds and not yet consumed. This is what makes inputs feel
 *   responsive during animations.
 */
export class Input {
  readonly move = new Vector2();
  readonly look = new Vector2();
  lastDevice: Device = 'kbm';
  pointerLocked = false;

  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  private mouseDelta = new Vector2();
  private heldNow = new Set<Action>();
  private heldPrev = new Set<Action>();
  private pressTime = new Map<Action, number>();
  private now = 0;
  private padConnected = false;
  private onDeviceChange: ((d: Device) => void) | null = null;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      this.keys.add(e.code);
      this.setDevice('kbm');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
    });
    element.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      this.setDevice('kbm');
    });
    window.addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDelta.x += e.movementX;
      this.mouseDelta.y += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.element;
    });
    window.addEventListener('gamepadconnected', () => (this.padConnected = true));
  }

  requestPointerLock() {
    if (this.pointerLocked) return;
    // Returns a promise in modern browsers; it rejects in some embedded views.
    const p = this.element.requestPointerLock?.() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  }

  onDevice(cb: (d: Device) => void) {
    this.onDeviceChange = cb;
  }

  private setDevice(d: Device) {
    if (d === this.lastDevice) return;
    this.lastDevice = d;
    this.onDeviceChange?.(d);
  }

  private getPad(): Gamepad | null {
    if (!this.padConnected) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }

  update(now: number, dt: number) {
    this.now = now;
    const pad = this.getPad();

    // --- buttons -------------------------------------------------------------
    [this.heldPrev, this.heldNow] = [this.heldNow, this.heldPrev];
    this.heldNow.clear();
    let padActive = false;
    for (const a of ACTIONS) {
      const b = Bindings[a];
      let down = b.keys.some((k) => this.keys.has(k)) || b.mouse.some((m) => this.mouseButtons.has(m));
      if (pad) {
        for (const i of b.pad) {
          const btn = pad.buttons[i];
          if (btn && (btn.pressed || btn.value > 0.5)) {
            down = true;
            padActive = true;
          }
        }
      }
      if (down) {
        this.heldNow.add(a);
        if (!this.heldPrev.has(a)) this.pressTime.set(a, now);
      }
    }

    // --- move ------------------------------------------------------------------
    const kx = +MoveKeys.right.some((k) => this.keys.has(k)) - +MoveKeys.left.some((k) => this.keys.has(k));
    const ky = +MoveKeys.forward.some((k) => this.keys.has(k)) - +MoveKeys.back.some((k) => this.keys.has(k));
    this.move.set(kx, ky);
    if (this.move.lengthSq() > 1) this.move.normalize();

    const sens = Tuning.camera.mouseSensitivity;
    this.look.set(this.mouseDelta.x * sens, this.mouseDelta.y * sens);
    this.mouseDelta.set(0, 0);

    if (pad) {
      const m = radialDeadzone(pad.axes[PadAxes.moveX] ?? 0, -(pad.axes[PadAxes.moveY] ?? 0));
      const l = radialDeadzone(pad.axes[PadAxes.lookX] ?? 0, pad.axes[PadAxes.lookY] ?? 0);
      if (m.lengthSq() > 0) {
        this.move.copy(m);
        padActive = true;
      }
      if (l.lengthSq() > 0) {
        // Slight response curve: precise near centre, fast at the edge.
        l.multiplyScalar(l.length());
        this.look.x += l.x * Tuning.camera.stickSpeed * dt;
        this.look.y += l.y * Tuning.camera.stickSpeed * 0.75 * dt;
        padActive = true;
      }
    }
    if (padActive) this.setDevice('pad');
  }

  held(a: Action) {
    return this.heldNow.has(a);
  }
  pressed(a: Action) {
    return this.heldNow.has(a) && !this.heldPrev.has(a);
  }
  released(a: Action) {
    return !this.heldNow.has(a) && this.heldPrev.has(a);
  }

  /** Buffered press: true if `a` was pressed within `window` seconds and not yet consumed. */
  consume(a: Action, window = 0.15): boolean {
    const t = this.pressTime.get(a);
    if (t === undefined || this.now - t > window) return false;
    this.pressTime.delete(a);
    return true;
  }

  /** Peek at a buffered press without consuming it. */
  buffered(a: Action, window = 0.15): boolean {
    const t = this.pressTime.get(a);
    return t !== undefined && this.now - t <= window;
  }

  clearBuffer(a: Action) {
    this.pressTime.delete(a);
  }
}

function radialDeadzone(x: number, y: number): Vector2 {
  const v = new Vector2(x, y);
  const len = v.length();
  if (len < STICK_DEADZONE) return v.set(0, 0);
  const scaled = Math.min(1, (len - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return v.multiplyScalar(scaled / len);
}
