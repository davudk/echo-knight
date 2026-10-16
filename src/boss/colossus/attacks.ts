import type { AttackDef, AttackStep } from '../types';
import { HitFrame } from './clips';

/**
 * The Bell Colossus's moveset (Normal timings; windups ×1.3 Story / ×0.85 Souls, final recoveries
 * likewise). Distances are from the giant's feet centre; the hammer head lands ~9 m in front.
 *
 *  red   stomp / stompL / stompChain / slam / sweep / greatToll / shakeoff / debris / march / leap
 *  gold  backhand / swat           (parry → recoil + poise; block → chip)
 *  cyan  toll                      (a spherical bell wave: block it or roll through it)
 *
 * Custom mechanics (toll wave, shake-off throw, debris rocks) are triggered from Colossus.ts
 * (`onAttackStep` / `beginTelegraph`); their steps carry no framework hitboxes.
 */

const stompStep = (clip: 'stompR' | 'stompL', windup: number, recovery: number, extra: Partial<AttackStep> = {}): AttackStep => ({
  windup, active: 0.1, recovery,
  anim: { clip, startAt: 0, hitFrame: HitFrame.stomp, speed: 1 },
  track: { windup: 0.9, active: 0, recovery: 0.3 },
  hitboxes: [
    { shape: 'circle', at: 'self', radius: 3.6 },
    { shape: 'ring', speed: 9, maxRadius: 12, thickness: 0.8, startRadius: 3.2, damage: 16, knockback: 7 },
  ],
  damage: 30, knockback: 10, shake: 0.55,
  ...extra,
});

const marchStep = (clip: 'marchL' | 'marchR', last: boolean): AttackStep => ({
  windup: 0.6, active: 0.1, recovery: last ? 1.6 : 0.05,
  anim: { clip, startAt: 0, hitFrame: HitFrame.march, speed: 1 },
  track: { windup: 1.3, active: 0, recovery: 0.3 },
  // keeps walking: never stops short of you
  move: [{ kind: 'lunge', during: 'windup', from: 0, to: 1, distance: 2.6, stopAt: -6 }],
  hitboxes: [
    { shape: 'circle', at: 'self', radius: 2.9, lockAt: 0.45 },
    { shape: 'ring', speed: 8, maxRadius: 6.5, thickness: 0.7, startRadius: 2.6, damage: 14, knockback: 6 },
  ],
  damage: 24, knockback: 9, shake: 0.4,
});

