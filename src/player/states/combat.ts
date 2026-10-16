import { Color, Vector3 } from 'three';
import { Tuning, type ComboStep } from '../../config/tuning';
import { events } from '../../core/Events';
import { dampAngle } from '../../core/math';
import type { HitInfo } from '../../world/World';
import type { Player } from '../Player';

/**
 * Combat states: attack (3-step light combo with Riven-style slam finisher) and plunge.
 * The offense stream extends this with heavies, strings, launchers, etc.
 */
const C = Tuning.combo;
const PL = Tuning.plunge;

const s = {
  step: null as ComboStep | null,
  stepIndex: 0,
  hitDone: false,
  leapDone: false,
  slamPending: false,
  plungeLanded: 0,
  afterimageTimer: 0,
};

export function installCombat(p: Player) {
  p.registerState('attack', { enter: enterAttack, update: updateAttack, exit: exitAttack });
  p.registerState('plunge', { enter: enterPlunge, update: updatePlunge, visual: plungeVisual });

  p.registerInterrupt({
    name: 'attack', priority: 80, contexts: ['ground', 'cancel'],
    check: (pl, _ctx, from) => {
      if (from === 'attack') return false; // chaining is handled inside the attack state
      if (!pl.grounded || !pl.input.consume('attack', C.inputBuffer)) return false;
      // Attacking out of a roll always starts the chain fresh.
      pl.go('attack', from === 'dodge' ? 0 : pl.comboNext);
      return true;
    },
  });
  p.registerInterrupt({
    name: 'plunge', priority: 80, contexts: ['air', 'cancel'],
    check: (pl) => {
      if (pl.grounded || !pl.input.buffered('attack', 0.1) || pl.heightAboveGround() <= 1.1) return false;
      pl.input.clearBuffer('attack');
      pl.go('plunge');
      return true;
    },
  });

  p.landHandlers.unshift((pl) => {
    if (pl.state === 'attack' && s.slamPending) {
      s.slamPending = false;
      s.hitDone = true;
      doSlam(pl, s.step!.aoe!, 'slam');
      return true;
    }
    if (pl.state === 'plunge' && s.plungeLanded === 0) {
      s.plungeLanded = pl.stateTime;
      doSlam(pl, PL.aoe, 'plunge');
      if (pl.trail) pl.trail.active = false;
      return true;
    }
    return false;
  });
}

// ------------------------------------------------------------------ attack
function enterAttack(p: Player, data?: unknown) {
  const index = typeof data === 'number' ? data : 0;
  const step = C.steps[index];
  s.step = step;
  s.stepIndex = index;
  p.comboShown = index;
  s.hitDone = false;
  s.leapDone = false;
  s.slamPending = false;
  p.faceMoveDir();
  p.model.play(step.clip, { fade: 0.06, loop: false, speed: step.speed, startAt: step.clipStart, restart: true });
  p.input.clearBuffer('attack');
  events.emit('player:attack', {
    move: `light${index + 1}`, clip: step.clip, speed: step.speed, clipStart: step.clipStart, heavy: false,
    position: p.position.clone(), facing: p.facing,
  });
}

function exitAttack(p: Player) {
  if (p.trail) p.trail.active = false;
  p.sinceAttack = 0;
  const last = s.stepIndex >= C.steps.length - 1;
  p.comboNext = last ? 0 : s.stepIndex + 1;
  if (last) p.comboShown = -1;
  s.slamPending = false;
}

function updateAttack(p: Player, dt: number) {
  const step = s.step!;
  const t = p.stateTime;
  const fwd = p.forward;

  if (t < 0.08 && p.moveMag > 0.1) {
    p.facing = dampAngle(p.facing, Math.atan2(p.moveDir.x, p.moveDir.z), 20, dt);
  }

  const l = step.lunge;
  if (t >= l.start && t <= l.end) {
    const sp = l.distance / Math.max(0.01, l.end - l.start);
    const sc = sp * (step.leap ? 1 : 1.5 - (t - l.start) / (l.end - l.start));
    p.velocity.x = fwd.x * sc;
    p.velocity.z = fwd.z * sc;
  } else if (p.grounded) {
    const k = Math.exp(-14 * dt);
    p.velocity.x *= k;
    p.velocity.z *= k;
  }

  if (step.leap && !s.leapDone && t >= step.leap.at) {
    s.leapDone = true;
    s.slamPending = true;
    p.velocity.y = step.leap.vy;
    p.grounded = false;
    p.fullJumpArc = true;
    p.ctx.fx.dustPuff(p.position, 8, 2);
  }
  if (s.slamPending) p.fullJumpArc = true;

  if (!step.leap && !s.hitDone && t >= step.hitAt) {
    s.hitDone = true;
    swingHit(p, step.hit, `light${s.stepIndex + 1}`);
  }

  if (p.trail) p.trail.active = t >= step.trail[0] && t <= step.trail[1];

  if (t >= step.chainAt && s.stepIndex < C.steps.length - 1 && !s.slamPending && p.input.consume('attack', t + 0.05)) {
    return p.go('attack', s.stepIndex + 1);
  }
  if (t >= step.cancelAt && !s.slamPending && p.runInterrupts('cancel')) return;
  if (t >= step.moveCancelAt && p.moveMag > 0.3 && p.grounded && !s.slamPending) return p.go('move');
  if (t >= step.end && !s.slamPending) return p.goFree();
  if (t > step.end + 1.5) p.go('air');
}

