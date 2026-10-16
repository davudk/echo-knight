import { Vector3 } from 'three';
import { Tuning } from '../../config/tuning';
import { events } from '../../core/Events';
import { loadout } from '../../core/Loadout';
import { clamp, dampAngle, easeInOutSine, easeOutCubic, lerp } from '../../core/math';
import { Colors } from '../../fx/Fx';
import type { Player } from '../Player';

/**
 * Locomotion states: move (ground), air, dodge (roll / backstep), airdash.
 * Also registers the jump / dodge / airdash interrupts.
 */
const P = Tuning.player;
const J = Tuning.jump;
const D = Tuning.dodge;
const AD = Tuning.airDash;
const M = Tuning.movement;

/** How the air state should pose the body (set on entering `air`). */
export type AirPose = 'none' | 'flip' | 'long';

// Module-local state data (single player).
const s = {
  footstep: 0,
  landLock: 0,
  dodgeDir: new Vector3(),
  dodgeDuration: 0,
  dodgeDistance: 0,
  backstep: false,
  afterimageTimer: 0,
  airPose: 'none' as AirPose,
  /** eight-way dash: vertical component (sin of the dash angle), 0 = flat */
  dashVert: 0,
  /** ignore early jump-button release for this airtime (wall kicks, long jumps) */
  fullArc: false,
};

export function installLocomotion(p: Player) {
  p.registerState('move', { update: updateMove });
  p.registerState('air', { enter: enterAir, update: updateAir, visual: airVisual });
  p.registerState('dodge', { enter: enterDodge, update: updateDodge, visual: dodgeVisual });
  p.registerState('airdash', {
    enter: enterAirDash, update: updateAirDash,
    visual: (_p, o) => (o.pitch = 0.45 - s.dashVert * 0.9),
  });

  p.registerInterrupt({ name: 'jump', priority: 100, contexts: ['ground', 'air', 'cancel'], check: tryJump });
  p.registerInterrupt({
    name: 'dodge', priority: 90, contexts: ['ground', 'cancel'],
    check: (pl) => pl.grounded && pl.input.consume('dodge', 0.15) && (pl.go('dodge'), true),
  });
  p.registerInterrupt({
    name: 'airdash', priority: 90, contexts: ['air', 'cancel'],
    check: (pl) => !pl.grounded && pl.airDashCharges > 0 && pl.input.consume('dodge', 0.12) && (pl.go('airdash'), true),
  });

  // Plain landing from the air state.
  p.landHandlers.push((pl, impact) => {
    if (pl.state !== 'air') return false;
    pl.go('move');
    if (pl.moveMag < 0.1) {
      pl.model.play('Jump_Land', { fade: 0.08, loop: false, speed: 1.6, startAt: 0.1, restart: true });
      s.landLock = 0.28;
    }
    if (impact < -12) pl.ctx.cam.shake(0.12);
    return true;
  });

  // Landing mid-dash (down-diagonal dashes, or dashing onto rising ground): end the dash.
  p.landHandlers.push((pl) => {
    if (pl.state !== 'airdash') return false;
    const hs = Math.hypot(pl.velocity.x, pl.velocity.z);
    const keep = Math.min(hs, AD.exitSpeed) / Math.max(hs, 1e-3);
    pl.velocity.x *= keep;
    pl.velocity.z *= keep;
    pl.ctx.fx.dustPuff(pl.position, 10, 3);
    // Slide out of a down-dash when the slide upgrade is on.
    if (loadout.has('move.slide') && pl.states.has('slide') && s.dashVert < 0) pl.go('slide', { speed: hs * 0.8 });
    else pl.go('move');
    return true;
  });
}

// ------------------------------------------------------------------ jump
/** Ground jump, coyote jump, and (with `move.jumps` > 1) air jumps. */
export function tryJump(p: Player): boolean {
  const coyote = !p.grounded && p.airTime < J.coyoteTime && p.jumpsUsed === 0;
  const canGroundJump = p.grounded || coyote;
  // Walking off a ledge (past coyote time) counts as having used the ground jump.
  const used = canGroundJump ? 0 : Math.max(1, p.jumpsUsed);
  const canAirJump = !canGroundJump && used < p.maxJumps;
  if (!canGroundJump && !canAirJump) return false;
  if (!p.input.consume('jump', J.bufferTime)) return false;
  const airJump = used;
  p.jumpsUsed = used + 1;
  p.velocity.y = J.velocity * (airJump ? M.airJumpScale[Math.min(airJump, M.airJumpScale.length) - 1] : 1);
  p.grounded = false;
  p.variableJump = true;
  if (airJump) {
    p.ctx.fx.waves.spawn(p.position.clone(), 1.2, Colors.dash, 0.3, 0.25);
    p.ctx.fx.afterimage(0.25);
  } else {
    p.ctx.fx.dustPuff(p.position, 6, 1.6);
  }
  events.emit('player:jump', { position: p.position.clone(), airJump });
  p.go('air', { jumped: true, airJump });
  return true;
}

