import { playSfx } from '../audio/audioFeature';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import { loadout } from '../core/Loadout';
import type { Feature } from '../features';
import { HUD } from './HUD';

/**
 * DMC-style combo counter + style rank (only with the `combat.styleMeter` upgrade).
 *
 * Score runs 0..500; each 100 points is a rank (D C B A S). Hits earn points scaled by move
 * variety (repeating a move id within the last few hits gives diminishing returns), airborne
 * and echo hits earn multipliers, parries / perfect dodges / kills give flat bonuses.
 * Idle time decays the score (faster at high ranks); taking damage drops a rank.
 */
const RANKS = [
  { letter: 'D', title: 'Dormant' },
  { letter: 'C', title: 'Clean' },
  { letter: 'B', title: 'Bold' },
  { letter: 'A', title: 'Ascendant' },
  { letter: 'S', title: 'Sublime' },
];
const PER_RANK = 100;
const MAX_SCORE = PER_RANK * RANKS.length;
const COMBO_WINDOW = 2.0; // s without a hit before the hit counter resets
const DECAY_DELAY = 1.6; // s idle before the score starts to decay
const VARIETY = [1, 0.65, 0.42, 0.28, 0.18];
const RECENT = 6;

export const StyleTuning = { PER_RANK, COMBO_WINDOW, DECAY_DELAY, VARIETY, RECENT };

export class StyleMeter {
  readonly el: HTMLElement;
  private readonly hitsN: HTMLElement;
  private readonly hitsBox: HTMLElement;
  private readonly letter: HTMLElement;
  private readonly title: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly bonus: HTMLElement;
  score = 0;
  hits = 0;
  private hitTimer = 0;
  private idle = 99;
  private recent: string[] = [];
  private shownRank = -1;
  enabled = true;

  constructor(private readonly game: Game) {
    HUD.addStyles('style-meter-css', CSS);
    this.el = document.createElement('div');
    this.el.className = 'style-meter';
    this.el.innerHTML = `
      <div class="sm-hits"><span class="n">0</span><span class="lbl">hits</span></div>
      <div class="sm-rank"><span class="letter"></span><span class="title"></span></div>
      <div class="sm-bar"><div class="fill"></div></div>
      <div class="sm-bonus"></div>`;
    this.hitsBox = this.el.querySelector('.sm-hits')!;
    this.hitsN = this.el.querySelector('.sm-hits .n')!;
    this.letter = this.el.querySelector('.letter')!;
    this.title = this.el.querySelector('.title')!;
    this.fill = this.el.querySelector('.fill')!;
    this.bonus = this.el.querySelector('.sm-bonus')!;
    game.hud.mount(this.el);

    events.on('player:hit', ({ info, move, target }) => {
      const id = info.move ?? move;
      const count = this.recent.filter((m) => m === id).length;
      this.recent.push(id);
      if (this.recent.length > RECENT) this.recent.shift();
      let pts = info.heavy ? 15 : 9;
      pts *= VARIETY[Math.min(count, VARIETY.length - 1)];
      if (count === 0 && this.hits > 0) pts += 3; // fresh move mid-combo
      const tags: string[] = [];
      if (this.game.player.airborne || target.airborne) {
        pts *= 1.35;
        tags.push('aerial');
      }
      if (info.source === 'echo') {
        pts *= 1.5;
        tags.push('echo');
      }
      if (info.launch) tags.push('launch');
      // Higher ranks are harder to climb.
      pts *= 1 - this.rank * 0.09;
      this.hits++;
      this.hitTimer = COMBO_WINDOW;
      this.add(pts, tags[0]);
      this.pulse(this.hitsBox, 'bump');
    });
    events.on('player:parry', () => this.add(55, 'parry'));
    events.on('player:perfect-dodge', () => this.add(45, 'perfect dodge'));
    events.on('enemy:died', () => this.add(20, 'kill'));
    events.on('echo:recalled', () => {
      if (this.hits > 0) this.add(6, 'recall');
    });
    events.on('player:airdash', () => {
      if (this.hits > 0) this.add(2);
    });
    events.on('player:damaged', () => this.damaged());
    events.on('player:died', () => this.reset());
    events.on('ui:pause', ({ paused }) => this.el.classList.toggle('is-paused', paused));
    events.on('loadout:changed', ({ id }) => {
      if (id === 'combat.styleMeter') this.syncEnabled();
    });
    this.syncEnabled();
    this.el.classList.toggle('is-paused', game.paused);
    this.render();
  }

