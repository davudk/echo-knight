import { Vector3 } from 'three';
import { events } from '../core/Events';
import type { HitResult, IncomingHit, Player } from '../player/Player';

/**
 * Player `grabbed` state (registered by the boss feature). A boss grab that connects puts the
 * player here: held at an anchor the boss provides, invulnerable to everything else, then thrown
 * (`throwPlayer`) for heavy damage — or let go (`escapePlayer`) if the boss is interrupted.
 *
 * Grabs are unblockable and not parryable: `probeDefenses` runs the player's defense handlers
 * (perfect dodge, counter state, post-hit grace) and i-frames without dealing damage, so the
 * only way out is to not be there — dodge before it lands.
 */
export interface GrabHold {
  /** writes the hold position (player feet) into `out` */
  anchor(out: Vector3): Vector3;
  /** yaw the player should face (toward the boss) */
  facing(): number;
}

let hold: GrabHold | null = null;
const tmp = new Vector3();

export function installGrab(p: Player) {
  p.registerState('grabbed', {
    enter(pl, data) {
      hold = data as GrabHold;
      pl.velocity.set(0, 0, 0);
      if (pl.trail) pl.trail.active = false;
      pl.model.play('Hit_B', { fade: 0.06, loop: false, speed: 0.6, restart: true });
      pl.ctx.cam.shake(0.35);
      events.emit('player:grabbed', { position: pl.position.clone() });
    },
    update(pl) {
      pl.invulnerable = true;
      pl.gravityScale = 0;
      pl.velocity.set(0, 0, 0);
      // drop any buffered actions: there is no input while held
      pl.input.clearBuffer('dodge');
      pl.input.clearBuffer('attack');
      pl.input.clearBuffer('jump');
      if (hold) {
        pl.position.copy(hold.anchor(tmp));
        pl.facing = hold.facing();
      }
    },
    exit() {
      hold = null;
    },
    visual(pl, o) {
      o.pitch = -0.25;
      o.lift = 0.05 * Math.sin(pl.stateTime * 30);
    },
  });
}

/**
 * Would a hit connect? Runs the defense handlers and i-frames WITHOUT applying damage.
 * Returns null when nothing avoided it (the caller then applies its own effect, e.g. a grab).
 */
export function probeDefenses(p: Player, hit: IncomingHit): HitResult | null {
  if (p.dead) return 'ignored';
  for (const d of p.defenseHandlers) {
    const r = d(p, hit);
    if (r) return r;
  }
  if (p.invulnerable) return 'dodged';
  return null;
}

/** End a grab with a throw: heavy damage + knockback, the hurt (or dead) state takes over. */
export function throwPlayer(p: Player, damage: number, dir: Vector3, knockback: number) {
  if (p.state !== 'grabbed') return;
  p.health = Math.max(0, p.health - damage);
  events.emit('player:damaged', { damage, health: p.health, position: p.position.clone() });
  const hit: IncomingHit = { damage, dir, knockback, heavy: true, unblockable: true };
  p.go(p.health <= 0 && p.states.has('dead') ? 'dead' : 'hurt', hit);
  p.velocity.y = 6; // thrown: a short arc
  p.grounded = false;
}

/** The boss was interrupted mid-grab: drop the player unharmed. */
export function escapePlayer(p: Player) {
  if (p.state !== 'grabbed') return;
  p.velocity.set(0, 0, 0);
  p.goFree();
}
