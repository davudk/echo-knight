import type { AttackDef, AttackStep } from '../types';

/**
 * The Hollow Warden's moveset (times = seconds on Normal; the runner scales windups / punish
 * windows by difficulty). The Warden is a 4.6 m knight: melee reaches ~5 m, and every melee
 * hitbox stops at 2.8 m above his feet, so the pillar tops (≥ 2.9 m) are safe from swings —
 * high ground is answered by `heaven` (rising cut) and `pursuit` (leap onto your perch).
 *
 * Phase 3+ uses the "Unbound" copies built by `unbound()` (ids ending in `_u`): ~20 % shorter
 * wind-ups, shorter punish windows, faster follow-through.
 *
 * Clip impact frames: 2H Chop 0.78 · 2H Slice 0.42 · 2H Stab 0.72 · Punch_A 0.55 ·
 * Spellcast_Raise 1.0 · Spellcast_Shoot 0.45 · Block_Attack ≈ 0.4
 */

/** melee hitboxes never reach the pillar tops / wall walk */
const MELEE_TOP = 2.8;

// ------------------------------------------------------------------ reusable swings
const rendOpen: AttackStep = {
  // right-to-left horizontal sweep with a step in
  windup: 0.8, active: 0.22, recovery: 0.18,
  anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.05, hitFrame: 0.42, speed: 1 },
  move: [{ kind: 'lunge', during: 'windup', from: 0.5, to: 1, distance: 2.2, stopAt: 1.4 }],
  track: { windup: 3.5 },
  hitboxes: [{ shape: 'sweep', range: 5.2, from: -100, to: 95, width: 30, yMax: MELEE_TOP }],
  damage: 17, knockback: 4, heavy: false,
  // string opener: a parry is a deflect (poise only) — he keeps swinging; parry the whole string
  onParry: 'none', parryPoise: 22,
};

const rendChop: AttackStep = {
  windup: 0.62, active: 0.14, recovery: 0.2,
  anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.35, hitFrame: 0.78, speed: 1.1 },
  move: [{ kind: 'lunge', during: 'windup', from: 0.3, to: 1, distance: 2.0, stopAt: 1.2 }],
  track: { windup: 4 },
  hitboxes: [{ shape: 'cone', range: 5.0, arc: 55, yMax: MELEE_TOP }],
  damage: 19, knockback: 4, heavy: false,
  onParry: 'none', parryPoise: 22,
};

