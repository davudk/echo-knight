import { HUD } from './HUD';

/**
 * Thin stamina bar mounted under the player HP bar (top-left). Only visible while the
 * `defense.stamina` upgrade is on. Flashes red when an action is refused for lack of stamina.
 */
const CSS = `
.ek-stam { position: absolute; left: 28px; top: 52px; width: 200px; pointer-events: none; transition: opacity 0.25s; }
.ek-stam .bar { position: relative; height: 5px; background: rgba(10,8,8,0.72); border: 1px solid rgba(220,200,170,0.3);
  box-shadow: 0 0 6px rgba(0,0,0,0.6); }
.ek-stam .trail, .ek-stam .fill { position: absolute; left: 0; top: 0; bottom: 0; }
.ek-stam .trail { background: rgba(240,230,190,0.55); }
.ek-stam .fill { background: linear-gradient(#8fc760, #4f8a2c); }
.ek-stam.empty .fill { background: linear-gradient(#b9b25a, #7b7430); }
.ek-stam.deny .bar { border-color: rgba(255,90,60,0.95); box-shadow: 0 0 10px rgba(255,60,30,0.8); }
.ek-stam.deny .fill { background: #d8503a; }
`;

export interface StaminaSource {
  value: number;
  max: number;
  enabled: boolean;
  /** 1 → 0 flash after a refused action */
  denied: number;
}

export class StaminaBar {
  private readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly trail: HTMLElement;
  private trailV = 1;
  private hold = 0;
  private last = 1;

  constructor(hud: HUD) {
    HUD.addStyles('ek-stamina', CSS);
    this.el = hud.mount(document.createElement('div'));
    this.el.className = 'ek-stam';
    this.el.innerHTML = '<div class="bar"><div class="trail"></div><div class="fill"></div></div>';
    this.fill = this.el.querySelector('.fill')!;
    this.trail = this.el.querySelector('.trail')!;
  }

  update(dt: number, s: StaminaSource) {
    this.el.style.opacity = s.enabled ? '1' : '0';
    if (!s.enabled) return;
    const frac = Math.max(0, Math.min(1, s.value / s.max));
    if (frac < this.last - 1e-4) this.hold = 0.45;
    this.last = frac;
    if (this.hold > 0) this.hold -= dt;
    else this.trailV = Math.max(frac, this.trailV - dt * 0.9);
    this.trailV = Math.max(this.trailV, frac);
    this.fill.style.width = `${frac * 100}%`;
    this.trail.style.width = `${this.trailV * 100}%`;
    this.el.classList.toggle('deny', s.denied > 0 && Math.floor(s.denied * 8) % 2 === 0);
    this.el.classList.toggle('empty', frac < 0.15);
  }
}
