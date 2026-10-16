import './loadoutPanel.css';
import { Presets, Upgrades, type UpgradeDef } from '../config/upgrades';
import { events, type LoadoutValue } from '../core/Events';
import type { Game } from '../core/Game';
import { loadout } from '../core/Loadout';
import type { Feature } from '../features';

/**
 * Loadout panel (pause menu for the kit), the pause-overlay menu buttons and the
 * always-on "active kit" HUD chips. Fully data-driven from `Upgrades` / `Presets`:
 * new upgrades and categories appear automatically.
 *
 * Input:
 *  - open: `loadout` action (Tab / Back) in game or on the pause overlay, or the overlay button
 *  - close: `loadout` / `pause` action (Tab, Esc, Back, Start), pad B, or the Close button
 *  - keyboard: arrows / WASD navigate (spatial), Enter / Space select, Q / E category, P presets
 *  - gamepad: D-pad / left stick navigate (with repeat), A select, B close, LB / RB category, Y presets
 */

const CATEGORY_LABELS: Record<string, string> = {
  echo: 'Echo',
  movement: 'Movement',
  defense: 'Defense',
  combat: 'Combat',
};
const CATEGORY_GLYPHS: Record<string, string> = {
  echo: '◈',
  movement: '➶',
  defense: '⛨',
  combat: '⚔',
};

const DEFS = new Map(Upgrades.map((d) => [d.id, d]));

function categories(): string[] {
  const out: string[] = [];
  for (const d of Upgrades) if (!out.includes(d.category)) out.push(d.category);
  return out;
}
const catLabel = (c: string) => CATEGORY_LABELS[c] ?? c.charAt(0).toUpperCase() + c.slice(1);

function esc(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function valueLabel(def: UpgradeDef, v: LoadoutValue): string {
  if (def.kind === 'toggle') return v ? 'On' : 'Off';
  if (def.kind === 'tier') return def.labels?.[def.levels.indexOf(v as number)] ?? String(v);
  return def.options.find((o) => o.id === v)?.name ?? String(v);
}

function chipLabel(def: UpgradeDef, v: LoadoutValue): string {
  if (def.kind === 'toggle') return v ? def.name : `No ${def.name}`;
  return `${def.name}: ${valueLabel(def, v)}`;
}

function isOff(def: UpgradeDef, v: LoadoutValue) {
  return (def.kind === 'toggle' && v === false) || (def.kind === 'tier' && v === def.levels[0]);
}
function offValue(def: UpgradeDef): LoadoutValue {
  if (def.kind === 'toggle') return false;
  if (def.kind === 'tier') return def.levels[0];
  return def.default;
}

function rulesFor(def: UpgradeDef, value: LoadoutValue) {
  const requires = [...(def.requires ?? [])];
  const excludes = [...(def.excludes ?? [])];
  if (def.kind === 'choice') {
    const opt = def.options.find((o) => o.id === value);
    if (opt?.requires) requires.push(...opt.requires);
    if (opt?.excludes) excludes.push(...opt.excludes);
  }
  return { requires, excludes };
}

function tokenActive(token: string) {
  const [id, val] = token.split('=');
  const def = DEFS.get(id);
  if (!def) return false;
  const cur = loadout.get(id);
  if (val !== undefined) return String(cur) === val;
  if (def.kind === 'toggle') return cur === true;
  if (def.kind === 'tier') return cur !== def.levels[0];
  return cur !== def.default;
}

function parseValue(def: UpgradeDef, raw: string): LoadoutValue {
  if (def.kind === 'toggle') return raw === 'true';
  if (def.kind === 'tier') return Number(raw);
  return raw;
}

/** Non-default upgrades as [def, value] pairs (the "active kit"). */
function activeKit(): [UpgradeDef, LoadoutValue][] {
  return Upgrades.filter((d) => loadout.get(d.id) !== d.default).map((d) => [d, loadout.get(d.id)]);
}

/** Preset whose values exactly match the current loadout, if any. */
function matchingPreset() {
  const snap = loadout.snapshot();
  return Presets.find((p) =>
    Upgrades.every((d) => (p.values[d.id] ?? d.default) === snap[d.id]),
  );
}

/**
 * "Switch anyway": set `id` to `value`, first turning off whatever conflicts with it
 * (or enabling what it requires). Returns the names of upgrades that were changed.
 */
export function forceSelect(id: string, value: LoadoutValue): { ok: boolean; changed: string[]; reason?: string } {
  const def = DEFS.get(id);
  if (!def) return { ok: false, changed: [], reason: 'unknown upgrade' };
  const changed: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = loadout.set(id, value);
    if (r.ok) return { ok: true, changed };
    let fixed = false;
    const own = rulesFor(def, value);
    for (const t of own.requires) {
      if (tokenActive(t)) continue;
      const [tid, tval] = t.split('=');
      const tdef = DEFS.get(tid);
      if (!tdef) continue;
      let v: LoadoutValue;
      if (tval !== undefined) v = parseValue(tdef, tval);
      else if (tdef.kind === 'toggle') v = true;
      else if (tdef.kind === 'tier') v = tdef.levels[1] ?? tdef.levels[0];
      else v = tdef.options.find((o) => o.id !== tdef.default)?.id ?? tdef.default;
      if (loadout.set(tid, v, { force: true }).ok) {
        changed.push(tdef.name);
        fixed = true;
      }
    }
    for (const t of own.excludes) {
      if (!tokenActive(t)) continue;
      const tdef = DEFS.get(t.split('=')[0]);
      if (!tdef) continue;
      loadout.set(tdef.id, offValue(tdef), { force: true });
      changed.push(tdef.name);
      fixed = true;
    }
    const self = def.kind === 'choice' ? `${id}=${value}` : id;
    for (const other of Upgrades) {
      if (other.id === id) continue;
      const ov = loadout.get(other.id);
      if (isOff(other, ov)) continue;
      const ex = rulesFor(other, ov).excludes;
      if (ex.includes(self) || ex.includes(id)) {
        loadout.set(other.id, offValue(other), { force: true });
        changed.push(other.name);
        fixed = true;
      }
    }
    if (!fixed) return { ok: false, changed, reason: r.reason };
  }
  return { ok: false, changed, reason: 'could not resolve conflicts' };
}

