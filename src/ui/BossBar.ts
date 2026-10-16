import { HUD } from './HUD';

/**
 * Souls-style boss HUD: one big bar per engaged boss (stacked, up to 3) above the ability bar,
 * name in serif small caps, trailing damage segment, phase tick marks at the HP thresholds and a
 * thin poise / stagger meter underneath. Fades in on engage, out on defeat / reset.
 * Plus the "GREAT ENEMY FELLED" banner.
 */
const CSS = `
.ek-bossbars { position: absolute; left: 50%; bottom: 128px; transform: translateX(-50%); width: min(64vw, 760px);
  display: flex; flex-direction: column-reverse; pointer-events: none; }
/* Every registered boss owns a bar; hidden ones collapse so the visible bar(s) sit at the bottom. */
.ek-boss { opacity: 0; max-height: 0; overflow: hidden; transition: opacity 0.6s ease, max-height 0s linear 0.6s; }
.ek-boss.show { opacity: 1; max-height: 80px; margin-top: 10px; transition: opacity 0.6s ease; }
.ek-boss .name { font-family: "Cinzel", "Trajan Pro", Georgia, serif; font-variant: small-caps; font-size: 17px; letter-spacing: 0.1em;
  color: #efe4cc; text-shadow: 0 1px 3px #000, 0 0 10px rgba(0,0,0,0.7); margin: 0 0 4px 2px; display: flex; align-items: baseline; gap: 10px; }
.ek-boss .name small { font-size: 11px; letter-spacing: 0.18em; color: rgba(240,179,90,0.75); font-variant: normal; text-transform: uppercase; }
.ek-boss .hp { position: relative; height: 10px; background: rgba(8,6,6,0.78); border: 1px solid rgba(200,170,120,0.45);
  box-shadow: 0 0 8px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(0,0,0,0.6); }
.ek-boss .hp .trail, .ek-boss .hp .fill { position: absolute; left: 0; top: 0; bottom: 0; }
.ek-boss .hp .trail { background: #e8c27a; }
.ek-boss .hp .fill { background: linear-gradient(#b8332a, #7a1712); }
.ek-boss .tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: rgba(240,200,130,0.85);
  box-shadow: 0 0 4px rgba(0,0,0,0.9); }
.ek-boss .tick.passed { background: rgba(240,200,130,0.3); }
.ek-boss .poise { position: relative; height: 3px; margin-top: 3px; width: 46%; margin-left: 27%; background: rgba(8,6,6,0.6); }
.ek-boss .poise .fill { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #c9a24a, #f3d27a); }
.ek-boss.staggered .poise .fill { background: #fff2b0; box-shadow: 0 0 8px rgba(255,220,120,0.95); }
.ek-boss.staggered .name { color: #ffe6a0; }
.ek-boss.transition .hp { box-shadow: 0 0 14px rgba(240,179,90,0.75); }
.ek-banner { position: absolute; left: 0; right: 0; top: 38%; height: 110px; display: flex; align-items: center; justify-content: center;
  pointer-events: none; opacity: 0; background: linear-gradient(90deg, transparent, rgba(0,0,0,0.65) 22%, rgba(0,0,0,0.65) 78%, transparent); }
.ek-banner span { font-family: "Cinzel", "Trajan Pro", Georgia, serif; font-size: 46px; letter-spacing: 0.16em; color: #e9c46a;
  text-shadow: 0 0 18px rgba(240,179,90,0.65), 0 2px 4px #000; white-space: nowrap; }
@media (max-width: 860px) {
  .ek-bossbars { width: 86vw; bottom: 122px; }
  .ek-boss .name { font-size: 14px; }
  .ek-banner span { font-size: 30px; }
}
`;

/** What the bar reads from a boss (Boss implements this). */
export interface BossBarSource {
  readonly id: string;
  readonly name: string;
  readonly def: { title?: string; phases: { threshold: number }[]; poise: { max: number } };
  readonly health: number;
  readonly maxHealth: number;
  readonly poise: number;
  readonly phase: number;
  readonly state: string;
}

