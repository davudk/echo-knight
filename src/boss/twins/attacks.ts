import type { AttackDef, AttackStep } from '../types';

/**
 * The Twin Wardens' movesets. Times are seconds on Normal (windups ×1.3 Story / ×0.85 Souls,
 * final recoveries likewise).
 *
 * Attacks with NO hitboxes are "support" moves (ward, heal, smoke, clone cast): the pair director
 * lets them run at any time. Every attack WITH hitboxes is "damaging" and needs the pair token
 * (see Pair.ts) so the twins' hits interleave instead of overlapping.
 *
 * Clip impact frames used here (KayKit rig, seconds into the clip):
 *   2H_Melee_Attack_Chop 0.78 · 2H_Melee_Attack_Slice 0.42 · 2H_Melee_Attack_Stab 0.72 · 2H_Melee_Attack_Spin 0.9
 *   1H_Melee_Attack_Slice_Horizontal 0.45 · Unarmed_Melee_Attack_Kick 0.42 · Block 0.3
 *   Dualwield_Melee_Attack_Slice 0.45 · Dualwield_Melee_Attack_Chop 0.55 · Dualwield_Melee_Attack_Stab 0.65
 *   Throw 0.6 · Spellcast_Raise 1.0 · Spellcast_Shoot 0.45
 */

// ================================================================== VAREK THE BREAKER
// Aggressor: two-handed axe, relentless strings, guard-breaking kick, leap slams, charges.

const chop: AttackDef = {
  // Overhead chop with a step-in: the bread-and-butter parry check.
  id: 'v_chop', name: 'Breaker Chop', telegraph: 'parryable',
  steps: [{
    windup: 0.85, active: 0.14, recovery: 1.15,
    anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.15, hitFrame: 0.78 },
    move: [{ kind: 'lunge', during: 'windup', from: 0.5, to: 1, distance: 2.4, stopAt: 0.9 }],
    hitboxes: [{ shape: 'cone', range: 3.6, arc: 70 }],
    damage: 24, knockback: 7, shake: 0.25,
  }],
};

const sweep: AttackDef = {
  // Wide right-to-left sweep; the blade travels, rolling into it early still gets clipped.
  id: 'v_sweep', name: 'Wide Sweep', telegraph: 'parryable',
  steps: [{
    windup: 0.75, active: 0.28, recovery: 1.0,
    anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.05, hitFrame: 0.42, speed: 0.9 },
    track: { windup: 4 },
    hitboxes: [{ shape: 'sweep', range: 4.0, from: -110, to: 110, width: 30, decal: true }],
    damage: 18, knockback: 6,
  }],
};

const rendSlice: AttackStep = {
  windup: 0.6, active: 0.2, recovery: 0.12,
  anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.08, hitFrame: 0.42, speed: 1.1 },
  move: [{ kind: 'lunge', during: 'windup', from: 0.4, to: 1, distance: 1.5 }],
  hitboxes: [{ shape: 'sweep', range: 3.6, from: -85, to: 85, width: 30 }],
  damage: 14, knockback: 3, heavy: false,
};
const rendBack: AttackStep = {
  windup: 0.45, active: 0.18, recovery: 0.14,
  anim: { clip: '1H_Melee_Attack_Slice_Horizontal', startAt: 0.1, hitFrame: 0.45, speed: 1.1 },
  move: [{ kind: 'lunge', during: 'windup', from: 0.3, to: 1, distance: 1.3 }],
  hitboxes: [{ shape: 'sweep', range: 3.5, from: 90, to: -90, width: 30 }],
  damage: 14, knockback: 3, heavy: false,
};
const rendDelayedChop: AttackStep = {
  // the held overhead: rolling on rhythm gets you hit
  windup: 1.1, active: 0.14, recovery: 1.3,
  anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.2, hitFrame: 0.78, pacing: 'hold' },
  track: { windup: 5 },
  move: [{ kind: 'lunge', during: 'windup', from: 0.85, to: 1, distance: 1.6, stopAt: 0.8 }],
  hitboxes: [{ shape: 'cone', range: 3.6, arc: 60 }],
  damage: 24, knockback: 8, parryPoise: 45, shake: 0.3,
};

const rend: AttackDef = { id: 'v_rend', name: 'Threefold Rend', telegraph: 'parryable', steps: [rendSlice, rendBack, rendDelayedChop] };

