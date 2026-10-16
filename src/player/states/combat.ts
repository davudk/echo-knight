import { Color, Vector3 } from 'three';
import { CombatTuning, Tuning, type ComboInput, type MoveDef } from '../../config/tuning';
import { events } from '../../core/Events';
import { loadout } from '../../core/Loadout';
import { clamp, dampAngle, easeInOutSine } from '../../core/math';
import type { HitInfo, Hittable } from '../../world/World';
import { lockOn } from '../../camera/LockOn';
import type { Player, VisualPose } from '../Player';
import { installMoves } from './moves';

/**
 * Combat: a data-driven combo graph (light / heavy strings, launcher, air string, directional and
 * dodge attacks, charged releases) run by two states — `attack` (ground) and `airattack` — plus
 * the plunge. Special-behaviour moves (charge, whirlwind, dash strike) live in `moves.ts`.
 *
 * Move data: `Tuning.combo.steps` (the original L-L-L, untouched) + `CombatTuning.moves`.
 * Edges: `CombatTuning.edges` (node → { L, H } → next move id).
 */
const C = Tuning.combo;
const PL = Tuning.plunge;
const CT = CombatTuning;

export const DEFAULT_TRAIL_COLOR = new Color(1.6, 1.25, 0.85);

/** Every move in the graph by id (id = the `move` string in events / HitInfo / moveList). */
export const Moves: Record<string, MoveDef> = {
  light1: C.steps[0],
  light2: C.steps[1],
  slam: C.steps[2],
  ...CT.moves,
};

/** Follow `requires` → `fallback` until a move whose loadout toggle is on (null = none). */
export function resolveMove(id: string | undefined | null): string | null {
  for (let guard = 0; id && guard < 6; guard++) {
    const m = Moves[id];
    if (!m) return null;
    if (m.requires && !loadout.has(m.requires)) {
      id = m.fallback;
      continue;
    }
    return id;
  }
  return null;
}

/** Next move from graph node `from` on `input` (already resolved against the loadout). */
export function comboEdge(from: string, input: ComboInput): string | null {
  return resolveMove(CT.edges[from]?.[input]);
}

export interface AttackData {
  id: string;
  /** position in the string (0 = opener) — drives the HUD pips */
  depth?: number;
}

const s = {
  id: 'light1',
  move: C.steps[0] as MoveDef,
  depth: 0,
  hits: [] as boolean[],
  slamDone: false,
  hopDone: false,
  leapDone: false,
  slamPending: false,
  plungeLanded: 0,
  afterimageTimer: 0,
  /** last finished move (continuation within `Tuning.combo.resetWindow`) */
  lastMove: '' as string,
  /** launcher connected during the current move */
  launchHit: false,
  /** time left in which air slashes are allowed without a nearby target */
  launchTimer: 0,
  /** air moves used this airtime */
  airCount: 0,
  /** targets struck by this move's swing (its shockwave skips them) */
  struck: new Set<Hittable>(),
};

/** Read-only view for other modules (HUD, training). */
export const combatInfo = {
  get move() { return s.id; },
  get depth() { return s.depth; },
  get launchTimer() { return s.launchTimer; },
};

