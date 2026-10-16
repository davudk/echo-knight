import type { AttackDef } from '../types';

/**
 * Ysolde's moveset. Framework hitboxes cover the bolts (reflectable projectiles) and the nova;
 * everything arena-scale (runes, chains, walls, orbs, mirrors, thunderfall) is spawned by the
 * boss class at the windup start (`Stormcaller.beginTelegraph`) so the telegraph runs during the
 * windup and lands on / after the active frame. Times are seconds on Normal.
 *
 * Colours: cyan = magic (block for chip, a parry only blocks) — but every BOLT is reflectable and
 * wears a gold halo: parry it to send it back (big poise). Red = unblockable arena hazards
 * (chains, walls, thunderfall): move.
 *
 * Clips: Spellcast_Shoot (impact ≈ 0.45) · Spellcast_Raise (≈ 1.0) · Spellcast_Long · Spellcasting (loop)
 */
const STAFF_H = 2.1;

export const StormAttacks: AttackDef[] = [
  // ---------------------------------------------------------------- bolts (reflectable)
  {
    id: 'bolt',
    name: 'Storm Bolt',
    telegraph: 'magic',
    steps: [{
      windup: 0.8, active: 0.1, recovery: 0.75,
      anim: { clip: 'Spellcast_Shoot', startAt: 0.05, hitFrame: 0.45, speed: 1 },
      track: { windup: 5, active: 3 },
      hitboxes: [{ shape: 'projectile', speed: 15, homing: 0.9, lifetime: 3.2, radius: 0.32, reflectable: true, reflectDamage: 40, reflectPoise: 34, height: STAFF_H }],
      damage: 16, knockback: 4, heavy: false,
    }],
  },
  {
    // three bolts at once in a 32° fan: the gaps between them widen with distance
    id: 'fan',
    name: 'Forked Bolts',
    telegraph: 'magic',
    steps: [{
      windup: 1.0, active: 0.1, recovery: 0.9,
      anim: { clip: 'Spellcast_Shoot', startAt: 0.0, hitFrame: 0.45, speed: 0.9 },
      track: { windup: 5, active: 0 },
      hitboxes: [{ shape: 'projectile', count: 3, spread: 32, speed: 13, lifetime: 3.2, radius: 0.3, reflectable: true, reflectDamage: 30, reflectPoise: 24, height: STAFF_H }],
      damage: 14, knockback: 4, heavy: false,
    }],
  },
  {
    // phase 2: five aimed bolts on a steady beat — a parry rhythm check
    id: 'volley',
    name: 'Thunder Volley',
    telegraph: 'magic',
    steps: [{
      windup: 0.95, active: 1.05, recovery: 1.0,
      anim: { clip: 'Spellcast_Shoot', startAt: 0.0, hitFrame: 0.45, speed: 0.6 },
      extraAnims: [{ during: 'active', at: 0.05, clip: 'Spellcasting', loop: true, speed: 1.4 }],
      track: { windup: 5, active: 3 },
      hitboxes: [{ shape: 'projectile', count: 5, interval: 0.26, speed: 14, homing: 0.45, lifetime: 3.2, radius: 0.3, reflectable: true, reflectDamage: 24, reflectPoise: 18, height: STAFF_H }],
      damage: 12, knockback: 3, heavy: false,
    }],
  },

  // ---------------------------------------------------------------- arena spells (custom spawns)
  {
    // runes appear at the windup start and erupt in waves after the active frame (walk the gaps)
    id: 'runes',
    name: 'Rune Field',
    telegraph: 'magic',
    steps: [{
      windup: 0.9, active: 0.1, recovery: 1.7,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 0.8 },
      track: { windup: 2, active: 0, recovery: 1 },
      hitboxes: [],
      damage: 18, knockback: 6,
    }],
  },
  {
    // a red chain of lightning sweeps the whole plateau: low → jump, high → slide / roll under
    id: 'chain',
    name: 'Chain Lightning',
    telegraph: 'unblockable',
    steps: [{
      windup: 1.25, active: 0.1, recovery: 2.6,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 0.6 },
      extraAnims: [{ during: 'recovery', at: 0.05, clip: 'Spellcasting', loop: true }],
      track: { windup: 2, active: 0, recovery: 0.5 },
      hitboxes: [],
      damage: 22, knockback: 8,
    }],
  },
  {
    // phase 2: a wall of lightning with one gap crosses the arena
    id: 'wall',
    name: 'Stormwall',
    telegraph: 'unblockable',
    steps: [{
      windup: 1.2, active: 0.1, recovery: 1.6,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 0.7 },
      track: { windup: 2, active: 0, recovery: 0.5 },
      hitboxes: [],
      damage: 24, knockback: 9,
    }],
  },
  {
    // phase 2: slow homing orbs — outrun them or pop them with a hit
    id: 'orbs',
    name: 'Ball Lightning',
    telegraph: 'magic',
    steps: [{
      windup: 1.0, active: 0.1, recovery: 0.9,
      anim: { clip: 'Spellcast_Raise', startAt: 0.3, hitFrame: 1.0, speed: 1 },
      track: { windup: 3 },
      hitboxes: [],
      damage: 20, knockback: 7,
    }],
  },
  {
    // phase 2: two mirror images appear on other perches and mimic her casts
    id: 'mirrors',
    name: 'Mirror Storm',
    telegraph: 'magic',
    steps: [{
      windup: 1.1, active: 0.1, recovery: 0.6,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 1 },
      track: { windup: 2 },
      hitboxes: [],
      damage: 0,
    }],
  },
  {
    // a quick column of strikes on you (phase 2+ pressure tool)
    id: 'smite',
    name: 'Smite',
    telegraph: 'magic',
    steps: [{
      windup: 0.7, active: 0.1, recovery: 1.0,
      anim: { clip: 'Spellcast_Shoot', startAt: 0.0, hitFrame: 0.45, speed: 0.8 },
      track: { windup: 3 },
      hitboxes: [],
      damage: 18, knockback: 6,
    }],
  },
  {
    // phase 3 desperation: everything outside the green pockets is struck
    id: 'thunderfall',
    name: 'Thunderfall',
    telegraph: 'unblockable',
    steps: [{
      windup: 3.2, active: 0.15, recovery: 2.4,
      anim: { clip: 'Spellcast_Raise', startAt: 0.1, hitFrame: 1.0, speed: 0.5 },
      track: { windup: 0.5, active: 0, recovery: 0 },
      hitboxes: [],
      damage: 46, knockback: 10, shake: 0.9,
    }],
  },

  // ---------------------------------------------------------------- close range
  {
    // anti-melee: a short cyan nova around her (block it or roll through), then she blinks away
    id: 'nova',
    name: 'Static Nova',
    telegraph: 'magic',
    steps: [{
      windup: 0.6, active: 0.12, recovery: 0.45,
      anim: { clip: 'Spellcast_Raise', startAt: 0.55, hitFrame: 1.0, speed: 1.2 },
      track: { windup: 1 },
      hitboxes: [{ shape: 'circle', at: 'self', radius: 3.6, yMin: -1.2, yMax: 2.4 }],
      damage: 20, knockback: 10, shake: 0.3,
    }],
  },

  // ---------------------------------------------------------------- movement
  {
    // teleport: a shimmer marks the destination for the whole windup
    id: 'blink',
    name: 'Blink',
    telegraph: 'magic',
    steps: [{
      windup: 0.6, active: 0.05, recovery: 0.25,
      anim: { clip: 'Spellcast_Long', startAt: 0.0, hitFrame: 0.5, speed: 1 },
      track: { windup: 2 },
      hitboxes: [],
      damage: 0, flash: false,
    }],
  },
  {
    id: 'blinkFast',
    name: 'Quick Blink',
    telegraph: 'magic',
    steps: [{
      windup: 0.45, active: 0.05, recovery: 0.2,
      anim: { clip: 'Spellcast_Long', startAt: 0.0, hitFrame: 0.5, speed: 1 },
      track: { windup: 2 },
      hitboxes: [],
      damage: 0, flash: false,
    }],
  },
];
