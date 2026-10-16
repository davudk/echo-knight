import { Camera, Vector3 } from 'three';
import { PromptLabels } from '../config/bindings';
import type { Device } from '../core/Input';

const CIRC = 2 * Math.PI * 25;

/** DOM HUD: start overlay, control prompts, ability bar, damage numbers. */
export class HUD {
  private readonly root: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly pips: HTMLElement[] = [];
  private readonly dash: { el: HTMLElement; arc: SVGCircleElement };
  private readonly dashKey: HTMLElement;
  private readonly numbers: { el: HTMLElement; pos: Vector3; age: number; life: number; vx: number }[] = [];
  private fpsAcc = 0;
  private fpsFrames = 0;
  private toastTimer = 0;
  showFps = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="overlay">
        <div>
          <h1>Echo Knight</h1>
          <p>mobility prototype</p>
          <p class="cta">click or press any button</p>
        </div>
      </div>
      <div class="controls"></div>
      <div class="abilities">
        <div>
          <div class="pips"><div class="pip"></div><div class="pip"></div><div class="pip"></div></div>
        </div>
      </div>
      <div class="fps" hidden></div>
      <div class="toast"></div>`;
    this.overlay = root.querySelector('.overlay')!;
    this.controls = root.querySelector('.controls')!;
    this.fps = root.querySelector('.fps')!;
    this.toast = root.querySelector('.toast')!;
    root.querySelectorAll<HTMLElement>('.pip').forEach((p) => this.pips.push(p));

    const bar = root.querySelector('.abilities')!;
    const mk = (cls: string, label: string) => {
      const el = document.createElement('div');
      el.className = `ability ${cls}`;
      el.innerHTML = `
        <span class="key"></span>
        <svg viewBox="0 0 56 56"><circle class="bg" cx="28" cy="28" r="25"/><circle class="arc" cx="28" cy="28" r="25"
          stroke-dasharray="${CIRC}" stroke-dashoffset="0"/></svg>
        <div class="label">${label}</div>`;
      bar.appendChild(el);
      return el;
    };
    const dashEl = mk('ready', 'Dash');
    // The echo widget lives in ui/EchoHud.ts (mounted into this bar by the echo feature).
    this.dash = { el: dashEl, arc: dashEl.querySelector('.arc')! };
    this.dashKey = dashEl.querySelector('.key')!;
  }

  /** Mount a feature's HUD widget (absolute-positioned element). */
  mount(el: HTMLElement): HTMLElement {
    this.root.appendChild(el);
    return el;
  }

  /** Inject a feature's CSS once (keeps styles next to the widget code). */
  static addStyles(id: string, css: string) {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  get overlayVisible() {
    return !this.overlay.classList.contains('hidden');
  }
  setOverlay(visible: boolean, paused = false) {
    this.overlay.classList.toggle('hidden', !visible);
    const cta = this.overlay.querySelector('.cta')!;
    cta.textContent = paused ? 'paused — click or press any button' : 'click or press any button';
  }
  onOverlayClick(cb: () => void) {
    this.overlay.addEventListener('click', cb);
  }

  setDevice(d: Device) {
    const L = PromptLabels[d];
    const rows: [string, string][] = [
      ['Move', L.move],
      ['Camera', L.look],
      ['Sprint', L.sprint],
      ['Jump', L.jump],
      ['Roll · Air dash', L.dodge],
      ['Attack (×3 combo)', L.attack],
      ['Echo · Recall (hold)', L.echo],
      ['Recenter cam', L.recenter],
    ];
    this.controls.innerHTML =
      `<div class="title">${d === 'pad' ? 'Gamepad' : 'Keyboard & Mouse'}</div>` +
      rows.map(([a, k]) => `<div class="row"><span>${a}</span><kbd>${k}</kbd></div>`).join('') +
      `<div class="row" style="margin-top:4px"><span>Toggle help / FPS</span><kbd>H / F3</kbd></div>`;
    this.dashKey.textContent = L.dodge;
  }

  toggleHelp() {
    this.controls.classList.toggle('collapsed');
  }

  flash(text: string, seconds = 1.2) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    this.toastTimer = seconds;
  }

  update(
    dt: number,
    // echo* fields are unused (ui/EchoHud.ts draws the echo); kept optional so callers stay valid
    s: { combo: number; dashCharges: number; airborne: boolean; echoState?: string; echoProgress?: number; echoTimer?: number },
  ) {
    this.pips.forEach((p, i) => p.classList.toggle('on', i <= s.combo));

    // Dash: lit while a charge is available.
    const dashReady = s.dashCharges > 0;
    this.dash.el.className = `ability ${dashReady ? 'ready' : 'cool'}`;
    this.dash.arc.style.strokeDashoffset = `${dashReady ? 0 : CIRC}`;

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }

    if (this.showFps) {
      this.fpsAcc += dt;
      this.fpsFrames++;
      if (this.fpsAcc > 0.5) {
        this.fps.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} fps`;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
      }
    }
    this.fps.hidden = !this.showFps;
  }

  damageNumber(pos: Vector3, value: number, big: boolean) {
    const el = document.createElement('div');
    el.className = `dmg${big ? ' big' : ''}`;
    el.textContent = `${value}`;
    this.root.appendChild(el);
    this.numbers.push({ el, pos: pos.clone(), age: 0, life: 0.9, vx: (Math.random() - 0.5) * 0.8 });
  }

  /** Position floating numbers; call after the camera has been updated. */
  updateNumbers(dt: number, camera: Camera, w: number, h: number) {
    const v = new Vector3();
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.age += dt;
      n.pos.y += dt * 1.6;
      n.pos.x += n.vx * dt;
      if (n.age >= n.life) {
        n.el.remove();
        this.numbers.splice(i, 1);
        continue;
      }
      v.copy(n.pos).project(camera);
      const hidden = v.z > 1;
      n.el.style.display = hidden ? 'none' : '';
      n.el.style.left = `${(v.x * 0.5 + 0.5) * w}px`;
      n.el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
      const t = n.age / n.life;
      n.el.style.opacity = `${t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3}`;
      n.el.style.transform = `translate(-50%,-50%) scale(${t < 0.12 ? 1.5 - t * 4 : 1})`;
    }
  }
}
