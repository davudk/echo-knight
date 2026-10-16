import { Presets, Upgrades, type UpgradeDef } from '../config/upgrades';
import { events, type LoadoutValue } from './Events';

const STORAGE_KEY = 'echo-knight.loadout.v1';

export interface SetResult {
  ok: boolean;
  reason?: string;
}

/**
 * Current upgrade selection. Gameplay reads it every frame (cheap map lookups), so
 * changes apply live. Validation enforces `requires` / `excludes`.
 */
export class Loadout {
  private values = new Map<string, LoadoutValue>();
  private readonly defs = new Map<string, UpgradeDef>();

  constructor() {
    for (const d of Upgrades) {
      this.defs.set(d.id, d);
      this.values.set(d.id, d.default);
    }
    this.load();
  }

  definitions() {
    return Upgrades;
  }

  get(id: string): LoadoutValue {
    const v = this.values.get(id);
    if (v === undefined) throw new Error(`Unknown upgrade '${id}'`);
    return v;
  }
  /** Toggle on? */
  has(id: string): boolean {
    return this.get(id) === true;
  }
  num(id: string): number {
    return this.get(id) as number;
  }
  str(id: string): string {
    return this.get(id) as string;
  }
  /** Choice equals option? */
  is(id: string, option: string): boolean {
    return this.get(id) === option;
  }

  /** Does a `requires`/`excludes` token currently hold? (`id`, or `id=value`) */
  private tokenActive(token: string): boolean {
    const [id, val] = token.split('=');
    const def = this.defs.get(id);
    if (!def) return false;
    const cur = this.values.get(id);
    if (val !== undefined) return String(cur) === val;
    if (def.kind === 'toggle') return cur === true;
    if (def.kind === 'tier') return cur !== def.levels[0];
    return cur !== def.default;
  }

  /** Why can't `id` be set to `value` right now? null = allowed. */
  blockedReason(id: string, value: LoadoutValue): string | null {
    const def = this.defs.get(id);
    if (!def) return 'unknown upgrade';
    const isOff =
      (def.kind === 'toggle' && value === false) || (def.kind === 'tier' && value === def.levels[0]);
    const own = this.rulesFor(def, value);
    if (!isOff) {
      for (const r of own.requires) if (!this.tokenActive(r)) return `requires ${this.label(r)}`;
      for (const x of own.excludes) if (this.tokenActive(x)) return `conflicts with ${this.label(x)}`;
    }
    // Reverse: does an active selection elsewhere exclude this one?
    const self = def.kind === 'choice' ? `${id}=${value}` : id;
    if (!isOff) {
      for (const other of this.defs.values()) {
        if (other.id === id) continue;
        const ov = this.values.get(other.id)!;
        const oRules = this.rulesFor(other, ov);
        const otherOff = (other.kind === 'toggle' && ov === false) || (other.kind === 'tier' && ov === other.levels[0]);
        if (otherOff) continue;
        if (oRules.excludes.includes(self) || oRules.excludes.includes(id)) {
          return `conflicts with ${this.describe(other, ov)}`;
        }
      }
    }
    return null;
  }

  private rulesFor(def: UpgradeDef, value: LoadoutValue) {
    const requires = [...(def.requires ?? [])];
    const excludes = [...(def.excludes ?? [])];
    if (def.kind === 'choice') {
      const opt = def.options.find((o) => o.id === value);
      if (opt?.requires) requires.push(...opt.requires);
      if (opt?.excludes) excludes.push(...opt.excludes);
    }
    return { requires, excludes };
  }

  private label(token: string) {
    const [id, val] = token.split('=');
    const def = this.defs.get(id);
    if (!def) return token;
    if (val === undefined) return def.name;
    if (def.kind === 'choice') return `${def.name}: ${def.options.find((o) => o.id === val)?.name ?? val}`;
    return `${def.name} ${val}`;
  }

  private describe(def: UpgradeDef, value: LoadoutValue) {
    if (def.kind === 'choice') return `${def.name}: ${def.options.find((o) => o.id === value)?.name ?? value}`;
    if (def.kind === 'tier') return `${def.name} ${value}`;
    return def.name;
  }

  set(id: string, value: LoadoutValue, opts: { force?: boolean; silent?: boolean } = {}): SetResult {
    const def = this.defs.get(id);
    if (!def) return { ok: false, reason: 'unknown upgrade' };
    if (def.kind === 'tier' && !def.levels.includes(value as number)) return { ok: false, reason: 'invalid level' };
    if (def.kind === 'choice' && !def.options.some((o) => o.id === value)) return { ok: false, reason: 'invalid option' };
    if (def.kind === 'toggle' && typeof value !== 'boolean') return { ok: false, reason: 'invalid value' };
    if (!opts.force) {
      const reason = this.blockedReason(id, value);
      if (reason) return { ok: false, reason };
    }
    if (this.values.get(id) === value) return { ok: true };
    this.values.set(id, value);
    if (!opts.silent) {
      this.save();
      events.emit('loadout:changed', { id, value });
    }
    return { ok: true };
  }

  /** Reset to defaults then apply a preset (conflicting entries are skipped). Challenge settings are kept. */
  applyPreset(presetId: string) {
    const p = Presets.find((x) => x.id === presetId);
    if (!p) return;
    for (const d of Upgrades) if (d.category !== 'challenge') this.values.set(d.id, d.default);
    for (const [id, v] of Object.entries(p.values)) this.set(id, v, { silent: true });
    this.save();
    for (const d of Upgrades) events.emit('loadout:changed', { id: d.id, value: this.values.get(d.id)! });
  }

  snapshot(): Record<string, LoadoutValue> {
    return Object.fromEntries(this.values);
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot()));
    } catch {
      /* storage unavailable — loadout just won't persist */
    }
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Record<string, LoadoutValue>;
      for (const [id, v] of Object.entries(data)) if (this.defs.has(id)) this.set(id, v, { silent: true, force: true });
    } catch {
      /* ignore corrupt / unavailable storage */
    }
  }
}

export const loadout = new Loadout();
