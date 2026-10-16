import { Color, Vector3 } from 'three';
import { PromptLabels } from '../../config/bindings';
import { MoveList, type MoveEntry } from '../../config/moveList';
import { Tuning } from '../../config/tuning';
import { events } from '../../core/Events';
import type { Game } from '../../core/Game';
import { loadout } from '../../core/Loadout';
import { clamp, dampAngle } from '../../core/math';
import type { Feature } from '../../features';
import { DefenseHud } from '../../ui/DefenseHud';
import { StaminaBar } from '../../ui/StaminaBar';
import type { HitInfo } from '../../world/World';
import type { HitResult, IncomingHit, Player } from '../Player';

/**
 * Defense styles (loadout `defense.style`) and stamina (`defense.stamina`).
 *
 *  - block-parry:   hold block → `block` state (frontal 120°, chip damage). A press ≤ 0.15 s before a
 *                   frontal hit parries (slow-mo, enemy staggers) and arms a ×2 riposte for 1.2 s.
 *  - perfect-dodge: a roll started ≤ 0.2 s before a hit → witch time (world slow-mo, player near full
 *                   speed, blue tint). Block still blocks, no parry.
 *  - counter:       when an enemy within 3 m in front is ≤ 0.4 s from its hit frame, a prompt flashes
 *                   over it; pressing block then reverses the attack (`counter` state). Otherwise block.
 *  - stamina:       rolls / dashes / attacks / blocked hits cost stamina; presses without enough are
 *                   refused; a block with no stamina left is a guard break (0.6 s stagger).
 *
 * Everything hooks in through registries: states, interrupts, one defense handler, events.
 */
const D = Tuning.defense;
const S = D.stamina;
const C = D.counter;
const tmpV = new Vector3();

type Style = 'block-parry' | 'perfect-dodge' | 'counter';

/** Anything the counter style can reverse: enemies, bosses (`attacking` = a counterable swing is coming). */
export interface CounterThreat {
  readonly alive?: boolean;
  readonly attacking: boolean;
  readonly attackTimeRemaining: number;
  readonly feet: Vector3;
  readonly position: Vector3;
  readonly radius: number;
  onCountered(): void;
  onHit(info: HitInfo): void;
}
/** Extra counter-threat lists besides `game.enemies` (the boss framework registers one). */
export const counterThreatSources: (() => readonly CounterThreat[])[] = [];
const style = () => loadout.str('defense.style') as Style;

let game: Game;
let bar: StaminaBar;
let hud: DefenseHud;

/** Module state (single player). `clock` is gameplay time (scaled by slow-mo / hitstop). */
const s = {
  clock: 0,
  parryArmed: false,
  parryArmedAt: -99,
  parryCooldown: 0,
  /** time left to start a riposte after a parry */
  riposteTimer: 0,
  /** the current attack is a riposte (bonus damage on its hits) while > 0 */
  riposteActive: 0,
  blockReact: 0,
  /** witch time remaining (real seconds) */
  witch: 0,
  witchTotal: 1,
  counterTarget: null as CounterThreat | null,
  counterStruck: false,
  counterLockout: 0,
  guardBreakDir: new Vector3(),
};

/** Stamina pool (read by the HUD bar; other features may read it too). */
export const stamina = {
  value: S.max as number,
  max: S.max as number,
  sinceSpend: 99,
  denied: 0,
  get enabled() {
    return loadout.has('defense.stamina');
  },
};

export function spendStamina(cost: number) {
  if (!stamina.enabled || cost <= 0) return;
  stamina.value = Math.max(0, stamina.value - cost);
  stamina.sinceSpend = 0;
}

function hasStamina(cost: number) {
  return !stamina.enabled || stamina.value >= cost;
}

/** Moves for the training overlay (pushed into MoveList at install, avoids editing moveList.ts). */
export const DefenseMoves: (MoveEntry & { group?: string })[] = [
  { id: 'block', name: 'Block', input: '[B]', description: 'Hold to guard the front (120°): 20% chip damage, slower movement.', group: 'Defense' },
  {
    id: 'parry', name: 'Parry', input: 'B', description: 'Press block just before a frontal hit (0.15 s): no damage, enemy reels.',
    requires: 'defense.style=block-parry', group: 'Defense',
  },
  {
    id: 'riposte', name: 'Riposte', input: 'B → L / H', description: 'Attack within 1.2 s of a parry: double damage, big hitstop.',
    requires: 'defense.style=block-parry', group: 'Defense',
  },
  {
    id: 'perfect-dodge', name: 'Witch Time', input: 'D', description: 'Roll just before a hit lands: the world slows for 2 s.',
    requires: 'defense.style=perfect-dodge', group: 'Defense',
  },
  {
    id: 'counter', name: 'Counter', input: 'B', description: 'Press block when "!" flashes over an attacker: reverse its swing and strike back.',
    requires: 'defense.style=counter', group: 'Defense',
  },
];

