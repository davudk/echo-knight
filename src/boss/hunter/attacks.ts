import type { AttackDef, AttackStep, HitboxDef, StepAnim } from '../types';

/**
 * Kaede, the Last Hunter — moveset. Times are seconds on Normal (windups ×1.3 Story / ×0.85 Souls,
 * final recoveries likewise). A Sekiro-style duelist: fast deflectable strings with varied rhythm
 * (onParry 'none' — deflects only build posture, the string keeps coming), few but sharp perilous
 * (red) attacks with ONE specific answer each, and phase-2 lightning.
 *
 * Clip impact frames (KayKit rig, clip seconds):
 *   1H Slice_Diagonal 0.42 · 1H Slice_Horizontal 0.46 · 1H Chop 0.52 · 1H Stab 0.72 ·
 *   Dualwield Slice 0.5 · Unarmed Kick 0.38 · Punch_A 0.55 · Throw 0.6 · Spellcast_Raise 1.0
 */

const DIAG: StepAnim = { clip: '1H_Melee_Attack_Slice_Diagonal', startAt: 0.08, hitFrame: 0.42, speed: 1.3 };
const HORIZ: StepAnim = { clip: '1H_Melee_Attack_Slice_Horizontal', startAt: 0.1, hitFrame: 0.46, speed: 1.3 };
const CHOP: StepAnim = { clip: '1H_Melee_Attack_Chop', startAt: 0.05, hitFrame: 0.52, speed: 1.2 };
const STAB: StepAnim = { clip: '1H_Melee_Attack_Stab', startAt: 0.15, hitFrame: 0.72, speed: 1.2 };
const DWSLICE: StepAnim = { clip: 'Dualwield_Melee_Attack_Slice', startAt: 0.08, hitFrame: 0.5, speed: 1.1 };

const held = (a: StepAnim): StepAnim => ({ ...a, pacing: 'hold' });

interface SlashOpts {
  lunge?: number;
  dmg?: number;
  /** sweep from → to (deg, + = boss's left) */
  arc?: [number, number];
  range?: number;
  recovery?: number;
  active?: number;
  parryPoise?: number;
  hold?: boolean;
  extra?: Partial<AttackStep>;
}

/** One deflectable katana swing: a fast blade arc with a short step-in. */
function slash(anim: StepAnim, windup: number, o: SlashOpts = {}): AttackStep {
  const [from, to] = o.arc ?? [-75, 75];
  return {
    windup,
    active: o.active ?? 0.14,
    recovery: o.recovery ?? 0.1,
    anim: o.hold ? held(anim) : anim,
    move: o.lunge === 0 ? undefined : [{ kind: 'lunge', during: 'windup', from: 0.45, to: 1, distance: o.lunge ?? 1.8, stopAt: 0.9 }],
    track: { windup: 7, active: 0.6, recovery: 2 },
    hitboxes: [{ shape: 'sweep', range: o.range ?? 3.3, from, to, width: 32 }],
    damage: o.dmg ?? 13,
    knockback: 3,
    heavy: false,
    parryPoise: o.parryPoise,
    ...o.extra,
  };
}

/** A feint: the blade comes up exactly like a real swing, then stops short (no hitbox, no glint). */
function feint(anim: StepAnim, windup: number): AttackStep {
  return {
    windup, active: 0.04, recovery: 0.06, anim: held(anim),
    track: { windup: 7, active: 4, recovery: 4 },
    hitboxes: [], damage: 0, parryable: false, flash: false,
  };
}

/**
 * Perilous thrust (red) as two steps: he draws back and AIMS (tracks you, red flash + 危), then a short
 * committed lunge along a fixed line. Sidestep / roll on the commit, dodge INTO it to stomp the blade,
 * or (counter style) press block on the commit.
 */
