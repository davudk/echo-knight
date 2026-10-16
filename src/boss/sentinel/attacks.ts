import type { AttackDef } from '../types';

/**
 * The Gate Sentinel's moveset — the reference for every attack shape. Times are seconds on
 * Normal (windups ×1.3 on Story / ×0.85 on Souls, final recoveries likewise).
 *
 * Clip impact frames (KayKit rig, seconds into the clip):
 *   2H_Melee_Attack_Chop 0.78 · 2H_Melee_Attack_Slice 0.42 · 2H_Melee_Attack_Stab 0.72
 *   Unarmed_Melee_Attack_Punch_A 0.55 · Spellcast_Shoot 0.45 · Spellcast_Raise 1.0
 */
export const SentinelAttacks: AttackDef[] = [
  // -------------------------------------------------------------- gold: parryable melee
  {
    // Overhead cleave with a step-in. The bread-and-butter parry check.
    id: 'cleave',
    name: 'Cleave',
    telegraph: 'parryable',
    steps: [{
      windup: 0.85, active: 0.14, recovery: 1.1,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.15, hitFrame: 0.78, speed: 1 },
      move: [{ kind: 'lunge', during: 'windup', from: 0.55, to: 1, distance: 2.6, stopAt: 1.0 }],
      hitboxes: [{ shape: 'cone', range: 3.7, arc: 70 }],
      damage: 22, knockback: 7, shake: 0.2,
    }],
  },
  {
    // Wide right-to-left sweep: the blade travels over 0.3 s, so rolling INTO it early still gets clipped.
    id: 'sweep',
    name: 'Reaping Arc',
    telegraph: 'parryable',
    steps: [{
      windup: 0.75, active: 0.3, recovery: 1.0,
      anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.05, hitFrame: 0.42, speed: 0.9 },
      track: { windup: 4 },
      hitboxes: [{ shape: 'sweep', range: 4.1, from: -115, to: 115, width: 30, decal: true }],
      damage: 18, knockback: 6,
    }],
  },
  {
    // Three-hit string. The third hit is DELAYED (held wind-up): rolling on rhythm gets you hit.
    id: 'triple',
    name: 'Threefold Rend',
    telegraph: 'parryable',
    steps: [
      {
        windup: 0.6, active: 0.2, recovery: 0.12,
        anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.08, hitFrame: 0.42, speed: 1.1 },
        move: [{ kind: 'lunge', during: 'windup', from: 0.5, to: 1, distance: 1.6 }],
        hitboxes: [{ shape: 'sweep', range: 3.7, from: -80, to: 80, width: 30 }],
        damage: 15, knockback: 3, heavy: false,
      },
      {
        windup: 0.5, active: 0.14, recovery: 0.15,
        anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.35, hitFrame: 0.78, speed: 1.1 },
        move: [{ kind: 'lunge', during: 'windup', from: 0.3, to: 1, distance: 1.6 }],
        hitboxes: [{ shape: 'cone', range: 3.6, arc: 60 }],
        damage: 15, knockback: 3, heavy: false,
      },
      {
        // the delayed thrust: long hold, then a fast lunging stab along a line
        windup: 1.15, active: 0.16, recovery: 1.3,
        anim: { clip: '2H_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.72, speed: 1, pacing: 'hold' },
        track: { windup: 5 },
        move: [{ kind: 'lunge', during: 'active', distance: 1.6, stopAt: 0.6 }],
        hitboxes: [{ shape: 'line', length: 4.8, width: 1.2, decal: false }],
        damage: 26, knockback: 8, parryPoise: 45,
      },
    ],
  },

  // -------------------------------------------------------------- red: unblockable
  {
    // Leap + slam. The landing hurts (circle under it), then a shockwave ring expands: JUMP it.
    id: 'quake',
    name: 'Quake Slam',
    telegraph: 'unblockable',
    steps: [{
      windup: 1.25, active: 0.1, recovery: 1.45,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.1, hitFrame: 0.78, speed: 0.9 },
      // lands ~3 m short of you: standing still → the ring gets you; rolling in → the slam circle does
      move: [{ kind: 'leap', during: 'windup', from: 0.35, to: 1, height: 3.2, maxDistance: 9, stopAt: 2.6 }],
      track: { windup: 4 },
      hitboxes: [
        { shape: 'circle', at: 'leap', lockAt: 0.36, radius: 2.4 },
        { shape: 'ring', speed: 8.5, maxRadius: 11, thickness: 0.8, startRadius: 1.4, damage: 18, knockback: 7 },
      ],
      damage: 26, knockback: 9, shake: 0.6,
    }],
  },
  {
    // Lunging grab. Unblockable, can't be parried: dodge THROUGH or away just before it lands.
    id: 'grab',
    name: 'Iron Grasp',
    telegraph: 'unblockable',
    steps: [{
      windup: 0.95, active: 0.24, recovery: 1.45,
      anim: { clip: 'Unarmed_Melee_Attack_Punch_A', startAt: 0.1, hitFrame: 0.55, speed: 0.9 },
      move: [
        { kind: 'lunge', during: 'windup', from: 0.6, to: 1, distance: 2.2, stopAt: 0.9 },
        { kind: 'lunge', during: 'active', distance: 1.2, stopAt: 0.5 },
      ],
      track: { windup: 5, active: 2 },
      hitboxes: [{ shape: 'grab', range: 2.5, arc: 70, hold: 1.1, throwClip: 'Throw', throwKnockback: 9, decal: true }],
      damage: 34, knockback: 9,
    }],
  },

  // -------------------------------------------------------------- cyan: magic
  {
    // Homing bolt. Block it, outrun it, or PARRY it to send it back (big poise damage).
    id: 'bolt',
    name: 'Sentinel Bolt',
    telegraph: 'magic',
    steps: [{
      windup: 0.8, active: 0.3, recovery: 0.9,
      anim: { clip: 'Spellcast_Shoot', startAt: 0.0, hitFrame: 0.45, speed: 1 },
      track: { windup: 4, active: 2 },
      hitboxes: [{ shape: 'projectile', speed: 12, homing: 1.1, lifetime: 3, radius: 0.35, reflectable: true, reflectDamage: 45, reflectPoise: 40 }],
      damage: 16, knockback: 4, heavy: false,
    }],
  },
  {
    // Phase 2: fan of three bolts, one after another.
    id: 'volley',
    name: 'Bolt Volley',
    telegraph: 'magic',
    steps: [{
      windup: 0.9, active: 0.6, recovery: 1.0,
      anim: { clip: 'Spellcast_Shoot', startAt: 0.0, hitFrame: 0.45, speed: 0.8 },
      track: { windup: 4, active: 3 },
      hitboxes: [{ shape: 'projectile', count: 3, interval: 0.22, spread: 24, speed: 11, homing: 0.6, lifetime: 3, radius: 0.32, reflectable: true }],
      damage: 12, knockback: 3, heavy: false,
    }],
  },
  {
    // Circle AoE where you stand: the decal fills, then it erupts. Keep moving.
    id: 'judgement',
    name: 'Judgement',
    telegraph: 'magic',
    steps: [{
      windup: 1.3, active: 0.2, recovery: 1.0,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 1 },
      track: { windup: 2 },
      hitboxes: [{ shape: 'circle', at: 'player', radius: 2.3 }],
      damage: 22, knockback: 6,
    }],
  },
  {
    // Phase 2: three staggered eruptions around you (each decal fills to its own impact).
    id: 'judgement3',
    name: 'Triple Judgement',
    telegraph: 'magic',
    steps: [{
      windup: 1.2, active: 1.0, recovery: 1.1,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 0.8 },
      track: { windup: 2 },
      hitboxes: [
        { shape: 'circle', at: 'player', radius: 2.0 },
        { shape: 'circle', at: 'player', around: [2.6, 1.5], radius: 2.0, delay: 0.35, lockAt: 0.5 },
        { shape: 'circle', at: 'player', around: [-2.6, 1.5], radius: 2.0, delay: 0.7, lockAt: 0.8 },
      ],
      damage: 18, knockback: 6,
    }],
  },
  {
    // Phase 2: a rotating beam (line hitbox sweeping 110°). Roll through it or get out of reach.
    id: 'lance',
    name: 'Radiant Lance',
    telegraph: 'magic',
    steps: [{
      windup: 1.1, active: 1.3, recovery: 1.3,
      anim: { clip: '2H_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.72, speed: 0.15 },
      track: { windup: 3, active: 0 },
      hitboxes: [{ shape: 'line', length: 13, width: 1.1, offset: 0.6, yawFrom: 55, yawTo: -55, tick: 0.5 }],
      damage: 14, knockback: 5, heavy: false,
    }],
  },
];
