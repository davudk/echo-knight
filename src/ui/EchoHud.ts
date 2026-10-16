import { PromptLabels } from '../config/bindings';
import { Tuning } from '../config/tuning';
import type { EchoRecall } from '../abilities/EchoRecall';
import type { Input } from '../core/Input';
import { HUD } from './HUD';

const CIRC = 2 * Math.PI * 25;

const CSS = `
.echo-hud .echo-stack { position: absolute; left: 50%; top: -32px; transform: translateX(-50%); display: flex; gap: 5px; }
.echo-hud .echo-stack[hidden] { display: none; }
.echo-hud .echo-pip { position: relative; width: 18px; height: 6px; border-radius: 3px; overflow: hidden;
  background: rgba(10,12,18,0.6); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18); }
.echo-hud .echo-pip b { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--echo); border-radius: 3px; }
.echo-hud .echo-pip.top { box-shadow: inset 0 0 0 1px var(--echo), 0 0 6px rgba(127,227,255,0.55); }
.echo-hud .echo-pip.low b { animation: echo-pip-flicker 0.18s steps(2) infinite; }
.echo-hud.platform .echo-pip b { background: #9fe8f0; }
.echo-hud .echo-hint { position: absolute; left: 50%; bottom: -15px; transform: translateX(-50%); white-space: nowrap;
  font: 9px ui-monospace, monospace; letter-spacing: 0.08em; color: var(--echo); opacity: 0.8; }
.echo-hud .echo-hint[hidden] { display: none; }
.echo-hud.shake { animation: echo-hud-shake 0.32s ease-out; }
.echo-hud.shake .arc { stroke: #ff8a6a !important; }
@keyframes echo-hud-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-5px); } 40% { transform: translateX(4px); }
  60% { transform: translateX(-3px); } 80% { transform: translateX(2px); }
}
@keyframes echo-pip-flicker { 50% { opacity: 0.35; } }
`;

/**
 * Echo HUD: the ability circle (top echo's remaining time / cooldown) plus a row of pips,
 * one per stack slot, each showing that echo's remaining time. Shakes when a press fizzles.
 */
export class EchoHud {
  readonly el: HTMLElement;
  private readonly arc: SVGCircleElement;
  private readonly label: HTMLElement;
  private readonly key: HTMLElement;
  private readonly stackEl: HTMLElement;
  private readonly hint: HTMLElement;
  private pips: { el: HTMLElement; fill: HTMLElement }[] = [];
  private shakeTimer = 0;

  constructor(hud: HUD, input: Input) {
    HUD.addStyles('echo-hud-css', CSS);
    this.el = document.createElement('div');
    this.el.className = 'ability echo-hud ready';
    this.el.innerHTML = `
      <div class="echo-stack"></div>
      <span class="key"></span>
      <svg viewBox="0 0 56 56"><circle class="bg" cx="28" cy="28" r="25"/><circle class="arc" cx="28" cy="28" r="25"
        stroke-dasharray="${CIRC}" stroke-dashoffset="0"/></svg>
      <div class="label">Echo</div>
      <div class="echo-hint" hidden>hold: recall</div>`;
    this.arc = this.el.querySelector('.arc')!;
    this.label = this.el.querySelector('.label')!;
    this.key = this.el.querySelector('.key')!;
    this.stackEl = this.el.querySelector('.echo-stack')!;
    this.hint = this.el.querySelector('.echo-hint')!;

    // Sit in the ability bar next to Dash when it exists.
    const bar = document.querySelector('.abilities');
    if (bar) bar.appendChild(this.el);
    else hud.mount(this.el);

    const setKey = () => (this.key.textContent = PromptLabels[input.lastDevice].echo);
    setKey();
    input.onDevice(setKey);
  }

  /** Short shake + red arc (refused press). */
  shake() {
    this.el.classList.remove('shake');
    void this.el.offsetWidth; // restart the animation
    this.el.classList.add('shake');
    this.shakeTimer = 0.35;
  }

  update(dt: number, echo: EchoRecall) {
    const count = echo.count;
    if (this.pips.length !== count) {
      this.stackEl.innerHTML = '';
      this.pips = [];
      for (let i = 0; i < count; i++) {
        const el = document.createElement('div');
        el.className = 'echo-pip';
        el.innerHTML = '<b></b>';
        this.stackEl.appendChild(el);
        this.pips.push({ el, fill: el.querySelector('b')! });
      }
    }
    this.stackEl.hidden = count <= 1;
    const stack = echo.stack;
    this.pips.forEach((p, i) => {
      const e = stack[i];
      const frac = e ? Math.max(0, e.life / e.maxLife) : 0;
      p.fill.style.width = `${frac * 100}%`;
      p.el.classList.toggle('top', !!e && i === stack.length - 1);
      p.el.classList.toggle('low', !!e && e.life < Tuning.echo.flickerLast);
    });

    // Stack has room but isn't empty: a tap would place, so remind that holding recalls.
    this.hint.hidden = !(stack.length > 0 && stack.length < count);

    const state = echo.state;
    const top = echo.top;
    const cls = state === 'active' ? 'echo' : state === 'ready' ? 'ready' : 'cool';
    this.el.classList.remove('echo', 'ready', 'cool');
    this.el.classList.add(cls);
    this.el.classList.toggle('platform', top?.body === 'platform');
    this.arc.style.strokeDashoffset = `${CIRC * (1 - echo.progress)}`;
    this.label.textContent = top ? top.life.toFixed(1) : 'Echo';

    if (this.shakeTimer > 0) {
      this.shakeTimer -= dt;
      if (this.shakeTimer <= 0) this.el.classList.remove('shake');
    }
  }
}