  get rank() {
    return Math.min(RANKS.length - 1, Math.floor(this.score / PER_RANK));
  }

  private syncEnabled() {
    let on = true;
    try {
      on = loadout.has('combat.styleMeter');
    } catch {
      on = true;
    }
    this.enabled = on;
    if (!on) this.reset();
    this.el.hidden = !on;
  }

  reset() {
    this.score = 0;
    this.hits = 0;
    this.hitTimer = 0;
    this.recent = [];
    this.shownRank = -1;
    this.render();
  }

  private add(pts: number, tag?: string) {
    if (!this.enabled) return;
    this.score = Math.min(MAX_SCORE - 0.01, this.score + pts);
    this.idle = 0;
    if (tag) this.showBonus(tag);
    this.render();
  }

  private damaged() {
    if (!this.enabled) return;
    const r = this.rank;
    this.score = this.score <= 0 ? 0 : r === 0 ? 0 : (r - 1) * PER_RANK + PER_RANK * 0.3;
    this.hits = 0;
    this.hitTimer = 0;
    this.recent = [];
    this.pulse(this.el, 'hurt');
    this.render(true);
  }

  private showBonus(text: string) {
    const b = document.createElement('div');
    b.className = 'b';
    b.textContent = text;
    this.bonus.prepend(b);
    while (this.bonus.childElementCount > 3) this.bonus.lastElementChild!.remove();
    setTimeout(() => b.remove(), 1400);
  }