interface Notice {
  id: string;
  value: LoadoutValue;
  reason: string;
}

type Dir = 'up' | 'down' | 'left' | 'right';

const NAV_REPEAT_DELAY = 0.38;
const NAV_REPEAT_RATE = 0.11;

export class LoadoutPanel {
  private readonly root: HTMLElement;
  private readonly presetsEl: HTMLElement;
  private readonly catsEl: HTMLElement;
  private readonly cardsEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly kitEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly chips: HTMLElement;
  private chipsFade = 0;

  isOpen = false;
  private cat = categories()[0];
  private focusKey: string | null = null;
  private notice: Notice | null = null;
  private renderQueued = false;
  private device: string = '';
  private pointerActive = false;

  // gamepad edge / repeat state
  private padPrev: boolean[] = [];
  private navDir: Dir | null = null;
  private navTimer = 0;

  constructor(private readonly game: Game) {
    const root = document.createElement('div');
    root.className = 'lo-backdrop';
    root.hidden = true;
    root.innerHTML = `
      <div class="lo-panel" role="dialog" aria-label="Loadout">
        <header class="lo-header">
          <div>
            <h2>Loadout</h2>
            <p class="lo-sub">Same knight, different kit — changes apply instantly</p>
          </div>
          <button class="lo-x" data-key="close" aria-label="Close">✕</button>
        </header>
        <div class="lo-presets"></div>
        <div class="lo-body">
          <nav class="lo-cats"></nav>
          <div class="lo-cards"></div>
          <aside class="lo-side">
            <div class="lo-detail"></div>
            <div class="lo-kit"></div>
          </aside>
        </div>
        <footer class="lo-footer">
          <span class="lo-hint"></span>
          <span class="lo-footer-btns">
            <button class="lo-btn nav" data-key="reset">Reset to Base</button>
            <button class="lo-btn lo-primary nav" data-key="close">Close</button>
          </span>
        </footer>
      </div>`;
    this.root = game.hud.mount(root);
    this.presetsEl = root.querySelector('.lo-presets')!;
    this.catsEl = root.querySelector('.lo-cats')!;
    this.cardsEl = root.querySelector('.lo-cards')!;
    this.detailEl = root.querySelector('.lo-detail')!;
    this.kitEl = root.querySelector('.lo-kit')!;
    this.hintEl = root.querySelector('.lo-hint')!;

    this.chips = game.hud.mount(document.createElement('div'));
    this.chips.className = 'kit-chips';

    // Mouse: click activates, hover focuses (drives the detail area).
    root.addEventListener('mousedown', (e) => e.preventDefault()); // keep DOM focus off buttons
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      if (el && root.contains(el)) {
        this.setFocus(el.dataset.key!, false);
        this.activate(el.dataset.key!);
      } else if (e.target === root) {
        this.close();
      }
    });
    // Hover follows the mouse only after it actually moved, so a re-render under a resting
    // cursor doesn't steal keyboard / gamepad focus.
    root.addEventListener('mousemove', () => (this.pointerActive = true));
    root.addEventListener('mouseover', (e) => {
      if (!this.pointerActive) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('.nav');
      if (el && el.dataset.key !== this.focusKey) this.setFocus(el.dataset.key!, false);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));

    events.on('loadout:changed', () => this.queueRender());
    this.renderChips(false);
  }

  // ------------------------------------------------------------------ open / close
  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.notice = null;
    this.root.hidden = false;
    this.game.setPaused('menu');
    this.padPrev = this.readPad().slice();
    this.navDir = null;
    this.render();
    if (!this.focusKey || this.focusKey === 'close' || !this.find(this.focusKey)) {
      const first = this.cardsEl.querySelector<HTMLElement>('.nav');
      this.setFocus(first?.dataset.key ?? `c:${this.cat}`);
    } else this.setFocus(this.focusKey);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    if (this.game.pauseReason === 'menu') this.game.setPaused(null);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  // ------------------------------------------------------------------ rendering
  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (this.notice && loadout.get(this.notice.id) === this.notice.value) this.notice = null;
      this.renderChips(true);
      if (this.isOpen) this.render();
    });
  }

  private render() {
    const preset = matchingPreset();
    this.presetsEl.innerHTML =
      `<span class="lo-label">Presets</span>` +
      Presets.map(
        (p) =>
          `<button class="lo-preset nav${preset?.id === p.id ? ' active' : ''}" data-key="p:${p.id}" title="${esc(p.description)}">${esc(p.name)}</button>`,
      ).join('');

    this.catsEl.innerHTML = categories()
      .map((c) => {
        const mods = Upgrades.filter((d) => d.category === c && loadout.get(d.id) !== d.default).length;
        return `<button class="lo-cat nav cat-${c}${c === this.cat ? ' active' : ''}" data-key="c:${c}">
          <span class="lo-glyph">${CATEGORY_GLYPHS[c] ?? '◆'}</span><span class="lo-cat-name">${esc(catLabel(c))}</span>
          ${mods ? `<span class="lo-count">${mods}</span>` : ''}</button>`;
      })
      .join('');

    this.cardsEl.className = `lo-cards cat-${this.cat}`;
    this.cardsEl.innerHTML = Upgrades.filter((d) => d.category === this.cat)
      .map((d) => this.cardHtml(d))
      .join('');

    const dev = this.game.input.lastDevice;
    this.device = dev;
    this.hintEl.innerHTML =
      dev === 'pad'
        ? '<b>D-pad</b> navigate · <b>A</b> select · <b>LB/RB</b> category · <b>Y</b> presets · <b>B</b> close'
        : '<b>Arrows</b> navigate · <b>Enter</b> select · <b>Q/E</b> category · <b>P</b> presets · <b>Esc/Tab</b> close';

    this.renderKit(this.kitEl, preset?.name);
    if (this.focusKey && !this.find(this.focusKey)) {
      // focused element vanished (e.g. notice dismissed): fall back to its upgrade
      const id = this.focusKey.split(':')[1];
      const alt = this.cardsEl.querySelector<HTMLElement>(`[data-upgrade="${CSS.escape(id ?? '')}"] .nav`);
      this.focusKey = alt?.dataset.key ?? `c:${this.cat}`;
    }
    this.applyFocus(false);
  }

  private cardHtml(d: UpgradeDef): string {
    const cur = loadout.get(d.id);
    const changed = cur !== d.default;
    let control = '';
    let blockedLine = '';
    if (d.kind === 'toggle') {
      const reason = cur ? null : loadout.blockedReason(d.id, true);
      control = `<button class="lo-switch nav${cur ? ' on' : ''}${reason ? ' blocked' : ''}" data-key="t:${d.id}" role="switch" aria-checked="${cur}">
        <span class="lo-knob"></span><span class="lo-switch-label">${cur ? 'On' : 'Off'}</span></button>`;
      if (reason) blockedLine = `<div class="lo-reason">${esc(reason)}</div>`;
    }
    let options = '';
    if (d.kind === 'tier') {
      options = `<div class="lo-seg">${d.levels
        .map((lv, i) => {
          const reason = lv === cur ? null : loadout.blockedReason(d.id, lv);
          return `<button class="lo-seg-btn nav${lv === cur ? ' on' : ''}${reason ? ' blocked' : ''}" data-key="o:${d.id}:${lv}">
            ${esc(d.labels?.[i] ?? String(lv))}${reason ? `<small>${esc(reason)}</small>` : ''}</button>`;
        })
        .join('')}</div>`;
    } else if (d.kind === 'choice') {
      options = `<div class="lo-choices">${d.options
        .map((o) => {
          const reason = o.id === cur ? null : loadout.blockedReason(d.id, o.id);
          return `<button class="lo-choice nav${o.id === cur ? ' on' : ''}${reason ? ' blocked' : ''}" data-key="o:${d.id}:${o.id}">
            <span class="lo-choice-name">${esc(o.name)}</span>
            <span class="lo-choice-desc">${esc(o.description)}</span>
            ${reason ? `<span class="lo-reason">${esc(reason)}</span>` : ''}</button>`;
        })
        .join('')}</div>`;
    }
    let notice = '';
    if (this.notice?.id === d.id) {
      const n = this.notice;
      notice = `<div class="lo-notice">
        <span>Can't pick <b>${esc(valueLabel(d, n.value))}</b> — ${esc(n.reason)}.</span>
        <span class="lo-notice-btns">
          <button class="lo-btn lo-primary nav" data-key="force:${d.id}:${String(n.value)}">Switch anyway</button>
          <button class="lo-btn nav" data-key="dismiss:${d.id}">Keep</button>
        </span></div>`;
    }
    return `<section class="lo-card${changed ? ' changed' : ''}" data-upgrade="${d.id}">
      <div class="lo-card-head">
        <div><h3>${esc(d.name)}</h3>${changed && d.kind !== 'toggle' ? `<span class="lo-mod">${esc(valueLabel(d, cur))}</span>` : ''}</div>
        ${control}
      </div>
      <p class="lo-desc">${esc(d.description)}</p>
      ${blockedLine}${options}${notice}
    </section>`;
  }

  private renderKit(el: HTMLElement, presetName?: string) {
    const kit = activeKit();
    el.innerHTML =
      `<div class="lo-label">Active kit${presetName ? ` · <span class="lo-kit-preset">${esc(presetName)}</span>` : ''}</div>` +
      (kit.length
        ? `<div class="lo-chips">${kit
            .map(([d, v]) => `<span class="lo-chip cat-${d.category}${isOff(d, v) ? ' off' : ''}">${esc(chipLabel(d, v))}</span>`)
            .join('')}</div>`
        : `<div class="lo-empty">Base kit — nothing changed.</div>`);
  }

  /** Compact always-on HUD row (top-right). */
  private renderChips(highlight: boolean) {
    const kit = activeKit();
    const preset = matchingPreset();
    this.chips.innerHTML =
      `<span class="kc-title">${esc(preset ? preset.name : 'Custom')} kit</span>` +
      kit
        .map(([d, v]) => `<span class="kc cat-${d.category}${isOff(d, v) ? ' off' : ''}">${esc(chipLabel(d, v))}</span>`)
        .join('');
    if (highlight) {
      this.chips.classList.add('fresh');
      this.chipsFade = 4;
    }
  }

  // ------------------------------------------------------------------ focus
  private find(key: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`.nav[data-key="${CSS.escape(key)}"]`);
  }

  private navEls(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('.nav')].filter((e) => e.getClientRects().length > 0);
  }

  private setFocus(key: string, scroll = true) {
    this.focusKey = key;
    // Keyboard / pad focus on a category tab switches to it (tabs act like a list).
    if (key.startsWith('c:') && key.slice(2) !== this.cat) {
      this.cat = key.slice(2);
      this.notice = null;
      this.render();
    }
    this.applyFocus(scroll);
  }

  private applyFocus(scroll: boolean) {
    this.root.querySelectorAll('.kfocus').forEach((e) => e.classList.remove('kfocus'));
    const el = this.focusKey ? this.find(this.focusKey) : null;
    if (el) {
      el.classList.add('kfocus');
      if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    this.renderDetail();
  }

  private renderDetail() {
    const key = this.focusKey ?? '';
    const [kind, id, raw] = key.split(':');
    let html = '';
    if (kind === 'p') {
      const p = Presets.find((x) => x.id === id)!;
      const vals = Object.entries(p.values)
        .map(([uid, v]) => {
          const d = DEFS.get(uid);
          return d ? `<span class="lo-chip cat-${d.category}">${esc(chipLabel(d, v))}</span>` : '';
        })
        .join('');
      html = `<div class="lo-kind">Preset</div><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p>
        ${vals ? `<div class="lo-chips">${vals}</div>` : '<p class="lo-dim">All upgrades at their defaults.</p>'}
        <p class="lo-dim">Applying a preset resets everything else to default.</p>`;
    } else if (kind === 'c') {
      const defs = Upgrades.filter((d) => d.category === id);
      html = `<div class="lo-kind">Category</div><h3>${esc(catLabel(id))}</h3>
        <p>${defs.length} upgrades · ${defs.filter((d) => loadout.get(d.id) !== d.default).length} changed</p>`;
    } else if ((kind === 't' || kind === 'o' || kind === 'force' || kind === 'dismiss') && DEFS.has(id)) {
      const d = DEFS.get(id)!;
      const cur = loadout.get(id);
      const kindLabel = d.kind === 'toggle' ? 'Toggle' : d.kind === 'tier' ? 'Tier' : 'Exclusive choice';
      html = `<div class="lo-kind cat-${d.category}">${esc(catLabel(d.category))} · ${kindLabel}</div>
        <h3>${esc(d.name)}</h3><p>${esc(d.description)}</p>`;
      if (kind === 'o' && raw !== undefined) {
        const v = parseValue(d, raw);
        if (d.kind === 'choice') {
          const o = d.options.find((x) => x.id === raw);
          if (o) html += `<div class="lo-opt"><b>${esc(o.name)}</b> — ${esc(o.description)}</div>`;
        } else html += `<div class="lo-opt"><b>${esc(valueLabel(d, v))}</b></div>`;
        const reason = v === cur ? null : loadout.blockedReason(id, v);
        if (reason) html += `<p class="lo-warn">Unavailable: ${esc(reason)}</p>`;
      } else if (kind === 't' && !cur) {
        const reason = loadout.blockedReason(id, true);
        if (reason) html += `<p class="lo-warn">Unavailable: ${esc(reason)}</p>`;
      }
      html += `<p class="lo-dim">Current: <b>${esc(valueLabel(d, cur))}</b>${cur === d.default ? ' (default)' : ` · default ${esc(valueLabel(d, d.default))}`}</p>`;
    } else if (kind === 'reset') {
      html = `<div class="lo-kind">Reset</div><h3>Base kit</h3><p>Return every upgrade to its default.</p>`;
    } else {
      html = `<div class="lo-kind">Loadout</div><h3>Shape your kit</h3>
        <p>Pick a preset or tune single upgrades. Gameplay picks changes up immediately.</p>`;
    }
    this.detailEl.innerHTML = html;
  }

  /** Spatial navigation: nearest focusable element in `dir` from the focused one. */
  private move(dir: Dir) {
    this.pointerActive = false;
    const els = this.navEls();
    const cur = this.focusKey ? this.find(this.focusKey) : null;
    if (!cur) {
      if (els[0]) this.setFocus(els[0].dataset.key!);
      return;
    }
    const a = cur.getBoundingClientRect();
    const acx = a.left + a.width / 2;
    const acy = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of els) {
      if (el === cur || el.dataset.key === this.focusKey) continue;
      const b = el.getBoundingClientRect();
      const bcx = b.left + b.width / 2;
      const bcy = b.top + b.height / 2;
      let primary: number;
      let ortho: number;
      if (dir === 'down' || dir === 'up') {
        primary = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
        if ((dir === 'down' ? bcy - acy : acy - bcy) <= 2) continue;
        ortho = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)) + Math.abs(bcx - acx) * 0.05;
      } else {
        primary = dir === 'right' ? b.left - a.right : a.left - b.right;
        if ((dir === 'right' ? bcx - acx : acx - bcx) <= 2) continue;
        const gap = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
        if (gap > 48) continue; // left/right stays roughly on the same line
        ortho = gap + Math.abs(bcy - acy) * 0.05;
      }
      if (primary < -4) continue; // must lie beyond the focused element's edge
      const score = Math.max(primary, 0) + ortho * 4;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.setFocus(best.dataset.key!);
  }

  private cycleCategory(step: number) {
    const cats = categories();
    const i = (cats.indexOf(this.cat) + step + cats.length) % cats.length;
    this.cat = cats[i];
    this.notice = null;
    this.render();
    const first = this.cardsEl.querySelector<HTMLElement>('.nav');
    this.setFocus(first?.dataset.key ?? `c:${this.cat}`);
  }

  private focusPresets() {
    const active = this.presetsEl.querySelector<HTMLElement>('.lo-preset.active') ?? this.presetsEl.querySelector<HTMLElement>('.nav');
    if (active) this.setFocus(active.dataset.key!);
  }

  // ------------------------------------------------------------------ actions
  private activate(key: string) {
    const [kind, id, raw] = key.split(':');
    switch (kind) {
      case 'close':
        this.close();
        return;
      case 'reset':
        this.notice = null;
        loadout.applyPreset('base');
        this.game.hud.flash('kit reset', 1);
        return;
      case 'p': {
        this.notice = null;
        loadout.applyPreset(id);
        this.game.hud.flash(`${Presets.find((p) => p.id === id)?.name ?? id} kit`, 1.2);
        return;
      }
      case 'c':
        if (id !== this.cat) this.setFocus(key);
        else {
          const first = this.cardsEl.querySelector<HTMLElement>('.nav');
          if (first) this.setFocus(first.dataset.key!);
        }
        return;
      case 't':
        this.choose(id, !loadout.has(id));
        return;
      case 'o': {
        const d = DEFS.get(id);
        if (d) this.choose(id, parseValue(d, raw));
        return;
      }
      case 'force': {
        const d = DEFS.get(id);
        if (!d) return;
        const v = parseValue(d, raw);
        const r = forceSelect(id, v);
        this.notice = null;
        if (r.ok) {
          this.focusKey = d.kind === 'toggle' ? `t:${id}` : `o:${id}:${String(v)}`;
          if (r.changed.length) this.game.hud.flash(`turned off ${r.changed.join(', ')}`, 1.6);
        } else this.notice = { id, value: v, reason: r.reason ?? 'unavailable' };
        this.render();
        return;
      }
      case 'dismiss': {
        const d = DEFS.get(id);
        this.notice = null;
        this.focusKey = d?.kind === 'toggle' ? `t:${id}` : null;
        this.render();
        return;
      }
    }
  }

  private choose(id: string, value: LoadoutValue) {
    if (loadout.get(id) === value) return;
    const r = loadout.set(id, value);
    if (r.ok) {
      this.notice = null;
      return;
    }
    const d = DEFS.get(id)!;
    this.notice = { id, value, reason: r.reason ?? 'unavailable' };
    const srcKey = d.kind === 'toggle' ? `t:${id}` : `o:${id}:${String(value)}`;
    this.render();
    this.find(srcKey)?.classList.add('shake');
    // Put the cursor on "Switch anyway" so a pad user can confirm right away.
    this.pointerActive = false;
    this.setFocus(`force:${id}:${String(value)}`);
  }

  // ------------------------------------------------------------------ input
  private onKey(e: KeyboardEvent) {
    if (!this.isOpen) return;
    const code = e.code;
    const dirs: Record<string, Dir> = {
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    };
    if (dirs[code]) {
      e.preventDefault();
      this.move(dirs[code]);
    } else if ((code === 'Enter' || code === 'Space' || code === 'NumpadEnter') && !e.repeat) {
      e.preventDefault();
      if (this.focusKey) this.activate(this.focusKey);
    } else if (code === 'KeyQ' && !e.repeat) this.cycleCategory(-1);
    else if (code === 'KeyE' && !e.repeat) this.cycleCategory(1);
    else if (code === 'KeyP' && !e.repeat) this.focusPresets();
    // Tab / Escape close via the input actions in pausedUpdate (single edge, no reopen).
  }

  private readPad(): boolean[] {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p.buttons.map((b) => b.pressed || b.value > 0.5);
    return [];
  }

  /** Runs while paused: open from the pause overlay, menu navigation. */
  pausedUpdate(dt: number) {
    const input = this.game.input;
    if (!this.isOpen) {
      if (this.game.pauseReason === 'overlay' && input.pressed('loadout')) this.open();
      return;
    }
    if (input.pressed('loadout') || input.pressed('pause')) {
      this.close();
      return;
    }
    if (this.device !== input.lastDevice) this.render();

    const now = this.readPad();
    const edge = (i: number) => !!now[i] && !this.padPrev[i];
    if (now.length) {
      if (edge(0) && this.focusKey) this.activate(this.focusKey); // A
      else if (edge(1)) this.close(); // B
      else if (edge(4)) this.cycleCategory(-1); // LB
      else if (edge(5)) this.cycleCategory(1); // RB
      else if (edge(3)) this.focusPresets(); // Y
    }
    this.padPrev = now;
    if (!this.isOpen) return;

    // D-pad (12-15) or left stick, with a repeat delay.
    let dir: Dir | null = null;
    if (now[12]) dir = 'up';
    else if (now[13]) dir = 'down';
    else if (now[14]) dir = 'left';
    else if (now[15]) dir = 'right';
    else if (input.lastDevice === 'pad' && input.move.lengthSq() > 0.35) {
      const m = input.move;
      dir = Math.abs(m.x) > Math.abs(m.y) ? (m.x > 0 ? 'right' : 'left') : m.y > 0 ? 'up' : 'down';
    }
    if (dir !== this.navDir) {
      this.navDir = dir;
      this.navTimer = NAV_REPEAT_DELAY;
      if (dir) this.move(dir);
    } else if (dir) {
      this.navTimer -= dt;
      if (this.navTimer <= 0) {
        this.navTimer = NAV_REPEAT_RATE;
        this.move(dir);
      }
    }
  }

  /** Real-time tick (fade the HUD chips also while paused). */
  tickChips(dt: number) {
    if (this.chipsFade > 0) {
      this.chipsFade -= dt;
      if (this.chipsFade <= 0) this.chips.classList.remove('fresh');
    }
  }
}