export const ColossusAttacks: AttackDef[] = [
  // -------------------------------------------------------------- red: feet
  {
    // Lifts a foot high, slams it down: a crushing circle under its body, then a ring — JUMP the ring.
    id: 'stomp', name: 'Stomp', telegraph: 'unblockable',
    steps: [stompStep('stompR', 1.15, 1.4)],
  },
  { id: 'stompL', name: 'Stomp (left)', telegraph: 'unblockable', steps: [stompStep('stompL', 1.15, 1.4)] },
  {
    // Phase 2: three stomps, faster, the third one DELAYED (held foot).
    id: 'stompChain', name: 'Tremor Chain', telegraph: 'unblockable',
    steps: [
      stompStep('stompR', 0.95, 0.2, { hitboxes: [{ shape: 'circle', at: 'self', radius: 3.4 }, { shape: 'ring', speed: 10, maxRadius: 10, thickness: 0.8, startRadius: 3.0, damage: 14, knockback: 6 }] }),
      stompStep('stompL', 0.75, 0.2, { hitboxes: [{ shape: 'circle', at: 'self', radius: 3.4 }, { shape: 'ring', speed: 10, maxRadius: 10, thickness: 0.8, startRadius: 3.0, damage: 14, knockback: 6 }] }),
      stompStep('stompR', 1.3, 1.6, { anim: { clip: 'stompR', startAt: 0, hitFrame: HitFrame.stomp, speed: 1, pacing: 'hold' } }),
    ],
  },
  {
    // Phase 3: walks THROUGH the arena, every footfall a small shockwave.
    id: 'march', name: 'Earthshaker March', telegraph: 'unblockable',
    steps: [marchStep('marchR', false), marchStep('marchL', false), marchStep('marchR', false), marchStep('marchL', false), marchStep('marchR', true)],
  },

  // -------------------------------------------------------------- red: hammer
  {
    // Overhead slam. Committed (no tracking): the decal shows the impact for the whole windup.
    // The hammer then RESTS on the ground for ~2.8 s: a ramp up its handle and forearm (wrist rune).
    id: 'slam', name: 'Bell-Clapper Slam', telegraph: 'unblockable',
    steps: [{
      windup: HitFrame.slam, active: 0.12, recovery: 2.8,
      anim: { clip: 'slam', startAt: 0, hitFrame: HitFrame.slam, speed: 1 },
      track: { windup: 0, active: 0, recovery: 0 },
      hitboxes: [
        { shape: 'circle', at: 'forward', distance: 9.0, radius: 3.0 },
        { shape: 'ring', at: 'forward', distance: 9.0, speed: 8, maxRadius: 7, thickness: 0.8, startRadius: 2.8, damage: 14, knockback: 6 },
      ],
      damage: 38, knockback: 11, shake: 0.9,
    }],
  },
  {
    // Low swing right → left along the ground: JUMP over it (feet above 1 m), SLIDE under the handle
    // or roll through. The blade travels for 0.6 s.
    id: 'sweep', name: 'Ground Reaper', telegraph: 'unblockable',
    steps: [{
      windup: HitFrame.sweep, active: 0.6, recovery: 1.3,
      anim: { clip: 'sweep', startAt: 0, hitFrame: HitFrame.sweep, speed: 1 },
      track: { windup: 1.0, active: 0, recovery: 0.2 },
      hitboxes: [{ shape: 'sweep', range: 8.6, from: -110, to: 100, width: 30, inner: 2.0, yMax: 1.0, decal: true }],
      damage: 26, knockback: 9, shake: 0.3,
    }],
  },
  {
    // Phase 3 desperation: crouches, leaps across the arena and lands hammer-first where you stood
    // (both circles lock when it takes off), then a big ring. It stays stuck for ~2.4 s.
    id: 'leap', name: 'Falling Bell', telegraph: 'unblockable',
    steps: [{
      windup: HitFrame.leap, active: 0.15, recovery: 2.4,
      anim: { clip: 'leap', startAt: 0, hitFrame: HitFrame.leap, speed: 1 },
      track: { windup: 1.5, active: 0, recovery: 0 },
      // lands ~8.5 m short so the hammer head comes down where you stood
      move: [{ kind: 'leap', during: 'windup', from: 0.5, to: 1, height: 9, maxDistance: 24, stopAt: 8.5 }],
      hitboxes: [
        { shape: 'circle', at: 'player', lockAt: 0.5, radius: 3.6 },
        { shape: 'circle', at: 'leap', lockAt: 0.52, radius: 3.4, damage: 30 },
        { shape: 'ring', speed: 10, maxRadius: 16, thickness: 0.9, startRadius: 3.2, damage: 20, knockback: 8 },
      ],
      damage: 44, knockback: 12, shake: 1.1,
    }],
  },

  // -------------------------------------------------------------- red: body
  {
    // Phase 2+: full-body shudder. Anyone STANDING on its body is thrown off. Hanging from a ledge
    // (or being airborne) when it peaks = you hold on.
    id: 'shakeoff', name: 'Shake Off', telegraph: 'unblockable',
    steps: [{
      windup: HitFrame.shakeoff, active: 0.3, recovery: 1.3,
      anim: { clip: 'shakeoff', startAt: 0, hitFrame: HitFrame.shakeoff, speed: 1 },
      track: { windup: 0, active: 0, recovery: 0 },
      hitboxes: [],
      damage: 16, knockback: 13, shake: 0.7,
    }],
  },
  {
    // Phase 2+: pounds its chest, rubble rains around it (red circles fill until each rock lands).
    id: 'debris', name: 'Crumbling Hail', telegraph: 'unblockable',
    steps: [{
      windup: HitFrame.debris, active: 2.0, recovery: 1.0,
      anim: { clip: 'debris', startAt: 0, hitFrame: HitFrame.debris, speed: 1 },
      track: { windup: 0.6, active: 0, recovery: 0 },
      hitboxes: [],
      damage: 20, knockback: 7, shake: 0.3,
    }],
  },
  {
    // Phase 3: the cracked bell's double toll — two ARENA-WIDE rings (the second faster). Jump each,
    // or stand on high ground (ruins, its own body: anything > 1.2 m up is safe).
    id: 'greatToll', name: 'Cracked Toll', telegraph: 'unblockable',
    steps: [{
      windup: HitFrame.greatToll, active: 1.0, recovery: 1.5,
      anim: { clip: 'greatToll', startAt: 0, hitFrame: HitFrame.greatToll, speed: 1 },
      track: { windup: 0, active: 0, recovery: 0 },
      hitboxes: [
        { shape: 'ring', speed: 9, maxRadius: 34, thickness: 1.0, startRadius: 2.5, damage: 24, knockback: 9 },
        { shape: 'ring', delay: 0.8, speed: 13, maxRadius: 34, thickness: 1.0, startRadius: 2.5, damage: 24, knockback: 9 },
      ],
      damage: 24, knockback: 9, shake: 0.8,
    }],
  },

  // -------------------------------------------------------------- gold: parryable
  {
    // Left backhand at chest height, left → right. Parry it (recoil + big poise), block it, or roll.
    id: 'backhand', name: 'Stone Backhand', telegraph: 'parryable',
    steps: [{
      windup: HitFrame.backhand, active: 0.4, recovery: 1.1,
      anim: { clip: 'backhand', startAt: 0, hitFrame: HitFrame.backhand, speed: 1 },
      track: { windup: 1.1, active: 0, recovery: 0.2 },
      hitboxes: [{ shape: 'sweep', range: 7.6, from: 110, to: -40, width: 30, inner: 1.2, yMin: -1, yMax: 3.0, decal: true }],
      damage: 22, knockback: 8, parryPoise: 35,
    }],
  },
  {
    // Phase 2+: swats along its own body (everything 1.6 m+ above its feet, within 5 m).
    // Standing climbers can parry / block it; hanging ones must let go.
    id: 'swat', name: 'Swat', telegraph: 'parryable',
    steps: [{
      windup: HitFrame.swat, active: 0.6, recovery: 1.1,
      anim: { clip: 'swat', startAt: 0, hitFrame: HitFrame.swat, speed: 1 },
      track: { windup: 0.5, active: 0, recovery: 0 },
      hitboxes: [{ shape: 'sweep', range: 5.2, from: 180, to: -180, width: 40, yMin: 1.6, yMax: 14 }],
      damage: 20, knockback: 10, parryPoise: 30,
    }],
  },

  // -------------------------------------------------------------- cyan: magic
  {
    // The bell tolls: a spherical wave from the bell (reaches climbers too). Block it (chip) or roll.
    id: 'toll', name: 'Toll', telegraph: 'magic',
    steps: [{
      windup: HitFrame.toll, active: 0.2, recovery: 1.2,
      anim: { clip: 'toll', startAt: 0, hitFrame: HitFrame.toll, speed: 1 },
      track: { windup: 0.6, active: 0, recovery: 0 },
      hitboxes: [],
      damage: 12, knockback: 13, heavy: true,
    }],
  },
];
