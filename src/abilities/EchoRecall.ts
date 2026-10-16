import { Color, Vector3 } from 'three';
import { Tuning } from '../config/tuning';
import { events } from '../core/Events';
import { loadout } from '../core/Loadout';
import { lerp } from '../core/math';
import { Colors, type Fx } from '../fx/Fx';
import type { Input } from '../core/Input';
import type { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import type { Player } from '../player/Player';
import type { HitInfo, World } from '../world/World';
import { EchoInstance, MIMIC, type EchoBody } from './EchoInstance';

const E = Tuning.echo;

/** Echo-specific numbers (kept here so the echo stream doesn't touch config/tuning.ts). */
export const EchoTuning = {
  /** hold echo this long to recall while the stack still has room */
  holdToRecall: 0.3,
  /** lockout after a recall when stacking (count > 1); count 1 uses Tuning.echo.cooldown */
  stackRecallLock: 0.35,
  /** swap refreshes the echo's remaining time to at least this fraction */
  swapRefresh: 0.6,
  /** rewind: path sampling rate and travel time */
  sampleInterval: 0.05,
  maxSamples: 320,
  rewindTime: 0.35,
  shockwave: { radius: 3.2, damage: 14, knockback: 8 },
};

export type EchoState = 'ready' | 'active' | 'cooldown';
export type RecallMode = 'teleport' | 'swap' | 'rewind';

interface Sample {
  x: number;
  y: number;
  z: number;
  facing: number;
}

interface Rewind {
  echo: EchoInstance;
  from: Vector3;
  points: Vector3[];
  facings: number[];
  /** cumulative arc length at each point */
  cum: number[];
  total: number;
  duration: number;
  t: number;
  afterimage: number;
}

/** Known hit timings for the base moves (seconds after the attack starts). */
const HIT_AT: Record<string, number> = {
  light1: Tuning.combo.steps[0].hitAt,
  light2: Tuning.combo.steps[1].hitAt,
  light3: 0.48,
  plunge: 0.3,
};
/** Attack move id → the move id its damage is reported under. */
const HIT_MOVE: Record<string, string> = { light3: 'slam' };
/** Moves the mimic replays as a ground AoE rather than a cone. */
const AOE_MOVES = new Set(['light3', 'plunge', 'slam']);

/**
 * Echo: leave holographic copies of yourself and recall to them.
 *
 * Loadout (read live):
 *  - echo.aerial   place mid-air (otherwise grounded only — a mid-air press fizzles)
 *  - echo.count    stack size 1–3, first in last out
 *  - echo.recall   teleport | swap | rewind
 *  - echo.body     phantom | platform (solid) | mimic (repeats your attacks)
 *  - echo.refresh  recall restores air jumps + air dashes
 *  - echo.shockwave  AoE on arrival
 *  - echo.duration lifetime of each echo
 *
 * Input: tap = place while the stack has room, recall when it's full.
 * Hold (≥ 0.3 s) = recall the most recent echo even if the stack isn't full.
 */
export class EchoRecall {
  /** active echoes, oldest first (top of the stack = last) */
  readonly stack: EchoInstance[] = [];
  private readonly pool: EchoInstance[] = [];
  /** lockout after a recall / expiry (HUD shows it as cooldown) */
  lock = 0;
  private lockMax = 1;
  private sinceAction = 99;
  private time = 0;
  private pending = false;
  private queued = 0;
  private rewind: Rewind | null = null;

  // path recording (rewind)
  private readonly samples: Sample[] = [];
  /** absolute index of samples[0] */
  private sampleBase = 0;
  private sampleTimer = 0;

  /** last damage the player's own moves dealt (mimic scales it) */
  private readonly lastDamage = new Map<string, number>();

  constructor(
    private readonly player: Player,
    private readonly world: World,
    private readonly fx: Fx,
    private readonly cam: ThirdPersonCamera,
    private readonly input: Input,
    private readonly hitstop: (d: number) => void = () => {},
  ) {
    for (let i = 0; i < 3; i++) {
      const e = new EchoInstance(player, world, fx);
      e.onSwingHit = (echo, origin, facing, swing) => this.mimicHit(echo, origin, facing, swing);
      this.pool.push(e);
    }
    this.installRewindState();

    events.on('player:attack', (a) => {
      const hitAt = HIT_AT[a.move] ?? (a.heavy ? 0.36 : 0.2);
      for (const e of this.stack) e.mimic(a, hitAt);
    });
    events.on('player:hit', ({ info, move }) => {
      if (info.source !== 'echo') this.lastDamage.set(move, info.damage);
    });
    events.on('loadout:changed', ({ id }) => {
      if (id === 'echo.body' || id === 'echo.count') this.dissolveAll();
    });
  }

  // ---------------------------------------------------------------- HUD compat
  get count() {
    return loadout.num('echo.count');
  }
  get top(): EchoInstance | null {
    return this.stack[this.stack.length - 1] ?? null;
  }
  get state(): EchoState {
    if (this.stack.length) return 'active';
    return this.lock > 0 ? 'cooldown' : 'ready';
  }
  /** 0..1: top echo's remaining lifetime when active, cooldown progress otherwise. */
  get progress() {
    const t = this.top;
    if (t) return t.life / t.maxLife;
    if (this.lock > 0) return 1 - this.lock / this.lockMax;
    return 1;
  }
  get timer() {
    return this.top ? this.top.life : Math.max(0, this.lock);
  }
  get position() {
    return this.top?.position ?? this.player.position;
  }
  get rewinding() {
    return this.rewind !== null;
  }
  /** cooldown progress 0..1 (1 = ready) */
  get lockProgress() {
    return this.lock > 0 ? 1 - this.lock / this.lockMax : 1;
  }

  // ---------------------------------------------------------------- frame
  update(dt: number) {
    this.time += dt;
    this.sinceAction += dt;
    if (this.lock > 0) this.lock -= dt;
    this.record(dt);
    this.handleInput(dt);

    for (const e of [...this.stack]) {
      if (!e.update(dt, this.time)) this.expire(e);
    }
  }

  private get busy() {
    return this.lock > 0 || this.rewind !== null || this.player.dead;
  }

  private handleInput(dt: number) {
    const input = this.input;
    if (input.pressed('echo')) {
      if (!this.busy) this.onPress();
      else if (!this.rewind && this.lock < 0.2) this.queued = 0.2; // buffer a press just before the lock ends
    } else if (this.queued > 0) {
      this.queued -= dt;
      if (!this.busy) {
        this.queued = 0;
        this.onPress();
      }
    }

    if (this.pending) {
      if (input.heldFor('echo') >= EchoTuning.holdToRecall) {
        this.pending = false;
        this.recall();
      } else if (!input.held('echo')) {
        this.pending = false;
        this.place();
      }
    }
  }

  /** Tap: place if empty; recall if full; otherwise wait — release = place, hold = recall. */
  private onPress() {
    const n = this.stack.length;
    if (n === 0) this.place();
    else if (n >= this.count) this.recall();
    else if (this.input.held('echo')) this.pending = true;
    else this.place(); // buffered press that was already released
  }

  // ---------------------------------------------------------------- place
  private place() {
    const p = this.player;
    if (this.busy || this.stack.length >= this.count) return;
    if (!p.grounded && !loadout.has('echo.aerial')) return this.fizzle('grounded only');

    const e = this.pool.find((x) => !x.active && !this.stack.includes(x));
    if (!e) return;
    e.place(loadout.str('echo.body') as EchoBody, loadout.num('echo.duration'), this.sampleBase + this.samples.length);
    this.stack.push(e);
    this.sinceAction = 0;
    this.pushSample(); // the path back always ends exactly at the echo

    this.fx.echoBurst(e.chest, 36, 3);
    this.fx.waves.spawn(e.position.clone().setY(this.world.groundAt(e.position.x, e.position.z, e.position.y + 0.1) + 0.05), 2.2, Colors.echo, 0.4, 0.2);
    events.emit('echo:placed', { position: e.position.clone(), index: this.stack.length - 1 });
  }

  private fizzle(reason: string) {
    const p = this.player.position.clone().setY(this.player.position.y + 1);
    this.fx.sparks.emit({
      count: 10, position: p, spread: 0.3, speed: 1.6, upBias: -0.2,
      life: [0.2, 0.4], size: [0.03, 0.07], color: new Color(0.35, 0.55, 0.7), gravity: 6, drag: 3,
    });
    events.emit('echo:fizzle', { position: p, reason });
  }

  // ---------------------------------------------------------------- recall
  private recall() {
    const e = this.top;
    if (!e || this.busy || this.sinceAction < E.armDelay) return;
    const mode = loadout.str('echo.recall') as RecallMode;
    if (mode === 'swap') return this.swap(e);
    if (mode === 'rewind') return this.startRewind(e);

    const from = this.player.position.clone();
    this.fx.afterimage(0.4, Colors.echo);
    this.fx.streak(from, e.position);
    this.fx.echoBurst(from.clone().setY(from.y + 1), 24, 2);
    this.pop(e);
    this.arrive(e.position.clone(), e.facing, from, 'teleport');
    e.hide();
  }

  private swap(e: EchoInstance) {
    const p = this.player;
    const from = p.position.clone();
    const fromFacing = p.facing;
    const to = e.position.clone();
    const toFacing = e.facing;
    this.fx.streak(from, to);
    this.fx.streak(to, from);
    // The echo takes your current pose at your old spot; you take its place.
    e.setSolid(false);
    e.capture(from, fromFacing);
    e.life = Math.max(e.life, e.maxLife * EchoTuning.swapRefresh);
    e.sampleIndex = this.sampleBase + this.samples.length;
    this.fx.echoBurst(e.chest, 30, 3);
    this.arrive(to, toFacing, from, 'swap', E.cooldown);
  }

  private startRewind(e: EchoInstance) {
    const p = this.player;
    const from = p.position.clone();
    // Path: now → recorded samples (newest first) → the echo.
    const pts: Vector3[] = [from.clone()];
    const fac: number[] = [p.facing];
    const startIdx = Math.max(0, e.sampleIndex - this.sampleBase);
    for (let i = this.samples.length - 1; i >= startIdx; i--) {
      const s = this.samples[i];
      pts.push(new Vector3(s.x, s.y, s.z));
      fac.push(s.facing);
    }
    pts.push(e.position.clone());
    fac.push(e.facing);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];

    e.pinned = true;
    e.setSolid(false);
    this.rewind = {
      echo: e, from, points: pts, facings: fac, cum, total, t: 0, afterimage: 0,
      duration: Math.min(0.55, Math.max(EchoTuning.rewindTime, 0.25 + total * 0.01)),
    };
    // Trail of light along the route.
    const step = Math.max(1, Math.floor(pts.length / 60));
    for (let i = 0; i < pts.length; i += step) {
      this.fx.sparks.emit({
        count: 2, position: pts[i].clone().setY(pts[i].y + 1), spread: 0.15, speed: 0.4,
        life: [0.35, 0.7], size: [0.06, 0.12], color: Colors.echoParticle, color2: Colors.echoParticle2, drag: 3,
      });
    }
    this.fx.echoBurst(from.clone().setY(from.y + 1), 24, 2);
    this.sinceAction = 0;
    p.go('echo-rewind');
  }

  private installRewindState() {
    this.player.registerState('echo-rewind', {
      enter: (p) => {
        p.invulnerable = true;
        p.velocity.set(0, 0, 0);
        if (p.trail) p.trail.active = false;
        p.model.play('Jump_Idle', { fade: 0.08 });
      },
      update: (p, dt) => this.updateRewind(p, dt),
      exit: () => {
        // Interrupted (death, forced state): keep the echo where it was.
        if (this.rewind) {
          this.rewind.echo.pinned = false;
          this.rewind = null;
        }
      },
      visual: (p, o) => {
        o.pitch = -0.12;
        o.lift = 0.1 * Math.sin(Math.min(1, p.stateTime / 0.35) * Math.PI);
      },
    });
  }

  private updateRewind(p: Player, dt: number) {
    const r = this.rewind;
    if (!r) return p.goFree();
    p.invulnerable = true;
    p.gravityScale = 0;
    p.velocity.set(0, 0, 0);
    r.t += dt;
    const k = Math.min(1, r.t / r.duration);
    // ease in-out so departure and arrival read clearly
    const e = k * k * (3 - 2 * k);
    const d = e * r.total;
    let i = 1;
    while (i < r.cum.length - 1 && r.cum[i] < d) i++;
    const seg = r.cum[i] - r.cum[i - 1];
    const f = seg > 1e-5 ? (d - r.cum[i - 1]) / seg : 1;
    p.position.lerpVectors(r.points[i - 1], r.points[i], f);
    p.facing = lerpAngle(r.facings[i - 1], r.facings[i], f);

    r.afterimage -= dt;
    if (r.afterimage <= 0) {
      r.afterimage = 0.03;
      p.model.root.position.copy(p.position);
      p.model.root.rotation.y = p.facing;
      this.fx.afterimage(0.32, Colors.echo);
    }
    if (k >= 1) this.finishRewind();
  }

  private finishRewind() {
    const r = this.rewind!;
    this.rewind = null;
    const e = r.echo;
    e.pinned = false;
    // Forget the path walked after this echo was placed (it has been retraced).
    const keep = Math.max(0, e.sampleIndex - this.sampleBase);
    this.samples.length = Math.min(this.samples.length, keep);
    this.pop(e);
    this.arrive(e.position.clone(), e.facing, r.from, 'rewind');
    e.hide();
  }

  private pop(e: EchoInstance) {
    const i = this.stack.indexOf(e);
    if (i >= 0) this.stack.splice(i, 1);
    e.setSolid(false);
  }

  /** Common arrival: move the player, effects, shockwave, event, lockout. */
  private arrive(to: Vector3, facing: number, from: Vector3, mode: RecallMode, lock?: number) {
    this.player.teleport(to, facing, { refresh: loadout.has('echo.refresh') });
    const at = this.player.position.clone();
    this.fx.echoBurst(at.clone().setY(at.y + 1), 50, 5);
    this.cam.kickFov(9);
    this.cam.shake(0.15);
    if (loadout.has('echo.shockwave')) this.shockwave(at);
    else {
      const g = this.world.groundAt(at.x, at.z, at.y + 0.1);
      this.fx.waves.spawn(new Vector3(at.x, g + 0.05, at.z), 3, Colors.echo, 0.45, 0.25);
    }
    this.sinceAction = 0;
    this.setLock(lock ?? (this.count > 1 ? EchoTuning.stackRecallLock : E.cooldown));
    events.emit('echo:recalled', { from, to: at, mode });
  }

  private setLock(v: number) {
    this.lock = v;
    this.lockMax = Math.max(0.01, v);
  }

  private shockwave(at: Vector3) {
    const S = EchoTuning.shockwave;
    const center = at.clone();
    const ground = this.world.groundAt(at.x, at.z, at.y + 0.1);
    this.fx.waves.spawn(new Vector3(at.x, ground + 0.08, at.z), S.radius, Colors.echo, 0.4, 0.22);
    this.fx.waves.spawn(new Vector3(at.x, at.y + 0.9, at.z), S.radius * 0.8, Colors.echoParticle2, 0.3, 0.12);
    this.fx.sparks.emit({
      count: 40, position: center.clone().setY(at.y + 0.6), spread: 0.4, speed: 8, flat: true, upBias: 0.2,
      life: [0.25, 0.5], size: [0.05, 0.12], color: Colors.echoParticle, color2: Colors.echoParticle2, drag: 4,
    });
    this.cam.shake(0.3);
    events.emit('echo:shockwave', { position: center.clone(), radius: S.radius });
    const hits = this.world.querySphere(center, S.radius);
    for (const h of hits) {
      const dir = new Vector3(h.position.x - center.x, 0, h.position.z - center.z);
      if (dir.lengthSq() < 1e-4) dir.set(Math.sin(this.player.facing), 0, Math.cos(this.player.facing));
      dir.normalize();
      const info: HitInfo = {
        damage: S.damage, dir, knockback: S.knockback, heavy: true, source: 'echo', move: 'echo-shockwave',
      };
      h.onHit(info);
      events.emit('player:hit', { target: h, info, move: 'echo-shockwave' });
    }
    if (hits.length) this.hitstop(Tuning.feel.hitstop);
  }

  // ---------------------------------------------------------------- expire / dissolve
  private expire(e: EchoInstance) {
    this.fx.echoBurst(e.chest, 30, 1.5);
    this.pop(e);
    e.hide();
    events.emit('echo:expired', { position: e.position.clone() });
    if (!this.stack.length && this.count === 1) this.setLock(E.cooldown);
  }

  /** Quietly remove every echo (loadout changed). */
  dissolveAll() {
    for (const e of [...this.stack]) {
      if (e.pinned) continue;
      this.fx.echoBurst(e.chest, 20, 1.2);
      this.pop(e);
      e.hide();
    }
    this.pending = false;
  }

  // ---------------------------------------------------------------- mimic
  private mimicHit(echo: EchoInstance, origin: Vector3, facing: number, swing: { move: string; heavy: boolean }) {
    const base = this.lastDamage.get(HIT_MOVE[swing.move] ?? swing.move) ?? (swing.heavy ? 22 : 12);
    const damage = Math.max(1, Math.round(base * MIMIC.damageScale));
    const aoe = swing.heavy || AOE_MOVES.has(swing.move);
    const fwd = new Vector3(Math.sin(facing), 0, Math.cos(facing));
    let hits;
    if (aoe) {
      const ground = this.world.groundAt(echo.position.x, echo.position.z, echo.position.y + 0.1);
      const c = new Vector3(echo.position.x, ground, echo.position.z).addScaledVector(fwd, 0.8);
      this.fx.waves.spawn(c.clone().setY(ground + 0.06), 3, Colors.echo, 0.4, 0.18);
      hits = this.world.querySphere(c, 3);
    } else {
      hits = this.world.queryCone(origin, fwd, 2.8, 150);
    }
    for (const h of hits) {
      const dir = new Vector3(h.position.x - origin.x, 0, h.position.z - origin.z);
      if (dir.lengthSq() < 1e-4) dir.copy(fwd);
      dir.normalize();
      const info: HitInfo = {
        damage, dir, knockback: aoe ? 6 : 2.5, heavy: aoe, source: 'echo', move: `echo-${swing.move}`,
      };
      h.onHit(info);
      events.emit('player:hit', { target: h, info, move: info.move! });
      // echo-coloured hit sparks
      const sp = h.position.clone().setY(h.position.y + 1).addScaledVector(dir, -0.3);
      this.fx.sparks.emit({
        count: 18, position: sp, spread: 0.1, velocity: dir.clone().negate().setY(0.3).multiplyScalar(4), speed: 6,
        life: [0.15, 0.4], size: [0.05, 0.11], color: Colors.echoParticle, color2: Colors.echoParticle2, gravity: 10, drag: 4,
      });
    }
    if (hits.length) {
      this.hitstop(Tuning.feel.hitstop * 0.5);
      this.cam.shake(0.12);
    }
  }

  // ---------------------------------------------------------------- path recording
  private record(dt: number) {
    if (this.rewind) return;
    this.sampleTimer -= dt;
    if (this.sampleTimer > 0) return;
    this.sampleTimer = EchoTuning.sampleInterval;
    this.pushSample();
  }

  private pushSample() {
    const p = this.player;
    this.samples.push({ x: p.position.x, y: p.position.y, z: p.position.z, facing: p.facing });
    const over = this.samples.length - EchoTuning.maxSamples;
    if (over > 0) {
      this.samples.splice(0, over);
      this.sampleBase += over;
    }
  }
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return lerp(a, a + d, t);
}
