import { clamp, lerp } from '../core/math';
import type { Player } from '../player/Player';
import type { Boss } from './Boss';

/**
 * Boss AI director: decides WHAT to do between attacks and WHICH attack to use.
 *
 *  - per-phase attack lists with weights, range bands, angle / player-state conditions, cooldowns
 *  - combo follow-ups (chains with a probability) — every follow-up still has its own wind-up
 *  - never the same attack three times in a row (fairness rule #5)
 *  - idle behaviours between attacks: approach / strafe (circle) / back off / wait
 *  - aggression per phase (shorter gaps, more pressure)
 *  - punish logic: attacks reserved for when the player drinks a flask (or whiffs) in range
 *  - hooks: `boss.decide(ctx)` can override any decision (custom mechanics)
 */

export type AngleCond = 'front' | 'side' | 'behind' | 'any';
export type PlayerCond = 'grounded' | 'airborne' | 'above' | 'any';

export interface FollowUp {
  attack: string;
  /** 0..1 */
  chance: number;
  /** only if the player is within this distance band when the first attack's recovery starts */
  range?: [number, number];
}

export interface DirectorEntry {
  attack: string;
  weight: number;
  /** distance band boss feet → player feet, metres (default any) */
  range?: [number, number];
  /** where the player must be relative to the boss's facing (default 'front') */
  angle?: AngleCond;
  /** player state condition (default 'any'). above = the player stands ≥ 1.5 m higher */
  player?: PlayerCond;
  /** seconds before this entry can be used again (counted from its start) */
  cooldown?: number;
  followUps?: FollowUp[];
  /** never picked as an opener — only reachable as a follow-up or punish */
  followUpOnly?: boolean;
  /** custom condition */
  when?: (ctx: DirectorContext) => boolean;
}

export interface PhaseDirector {
  attacks: DirectorEntry[];
  /** 0 (patient) .. 1 (relentless). Default 0.5 */
  aggression?: number;
  /** idle gap between attacks [min, max] seconds; aggression picks inside it. Default [0.35, 2.0] */
  idleTime?: [number, number];
  /** comfortable distance band while idling. Default [3, 7] */
  preferredRange?: [number, number];
  /** attack ids used to punish a flask (player.state === 'heal') or a whiffed attack in range */
  punish?: { heal?: string[]; whiff?: string[]; reaction?: number };
}

export interface DirectorConfig {
  /** indexed by boss phase; a missing phase uses the last entry */
  phases: PhaseDirector[];
}

export interface DirectorContext {
  boss: Boss;
  player: Player;
  phase: number;
  /** horizontal distance feet → feet */
  dist: number;
  /** relative angle of the player from the boss's facing (rad, + = left) */
  angle: number;
  side: 'front' | 'side' | 'behind';
  airborne: boolean;
  above: boolean;
  healing: boolean;
  /** player in attack recovery (whiffed or not) */
  attacking: boolean;
  /** last attack ids, most recent last (up to 4) */
  history: readonly string[];
}

export type IdleMode = 'approach' | 'strafe' | 'backoff' | 'wait';

/** What `boss.decide()` may return to override the director. */
export type Decision =
  | { attack: string }
  | { idle: IdleMode; duration?: number; dir?: 1 | -1 }
  | null;

export class Director {
  readonly history: string[] = [];
  private readonly cooldowns = new Map<string, number>();
  idleMode: IdleMode = 'wait';
  strafeDir: 1 | -1 = 1;
  private idleTimer = 0.6;
  private modeTimer = 0;
  private punishTimer = -1;
  private readonly ctx = {} as DirectorContext;

  constructor(private readonly boss: Boss, readonly config: DirectorConfig) {}

  get phaseConfig(): PhaseDirector {
    const ph = this.config.phases;
    return ph[Math.min(this.boss.phase, ph.length - 1)];
  }

  get aggression() {
    return this.phaseConfig.aggression ?? 0.5;
  }

  reset() {
    this.history.length = 0;
    this.cooldowns.clear();
    this.idleTimer = 0.6;
    this.modeTimer = 0;
    this.punishTimer = -1;
  }

  /** Build the decision context (reused object). */
  context(): DirectorContext {
    const b = this.boss;
    const p = b.game.player;
    const c = this.ctx;
    c.boss = b;
    c.player = p;
    c.phase = b.phase;
    c.dist = Math.hypot(p.position.x - b.feet.x, p.position.z - b.feet.z);
    c.angle = b.angleTo(p.position);
    const a = Math.abs(c.angle);
    c.side = a < Math.PI / 3 ? 'front' : a > (Math.PI * 2) / 3 ? 'behind' : 'side';
    c.airborne = !p.grounded;
    c.above = p.position.y - b.feet.y > 1.5;
    c.healing = p.state === 'heal';
    c.attacking = p.attacking;
    c.history = this.history;
    return c;
  }

  tick(dt: number) {
    for (const [k, v] of this.cooldowns) {
      if (v - dt <= 0) this.cooldowns.delete(k);
      else this.cooldowns.set(k, v - dt);
    }
  }

  /** The boss just started `id` (from any source). */
  noteAttack(id: string) {
    this.history.push(id);
    if (this.history.length > 4) this.history.shift();
    const e = this.phaseConfig.attacks.find((x) => x.attack === id);
    if (e?.cooldown) this.cooldowns.set(id, e.cooldown);
  }

  /** An attack (and any chain) ended: schedule the next idle gap. */
  onAttackEnd() {
    const [lo, hi] = this.phaseConfig.idleTime ?? [0.35, 2.0];
    this.idleTimer = lerp(hi, lo, this.aggression) * (0.75 + Math.random() * 0.5);
    this.modeTimer = 0;
  }