// ------------------------------------------------------------------ move
function updateMove(p: Player, dt: number) {
  s.landLock = Math.max(0, s.landLock - dt);
  if (!p.grounded) return p.go('air');
  if (p.runInterrupts('ground')) return;

  const sprint = p.input.held('sprint') && p.moveMag > 0.5;
  let speed: number;
  if (p.moveMag <= 0.5) speed = lerp(0, P.walkSpeed, p.moveMag / 0.5);
  else speed = lerp(P.walkSpeed, P.runSpeed, (p.moveMag - 0.5) / 0.5);
  if (sprint) speed = P.sprintSpeed;
  p.accelerateHorizontal(p.moveDir, speed, p.moveMag > 0.01 ? P.accel : P.decel, dt);

  if (p.moveMag > 0.05) p.facing = dampAngle(p.facing, Math.atan2(p.moveDir.x, p.moveDir.z), P.turnRate, dt);

  const hs = Math.hypot(p.velocity.x, p.velocity.z);
  if (s.landLock > 0 && hs < 1) {
    // keep landing anim
  } else if (hs < 0.35) {
    p.model.play('Idle', { fade: 0.2 });
  } else if (hs < P.walkSpeed + 0.9) {
    p.model.play('Walking_A', { fade: 0.2, speed: clamp(hs / P.walkSpeed, 0.6, 1.5) });
  } else {
    p.model.play('Running_A', { fade: 0.18, speed: clamp(hs / P.runSpeed, 0.75, 1.45) });
  }

  if (hs > P.runSpeed * 0.9) {
    s.footstep -= dt;
    if (s.footstep <= 0) {
      s.footstep = sprint ? 0.2 : 0.3;
      p.ctx.fx.dustPuff(p.position, sprint ? 4 : 2, 1.2, [0.18, 0.32]);
      events.emit('player:footstep', { position: p.position.clone(), sprint });
    }
  }
}

// ------------------------------------------------------------------ air
function enterAir(p: Player, data?: unknown) {
  const d = (data ?? {}) as { jumped?: boolean; airJump?: number; pose?: AirPose; fullArc?: boolean };
  s.airPose = d.pose ?? (d.airJump ? 'flip' : 'none');
  s.fullArc = !!d.fullArc || s.airPose === 'long';
  if (d.jumped) {
    if (d.airJump) p.model.play('Jump_Start', { fade: 0.05, loop: false, speed: 2.6, startAt: 0.25, restart: true });
    else p.model.play('Jump_Start', { fade: 0.06, loop: false, speed: 2.2, startAt: 0.15, restart: true });
  } else {
    p.model.play('Jump_Idle', { fade: 0.25 });
  }
}

/** Front flip on air jumps / wall kicks, superman lean on long jumps. */
function airVisual(p: Player, o: { pitch: number; lift: number; squash: number }) {
  const t = p.stateTime;
  if (s.airPose === 'flip') {
    const u = clamp(t / M.airJumpFlip, 0, 1);
    o.pitch = easeOutCubic(u) * Math.PI * 2;
    const tuck = Math.sin(u * Math.PI);
    o.lift = tuck * 0.25;
    o.squash = 1 - tuck * 0.22;
  } else if (s.airPose === 'long') {
    // lean into the jump, straighten as the fall speeds up (ready to land)
    o.pitch = 0.42 * clamp((p.velocity.y + 9) / 9, 0, 1);
  }
}

function updateAir(p: Player, dt: number) {
  if (s.fullArc) p.fullJumpArc = true; // long jumps / wall kicks always get the full arc
  if (p.runInterrupts('air')) return;

  const hs = Math.hypot(p.velocity.x, p.velocity.z);
  const maxSpeed = Math.max(P.runSpeed, hs);
  if (p.moveMag > 0.05) {
    p.accelerateHorizontal(p.moveDir, maxSpeed * p.moveMag, J.airAccel, dt);
    p.facing = dampAngle(p.facing, Math.atan2(p.moveDir.x, p.moveDir.z), J.airTurnRate, dt);
  } else {
    const k = Math.exp(-1.2 * dt);
    p.velocity.x *= k;
    p.velocity.z *= k;
  }
  if (p.model.currentName === 'Jump_Start' && p.stateTime > 0.18) p.model.play('Jump_Idle', { fade: 0.2 });
}

// ------------------------------------------------------------------ dodge
function enterDodge(p: Player) {
  s.backstep = p.moveMag < 0.1;
  if (s.backstep) {
    s.dodgeDir.copy(p.forward).negate();
    s.dodgeDuration = D.backstepDuration;
    s.dodgeDistance = D.backstepDistance;
    p.model.play('Dodge_Backward', { fade: 0.05, loop: false, speed: p.model.clipDuration('Dodge_Backward') / D.backstepDuration, restart: true });
  } else {
    s.dodgeDir.copy(p.moveDir);
    p.facing = Math.atan2(p.moveDir.x, p.moveDir.z);
    s.dodgeDuration = D.duration;
    s.dodgeDistance = D.distance;
    p.model.play('Dodge_Forward', { fade: 0.05, loop: false, speed: p.model.clipDuration('Dodge_Forward') / (D.duration * 0.9), restart: true });
  }
  p.ctx.fx.dustPuff(p.position, 8, 2.2);
  events.emit('player:dodge', { position: p.position.clone(), backstep: s.backstep });
}

