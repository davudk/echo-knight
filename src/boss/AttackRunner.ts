import { Vector3 } from 'three';
import { clamp } from '../core/math';
import type { Boss } from './Boss';
import type { Decal } from './Decals';
import { Difficulty } from './difficulty';
import {
  PLAYER_RADIUS, inArcBand, inCircle, inCone, inHeight, relAngle, segmentDistance,
} from './Hitboxes';
import type {
  AttackDef, AttackProgress, AttackStep, GrabBox, HitboxDef, MovePhase, MoveSeg, TelegraphKind,
} from './types';

/**
 * Plays one `AttackDef` on a boss: per step windup → active → recovery, with
 *  - animation retiming (the clip's `hitFrame` lands exactly on the active start),
 *  - movement segments (lunge / retreat / strafe / leap) and turn-rate-limited tracking,
 *  - telegraph glow + ground decals that fill up during the windup,
 *  - hitbox evaluation during the active window (cone, sweep, line, circle, ring, grab, projectile),
 *  - the grab hold → throw sub-sequence.
 * The boss owns one runner (`boss.runner`). Everything is data-driven from `types.ts`.
 */

const DEG = Math.PI / 180;
const DEFAULT_TRACK = { windup: 3.5, active: 0, recovery: 0.8 };
const DEFAULT_Y: Record<HitboxDef['shape'], [number, number]> = {
  cone: [-1, 2.6], sweep: [-1, 2.6], line: [-1, 2.6], circle: [-1, 2.2], ring: [-1, 99], grab: [-0.6, 1.0], projectile: [-1, 99],
};

interface BoxRt {
  def: HitboxDef;
  live: boolean;
  done: boolean;
  decal: Decal | null;
  /** locked centre (circle) */
  cx: number;
  cy: number;
  cz: number;
  /** previous sweep angle (rad, relative) */
  prevA: number;
  /** current line yaw (absolute) */
  yaw: number;
  tick: number;
  fired: number;
  centreLocked: boolean;
}

const tmp = new Vector3();

export class AttackRunner {
  def: AttackDef | null = null;
  stepIndex = 0;
  phase: MovePhase = 'windup';
  phaseTime = 0;
  /** scaled durations of the current step */
  windup = 0;
  active = 0;
  recovery = 0;
  private stepTime = 0;
  private readonly boxes: BoxRt[] = [];
  private nBoxes = 0;
  private grab: { box: GrabBox; t: number } | null = null;
  private leap: { seg: MoveSeg & { kind: 'leap' }; from: Vector3; to: Vector3 } | null = null;
  private progressView: AttackProgress | null = null;
  /** bitmask of `extraAnims` already started in this step */
  private extraFired = 0;

  constructor(private readonly boss: Boss) {}

  get running() {
    return this.def !== null;
  }
  get step(): AttackStep | null {
    return this.def ? this.def.steps[this.stepIndex] : null;
  }
  get isLastStep() {
    return !!this.def && this.stepIndex === this.def.steps.length - 1;
  }
  get grabbing() {
    return this.grab !== null;
  }
  /** colour of the current step's telegraph */
  get telegraph(): TelegraphKind {
    const s = this.step;
    return s?.telegraph ?? this.def?.telegraph ?? 'parryable';
  }
  /** parryable / unblockable flags of the current step (defaults from the telegraph colour) */
  get parryable() {
    const s = this.step;
    if (!s) return false;
    return s.parryable ?? this.telegraph === 'parryable';
  }
  get unblockable() {
    const s = this.step;
    if (!s) return false;
    return s.unblockable ?? this.telegraph === 'unblockable';
  }
  /** seconds until the current step turns active; Infinity when not winding up */
  get timeToActive() {
    if (!this.def || this.phase !== 'windup') return Infinity;
    return Math.max(0, this.windup - this.phaseTime);
  }

  get progress(): AttackProgress | null {
    if (!this.def) return null;
    const v = (this.progressView ??= {} as AttackProgress);
    v.def = this.def;
    v.stepIndex = this.stepIndex;
    v.step = this.def.steps[this.stepIndex];
    v.phase = this.phase;
    v.phaseTime = this.phaseTime;
    v.windup = this.windup;
    v.active = this.active;
    v.recovery = this.recovery;
    return v;
  }

  start(def: AttackDef) {
    this.cancel();
    this.def = def;
    this.enterStep(0);
  }

