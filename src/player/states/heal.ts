import { Color, Vector3 } from 'three';
import { Difficulty } from '../../boss/difficulty';
import { Tuning } from '../../config/tuning';
import { events } from '../../core/Events';
import type { Game } from '../../core/Game';
import { dampAngle } from '../../core/math';
import type { Feature } from '../../features';
import { FlaskHud } from '../../ui/FlaskHud';
import type { Player } from '../Player';

/**
 * Flasks: `heal` action (C / D-pad down) → `heal` state. A charge is spent when the drink starts;
 * the heal lands at `healAt`, so a hit before that wastes it (punishable — bosses read
 * `player.state === 'heal'`). Walk speed while drinking, no cancels. Charges depend on difficulty
 * (story 5 / normal 3 / souls 2) and refill on respawn and at checkpoints (`flasks.refill()`).
 */
export const HealTuning = {
  duration: 1.1,
  healAt: 0.6,
  /** fraction of max health restored */
  amount: 0.45,
  moveSpeed: Tuning.player.walkSpeed * 0.75,
  clip: 'Use_Item',
};
const H = HealTuning;

export const flasks = {
  charges: Difficulty.flasks(),
  get max() {
    return Difficulty.flasks();
  },
  /** refill to max; returns true if anything changed */
  refill(): boolean {
    const was = this.charges;
    this.charges = this.max;
    return this.charges !== was;
  },
};

const s = { healed: false };
const GLOW = new Color(1.6, 2.2, 0.9);
const GLOW2 = new Color(2.4, 1.8, 0.6);
const tmp = new Vector3();

let game: Game;
let hud: FlaskHud;

export function installHeal(p: Player) {
  p.registerState('heal', { enter: enterHeal, update: updateHeal, exit: exitHeal });
  p.registerInterrupt({
    name: 'heal',
    priority: 70,
    contexts: ['ground'],
    check: (pl) => {
      if (!pl.grounded || !pl.input.consume('heal', 0.2)) return false;
      if (flasks.charges <= 0) {
        events.emit('player:heal-empty', { position: pl.position.clone() });
        game?.hud.flash('No flasks left', 1);
        hud?.deny();
        return false;
      }
      pl.go('heal');
      return true;
    },
  });
}

function enterHeal(p: Player) {
  flasks.charges--;
  s.healed = false;
  if (p.trail) p.trail.active = false;
  const len = p.model.clipDuration(H.clip) || 1.5;
  p.model.play(H.clip, { fade: 0.12, loop: false, speed: Math.max(0.6, len / H.duration), restart: true });
  events.emit('player:heal-start', { position: p.position.clone(), charges: flasks.charges });
}

function updateHeal(p: Player, dt: number) {
  if (!p.grounded) return p.go('air');
  p.accelerateHorizontal(p.moveDir, H.moveSpeed * p.moveMag, Tuning.player.accel, dt);
  if (p.moveMag > 0.1) p.facing = dampAngle(p.facing, Math.atan2(p.moveDir.x, p.moveDir.z), 6, dt);
  if (!s.healed && p.stateTime >= H.healAt) {
    s.healed = true;
    const amount = Math.round(p.maxHealth * H.amount);
    const before = p.health;
    p.health = Math.min(p.maxHealth, p.health + amount);
    const at = tmp.copy(p.position).setY(p.position.y + 1);
    p.ctx.fx.sparks.emit({
      count: 40, position: at, spread: 0.45, speed: 1.6, upBias: 1, life: [0.5, 1.0], size: [0.05, 0.12],
      color: GLOW, color2: GLOW2, gravity: -2.5, drag: 1.5,
    });
    p.ctx.fx.waves.spawn(tmp.copy(p.position).setY(p.position.y + 0.05), 1.4, GLOW, 0.5, 0.25);
    events.emit('player:heal', { position: p.position.clone(), amount: p.health - before, charges: flasks.charges });
  }
  if (p.stateTime >= H.duration) p.goFree();
}

function exitHeal() {
  s.healed = false;
}

/** Flasks + HUD as one feature line in features/index.ts. */
export const healFeature: Feature = {
  name: 'heal',
  install(g) {
    game = g;
    installHeal(g.player);
    hud = new FlaskHud(g.hud);
    events.on('player:respawn', () => flasks.refill());
    events.on('loadout:changed', ({ id }) => {
      // difficulty change: snap to the new maximum
      if (id === 'challenge.difficulty') flasks.refill();
    });
  },
  lateUpdate(dt, g) {
    hud.update(dt, flasks.charges, flasks.max, g.player.state === 'heal');
  },
  pausedUpdate(dt, g) {
    hud.update(dt, flasks.charges, flasks.max, g.player.state === 'heal');
  },
};