/** Pause / start overlay buttons: Play · Loadout. */
function installOverlayMenu(game: Game, panel: LoadoutPanel) {
  const menu = game.hud.overlayMenu();
  menu.innerHTML = `
    <button class="ov-btn" data-act="play">Play</button>
    <button class="ov-btn" data-act="loadout">Loadout</button>
    <div class="ov-hint">Tab / Back — loadout at any time</div>`;
  menu.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.act === 'loadout') panel.open();
    else game.setPaused(null);
  });
  let started = false;
  events.on('ui:pause', ({ paused }) => {
    if (!paused) started = true;
    menu.querySelector('[data-act="play"]')!.textContent = started ? 'Resume' : 'Play';
  });
}

let panel: LoadoutPanel | null = null;

export const loadoutFeature: Feature = {
  name: 'loadout-panel',
  install(game) {
    panel = new LoadoutPanel(game);
    installOverlayMenu(game, panel);
    (window as unknown as { loadoutPanel: LoadoutPanel }).loadoutPanel = panel;
  },
  update(_dt, game) {
    if (panel && game.input.pressed('loadout')) panel.open();
  },
  lateUpdate(dt) {
    panel?.tickChips(dt);
  },
  pausedUpdate(dt) {
    panel?.tickChips(dt);
    panel?.pausedUpdate(dt);
  },
};
