import { MoveList, type MoveEntry } from '../config/moveList';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import { loadout } from '../core/Loadout';
import type { Feature } from '../features';
import { HUD } from './HUD';

/**
 * Training overlay.
 *  - T  : input history (fighting-game style: direction + buttons, frames held) and a
 *         "last move" readout (name, notation, startup, hits, damage).
 *  - F1 : move list generated from config/moveList.ts, grouped; moves whose `requires`
 *         loadout token is off are greyed out. Rebuilt on open and on loadout changes,
 *         so moves appended by other modules show up automatically.
 * Keys are handled here (not in bindings) so they never reach gameplay actions.
 */
const BUTTON_LABEL: Record<string, string> = {
  attack: 'L',
  heavy: 'H',
  jump: 'J',
  dodge: 'D',
  block: 'B',
  echo: 'E',
  sprint: 'S',
  lockOn: 'R',
};
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
const MAX_ROWS = 12;
const STORAGE_KEY = 'echo-knight.training.v1';

interface Row {
  dir: number; // -1 neutral, 0..7 sector (0 = right, counter-clockwise)
  buttons: string[];
  start: number; // game.time
  el: HTMLElement;
}

interface LastMove {
  id: string;
  start: number;
  hits: number;
  damage: number;
  firstHit: number;
  echo: boolean;
  heavy: boolean;
}

export class Training {
  readonly root: HTMLElement;
  private readonly historyEl: HTMLElement;
  private readonly lastEl: HTMLElement;
  private readonly movesEl: HTMLElement;
  private rows: Row[] = [];
  private pending: string[] = [];
  private dir = -1;
  private last: LastMove | null = null;
  showHistory = false;
  showMoves = false;

  constructor(private readonly game: Game) {
    HUD.addStyles('training-css', CSS);
    this.root = document.createElement('div');
    this.root.className = 'training';
    this.root.innerHTML = `
      <div class="tr-panel tr-history"><div class="tr-head">Inputs <span>frames</span></div><div class="tr-rows"></div></div>
      <div class="tr-panel tr-last"></div>
      <div class="tr-panel tr-moves"></div>`;
    this.historyEl = this.root.querySelector('.tr-rows')!;
    this.lastEl = this.root.querySelector('.tr-last')!;
    this.movesEl = this.root.querySelector('.tr-moves')!;
    game.hud.mount(this.root);

    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (s) {
        this.showHistory = !!s.history;
        this.showMoves = !!s.moves;
      }
    } catch {
      /* ignore */
    }