  /** Called after a stagger / phase change etc: a short breather before acting. */
  delay(seconds: number) {
    this.idleTimer = Math.max(this.idleTimer, seconds);
  }

  // ------------------------------------------------------------------ selection
  private repeatsThird(id: string) {
    const h = this.history;
    const n = h.length;
    return n >= 2 && h[n - 1] === id && h[n - 2] === id;
  }

  private matches(e: DirectorEntry, c: DirectorContext, ignoreCooldown = false) {
    if (!this.boss.attacks.has(e.attack)) return false;
    if (!ignoreCooldown && this.cooldowns.has(e.attack)) return false;
    if (this.repeatsThird(e.attack)) return false;
    if (e.range && (c.dist < e.range[0] || c.dist > e.range[1])) return false;
    const ang = e.angle ?? 'front';
    if (ang !== 'any' && ang !== c.side) return false;
    const pc = e.player ?? 'any';
    if (pc === 'grounded' && c.airborne) return false;
    if (pc === 'airborne' && !c.airborne) return false;
    if (pc === 'above' && !c.above) return false;
    if (e.when && !e.when(c)) return false;
    return true;
  }

  /** Weighted pick among entries that fit right now (or null). */
  pick(c: DirectorContext, ids?: readonly string[]): string | null {
    let total = 0;
    const list = this.phaseConfig.attacks;
    for (const e of list) {
      if (ids ? !ids.includes(e.attack) : e.followUpOnly) continue;
      if (this.matches(e, c)) total += e.weight;
    }
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const e of list) {
      if (ids ? !ids.includes(e.attack) : e.followUpOnly) continue;
      if (!this.matches(e, c)) continue;
      r -= e.weight;
      if (r <= 0) return e.attack;
    }
    return null;
  }

  /** Roll the follow-ups of `id` (called when its last step's recovery starts). */
  pickFollowUp(id: string): string | null {
    const entry = this.phaseConfig.attacks.find((x) => x.attack === id);
    if (!entry?.followUps?.length) return null;
    const c = this.context();
    for (const f of entry.followUps) {
      if (Math.random() > f.chance) continue;
      if (f.range && (c.dist < f.range[0] || c.dist > f.range[1])) continue;
      if (!this.boss.attacks.has(f.attack) || this.repeatsThird(f.attack)) continue;
      return f.attack;
    }
    return null;
  }

  /** Is any opener usable at some distance? Used to decide whether to close in. */
  private maxRange(c: DirectorContext) {
    let m = 0;
    for (const e of this.phaseConfig.attacks) {
      if (e.followUpOnly || this.cooldowns.has(e.attack)) continue;
      const pc = e.player ?? 'any';
      if (pc === 'airborne' && !c.airborne) continue;
      if (pc === 'above' && !c.above) continue;
      m = Math.max(m, e.range ? e.range[1] : 99);
    }
    return m;
  }

  // ------------------------------------------------------------------ idle frame
  /** One idle frame: maybe start an attack, otherwise move. */
  update(dt: number) {
    const b = this.boss;
    const c = this.context();
    const cfg = this.phaseConfig;

    // 1. boss-specific override
    const o = b.decide(c);
    if (o) {
      if ('attack' in o) {
        b.startAttack(o.attack);
        return;
      }
      this.idleMode = o.idle;
      if (o.dir) this.strafeDir = o.dir;
      this.modeTimer = o.duration ?? 1;
    }

    // 2. punish a flask / a whiff in range (with a human reaction delay)
    const punishIds = c.healing ? cfg.punish?.heal : c.attacking ? cfg.punish?.whiff : undefined;
    if (punishIds?.length) {
      if (this.punishTimer < 0) this.punishTimer = cfg.punish?.reaction ?? 0.25;
      this.punishTimer -= dt;
      if (this.punishTimer <= 0) {
        const id = this.pick(c, punishIds);
        if (id) {
          this.punishTimer = -1;
          b.startAttack(id);
          return;
        }
      }
    } else {
      this.punishTimer = -1;
    }

    // 3. regular attack when the gap is over
    this.idleTimer -= dt;
    if (this.idleTimer <= 0 && !b.game.player.dead) {
      const id = this.pick(c);
      if (id) {
        b.startAttack(id);
        return;
      }
      this.idleTimer = 0.1; // nothing fits: keep repositioning, retry soon
    }

    // 4. idle movement
    this.modeTimer -= dt;
    if (this.modeTimer <= 0 && !o) this.chooseMode(c);
    b.idleMove(this.idleMode, this.strafeDir, c, dt);
  }

  private chooseMode(c: DirectorContext) {
    const cfg = this.phaseConfig;
    const [near, far] = cfg.preferredRange ?? [3, 7];
    const reach = this.maxRange(c);
    const ag = this.aggression;
    if (c.dist > Math.min(far, reach) || (this.idleTimer < 0.5 && c.dist > reach * 0.85)) {
      this.idleMode = 'approach';
      this.modeTimer = 0.4;
    } else if (c.dist < near) {
      this.idleMode = Math.random() < 0.5 ? 'backoff' : 'strafe';
      this.modeTimer = 0.6 + Math.random() * 0.5;
    } else {
      const r = Math.random();
      this.idleMode = r < 0.55 ? 'strafe' : r < 0.55 + 0.3 * ag ? 'approach' : 'wait';
      this.modeTimer = 0.7 + Math.random() * 0.9;
    }
    if (this.idleMode === 'strafe' && Math.random() < 0.4) this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    this.modeTimer = clamp(this.modeTimer, 0.2, 2);
  }
}