export const WardenAttacks: AttackDef[] = [
  // ============================================================== phase 1 — The Knight
  {
    // Three-hit string; the third is a HELD thrust (the blade drawn back at the shoulder, frozen):
    // rolling on rhythm eats it. Parrying it staggers him (riposte).
    id: 'rend',
    name: 'Hollow Rend',
    telegraph: 'parryable',
    steps: [
      rendOpen,
      rendChop,
      {
        windup: 1.45, active: 0.18, recovery: 1.45,
        anim: { clip: '2H_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.72, speed: 1, pacing: 'hold' },
        track: { windup: 5 },
        move: [{ kind: 'lunge', during: 'active', distance: 2.4, stopAt: 0.5 }],
        hitboxes: [{ shape: 'line', length: 6.2, width: 1.6, decal: false, yMax: MELEE_TOP }],
        damage: 30, knockback: 9, parryPoise: 60, onParry: 'stagger',
      },
    ],
  },
  {
    // Same opening, but the third is a QUICK wide backhand (blade wound back at the hip, no hold):
    // the pose tells you which one is coming.
    id: 'rendQuick',
    name: 'Hollow Rend (quick)',
    telegraph: 'parryable',
    steps: [
      rendOpen,
      rendChop,
      {
        windup: 0.58, active: 0.24, recovery: 1.25,
        anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.0, hitFrame: 0.42, speed: 0.95 },
        move: [{ kind: 'lunge', during: 'windup', from: 0.4, to: 1, distance: 1.6, stopAt: 1.2 }],
        track: { windup: 4.5 },
        hitboxes: [{ shape: 'sweep', range: 5.4, from: 105, to: -105, width: 30, yMax: MELEE_TOP }],
        damage: 22, knockback: 7,
      },
    ],
  },
  {
    // Short string (variable combo length): two hits then a long recovery.
    id: 'rend2',
    name: 'Hollow Rend (short)',
    telegraph: 'parryable',
    steps: [rendOpen, { ...rendChop, recovery: 1.2, damage: 22, knockback: 7, heavy: true, onParry: 'recoil', parryPoise: 30 }],
  },
  {
    // Single overhead cleave with a big step in. Mimic-able.
    id: 'cleave',
    name: 'Cleave',
    telegraph: 'parryable',
    steps: [{
      windup: 0.95, active: 0.14, recovery: 1.2,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.15, hitFrame: 0.78, speed: 1 },
      move: [{ kind: 'lunge', during: 'windup', from: 0.5, to: 1, distance: 2.8, stopAt: 1.2 }],
      track: { windup: 3.5 },
      hitboxes: [{ shape: 'cone', range: 5.2, arc: 65, yMax: MELEE_TOP, decal: true }],
      damage: 26, knockback: 8, shake: 0.3,
    }],
  },
  {
    // Overhead slam: the impact area hurts, then a slow shockwave ring rolls out — JUMP it.
    id: 'slam',
    name: 'Hollow Slam',
    telegraph: 'unblockable',
    steps: [{
      windup: 1.15, active: 0.12, recovery: 1.5,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.1, hitFrame: 0.78, speed: 0.9 },
      move: [{ kind: 'lunge', during: 'windup', from: 0.6, to: 1, distance: 2.0, stopAt: 2.2 }],
      track: { windup: 2.5 },
      hitboxes: [
        { shape: 'circle', at: 'forward', distance: 3.4, radius: 2.4, lockAt: 0.55 },
        { shape: 'ring', at: 'forward', distance: 3.4, speed: 6.5, maxRadius: 14, thickness: 0.9, startRadius: 1.4, damage: 18, knockback: 7 },
      ],
      damage: 32, knockback: 9, shake: 0.6,
    }],
  },
  {
    // Long-range thrust lunge (~11 m): punishes backing off. Gold — parry or roll sideways.
    id: 'thrust',
    name: 'Hollow Lance',
    telegraph: 'parryable',
    steps: [{
      windup: 1.0, active: 0.34, recovery: 1.35,
      anim: { clip: '2H_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.72, speed: 0.8 },
      track: { windup: 4.5, active: 0, recovery: 0.6 },
      move: [{ kind: 'lunge', during: 'active', from: 0, to: 0.8, distance: 11, stopAt: 0.4 }],
      hitboxes: [{ shape: 'line', length: 4.8, width: 1.7, offset: 0.4, decal: false, yMax: MELEE_TOP }],
      damage: 26, knockback: 10,
    }],
  },
  {
    // Lunging grab → lifted → slammed down. Red: can't block or parry — dodge before it closes.
    id: 'grab',
    name: 'Hollow Grasp',
    telegraph: 'unblockable',
    steps: [{
      windup: 1.0, active: 0.26, recovery: 1.5,
      anim: { clip: 'Unarmed_Melee_Attack_Punch_A', startAt: 0.1, hitFrame: 0.55, speed: 0.9 },
      move: [
        { kind: 'lunge', during: 'windup', from: 0.55, to: 1, distance: 3.0, stopAt: 1.0 },
        { kind: 'lunge', during: 'active', distance: 1.5, stopAt: 0.6 },
      ],
      track: { windup: 5, active: 2 },
      hitboxes: [{ shape: 'grab', range: 3.2, arc: 70, hold: 1.2, holdClip: 'Unarmed_Idle', throwClip: '2H_Melee_Attack_Chop', throwKnockback: 4, decal: true }],
      damage: 38, knockback: 10,
    }],
  },
  {
    // Shoulder charge: gap closer from mid range, body-checks along its path.
    id: 'charge',
    name: 'Rampart Charge',
    telegraph: 'parryable',
    steps: [{
      windup: 0.85, active: 0.42, recovery: 1.2,
      anim: { clip: 'Block_Attack', startAt: 0.0, hitFrame: 0.38, speed: 0.6 },
      track: { windup: 4, active: 0 },
      move: [{ kind: 'lunge', during: 'active', distance: 7.5, stopAt: 0 }],
      hitboxes: [{ shape: 'cone', range: 2.5, arc: 75, offset: 0.3, yMax: MELEE_TOP }],
      damage: 22, knockback: 13,
    }],
  },
  {
    // Anti-backstab: a fast reverse sweep that covers his back and sides.
    id: 'turnSweep',
    name: 'Turning Reap',
    telegraph: 'parryable',
    steps: [{
      // a full spin starting behind him: reaches every side, no tracking (no matter which way you circle)
      windup: 0.66, active: 0.4, recovery: 1.1,
      anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.05, hitFrame: 0.42, speed: 0.9 },
      track: { windup: 0, active: 0 },
      hitboxes: [{ shape: 'sweep', range: 5.2, from: 180, to: -180, width: 30, yMax: MELEE_TOP, decal: true }],
      damage: 20, knockback: 7,
    }],
  },
  {
    // Anti-air / anti-perch rising cut (only hits ABOVE 1.2 m).
    id: 'heaven',
    name: 'Rising Cut',
    telegraph: 'parryable',
    steps: [{
      windup: 0.7, active: 0.22, recovery: 1.0,
      anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.0, hitFrame: 0.42, speed: 0.8 },
      track: { windup: 5 },
      hitboxes: [{ shape: 'cone', range: 5.4, arc: 95, yMin: 1.2, yMax: 5.2, decal: true }],
      damage: 22, knockback: 8,
    }],
  },
  {
    // Leap onto the player's perch (lands where you stood when he jumped, on top of whatever you
    // stand on). Air-dash / wall-kick away, or meet him in the air: an air hit knocks him down.
    id: 'pursuit',
    name: 'Hollow Pursuit',
    telegraph: 'unblockable',
    steps: [{
      windup: 1.3, active: 0.12, recovery: 1.4,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.1, hitFrame: 0.78, speed: 0.9 },
      move: [{ kind: 'leap', during: 'windup', from: 0.4, to: 1, height: 4.2, maxDistance: 18, stopAt: 0 }],
      track: { windup: 4 },
      hitboxes: [
        { shape: 'circle', at: 'leap', lockAt: 0.41, radius: 2.6, yMin: -4.5, yMax: 4.5 },
        { shape: 'ring', speed: 8, maxRadius: 9, thickness: 0.8, startRadius: 1.6, damage: 14, knockback: 6 },
      ],
      damage: 30, knockback: 9, shake: 0.7,
    }],
  },

  // ============================================================== phase 2 — The Echo
  {
    // Double-ring slam (phase 2+): two rings, two jumps.
    id: 'slam2',
    name: 'Echoing Slam',
    telegraph: 'unblockable',
    steps: [{
      windup: 1.15, active: 0.12, recovery: 1.5,
      anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.1, hitFrame: 0.78, speed: 0.9 },
      move: [{ kind: 'lunge', during: 'windup', from: 0.6, to: 1, distance: 2.0, stopAt: 2.2 }],
      track: { windup: 2.5 },
      hitboxes: [
        { shape: 'circle', at: 'forward', distance: 3.4, radius: 2.4, lockAt: 0.55 },
        { shape: 'ring', at: 'forward', distance: 3.4, speed: 6.5, maxRadius: 14, thickness: 0.9, startRadius: 1.4, damage: 16, knockback: 6 },
        { shape: 'ring', at: 'forward', distance: 3.4, speed: 6.5, maxRadius: 14, thickness: 0.9, startRadius: 1.4, damage: 16, knockback: 6, delay: 0.6, telegraph: 'magic' },
      ],
      damage: 30, knockback: 9, shake: 0.6,
    }],
  },
  {
    // Plants an echo of himself where he stands (it kneels there) and steps away from it.
    id: 'plantEcho',
    name: 'Leave an Echo',
    telegraph: 'magic',
    steps: [{
      windup: 0.65, active: 0.1, recovery: 0.75,
      anim: { clip: 'Spellcast_Raise', startAt: 0.4, hitFrame: 1.0, speed: 1 },
      track: { windup: 2 },
      move: [{ kind: 'retreat', during: 'recovery', from: 0.05, to: 0.8, distance: 4.5 }],
      hitboxes: [],
      damage: 0,
    }],
  },
  {
    // Echo ambush: a sweep, then he RECALLS to his planted echo (it charges up first — watch it)
    // and cleaves from there, usually from behind you.
    id: 'ambushCombo',
    name: 'Echo Ambush',
    telegraph: 'parryable',
    steps: [
      { ...rendOpen, recovery: 0.12 },
      {
        // the recall: the planted echo glows (cyan column + filling ring), then he is there
        windup: 0.9, active: 0.08, recovery: 0.08,
        telegraph: 'magic',
        anim: { clip: 'Spellcast_Raise', startAt: 0.3, hitFrame: 1.0, speed: 1 },
        track: { windup: 0 },
        hitboxes: [],
        damage: 0,
      },
      {
        windup: 0.7, active: 0.14, recovery: 1.4,
        anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.15, hitFrame: 0.78, speed: 1 },
        move: [{ kind: 'lunge', during: 'windup', from: 0.4, to: 1, distance: 2.6, stopAt: 1.2 }],
        track: { windup: 6 },
        hitboxes: [{ shape: 'cone', range: 5.2, arc: 65, yMax: MELEE_TOP, decal: true }],
        damage: 26, knockback: 8, shake: 0.3,
      },
    ],
  },
  {
    // Swap trick: an echo forms BEHIND you, then he trades places with it (lock-on breaks) and
    // sweeps from there. The echo left in his old spot lingers as a decoy — hit it.
    id: 'swap',
    name: 'Mirror Swap',
    telegraph: 'magic',
    steps: [
      {
        windup: 0.8, active: 0.08, recovery: 0.1,
        anim: { clip: 'Spellcast_Shoot', startAt: 0.0, hitFrame: 0.45, speed: 0.8 },
        track: { windup: 2 },
        hitboxes: [],
        damage: 0,
      },
      {
        telegraph: 'parryable',
        windup: 0.72, active: 0.3, recovery: 1.3,
        anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.05, hitFrame: 0.42, speed: 0.9 },
        track: { windup: 6 },
        hitboxes: [{ shape: 'sweep', range: 5.4, from: -110, to: 110, width: 30, yMax: MELEE_TOP, decal: true }],
        damage: 22, knockback: 7,
      },
    ],
  },

  // ============================================================== phase 3 — Unbound
  {
    // Ground-skimming void slash across most of the arena: JUMP it (or parry it).
    id: 'reap',
    name: 'Void Reap',
    telegraph: 'parryable',
    steps: [{
      windup: 0.9, active: 0.34, recovery: 1.25,
      anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.0, hitFrame: 0.42, speed: 0.8 },
      track: { windup: 3.5 },
      hitboxes: [{ shape: 'sweep', range: 9, from: -120, to: 120, width: 28, yMax: 0.6, decal: true }],
      damage: 22, knockback: 6,
    }],
  },
  {
    // LOW void beam (knee height) sweeping 190°: jump over it. Pillar tops are above it.
    id: 'beamLow',
    name: 'Void Ray (low)',
    telegraph: 'magic',
    steps: [{
      windup: 1.15, active: 1.3, recovery: 1.3,
      anim: { clip: '2H_Melee_Attack_Slice', startAt: 0.0, hitFrame: 0.42, speed: 0.12 },
      track: { windup: 3, active: 0 },
      hitboxes: [{ shape: 'line', length: 22, width: 0.9, offset: 1.0, yawFrom: 95, yawTo: -95, tick: 0.45, yMax: 0.55 }],
      damage: 16, knockback: 4, heavy: false,
    }],
  },
  {
    // HIGH void beam (chest height): slide or roll under it. Jumping does not clear it on the
    // ground; on a pillar top you can hop it; the wall walk is above it.
    id: 'beamHigh',
    name: 'Void Ray (high)',
    telegraph: 'magic',
    steps: [{
      windup: 1.15, active: 1.3, recovery: 1.3,
      anim: { clip: '2H_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.72, speed: 0.1 },
      track: { windup: 3, active: 0 },
      hitboxes: [{ shape: 'line', length: 22, width: 0.9, offset: 1.0, yawFrom: -95, yawTo: 95, tick: 0.45, yMin: -1, yMax: 3.3 }],
      damage: 16, knockback: 4, heavy: false,
    }],
  },

  // ============================================================== desperation
  {
    // Echo Storm: he kneels and channels; three echoes around you strike one after another
    // (each lights up before its turn). Perfect-dodge one → the storm breaks, he is open to the
    // execution. The sequence itself is driven by Warden.ts during the long active window.
    id: 'storm',
    name: 'Echo Storm',
    telegraph: 'magic',
    steps: [{
      windup: 1.3, active: 3.6, recovery: 1.7,
      anim: { clip: 'Spellcast_Raise', startAt: 0.2, hitFrame: 1.0, speed: 0.15 },
      track: { windup: 2, active: 0 },
      hitboxes: [],
      damage: 0,
    }],
  },
  {
    // what each storm echo does: a lunging thrust (gold — parry it, or roll)
    id: 'stormLunge',
    name: 'Storm Lunge',
    telegraph: 'parryable',
    steps: [{
      windup: 0.95, active: 0.26, recovery: 0.6,
      anim: { clip: '2H_Melee_Attack_Stab', startAt: 0.1, hitFrame: 0.72, speed: 1 },
      track: { windup: 4, active: 0 },
      move: [{ kind: 'lunge', during: 'active', distance: 4.5, stopAt: 0.3 }],
      hitboxes: [{ shape: 'line', length: 5.2, width: 1.6, offset: 0.3, decal: true, yMax: MELEE_TOP }],
      damage: 22, knockback: 8,
    }],
  },
];

/** Ids that get an Unbound (`_u`) copy. */
const UNBOUND = ['rend', 'rendQuick', 'rend2', 'cleave', 'slam2', 'thrust', 'grab', 'charge', 'turnSweep', 'heaven', 'pursuit', 'swap', 'reap', 'beamLow', 'beamHigh'];

/** Phase 3+ copy: shorter wind-ups (×0.82), shorter recoveries (×0.8), faster follow-through. */
export function unbound(def: AttackDef): AttackDef {
  return {
    ...def,
    id: `${def.id}_u`,
    name: `${def.name ?? def.id} (unbound)`,
    steps: def.steps.map((s) => ({
      ...s,
      windup: +(s.windup * 0.82).toFixed(3),
      recovery: +(s.recovery * 0.8).toFixed(3),
      anim: s.anim ? { ...s.anim, speed: (s.anim.speed ?? 1) * 1.15 } : undefined,
    })),
  };
}

for (const id of UNBOUND) {
  const d = WardenAttacks.find((a) => a.id === id);
  if (d) WardenAttacks.push(unbound(d));
}

/** strip the `_u` suffix */
export const baseId = (id: string) => id.replace(/_u$/, '');