    events.on('input:action', ({ action }) => {
      if (BUTTON_LABEL[action] && !this.game.paused) this.pending.push(BUTTON_LABEL[action]);
    });
    events.on('player:attack', ({ move, heavy }) => {
      this.last = { id: move, start: this.game.time, hits: 0, damage: 0, firstHit: -1, echo: false, heavy };
      this.renderLast();
    });
    events.on('player:hit', ({ info, move }) => {
      const id = info.move ?? move;
      if (info.source === 'echo' && (!this.last || this.last.id !== id)) {
        this.last = { id, start: this.game.time, hits: 0, damage: 0, firstHit: -1, echo: true, heavy: info.heavy };
      }
      if (!this.last) this.last = { id, start: this.game.time, hits: 0, damage: 0, firstHit: -1, echo: false, heavy: info.heavy };
      const l = this.last;
      // The hit names the move more precisely (e.g. the 3rd light starts a leap that lands as 'slam').
      if (id !== l.id && !MoveList.some((m) => m.id === l.id) && MoveList.some((m) => m.id === id)) l.id = id;
      if (l.firstHit < 0) l.firstHit = this.game.time - l.start;
      l.hits++;
      l.damage += info.damage;
      if (info.source === 'echo') l.echo = true;
      this.renderLast();
    });
    events.on('loadout:changed', () => {
      if (this.showMoves) this.renderMoves();
    });
    events.on('ui:pause', ({ paused }) => this.root.classList.toggle('is-paused', paused));
    this.root.classList.toggle('is-paused', game.paused);

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyT') this.toggleHistory();
      else if (e.code === 'F1') {
        e.preventDefault();
        this.toggleMoves();
      }
    });
    this.apply();
    this.renderLast();
  }

  toggleHistory(v = !this.showHistory) {
    this.showHistory = v;
    this.game.hud.flash(v ? 'training: inputs on' : 'training: inputs off', 0.9);
    this.apply();
  }

  toggleMoves(v = !this.showMoves) {
    this.showMoves = v;
    this.apply();
  }

  private apply() {
    this.root.classList.toggle('show-history', this.showHistory);
    this.root.classList.toggle('show-moves', this.showMoves);
    if (this.showMoves) this.renderMoves();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ history: this.showHistory, moves: this.showMoves }));
    } catch {
      /* ignore */
    }
  }

  /** Sample the stick (camera-relative) and flush button presses into rows. */
  update() {
    const m = this.game.input.move;
    let dir = -1;
    if (m.lengthSq() > 0.09) {
      const a = Math.atan2(m.y, m.x); // 0 = right, π/2 = forward
      dir = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    }
    const buttons = this.pending;
    if (dir !== this.dir || buttons.length) {
      this.dir = dir;
      this.push(dir, [...new Set(buttons)]); // dir -1 + no buttons = back to neutral
      this.pending = [];
    }
    if (this.showHistory) this.renderFrames();
  }

  private push(dir: number, buttons: string[]) {
    const el = document.createElement('div');
    el.className = 'tr-row';
    const btn = buttons.map((b) => `<b class="k k-${b}">${b}</b>`).join('');
    el.innerHTML = `<span class="f"></span><span class="d">${dir >= 0 ? ARROWS[dir] : dir === -1 && !buttons.length ? '·' : ''}</span>${btn}`;
    this.historyEl.prepend(el);
    this.rows.unshift({ dir, buttons, start: this.game.time, el });
    while (this.rows.length > MAX_ROWS) this.rows.pop()!.el.remove();
  }

  private renderFrames() {
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const end = i === 0 ? this.game.time : this.rows[i - 1].start;
      const f = Math.round((end - r.start) * 60);
      const txt = f > 99 ? '99+' : `${f}`;
      const fe = r.el.firstElementChild as HTMLElement;
      if (fe.textContent !== txt) fe.textContent = txt;
    }
  }

  private renderLast() {
    const l = this.last;
    if (!l) {
      this.lastEl.innerHTML = `<div class="tr-head">Last move</div><div class="tr-empty">—</div>`;
      return;
    }
    const entry = MoveList.find((m) => m.id === l.id);
    const name = entry?.name ?? l.id;
    const startup = l.firstHit >= 0 ? `${Math.round(l.firstHit * 60)}f` : '—';
    this.lastEl.innerHTML = `
      <div class="tr-head">Last move${l.echo ? ' <span class="echo">echo</span>' : ''}</div>
      <div class="tr-name">${esc(name)}</div>
      ${entry ? `<div class="tr-input">${notation(entry.input)}</div>` : ''}
      <div class="tr-stats"><span>hits <b>${l.hits}</b></span><span>dmg <b>${l.damage}</b></span><span>hit @ <b>${startup}</b></span></div>`;
  }

  renderMoves() {
    const groups = new Map<string, MoveEntry[]>();
    for (const m of MoveList) {
      const g = groupOf(m);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(m);
    }
    const order = ['Ground', 'Heavy', 'Directional', 'Dodge', 'Aerial', 'Defense', 'Echo'];
    const names = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99 || a.localeCompare(b));
    this.movesEl.innerHTML =
      `<div class="tr-head">Move list <span>F1</span></div>` +
      names
        .map(
          (g) =>
            `<div class="tr-group">${esc(g)}</div>` +
            groups
              .get(g)!
              .map((m) => {
                const ok = !m.requires || tokenActive(m.requires);
                return `<div class="tr-move${ok ? '' : ' off'}" title="${esc(m.description)}">
                  <span class="nm">${esc(m.name)}</span><span class="in">${notation(m.input)}</span>
                  <div class="ds">${esc(m.description)}${ok ? '' : ` <em>requires ${esc(requiresLabel(m.requires!))}</em>`}</div></div>`;
              })
              .join(''),
        )
        .join('');
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** "L L [H]" → key caps. */
function notation(input: string) {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      if (/^\(.*\)$/.test(t)) return `<i>${esc(t.slice(1, -1))}</i>`;
      const key = t.replace(/[[\]]/g, '');
      const cls = /^[LHJDBE]$/.test(key) ? ` k-${key}` : '';
      return `<b class="k${cls}${t.startsWith('[') ? ' hold' : ''}">${esc(t)}</b>`;
    })
    .join('');
}

function groupOf(m: MoveEntry): string {
  const g = (m as MoveEntry & { group?: string }).group;
  if (g) return g;
  const r = m.requires ?? '';
  if (/\(air\)/i.test(m.input)) return 'Aerial';
  if (r.startsWith('defense') || /\bB\b/.test(m.input)) return 'Defense';
  if (r.startsWith('echo') || /\bE\b/.test(m.input)) return 'Echo';
  if (r === 'combat.dodgeAttacks' || /\bD\b/.test(m.input)) return 'Dodge';
  if (r === 'combat.directional' || /[→←↑↓]/.test(m.input)) return 'Directional';
  if (/H/.test(m.input)) return 'Heavy';
  return 'Ground';
}

/** Same semantics as Loadout's requires tokens: `id` (on / above first tier / non-default) or `id=value`. */
function tokenActive(token: string): boolean {
  const [id, val] = token.split('=');
  const def = loadout.definitions().find((d) => d.id === id);
  if (!def) return true; // unknown token: don't hide the move
  const cur = loadout.get(id);
  if (val !== undefined) return String(cur) === val;
  if (def.kind === 'toggle') return cur === true;
  if (def.kind === 'tier') return cur !== def.levels[0];
  return cur !== def.default;
}

