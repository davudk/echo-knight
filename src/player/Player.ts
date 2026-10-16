import { Vector3 } from 'three';
import type { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { Tuning } from '../config/tuning';
import { events } from '../core/Events';
import type { Input } from '../core/Input';
import { loadout } from '../core/Loadout';
import { angleDelta, clamp, damp, lerp } from '../core/math';
import type { Fx } from '../fx/Fx';
import { SwordTrail } from '../fx/SwordTrail';
import type { World } from '../world/World';
import type { CharacterModel } from './CharacterModel';

const P = Tuning.player;
const J = Tuning.jump;

export interface PlayerContext {
  world: World;
  fx: Fx;
  cam: ThirdPersonCamera;
  input: Input;
  hitstop(duration: number): void;
  /** global time-scale request (slow-mo); duration in real seconds */
  slowmo?(scale: number, duration: number): void;
}

/** Procedural pose offsets applied to the pivot (flips, leans). */
export interface VisualPose {
  pitch: number;
  roll: number;
  lift: number;
  squash: number;
}

/**
 * A state module. States live in `player/states/*.ts` and are registered by name, so each
 * feature can add states without editing this file.
 */
export interface StateHandler {
  enter?(p: Player, data?: unknown): void;
  update(p: Player, dt: number): void;
  exit?(p: Player, next: string): void;
  /** procedural pose for this state (written into `out`) */
  visual?(p: Player, out: VisualPose): void;
}

/**
 * Where an interrupt can fire:
 *  - ground: free on the ground (move state)
 *  - air:    free in the air (air state)
 *  - cancel: inside another action's cancel window (end of roll / attack recovery)
 */
export type InterruptContext = 'ground' | 'air' | 'cancel';

/**
 * Interrupts are how features hook actions into other states without editing them:
 * e.g. combat registers "attack pressed → enter attack" for the ground context.
 * Highest priority first; the first `check` returning true wins (and must transition).
 */
export interface Interrupt {
  name: string;
  priority: number;
  contexts: InterruptContext[];
  check(p: Player, ctx: InterruptContext, from: string): boolean;
}

/** Damage coming *to* the player. */
export interface IncomingHit {
  damage: number;
  /** direction to push the player (from attacker toward player, horizontal, normalised) */
  dir: Vector3;
  knockback: number;
  heavy?: boolean;
  unblockable?: boolean;
  /** attacker hooks for parry / counter reactions */
  attacker?: {
    position: Vector3;
    onParried?(): void;
    onCountered?(): void;
  };
}

export type HitResult = 'hit' | 'blocked' | 'parried' | 'dodged' | 'countered' | 'ignored';
/** Defense handlers can consume a hit (block / parry / perfect dodge / counter). */
export type DefenseHandler = (p: Player, hit: IncomingHit) => HitResult | null;

/**
 * Kinematic character controller + pluggable state machine.
 * Fields are public so state modules can drive them; treat them as the player's "blackboard".
 */
export class Player {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  facing = Math.PI;
  state = 'move';
  prevState = 'move';
  stateTime = 0;
  grounded = true;
  invulnerable = false;

  // Health (enemies stream)
  maxHealth = 100;
  health = 100;
  dead = false;

  // Movement bookkeeping (movement stream extends these)
  airTime = 0;
  variableJump = false;
  jumpsUsed = 0;
  airDashCharges = 1;
  /** 0 = no gravity (dashes), 1 = normal; reset to 1 every frame before the state update */
  gravityScale = 1;
  /** set by a state to suppress the low-jump (button released) gravity multiplier */
  fullJumpArc = false;
  /** collision body height for this frame (slides lower it); reset to `Tuning.movement.bodyHeight` every frame */
  bodyHeight = Tuning.movement.bodyHeight;

  // Combat bookkeeping (offense stream extends these)
  sinceAttack = 99;
  comboNext = 0;
  comboShown = -1;

  // Camera-relative move intent, refreshed every frame
  readonly moveDir = new Vector3();
  moveMag = 0;

  readonly trail: SwordTrail | null;
  readonly states = new Map<string, StateHandler>();
  readonly interrupts: Interrupt[] = [];
  readonly defenseHandlers: DefenseHandler[] = [];
  readonly spawnPoint = new Vector3();

  private yawRate = 0;
  private lean = 0;
  private readonly fwd = new Vector3();
  private readonly pose: VisualPose = { pitch: 0, roll: 0, lift: 0, squash: 1 };

  constructor(
    readonly model: CharacterModel,
    readonly ctx: PlayerContext,
    spawn: Vector3,
  ) {
    this.position.copy(spawn);
    this.spawnPoint.copy(spawn);
    this.trail = model.sword ? new SwordTrail(model.sword, model.swordBase, model.swordTip) : null;
    if (this.trail) ctx.world.scene.add(this.trail.mesh);
    ctx.world.scene.add(model.root);
    this.model.play('Idle', { fade: 0 });
    this.airDashCharges = this.maxAirDashes;
  }

  // ---------------------------------------------------------------- registry
  registerState(name: string, handler: StateHandler) {
    this.states.set(name, handler);
  }
  registerInterrupt(i: Interrupt) {
    this.interrupts.push(i);
    this.interrupts.sort((a, b) => b.priority - a.priority);
  }
  registerDefense(h: DefenseHandler) {
    this.defenseHandlers.push(h);
  }

  /** Transition to `name`. Runs exit of the current state and enter of the next. */
  go(name: string, data?: unknown) {
    const next = this.states.get(name);
    if (!next) {
      console.warn(`Player: unknown state '${name}'`);
      return;
    }
    this.states.get(this.state)?.exit?.(this, name);
    this.prevState = this.state;
    this.state = name;
    this.stateTime = 0;
    this.invulnerable = false;
    next.enter?.(this, data);
  }

  /** Give registered features a chance to take over. Returns true if a transition happened. */
  runInterrupts(ctx: InterruptContext): boolean {
    const from = this.state;
    for (const i of this.interrupts) {
      if (!i.contexts.includes(ctx)) continue;
      if (i.check(this, ctx, from)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- helpers
  get forward() {
    return this.fwd.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }
  /** States that count as "attacking" for combo bookkeeping (offense stream adds more). */
  readonly attackStates = new Set(['attack']);
  get attacking() {
    return this.attackStates.has(this.state);
  }
  get airborne() {
    return !this.grounded;
  }
  get maxAirDashes() {
    return loadout.num('move.airDashes');
  }
  get maxJumps() {
    return loadout.num('move.jumps');
  }
  get input() {
    return this.ctx.input;
  }

  faceMoveDir() {
    if (this.moveMag > 0.1) this.facing = Math.atan2(this.moveDir.x, this.moveDir.z);
  }

  accelerateHorizontal(dir: Vector3, speed: number, accel: number, dt: number) {
    const tx = dir.x * speed;
    const tz = dir.z * speed;
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

  heightAboveGround() {
    return this.position.y - this.ctx.world.groundAt(this.position.x, this.position.z, this.position.y);
  }

  /** Called by states when they finish: back to move or air depending on footing. */
  goFree() {
    this.go(this.grounded ? 'move' : 'air');
  }

  // ---------------------------------------------------------------- frame
  update(dt: number) {
    const { input, cam } = this.ctx;
    const f = cam.forward(new Vector3());
    const r = cam.right(new Vector3());
    this.moveDir.set(0, 0, 0).addScaledVector(f, input.move.y).addScaledVector(r, input.move.x);
    this.moveMag = Math.min(1, this.moveDir.length());
    if (this.moveMag > 1e-3) this.moveDir.divideScalar(this.moveDir.length());

    this.stateTime += dt;
    this.sinceAttack += dt;
    if (this.grounded) this.airTime = 0;
    else this.airTime += dt;
    if (this.variableJump && (!input.held('jump') || this.velocity.y <= 0)) this.variableJump = false;
    if (this.sinceAttack > Tuning.combo.resetWindow && !this.attacking) {
      this.comboNext = 0;
      this.comboShown = -1;
    }

    const prevFacing = this.facing;
    this.gravityScale = 1;
    this.fullJumpArc = false;
    this.bodyHeight = Tuning.movement.bodyHeight;
    this.states.get(this.state)?.update(this, dt);
    this.yawRate = dt > 0 ? angleDelta(prevFacing, this.facing) / dt : 0;

    this.integrate(dt);
    this.syncVisual(dt);
    this.model.update(dt);
    this.trail?.update(dt);

    if (this.position.y < -40) this.teleport(this.spawnPoint, Math.PI);
  }

  // ---------------------------------------------------------------- physics
  private integrate(dt: number) {
    const { world } = this.ctx;
    const wasGrounded = this.grounded;

    if (!this.grounded || this.velocity.y > 0) {
      let g = J.gravity * this.gravityScale;
      if (this.velocity.y > 0 && !this.variableJump && !this.fullJumpArc && this.state === 'air') g *= J.lowJumpGravityMul;
      else if (this.velocity.y < 0) g *= J.fallGravityMul;
      this.velocity.y = Math.max(-J.maxFallSpeed, this.velocity.y - g * dt);
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;
    world.resolveCollisions(this.position, P.radius, P.stepHeight, this.bodyHeight);

    // Bonk heads on ceilings (box undersides).
    if (this.velocity.y > 0) {
      for (const c of world.colliders) {
        if (c.bottom > this.position.y + 1.4 && c.bottom < this.position.y + 1.8 && world.contains2D(c, this.position.x, this.position.z, -0.1)) {
          this.velocity.y = 0;
          break;
        }
      }
    }

    const ground = world.groundAt(this.position.x, this.position.z, this.position.y, P.stepHeight);
    const snap = wasGrounded ? P.groundSnap : 0;
    if (this.velocity.y <= 0 && this.position.y <= ground + snap) {
      const impact = this.velocity.y;
      this.position.y = ground;
      this.velocity.y = 0;
      this.grounded = true;
      if (!wasGrounded) this.onLand(impact);
    } else {
      this.grounded = false;
    }
  }

  /** Landing hooks: states may define `onLand` via `landHandlers`. */
  readonly landHandlers: ((p: Player, impactVy: number) => boolean)[] = [];

  private onLand(impactVy: number) {
    this.jumpsUsed = 0;
    this.airDashCharges = this.maxAirDashes;
    events.emit('player:land', { position: this.position.clone(), impact: impactVy });
    if (impactVy < -5) this.ctx.fx.dustPuff(this.position, impactVy < -12 ? 14 : 7, impactVy < -12 ? 3 : 2);
    // First handler that returns true consumes the landing (e.g. slams).
    for (const h of this.landHandlers) if (h(this, impactVy)) return;
  }

  // ---------------------------------------------------------------- damage
  /** Apply an incoming hit. Defense handlers (block/parry/...) get first say. */
  receiveHit(hit: IncomingHit): HitResult {
    if (this.dead) return 'ignored';
    for (const d of this.defenseHandlers) {
      const r = d(this, hit);
      if (r) return r;
    }
    if (this.invulnerable) return 'dodged';
    this.health = Math.max(0, this.health - hit.damage);
    events.emit('player:damaged', { damage: hit.damage, health: this.health, position: this.position.clone() });
    if (this.health <= 0 && this.states.has('dead')) {
      this.go('dead', hit);
    } else if (this.states.has('hurt')) {
      this.go('hurt', hit);
    } else {
      this.velocity.x = hit.dir.x * hit.knockback;
      this.velocity.z = hit.dir.z * hit.knockback;
    }
    return 'hit';
  }

  // ---------------------------------------------------------------- teleport
  /** Instantly move the character (echo recall, respawn). Keeps mid-air positions. */
  teleport(pos: Vector3, facing: number, opts: { refresh?: boolean } = {}) {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.facing = facing;
    if (opts.refresh !== false) {
      this.airDashCharges = this.maxAirDashes;
      this.jumpsUsed = Math.min(this.jumpsUsed, 1);
    }
    this.variableJump = false;
    if (this.trail) this.trail.active = false;
    const ground = this.ctx.world.groundAt(pos.x, pos.z, pos.y + 0.05);
    this.grounded = pos.y <= ground + 0.05;
    if (this.grounded) {
      this.position.y = ground;
      this.go('move');
    } else {
      this.go('air');
      this.velocity.y = 1.5; // tiny float so a recall into the air feels deliberate
    }
  }

  // ---------------------------------------------------------------- visuals
  private syncVisual(dt: number) {
    const root = this.model.root;
    root.position.copy(this.position);
    root.rotation.y = this.facing;

    const targetLean = this.state === 'move' ? clamp(-this.yawRate * 0.035, -0.25, 0.25) : 0;
    this.lean = lerp(this.lean, targetLean, damp(10, dt));

    const pose = this.pose;
    pose.pitch = 0;
    pose.roll = this.lean;
    pose.lift = 0;
    pose.squash = 1;
    this.states.get(this.state)?.visual?.(this, pose);

    const pivot = this.model.pivot;
    pivot.rotation.set(pose.pitch, 0, pose.roll);
    pivot.position.y = this.model.hipHeight + pose.lift;
    pivot.scale.set(1, pose.squash, 1);
  }
}