  /** Stop immediately (stagger, phase change, death). Releases decals and any grabbed player. */
  cancel() {
    for (let i = 0; i < this.nBoxes; i++) this.boxes[i].decal?.release(0.15);
    this.nBoxes = 0;
    if (this.grab) this.boss.releaseGrab(false);
    this.grab = null;
    this.leap = null;
    this.boss.kinematic = false;
    this.def = null;
  }

  // ------------------------------------------------------------------ steps
  private enterStep(i: number) {
    const def = this.def!;
    const step = def.steps[i];
    const last = i === def.steps.length - 1;
    this.stepIndex = i;
    this.phase = 'windup';
    this.phaseTime = 0;
    this.stepTime = 0;
    this.windup = step.windup * Difficulty.telegraph();
    this.active = step.active;
    this.recovery = last ? step.recovery * Difficulty.recovery() : step.recovery;
    this.leap = null;
    this.extraFired = 0;

    for (let k = 0; k < this.nBoxes; k++) this.boxes[k].decal?.release(0.12);
    this.nBoxes = 0;
    for (const hb of step.hitboxes) this.addBox(hb);

    const b = this.boss;
    if (step.anim) {
      const a = b.model.play(step.anim.clip, { fade: step.anim.fade ?? 0.12, loop: false, restart: true, startAt: step.anim.startAt ?? 0 });
      if (a) a.timeScale = 0; // the runner drives the clip time during the windup
    }
    b.beginTelegraph(def, i, this.telegraph, this.windup, step.flash !== false);
  }

  private addBox(def: HitboxDef) {
    let rt = this.boxes[this.nBoxes];
    if (!rt) this.boxes.push((rt = {} as BoxRt));
    this.nBoxes++;
    rt.def = def;
    rt.live = false;
    rt.done = false;
    rt.decal = null;
    rt.prevA = 0;
    rt.yaw = 0;
    rt.tick = 0;
    rt.fired = 0;
    rt.centreLocked = false;
    const tele = def.telegraph ?? this.telegraph;
    const wantsDecal = def.decal ?? (def.shape === 'circle' || def.shape === 'ring' || def.shape === 'line');
    if (wantsDecal) rt.decal = this.boss.game.bosses.decals.acquire().tint(tele);
    if (def.shape === 'circle' && (def.lockAt ?? 0) <= 0) this.lockCentre(rt);
    this.placeDecal(rt, 0);
  }

  /** Lock a circle's target point. */
  private lockCentre(rt: BoxRt) {
    const def = rt.def;
    if (def.shape !== 'circle') return;
    const b = this.boss;
    const f = b.facing;
    if (def.at === 'self' || (def.at === 'leap' && !this.leap)) {
      rt.cx = b.feet.x;
      rt.cz = b.feet.z;
    } else if (def.at === 'leap') {
      rt.cx = this.leap!.to.x;
      rt.cz = this.leap!.to.z;
    } else if (def.at === 'forward') {
      const d = def.distance ?? 2.5;
      rt.cx = b.feet.x + Math.sin(f) * d;
      rt.cz = b.feet.z + Math.cos(f) * d;
    } else {
      const p = b.game.player.position;
      const [ox, oz] = def.around ?? [0, 0];
      // around offsets are in boss space: x = boss's left, z = forward
      rt.cx = p.x + Math.cos(f) * ox + Math.sin(f) * oz;
      rt.cz = p.z - Math.sin(f) * ox + Math.cos(f) * oz;
    }
    rt.cy = b.game.world.groundAt(rt.cx, rt.cz, b.feet.y + 2);
    rt.centreLocked = true;
  }

  /** seconds from step start until this box goes live */
  private boxStart(rt: BoxRt) {
    return this.windup + (rt.def.delay ?? 0);
  }