const rend4: AttackDef = {
  // Phase 2: four hits — slice, back slice, a QUICK chop (no hold), then a held spinning finisher.
  id: 'v_rend4', name: 'Breaker Storm', telegraph: 'parryable',
  steps: [
    rendSlice,
    rendBack,
    {
      windup: 0.42, active: 0.14, recovery: 0.16,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.4, hitFrame: 0.78, speed: 1.1 },
      move: [{ kind: 'lunge', during: 'windup', from: 0.2, to: 1, distance: 1.4 }],
      hitboxes: [{ shape: 'cone', range: 3.5, arc: 60 }],
      damage: 16, knockback: 3, heavy: false,
    },
    {
      windup: 1.0, active: 0.45, recovery: 1.45,
      anim: { clip: '2H_Melee_Attack_Spin', startAt: 0.3, hitFrame: 0.9, speed: 1.1, pacing: 'hold' },
      track: { windup: 4, active: 0 },
      hitboxes: [{ shape: 'sweep', range: 3.9, from: -180, to: 180, width: 40, decal: true }],
      damage: 22, knockback: 9, parryPoise: 45,
    },
  ],
};

const kick: AttackDef = {
  // Guard breaker: a quick RED kick (unblockable) — he uses it on a player who turtles behind a block.
  id: 'v_kick', name: 'Guard Breaker', telegraph: 'unblockable',
  steps: [{
    windup: 0.62, active: 0.14, recovery: 0.95,
    anim: { clip: 'Unarmed_Melee_Attack_Kick', startAt: 0.0, hitFrame: 0.42 },
    move: [{ kind: 'lunge', during: 'windup', from: 0.5, to: 1, distance: 1.2, stopAt: 0.6 }],
    track: { windup: 5 },
    hitboxes: [{ shape: 'cone', range: 2.7, arc: 70, decal: true }],
    damage: 12, knockback: 10,
  }],
};

const leap: AttackDef = {
  // Leap slam: the landing circle, then a jumpable shockwave ring.
  id: 'v_leap', name: 'Skybreaker', telegraph: 'unblockable',
  steps: [{
    windup: 1.2, active: 0.1, recovery: 1.4,
    anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.1, hitFrame: 0.78, speed: 0.9 },
    move: [{ kind: 'leap', during: 'windup', from: 0.35, to: 1, height: 3.0, maxDistance: 10, stopAt: 1.8 }],
    track: { windup: 4 },
    hitboxes: [
      { shape: 'circle', at: 'leap', lockAt: 0.36, radius: 2.4 },
      { shape: 'ring', speed: 8, maxRadius: 8, thickness: 0.8, startRadius: 1.4, damage: 16, knockback: 7 },
    ],
    damage: 26, knockback: 9, shake: 0.6,
  }],
};

const doubleLeap: AttackDef = {
  // Phase 2: a short hop slam (no ring), then the big one. Two different timings.
  id: 'v_leap2', name: 'Twin Skybreaker', telegraph: 'unblockable',
  steps: [
    {
      windup: 0.95, active: 0.1, recovery: 0.35,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.2, hitFrame: 0.78, speed: 1 },
      move: [{ kind: 'leap', during: 'windup', from: 0.4, to: 1, height: 2.2, maxDistance: 7, stopAt: 1.6 }],
      track: { windup: 4 },
      hitboxes: [{ shape: 'circle', at: 'leap', lockAt: 0.41, radius: 2.2 }],
      damage: 20, knockback: 7, shake: 0.4,
    },
    {
      windup: 1.15, active: 0.1, recovery: 1.5,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.1, hitFrame: 0.78, speed: 0.9 },
      move: [{ kind: 'leap', during: 'windup', from: 0.35, to: 1, height: 3.2, maxDistance: 9, stopAt: 1.8 }],
      track: { windup: 4 },
      hitboxes: [
        { shape: 'circle', at: 'leap', lockAt: 0.36, radius: 2.4 },
        { shape: 'ring', speed: 8.5, maxRadius: 9, thickness: 0.8, startRadius: 1.4, damage: 16, knockback: 7 },
      ],
      damage: 26, knockback: 9, shake: 0.6,
    },
  ],
};

const charge: AttackDef = {
  // Shoulder charge down a lane (red preview on the floor). Sidestep / roll out of the lane.
  id: 'v_charge', name: 'Bull Rush', telegraph: 'unblockable',
  steps: [{
    windup: 0.95, active: 0.6, recovery: 1.25,
    anim: { clip: 'Block', startAt: 0.0, hitFrame: 0.3 },
    extraAnims: [{ during: 'active', clip: 'Running_A', speed: 1.6, loop: true, fade: 0.08 }],
    track: { windup: 3.2, active: 0.5 },
    move: [{ kind: 'lunge', during: 'active', distance: 10, stopAt: -6 }],
    hitboxes: [
      { shape: 'cone', range: 1.9, arc: 130 },
      // floor preview of the lane only (never hits: yMin far above)
      { shape: 'line', length: 10.5, width: 2.0, yMin: 90, yMax: 99, duration: 0.05 },
    ],
    damage: 24, knockback: 11, shake: 0.3,
  }],
};