// ------------------------------------------------------------------ feature
export const defenseFeature: Feature = {
  name: 'defense',
  install(g) {
    game = g;
    const p = g.player;
    p.registerState('block', { enter: enterBlock, update: updateBlock, exit: exitBlock });
    p.registerState('counter', { enter: enterCounter, update: updateCounter, exit: exitCounter, visual: counterVisual });
    p.registerState('guardbreak', { enter: enterGuardBreak, update: updateGuardBreak, visual: guardBreakVisual });

    p.registerInterrupt({ name: 'counter', priority: 120, contexts: ['ground', 'cancel'], check: tryCounter });
    p.registerInterrupt({
      name: 'block', priority: 85, contexts: ['ground', 'cancel'],
      check: (pl, _ctx, from) => from !== 'block' && from !== 'guardbreak' && pl.grounded && pl.input.held('block') && (pl.go('block'), true),
    });

    // Registered after hurt.ts's post-hit grace handler (enemy feature installs first): grace wins.
    p.registerDefense(defend);

    for (const m of DefenseMoves) if (!MoveList.some((x) => x.id === m.id)) MoveList.push(m);

    bar = new StaminaBar(g.hud);
    hud = new DefenseHud(g.hud);

    events.on('input:action', ({ action }) => onPress(action));
    events.on('player:dodge', () => spendStamina(S.roll));
    events.on('player:airdash', () => spendStamina(S.airDash));
    events.on('player:attack', ({ move, heavy }) => {
      if (move === 'counter') {
        s.riposteActive = 0;
        return;
      }
      spendStamina(heavy ? S.heavy : S.light);
      if (s.riposteTimer > 0) {
        s.riposteTimer = 0;
        s.riposteActive = 1.0;
      } else {
        s.riposteActive = 0;
      }
    });
    events.on('player:hit', ({ target, info }) => onPlayerHit(target, info));
    events.on('player:respawn', () => {
      stamina.value = stamina.max;
      endWitchTime();
    });
  },

  update(dt) {
    s.clock += dt;
    s.parryCooldown = Math.max(0, s.parryCooldown - dt);
    s.counterLockout = Math.max(0, s.counterLockout - dt);
    s.riposteTimer = Math.max(0, s.riposteTimer - dt);
    s.riposteActive = Math.max(0, s.riposteActive - dt);
    if (s.parryArmed && s.clock - s.parryArmedAt > D.parryWindow) {
      // missed: short lockout so mashing block doesn't parry everything
      s.parryArmed = false;
      s.parryCooldown = D.parryMissCooldown;
    }

    // stamina
    stamina.sinceSpend += dt;
    if (!stamina.enabled) {
      stamina.value = stamina.max;
    } else if (stamina.sinceSpend >= S.regenDelay) {
      const mul = game.player.state === 'block' ? S.blockRegenMul : 1;
      stamina.value = Math.min(stamina.max, stamina.value + S.regen * mul * dt);
    }
  },

  lateUpdate(dt) {
    const p = game.player;
    stamina.denied = Math.max(0, stamina.denied - dt * 2.2);
    bar.update(dt, stamina);

    // witch time runs in real seconds
    if (s.witch > 0) {
      s.witch -= dt;
      if (s.witch <= 0) endWitchTime();
    }
    const wt = s.witch > 0 ? clamp(Math.min((s.witchTotal - s.witch) / 0.12, s.witch / 0.35), 0, 1) : 0;

    let at: Vector3 | null = null;
    let urgency = 0;
    if (style() === 'counter' && !p.dead && p.grounded && p.state !== 'counter') {
      const e = counterCandidate(p);
      if (e) {
        at = e.position.clone().setY(e.feet.y + 2.35);
        urgency = 1 - clamp(e.attackTimeRemaining / C.window, 0, 1);
      }
    }
    hud.update(dt, game.cam.camera, window.innerWidth, window.innerHeight, {
      witch: wt,
      counterAt: at,
      counterUrgency: urgency,
      keyLabel: PromptLabels[game.input.lastDevice].block,
      riposte: s.riposteTimer,
    });
  },
};