/** Cone hit in front of the player. Exported for other attack modules. */
export function swingHit(
  p: Player,
  hit: { range: number; arcDeg: number; damage: number; knockback: number },
  move: string,
  extra: Partial<HitInfo> = {},
) {
  const fwd = p.forward.clone();
  const origin = p.position.clone().setY(p.position.y + 1);
  const hits = p.ctx.world.queryCone(origin, fwd, hit.range, hit.arcDeg);
  for (const h of hits) {
    const dir = new Vector3(h.position.x - origin.x, 0, h.position.z - origin.z);
    if (dir.lengthSq() < 1e-4) dir.copy(fwd);
    dir.normalize();
    const info: HitInfo = { damage: hit.damage, dir, knockback: hit.knockback, heavy: false, source: 'player', move, ...extra };
    h.onHit(info);
    events.emit('player:hit', { target: h, info, move });
  }
  if (hits.length) {
    p.ctx.hitstop(extra.heavy ? Tuning.feel.hitstopHeavy : Tuning.feel.hitstop);
    p.ctx.cam.shake(extra.heavy ? 0.4 : 0.22);
  }
  return hits;
}

/** Ground slam AoE in front of the player. Exported for other attack modules. */
export function doSlam(p: Player, aoe: { radius: number; damage: number; knockback: number }, move: string, extra: Partial<HitInfo> = {}) {
  const center = p.position.clone().addScaledVector(p.forward, 0.8);
  center.y = p.ctx.world.groundAt(center.x, center.z, p.position.y + 0.5);
  p.ctx.fx.slam(center, aoe.radius);
  p.ctx.cam.shake(0.55);
  p.ctx.cam.kickFov(4);
  events.emit('player:slam', { position: center.clone(), radius: aoe.radius });
  const hits = p.ctx.world.querySphere(center, aoe.radius);
  for (const h of hits) {
    const dir = new Vector3(h.position.x - center.x, 0, h.position.z - center.z);
    if (dir.lengthSq() < 1e-4) dir.copy(p.forward);
    dir.normalize();
    const info: HitInfo = { damage: aoe.damage, dir, knockback: aoe.knockback, heavy: true, source: 'player', move, ...extra };
    h.onHit(info);
    events.emit('player:hit', { target: h, info, move });
  }
  p.ctx.hitstop(hits.length ? Tuning.feel.hitstopHeavy : 0.04);
  return hits;
}

// ------------------------------------------------------------------ plunge
function enterPlunge(p: Player) {
  s.plungeLanded = 0;
  p.velocity.x *= 0.25;
  p.velocity.z *= 0.25;
  p.velocity.y = 3;
  p.model.play('1H_Melee_Attack_Chop', { fade: 0.05, loop: false, speed: 1.0, startAt: 0.15, restart: true });
  if (p.trail) p.trail.active = true;
  events.emit('player:attack', {
    move: 'plunge', clip: '1H_Melee_Attack_Chop', speed: 1, clipStart: 0.15, heavy: true,
    position: p.position.clone(), facing: p.facing,
  });
}

function updatePlunge(p: Player, dt: number) {
  const t = p.stateTime;
  if (s.plungeLanded > 0) {
    p.velocity.x *= Math.exp(-20 * dt);
    p.velocity.z *= Math.exp(-20 * dt);
    if (p.trail) p.trail.active = false;
    if (t - s.plungeLanded > 0.15 && p.runInterrupts('cancel')) return;
    if (t - s.plungeLanded >= PL.recovery) p.go('move');
    return;
  }
  p.fullJumpArc = true;
  if (t < PL.hang) {
    p.gravityScale = 0.3;
  } else {
    p.gravityScale = 0;
    p.velocity.y = -PL.speed;
    s.afterimageTimer -= dt;
    if (s.afterimageTimer <= 0) {
      s.afterimageTimer = 0.045;
      p.ctx.fx.afterimage(0.25, new Color(2.2, 1.4, 0.6));
    }
  }
}

function plungeVisual(p: Player, o: { pitch: number }) {
  if (s.plungeLanded === 0 && p.stateTime > PL.hang) o.pitch = 0.25;
}
