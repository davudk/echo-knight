import { loadout } from '../core/Loadout';

/**
 * Difficulty (loadout `challenge.difficulty`). Read live every time, so switching in the
 * loadout panel applies immediately (boss HP is rescaled on the next reset / engage).
 *
 *            damage  telegraph  recovery  flasks  boss HP
 *   story     ×0.5     ×1.3       ×1.3      5      ×0.7
 *   normal    ×1       ×1         ×1        3      ×1
 *   souls     ×1.35    ×0.85      ×0.85     2      ×1.15
 */
export type DifficultyId = 'story' | 'normal' | 'souls';

export const DifficultyTable: Record<DifficultyId, {
  /** damage dealt TO the player by bosses and grunts */
  damage: number;
  /** boss wind-up (telegraph) durations */
  telegraph: number;
  /** boss recovery (punish window) durations */
  recovery: number;
  flasks: number;
  bossHealth: number;
}> = {
  story: { damage: 0.5, telegraph: 1.3, recovery: 1.3, flasks: 5, bossHealth: 0.7 },
  normal: { damage: 1, telegraph: 1, recovery: 1, flasks: 3, bossHealth: 1 },
  souls: { damage: 1.35, telegraph: 0.85, recovery: 0.85, flasks: 2, bossHealth: 1.15 },
};

export function difficultyId(): DifficultyId {
  const v = loadout.str('challenge.difficulty') as DifficultyId;
  return v in DifficultyTable ? v : 'normal';
}

/** Current multipliers. `Difficulty.damage()` etc. — cheap, call freely. */
export const Difficulty = {
  id: difficultyId,
  damage: () => DifficultyTable[difficultyId()].damage,
  telegraph: () => DifficultyTable[difficultyId()].telegraph,
  recovery: () => DifficultyTable[difficultyId()].recovery,
  flasks: () => DifficultyTable[difficultyId()].flasks,
  bossHealth: () => DifficultyTable[difficultyId()].bossHealth,
  /** scale an incoming damage number (rounded, never below 1 for a non-zero hit) */
  scaleDamage(d: number) {
    return d > 0 ? Math.max(1, Math.round(d * DifficultyTable[difficultyId()].damage)) : 0;
  },
};