// ------------------------------------------------------------------ input gating
/** Fires inside Input.update (before the player updates): arm parries, refuse unaffordable actions. */
function onPress(action: string) {
  const p = game?.player;
  if (!p || game.paused || p.dead) return;
  if (action === 'block') {
    const st = style();
    if (st === 'block-parry' && s.parryCooldown <= 0 && !s.parryArmed) {
      s.parryArmed = true;
      s.parryArmedAt = s.clock;
    }
    if (st === 'counter' && !counterCandidate(p) && enemyWindingUpNear(p)) s.counterLockout = C.missLockout;
    return;
  }
  if (!stamina.enabled) return;
  let cost = 0;
  if (action === 'dodge') cost = p.grounded ? S.roll : p.airDashCharges > 0 ? S.airDash : 0;
  else if (action === 'attack') cost = S.light;
  else if (action === 'heavy') cost = S.heavy;
  if (cost > 0 && !hasStamina(cost)) {
    // Drop the buffered press: dodge / airdash / attack interrupts (and combo chains) never see it.
    game.input.clearBuffer(action as 'dodge' | 'attack' | 'heavy');
    stamina.denied = 1;
  }
}

// ------------------------------------------------------------------ defense handler
function defend(p: Player, hit: IncomingHit): HitResult | null {
  if (p.state === 'counter') return hit.attacker && hit.attacker === (s.counterTarget as unknown) ? 'countered' : 'dodged';
  const st = style();
  if (st === 'perfect-dodge' && p.state === 'dodge' && p.stateTime <= D.perfectDodgeWindow) {
    perfectDodge(p);
    return 'dodged';
  }
  if (p.state === 'block' && !hit.unblockable && frontal(p, hit)) {
    if (st === 'block-parry' && s.parryArmed && s.clock - s.parryArmedAt <= D.parryWindow && hit.parryable !== false) return parry(p, hit);
    return blockHit(p, hit);
  }
  return null;
}

function frontal(p: Player, hit: IncomingHit) {
  // hit.dir points attacker → player, so the attacker is in front when forward · (-dir) is large
  const f = p.forward;
  const dot = -(f.x * hit.dir.x + f.z * hit.dir.z);
  return dot >= Math.cos(((D.blockArcDeg / 2) * Math.PI) / 180);
}

const PARRY_COLOR = new Color(2.6, 2.8, 3.4);
const PARRY_COLOR2 = new Color(0.9, 1.3, 2.6);
const BLOCK_COLOR = new Color(2.4, 1.8, 1.0);
const WITCH_COLOR = new Color(0.35, 0.65, 2.4);

function guardPoint(p: Player) {
  return p.position.clone().addScaledVector(p.forward, 0.55).setY(p.position.y + 1.25);
}

function parry(p: Player, hit: IncomingHit): HitResult {
  s.parryArmed = false;
  s.riposteTimer = D.riposteWindow;
  s.blockReact = 0.32;
  p.velocity.x = hit.dir.x * 1.5;
  p.velocity.z = hit.dir.z * 1.5;
  p.model.play('Block_Attack', { fade: 0.04, loop: false, speed: 2.2, startAt: 0.15, restart: true });
  const pt = guardPoint(p);
  const { fx, cam } = p.ctx;
  fx.sparks.emit({
    count: 46, position: pt, spread: 0.08, velocity: p.forward.clone().multiplyScalar(4).setY(1.5), speed: 9,
    life: [0.15, 0.45], size: [0.04, 0.11], color: PARRY_COLOR, color2: PARRY_COLOR2, gravity: 8, drag: 3,
  });
  fx.sparks.emit({ count: 1, position: pt, speed: 0, life: [0.18, 0.18], size: [1.6, 1.6], color: PARRY_COLOR });
  fx.waves.spawn(p.position.clone().setY(p.position.y + 0.05), 1.6, PARRY_COLOR2, 0.3, 0.2);
  hud.flash(0.9);
  cam.shake(0.25);
  cam.kickFov(-4);
  p.ctx.slowmo?.(D.parrySlowmo[0], D.parrySlowmo[1]);
  events.emit('player:parry', { position: p.position.clone() });
  return 'parried';
}