const pincerV: AttackDef = {
  // Pair move (the director starts both): Varek's lunging thrust from the front.
  id: 'v_pincer', name: 'Pincer — Breaker', telegraph: 'parryable',
  steps: [{
    windup: 1.6, active: 0.16, recovery: 1.3,
    anim: { clip: '2H_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.72 },
    track: { windup: 2.4, active: 0 },
    move: [{ kind: 'lunge', during: 'active', distance: 1.6, stopAt: 0.4 }],
    hitboxes: [{ shape: 'line', length: 5.6, width: 1.3 }],
    damage: 26, knockback: 8, parryPoise: 40,
  }],
};

// ---------------------------------------------------------------- Varek, enraged (Selene fell)
const knivesV: AttackDef = {
  // inherited from Selene: a fan of three knives (gold — parry reflects them)
  id: 'e_knives', name: 'Widow Knives', telegraph: 'parryable',
  steps: [{
    windup: 0.65, active: 0.3, recovery: 0.8,
    anim: { clip: 'Throw', startAt: 0.1, hitFrame: 0.6 },
    track: { windup: 4, active: 2 },
    hitboxes: [{ shape: 'projectile', count: 3, interval: 0.12, spread: 22, speed: 17, homing: 0.35, lifetime: 2.2, radius: 0.22, reflectable: true, reflectDamage: 30, reflectPoise: 30 }],
    damage: 11, knockback: 3, heavy: false,
  }],
};

const blinkChop: AttackDef = {
  // after his (inherited) blink: the chop has its full wind-up from the moment he reappears
  id: 'e_blinkChop', name: 'Phantom Chop', telegraph: 'parryable',
  steps: [{
    windup: 0.8, active: 0.14, recovery: 1.15,
    anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.2, hitFrame: 0.78 },
    track: { windup: 5 },
    move: [{ kind: 'lunge', during: 'windup', from: 0.6, to: 1, distance: 1.4, stopAt: 0.9 }],
    hitboxes: [{ shape: 'cone', range: 3.6, arc: 70 }],
    damage: 24, knockback: 8, shake: 0.25,
  }],
};

const rend5: AttackDef = {
  // enraged: five hits — slice, back slice, kick (red), back slice, delayed chop
  id: 'e_rend5', name: 'Grief Unbound', telegraph: 'parryable',
  steps: [
    rendSlice,
    rendBack,
    { ...kick.steps[0], telegraph: 'unblockable', windup: 0.55, recovery: 0.2 },
    { ...rendBack, windup: 0.5 },
    rendDelayedChop,
  ],
};

/** Copy an attack with scaled windups / recoveries (enraged = faster). */
function quicken(def: AttackDef, id: string, windup: number, recovery: number): AttackDef {
  return {
    ...def,
    id,
    steps: def.steps.map((s) => ({ ...s, windup: Math.max(0.42, s.windup * windup), recovery: s.recovery * recovery })),
  };
}

export const VarekAttacks: AttackDef[] = [
  chop, sweep, rend, rend4, kick, leap, doubleLeap, charge, pincerV,
  knivesV, blinkChop, rend5,
  quicken(chop, 'e_chop', 0.85, 0.85),
  quicken(sweep, 'e_sweep', 0.85, 0.85),
  quicken(rend4, 'e_rend4', 0.88, 0.85),
  quicken(leap, 'e_leap', 0.88, 0.85),
  quicken(charge, 'e_charge', 0.85, 0.85),
  quicken(kick, 'e_kick', 0.9, 0.85),
];

// ================================================================== SELENE THE VEIL
// Support: dual daggers, knives (reflectable), ward, heal, blink, smoke bomb.

const slash2: AttackDef = {
  id: 's_slash2', name: 'Twin Fangs', telegraph: 'parryable',
  steps: [
    {
      windup: 0.55, active: 0.15, recovery: 0.12,
      anim: { clip: 'Dualwield_Melee_Attack_Slice', startAt: 0.05, hitFrame: 0.45, speed: 1.1 },
      move: [{ kind: 'lunge', during: 'windup', from: 0.4, to: 1, distance: 1.5, stopAt: 0.7 }],
      hitboxes: [{ shape: 'sweep', range: 2.8, from: -75, to: 75, width: 30 }],
      damage: 10, knockback: 2, heavy: false,
    },
    {
      windup: 0.42, active: 0.12, recovery: 0.95,
      anim: { clip: 'Dualwield_Melee_Attack_Chop', startAt: 0.15, hitFrame: 0.55, speed: 1.1 },
      move: [{ kind: 'lunge', during: 'windup', from: 0.3, to: 1, distance: 1.0, stopAt: 0.6 }],
      hitboxes: [{ shape: 'cone', range: 2.7, arc: 60 }],
      damage: 12, knockback: 4, heavy: false,
    },
  ],
};

