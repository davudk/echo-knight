import { Camera, Vector3 } from 'three';
import type { Enemy } from '../enemy/Enemy';
import type { Player } from '../player/Player';
import { HUD } from './HUD';

const CSS = `
.ek-hp { position: absolute; left: 28px; top: 24px; width: 260px; pointer-events: none; }
.ek-hp .bar { position: relative; height: 7px; background: rgba(10,8,8,0.72); border: 1px solid rgba(220,200,170,0.35);
  box-shadow: 0 0 6px rgba(0,0,0,0.6); }
.ek-hp .trail, .ek-hp .fill { position: absolute; left: 0; top: 0; bottom: 0; }
.ek-hp .trail { background: #e8c27a; }
.ek-hp .fill { background: linear-gradient(#c8423a, #8e1f1c); }
.ek-hp .num { margin-top: 3px; font: 11px Georgia, serif; letter-spacing: 0.12em; color: rgba(235,220,200,0.75);
  text-shadow: 0 1px 2px #000; }
.ek-hp.low .fill { animation: ek-hp-pulse 0.8s ease-in-out infinite; }
@keyframes ek-hp-pulse { 50% { filter: brightness(1.7); } }
.ek-vignette { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 0.4s;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(120,0,0,0.55) 100%); }
.ek-hurtflash { position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(200,20,10,0.5) 100%); }
.ek-death { position: absolute; inset: 0; pointer-events: none; opacity: 0; display: flex; align-items: center;
  justify-content: center; background: rgba(0,0,0,0.0); }
.ek-death span { font: 64px Georgia, 'Times New Roman', serif; letter-spacing: 0.12em; color: #a3201a;
  text-shadow: 0 0 18px rgba(0,0,0,0.9); transform: scale(1); }
.ek-ebar { position: absolute; width: 70px; height: 5px; transform: translate(-50%, -50%); pointer-events: none;
  background: rgba(10,8,8,0.7); border: 1px solid rgba(0,0,0,0.6); transition: opacity 0.3s; }
.ek-ebar .trail, .ek-ebar .fill { position: absolute; left: 0; top: 0; bottom: 0; }
.ek-ebar .trail { background: #e8c27a; }
.ek-ebar .fill { background: #b8322c; }
.ek-ebar.vuln .fill { background: #e6d24a; }
`;

/** Souls-like thin player HP bar (top-left) with a trailing damage segment, low-HP vignette, death screen. */
export class PlayerHealthBar {
  private readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly trail: HTMLElement;
  private readonly num: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly flashEl: HTMLElement;
  private readonly death: HTMLElement;
  private shown = 1;
  private trailShown = 1;
  private trailHold = 0;
  private lastHealth: number;
  private flash = 0;

  constructor(hud: HUD, private readonly player: Player) {
    HUD.addStyles('ek-healthbars', CSS);
    this.vignette = hud.mount(div('ek-vignette'));
    this.flashEl = hud.mount(div('ek-hurtflash'));
    this.death = hud.mount(div('ek-death'));
    this.death.innerHTML = '<span>YOU DIED</span>';
    this.el = hud.mount(div('ek-hp'));
    this.el.innerHTML = '<div class="bar"><div class="trail"></div><div class="fill"></div></div><div class="num"></div>';
    this.fill = this.el.querySelector('.fill')!;
    this.trail = this.el.querySelector('.trail')!;
    this.num = this.el.querySelector('.num')!;
    this.lastHealth = player.health;
  }

  /** `deadTime`: seconds since death, or < 0 when alive. */
  update(dt: number, deadTime: number) {
    const p = this.player;
    const frac = Math.max(0, p.health / p.maxHealth);
    if (p.health < this.lastHealth) {
      this.trailHold = 0.6;
      this.flash = 1;
    }
    if (p.health > this.lastHealth) this.trailShown = frac; // heals snap the trail
    this.lastHealth = p.health;

    this.shown = frac;
    if (this.trailHold > 0) this.trailHold -= dt;
    else this.trailShown = Math.max(frac, this.trailShown - dt * 0.6);
    this.trailShown = Math.max(this.trailShown, frac);

    this.fill.style.width = `${this.shown * 100}%`;
    this.trail.style.width = `${this.trailShown * 100}%`;
    this.num.textContent = `${Math.ceil(p.health)} / ${p.maxHealth}`;
    this.el.classList.toggle('low', frac > 0 && frac <= 0.3);

    this.vignette.style.opacity = `${frac <= 0.3 && !p.dead ? 0.6 + 0.4 * (1 - frac / 0.3) : 0}`;
    this.flash = Math.max(0, this.flash - dt * 3.5);
    this.flashEl.style.opacity = `${this.flash}`;

    // death screen: text fades in, then black, then out on respawn
    if (deadTime >= 0) {
      const textA = Math.min(1, Math.max(0, (deadTime - 0.4) / 0.6));
      const black = Math.min(1, Math.max(0, (deadTime - 1.6) / 0.8));
      this.death.style.opacity = '1';
      this.death.style.background = `rgba(0,0,0,${0.25 * textA + 0.75 * black})`;
      const span = this.death.firstElementChild as HTMLElement;
      span.style.opacity = `${textA}`;
      span.style.transform = `scale(${1 + deadTime * 0.04})`;
    } else {
      const o = parseFloat(this.death.style.opacity || '0');
      this.death.style.opacity = `${Math.max(0, o - dt * 2)}`;
    }
  }
}

/** Small bars over enemies, shown only while damaged and recently hit. */
export class EnemyHealthBars {
  private readonly bars = new Map<Enemy, { el: HTMLElement; fill: HTMLElement; trail: HTMLElement; trailV: number; hold: number; last: number }>();
  private readonly v = new Vector3();

  constructor(private readonly hud: HUD) {
    HUD.addStyles('ek-healthbars', CSS);
  }

  update(dt: number, enemies: Enemy[], camera: Camera, now: number, w: number, h: number) {
    for (const e of enemies) {
      let b = this.bars.get(e);
      if (!b) {
        const el = this.hud.mount(div('ek-ebar'));
        el.innerHTML = '<div class="trail"></div><div class="fill"></div>';
        b = { el, fill: el.querySelector('.fill')!, trail: el.querySelector('.trail')!, trailV: 1, hold: 0, last: e.health };
        this.bars.set(e, b);
      }
      const frac = e.health / e.maxHealth;
      if (e.health < b.last) b.hold = 0.5;
      if (e.health > b.last) b.trailV = frac;
      b.last = e.health;
      if (b.hold > 0) b.hold -= dt;
      else b.trailV = Math.max(frac, b.trailV - dt * 0.8);

      const recent = now - e.lastHitAt < 5;
      const visible = e.alive && frac < 1 && recent;
      this.v.set(e.feet.x, e.feet.y + 2.5, e.feet.z).project(camera);
      if (!visible || this.v.z > 1) {
        b.el.style.display = 'none';
        continue;
      }
      b.el.style.display = '';
      b.el.style.left = `${(this.v.x * 0.5 + 0.5) * w}px`;
      b.el.style.top = `${(-this.v.y * 0.5 + 0.5) * h}px`;
      b.el.style.opacity = `${Math.min(1, (5 - (now - e.lastHitAt)) * 2)}`;
      b.el.classList.toggle('vuln', e.vulnerable);
      b.fill.style.width = `${frac * 100}%`;
      b.trail.style.width = `${b.trailV * 100}%`;
    }
  }
}

function div(cls: string) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}