  private placeDecal(rt: BoxRt, tA: number) {
    const d = rt.decal;
    if (!d) return;
    const def = rt.def;
    const b = this.boss;
    const f = b.facing;
    const y = b.feet.y;
    const fx = b.feet.x;
    const fz = b.feet.z;
    switch (def.shape) {
      case 'cone': {
        const o = def.offset ?? 0;
        d.sector(fx + Math.sin(f) * o, y, fz + Math.cos(f) * o, f, def.range, def.arc * DEG);
        break;
      }
      case 'grab':
        d.sector(fx, y, fz, f, def.range, def.arc * DEG);
        break;
      case 'sweep': {
        const mid = ((def.from + def.to) / 2) * DEG;
        d.sector(fx, y, fz, f + mid, def.range, Math.abs(def.to - def.from) * DEG + (def.width ?? 25) * DEG);
        break;
      }
      case 'line': {
        const o = def.offset ?? 0;
        const yaw = rt.live ? rt.yaw : f + (def.yawFrom ?? 0) * DEG;
        const span = Math.abs((def.yawTo ?? 0) - (def.yawFrom ?? 0));
        if (!rt.live && span > 1 && def.trackRate === undefined) {
          // a rotating beam: preview the whole swept area
          const mid = (((def.yawFrom ?? 0) + (def.yawTo ?? 0)) / 2) * DEG;
          d.sector(fx, y, fz, f + mid, def.length + o, span * DEG + 6 * DEG);
        } else {
          d.rect(fx + Math.sin(yaw) * o, y, fz + Math.cos(yaw) * o, yaw, def.length, def.width);
        }
        break;
      }
      case 'circle':
        // hidden until its centre is locked (lockAt > 0)
        d.alpha = rt.centreLocked ? 1 : 0;
        if (rt.centreLocked) d.circle(rt.cx, rt.cy, rt.cz, def.radius);
        break;
      case 'ring': {
        const o = def.at === 'forward' ? def.distance ?? 2 : 0;
        d.circle(fx + Math.sin(f) * o, y, fz + Math.cos(f) * o, Math.min(2.2, def.maxRadius));
        break;
      }
      case 'projectile':
        break;
    }
    void tA;
  }

  // ------------------------------------------------------------------ frame
  /** Returns true when the attack has finished. */
  update(dt: number): boolean {
    if (!this.def) return true;
    const b = this.boss;
    const step = this.def.steps[this.stepIndex];

    if (this.grab) {
      this.updateGrab(dt);
      return !this.def;
    }

    this.phaseTime += dt;
    this.stepTime += dt;

    // tracking (turn-rate limited)
    const tr = step.track ?? {};
    const rate = tr[this.phase] ?? b.def.trackRate?.[this.phase] ?? DEFAULT_TRACK[this.phase];
    if (rate > 0 && !b.game.player.dead && !this.leap) b.turnToward(b.game.player.position, rate, dt);

    this.updateMovement(step, dt);
    this.updateAnim(step);

    // glow: ramps during the windup, full while active, fades in recovery
    if (this.phase === 'windup') b.glow = clamp(this.phaseTime / Math.max(0.05, this.windup), 0, 1);
    else if (this.phase === 'active') b.glow = 1;

    // hitboxes / decals
    const tA = this.stepTime - this.windup; // time since active start (negative during windup)
    for (let i = 0; i < this.nBoxes; i++) {
      const rt = this.boxes[i];
      if (rt.done) continue;
      const start = this.boxStart(rt);
      if (!rt.live) {
        if (rt.def.shape === 'circle' && !rt.centreLocked && this.stepTime >= (rt.def.lockAt ?? 0) * this.windup) {
          this.lockCentre(rt);
          this.placeDecal(rt, tA);
        }
        if (rt.decal) {
          if (rt.def.shape !== 'circle') this.placeDecal(rt, tA);
          rt.decal.fill = clamp(this.stepTime / Math.max(0.05, start), 0, 1);
        }
        if (this.stepTime >= start) this.goLive(rt);
      }
      if (rt.live && !rt.done) {
        this.evaluate(rt, this.stepTime - start, dt);
        if (!this.def) return true; // cancelled by a parry reaction / death
        if (this.grab) return false;
      }
    }

    // phase transitions
    if (this.phase === 'windup' && this.phaseTime >= this.windup) {
      this.phase = 'active';
      this.phaseTime -= this.windup;
      const a = b.model.currentAction;
      if (a && step.anim) a.timeScale = step.anim.speed ?? 1;
      if (step.shake) b.game.cam.shake(step.shake);
      b.onStepActive(this.def, this.stepIndex);
    }
    if (this.phase === 'active' && this.phaseTime >= this.active) {
      this.phase = 'recovery';
      this.phaseTime -= this.active;
      b.onStepRecovery(this.def, this.stepIndex, this.isLastStep);
      if (!this.def) return true;
    }
    if (this.phase === 'recovery' && this.phaseTime >= this.recovery && this.allBoxesSettled()) {
      if (this.isLastStep) {
        this.cancel();
        return true;
      }
      this.enterStep(this.stepIndex + 1);
    }
    return false;
  }