const flurry: AttackDef = {
  // Phase 2: slice, chop, then a DELAYED lunging stab.
  id: 's_flurry', name: 'Veil Flurry', telegraph: 'parryable',
  steps: [
    slash2.steps[0],
    { ...slash2.steps[1], recovery: 0.15 },
    {
      windup: 0.95, active: 0.16, recovery: 1.1,
      anim: { clip: 'Dualwield_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.65, pacing: 'hold' },
      track: { windup: 5 },
      move: [{ kind: 'lunge', during: 'active', distance: 2.2, stopAt: 0.5 }],
      hitboxes: [{ shape: 'line', length: 3.6, width: 1.0, decal: false }],
      damage: 16, knockback: 6, parryPoise: 40,
    },
  ],
};

const lunge: AttackDef = {
  id: 's_lunge', name: 'Viper Lunge', telegraph: 'parryable',
  steps: [{
    windup: 0.8, active: 0.18, recovery: 1.05,
    anim: { clip: 'Dualwield_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.65 },
    track: { windup: 4, active: 0 },
    move: [{ kind: 'lunge', during: 'active', distance: 3.4, stopAt: 0.5 }],
    hitboxes: [{ shape: 'line', length: 3.6, width: 1.0 }],
    damage: 15, knockback: 5,
  }],
};

const knife: AttackDef = {
  // one fast knife; gold: block it, sidestep it, or PARRY it back (big poise damage to her).
  id: 's_knife', name: 'Veil Knife', telegraph: 'parryable',
  steps: [{
    windup: 0.65, active: 0.1, recovery: 0.75,
    anim: { clip: 'Throw', startAt: 0.1, hitFrame: 0.6 },
    track: { windup: 4, active: 2 },
    hitboxes: [{ shape: 'projectile', speed: 18, homing: 0.45, lifetime: 2.2, radius: 0.2, reflectable: true, reflectDamage: 30, reflectPoise: 40 }],
    damage: 10, knockback: 3, heavy: false,
  }],
};

const fan: AttackDef = {
  id: 's_fan', name: 'Knife Fan', telegraph: 'parryable',
  steps: [{
    windup: 0.75, active: 0.3, recovery: 0.85,
    anim: { clip: 'Throw', startAt: 0.1, hitFrame: 0.6 },
    track: { windup: 4, active: 2 },
    hitboxes: [{ shape: 'projectile', count: 3, interval: 0.1, spread: 26, speed: 17, homing: 0.25, lifetime: 2.2, radius: 0.2, reflectable: true, reflectDamage: 22, reflectPoise: 25 }],
    damage: 10, knockback: 3, heavy: false,
  }],
};

const ambush: AttackDef = {
  // out of the smoke: full gold wind-up from the moment she reappears
  id: 's_ambush', name: 'Veil Ambush', telegraph: 'parryable',
  steps: [{
    windup: 0.85, active: 0.18, recovery: 1.1,
    anim: { clip: 'Dualwield_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.65 },
    track: { windup: 5, active: 0 },
    move: [{ kind: 'lunge', during: 'active', distance: 2.6, stopAt: 0.5 }],
    hitboxes: [{ shape: 'line', length: 3.8, width: 1.1 }],
    damage: 16, knockback: 6,
  }],
};

const pincerS: AttackDef = {
  // Pair move: Selene's stab from BEHIND, landing ~0.55 s after Varek's thrust. Sidestep both lanes.
  id: 's_pincer', name: 'Pincer — Veil', telegraph: 'parryable',
  steps: [{
    windup: 1.65, active: 0.16, recovery: 1.2,
    anim: { clip: 'Dualwield_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.65, pacing: 'hold' },
    track: { windup: 2.4, active: 0 },
    move: [{ kind: 'lunge', during: 'active', distance: 1.4, stopAt: 0.4 }],
    hitboxes: [{ shape: 'line', length: 5.0, width: 1.1 }],
    damage: 18, knockback: 7,
  }],
};

// support (no hitboxes → no token needed)
const ward: AttackDef = {
  // cyan: Varek turns invulnerable for a few seconds. Hit her during the cast to break it.
  id: 's_ward', name: 'Warden’s Veil', telegraph: 'magic',
  steps: [{
    windup: 1.3, active: 0.2, recovery: 0.8,
    anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0 },
    track: { windup: 1.5 },
    hitboxes: [],
    damage: 0, heavy: false,
  }],
};

const heal: AttackDef = {
  // cyan channel: heals Varek while active. Interrupt by hitting her.
  id: 's_heal', name: 'Mending Thread', telegraph: 'magic',
  steps: [{
    windup: 0.7, active: 2.6, recovery: 0.8,
    anim: { clip: 'Spellcast_Raise', startAt: 0.3, hitFrame: 1.0 },
    extraAnims: [{ during: 'active', clip: 'Spellcasting', loop: true, fade: 0.2 }],
    track: { windup: 1, active: 0, recovery: 1 },
    hitboxes: [],
    damage: 0, heavy: false,
  }],
};

const smoke: AttackDef = {
  // throws a smoke bomb at her feet and vanishes (see Selene.onCustomState)
  id: 's_smoke', name: 'Smoke Bomb', telegraph: 'magic',
  steps: [{
    windup: 0.45, active: 0.05, recovery: 0.05,
    anim: { clip: 'Throw', startAt: 0.25, hitFrame: 0.6, speed: 1.4 },
    hitboxes: [],
    damage: 0, heavy: false, flash: false,
  }],
};

const clones: AttackDef = {
  // enraged: summons two smoke clones that throw knives
  id: 's_clones', name: 'Veil of Echoes', telegraph: 'magic',
  steps: [{
    windup: 0.9, active: 0.2, recovery: 0.7,
    anim: { clip: 'Spellcast_Shoot', startAt: 0.0, hitFrame: 0.45, speed: 0.8 },
    hitboxes: [],
    damage: 0, heavy: false,
  }],
};

// ---------------------------------------------------------------- Selene, enraged (Varek fell): his axe
const axeCleave: AttackDef = {
  // heavier and slower than Varek — but HUGE reach (floor preview on)
  id: 'a_cleave', name: 'Inherited Cleave', telegraph: 'parryable',
  steps: [{
    windup: 1.05, active: 0.16, recovery: 1.25,
    anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.15, hitFrame: 0.78, speed: 0.95 },
    move: [{ kind: 'lunge', during: 'windup', from: 0.55, to: 1, distance: 2.2, stopAt: 1.4 }],
    hitboxes: [{ shape: 'cone', range: 5.4, arc: 46, decal: true }],
    damage: 28, knockback: 9, shake: 0.35,
  }],
};

const axeSweep: AttackDef = {
  id: 'a_sweep', name: 'Mourning Arc', telegraph: 'parryable',
  steps: [{
    windup: 0.95, active: 0.34, recovery: 1.2,
    anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.05, hitFrame: 0.42, speed: 0.85 },
    track: { windup: 3.5 },
    hitboxes: [{ shape: 'sweep', range: 5.6, from: -120, to: 120, width: 30, decal: true }],
    damage: 22, knockback: 7,
  }],
};

const axeSpin: AttackDef = {
  // LOW red spin: unblockable, but it only hits the ground level — JUMP it (or roll through).
  id: 'a_spin', name: 'Widow’s Wheel', telegraph: 'unblockable',
  steps: [{
    windup: 1.0, active: 0.5, recovery: 1.4,
    anim: { clip: '2H_Melee_Attack_Spin', startAt: 0.3, hitFrame: 0.9 },
    track: { windup: 3.5, active: 0 },
    hitboxes: [{ shape: 'sweep', range: 4.6, from: -180, to: 180, width: 40, yMax: 0.7, decal: true }],
    damage: 24, knockback: 8,
  }],
};

const axeLeap: AttackDef = { ...leap, id: 'a_leap', name: 'Widow’s Fall' };

const blinkCleave: AttackDef = {
  id: 'a_blinkCleave', name: 'Veiled Cleave', telegraph: 'parryable',
  steps: [{ ...axeCleave.steps[0], windup: 0.9, track: { windup: 5 } }],
};

export const SeleneAttacks: AttackDef[] = [
  slash2, flurry, lunge, knife, fan, ambush, pincerS, ward, heal, smoke, clones,
  axeCleave, axeSweep, axeSpin, axeLeap, blinkCleave,
];

/** Damaging = has at least one hitbox (needs the pair token). */
export function isDamaging(def: AttackDef) {
  return def.steps.some((s) => s.hitboxes.length > 0);
}
