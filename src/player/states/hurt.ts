import { Color, Vector3 } from 'three';
import { events } from '../../core/Events';
import type { IncomingHit, Player } from '../Player';

/**
 * Player damage states: `hurt` (flinch + knockback, brief invulnerability after) and
 * `dead` (death anim, fade, respawn at `player.spawnPoint`). `Player.receiveHit` enters these.
 */
export const HurtTuning = {
  duration: 0.35,
  heavyDuration: 0.5,
  /** dodge / jump can cancel the flinch from here */
  cancelAt: 0.25,
  /** invulnerability after a hit (covers the flinch + this much afterwards) */
  grace: 0.45,
  respawnDelay: 2.5,
};

const H = HurtTuning;

const s = {
  hurtDur: 0,
  grace: 0,
  deadTime: 0,
  dir: new Vector3(),
};

/** Seconds since death (for the death screen fade); -1 when alive. */
export const deathInfo = {
  get time() {
    return s.deadTime;
  },
};

const HURT_SPARK = new Color(2.4, 0.5, 0.3);

export function installHurt(p: Player) {
  p.registerState('hurt', { enter: enterHurt, update: updateHurt, visual: hurtVisual });
  p.registerState('dead', { enter: enterDead, update: updateDead });
  s.deadTime = -1;

  // Post-hit grace: swallow hits while flinching and shortly after (never stun-locked).
  p.registerDefense((pl) => (s.grace > 0 && !pl.dead ? 'ignored' : null));
}

/** Per-frame bookkeeping that must run regardless of the current state. */
export function tickHurt(p: Player, dt: number) {
  s.grace = Math.max(0, s.grace - dt);
  // Something (e.g. an echo recall teleport) yanked us out of the dead state: go back.
  if (p.dead && p.state !== 'dead') p.go('dead', { resume: true });
}

function enterHurt(p: Player, data?: unknown) {
  const hit = data as IncomingHit | undefined;
  const heavy = !!hit?.heavy;
  s.hurtDur = heavy ? H.heavyDuration : H.duration;
  s.grace = s.hurtDur + H.grace;
  if (hit) {
    s.dir.copy(hit.dir).setY(0).normalize();
    p.velocity.x = s.dir.x * hit.knockback;
    p.velocity.z = s.dir.z * hit.knockback;
    // face the attacker
    p.facing = Math.atan2(-s.dir.x, -s.dir.z);
  } else {
    s.dir.copy(p.forward).negate();
  }
  if (p.trail) p.trail.active = false;
  p.model.play(heavy ? 'Hit_B' : 'Hit_A', { fade: 0.04, loop: false, speed: heavy ? 1.4 : 1.7, restart: true });
  const pos = p.position.clone().setY(p.position.y + 1.2);
  p.ctx.fx.sparks.emit({
    count: heavy ? 26 : 16, position: pos, spread: 0.15, velocity: s.dir.clone().multiplyScalar(3).setY(1), speed: 5,
    life: [0.15, 0.4], size: [0.05, 0.12], color: HURT_SPARK, color2: new Color(1.4, 0.2, 0.1), gravity: 10, drag: 4,
  });
  p.ctx.cam.shake(heavy ? 0.45 : 0.3);
}

function updateHurt(p: Player, dt: number) {
  p.invulnerable = true;
  const k = Math.exp(-7 * dt);
  p.velocity.x *= k;
  p.velocity.z *= k;
  if (p.stateTime >= H.cancelAt && p.runInterrupts('cancel')) return;
  if (p.stateTime >= s.hurtDur) p.goFree();
}

function hurtVisual(p: Player, o: { pitch: number }) {
  // small backward lean that recovers
  const u = Math.min(1, p.stateTime / s.hurtDur);
  o.pitch = -Math.sin(u * Math.PI) * 0.18;
}

function enterDead(p: Player, data?: unknown) {
  const resume = (data as { resume?: boolean } | undefined)?.resume;
  p.dead = true;
  p.invulnerable = true;
  if (p.trail) p.trail.active = false;
  if (resume) {
    p.model.play('Death_A', { fade: 0, loop: false, startAt: 0.79 });
    return;
  }
  s.deadTime = 0;
  const hit = data as IncomingHit | undefined;
  if (hit) {
    p.velocity.x = hit.dir.x * hit.knockback * 1.3;
    p.velocity.z = hit.dir.z * hit.knockback * 1.3;
    p.facing = Math.atan2(-hit.dir.x, -hit.dir.z);
  }
  p.model.play('Death_A', { fade: 0.06, loop: false, speed: 0.9, restart: true });
  p.ctx.slowmo?.(0.35, 0.6);
  p.ctx.cam.shake(0.5);
  events.emit('player:died', { position: p.position.clone() });
}

function updateDead(p: Player, dt: number) {
  p.invulnerable = true;
  s.deadTime += dt;
  const k = Math.exp(-5 * dt);
  p.velocity.x *= k;
  p.velocity.z *= k;
  // no echo / attack inputs while dead
  p.input.clearBuffer('echo');
  p.input.clearBuffer('attack');
  if (s.deadTime >= H.respawnDelay) respawn(p);
}

function respawn(p: Player) {
  p.dead = false;
  p.health = p.maxHealth;
  s.deadTime = -1;
  s.grace = 1.0; // spawn protection
  p.teleport(p.spawnPoint, Math.PI);
  p.ctx.fx.echoBurst(p.position.clone().setY(p.position.y + 1), 40, 3);
  events.emit('player:respawn', { position: p.position.clone() });
}