export function installCombat(p: Player) {
  p.registerState('attack', { enter: enterAttack, update: updateAttack, exit: exitAttack, visual: attackVisual });
  p.registerState('airattack', { enter: enterAttack, update: updateAttack, exit: exitAttack, visual: attackVisual });
  p.registerState('plunge', { enter: enterPlunge, update: updatePlunge, visual: plungeVisual });
  p.attackStates.add('airattack');

  // Ground attacks: openers, string continuation after a short pause, directional, dodge fallback.
  p.registerInterrupt({
    name: 'attack', priority: 80, contexts: ['ground', 'cancel'],
    check: (pl, _ctx, from) => {
      if (pl.attacking || from === 'plunge' || !pl.grounded) return false; // chaining is handled inside the attack state
      const L = pl.input.buffered('attack', C.inputBuffer);
      const H = pl.input.buffered('heavy', C.inputBuffer);
      if (!L && !H) return false;
      const input: ComboInput = L ? 'L' : 'H';
      pl.input.clearBuffer(L ? 'attack' : 'heavy');
      let id: string | null = null;
      const dir = directionalInput(pl);
      if (input === 'H' && dir === 'forward') id = resolveMove('lungeStab');
      else if (input === 'L' && dir === 'back') id = resolveMove('backflip');
      // Attacking out of a roll always starts the chain fresh.
      let depth = 0;
      if (!id && from !== 'dodge' && pl.comboNext > 0 && s.lastMove) {
        id = comboEdge(s.lastMove, input);
        if (id) depth = s.depth + 1;
      }
      id ??= comboEdge('root', input);
      if (!id) return false;
      pl.go('attack', { id, depth } satisfies AttackData);
      return true;
    },
  });

  // Air slashes near a target (or after a launcher); otherwise the plunge below takes the press.
  p.registerInterrupt({
    name: 'airattack', priority: 82, contexts: ['air', 'cancel'],
    check: (pl, _ctx, from) => {
      if (pl.grounded || pl.attacking || !pl.input.buffered('attack', 0.12)) return false;
      if (s.airCount >= CT.air.maxHits) return false;
      if (s.launchTimer <= 0 && !nearTarget(pl)) return false;
      const id = comboEdge('airRoot', 'L');
      if (!id) return false;
      pl.input.clearBuffer('attack');
      pl.go('airattack', { id, depth: 0 } satisfies AttackData);
      void from;
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

  // Launcher follow-up: jumping out of a connected launcher goes higher (chase the target).
  p.registerInterrupt({
    name: 'launch-jump', priority: 101, contexts: ['cancel'],
    check: (pl, _ctx, from) => {
      if (from !== 'attack' || s.id !== 'launcher' || !s.launchHit) return false;
      if (!pl.input.consume('jump', Tuning.jump.bufferTime)) return false;
      pl.velocity.y = CT.air.launchJumpVy;
      pl.grounded = false;
      pl.jumpsUsed = Math.max(1, pl.jumpsUsed);
      pl.variableJump = true;
      pl.ctx.fx.dustPuff(pl.position, 8, 2);
      pl.ctx.fx.afterimage(0.25);
      events.emit('player:jump', { position: pl.position.clone(), airJump: 0 });
      pl.go('air', { jumped: true });
      return true;
    },
  });

  p.landHandlers.unshift((pl) => {
    s.airCount = 0;
    if (pl.state === 'attack' && s.slamPending) {
      s.slamPending = false;
      s.hits[0] = true;
      doSlam(pl, s.move.aoe!, s.id);
      return true;
    }
    if (pl.state === 'airattack') {
      pl.go('move');
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

  installMoves(p);
}

/** Called every gameplay tick by the moves feature (timers that outlive a state). */
export function tickCombat(dt: number) {
  s.launchTimer = Math.max(0, s.launchTimer - dt);
}

// ------------------------------------------------------------------ helpers
/** 'forward' / 'back' when the stick points toward / away from the facing (or lock target). */
export function directionalInput(p: Player): 'forward' | 'back' | null {
  if (!loadout.has('combat.directional') || p.moveMag < 0.5) return null;
  const ref = lockOn.target ? lockOn.dirTo(p.position) : p.forward;
  const dot = p.moveDir.x * ref.x + p.moveDir.z * ref.z;
  const hs = Math.hypot(p.velocity.x, p.velocity.z);
  if (dot > CT.directionalDot && (lockOn.target || hs > Tuning.player.walkSpeed + 0.5)) return 'forward';
  // Unlocked: only from (near) standstill, so turning around while running never backflips.
  if (dot < -CT.directionalDot && (lockOn.target || hs < 2)) return 'back';
  return null;
}

function nearTarget(p: Player): boolean {
  for (const t of p.ctx.world.targets) {
    if (t.alive === false) continue;
    const d = Math.hypot(t.position.x - p.position.x, t.position.z - p.position.z);
    const dy = t.position.y - (p.position.y + 1);
    if (d < CT.air.nearRange + t.radius && Math.abs(dy) < CT.air.nearHeight) return true;
  }
  return false;
}

/** Turn toward the lock target (if any) or the stick. */
export function aimAtTarget(p: Player, dt: number | null, sharpness = 20, useStick = true) {
  let yaw: number | null = null;
  if (lockOn.target) {
    const d = lockOn.dirTo(p.position);
    yaw = Math.atan2(d.x, d.z);
  } else if (useStick && p.moveMag > 0.1) {
    yaw = Math.atan2(p.moveDir.x, p.moveDir.z);
  }
  if (yaw === null) return;
  p.facing = dt === null ? yaw : dampAngle(p.facing, yaw, sharpness, dt);
}

export function emitAttack(p: Player, move: string, clip: string, speed: number, clipStart: number, heavy: boolean) {
  events.emit('player:attack', {
    move, clip, speed, clipStart, heavy, position: p.position.clone(), facing: p.facing,
  });
}

// ------------------------------------------------------------------ attack runner
function enterAttack(p: Player, data?: unknown) {
  let id = 'light1';
  let depth = 0;
  if (typeof data === 'number') id = ['light1', 'light2', 'slam'][data] ?? 'light1'; // legacy index
  else if (data && typeof data === 'object') {
    id = (data as AttackData).id;
    depth = (data as AttackData).depth ?? 0;
  }
  const m = Moves[id] ?? Moves.light1;
  s.id = id;
  s.move = m;
  s.depth = depth;
  s.hits = [false, ...(m.extraHits ?? []).map(() => false)];
  s.slamDone = false;
  s.hopDone = false;
  s.leapDone = false;
  s.slamPending = false;
  s.launchHit = false;
  s.struck.clear();
  p.comboShown = Math.min(2, depth);

  if (m.air) {
    s.airCount++;
    // Hang in place: stop any rise (low air gravity would otherwise carry a jump much higher) but never add height.
    p.velocity.y = Math.min(p.velocity.y, 0) * 0.2;
    p.velocity.x *= 0.4;
    p.velocity.z *= 0.4;
  }
  if (m.pose !== 'backflip') aimAtTarget(p, null);
  else aimAtTarget(p, null, 20, false);
  if (p.trail && !id.startsWith('charged')) p.trail.setColor(DEFAULT_TRAIL_COLOR);

  p.model.play(m.clip, { fade: 0.06, loop: false, speed: m.speed, startAt: m.clipStart, restart: true });
  p.input.clearBuffer('attack');
  if (m.heavy || id.startsWith('heavy')) p.input.clearBuffer('heavy');
  emitAttack(p, id, m.clip, m.speed, m.clipStart, !!m.heavy);
}

function exitAttack(p: Player) {
  if (p.trail) {
    p.trail.active = false;
    p.trail.setColor(DEFAULT_TRAIL_COLOR);
  }
  p.sinceAttack = 0;
  s.lastMove = s.id;
  const edges = CT.edges[s.id];
  const more = !!edges && Object.keys(edges).length > 0;
  p.comboNext = more ? 1 : 0;
  if (!more) p.comboShown = -1;
  s.slamPending = false;
}

function updateAttack(p: Player, dt: number) {
  const m = s.move;
  const t = p.stateTime;
  const fwd = p.forward;

  // Early steering toward the stick / lock target.
  if (t < 0.08 && m.pose !== 'backflip') aimAtTarget(p, dt, 20);

  // Whirlwind: the second button of a light+heavy pair arrives a few frames after the first.
  if (s.depth === 0 && t <= CT.simultaneousWindow + 0.02 && p.grounded && !m.air && loadout.has('combat.spin') &&
    (s.id === 'light1' || s.id === 'heavy1' || s.id === 'backflip' || s.id === 'lungeStab')) {
    const other = m.heavy ? 'attack' : 'heavy';
    if (p.input.consume(other, CT.simultaneousWindow + 0.02)) return p.go('spin');
  }

  // Charged heavy: still holding heavy after the wind-up → charge.
  if (m.chargeable && !s.hits[0] && loadout.has('combat.chargeHeavy') && p.grounded &&
    p.input.held('heavy') && p.input.heldFor('heavy') >= CT.charge.holdTime) {
    return p.go('charge');
  }

  if (m.air) {
    p.gravityScale = m.air.gravity;
    p.fullJumpArc = true;
  }

  // Lunge only along the stick: no movement input = attack in place; partial tilt = shorter step.
  const l = m.lunge;
  const inLunge = l.end > l.start && t >= l.start && t <= l.end;
  if (inLunge && p.moveMag > 0.1) {
    const sp = l.distance / Math.max(0.01, l.end - l.start);
    const sc = sp * (m.leap ? 1 : 1.5 - (t - l.start) / (l.end - l.start)) * Math.min(1, p.moveMag);
    p.velocity.x = p.moveDir.x * sc;
    p.velocity.z = p.moveDir.z * sc;
  } else if (p.grounded) {
    const k = Math.exp(-14 * dt);
    p.velocity.x *= k;
    p.velocity.z *= k;
  } else if (m.air || m.leap) {
    const k = Math.exp(-4 * dt);
    p.velocity.x *= k;
    p.velocity.z *= k;
  }

  if (m.hop && !s.hopDone && t >= m.hop.at) {
    s.hopDone = true;
    p.velocity.y = m.hop.vy;
    p.velocity.x = fwd.x * m.hop.forward;
    p.velocity.z = fwd.z * m.hop.forward;
    p.grounded = false;
    if (m.pose === 'backflip') p.ctx.fx.dustPuff(p.position, 6, 1.6);
  }
  if (m.hop && s.hopDone && !p.grounded) p.fullJumpArc = true;

  if (m.leap && !s.leapDone && t >= m.leap.at) {
    s.leapDone = true;
    s.slamPending = true;
    p.velocity.y = m.leap.vy;
    p.grounded = false;
    p.fullJumpArc = true;
    p.ctx.fx.dustPuff(p.position, 8, 2);
  }
  if (s.slamPending) p.fullJumpArc = true;

  if (!m.leap) {
    const times = [m.hitAt, ...(m.extraHits ?? [])];
    for (let i = 0; i < times.length; i++) {
      if (!s.hits[i] && t >= times[i]) {
        s.hits[i] = true;
        moveHit(p, m);
      }
    }
  }
  if (m.slamAt !== undefined && m.aoe && !s.slamDone && t >= m.slamAt) {
    s.slamDone = true;
    doSlam(p, m.aoe, s.id, { ...m.effect }, s.struck);
  }

  if (p.trail) p.trail.active = t >= m.trail[0] && t <= m.trail[1];

  if (t >= m.chainAt && !s.slamPending) {
    for (const input of ['L', 'H'] as ComboInput[]) {
      const next = comboEdge(s.id, input);
      if (next && p.input.consume(input === 'L' ? 'attack' : 'heavy', t + 0.05)) {
        return p.go(m.air ? 'airattack' : 'attack', { id: next, depth: s.depth + 1 } satisfies AttackData);
      }
    }
  }
  if (t >= m.cancelAt && !s.slamPending && p.runInterrupts('cancel')) return;
  if (t >= m.moveCancelAt && p.moveMag > 0.3 && p.grounded && !s.slamPending) return p.go(lockOn.target && p.states.has('lockmove') ? 'lockmove' : 'move');
  if (t >= m.end && !s.slamPending) return p.goFree();
  if (t > m.end + 1.5) p.go('air');
}

function moveHit(p: Player, m: MoveDef) {
  const hits = swingHit(p, m.hit, s.id, { heavy: !!m.heavy, ...m.effect }, { hitstop: m.hitstop, shake: m.shake });
  for (const h of hits) s.struck.add(h);
  if (hits.length && m.effect?.launch && m.effect.launch > 0 && !m.air) {
    s.launchHit = true;
    s.launchTimer = CT.air.launchWindow;
    p.ctx.cam.kickFov(3);
  }
  if (hits.length && m.air) {
    // Hang: each connecting air hit halts the fall so the juggle can continue (no extra height).
    p.velocity.y = Math.max(p.velocity.y, 0);
  }
  return hits;
}

function attackVisual(p: Player, o: VisualPose) {
  const m = s.move;
  const t = p.stateTime;
  switch (m.pose) {
    case 'backflip': {
      const u = clamp((t - 0.02) / 0.5, 0, 1);
      o.pitch = -easeInOutSine(u) * Math.PI * 2;
      o.lift = Math.sin(u * Math.PI) * 0.3;
      break;
    }
    case 'low': {
      const u = clamp(t / 0.12, 0, 1) * clamp((m.end - t) / 0.2, 0, 1);
      o.pitch = 0.32 * u;
      o.lift = -0.28 * u;
      o.squash = 1 - 0.12 * u;
      break;
    }
    case 'rise': {
      const u = clamp((t - 0.06) / 0.12, 0, 1) * clamp((m.end - t) / 0.25, 0, 1);
      o.pitch = -0.28 * u;
      o.lift = 0.12 * u;
      break;
    }
    case 'dive':
      o.pitch = 0.4 * clamp(t / 0.15, 0, 1);
      break;
  }
}

// ------------------------------------------------------------------ hit helpers
export interface HitFeel {
  hitstop?: number;
  shake?: number;
}

/** Deliver one hit to one target and emit 'player:hit'. */
export function applyHit(target: Hittable, info: HitInfo, move: string) {
  target.onHit(info);
  events.emit('player:hit', { target, info, move });
}

/** Cone hit in front of the player. Exported for other attack modules. */
export function swingHit(
  p: Player,
  hit: { range: number; arcDeg: number; damage: number; knockback: number },
  move: string,
  extra: Partial<HitInfo> = {},
  feel: HitFeel = {},
) {
  const fwd = p.forward.clone();
  const origin = p.position.clone().setY(p.position.y + 1);
  const hits = p.ctx.world.queryCone(origin, fwd, hit.range, hit.arcDeg);
  for (const h of hits) {
    const dir = new Vector3(h.position.x - origin.x, 0, h.position.z - origin.z);
    if (dir.lengthSq() < 1e-4) dir.copy(fwd);
    dir.normalize();
    const info: HitInfo = { damage: hit.damage, dir, knockback: hit.knockback, heavy: false, source: 'player', move, ...extra };
    applyHit(h, info, move);
  }
  if (hits.length) {
    p.ctx.hitstop(feel.hitstop ?? (extra.heavy ? Tuning.feel.hitstopHeavy : Tuning.feel.hitstop));
    p.ctx.cam.shake(feel.shake ?? (extra.heavy ? 0.4 : 0.22));
  }
  return hits;
}

/** Ground slam AoE in front of the player. Exported for other attack modules. */
export function doSlam(
  p: Player,
  aoe: { radius: number; damage: number; knockback: number },
  move: string,
  extra: Partial<HitInfo> = {},
  exclude?: Set<Hittable>,
) {
  const center = p.position.clone().addScaledVector(p.forward, 0.8);
  center.y = p.ctx.world.groundAt(center.x, center.z, p.position.y + 0.5);
  p.ctx.fx.slam(center, aoe.radius);
  p.ctx.cam.shake(0.55);
  p.ctx.cam.kickFov(4);
  events.emit('player:slam', { position: center.clone(), radius: aoe.radius });
  const hits = p.ctx.world.querySphere(center, aoe.radius).filter((h) => !exclude?.has(h));
  for (const h of hits) {
    const dir = new Vector3(h.position.x - center.x, 0, h.position.z - center.z);
    if (dir.lengthSq() < 1e-4) dir.copy(p.forward);
    dir.normalize();
    const info: HitInfo = { damage: aoe.damage, dir, knockback: aoe.knockback, heavy: true, source: 'player', move, ...extra };
    applyHit(h, info, move);
  }
  p.ctx.hitstop(hits.length ? Tuning.feel.hitstopHeavy : 0.04);
  return hits;
}

// ------------------------------------------------------------------ plunge
function enterPlunge(p: Player) {
  s.plungeLanded = 0;
  p.velocity.x *= 0.25;
  p.velocity.z *= 0.25;
  p.velocity.y = 0; // brief hang at the current height, then dive (no upward hop)
  p.model.play('1H_Melee_Attack_Chop', { fade: 0.05, loop: false, speed: 1.0, startAt: 0.15, restart: true });
  if (p.trail) p.trail.active = true;
  emitAttack(p, 'plunge', '1H_Melee_Attack_Chop', 1, 0.15, true);
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