function thrustSteps(aim: number, recovery: number, dmg = 30): AttackStep[] {
  return [
    {
      windup: aim, active: 0.02, recovery: 0,
      anim: { ...STAB, hitFrame: 0.45 },
      track: { windup: 6, active: 6 },
      move: [{ kind: 'retreat', during: 'windup', from: 0, to: 0.4, distance: 0.6 }],
      hitboxes: [], damage: 0, telegraph: 'unblockable',
    },
    {
      windup: 0.3, active: 0.18, recovery,
      anim: { ...STAB, startAt: 0.45, pacing: 'hold' },
      track: { windup: 0, active: 0, recovery: 1 },
      move: [
        { kind: 'lunge', during: 'windup', from: 0, to: 0.7, distance: 1.6, stopAt: 1.4 },
        { kind: 'lunge', during: 'active', distance: 2.6, stopAt: 0.25 },
      ],
      hitboxes: [{ shape: 'line', length: 4.8, width: 0.9, offset: 0.2 }],
      damage: dmg, knockback: 8, heavy: true, telegraph: 'unblockable', shake: 0.25, flash: false,
    },
  ];
}

/**
 * Dash-slash as two steps: a crouch that tracks you (no hitbox), then the committed dash during a short
 * windup so the cut always lands exactly on the second glint, whatever the distance.
 */
function dashSteps(crouch: number, anim: StepAnim, recovery: number, dmg: number): AttackStep[] {
  return [
    {
      windup: crouch, active: 0.02, recovery: 0,
      anim: { ...anim, hitFrame: anim.hitFrame * 0.55 },
      track: { windup: 7, active: 7 },
      hitboxes: [], damage: 0, parryable: false,
    },
    {
      windup: 0.2, active: 0.1, recovery,
      anim: { ...anim, startAt: anim.hitFrame * 0.55 },
      track: { windup: 0, active: 0, recovery: 1.5 },
      move: [{ kind: 'lunge', during: 'windup', from: 0, to: 1, distance: 11, stopAt: 0.5 }],
      hitboxes: [{ shape: 'line', length: 2.6, width: 1.5, offset: 0.1, decal: false }],
      damage: dmg, knockback: 6, heavy: true, parryPoise: 14,
    },
  ];
}

const sweepBox = (range: number): HitboxDef => ({ shape: 'sweep', range, from: 115, to: -115, width: 30, yMax: 0.6, decal: true });

