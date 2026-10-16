import { HUD } from './HUD';

/** Flask icon + charge count next to the player HP bar (top-left). */
const CSS = `
.ek-flask { position: absolute; left: 298px; top: 14px; display: flex; align-items: center; gap: 4px; pointer-events: none;
  font: 13px Georgia, serif; color: rgba(240,225,195,0.9); text-shadow: 0 1px 2px #000; transition: opacity 0.3s, transform 0.15s; }
.ek-flask svg { width: 18px; height: 24px; filter: drop-shadow(0 0 3px rgba(0,0,0,0.8)); }
.ek-flask .liquid { fill: #e0a43c; transition: fill 0.2s; }
.ek-flask.empty { opacity: 0.45; }
.ek-flask.empty .liquid { fill: #3a2a1a; }
.ek-flask.drinking svg { filter: drop-shadow(0 0 7px rgba(255,200,90,0.9)); }
.ek-flask.deny { transform: translateX(3px); color: #e2543a; }
.ek-flask b { font-weight: 400; letter-spacing: 0.06em; }
`;

export class FlaskHud {
  private readonly el: HTMLElement;
  private readonly count: HTMLElement;
  private last = -1;
  private lastMax = -1;
  private denyT = 0;

  constructor(hud: HUD) {
    HUD.addStyles('ek-flask', CSS);
    const el = document.createElement('div');
    el.className = 'ek-flask';
    el.innerHTML = `
      <svg viewBox="0 0 18 24" aria-hidden="true">
        <rect x="6.5" y="1" width="5" height="4" rx="1" fill="#6b4a2a"/>
        <path d="M6 5h6v3l4 5v7a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-7l4-5z" fill="rgba(20,16,12,0.75)" stroke="rgba(240,220,180,0.7)" stroke-width="1"/>
        <path class="liquid" d="M3 14h12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      </svg><b></b>`;
    this.el = hud.mount(el);
    this.count = el.querySelector('b')!;
  }

  deny() {
    this.denyT = 0.3;
  }

  update(dt: number, charges: number, max: number, drinking: boolean) {
    if (charges !== this.last || max !== this.lastMax) {
      this.last = charges;
      this.lastMax = max;
      this.count.textContent = `${charges}/${max}`;
      this.el.classList.toggle('empty', charges <= 0);
    }
    this.el.classList.toggle('drinking', drinking);
    this.denyT = Math.max(0, this.denyT - dt);
    this.el.classList.toggle('deny', this.denyT > 0);
  }
}