  /** Rings and projectiles are handed off to BossEffects; everything else must be done. */
  private allBoxesSettled() {
    for (let i = 0; i < this.nBoxes; i++) {
      const rt = this.boxes[i];
      if (!rt.done && rt.live) {
        const dur = rt.def.duration ?? this.active;
        if (this.stepTime - this.boxStart(rt) < dur) return false;
      }
      if (!rt.live && !rt.done) return false;
    }
    return true;
  }

  private updateAnim(step: AttackStep) {
    const b = this.boss;
    const anim = step.anim;
    if (anim && this.phase === 'windup') {
      const a = b.model.currentAction;
      if (a && b.model.currentName === anim.clip) {
        const s = anim.startAt ?? 0;
        let u = clamp(this.phaseTime / Math.max(0.01, this.windup), 0, 1);
        if (anim.pacing === 'hold') u = u < 0.35 ? (u / 0.35) * 0.8 : u < 0.85 ? 0.8 : 0.8 + ((u - 0.85) / 0.15) * 0.2;
        a.time = s + (anim.hitFrame - s) * u;
        a.timeScale = 0;
      }
    }
    if (step.extraAnims) {
      for (let i = 0; i < step.extraAnims.length; i++) {
        const ex = step.extraAnims[i];
        if (ex.during !== this.phase || this.extraFired & (1 << i)) continue;
        const dur = this.phase === 'windup' ? this.windup : this.phase === 'active' ? this.active : this.recovery;
        if (this.phaseTime < (ex.at ?? 0) * dur) continue;
        this.extraFired |= 1 << i;
        b.model.play(ex.clip, { fade: ex.fade ?? 0.15, loop: ex.loop ?? false, speed: ex.speed ?? 1, startAt: ex.startAt ?? 0, restart: true });
      }
    }
  }

  // ------------------------------------------------------------------ movement
  private updateMovement(step: AttackStep, dt: number) {
    const b = this.boss;
    let moved = false;
    if (step.move) {
      const dur = this.phase === 'windup' ? this.windup : this.phase === 'active' ? this.active : this.recovery;
      const u = dur > 0 ? this.phaseTime / dur : 1;
      for (const seg of step.move) {
        if (seg.during !== this.phase) continue;
        const from = seg.from ?? 0;
        const to = seg.to ?? 1;
        const segDur = Math.max(0.02, (to - from) * dur);
        if (seg.kind === 'leap') {
          if (u >= from && !this.leap && u < to) this.startLeap(seg);
          if (this.leap && this.leap.seg === seg) {
            const lu = clamp((u - from) / Math.max(1e-3, to - from), 0, 1);
            const { from: p0, to: p1 } = this.leap;
            b.feet.x = p0.x + (p1.x - p0.x) * lu;
            b.feet.z = p0.z + (p1.z - p0.z) * lu;
            b.feet.y = p0.y + (p1.y - p0.y) * lu + seg.height * 4 * lu * (1 - lu);
            b.velocity.set(0, 0, 0);
            if (lu >= 1 || u >= to) {
              this.leap = null;
              b.kinematic = false;
              b.land();
            }
            moved = true;
          }
          continue;
        }
        if (u < from || u > to) continue;
        const speed = seg.distance / segDur;
        const f = b.forwardVec(tmp);
        if (seg.kind === 'lunge') {
          const stop = (seg.stopAt ?? 1.2) + b.radius;
          const pd = b.distanceToPlayer();
          const k = pd > stop ? 1 : 0;
          b.velocity.x = f.x * speed * k;
          b.velocity.z = f.z * speed * k;
        } else if (seg.kind === 'retreat') {
          b.velocity.x = -f.x * speed;
          b.velocity.z = -f.z * speed;
        } else if (seg.kind === 'strafe') {
          // + = boss's left; yaw grows to the left, so "left" is the forward vector rotated by +90°
          b.velocity.x = Math.sin(b.facing + Math.PI / 2) * speed;
          b.velocity.z = Math.cos(b.facing + Math.PI / 2) * speed;
        }
        moved = true;
      }
    }
    if (!moved) {
      const k = Math.exp(-12 * dt);
      b.velocity.x *= k;
      b.velocity.z *= k;
    }
  }