function blockHit(p: Player, hit: IncomingHit): HitResult {
  if (stamina.enabled && stamina.value < S.blockHit) return guardBreak(p, hit);
  spendStamina(S.blockHit);
  const chip = Math.round(hit.damage * D.chip);
  p.health = Math.max(Math.min(p.health, 1), p.health - chip); // chip never kills
  s.blockReact = 0.3;
  const kb = hit.knockback * D.blockPushback;
  p.velocity.x = hit.dir.x * kb;
  p.velocity.z = hit.dir.z * kb;
  p.model.play('Block_Hit', { fade: 0.04, loop: false, speed: 1.8, restart: true });
  const pt = guardPoint(p);
  p.ctx.fx.sparks.emit({
    count: 24, position: pt, spread: 0.08, velocity: p.forward.clone().multiplyScalar(3).setY(1.2), speed: 6,
    life: [0.12, 0.35], size: [0.04, 0.1], color: BLOCK_COLOR, color2: new Color(1.4, 0.8, 0.3), gravity: 12, drag: 4,
  });
  p.ctx.fx.sparks.emit({ count: 1, position: pt, speed: 0, life: [0.1, 0.1], size: [0.7, 0.7], color: BLOCK_COLOR });
  p.ctx.cam.shake(hit.heavy ? 0.22 : 0.14);
  p.ctx.hitstop(0.05);
  events.emit('player:blocked', { damage: chip, position: p.position.clone() });
  return 'blocked';
}

function guardBreak(p: Player, hit: IncomingHit): HitResult {
  stamina.value = 0;
  stamina.sinceSpend = 0;
  stamina.denied = 1;
  const dmg = Math.round(hit.damage * D.guardBreak.damageFrac);
  p.health = Math.max(0, p.health - dmg);
  events.emit('player:damaged', { damage: dmg, health: p.health, position: p.position.clone() });
  events.emit('player:guard-break', { position: p.position.clone() });
  if (p.health <= 0 && p.states.has('dead')) p.go('dead', hit);
  else p.go('guardbreak', hit);
  return 'hit';
}

// ------------------------------------------------------------------ perfect dodge / witch time
function perfectDodge(p: Player) {
  if (s.witch > 0) return; // already in witch time: just dodge
  const W = D.witchTime;
  s.witch = W.duration;
  s.witchTotal = W.duration;
  p.slowmoExempt = W.playerExempt;
  p.ctx.slowmo?.(W.scale, W.duration);
  p.ctx.fx.afterimage(1.1, WITCH_COLOR);
  p.ctx.fx.waves.spawn(p.position.clone().setY(p.position.y + 0.05), 3.2, WITCH_COLOR, 0.5, 0.25);
  p.ctx.cam.kickFov(6);
  events.emit('player:perfect-dodge', { position: p.position.clone() });
}

function endWitchTime() {
  s.witch = 0;
  if (game?.player) game.player.slowmoExempt = 0;
}

// ------------------------------------------------------------------ riposte
function onPlayerHit(target: { position: Vector3; onHit(info: HitInfo): void }, info: HitInfo) {
  if (s.riposteActive <= 0 || info.source === 'echo' || info.move === 'riposte' || info.move === 'counter') return;
  const bonus = Math.round(info.damage * (D.riposteMul - 1));
  if (bonus <= 0) return;
  // Extra hit for the bonus (same direction, no extra knockback) — keeps combat.ts untouched.
  target.onHit({ ...info, damage: bonus, knockback: 0, launch: 0, stagger: 0, move: 'riposte' });
  game.hitstop(D.riposteHitstop);
  game.cam.shake(0.5);
  game.cam.kickFov(-5);
  hud.flash(0.45);
  game.hud.damageNumber(target.position.clone().setY(target.position.y + 1.6), 'Riposte' as unknown as number, true);
  events.emit('player:riposte', { position: target.position.clone(), damage: info.damage + bonus });
}

// ------------------------------------------------------------------ block state
function enterBlock(p: Player) {
  s.blockReact = 0;
  p.input.clearBuffer('block');
  if (p.trail) p.trail.active = false;
  p.model.play('Block', { fade: 0.06, loop: false, speed: 2.4, restart: true });
}

function exitBlock() {
  s.blockReact = 0;
}

