import {
  Box3,
  Color,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
} from 'three';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import { angleDelta, clamp } from '../core/math';
import type { CharacterModel } from '../player/CharacterModel';
import type { HitResult } from '../player/Player';
import type { HitInfo, Hittable } from '../world/World';
import type { BossArena } from './Arena';
import { AttackRunner } from './AttackRunner';
import { TelegraphColors } from './Decals';
import { Difficulty } from './difficulty';
import { Director, type Decision, type DirectorConfig, type DirectorContext, type IdleMode } from './Director';
import { escapePlayer, probeDefenses, throwPlayer } from './grab';
import type { BossHitSpec, EffectOwner } from './Hitboxes';
import type { AttackDef, GrabBox, ParryReaction, ProjectileBox, TelegraphKind } from './types';

// ====================================================================== definition
export interface PhaseDef {
  /** HP fraction at (or below) which this phase starts. Phase 0 uses 1. */
  threshold: number;
  name?: string;
  /** the transition beat: roar / kneel, invulnerable, camera shake */
  transition?: { duration?: number; clip?: string; speed?: number; startAt?: number; shake?: number };
}

export interface BossAnims {
  idle: string;
  walk: string;
  run: string;
  strafeLeft: string;
  strafeRight: string;
  back: string;
  /** engage roar + default phase transition */
  roar: string;
  /** poise break / parry stagger */
  stagger: string;
  /** short flinch (recoil after a parry / counter) */
  recoil: string;
  /** knocked down by a riposte (played from the start, ends standing) */
  knockdown: string;
  death: string;
}

export interface BossDef {
  id: string;
  name: string;
  /** optional subtitle under the HUD name */
  title?: string;
  maxHealth: number;
  /** body radius (collision, hit queries, lock-on) */
  radius: number;
  /** model height in metres (the player is 1.85) — used for the lock-on point and FX */
  height: number;
  phases: PhaseDef[];
  poise: {
    max: number;
    /** poise lost per second once `regenDelay` passed without poise damage */
    regen: number;
    regenDelay: number;
    /** poise damage per point of HP damage (heavies ×1.5) */
    damageMul?: number;
    /** stagger duration when poise breaks */
    staggerTime: number;
    /** damage multiplier while staggered */
    vulnerableMul: number;
  };
  /** poise damage of a parried swing / a counter (defaults 30 / 40) */
  parryPoise?: number;
  counterPoise?: number;
  /** default reaction when a step is parried */
  onParry?: ParryReaction;
  /** riposte / execution finisher during a stagger */
  riposte: { damage: number; range?: number; arcDeg?: number; knockdown?: number };
  speeds: { walk: number; run: number; strafe: number; back: number; /** rad/s */ turn: number };
  /** default turn rates during attack phases (rad/s), overridden per step by `track` */
  trackRate?: { windup?: number; active?: number; recovery?: number };
  anims: BossAnims;
  attacks: AttackDef[];
  director: DirectorConfig;
  /** HP damage multiplier for echo (mimic / shockwave) hits, default 0.6 */
  echoDamageMul?: number;
  /** body tint (multiplies the model's colours), eye colour at rest */
  tint?: Color;
  eyeColor?: Color;
  /** node name of the weapon mesh that glows during telegraphs (e.g. '2H_Sword') */
  weapon?: string;
  /** roar length when the fight starts */
  introTime?: number;
  /** without an arena: engage when the player comes this close */
  aggroRange?: number;
  /** recovery time before a follow-up attack chains in (s) */
  chainDelay?: number;
}

export type BossState =
  | 'dormant' | 'intro' | 'idle' | 'attack' | 'recoil' | 'stagger' | 'knockdown' | 'transition' | 'dead' | 'custom';

const HIT_FLASH = new Color(1.0, 0.85, 0.75);
const EYE_DAZED = new Color(1.6, 1.3, 0.3);
const tmp = new Vector3();
const tmp2 = new Vector3();
const tmpC = new Color();

/**
 * Boss base class. Subclass it (see sentinel/Sentinel.ts) and pass a `BossDef`; override the
 * hooks (`onPhaseEnter`, `decide`, `onUpdate`, ...) for special mechanics.
 *
 * Implements Hittable (player attacks, lock-on), the counter-threat interface (counter style),
 * and EffectOwner (rings / projectiles).
 */
export class Boss implements Hittable, EffectOwner {
  readonly id: string;
  readonly name: string;
  readonly position = new Vector3();
  readonly feet = new Vector3();
  readonly velocity = new Vector3();
  readonly radius: number;
  readonly lockable = true;
  alive = true;
  airborne = false;
  grounded = true;
  /** the runner drives the position directly (leaps) */
  kinematic = false;
  facing = 0;

  maxHealth: number;
  health: number;
  phase = 0;
  poise = 0;
  state: BossState = 'dormant';
  stateTime = 0;
  stateDur = 0;
  engaged = false;
  invulnerable = false;
  /** staggered and open to a riposte */
  riposteOpen = false;
  vulnerable = false;
  lastHitAt = -99;
  /** telegraph glow 0..1 and its colour class */
  glow = 0;
  glowKind: TelegraphKind = 'parryable';

  readonly home = new Vector3();
  homeFacing = 0;
  arena: BossArena | null = null;
  readonly runner: AttackRunner;
  readonly director: Director;
  readonly attacks = new Map<string, AttackDef>();