/** Read-only view of the current dodge for other features (dodge attacks, perfect dodge). */
export const dodgeInfo = {
  get backstep() { return s.backstep; },
  get dir() { return s.dodgeDir; },
  get duration() { return s.dodgeDuration; },
};

function updateDodge(p: Player, dt: number) {
  const t = p.stateTime;
  const d = s.dodgeDuration;
  const u = Math.min(1, t / d);
  const base = s.dodgeDistance / (0.9 * d);
  const speed = base * (1.35 - 0.9 * u);
  p.velocity.x = s.dodgeDir.x * speed;
  p.velocity.z = s.dodgeDir.z * speed;
  p.invulnerable = t >= D.iframes[0] && t <= D.iframes[1];

  if (t > 0.12 && t < d * 0.8 && p.grounded) {
    s.footstep -= dt;
    if (s.footstep <= 0) {
      s.footstep = 0.09;
      p.ctx.fx.dustPuff(p.position, 3, 1.2, [0.2, 0.4]);
    }
  }

  if (t >= D.cancelAt && p.runInterrupts('cancel')) return;
  if (t >= d) p.goFree();
}

function dodgeVisual(p: Player, o: { pitch: number; lift: number; squash: number }) {
  if (s.backstep || !D.flip) return;
  const u = clamp((p.stateTime - 0.03) / (s.dodgeDuration * 0.78), 0, 1);
  o.pitch = easeInOutSine(u) * Math.PI * 2;
  const arc = Math.sin(u * Math.PI);
  o.lift = arc * 0.35;
  o.squash = 1 - arc * 0.28;
}

// ------------------------------------------------------------------ airdash
function enterAirDash(p: Player) {
  p.airDashCharges--;
  const dir = p.moveMag > 0.1 ? p.moveDir : p.forward;
  s.dodgeDir.copy(dir).setY(0).normalize();
  p.facing = Math.atan2(s.dodgeDir.x, s.dodgeDir.z);
  // Eight-way: hold jump = up-diagonal, hold sprint = down-diagonal (same on keyboard and pad).
  s.dashVert = 0;
  if (loadout.is('move.dashDir', 'eight-way')) {
    if (p.input.held('jump')) s.dashVert = Math.sin(M.dashUpAngle);
    else if (p.input.held('sprint')) s.dashVert = -Math.sin(M.dashDownAngle);
  }
  const flat = Math.sqrt(1 - s.dashVert * s.dashVert);
  p.velocity.set(s.dodgeDir.x * AD.speed * flat, s.dashVert * AD.speed, s.dodgeDir.z * AD.speed * flat);
  p.variableJump = false;
  s.afterimageTimer = 0;
  p.model.play('Dodge_Forward', { fade: 0.04, loop: false, speed: 1.1, startAt: 0.05, restart: true });
  p.ctx.cam.kickFov(7);
  p.ctx.fx.afterimage(0.35);
  p.ctx.fx.sparks.emit({
    count: 24, position: p.position.clone().setY(p.position.y + 1), spread: 0.3,
    velocity: s.dodgeDir.clone().multiplyScalar(-6), speed: 3, life: [0.2, 0.45], size: [0.05, 0.12],
    color: Colors.dash, color2: Colors.echoParticle, drag: 3,
  });
  const dir3 = s.dodgeDir.clone().multiplyScalar(flat).setY(s.dashVert);
  events.emit('player:airdash', { position: p.position.clone(), dir: dir3 });
}

function updateAirDash(p: Player, dt: number) {
  p.gravityScale = 0;
  const flat = Math.sqrt(1 - s.dashVert * s.dashVert);
  p.velocity.set(s.dodgeDir.x * AD.speed * flat, s.dashVert * AD.speed, s.dodgeDir.z * AD.speed * flat);
  s.afterimageTimer -= dt;
  if (s.afterimageTimer <= 0) {
    s.afterimageTimer = AD.afterimageInterval;
    p.ctx.fx.afterimage(0.3);
  }
  if (p.stateTime > 0.08 && p.runInterrupts('cancel')) return;
  if (p.stateTime >= AD.duration) {
    // Up-dashes keep some lift; down-dashes keep falling.
    const vy = s.dashVert > 0 ? AD.exitVy + s.dashVert * 7 : s.dashVert < 0 ? s.dashVert * 10 : AD.exitVy;
    p.velocity.set(s.dodgeDir.x * AD.exitSpeed * flat, vy, s.dodgeDir.z * AD.exitSpeed * flat);
    p.go('air');
    p.model.play('Jump_Idle', { fade: 0.15 });
  }
}

/** Horizontal (unit, y = 0) direction of the current dash / dodge (for other modules). */
export const dashDir = s.dodgeDir;
/** Extra info about the current air dash: `vert` = sine of the vertical angle (+ up, - down, 0 flat). */
export const dashInfo = {
  get vert() { return s.dashVert; },
};
