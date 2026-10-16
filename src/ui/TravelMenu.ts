import type { Game } from '../core/Game';
import { HUD } from './HUD';

/**
 * Pause menu → Travel: warp to the spawn arena, the town, the parkour gym or any registered boss
 * arena (`registerBossArena` in boss/Arena.ts). Opens as its own menu (pauses with reason 'menu').
 * Mouse, keyboard (↑/↓ or W/S, Enter, 1–9, Esc) and gamepad (D-pad, A, B).
 */
export interface TravelDest {
  id: string;
  name: string;
  note?: string;
  x: number;
  z: number;
  facing: number;
}

const CSS = `
.ek-travel { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,0.55); pointer-events: auto; }
.ek-travel[hidden] { display: none; }
.ek-travel .tv-panel { min-width: 300px; max-width: 92vw; padding: 20px 22px 16px; background: rgba(14,15,20,0.94);
  border: 1px solid rgba(240,179,90,0.35); box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
.ek-travel h2 { margin: 0 0 12px; font: 400 20px "Cinzel", Georgia, serif; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ink); text-align: center; }
.ek-travel .tv-list { display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow: auto; }
.ek-travel .tv-item { display: flex; align-items: baseline; gap: 10px; padding: 9px 12px; cursor: pointer; text-align: left;
  font: 15px "Cinzel", Georgia, serif; letter-spacing: 0.08em; color: var(--ink); background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08); }
.ek-travel .tv-item:hover, .ek-travel .tv-item.focus { border-color: var(--accent); color: var(--accent); background: rgba(240,179,90,0.08); }
.ek-travel .tv-item kbd { font: 11px ui-monospace, monospace; color: var(--ink-dim); min-width: 14px; }
.ek-travel .tv-item small { margin-left: auto; font: 10.5px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink-dim); }
.ek-travel .tv-item.boss small { color: #e2543a; }
.ek-travel .tv-hint { margin-top: 10px; text-align: center; font: 11px ui-sans-serif, system-ui, sans-serif; color: var(--ink-dim); letter-spacing: 0.06em; }
`;

export class TravelMenu {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private items: TravelDest[] = [];
  private focus = 0;
  isOpen = false;
  private padPrev: boolean[] = [];

  constructor(
    private readonly game: Game,
    private readonly source: () => TravelDest[],
    private readonly onTravel: (d: TravelDest) => void,
  ) {
    HUD.addStyles('ek-travel', CSS);
    const root = document.createElement('div');
    root.className = 'ek-travel';
    root.hidden = true;
    root.innerHTML = `<div class="tv-panel" role="dialog" aria-label="Travel"><h2>Travel</h2><div class="tv-list"></div>
      <div class="tv-hint">Enter / A travel · Esc / B back</div></div>`;
    this.root = game.hud.mount(root);
    this.list = root.querySelector('.tv-list')!;
    root.addEventListener('mousedown', (e) => e.preventDefault());
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (el) this.choose(Number(el.dataset.i));
      else if (e.target === root) this.close();
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  open() {
    if (this.isOpen) return;
    this.items = this.source();
    this.focus = 0;
    this.isOpen = true;
    this.root.hidden = false;
    this.render();
    this.padPrev = this.readPad();
    this.game.setPaused('menu');
  }

  close(resume = false) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.game.setPaused(resume ? null : 'overlay');
  }

  private render() {
    this.list.innerHTML = this.items
      .map((d, i) => `<button class="tv-item${i === this.focus ? ' focus' : ''}${d.note === 'boss' ? ' boss' : ''}" data-i="${i}">
        <kbd>${i < 9 ? i + 1 : ''}</kbd><span>${esc(d.name)}</span>${d.note ? `<small>${esc(d.note)}</small>` : ''}</button>`)
      .join('');
  }

  private choose(i: number) {
    const d = this.items[i];
    if (!d) return;
    this.close(true);
    this.onTravel(d);
    this.game.hud.flash(`Travelled to ${d.name}`, 1.6);
  }

  private move(step: number) {
    if (!this.items.length) return;
    this.focus = (this.focus + step + this.items.length) % this.items.length;
    this.render();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen) return;
    const c = e.code;
    if (c === 'Escape' || c === 'Backspace') {
      e.preventDefault();
      this.close();
    } else if (c === 'ArrowDown' || c === 'KeyS') this.move(1);
    else if (c === 'ArrowUp' || c === 'KeyW') this.move(-1);
    else if (c === 'Enter' || c === 'Space' || c === 'NumpadEnter') {
      e.preventDefault();
      this.choose(this.focus);
    } else if (/^Digit[1-9]$/.test(c)) this.choose(Number(c.slice(5)) - 1);
  }

  private readPad(): boolean[] {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p.buttons.map((b) => b.pressed || b.value > 0.5);
    return [];
  }

  /** gamepad navigation while open (runs from the paused loop) */
  pausedUpdate() {
    if (!this.isOpen) return;
    const now = this.readPad();
    const edge = (i: number) => !!now[i] && !this.padPrev[i];
    if (edge(12)) this.move(-1);
    else if (edge(13)) this.move(1);
    else if (edge(0)) this.choose(this.focus);
    else if (edge(1)) this.close();
    this.padPrev = now;
  }
}

/** Add the "Travel" button to the pause overlay menu. Call `menu.pausedUpdate()` from a feature's pausedUpdate. */
export function installTravelMenu(game: Game, source: () => TravelDest[], onTravel: (d: TravelDest) => void) {
  const menu = new TravelMenu(game, source, onTravel);
  const overlayMenu = game.hud.overlayMenu();
  const btn = document.createElement('button');
  btn.className = 'ov-btn';
  btn.dataset.travel = '1';
  btn.textContent = 'Travel';
  // keep the overlay's own click handler (resume) from seeing this click
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.open();
  });
  const hint = overlayMenu.querySelector('.ov-hint');
  overlayMenu.insertBefore(btn, hint);
  return menu;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