  private pulse(el: HTMLElement, cls: string) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
  }

  update(dt: number) {
    if (!this.enabled) return;
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hits = 0;
    }
    this.idle += dt;
    if (this.idle > DECAY_DELAY && this.score > 0) {
      this.score = Math.max(0, this.score - (5 + this.rank * 7) * dt);
    }
    this.render();
  }

  private render(dropped = false) {
    const active = this.score > 0 || this.hits > 0;
    this.el.classList.toggle('active', active);
    this.hitsN.textContent = `${this.hits}`;
    this.hitsBox.classList.toggle('none', this.hits < 2);
    const r = this.rank;
    const frac = (this.score - r * PER_RANK) / PER_RANK;
    this.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac)).toFixed(3)})`;
    if (!active) {
      this.shownRank = -1;
      return;
    }
    if (r !== this.shownRank) {
      const up = r > this.shownRank;
      this.letter.textContent = RANKS[r].letter;
      this.title.textContent = RANKS[r].title;
      this.el.dataset.rank = RANKS[r].letter;
      if (up && !dropped) {
        this.pulse(this.letter, 'pop');
        if (this.shownRank >= 0 || r > 0) playSfx('rankUp', { ui: true, intensity: r / 4, from: 'style:rank' });
      }
      this.shownRank = r;
    }
  }
}

let meter: StyleMeter | null = null;

export const styleMeterFeature: Feature = {
  name: 'style-meter',
  install(game) {
    meter = new StyleMeter(game);
    if (import.meta.env.DEV) Object.assign(window as object, { styleMeter: meter });
  },
  lateUpdate(dt) {
    meter?.update(dt);
  },
};

const CSS = `
.style-meter {
  position: absolute; right: 30px; top: 24%; width: 200px; text-align: right;
  opacity: 0; transform: translateX(16px); transition: opacity 0.35s, transform 0.35s;
  font-family: "Cinzel", "Trajan Pro", Georgia, serif; pointer-events: none;
}
.style-meter.active { opacity: 1; transform: none; }
.style-meter.is-paused { opacity: 0 !important; }
.style-meter .sm-hits { display: flex; justify-content: flex-end; align-items: baseline; gap: 8px; height: 34px; transition: opacity 0.2s; }
.style-meter .sm-hits.none { opacity: 0; }
.style-meter .sm-hits .n {
  font-size: 32px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums;
  text-shadow: 0 0 10px rgba(0,0,0,0.8), 0 2px 0 rgba(0,0,0,0.5);
}
.style-meter .sm-hits .lbl { font-size: 12px; letter-spacing: 0.35em; text-transform: uppercase; color: var(--ink-dim); }
.style-meter .sm-hits.bump .n { animation: sm-bump 0.18s ease-out; }
@keyframes sm-bump { 0% { transform: scale(1.35); color: #fff4d6; } 100% { transform: scale(1); } }
.style-meter .sm-hits .n { display: inline-block; transform-origin: right center; }

.style-meter .sm-rank { display: flex; flex-direction: column; align-items: flex-end; margin-top: 4px; }
.style-meter .letter {
  display: inline-block; font-size: 76px; line-height: 0.95; font-weight: 700; font-style: italic;
  color: var(--accent); transform-origin: 70% 60%;
  background: linear-gradient(180deg, #fff1c9 0%, #f0b35a 55%, #a8661c 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 0 10px rgba(240,179,90,0.45)) drop-shadow(0 3px 0 rgba(0,0,0,0.55));
}
.style-meter[data-rank="S"] .letter { filter: drop-shadow(0 0 16px rgba(255,214,130,0.9)) drop-shadow(0 3px 0 rgba(0,0,0,0.55)); }
.style-meter .letter.pop { animation: sm-pop 0.42s cubic-bezier(.2,1.6,.4,1); }
@keyframes sm-pop {
  0% { transform: scale(2.1) rotate(-8deg); opacity: 0; filter: drop-shadow(0 0 28px rgba(255,230,170,1)); }
  60% { opacity: 1; }
  100% { transform: scale(1) rotate(0); }
}
.style-meter .title {
  font-size: 12px; letter-spacing: 0.45em; text-transform: uppercase; color: #f6d9a4; margin-top: 2px;
  text-shadow: 0 0 8px rgba(0,0,0,0.9);
}
.style-meter .sm-bar {
  margin: 8px 0 0 auto; width: 150px; height: 4px; background: rgba(255,255,255,0.1);
  border: 1px solid rgba(240,179,90,0.35); overflow: hidden;
}
.style-meter .sm-bar .fill {
  height: 100%; width: 100%; transform-origin: left center; transform: scaleX(0);
  background: linear-gradient(90deg, rgba(240,179,90,0.4), #f0b35a, #fff1c9);
  box-shadow: 0 0 8px #f0b35a; transition: transform 0.12s linear;
}
.style-meter .sm-bonus { margin-top: 6px; min-height: 54px; }
.style-meter .sm-bonus .b {
  font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; color: #ffe2a8; line-height: 18px;
  text-shadow: 0 0 8px rgba(0,0,0,0.9); animation: sm-bonus 1.4s ease-out forwards;
}
@keyframes sm-bonus { 0% { opacity: 0; transform: translateX(10px); } 12% { opacity: 1; transform: none; } 75% { opacity: 1; } 100% { opacity: 0; } }
.style-meter.hurt { animation: sm-hurt 0.35s; }
@keyframes sm-hurt { 20% { transform: translateX(-6px); filter: hue-rotate(-40deg) saturate(2); } 50% { transform: translateX(5px); } }
@media (max-width: 720px) {
  .style-meter { right: 12px; top: 14%; width: 140px; }
  .style-meter .letter { font-size: 52px; }
  .style-meter .sm-hits .n { font-size: 24px; }
  .style-meter .sm-bar { width: 110px; }
}
`;
