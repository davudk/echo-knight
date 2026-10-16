import { Color, Vector3 } from 'three';
import { CombatTuning, Tuning } from '../../config/tuning';
import type { Game } from '../../core/Game';
import { loadout } from '../../core/Loadout';
import { dampAngle } from '../../core/math';
import { installLockOn, lateUpdateLockOn, updateLockOn } from '../../camera/LockOn';
import { Colors } from '../../fx/Fx';
import type { Feature } from '../../features';
import type { HitInfo, Hittable } from '../../world/World';
import type { Player } from '../Player';
import { dashDir } from './locomotion';
import { aimAtTarget, applyHit, DEFAULT_TRAIL_COLOR, emitAttack, swingHit, tickCombat, type AttackData } from './combat';

/**
 * Special-behaviour moves that don't fit the combo-graph runner:
 *  - charge     hold heavy → 3 tiers → release (combat.chargeHeavy)
 *  - spin       light + heavy together → steerable whirlwind (combat.spin)
 *  - dashstrike attack during an air dash → piercing strike along the dash (combat.dodgeAttacks)
 * plus the roll → sweep interrupt (combat.dodgeAttacks).
 */
const CT = CombatTuning;
const CH = CT.charge;
const SP = CT.spin;
const DS = CT.dashStrike;

const s = {
  tier: 0,
  sparkTimer: 0,
  spinNextHit: 0,
  dashDir: new Vector3(),
  dashHit: new Set<Hittable>(),
  afterimageTimer: 0,
};

const tierColors = CH.colors.map(([r, g, b]) => new Color(r, g, b));
const tmp = new Vector3();

export function installMoves(p: Player) {
  p.registerState('charge', { enter: enterCharge, update: updateCharge, exit: exitCharge, visual: chargeVisual });
  p.registerState('spin', { enter: enterSpin, update: updateSpin, exit: exitTrail });
  p.registerState('dashstrike', { enter: enterDashStrike, update: updateDashStrike, exit: exitTrail, visual: (_p, o) => (o.pitch = 0.3) });
  for (const n of ['charge', 'spin', 'dashstrike']) p.attackStates.add(n);

  // Light + heavy pressed together (either order, within the window) → whirlwind.
  p.registerInterrupt({
    name: 'whirlwind', priority: 86, contexts: ['ground', 'cancel'],
    check: (pl) => {
      if (!pl.grounded || pl.attacking || !loadout.has('combat.spin')) return false;
      const w = CT.simultaneousWindow;
      if (!pl.input.buffered('attack', w) || !pl.input.buffered('heavy', w)) return false;
      pl.go('spin');
      return true;
    },
  });

  // Roll → attack: low sweep that pops the target up.
  p.registerInterrupt({
    name: 'dodge-sweep', priority: 85, contexts: ['cancel'],
    check: (pl, _ctx, from) => {
      if (from !== 'dodge' || !pl.grounded || !loadout.has('combat.dodgeAttacks')) return false;
      if (!pl.input.consume('attack', Tuning.combo.inputBuffer)) return false;
      pl.go('attack', { id: 'sweep', depth: 0 } satisfies AttackData);
      return true;
    },
  });

  // Air dash → attack: piercing strike that keeps the dash going.
  p.registerInterrupt({
    name: 'dash-strike', priority: 85, contexts: ['cancel'],
    check: (pl, _ctx, from) => {
      if (from !== 'airdash' || !loadout.has('combat.dodgeAttacks')) return false;
      if (!pl.input.consume('attack', 0.15)) return false;
      pl.go('dashstrike');
      return true;
    },
  });
}

/** Feature hook: lock-on + combat timers. */
export const offenseFeature: Feature = {
  name: 'offense',
  install(game: Game) {
    installLockOn(game);
  },
  update(dt, game) {
    tickCombat(dt);
    updateLockOn(game, dt);
  },
  lateUpdate(_dt, game) {
    lateUpdateLockOn(game);
  },
};

