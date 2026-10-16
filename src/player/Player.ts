import { Color, Vector3 } from 'three';
import type { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { Tuning, type ComboStep } from '../config/tuning';
import type { Input } from '../core/Input';
import { clamp, damp, dampAngle, easeInOutSine, lerp, angleDelta } from '../core/math';
import { Colors, type Fx } from '../fx/Fx';
import { SwordTrail } from '../fx/SwordTrail';
import type { World } from '../world/World';
import type { CharacterModel } from './CharacterModel';

const P = Tuning.player;
const J = Tuning.jump;
const D = Tuning.dodge;
const AD = Tuning.airDash;
const C = Tuning.combo;
const PL = Tuning.plunge;

export type PlayerState = 'move' | 'air' | 'dodge' | 'airdash' | 'attack' | 'plunge';

export interface PlayerContext {
  world: World;
  fx: Fx;
  cam: ThirdPersonCamera;
  input: Input;
  hitstop(duration: number): void;
}

/**
 * Kinematic character controller + action state machine.
 * Each state has enter/update logic; transitions are explicit `enter*` calls.
 */
export class Player {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  facing = Math.PI;
  state: PlayerState = 'move';
  stateTime = 0;
  grounded = true;
  invulnerable = false;
  airDashCharges: number = AD.charges;

  /** index of the combo step that may come next (0..2) */
  comboNext = 0;
  /** last attack step used, for the HUD */
  comboShown = -1;

  private readonly trail: SwordTrail | null;
  private readonly moveDir = new Vector3();
  private moveMag = 0;
  private airTime = 0;
  private variableJump = false;
  private jumpedSinceGround = false;
  private gravityScale = 1;
  private sinceAttack = 99;
  private landLock = 0;
  private footstep = 0;
  private yawRate = 0;
  private lean = 0;

  // state-local data
  private dodgeDir = new Vector3();
  private dodgeDuration = 0;
  private dodgeDistance = 0;
  private backstep = false;
  private step: ComboStep | null = null;
  private stepIndex = 0;
  private hitDone = false;
  private leapDone = false;
  private slamPending = false;
  private plungeLanded = 0;
  private afterimageTimer = 0;

  private readonly tmp = new Vector3();
  private readonly fwd = new Vector3();

  constructor(
    readonly model: CharacterModel,
    private readonly ctx: PlayerContext,
    spawn: Vector3,
  ) {
    this.position.copy(spawn);
    this.trail = model.sword ? new SwordTrail(model.sword, model.swordBase, model.swordTip) : null;
    if (this.trail) ctx.world.scene.add(this.trail.mesh);
    ctx.world.scene.add(model.root);
    this.model.play('Idle', { fade: 0 });
    this.syncVisual(0);
  }

  get forward() {
    return this.fwd.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  get airborne() {
    return !this.grounded;
  }

  // ---------------------------------------------------------------------------
  update(dt: number) {
    const { input, cam } = this.ctx;
    // Camera-relative move intent.
    const f = cam.forward(this.tmp);
    const r = cam.right(new Vector3());
    this.moveDir.set(0, 0, 0).addScaledVector(f, input.move.y).addScaledVector(r, input.move.x);
    this.moveMag = Math.min(1, this.moveDir.length());
    if (this.moveMag > 1e-3) this.moveDir.divideScalar(this.moveDir.length());

    this.stateTime += dt;
    this.sinceAttack += dt;
    this.landLock = Math.max(0, this.landLock - dt);
    if (this.grounded) this.airTime = 0;
    else this.airTime += dt;
    if (this.variableJump && (!input.held('jump') || this.velocity.y <= 0)) this.variableJump = false;
    if (this.sinceAttack > C.resetWindow && this.state !== 'attack') {
      this.comboNext = 0;
      this.comboShown = -1;
    }

    const prevFacing = this.facing;
    this.gravityScale = 1;
    switch (this.state) {
      case 'move': this.updateMove(dt); break;
      case 'air': this.updateAir(dt); break;
      case 'dodge': this.updateDodge(dt); break;
      case 'airdash': this.updateAirDash(dt); break;
      case 'attack': this.updateAttack(dt); break;
      case 'plunge': this.updatePlunge(dt); break;
    }
    this.yawRate = dt > 0 ? angleDelta(prevFacing, this.facing) / dt : 0;

    this.integrate(dt);
    this.syncVisual(dt);
    this.model.update(dt);
    this.trail?.update(dt);

    if (this.position.y < -40) this.teleport(new Vector3(0, 2, 6), Math.PI);
  }

  private setState(s: PlayerState) {
    if (this.state === 'attack' && s !== 'attack') this.exitAttack();
    this.state = s;
    this.stateTime = 0;
    this.invulnerable = false;
  }

  // ---------------------------------------------------------------------------
  // MOVE
  private updateMove(dt: number) {
    const { input } = this.ctx;
    if (!this.grounded) return this.enterAir(false);
    if (this.tryJump()) return;
    if (input.consume('dodge', 0.15)) return this.enterDodge();
    if (input.consume('attack', C.inputBuffer)) return this.enterAttack(this.comboNext);

    const sprint = input.held('sprint') && this.moveMag > 0.5;
    let speed: number;
    if (this.moveMag <= 0.5) speed = lerp(0, P.walkSpeed, this.moveMag / 0.5);
    else speed = lerp(P.walkSpeed, P.runSpeed, (this.moveMag - 0.5) / 0.5);
    if (sprint) speed = P.sprintSpeed;
    this.accelerateHorizontal(this.moveDir, speed, this.moveMag > 0.01 ? P.accel : P.decel, dt);

    if (this.moveMag > 0.05) {
      this.facing = dampAngle(this.facing, Math.atan2(this.moveDir.x, this.moveDir.z), P.turnRate, dt);
    }

    // Locomotion animation by actual speed.
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.landLock > 0 && hs < 1) {
      // keep landing anim
    } else if (hs < 0.35) {
      this.model.play('Idle', { fade: 0.2 });
    } else if (hs < P.walkSpeed + 0.9) {
      this.model.play('Walking_A', { fade: 0.2, speed: clamp(hs / P.walkSpeed, 0.6, 1.5) });
    } else {
      this.model.play('Running_A', { fade: 0.18, speed: clamp(hs / P.runSpeed, 0.75, 1.45) });
    }

    // Footstep dust while running fast.
    if (hs > P.runSpeed * 0.9) {
      this.footstep -= dt;
      if (this.footstep <= 0) {
        this.footstep = sprint ? 0.2 : 0.3;
        this.ctx.fx.dustPuff(this.position, sprint ? 4 : 2, 1.2, [0.18, 0.32]);
      }
    }
  }

  private tryJump(): boolean {
    const canJump = this.grounded || (this.airTime < J.coyoteTime && !this.jumpedSinceGround);
    if (!canJump || !this.ctx.input.consume('jump', J.bufferTime)) return false;
    this.velocity.y = J.velocity;
    this.grounded = false;
    this.variableJump = true;
    this.jumpedSinceGround = true;
    this.ctx.fx.dustPuff(this.position, 6, 1.6);
    this.enterAir(true);
    return true;
  }

  // ---------------------------------------------------------------------------
  // AIR
  private enterAir(jumped: boolean) {
    this.setState('air');
    if (jumped) this.model.play('Jump_Start', { fade: 0.06, loop: false, speed: 2.2, startAt: 0.15, restart: true });
    else this.model.play('Jump_Idle', { fade: 0.25 });
  }

  private updateAir(dt: number) {
    const { input } = this.ctx;
    if (this.tryJump()) return; // coyote jump
    if (input.consume('dodge', 0.12) && this.airDashCharges > 0) return this.enterAirDash();
    if (input.buffered('attack', 0.1) && this.heightAboveGround() > 1.1) {
      input.clearBuffer('attack');
      return this.enterPlunge();
    }

    // Air control: steer toward input but don't kill momentum from dashes / sprint jumps.
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    const maxSpeed = Math.max(P.runSpeed, hs);
    if (this.moveMag > 0.05) {
      this.accelerateHorizontal(this.moveDir, maxSpeed * this.moveMag, J.airAccel, dt);
      this.facing = dampAngle(this.facing, Math.atan2(this.moveDir.x, this.moveDir.z), J.airTurnRate, dt);
    } else {
      // gentle air drag
      const k = Math.exp(-1.2 * dt);
      this.velocity.x *= k;
      this.velocity.z *= k;
    }

    if (this.model.currentName === 'Jump_Start' && this.stateTime > 0.18) this.model.play('Jump_Idle', { fade: 0.2 });
  }

  // ---------------------------------------------------------------------------
  // DODGE (ground roll / backstep)
  private enterDodge() {
    this.setState('dodge');
    this.backstep = this.moveMag < 0.1;
    if (this.backstep) {
      this.dodgeDir.copy(this.forward).negate();
      this.dodgeDuration = D.backstepDuration;
      this.dodgeDistance = D.backstepDistance;
      this.model.play('Dodge_Backward', { fade: 0.05, loop: false, speed: this.model.clipDuration('Dodge_Backward') / D.backstepDuration, restart: true });
    } else {
      this.dodgeDir.copy(this.moveDir);
      this.facing = Math.atan2(this.moveDir.x, this.moveDir.z);
      this.dodgeDuration = D.duration;
      this.dodgeDistance = D.distance;
      this.model.play('Dodge_Forward', { fade: 0.05, loop: false, speed: this.model.clipDuration('Dodge_Forward') / (D.duration * 0.9), restart: true });
    }
    this.ctx.fx.dustPuff(this.position, 8, 2.2);
  }

  private updateDodge(dt: number) {
    const t = this.stateTime;
    const d = this.dodgeDuration;
    const u = Math.min(1, t / d);
    // Front-loaded speed curve; integrates to dodgeDistance.
    const base = this.dodgeDistance / (0.9 * d);
    const speed = base * (1.35 - 0.9 * u);
    this.velocity.x = this.dodgeDir.x * speed;
    this.velocity.z = this.dodgeDir.z * speed;
    this.invulnerable = t >= D.iframes[0] && t <= D.iframes[1];

    if (t > 0.12 && t < d * 0.8 && this.grounded) {
      this.footstep -= dt;
      if (this.footstep <= 0) {
        this.footstep = 0.09;
        this.ctx.fx.dustPuff(this.position, 3, 1.2, [0.2, 0.4]);
      }
    }

    const { input } = this.ctx;
    if (t >= D.cancelAt) {
      if (this.tryJump()) return;
      if (input.consume('attack', C.inputBuffer)) return this.enterAttack(0);
      if (input.consume('dodge', 0.15)) return this.enterDodge();
    }
    if (t >= d) {
      if (this.grounded) {
        this.setState('move');
      } else this.enterAir(false);
    }
  }

  // ---------------------------------------------------------------------------
  // AIR DASH
  private enterAirDash() {
    this.setState('airdash');
    this.airDashCharges--;
    const dir = this.moveMag > 0.1 ? this.moveDir : this.forward;
    this.dodgeDir.copy(dir).setY(0).normalize();
    this.facing = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
    this.velocity.set(this.dodgeDir.x * AD.speed, 0, this.dodgeDir.z * AD.speed);
    this.variableJump = false;
    this.afterimageTimer = 0;
    this.model.play('Dodge_Forward', { fade: 0.04, loop: false, speed: 1.1, startAt: 0.05, restart: true });
    this.ctx.cam.kickFov(7);
    this.ctx.fx.afterimage(0.35);
    this.ctx.fx.sparks.emit({
      count: 24, position: this.tmp.copy(this.position).setY(this.position.y + 1), spread: 0.3,
      velocity: this.dodgeDir.clone().multiplyScalar(-6), speed: 3, life: [0.2, 0.45], size: [0.05, 0.12],
      color: Colors.dash, color2: Colors.echoParticle, drag: 3,
    });
  }

  private updateAirDash(dt: number) {
    this.gravityScale = 0;
    this.velocity.set(this.dodgeDir.x * AD.speed, 0, this.dodgeDir.z * AD.speed);
    this.afterimageTimer -= dt;
    if (this.afterimageTimer <= 0) {
      this.afterimageTimer = AD.afterimageInterval;
      this.ctx.fx.afterimage(0.3);
    }
    if (this.stateTime > 0.08 && this.ctx.input.buffered('attack', 0.1)) {
      this.ctx.input.clearBuffer('attack');
      return this.enterPlunge();
    }
    if (this.stateTime >= AD.duration) {
      this.velocity.set(this.dodgeDir.x * AD.exitSpeed, AD.exitVy, this.dodgeDir.z * AD.exitSpeed);
      this.enterAir(false);
      this.model.play('Jump_Idle', { fade: 0.15 });
    }
  }

  // ---------------------------------------------------------------------------
  // ATTACK (3-step combo)
  private enterAttack(index: number) {
    const step = C.steps[index];
    this.setState('attack');
    this.step = step;
    this.stepIndex = index;
    this.comboShown = index;
    this.hitDone = false;
    this.leapDone = false;
    this.slamPending = false;
    if (this.moveMag > 0.1) this.facing = Math.atan2(this.moveDir.x, this.moveDir.z);
    this.model.play(step.clip, { fade: 0.06, loop: false, speed: step.speed, startAt: step.clipStart, restart: true });
    this.ctx.input.clearBuffer('attack');
  }

  private exitAttack() {
    if (this.trail) this.trail.active = false;
    this.sinceAttack = 0;
    this.comboNext = this.stepIndex >= C.steps.length - 1 ? 0 : this.stepIndex + 1;
    if (this.stepIndex >= C.steps.length - 1) this.comboShown = -1;
  }

  private updateAttack(dt: number) {
    const step = this.step!;
    const t = this.stateTime;
    const { input } = this.ctx;
    const fwd = this.forward;

    // Brief steering window at the start.
    if (t < 0.08 && this.moveMag > 0.1) {
      this.facing = dampAngle(this.facing, Math.atan2(this.moveDir.x, this.moveDir.z), 20, dt);
    }

    // Lunge.
    const l = step.lunge;
    if (t >= l.start && t <= l.end) {
      const sp = l.distance / Math.max(0.01, l.end - l.start);
      const s = sp * (step.leap ? 1 : 1.5 - (t - l.start) / (l.end - l.start));
      this.velocity.x = fwd.x * s;
      this.velocity.z = fwd.z * s;
    } else if (this.grounded) {
      const k = Math.exp(-14 * dt);
      this.velocity.x *= k;
      this.velocity.z *= k;
    }

    // Riven-style leap for the finisher.
    if (step.leap && !this.leapDone && t >= step.leap.at) {
      this.leapDone = true;
      this.slamPending = true;
      this.velocity.y = step.leap.vy;
      this.grounded = false;
      this.ctx.fx.dustPuff(this.position, 8, 2);
    }

    if (!step.leap && !this.hitDone && t >= step.hitAt) {
      this.hitDone = true;
      this.doSwingHit(step);
    }

    if (this.trail) this.trail.active = t >= step.trail[0] && t <= step.trail[1];

    // Chaining & cancels.
    if (t >= step.chainAt && this.stepIndex < C.steps.length - 1 && !this.slamPending && input.consume('attack', t + 0.05)) {
      return this.enterAttack(this.stepIndex + 1);
    }
    if (t >= step.cancelAt && !this.slamPending) {
      if (input.consume('dodge', 0.2)) return this.enterDodge();
      if (this.tryJump()) return;
    }
    if (t >= step.moveCancelAt && this.moveMag > 0.3 && this.grounded && !this.slamPending) {
      return this.setState('move');
    }
    if (t >= step.end && !this.slamPending) {
      if (this.grounded) this.setState('move');
      else this.enterAir(false);
    }
    // Safety: never get stuck in a slam if we somehow never land.
    if (t > step.end + 1.5) this.enterAir(false);
  }

  private doSwingHit(step: ComboStep) {
    const fwd = this.forward;
    const origin = this.tmp.copy(this.position).setY(this.position.y + 1);
    const hits = this.ctx.world.queryCone(origin, fwd, step.hit.range, step.hit.arcDeg);
    for (const h of hits) {
      const dir = new Vector3(h.position.x - origin.x, 0, h.position.z - origin.z);
      if (dir.lengthSq() < 1e-4) dir.copy(fwd);
      dir.normalize();
      h.onHit({ damage: step.hit.damage, dir, knockback: step.hit.knockback, heavy: false });
    }
    if (hits.length) {
      this.ctx.hitstop(Tuning.feel.hitstop);
      this.ctx.cam.shake(0.22);
    }
  }

  private doSlam(aoe: { radius: number; damage: number; knockback: number }) {
    const center = this.position.clone().addScaledVector(this.forward, 0.8);
    center.y = this.ctx.world.groundAt(center.x, center.z, this.position.y + 0.5);
    this.ctx.fx.slam(center, aoe.radius);
    this.ctx.cam.shake(0.55);
    this.ctx.cam.kickFov(4);
    const hits = this.ctx.world.querySphere(center, aoe.radius);
    for (const h of hits) {
      const dir = new Vector3(h.position.x - center.x, 0, h.position.z - center.z);
      if (dir.lengthSq() < 1e-4) dir.copy(this.forward);
      dir.normalize();
      h.onHit({ damage: aoe.damage, dir, knockback: aoe.knockback, heavy: true });
    }
    this.ctx.hitstop(hits.length ? Tuning.feel.hitstopHeavy : 0.04);
  }

  // ---------------------------------------------------------------------------
  // PLUNGE (air attack)
  private enterPlunge() {
    this.setState('plunge');
    this.plungeLanded = 0;
    this.velocity.x *= 0.25;
    this.velocity.z *= 0.25;
    this.velocity.y = 3;
    this.model.play('1H_Melee_Attack_Chop', { fade: 0.05, loop: false, speed: 1.0, startAt: 0.15, restart: true });
    if (this.trail) this.trail.active = true;
  }

  private updatePlunge(dt: number) {
    const t = this.stateTime;
    if (this.plungeLanded > 0) {
      this.velocity.x *= Math.exp(-20 * dt);
      this.velocity.z *= Math.exp(-20 * dt);
      if (this.trail) this.trail.active = false;
      if (t - this.plungeLanded > 0.15 && this.ctx.input.consume('dodge', 0.2)) return this.enterDodge();
      if (t - this.plungeLanded >= PL.recovery) this.setState('move');
      return;
    }
    if (t < PL.hang) {
      this.gravityScale = 0.3;
      // pause the animation at the top of the raise
    } else {
      this.gravityScale = 0;
      this.velocity.y = -PL.speed;
      this.afterimageTimer -= dt;
      if (this.afterimageTimer <= 0) {
        this.afterimageTimer = 0.045;
        this.ctx.fx.afterimage(0.25, new Color(2.2, 1.4, 0.6));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Physics
  private accelerateHorizontal(dir: Vector3, speed: number, accel: number, dt: number) {
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

  private heightAboveGround() {
    return this.position.y - this.ctx.world.groundAt(this.position.x, this.position.z, this.position.y);
  }

  private integrate(dt: number) {
    const { world } = this.ctx;
    const wasGrounded = this.grounded;

    if (!this.grounded || this.velocity.y > 0) {
      let g = J.gravity * this.gravityScale;
      if (this.velocity.y > 0 && !this.variableJump && this.state === 'air') g *= J.lowJumpGravityMul;
      else if (this.velocity.y < 0) g *= J.fallGravityMul;
      this.velocity.y = Math.max(-J.maxFallSpeed, this.velocity.y - g * dt);
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;
    world.resolveCollisions(this.position, P.radius, P.stepHeight);

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

  private onLand(impactVy: number) {
    this.jumpedSinceGround = false;
    this.airDashCharges = AD.charges;
    const hard = impactVy < -12;
    if (impactVy < -5) this.ctx.fx.dustPuff(this.position, hard ? 14 : 7, hard ? 3 : 2);

    if (this.state === 'attack' && this.slamPending) {
      this.slamPending = false;
      this.hitDone = true;
      this.doSlam(this.step!.aoe!);
      return;
    }
    if (this.state === 'plunge') {
      this.plungeLanded = this.stateTime;
      this.doSlam(PL.aoe);
      if (this.trail) this.trail.active = false;
      return;
    }
    if (this.state === 'air') {
      this.setState('move');
      if (this.moveMag < 0.1) {
        this.model.play('Jump_Land', { fade: 0.08, loop: false, speed: 1.6, startAt: 0.1, restart: true });
        this.landLock = 0.28;
      }
      if (hard) this.ctx.cam.shake(0.12);
    }
  }

  // ---------------------------------------------------------------------------
  /** Instantly move the character (Echo recall). Keeps mid-air positions. */
  teleport(pos: Vector3, facing: number) {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.facing = facing;
    this.airDashCharges = AD.charges;
    this.variableJump = false;
    if (this.trail) this.trail.active = false;
    const ground = this.ctx.world.groundAt(pos.x, pos.z, pos.y + 0.05);
    this.grounded = pos.y <= ground + 0.05;
    if (this.grounded) {
      this.position.y = ground;
      this.setState('move');
    } else {
      this.enterAir(false);
      this.velocity.y = 1.5; // tiny float so a recall into the air feels deliberate
    }
  }

  // ---------------------------------------------------------------------------
  private syncVisual(dt: number) {
    const root = this.model.root;
    root.position.copy(this.position);
    root.rotation.y = this.facing;

    const pivot = this.model.pivot;
    let pitch = 0;
    let lift = 0;
    let squash = 1;

    // Turn lean while running.
    const targetLean = this.state === 'move' ? clamp(-this.yawRate * 0.035, -0.25, 0.25) : 0;
    this.lean = lerp(this.lean, targetLean, damp(10, dt));

    if (this.state === 'dodge' && !this.backstep && D.flip) {
      const u = clamp((this.stateTime - 0.03) / (this.dodgeDuration * 0.78), 0, 1);
      pitch = easeInOutSine(u) * Math.PI * 2;
      const arc = Math.sin(u * Math.PI);
      lift = arc * 0.35;
      squash = 1 - arc * 0.28;
    } else if (this.state === 'airdash') {
      pitch = 0.45;
    } else if (this.state === 'plunge' && this.plungeLanded === 0 && this.stateTime > PL.hang) {
      pitch = 0.25;
    }

    pivot.rotation.set(pitch, 0, this.lean);
    pivot.position.y = this.model.hipHeight + lift;
    pivot.scale.set(1, squash, 1);
  }
}