export const HunterAttacks: AttackDef[] = [
  // ============================================================== gold strings (deflect!)
  {
    // Two quick cuts. The bread-and-butter deflect check.
    id: 'flurry2', name: 'Twin Cut', telegraph: 'parryable',
    steps: [
      slash(DIAG, 0.5, { lunge: 2.2, arc: [-60, 75] }),
      slash(HORIZ, 0.34, { arc: [85, -85], recovery: 0.75 }),
    ],
  },
  {
    // Three cuts: the third is a HELD overhead (delayed) — deflect on the snap, not on the rhythm.
    id: 'flurry3', name: 'Falling Leaves', telegraph: 'parryable',
    steps: [
      slash(DIAG, 0.48, { lunge: 2.0, arc: [-60, 75] }),
      slash(HORIZ, 0.32, { arc: [85, -85] }),
      slash(CHOP, 0.82, { hold: true, arc: [20, -20], range: 3.5, dmg: 18, parryPoise: 15, recovery: 0.95, lunge: 1.4 }),
    ],
  },
  {
    // Rhythm variant: a held opener, then two snap cuts back to back.
    id: 'flurry3b', name: 'Wind Through Reeds', telegraph: 'parryable',
    steps: [
      slash(HORIZ, 0.66, { hold: true, lunge: 2.4, arc: [85, -85] }),
      slash(DIAG, 0.27, { arc: [-60, 75], lunge: 0.8 }),
      slash(HORIZ, 0.27, { arc: [85, -85], recovery: 0.85, lunge: 0.8, dmg: 15 }),
    ],
  },
  {
    // The blade rises like a cut... and stops. The real swing follows on a different beat.
    id: 'feint', name: 'False Moon', telegraph: 'parryable',
    steps: [
      feint(CHOP, 0.42),
      slash(DIAG, 0.5, { hold: true, lunge: 1.4, arc: [-60, 75], dmg: 16, recovery: 0.85 }),
    ],
  },
  {
    // Lightning dash across the arena: a crouch (tracks you), then a second glint and he is ON you
    // 0.2 s later along a committed line. Deflect on the second glint, or roll / sidestep off the line.
    id: 'dash', name: 'Flash Step', telegraph: 'parryable',
    steps: [...dashSteps(0.58, HORIZ, 0.9, 20)],
  },
  {
    // Shuriken fan. Deflect (block-parry) to send them back; blocking also works.
    id: 'shuriken', name: 'Shuriken', telegraph: 'parryable',
    steps: [{
      windup: 0.55, active: 0.3, recovery: 0.6,
      anim: { clip: 'Throw', startAt: 0.15, hitFrame: 0.6, speed: 1.3 },
      track: { windup: 6, active: 3 },
      move: [{ kind: 'retreat', during: 'windup', from: 0, to: 0.5, distance: 1.8 }],
      hitboxes: [{
        shape: 'projectile', count: 3, interval: 0.11, spread: 14, speed: 19, homing: 0.35, lifetime: 1.6, radius: 0.28,
        reflectable: true, reflectDamage: 12, reflectPoise: 14, height: 1.4,
      }],
      damage: 8, knockback: 2, heavy: false,
    }],
  },
  {
    // Raised guard (no attack). Strike into it and he deflects YOU, then cuts back. Wait it out.
    id: 'stance', name: 'Still Water', telegraph: 'parryable',
    steps: [{
      windup: 1.5, active: 0.02, recovery: 0.12,
      anim: { clip: 'Blocking', startAt: 0, hitFrame: 0.6 },
      track: { windup: 5 },
      hitboxes: [], damage: 0, parryable: false, flash: false,
    }],
  },
  {
    // The answer from the guard stance (or after deflecting two careless swings). Fast, but gold.
    id: 'stanceCut', name: 'Reflection', telegraph: 'parryable',
    steps: [slash(HORIZ, 0.42, { lunge: 1.2, arc: [85, -85], dmg: 20, parryPoise: 12, recovery: 0.8 })],
  },
  {
    // Out of the smoke behind you: a held overhead. Listen for the shimmer, turn, deflect or roll.
    id: 'ambush', name: 'Smoke Fang', telegraph: 'parryable',
    steps: [slash(CHOP, 0.62, { hold: true, lunge: 1.0, arc: [40, -40], range: 3.5, dmg: 20, parryPoise: 14, recovery: 0.9 })],
  },
  {
    // Smoke bomb: vanish (the class takes over: shimmer behind the player → ambush).
    id: 'vanish', name: 'Smoke Veil', telegraph: 'parryable',
    steps: [{
      windup: 0.42, active: 0.05, recovery: 0.05,
      anim: { clip: 'Throw', startAt: 0.2, hitFrame: 0.6, speed: 1.2 },
      hitboxes: [], damage: 0, parryable: false, flash: false,
    }],
  },
  {
    // Leap high and plunge onto you (gold — deflect it, or roll away from the landing mark).
    id: 'plunge', name: 'Falling Hawk', telegraph: 'parryable',
    steps: [{
      windup: 1.05, active: 0.1, recovery: 1.0,
      anim: { ...CHOP, startAt: 0.0, pacing: 'hold' },
      move: [{ kind: 'leap', during: 'windup', from: 0.22, to: 1, height: 5, maxDistance: 11, stopAt: 0.7 }],
      track: { windup: 6 },
      hitboxes: [{ shape: 'circle', at: 'leap', lockAt: 0.24, radius: 2.0 }],
      damage: 22, knockback: 6, heavy: true, parryPoise: 16, shake: 0.35,
    }],
  },

  // ============================================================== red: perilous (危)
  {
    // Low sweep at ankle height: JUMP it (block / deflect do nothing). Land an air attack on his head for posture.
    id: 'sweep', name: 'Reaping Wind', telegraph: 'unblockable',
    steps: [{
      windup: 0.82, active: 0.24, recovery: 1.2,
      anim: DWSLICE,
      move: [{ kind: 'lunge', during: 'windup', from: 0.55, to: 1, distance: 1.6, stopAt: 1.2 }],
      track: { windup: 6, active: 0 },
      hitboxes: [sweepBox(3.9)],
      damage: 26, knockback: 7, heavy: true,
    }],
  },
  {
    // Lunging thrust: sidestep it, or dodge INTO it to stomp the blade (counter style: press block).
    id: 'thrust', name: 'Piercing Moon', telegraph: 'unblockable',
    steps: thrustSteps(0.6, 1.15),
  },
  {
    // Grab: roll through or away before it lands.
    id: 'grab', name: 'Hunter’s Snare', telegraph: 'unblockable',
    steps: [{
      windup: 0.8, active: 0.22, recovery: 1.3,
      anim: { clip: 'Unarmed_Melee_Attack_Punch_A', startAt: 0.1, hitFrame: 0.55, speed: 0.9 },
      move: [
        { kind: 'lunge', during: 'windup', from: 0.55, to: 1, distance: 2.4, stopAt: 0.8 },
        { kind: 'lunge', during: 'active', distance: 1.2, stopAt: 0.5 },
      ],
      track: { windup: 6, active: 2 },
      hitboxes: [{ shape: 'grab', range: 2.5, arc: 70, hold: 0.9, throwClip: 'Unarmed_Melee_Attack_Kick', throwKnockback: 9, decal: true }],
      damage: 30, knockback: 9,
    }],
  },

  // ============================================================== phase 2 (second life, lightning blade)
  {
    // Four cuts, the last one held.
    id: 'flurry4', name: 'Storm of Petals', telegraph: 'parryable',
    steps: [
      slash(DIAG, 0.42, { lunge: 2.2, arc: [-60, 75] }),
      slash(HORIZ, 0.28, { arc: [85, -85] }),
      slash(DIAG, 0.3, { arc: [-60, 75], lunge: 1.0 }),
      slash(CHOP, 0.7, { hold: true, arc: [20, -20], range: 3.5, dmg: 18, parryPoise: 15, recovery: 0.85, lunge: 1.4 }),
    ],
  },
  {
    // Feint, then the PERILOUS thrust: the glow turns red on the second beat.
    id: 'feintThrust', name: 'Hidden Moon', telegraph: 'parryable',
    steps: [feint(DIAG, 0.4), ...thrustSteps(0.42, 1.1, 28)],
  },
  {
    // Double feint into a real cut — don't press on the first two.
    id: 'feint2', name: 'Moon in Water', telegraph: 'parryable',
    steps: [feint(CHOP, 0.38), feint(HORIZ, 0.34), slash(DIAG, 0.4, { lunge: 1.6, arc: [-60, 75], dmg: 16, recovery: 0.8 })],
  },
  {
    // Cut, then a lightning-charged overhead that releases a ground ring (cyan): deflect, then JUMP.
    id: 'thunderCut', name: 'Thunder Fang', telegraph: 'parryable',
    steps: [
      slash(HORIZ, 0.48, { lunge: 2.0, arc: [85, -85] }),
      {
        ...slash(CHOP, 0.56, { hold: true, arc: [20, -20], range: 3.5, dmg: 18, parryPoise: 14, recovery: 1.0, lunge: 1.2 }),
        hitboxes: [
          { shape: 'sweep', range: 3.5, from: 20, to: -20, width: 32 },
          { shape: 'ring', at: 'forward', distance: 1.4, speed: 8, maxRadius: 9, thickness: 0.7, startRadius: 0.8, delay: 0.22, damage: 14, knockback: 5, telegraph: 'magic' },
        ],
        shake: 0.3,
      },
    ],
  },
  {
    // Two dashes: at you, then back again.
    id: 'dash2', name: 'Twin Flash', telegraph: 'parryable',
    steps: [...dashSteps(0.52, HORIZ, 0.15, 18), ...dashSteps(0.4, DIAG, 0.95, 18)],
  },
  {
    // Lightning strike called onto you (cyan). Grounded = hit. AIRBORNE = you catch it: attack before
    // landing to hurl it back (huge posture + damage). Landing while charged shocks you.
    id: 'lightning', name: 'Heaven’s Edge', telegraph: 'magic',
    steps: [{
      windup: 1.6, active: 0.15, recovery: 1.3,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 1 },
      track: { windup: 3, active: 0 },
      hitboxes: [{ shape: 'circle', at: 'player', lockAt: 0.8, radius: 2.3, yMax: 0.5 }],
      damage: 28, knockback: 7, heavy: true, shake: 0.5,
    }],
  },
];