  private startLeap(seg: MoveSeg & { kind: 'leap' }) {
    const b = this.boss;
    const p = b.game.player.position;
    const from = b.feet.clone();
    let dx = p.x - from.x;
    let dz = p.z - from.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    const want = clamp(d - (seg.stopAt ?? 1.5) - b.radius * 0.5, 0, seg.maxDistance);
    dx = (dx / d) * want;
    dz = (dz / d) * want;
    const to = new Vector3(from.x + dx, 0, from.z + dz);
    b.clampToArena(to);
    to.y = b.game.world.groundAt(to.x, to.z, from.y + 2);
    b.facing = Math.atan2(p.x - from.x, p.z - from.z);
    b.kinematic = true;
    this.leap = { seg, from, to };
    b.onLeap(to);
  }

  // ------------------------------------------------------------------ hitboxes
  private goLive(rt: BoxRt) {
    rt.live = true;
    const def = rt.def;
    const b = this.boss;
    rt.prevA = def.shape === 'sweep' ? def.from * DEG : 0;
    rt.yaw = b.facing + ((def.shape === 'line' ? def.yawFrom ?? 0 : 0) * DEG);
    if (rt.decal) {
      rt.decal.fill = 1;
      rt.decal.flash = def.shape === 'line' ? 0.6 : 0.3;
      // cone / sweep / grab decals are pure telegraphs: fade out as the swing starts
      if (def.shape === 'cone' || def.shape === 'sweep' || def.shape === 'grab') {
        rt.decal.release(0.18);
        rt.decal = null;
      }
    }
    const step = this.step!;
    const tele = def.telegraph ?? this.telegraph;
    const dmg = def.damage ?? step.damage;
    const kb = def.knockback ?? step.knockback ?? 6;
    if (def.shape === 'ring') {
      const o = def.at === 'forward' ? def.distance ?? 2 : 0;
      tmp.set(b.feet.x + Math.sin(b.facing) * o, 0, b.feet.z + Math.cos(b.facing) * o);
      tmp.y = b.game.world.groundAt(tmp.x, tmp.z, b.feet.y + 1);
      b.game.bosses.effects.spawnRing({
        owner: b, origin: tmp, speed: def.speed, maxRadius: def.maxRadius, thickness: def.thickness, startRadius: def.startRadius,
        damage: dmg, knockback: kb, telegraph: tele,
      });
      b.game.fx.slam(tmp, Math.min(4, def.maxRadius * 0.3));
      rt.decal?.release(0.1);
      rt.decal = null;
      rt.done = true;
    } else if (def.shape === 'circle') {
      tmp.set(rt.cx, rt.cy, rt.cz);
      b.impactFx(tmp, def.radius, tele);
      const p = b.game.player.position;
      if (inCircle(rt.cx, rt.cz, def.radius, p.x, p.z) && inHeight(rt.cy, p.y, def.yMin ?? DEFAULT_Y.circle[0], def.yMax ?? DEFAULT_Y.circle[1])) {
        this.hit(rt, tmp);
      }
      rt.decal?.release(0.3);
      rt.decal = null;
      rt.done = true;
    }
  }