function exitTrail(p: Player) {
  if (p.trail) {
    p.trail.active = false;
    p.trail.setColor(DEFAULT_TRAIL_COLOR);
  }
  p.sinceAttack = 0;
  p.comboNext = 0;
  p.comboShown = -1;
}

function bladeTip(p: Player, out: Vector3) {
  const m = p.model;
  if (!m.sword) return out.copy(p.position).setY(p.position.y + 1.4);
  m.sword.updateWorldMatrix(true, false);
  return out.copy(m.swordTip).applyMatrix4(m.sword.matrixWorld);
}

// ------------------------------------------------------------------ charge
function enterCharge(p: Player) {
  s.tier = 0;
  s.sparkTimer = 0;
  // Hold the raised pose of the overhead chop (barely moving, so it reads as "straining").
  p.model.play('2H_Melee_Attack_Chop', { fade: 0.12, loop: false, speed: 0.04, startAt: 0.52, restart: true });
  if (p.trail) p.trail.active = false;
  p.comboShown = 0;
}

function chargeTierAt(t: number) {
  const T = CH.tierTimes;
  return t >= T[2] ? 3 : t >= T[1] ? 2 : 1;
}

function updateCharge(p: Player, dt: number) {
  const t = p.stateTime;
  const tier = chargeTierAt(t);
  if (tier !== s.tier) {
    s.tier = tier;
    const c = tierColors[tier - 1];
    p.trail?.setColor(c);
    const tip = bladeTip(p, tmp);
    p.ctx.fx.sparks.emit({
      count: 10 + tier * 10, position: tip, spread: 0.1, speed: 2 + tier * 1.5, life: [0.2, 0.45],
      size: [0.05, 0.12], color: c, color2: Colors.spark, drag: 3,
    });
    p.ctx.fx.waves.spawn(p.position.clone().setY(p.position.y + 0.05), 0.9 + tier * 0.5, c, 0.3, 0.12);
    p.ctx.cam.kickFov(1 + tier);
    if (tier === 3) p.ctx.cam.shake(0.15);
  }

  // Blade glow: a pulsing orb + drifting sparks at the tip, growing with the tier.
  s.sparkTimer -= dt;
  if (s.sparkTimer <= 0) {
    s.sparkTimer = 0.035;
    const tip = bladeTip(p, tmp);
    const c = tierColors[s.tier - 1];
    const size = 0.45 + s.tier * 0.25 + Math.sin(t * 30) * 0.08;
    p.ctx.fx.sparks.emit({ count: 1, position: tip, speed: 0, life: [0.07, 0.07], size: [size, size], color: c });
    p.ctx.fx.sparks.emit({
      count: s.tier, position: tip, spread: 0.12, speed: 0.8, upBias: 0.6, life: [0.2, 0.4],
      size: [0.04, 0.08], color: c, color2: Colors.spark, gravity: -2, drag: 2,
    });
  }

  // Slow walk while charging; face the lock target or the stick.
  if (p.moveMag > 0.1) p.accelerateHorizontal(p.moveDir, CH.walkSpeed * p.moveMag, 20, dt);
  else p.accelerateHorizontal(p.moveDir, 0, 30, dt);
  aimAtTarget(p, dt, 8);

  if (!p.grounded) return p.go('air');
  if (p.runInterrupts('cancel')) return; // roll / jump out of a charge
  if (!p.input.held('heavy')) {
    p.go('attack', { id: `charged${s.tier}`, depth: 0 } satisfies AttackData);
  }
}

function exitCharge(p: Player, next: string) {
  p.sinceAttack = 0;
  if (next !== 'attack' && p.trail) p.trail.setColor(DEFAULT_TRAIL_COLOR);
}

function chargeVisual(p: Player, o: { pitch: number; squash: number }) {
  const t = p.stateTime;
  o.pitch = -0.12 - 0.04 * s.tier + Math.sin(t * 40) * 0.006 * s.tier;
  o.squash = 1 - 0.03 * s.tier;
}

