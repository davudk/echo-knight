/**
 * Human-readable move list, shown by the training overlay. Each attack module appends its
 * moves here (keep `id` equal to the `move` string used in 'player:attack' / HitInfo.move).
 *
 * Notation: L = light, H = heavy, [H] = hold heavy, J = jump, D = dodge, B = block,
 * → / ← = stick toward / away from facing, (air) = while airborne.
 */
export interface MoveEntry {
  id: string;
  name: string;
  input: string;
  description: string;
  /** loadout token required to perform it (e.g. 'combat.launcher') */
  requires?: string;
}

export const MoveList: MoveEntry[] = [
  { id: 'light1', name: 'Rising Slash', input: 'L', description: 'Right-to-left slash with a forward lunge.' },
  { id: 'light2', name: 'Return Slash', input: 'L L', description: 'Left-to-right slash.' },
  { id: 'slam', name: 'Broken Wings', input: 'L L L', description: 'Leap and smash the ground (AoE).' },
  { id: 'plunge', name: 'Plunge', input: '(air) L', description: 'Dive and slam from the air (when no target is close).' },
  // ---- offense stream: strings
  { id: 'spinSlash', name: 'Cyclone Cut', input: 'L H', description: 'Full-turn spinning slash that hits all around.' },
  { id: 'launcher', name: 'Skybreaker', input: 'L L H', description: 'Rising uppercut that launches the target. Jump right after to chase it.', requires: 'combat.launcher' },
  { id: 'heavy1', name: 'Cleaver', input: 'H', description: 'Slow overhead chop. Heavy hitstop.' },
  { id: 'heavy2', name: 'Breaker Kick', input: 'H H', description: 'Shoving kick that breaks guards.' },
  { id: 'heavy3', name: 'Earthsplitter', input: 'H H H', description: 'Wide two-handed sweep with a small shockwave.' },
  // ---- charged heavy
  { id: 'charged1', name: 'Charged Cleave I', input: '[H]', description: 'Hold heavy to charge, release to strike.', requires: 'combat.chargeHeavy' },
  { id: 'charged2', name: 'Charged Cleave II', input: '[H] (tier 2)', description: 'Longer charge: more damage and reach.', requires: 'combat.chargeHeavy' },
  { id: 'charged3', name: 'Charged Cleave III', input: '[H] (tier 3)', description: 'Full charge: guard break and a big shockwave.', requires: 'combat.chargeHeavy' },
  // ---- directional
  { id: 'lungeStab', name: 'Piercing Lunge', input: '→ H', description: 'Long-reach lunging stab (gap closer). Unlocked: while running.', requires: 'combat.directional' },
  { id: 'backflip', name: 'Backflip Slash', input: '← L', description: 'Hop back with a slash. Unlocked: from standstill.', requires: 'combat.directional' },
  // ---- dodge attacks
  { id: 'sweep', name: 'Low Sweep', input: 'D, L', description: 'Attack out of a roll: low sweep that pops the target up.', requires: 'combat.dodgeAttacks' },
  { id: 'dashStrike', name: 'Piercing Dash', input: '(air) D, L', description: 'Attack during an air dash: keeps dashing and hits everything on the path.', requires: 'combat.dodgeAttacks' },
  // ---- whirlwind
  { id: 'whirlwind', name: 'Whirlwind', input: 'L + H', description: 'Steerable spinning attack, hits every 0.2 s.', requires: 'combat.spin' },
  // ---- air
  { id: 'air1', name: 'Air Slash', input: '(air, near target) L', description: 'Air slash with a short hang.' },
  { id: 'air2', name: 'Air Return', input: '(air) L L', description: 'Second air slash.' },
  { id: 'airSpike', name: 'Meteor Spike', input: '(air) L L L', description: 'Chop that spikes the target into the ground.' },
];