  private evaluate(rt: BoxRt, t: number, dt: number) {
    const def = rt.def;
    const b = this.boss;
    const p = b.game.player;
    const pp = p.position;
    const dur = def.duration ?? this.active;
    const u = dur > 0 ? clamp(t / dur, 0, 1) : 1;
    const [y0, y1] = DEFAULT_Y[def.shape];
    const okY = inHeight(b.feet.y, pp.y, def.yMin ?? y0, def.yMax ?? y1);
    const f = b.facing;

    switch (def.shape) {
      case 'cone': {
        const o = def.offset ?? 0;
        const ox = b.feet.x + Math.sin(f) * o;
        const oz = b.feet.z + Math.cos(f) * o;
        if (okY && !p.dead && inCone(ox, oz, f, def.range, def.arc, pp.x, pp.z)) this.hit(rt, b.feet);
        break;
      }
      case 'sweep': {
        const a = (def.from + (def.to - def.from) * u) * DEG;
        const w = ((def.width ?? 25) * DEG) / 2;
        const lo = Math.min(rt.prevA, a) - w;
        const hi = Math.max(rt.prevA, a) + w;
        rt.prevA = a;
        b.sweepFx(a, def.range);
        if (okY && !p.dead && inArcBand(b.feet.x, b.feet.z, f, lo, hi, def.inner ?? 0, def.range, pp.x, pp.z)) this.hit(rt, b.feet);
        break;
      }
      case 'line': {
        if (def.trackRate !== undefined) {
          const target = Math.atan2(pp.x - b.feet.x, pp.z - b.feet.z);
          const d = relAngle(0, 0, rt.yaw, Math.sin(target), Math.cos(target));
          rt.yaw += clamp(d, -def.trackRate * dt, def.trackRate * dt);
        } else {
          rt.yaw = f + ((def.yawFrom ?? 0) + ((def.yawTo ?? 0) - (def.yawFrom ?? 0)) * u) * DEG;
        }
        const o = def.offset ?? 0;
        const sx = b.feet.x + Math.sin(rt.yaw) * o;
        const sz = b.feet.z + Math.cos(rt.yaw) * o;
        if (rt.decal) {
          rt.decal.rect(sx, b.feet.y, sz, rt.yaw, def.length, def.width);
          rt.decal.fill = 1;
          rt.decal.flash = Math.max(rt.decal.flash, 0.5);
        }
        b.beamFx(sx, sz, rt.yaw, def.length, def.telegraph ?? this.telegraph);
        rt.tick -= dt;
        if (rt.tick <= 0 && okY && !p.dead && segmentDistance(sx, sz, rt.yaw, def.length, pp.x, pp.z) <= def.width / 2 + PLAYER_RADIUS) {
          tmp.set(sx, b.feet.y, sz);
          const res = this.hit(rt, tmp, def.tick === undefined);
          if (def.tick !== undefined && (res === 'hit' || res === 'blocked')) rt.tick = def.tick;
        }
        if (t >= dur) {
          rt.decal?.release(0.15);
          rt.decal = null;
          rt.done = true;
        }
        break;
      }
      case 'grab':
        if (okY && !p.dead && inCone(b.feet.x, b.feet.z, f, def.range, def.arc, pp.x, pp.z)) {
          const res = b.tryGrab(def);
          if (res === 'grabbed') {
            rt.done = true;
            this.grab = { box: def, t: 0 };
            if (def.holdClip) b.model.play(def.holdClip, { fade: 0.1, loop: true });
          } else if (res !== 'ignored') {
            rt.done = true;
          }
        }
        break;
      case 'projectile': {
        const n = def.count ?? 1;
        const iv = def.interval ?? 0;
        while (rt.fired < n && t >= rt.fired * iv) {
          b.fireProjectile(def, rt.fired, n, def.telegraph ?? this.telegraph, def.damage ?? this.step!.damage);
          rt.fired++;
        }
        if (rt.fired >= n) rt.done = true;
        break;
      }
      default:
        break;
    }
    if (!rt.done && (def.shape === 'cone' || def.shape === 'sweep' || def.shape === 'grab') && t >= dur) rt.done = true;
  }

  /** Deliver the current step's hit through the boss. `once` = the box is finished on any contact. */
  private hit(rt: BoxRt, from: Vector3, once = true) {
    const step = this.step!;
    const def = rt.def;
    const tele = def.telegraph ?? this.telegraph;
    const res = this.boss.hitPlayer({
      damage: def.damage ?? step.damage,
      knockback: def.knockback ?? step.knockback ?? 6,
      heavy: step.heavy ?? true,
      telegraph: tele,
      parryable: def.telegraph ? tele === 'parryable' : this.parryable,
      unblockable: def.telegraph ? tele === 'unblockable' : this.unblockable,
      from,
    });
    if (once && res !== 'dodged' && res !== 'ignored') rt.done = true;
    return res;
  }

  private updateGrab(dt: number) {
    const g = this.grab!;
    g.t += dt;
    this.boss.velocity.set(0, 0, 0);
    if (g.t >= g.box.hold) {
      this.grab = null;
      this.boss.throwGrabbed(g.box, this.step!.damage);
      if (g.box.throwClip) this.boss.model.play(g.box.throwClip, { fade: 0.08, loop: false, restart: true, speed: 1.2 });
      // straight to the recovery (punish window)
      this.phase = 'recovery';
      this.phaseTime = 0;
      for (let i = 0; i < this.nBoxes; i++) this.boxes[i].done = true;
      this.boss.onStepRecovery(this.def!, this.stepIndex, this.isLastStep);
    }
  }
}