function updateBlock(p: Player, dt: number) {
  if (!p.grounded) return p.go('air');
  if (!p.input.held('block') && p.stateTime >= D.blockMinTime) return p.goFree();
  if (p.runInterrupts('cancel')) return;

  s.blockReact = Math.max(0, s.blockReact - dt);
  if (s.blockReact > 0) {
    const k = Math.exp(-8 * dt);
    p.velocity.x *= k;
    p.velocity.z *= k;
  } else {
    p.accelerateHorizontal(p.moveDir, D.blockMoveSpeed * p.moveMag, Tuning.player.accel, dt);
  }

  // Strafe: while moving, the guard turns toward the camera's forward (aim the shield with the camera);
  // standing still keeps the facing. No auto-turn toward enemies, so flanking still works.
  if (p.moveMag > 0.1) {
    const f = p.ctx.cam.forward(tmpV);
    p.facing = dampAngle(p.facing, Math.atan2(f.x, f.z), D.blockTurnRate, dt);
  }

  if (s.blockReact <= 0 && p.stateTime > 0.22) p.model.play('Blocking', { fade: 0.15 });
}

// ------------------------------------------------------------------ guard break
function enterGuardBreak(p: Player, data?: unknown) {
  const hit = data as IncomingHit | undefined;
  if (hit) {
    s.guardBreakDir.copy(hit.dir).setY(0).normalize();
    p.velocity.x = s.guardBreakDir.x * hit.knockback * 0.9;
    p.velocity.z = s.guardBreakDir.z * hit.knockback * 0.9;
  } else {
    s.guardBreakDir.copy(p.forward).negate();
  }
  p.model.play('Hit_B', { fade: 0.04, loop: false, speed: 0.87 / D.guardBreak.duration, restart: true });
  const pt = guardPoint(p);
  p.ctx.fx.sparks.emit({
    count: 30, position: pt, spread: 0.1, velocity: s.guardBreakDir.clone().multiplyScalar(-2).setY(2), speed: 6,
    life: [0.2, 0.5], size: [0.05, 0.12], color: new Color(2.4, 0.9, 0.3), color2: new Color(1.2, 0.3, 0.1), gravity: 12, drag: 3,
  });
  p.ctx.cam.shake(0.4);
  game.hud.flash('Guard broken', 0.9);
}

function updateGuardBreak(p: Player, dt: number) {
  const k = Math.exp(-6 * dt);
  p.velocity.x *= k;
  p.velocity.z *= k;
  if (p.stateTime >= D.guardBreak.duration) p.goFree();
}

function guardBreakVisual(p: Player, o: { pitch: number }) {
  const u = Math.min(1, p.stateTime / D.guardBreak.duration);
  o.pitch = -Math.sin(u * Math.PI) * 0.3;
}

// ------------------------------------------------------------------ counter
function counterCandidate(p: Player): CounterThreat | null {
  let best = counterCandidateIn(p, game.enemies?.list ?? [], null);
  for (const src of counterThreatSources) best = counterCandidateIn(p, src(), best);
  return best;
}

function counterCandidateIn(p: Player, list: readonly CounterThreat[], best: CounterThreat | null): CounterThreat | null {
  const f = p.forward;
  const cosArc = Math.cos(((C.arcDeg / 2) * Math.PI) / 180);
  for (const e of list) {
    if (e.alive === false || !e.attacking) continue;
    const tr = e.attackTimeRemaining;
    if (!(tr > 0 && tr <= C.window)) continue;
    const dx = e.feet.x - p.position.x;
    const dz = e.feet.z - p.position.z;
    const d = Math.hypot(dx, dz);
    // big targets (bosses) count from their body edge, grunts (r 0.5) are unchanged
    if (d > C.range + Math.max(0, e.radius - 0.5) || Math.abs(e.feet.y - p.position.y) > 1.5) continue;
    if (d > 0.8 && (dx * f.x + dz * f.z) / d < cosArc) continue;
    if (!best || tr < best.attackTimeRemaining) best = e;
  }
  return best;
}

function enemyWindingUpNear(p: Player) {
  const near = (e: CounterThreat) => e.alive !== false && e.attacking && e.feet.distanceTo(p.position) < C.range + 1.5;
  if (game.enemies?.list.some(near)) return true;
  return counterThreatSources.some((src) => src().some(near));
}