interface Row {
  el: HTMLElement;
  fill: HTMLElement;
  trail: HTMLElement;
  poise: HTMLElement;
  ticks: HTMLElement[];
  thresholds: number[];
  trailV: number;
  hold: number;
  last: number;
  seen: boolean;
}

export class BossBar {
  private readonly root: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private bannerT = -1;

  constructor(hud: HUD) {
    HUD.addStyles('ek-bossbar', CSS);
    this.root = hud.mount(document.createElement('div'));
    this.root.className = 'ek-bossbars';
    this.banner = hud.mount(document.createElement('div'));
    this.banner.className = 'ek-banner';
    this.banner.innerHTML = '<span></span>';
  }

  /** Show the defeat banner. */
  victory(text = 'GREAT ENEMY FELLED') {
    (this.banner.firstElementChild as HTMLElement).textContent = text;
    this.bannerT = 0;
  }

  private row(b: BossBarSource): Row {
    let r = this.rows.get(b.id);
    if (r) return r;
    const el = document.createElement('div');
    el.className = 'ek-boss';
    // thresholds ≤ 0 are phases entered by a boss mechanic (not by HP): no tick
    const thresholds = b.def.phases.slice(1).map((p) => p.threshold).filter((t) => t > 0);
    el.innerHTML = `
      <div class="name">${esc(b.name)}${b.def.title ? `<small>${esc(b.def.title)}</small>` : ''}</div>
      <div class="hp"><div class="trail"></div><div class="fill"></div>
        ${thresholds.map((t) => `<div class="tick" style="left:${(t * 100).toFixed(2)}%"></div>`).join('')}</div>
      <div class="poise"><div class="fill"></div></div>`;
    this.root.appendChild(el);
    r = {
      el, thresholds, fill: el.querySelector('.hp .fill')!, trail: el.querySelector('.hp .trail')!, poise: el.querySelector('.poise .fill')!,
      ticks: [...el.querySelectorAll<HTMLElement>('.tick')], trailV: 1, hold: 0, last: b.health, seen: false,
    };
    this.rows.set(b.id, r);
    return r;
  }

  /**
   * `shown`: bosses whose bars should be visible (engaged and alive, or just died).
   * Rows for other bosses fade out.
   */
  update(dt: number, shown: readonly BossBarSource[]) {
    for (const [, r] of this.rows) r.seen = false;
    for (const b of shown) {
      const r = this.row(b);
      r.seen = true;
      const frac = Math.max(0, b.health / b.maxHealth);
      if (b.health < r.last) r.hold = 0.6;
      if (b.health > r.last) r.trailV = frac;
      r.last = b.health;
      if (r.hold > 0) r.hold -= dt;
      else r.trailV = Math.max(frac, r.trailV - dt * 0.5);
      r.trailV = Math.max(r.trailV, frac);
      r.fill.style.width = `${frac * 100}%`;
      r.trail.style.width = `${r.trailV * 100}%`;
      r.poise.style.width = `${Math.min(1, b.poise / b.def.poise.max) * 100}%`;
      r.el.classList.add('show');
      r.el.classList.toggle('staggered', b.state === 'stagger' || b.state === 'knockdown');
      r.el.classList.toggle('transition', b.state === 'transition');
      for (let i = 0; i < r.ticks.length; i++) r.ticks[i].classList.toggle('passed', b.phase > i);
    }
    for (const [, r] of this.rows) if (!r.seen) r.el.classList.remove('show');

    if (this.bannerT >= 0) {
      this.bannerT += dt;
      const t = this.bannerT;
      const a = t < 0.8 ? t / 0.8 : t < 3.6 ? 1 : Math.max(0, 1 - (t - 3.6) / 1.2);
      this.banner.style.opacity = `${a}`;
      (this.banner.firstElementChild as HTMLElement).style.transform = `scale(${1 + t * 0.012})`;
      if (t > 4.8) this.bannerT = -1;
    }
  }

  /** Forget a boss's row (disposed bosses). */
  remove(id: string) {
    this.rows.get(id)?.el.remove();
    this.rows.delete(id);
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