// ------------------------------------------------------------------ whirlwind
function enterSpin(p: Player) {
  p.input.clearBuffer('attack');
  p.input.clearBuffer('heavy');
  s.spinNextHit = 0.06;
  p.model.play(SP.clip, { fade: 0.08, loop: true, speed: SP.clipSpeed, restart: true });
  if (p.trail) p.trail.active = true;
  p.comboShown = 2;
  emitAttack(p, 'whirlwind', SP.clip, SP.clipSpeed, 0, true);
}

function updateSpin(p: Player, dt: number) {
  const t = p.stateTime;
  if (p.moveMag > 0.1) {
    p.accelerateHorizontal(p.moveDir, SP.moveSpeed * p.moveMag, 30, dt);
    p.facing = dampAngle(p.facing, Math.atan2(p.moveDir.x, p.moveDir.z), 6, dt);
  } else {
    p.accelerateHorizontal(p.moveDir, 0, 25, dt);
  }
  if (t >= s.spinNextHit && t < SP.duration) {
    s.spinNextHit += SP.hitInterval;
    swingHit(p, SP.hit, 'whirlwind', { stagger: 0.3 }, { hitstop: 0.025, shake: 0.1 });
    p.ctx.fx.dustPuff(p.position, 3, 2.5, [0.2, 0.35]);
  }
  if (t >= SP.cancelAt && p.runInterrupts('cancel')) return;
  if (t >= SP.duration) p.goFree();
}

// ------------------------------------------------------------------ dash strike
function enterDashStrike(p: Player) {
  s.dashDir.copy(dashDir).setY(0);
  if (s.dashDir.lengthSq() < 1e-4) s.dashDir.copy(p.forward);
  s.dashDir.normalize();
  p.facing = Math.atan2(s.dashDir.x, s.dashDir.z);
  s.dashHit.clear();
  s.afterimageTimer = 0;
  p.model.play(DS.clip, { fade: 0.04, loop: false, speed: DS.clipSpeed, startAt: DS.clipStart, restart: true });
  if (p.trail) {
    p.trail.setColor(Colors.dash);
    p.trail.active = true;
  }
  p.ctx.cam.kickFov(5);
  emitAttack(p, 'dashStrike', DS.clip, DS.clipSpeed, DS.clipStart, false);
}

function updateDashStrike(p: Player, dt: number) {
  const t = p.stateTime;
  p.gravityScale = 0;
  p.velocity.set(s.dashDir.x * DS.speed, 0, s.dashDir.z * DS.speed);

  s.afterimageTimer -= dt;
  if (s.afterimageTimer <= 0) {
    s.afterimageTimer = 0.03;
    p.ctx.fx.afterimage(0.3);
  }

  // Everything along the path, once each.
  const center = tmp.copy(p.position).setY(p.position.y + 1);
  for (const h of p.ctx.world.querySphere(center, DS.radius)) {
    if (s.dashHit.has(h)) continue;
    s.dashHit.add(h);
    const dir = new Vector3(h.position.x - center.x, 0, h.position.z - center.z);
    // push sideways off the path + along it
    dir.addScaledVector(s.dashDir, 1.5).normalize();
    const info: HitInfo = { damage: DS.damage, dir, knockback: DS.knockback, heavy: false, source: 'player', move: 'dashStrike', stagger: 0.6 };
    applyHit(h, info, 'dashStrike');
    p.ctx.hitstop(0.04);
    p.ctx.cam.shake(0.2);
  }

  if (t > 0.12 && p.runInterrupts('cancel')) return;
  if (t >= DS.duration) {
    p.velocity.set(s.dashDir.x * DS.exitSpeed, Tuning.airDash.exitVy, s.dashDir.z * DS.exitSpeed);
    p.goFree();
  }
}