function tryCounter(p: Player, _ctx: string, from: string): boolean {
  if (style() !== 'counter' || !p.grounded || from === 'counter' || s.counterLockout > 0) return false;
  if (!p.input.buffered('block', 0.1)) return false;
  const e = counterCandidate(p);
  if (!e) return false;
  p.input.clearBuffer('block');
  p.go('counter', e);
  return true;
}

function enterCounter(p: Player, data?: unknown) {
  const e = data as CounterThreat;
  s.counterTarget = e;
  s.counterStruck = false;
  p.invulnerable = true;
  p.velocity.set(0, 0, 0);
  p.facing = Math.atan2(e.feet.x - p.position.x, e.feet.z - p.position.z);
  if (p.trail) p.trail.active = false;
  e.onCountered();
  p.model.play('Block_Attack', { fade: 0.04, loop: false, speed: 2.2, startAt: 0.1, restart: true });
  const pt = guardPoint(p);
  p.ctx.fx.sparks.emit({
    count: 50, position: pt, spread: 0.1, velocity: p.forward.clone().multiplyScalar(5).setY(1.5), speed: 9,
    life: [0.15, 0.5], size: [0.05, 0.12], color: new Color(2.8, 2.2, 1.0), color2: PARRY_COLOR2, gravity: 8, drag: 3,
  });
  p.ctx.fx.sparks.emit({ count: 1, position: pt, speed: 0, life: [0.2, 0.2], size: [1.8, 1.8], color: new Color(3, 2.4, 1.2) });
  hud.flash(1);
  p.ctx.cam.kickFov(-7);
  p.ctx.cam.shake(0.3);
  p.ctx.slowmo?.(C.slowmo[0], C.slowmo[1]);
  events.emit('player:counter', { position: p.position.clone() });
  events.emit('player:attack', {
    move: 'counter', clip: 'Block_Attack', speed: 2.2, clipStart: 0.1, heavy: true, position: p.position.clone(), facing: p.facing,
  });
}

function exitCounter(p: Player) {
  s.counterTarget = null;
  if (p.trail) p.trail.active = false;
}

function updateCounter(p: Player, dt: number) {
  p.invulnerable = true;
  const t = p.stateTime;
  const e = s.counterTarget;
  if (e && !s.counterStruck) {
    const dx = e.feet.x - p.position.x;
    const dz = e.feet.z - p.position.z;
    const d = Math.hypot(dx, dz);
    p.facing = Math.atan2(dx, dz);
    // close the gap so the strike connects
    const gap = d - 0.8 - e.radius; // 1.3 for a grunt (r 0.5)
    const left = Math.max(0.05, C.strikeAt - t);
    const sp = gap > 0 ? Math.min(10, gap / left) : 0;
    p.velocity.x = (dx / (d || 1)) * sp;
    p.velocity.z = (dz / (d || 1)) * sp;
  } else {
    const k = Math.exp(-12 * dt);
    p.velocity.x *= k;
    p.velocity.z *= k;
  }

  if (!s.counterStruck && t >= C.strikeAt) {
    s.counterStruck = true;
    p.model.play('1H_Melee_Attack_Slice_Horizontal', { fade: 0.05, loop: false, speed: 1.7, startAt: 0.25, restart: true });
    if (e && e.alive !== false) {
      const dir = new Vector3(e.feet.x - p.position.x, 0, e.feet.z - p.position.z);
      if (dir.lengthSq() < 1e-4) dir.copy(p.forward);
      dir.normalize();
      const info: HitInfo = {
        damage: C.damage, dir, knockback: C.knockback, heavy: true, stagger: C.stagger, source: 'player', move: 'counter', guardBreak: true,
      };
      e.onHit(info);
      events.emit('player:hit', { target: e, info, move: 'counter' });
      p.ctx.hitstop(Tuning.feel.hitstopHeavy);
      p.ctx.cam.shake(0.45);
    }
  }
  if (p.trail) p.trail.active = t >= C.strikeAt - 0.03 && t <= C.strikeAt + 0.18;

  if (t >= C.cancelAt && p.runInterrupts('cancel')) return;
  if (t >= C.duration) p.goFree();
}

function counterVisual(p: Player, o: { pitch: number; squash: number }) {
  const t = p.stateTime;
  if (t < C.strikeAt) o.pitch = 0.08 * (t / C.strikeAt);
}