  private sincePoiseDamage = 99;
  private pendingChain: string | null = null;
  private flash = 0;
  private deadTime = 0;
  private fade = 1;
  private readonly bodyMats: MeshStandardMaterial[] = [];
  private readonly weaponMats: MeshStandardMaterial[] = [];
  private readonly eyeMat = new MeshBasicMaterial({ color: new Color(1.6, 0.15, 0.05), toneMapped: false });
  private readonly eyeIdle: Color;
  readonly weaponNode: Object3D | null;

  constructor(
    readonly game: Game,
    readonly def: BossDef,
    readonly model: CharacterModel,
  ) {
    this.id = def.id;
    this.name = def.name;
    this.radius = def.radius;
    this.maxHealth = Math.round(def.maxHealth * Difficulty.bossHealth());
    this.health = this.maxHealth;
    for (const a of def.attacks) this.attacks.set(a.id, a);
    this.runner = new AttackRunner(this);
    this.director = new Director(this, def.director);
    this.eyeIdle = def.eyeColor ?? new Color(1.6, 0.15, 0.05);

    // Per-instance materials so flashes / glow don't leak to other characters.
    const cache = new Map<Material, MeshStandardMaterial>();
    this.weaponNode = def.weapon ? model.model.getObjectByName(def.weapon) ?? null : null;
    const weaponMeshes = new Set<Object3D>();
    this.weaponNode?.traverse((o) => weaponMeshes.add(o));
    model.model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const src = m.material as MeshStandardMaterial;
      const isWeapon = weaponMeshes.has(m);
      if (isWeapon) {
        const wm = src.clone();
        wm.emissive = new Color(0, 0, 0);
        m.material = wm;
        this.weaponMats.push(wm);
        return;
      }
      let mat = cache.get(src);
      if (!mat) {
        mat = src.clone();
        if (def.tint) mat.color.multiply(def.tint);
        mat.emissive = new Color(0, 0, 0);
        cache.set(src, mat);
      }
      m.material = mat;
    });
    this.bodyMats.push(...cache.values());
    this.addEyes();
    game.scene.add(model.root);
    model.root.visible = false;
  }

  /** Two glowing eyes on the head bone (telegraph colour while winding up). */
  private addEyes() {
    const scene = this.model.model;
    const headBone = scene.getObjectByName('head');
    let headMesh: Object3D | undefined;
    scene.traverse((o) => {
      if (!headMesh && (o as Mesh).isMesh && /_Head/.test(o.name) && o.visible) headMesh = o;
    });
    if (!headBone || !headMesh) return;
    scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(headMesh);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const geo = new SphereGeometry(size.x * 0.07, 8, 6);
    const ws = headBone.getWorldScale(new Vector3());
    const ss = scene.getWorldScale(new Vector3());
    for (const side of [-1, 1]) {
      const eye = new Mesh(geo, this.eyeMat);
      const wp = new Vector3(center.x + side * size.x * 0.17, center.y - size.y * 0.02, box.max.z - size.z * 0.06);
      headBone.worldToLocal(wp);
      eye.position.copy(wp);
      eye.scale.setScalar(ss.x / ws.x);
      headBone.add(eye);
    }
  }

  // ==================================================================== hooks (override)
  /** A new phase began (after `phase` was updated). Change attacks, arena, music... */
  protected onPhaseEnter(_phase: number): void {}
  /** The fight started. */
  protected onEngage(): void {}
  /** The fight was reset (player died / left). Undo arena changes here. */
  protected onReset(): void {}
  /** HP hit 0 (death animation is running). */
  protected onDefeated(): void {}
  /** Every frame while alive (after the state machine). */
  protected onUpdate(_dt: number): void {}
  /** Custom state frame (`setCustom(...)`): your own special mechanics (teleports, climbs, ...). */
  protected onCustomState(_dt: number): void {}
  /** An attack step turned active / started its recovery (sounds, spawns, arena events). */
  protected onAttackStep(_attack: AttackDef, _step: number, _phase: 'active' | 'recovery'): void {}
  /**
   * Override the director: return `{ attack }` to force an attack, `{ idle }` to choose movement,
   * or null to let the director decide. Called every idle frame.
   */
  decide(_ctx: DirectorContext): Decision {
    return null;
  }

  // ==================================================================== queries
  forwardVec(out: Vector3) {
    return out.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  distanceToPlayer() {
    const p = this.game.player.position;
    return Math.hypot(p.x - this.feet.x, p.z - this.feet.z);
  }

  /** Signed yaw from our facing to a point (rad, + = left). */
  angleTo(pos: Vector3) {
    return angleDelta(this.facing, Math.atan2(pos.x - this.feet.x, pos.z - this.feet.z));
  }

  get dead() {
    return this.state === 'dead';
  }

  /** Winding up any attack (UI). */
  get telegraphing() {
    return this.state === 'attack' && this.runner.phase === 'windup';
  }

  /**
   * Counter style: a COUNTERABLE swing is coming (gold / parryable steps only — magic and
   * unblockable attacks can't be countered). Read by player/states/defense.ts.
   */
  get attacking() {
    return this.state === 'attack' && this.runner.phase === 'windup' && this.runner.parryable && !this.runner.unblockable &&
      this.runner.telegraph === 'parryable' && !this.runner.grabbing;
  }

  /** Seconds until the current swing's active frame; Infinity when not winding up. */
  get attackTimeRemaining() {
    return this.state === 'attack' ? this.runner.timeToActive : Infinity;
  }

  get healthFrac() {
    return this.health / this.maxHealth;
  }

  // ==================================================================== placement / lifecycle
  /** Set the home spot (reset returns here). */
  placeAt(x: number, z: number, facing = 0) {
    this.home.set(x, this.game.world.groundAt(x, z), z);
    this.homeFacing = facing;
    this.feet.copy(this.home);
    this.facing = facing;
    this.velocity.set(0, 0, 0);
    this.syncPosition();
    this.model.root.visible = true;
    if (this.state === 'dormant') this.go('dormant');
  }

  /** Start the fight (arena / aggro calls this). */
  engage() {
    if (this.engaged || !this.alive) return;
    this.engaged = true;
    this.maxHealth = Math.round(this.def.maxHealth * Difficulty.bossHealth());
    this.health = this.maxHealth;
    this.go('intro', this.def.introTime ?? 1.6);
    this.model.play(this.def.anims.roar, { fade: 0.2, loop: false, restart: true });
    this.game.cam.shake(0.35);
    this.onEngage();
    events.emit('boss:engage', { id: this.id, name: this.name, position: this.position.clone() });
  }

  /** Back to the starting state (player died, travel away, dev). */
  reset() {
    this.runner.cancel();
    this.game.bosses.effects.clear(this);
    this.engaged = false;
    this.alive = true;
    this.phase = 0;
    this.poise = 0;
    this.invulnerable = false;
    this.riposteOpen = false;
    this.vulnerable = false;
    this.pendingChain = null;
    this.kinematic = false;
    this.glow = 0;
    this.fade = 1;
    this.deadTime = 0;
    this.maxHealth = Math.round(this.def.maxHealth * Difficulty.bossHealth());
    this.health = this.maxHealth;
    this.director.reset();
    this.feet.copy(this.home);
    this.facing = this.homeFacing;
    this.velocity.set(0, 0, 0);
    this.syncPosition();
    this.model.root.visible = true;
    this.go('dormant');
    this.onReset();
    events.emit('boss:reset', { id: this.id });
  }

  // ==================================================================== state machine
  protected go(state: BossState, dur = 0) {
    this.state = state;
    this.stateTime = 0;
    this.stateDur = dur;
    if (state !== 'stagger') {
      this.riposteOpen = false;
      this.vulnerable = false;
    }
    const A = this.def.anims;
    switch (state) {
      case 'dormant':
        this.model.play(A.idle, { fade: 0.3 });
        break;
      case 'idle':
        this.model.play(A.idle, { fade: 0.25 });
        break;
      case 'recoil':
        this.model.play(A.recoil, { fade: 0.05, loop: false, speed: 1.1, restart: true });
        break;
      case 'stagger':
        this.model.play(A.stagger, { fade: 0.05, loop: false, speed: 0.5, restart: true });
        break;
      case 'knockdown':
        this.model.play(A.knockdown, { fade: 0.08, loop: false, speed: clamp(2.6 / Math.max(0.5, dur), 0.6, 2), restart: true });
        break;
      case 'dead':
        this.model.play(A.death, { fade: 0.08, loop: false, speed: 0.8, restart: true });
        break;
      default:
        break;
    }
  }

  /** Enter the custom state: `onCustomState` runs every frame until you call `toIdle()`. */
  setCustom(duration = Infinity) {
    this.runner.cancel();
    this.go('custom', duration);
  }

  /** Back to the director (idle) after an optional breather. */
  toIdle(breather = 0) {
    this.go('idle');
    this.director.delay(breather);
  }

  /** Start an attack by id (director, hooks, dev). */
  startAttack(id: string) {
    const def = this.attacks.get(id);
    if (!def) {
      console.warn(`[boss ${this.id}] unknown attack '${id}'`);
      return;
    }
    this.pendingChain = null;
    this.go('attack');
    this.director.noteAttack(id);
    this.runner.start(def);
  }

  // -------------------------------------------------------------------- runner callbacks
  /** @internal windup start of a step: telegraph flash + event. */
  beginTelegraph(def: AttackDef, step: number, kind: TelegraphKind, windup: number, flash: boolean) {
    this.glowKind = kind;
    this.glow = 0;
    if (flash) {
      const c = TelegraphColors[kind];
      const at = this.eyePoint(tmp);
      this.game.fx.sparks.emit({ count: 1, position: at, speed: 0, life: [0.3, 0.3], size: [1.6, 1.6], color: c });
      this.game.fx.sparks.emit({ count: 10, position: at, spread: 0.2, speed: 2.5, life: [0.2, 0.45], size: [0.05, 0.1], color: c, drag: 3 });
    }
    events.emit('boss:attack', { id: this.id, attackId: def.id, step, telegraph: kind, windup, position: this.position.clone() });
  }

  /** @internal */
  onStepActive(def: AttackDef, step: number) {
    this.onAttackStep(def, step, 'active');
  }

  /** @internal recovery of a step started: roll combo follow-ups on the last step. */
  onStepRecovery(def: AttackDef, step: number, last: boolean) {
    this.onAttackStep(def, step, 'recovery');
    if (last && this.state === 'attack') this.pendingChain = this.director.pickFollowUp(def.id);
  }

  /** @internal a leap started toward `to` */
  onLeap(_to: Vector3) {
    this.game.fx.dustPuff(this.feet, 12, 3);
  }

  /** @internal a leap landed */
  land() {
    this.game.fx.dustPuff(this.feet, 22, 4, [0.4, 0.9]);
    this.game.cam.shake(0.3);
  }

  // ==================================================================== frame
  update(dt: number) {
    this.stateTime += dt;
    this.director.tick(dt);
    const p = this.game.player;
    const A = this.def.anims;

    switch (this.state) {
      case 'dormant':
        this.friction(10, dt);
        if (!this.arena && !p.dead && this.distanceToPlayer() < (this.def.aggroRange ?? 12)) this.engage();
        break;
      case 'intro':
        this.friction(10, dt);
        this.turnToward(p.position, 2, dt);
        if (this.stateTime >= this.stateDur) this.toIdle(0.3);
        break;
      case 'idle':
        if (p.dead) {
          this.friction(8, dt);
          this.model.play(A.idle, { fade: 0.3 });
        } else {
          this.director.update(dt);
        }
        break;
      case 'attack': {
        const done = this.runner.update(dt);
        if (this.state !== 'attack') break; // a hit reaction / phase change interrupted it
        const r = this.runner;
        if (this.pendingChain && r.running && r.isLastStep && r.phase === 'recovery' && r.phaseTime >= (this.def.chainDelay ?? 0.12)) {
          this.startAttack(this.pendingChain);
        } else if (done) {
          this.director.onAttackEnd();
          this.go('idle');
        }
        break;
      }
      case 'recoil':
        this.friction(6, dt);
        if (this.stateTime >= this.stateDur) this.toIdle(0.2);
        break;
      case 'stagger':
        this.friction(5, dt);
        if (this.stateTime >= this.stateDur) {
          this.poise = 0;
          this.toIdle(0.3);
        }
        break;
      case 'knockdown':
        this.friction(5, dt);
        if (this.stateTime >= this.stateDur) {
          this.poise = 0;
          this.toIdle(0.4);
        }
        break;
      case 'transition':
        this.friction(8, dt);
        this.turnToward(p.position, 1.5, dt);
        if (this.stateTime >= this.stateDur) {
          this.invulnerable = false;
          this.toIdle(0.2);
        }
        break;
      case 'dead':
        this.friction(5, dt);
        this.deadTime += dt;
        if (this.deadTime > 2.6) this.fade = Math.max(0, 1 - (this.deadTime - 2.6) / 1.6);
        if (this.deadTime > 2.6 && Math.random() < 0.5) {
          this.game.fx.sparks.emit({
            count: 2, position: tmp.copy(this.feet).setY(this.feet.y + Math.random() * this.def.height), spread: this.radius,
            speed: 0.6, upBias: 1, life: [0.6, 1.2], size: [0.05, 0.14], color: TelegraphColors.parryable, gravity: -2, drag: 1,
          });
        }
        break;
      case 'custom':
        this.onCustomState(dt);
        if (this.state === 'custom' && this.stateTime >= this.stateDur) this.toIdle();
        break;
    }

    // poise recovers when left alone
    this.sincePoiseDamage += dt;
    if (this.sincePoiseDamage > this.def.poise.regenDelay && this.state !== 'stagger') {
      this.poise = Math.max(0, this.poise - this.def.poise.regen * dt);
    }
    if (this.state !== 'attack') this.glow = Math.max(0, this.glow - dt * 3);

    if (this.state !== 'dead' && this.state !== 'dormant') this.onUpdate(dt);
    this.integrate(dt);
    if (this.alive) this.separateFromPlayer();
    this.syncVisual(dt);
  }

  // -------------------------------------------------------------------- movement helpers
  protected friction(k: number, dt: number) {
    const f = Math.exp(-k * dt);
    this.velocity.x *= f;
    this.velocity.z *= f;
  }

  /** Rate-limited turn toward a point (rad/s). */
  turnToward(pos: Vector3, rate: number, dt: number) {
    const target = Math.atan2(pos.x - this.feet.x, pos.z - this.feet.z);
    const d = angleDelta(this.facing, target);
    this.facing += clamp(d, -rate * dt, rate * dt);
  }

  protected steer(dirX: number, dirZ: number, speed: number, accel: number, dt: number) {
    const tx = dirX * speed;
    const tz = dirZ * speed;
    const dx = tx - this.velocity.x;
    const dz = tz - this.velocity.z;
    const d = Math.hypot(dx, dz);
    const max = accel * dt;
    if (d <= max) {
      this.velocity.x = tx;
      this.velocity.z = tz;
    } else {
      this.velocity.x += (dx / d) * max;
      this.velocity.z += (dz / d) * max;
    }
  }

  /** Idle locomotion chosen by the director (override for flying / teleporting bosses). */
  idleMove(mode: IdleMode, dir: 1 | -1, ctx: DirectorContext, dt: number) {
    const S = this.def.speeds;
    const p = this.game.player.position;
    const dx = p.x - this.feet.x;
    const dz = p.z - this.feet.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    const tx = dx / d;
    const tz = dz / d;
    const pref = this.director.phaseConfig.preferredRange ?? [3, 7];
    switch (mode) {
      case 'approach': {
        const run = ctx.dist > pref[1] + 4;
        this.steer(tx, tz, run ? S.run : S.walk, 14, dt);
        break;
      }
      case 'backoff':
        this.steer(-tx, -tz, S.back, 10, dt);
        break;
      case 'strafe': {
        const mid = (pref[0] + pref[1]) / 2;
        const radial = clamp((d - mid) * 0.6, -1, 1);
        let mx = -tz * dir * 0.85 + tx * radial;
        let mz = tx * dir * 0.85 + tz * radial;
        const ml = Math.hypot(mx, mz) || 1;
        mx /= ml;
        mz /= ml;
        this.steer(mx, mz, S.strafe, 10, dt);
        break;
      }
      default:
        this.friction(8, dt);
    }
    this.turnToward(p, S.turn, dt);
    this.pickLocomotionClip();
  }

  /** Walk / run / strafe / back clip from the velocity relative to facing. */
  protected pickLocomotionClip() {
    const A = this.def.anims;
    const S = this.def.speeds;
    const f = this.forwardVec(tmp2);
    const fwd = f.x * this.velocity.x + f.z * this.velocity.z;
    const lateral = f.z * this.velocity.x - f.x * this.velocity.z; // + = moving to our left
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    if (hs < 0.4) this.model.play(A.idle, { fade: 0.3 });
    else if (fwd < -0.5 && Math.abs(lateral) < Math.abs(fwd)) this.model.play(A.back, { fade: 0.25, speed: clamp(hs / S.back, 0.6, 1.4) });
    else if (Math.abs(lateral) > Math.abs(fwd)) this.model.play(lateral > 0 ? A.strafeLeft : A.strafeRight, { fade: 0.25, speed: clamp(hs / (S.strafe * 1.6), 0.5, 1.2) });
    else if (hs > (S.walk + S.run) / 2) this.model.play(A.run, { fade: 0.25, speed: clamp(hs / (S.run * 1.1), 0.6, 1.3) });
    else this.model.play(A.walk, { fade: 0.25, speed: clamp(hs / S.walk, 0.6, 1.4) });
  }

  /** Clamp a point to the arena (minus our radius). */
  clampToArena(v: Vector3) {
    const a = this.arena;
    if (!a) return v;
    const r = a.region.radius - this.radius - 0.3;
    const dx = v.x - a.region.x;
    const dz = v.z - a.region.z;
    const d = Math.hypot(dx, dz);
    if (d > r) {
      v.x = a.region.x + (dx / d) * r;
      v.z = a.region.z + (dz / d) * r;
    }
    return v;
  }

  private integrate(dt: number) {
    const world = this.game.world;
    if (this.kinematic) {
      this.syncPosition();
      return;
    }
    const wasGrounded = this.grounded;
    if (!this.grounded || this.velocity.y > 0) this.velocity.y = Math.max(-30, this.velocity.y - 30 * dt);
    this.feet.addScaledVector(this.velocity, dt);
    world.resolveCollisions(this.feet, this.radius * 0.85, 0.6, this.def.height);
    this.clampToArena(this.feet);
    const ground = world.groundAt(this.feet.x, this.feet.z, this.feet.y, 0.6);
    if (this.velocity.y <= 0 && this.feet.y <= ground + (wasGrounded ? 0.5 : 0)) {
      this.feet.y = ground;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    if (this.feet.y < -30) this.feet.copy(this.home);
    this.syncPosition();
  }

  protected syncPosition() {
    this.position.set(this.feet.x, this.feet.y + this.def.height * 0.55, this.feet.z);
    this.airborne = this.kinematic || !this.grounded;
  }

  /** Bosses are solid: the player is pushed out of the body. */
  private separateFromPlayer() {
    const p = this.game.player;
    if (p.dead || p.state === 'grabbed' || this.state === 'dead') return;
    if (p.position.y > this.feet.y + this.def.height * 0.8 || p.position.y < this.feet.y - 1.2) return;
    const min = this.radius + 0.4;
    const dx = p.position.x - this.feet.x;
    const dz = p.position.z - this.feet.z;
    const d = Math.hypot(dx, dz);
    if (d >= min || d < 1e-4) return;
    const push = min - d;
    p.position.x += (dx / d) * push;
    p.position.z += (dz / d) * push;
  }

  // ==================================================================== damage to the player
  /** Deliver a hit to the player with difficulty scaling and reactions. */
  hitPlayer(spec: BossHitSpec): HitResult {
    const p = this.game.player;
    if (p.dead) return 'ignored';
    const dir = tmp.set(p.position.x - spec.from.x, 0, p.position.z - spec.from.z);
    if (dir.lengthSq() < 1e-4) this.forwardVec(dir);
    dir.normalize();
    const res = p.receiveHit({
      damage: Difficulty.scaleDamage(spec.damage),
      dir: dir.clone(),
      knockback: spec.knockback,
      heavy: spec.heavy,
      unblockable: spec.unblockable,
      parryable: spec.parryable,
      attacker: this,
    });
    switch (res) {
      case 'hit':
        this.game.hitstop(spec.heavy ? 0.12 : 0.08);
        this.game.cam.shake(spec.heavy ? 0.5 : 0.35);
        break;
      case 'blocked':
        this.game.cam.shake(0.25);
        break;
      case 'parried':
        if (!spec.projectile) this.onParried();
        break;
      default:
        break;
    }
    return res;
  }

  /** @internal grab attempt from the runner. */
  tryGrab(_box: GrabBox): HitResult | 'grabbed' {
    const p = this.game.player;
    const dir = tmp.set(p.position.x - this.feet.x, 0, p.position.z - this.feet.z).normalize();
    const probe = probeDefenses(p, { damage: 0, dir: dir.clone(), knockback: 0, heavy: true, unblockable: true, parryable: false, attacker: this });
    if (probe) return probe;
    const box = _box;
    const off = box.holdOffset ?? this.radius + 0.5;
    const h = box.holdHeight ?? this.def.height * 0.35;
    p.go('grabbed', {
      anchor: (out: Vector3) => out.set(
        this.feet.x + Math.sin(this.facing) * off, this.feet.y + h, this.feet.z + Math.cos(this.facing) * off,
      ),
      facing: () => this.facing + Math.PI,
    });
    events.emit('boss:grab', { id: this.id, phase: 'catch', position: p.position.clone() });
    return 'grabbed';
  }

  /** @internal end of the hold: throw the player. */
  throwGrabbed(box: GrabBox, damage: number) {
    const p = this.game.player;
    const dir = this.forwardVec(new Vector3());
    throwPlayer(p, Difficulty.scaleDamage(damage), dir, box.throwKnockback ?? 9);
    this.game.hitstop(0.12);
    this.game.cam.shake(0.6);
    events.emit('boss:grab', { id: this.id, phase: 'throw', position: p.position.clone() });
  }

  /** @internal interrupted while holding: drop the player. */
  releaseGrab(_thrown: boolean) {
    const p = this.game.player;
    if (p.state === 'grabbed') {
      escapePlayer(p);
      events.emit('boss:grab', { id: this.id, phase: 'escape', position: p.position.clone() });
    }
  }

  /** @internal fire projectile `i` of `n` for a projectile hitbox. */
  fireProjectile(box: ProjectileBox, i: number, n: number, tele: TelegraphKind, damage: number) {
    const f = this.facing;
    const off = box.offset ?? this.radius + 0.4;
    const origin = tmp.set(this.feet.x + Math.sin(f) * off, this.feet.y + (box.height ?? this.def.height * 0.6), this.feet.z + Math.cos(f) * off);
    const p = this.game.player.position;
    let yaw = f;
    let pitch = 0;
    if ((box.aim ?? 'player') === 'player') {
      yaw = Math.atan2(p.x - origin.x, p.z - origin.z);
      const hd = Math.hypot(p.x - origin.x, p.z - origin.z);
      pitch = Math.atan2(p.y + 1.0 - origin.y, hd);
    }
    const spread = n > 1 ? (box.spread ?? 30) * (Math.PI / 180) : 0;
    yaw += n > 1 ? -spread / 2 + (spread * i) / (n - 1) : 0;
    const cp = Math.cos(pitch);
    const dir = tmp2.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    this.game.bosses.effects.spawnProjectile({
      owner: this, position: origin, direction: dir, speed: box.speed, homing: box.homing, lifetime: box.lifetime,
      radius: box.radius, damage, knockback: box.knockback, telegraph: tele, reflectable: box.reflectable,
      reflectDamage: box.reflectDamage, reflectPoise: box.reflectPoise,
    });
  }

  // ==================================================================== damage to the boss
  onHit(info: HitInfo) {
    if (!this.alive || this.state === 'dead') return;
    const { fx, hud } = this.game;
    if (this.state === 'dormant') {
      // arena bosses only fight once the player has walked through the fog
      if (this.arena) return;
      this.engage();
    }
    const sparkPos = tmp.copy(this.position).addScaledVector(info.dir, -this.radius * 0.6);
    if (this.invulnerable) {
      fx.sparks.emit({ count: 14, position: sparkPos, spread: 0.1, speed: 4, life: [0.1, 0.3], size: [0.04, 0.09], color: new Color(1.4, 1.5, 2), drag: 4 });
      hud.damageNumber(this.position.clone().setY(this.feet.y + this.def.height + 0.3), 'Immune' as unknown as number, false);
      return;
    }

    // Riposte: a player attack from the front while the boss is staggered.
    if (this.riposteOpen && info.source !== 'echo' && info.move !== 'riposte' && this.playerInRiposteSpot()) {
      this.riposte();
      return;
    }

    let dmg = info.damage;
    if (this.vulnerable) dmg *= this.def.poise.vulnerableMul;
    if (info.source === 'echo') dmg *= this.def.echoDamageMul ?? 0.6;
    dmg = Math.max(1, Math.round(dmg));
    this.applyDamage(dmg, !!info.heavy || this.vulnerable, false, sparkPos, info.dir);

    if (this.alive && this.state !== 'stagger' && this.state !== 'knockdown') {
      let pd = dmg * (info.heavy ? 1.5 : 1) * (this.def.poise.damageMul ?? 1);
      if (info.guardBreak) pd += 12;
      if (info.source === 'echo') pd *= 0.5;
      this.addPoise(pd, 'poise');
    }
  }

  /** HP loss + feedback + death / phase checks. */
  protected applyDamage(dmg: number, big: boolean, critical: boolean, at: Vector3, dir?: Vector3) {
    const { fx, hud } = this.game;
    this.health = Math.max(0, this.health - dmg);
    this.lastHitAt = this.game.time;
    this.flash = 1;
    fx.hitSpark(at.clone(), (dir ? dir.clone().negate() : new Vector3(0, 1, 0)).setY(0.3), big);
    hud.damageNumber(this.position.clone().setY(this.feet.y + this.def.height + 0.2), dmg, big);
    events.emit('boss:hit', { id: this.id, damage: dmg, position: this.position.clone(), heavy: big, critical });
    if (this.health <= 0) {
      this.die();
      return;
    }
    const next = this.def.phases[this.phase + 1];
    if (next && this.healthFrac <= next.threshold) this.enterPhase(this.phase + 1);
  }

  /** Add poise damage; breaks into a stagger at max. */
  addPoise(amount: number, cause: 'poise' | 'parry' | 'counter' | 'reflect' | 'custom') {
    if (!this.alive || this.state === 'dead' || this.state === 'transition') return;
    this.poise += amount;
    this.sincePoiseDamage = 0;
    if (this.poise >= this.def.poise.max && this.state !== 'stagger' && this.state !== 'knockdown') this.stagger(this.def.poise.staggerTime, cause, true);
  }

  /** Stagger the boss for `duration` s. `riposte` opens the finisher window (and bonus damage). */
  stagger(duration: number, cause: 'poise' | 'parry' | 'counter' | 'reflect' | 'custom', riposte: boolean) {
    this.runner.cancel();
    this.pendingChain = null;
    this.poise = riposte ? this.def.poise.max : this.poise;
    this.go('stagger', duration);
    this.riposteOpen = riposte;
    this.vulnerable = riposte;
    this.game.cam.shake(0.35);
    this.game.fx.sparks.emit({
      count: 40, position: tmp.copy(this.position), spread: 0.3, speed: 6, upBias: 0.5, life: [0.2, 0.6], size: [0.05, 0.14],
      color: EYE_DAZED, color2: TelegraphColors.parryable, gravity: 6, drag: 2,
    });
    events.emit('boss:stagger', { id: this.id, position: this.position.clone(), duration, cause, riposte });
  }

  /** Player parried one of our swings. */
  onParried() {
    const step = this.runner.step;
    const reaction = step?.onParry ?? this.def.onParry ?? 'recoil';
    const pd = step?.parryPoise ?? this.def.parryPoise ?? 30;
    this.poise += pd;
    this.sincePoiseDamage = 0;
    if (this.poise >= this.def.poise.max) {
      this.stagger(this.def.poise.staggerTime, 'parry', true);
    } else if (reaction === 'stagger') {
      this.stagger(this.def.poise.staggerTime * 0.75, 'parry', true);
    } else if (reaction === 'recoil') {
      this.runner.cancel();
      this.go('recoil', 0.8);
      events.emit('boss:stagger', { id: this.id, position: this.position.clone(), duration: 0.8, cause: 'parry', riposte: false });
    }
  }

  /** Counter style reversed our swing (called by player/states/defense.ts). */
  onCountered() {
    if (!this.alive) return;
    this.runner.cancel();
    this.poise += this.def.counterPoise ?? 40;
    this.sincePoiseDamage = 0;
    if (this.poise >= this.def.poise.max) {
      this.stagger(this.def.poise.staggerTime, 'counter', true);
    } else {
      this.go('recoil', 1.0);
      events.emit('boss:stagger', { id: this.id, position: this.position.clone(), duration: 1, cause: 'counter', riposte: false });
    }
  }

  /** A reflected projectile hit us. */
  onReflectHit(damage: number, poise: number, at: Vector3) {
    if (!this.alive || this.state === 'dead') return;
    if (this.invulnerable) return;
    this.applyDamage(Math.round(damage), true, false, at.clone());
    if (this.alive) this.addPoise(poise, 'reflect');
  }

  private playerInRiposteSpot() {
    const p = this.game.player.position;
    const R = this.def.riposte;
    const d = this.distanceToPlayer();
    if (d > (R.range ?? 2.6) + this.radius) return false;
    return Math.abs(this.angleTo(p)) <= ((R.arcDeg ?? 150) * Math.PI) / 360;
  }

  /** The execution finisher. */
  protected riposte() {
    const { game } = this;
    this.riposteOpen = false;
    this.vulnerable = false;
    const dmg = Math.round(this.def.riposte.damage);
    game.hitstop(0.22);
    game.slowmo(0.3, 0.5);
    game.cam.shake(0.8);
    game.cam.kickFov(-8);
    game.hud.damageNumber(this.position.clone().setY(this.feet.y + this.def.height + 0.6), 'Critical' as unknown as number, true);
    game.fx.sparks.emit({
      count: 70, position: tmp.copy(this.position), spread: 0.3, speed: 9, upBias: 0.4, life: [0.2, 0.7], size: [0.05, 0.16],
      color: new Color(3, 2.2, 1), color2: new Color(2.6, 0.5, 0.2), gravity: 8, drag: 2,
    });
    events.emit('boss:riposte', { id: this.id, damage: dmg, position: this.position.clone() });
    this.go('knockdown', this.def.riposte.knockdown ?? 1.8);
    this.applyDamage(dmg, true, true, tmp.copy(this.position));
  }

  protected enterPhase(i: number) {
    this.runner.cancel();
    this.game.bosses.effects.clear(this);
    this.pendingChain = null;
    this.phase = i;
    this.poise = 0;
    const ph = this.def.phases[i];
    const tr = ph.transition ?? {};
    this.go('transition', tr.duration ?? 2.2);
    this.invulnerable = true;
    this.model.play(tr.clip ?? this.def.anims.roar, { fade: 0.15, loop: false, restart: true, speed: tr.speed ?? 1, startAt: tr.startAt ?? 0 });
    this.game.cam.shake(tr.shake ?? 0.6);
    this.game.fx.slam(this.feet, 4);
    this.director.reset();
    events.emit('boss:phase', { id: this.id, phase: i, position: this.position.clone() });
    events.emit('arena:music', { id: this.arena?.id ?? this.id, cue: 'phase', phase: i });
    this.onPhaseEnter(i);
  }

  protected die() {
    this.runner.cancel();
    this.game.bosses.effects.clear(this);
    this.alive = false;
    this.deadTime = 0;
    this.invulnerable = false;
    this.go('dead');
    this.game.hitstop(0.18);
    this.game.slowmo(0.3, 1.4);
    this.game.cam.shake(0.7);
    this.onDefeated();
    events.emit('boss:defeated', { id: this.id, name: this.name, position: this.position.clone() });
  }

  // ==================================================================== visuals
  /** Point between the eyes (telegraph flashes). */
  eyePoint(out: Vector3) {
    return out.set(this.feet.x, this.feet.y + this.def.height * 0.92, this.feet.z).addScaledVector(this.forwardVec(tmp2), 0.25);
  }

  /** Impact FX for a circle AoE. */
  impactFx(at: Vector3, radius: number, kind: TelegraphKind) {
    const fx = this.game.fx;
    const c = TelegraphColors[kind];
    fx.waves.spawn(at, radius, c, 0.4, 0.2);
    fx.sparks.emit({ count: 30, position: at, spread: radius * 0.5, speed: 6, upBias: 1, life: [0.2, 0.6], size: [0.06, 0.15], color: c, gravity: 6, drag: 2 });
    fx.dustPuff(at, 14, 3);
    this.game.cam.shake(0.25);
  }

  /** Sparks along a sweeping blade (relative angle `a`). */
  sweepFx(a: number, range: number) {
    if (Math.random() > 0.5) return;
    const yaw = this.facing + a;
    const r = range * (0.5 + Math.random() * 0.5);
    tmp.set(this.feet.x + Math.sin(yaw) * r, this.feet.y + 1.0, this.feet.z + Math.cos(yaw) * r);
    this.game.fx.sparks.emit({ count: 2, position: tmp, spread: 0.1, speed: 1, life: [0.1, 0.25], size: [0.05, 0.1], color: TelegraphColors[this.glowKind], drag: 3 });
  }

  /** Particles along a beam. */
  beamFx(sx: number, sz: number, yaw: number, length: number, kind: TelegraphKind) {
    const t = Math.random();
    tmp.set(sx + Math.sin(yaw) * length * t, this.feet.y + 1.1, sz + Math.cos(yaw) * length * t);
    this.game.fx.sparks.emit({ count: 3, position: tmp, spread: 0.15, speed: 1.5, life: [0.1, 0.3], size: [0.08, 0.2], color: TelegraphColors[kind], drag: 3 });
  }

  protected syncVisual(dt: number) {
    const m = this.model;
    m.root.position.copy(this.feet);
    m.root.rotation.y = this.facing;
    m.update(dt);

    if (this.state === 'dead' && this.fade <= 0.01) m.root.visible = false;
    this.flash = Math.max(0, this.flash - dt * 7);
    const fl = this.flash * this.flash;
    const kind = TelegraphColors[this.glowKind];
    const pulse = this.telegraphing ? 0.7 + 0.3 * Math.sin(this.stateTime * 34) : 1;
    const g = this.glow * pulse;
    const transparent = this.fade < 1;
    for (const mat of this.bodyMats) {
      mat.emissive.copy(HIT_FLASH).multiplyScalar(fl * 0.6).add(tmpC.copy(kind).multiplyScalar(g * 0.03));
      this.applyFade(mat, transparent);
    }
    for (const mat of this.weaponMats) {
      mat.emissive.copy(kind).multiplyScalar(g * 1.3).add(tmpC.copy(HIT_FLASH).multiplyScalar(fl * 0.4));
      this.applyFade(mat, transparent);
    }
    const eye = this.eyeMat.color;
    if (this.state === 'dead') eye.setRGB(0, 0, 0);
    else if (this.state === 'stagger') eye.copy(EYE_DAZED).multiplyScalar(0.6 + 0.4 * Math.sin(this.stateTime * 18));
    else eye.copy(this.eyeIdle).lerp(tmpC.copy(kind).multiplyScalar(2), this.glow);
  }

  private applyFade(mat: MeshStandardMaterial, transparent: boolean) {
    if (mat.transparent !== transparent) {
      mat.transparent = transparent;
      mat.needsUpdate = true;
    }
    mat.opacity = this.fade;
    mat.depthWrite = !transparent;
  }

  dispose() {
    this.runner.cancel();
    this.game.bosses.effects.clear(this);
    this.game.scene.remove(this.model.root);
  }
}