function requiresLabel(token: string) {
  const [id, val] = token.split('=');
  const def = loadout.definitions().find((d) => d.id === id);
  return def ? `${def.name}${val ? `: ${val}` : ''}` : token;
}

let training: Training | null = null;

export const trainingFeature: Feature = {
  name: 'training',
  install(game) {
    training = new Training(game);
    if (import.meta.env.DEV) Object.assign(window as object, { training });
  },
  lateUpdate() {
    training?.update();
  },
};

const CSS = `
.training { position: absolute; inset: 0; pointer-events: none; transition: opacity 0.25s; }
.training.is-paused { opacity: 0; }
.training .tr-panel {
  background: var(--panel); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;
  font-family: ui-sans-serif, system-ui, sans-serif; color: var(--ink-dim); font-size: 12px;
}
.training .tr-head {
  display: flex; justify-content: space-between; color: var(--ink); font-family: "Cinzel", Georgia, serif;
  letter-spacing: 0.15em; text-transform: uppercase; font-size: 11px; margin-bottom: 6px;
}
.training .tr-head span { color: var(--ink-dim); font: 10px ui-monospace, monospace; letter-spacing: 0; text-transform: none; }
.training .tr-history { position: absolute; left: 18px; top: 64px; width: 150px; padding: 10px 10px 8px; display: none; }
.training .tr-last {
  position: absolute; left: 50%; top: 12px; transform: translateX(-50%); min-width: 260px; padding: 8px 14px;
  display: none; text-align: center;
}
.training.show-history .tr-history, .training.show-history .tr-last { display: block; }
.training .tr-last .tr-head { justify-content: center; gap: 8px; margin-bottom: 2px; }
.training .tr-rows { display: flex; flex-direction: column; gap: 2px; min-height: 12px; }
.training .tr-row { display: flex; align-items: center; gap: 4px; height: 20px; }
.training .tr-row:first-child { color: var(--ink); }
.training .tr-row:nth-child(n+7) { opacity: 0.6; }
.training .tr-row:nth-child(n+10) { opacity: 0.35; }
.training .tr-row .f { width: 28px; text-align: right; font: 11px ui-monospace, monospace; color: var(--ink-dim); margin-right: 4px; }
.training .tr-row .d { width: 18px; text-align: center; font-size: 15px; color: var(--ink); }
.training .k {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px;
  font: 600 10px/1 ui-monospace, monospace; color: #10131a; background: #d9d2c2;
}
.training .k-L { background: #f3ecdc; }
.training .k-H { background: #f0b35a; }
.training .k-J { background: #8fd18c; }
.training .k-D { background: #9ab7ff; }
.training .k-B { background: #c9a2ff; }
.training .k-E { background: var(--echo); }
.training .k-S, .training .k-R { background: rgba(255,255,255,0.35); }
.training .k.hold { border-radius: 3px; box-shadow: inset 0 0 0 2px rgba(0,0,0,0.35); }
.training .tr-last .echo { color: var(--echo); font-family: ui-monospace, monospace; }
.training .tr-name { color: var(--ink); font-family: "Cinzel", Georgia, serif; font-size: 14px; margin-bottom: 4px; }
.training .tr-input { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; justify-content: center; margin-bottom: 4px; }
.training .tr-input i, .training .tr-move .in i { font-size: 10px; color: var(--ink-dim); margin-right: 2px; }
.training .tr-stats { display: flex; justify-content: center; gap: 16px; font: 11px ui-monospace, monospace; }
.training .tr-stats b { color: #ffe2a8; font-weight: 600; }
.training .tr-empty { color: var(--ink-dim); }
.training .tr-moves {
  position: absolute; left: 200px; top: 12%; width: 320px; max-height: 70vh; overflow: auto; padding: 12px 14px;
  display: none; pointer-events: auto; scrollbar-width: thin;
}
.training:not(.show-history) .tr-moves { left: 18px; }
.training.show-moves .tr-moves { display: block; }
.training .tr-group {
  margin: 10px 0 4px; padding-bottom: 2px; border-bottom: 1px solid rgba(240,179,90,0.3);
  color: var(--accent); font-family: "Cinzel", Georgia, serif; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
}
.training .tr-move { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; padding: 3px 0; }
.training .tr-move .nm { color: var(--ink); font-size: 12px; }
.training .tr-move .in { display: flex; gap: 3px; align-items: center; }
.training .tr-move .ds { flex-basis: 100%; font-size: 10.5px; color: var(--ink-dim); line-height: 1.35; }
.training .tr-move.off { opacity: 0.38; }
.training .tr-move.off .k { background: rgba(255,255,255,0.3); }
.training .tr-move em { color: #f0b35a; font-style: normal; }
@media (max-width: 720px) {
  .training.show-history .tr-history { display: none; }
  .training .tr-last { min-width: 0; width: max-content; max-width: 70vw; }
  .training .tr-moves { left: 12px !important; right: 12px; width: auto; top: 118px; max-height: 55vh; background: rgba(12,14,20,0.85); z-index: 1; }
}
`;
