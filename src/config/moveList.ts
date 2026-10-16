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
  { id: 'plunge', name: 'Plunge', input: '(air) L', description: 'Dive and slam from the air.' },
];
