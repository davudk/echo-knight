/**
 * Upgrade definitions — the contract between the loadout UI and gameplay code.
 * Gameplay reads values through `loadout` (core/Loadout.ts) using these ids.
 *
 * Kinds:
 *  - toggle: on/off
 *  - tier:   pick one of `levels` (numbers)
 *  - choice: pick exactly one option id (exclusive group)
 *
 * `requires` / `excludes` reference other upgrades as `id` (toggle on / tier > first level)
 * or `id=value` (specific choice/tier value).
 */
export type UpgradeCategory = 'echo' | 'movement' | 'defense' | 'combat';

interface BaseDef {
  id: string;
  name: string;
  description: string;
  category: UpgradeCategory;
  requires?: string[];
  excludes?: string[];
}
export interface ToggleDef extends BaseDef {
  kind: 'toggle';
  default: boolean;
}
export interface TierDef extends BaseDef {
  kind: 'tier';
  levels: number[];
  labels?: string[];
  default: number;
}
export interface ChoiceDef extends BaseDef {
  kind: 'choice';
  options: { id: string; name: string; description: string; excludes?: string[]; requires?: string[] }[];
  default: string;
}
export type UpgradeDef = ToggleDef | TierDef | ChoiceDef;

export const Upgrades: UpgradeDef[] = [
  // ---------------------------------------------------------------- Echo
  {
    id: 'echo.aerial', kind: 'toggle', category: 'echo', default: false,
    name: 'Aerial Echo',
    description: 'Place echoes mid-air. Recall up there, then plunge to smash the ground.',
  },
  {
    id: 'echo.count', kind: 'tier', category: 'echo', levels: [1, 2, 3], default: 1,
    name: 'Echo Stack',
    description: 'Hold several echoes at once. Recall returns to the most recent one (first in, last out).',
  },
  {
    id: 'echo.recall', kind: 'choice', category: 'echo', default: 'teleport',
    name: 'Recall Mode',
    description: 'What happens when you recall.',
    options: [
      { id: 'teleport', name: 'Teleport', description: 'Jump to the echo; it vanishes.' },
      { id: 'swap', name: 'Swap', description: 'Trade places — the echo now stands where you were.' },
      { id: 'rewind', name: 'Rewind', description: 'Retrace your path back to the echo, invulnerable on the way.' },
    ],
  },
  {
    id: 'echo.body', kind: 'choice', category: 'echo', default: 'phantom',
    name: 'Echo Body',
    description: 'What the echo is while it waits.',
    options: [
      { id: 'phantom', name: 'Phantom', description: 'Intangible hologram (classic).' },
      { id: 'platform', name: 'Platform', description: 'Solid — stand or jump on it. It no longer marks a recall point in the air.' , excludes: ['echo.aerial'] },
      { id: 'mimic', name: 'Mimic', description: 'Repeats your attacks from where it stands.' },
    ],
  },
  {
    id: 'echo.refresh', kind: 'toggle', category: 'echo', default: true,
    name: 'Second Wind',
    description: 'Recalling restores your air jumps and air dashes.',
  },
  {
    id: 'echo.shockwave', kind: 'toggle', category: 'echo', default: false,
    name: 'Arrival Shockwave',
    description: 'Recalling releases a damaging shockwave where you arrive.',
  },
  {
    id: 'echo.duration', kind: 'tier', category: 'echo', levels: [6, 9, 12], labels: ['6 s', '9 s', '12 s'], default: 6,
    name: 'Echo Duration',
    description: 'How long an echo lasts.',
  },

  // ---------------------------------------------------------------- Movement
  {
    id: 'move.jumps', kind: 'tier', category: 'movement', levels: [1, 2, 3], labels: ['Single', 'Double', 'Triple'], default: 1,
    name: 'Jumps',
    description: 'Number of jumps before landing.',
  },
  {
    id: 'move.airDashes', kind: 'tier', category: 'movement', levels: [1, 2], default: 1,
    name: 'Air Dashes',
    description: 'Air dash charges per airtime.',
  },
  {
    id: 'move.dashDir', kind: 'choice', category: 'movement', default: 'horizontal',
    name: 'Dash Direction',
    description: 'Which way air dashes can go.',
    options: [
      { id: 'horizontal', name: 'Horizontal', description: 'Flat dash along the ground plane.' },
      { id: 'eight-way', name: 'Eight-way', description: 'Hold jump to dash up-diagonal, sprint to dash down-diagonal.' },
    ],
  },
  {
    id: 'move.slide', kind: 'toggle', category: 'movement', default: false,
    name: 'Slide',
    description: 'Roll while sprinting to slide; jump out of it for a long jump.',
  },
  {
    id: 'move.wallRun', kind: 'toggle', category: 'movement', default: false,
    name: 'Wall Run',
    description: 'Run along walls while airborne; jump off them.',
  },
  {
    id: 'move.ledgeGrab', kind: 'toggle', category: 'movement', default: true,
    name: 'Ledge Grab',
    description: 'Catch ledges you jump at and climb up.',
  },

  // ---------------------------------------------------------------- Defense
  {
    id: 'defense.style', kind: 'choice', category: 'defense', default: 'block-parry',
    name: 'Defense Style',
    description: 'What the block button does.',
    options: [
      { id: 'block-parry', name: 'Block & Parry', description: 'Hold to block. Tap just before a hit to parry and riposte.' },
      { id: 'perfect-dodge', name: 'Perfect Dodge', description: 'Rolling through an attack at the last moment slows time.' },
      { id: 'counter', name: 'Counter', description: 'Press block when an enemy flashes to reverse its attack.' },
    ],
  },
  {
    id: 'defense.stamina', kind: 'toggle', category: 'defense', default: false,
    name: 'Stamina',
    description: 'Rolls, dashes, blocks and heavy attacks cost stamina (Souls rules).',
  },

  // ---------------------------------------------------------------- Combat
  {
    id: 'combat.chargeHeavy', kind: 'toggle', category: 'combat', default: true,
    name: 'Charged Heavy',
    description: 'Hold heavy to charge up to three tiers.',
  },
  {
    id: 'combat.launcher', kind: 'toggle', category: 'combat', default: true,
    name: 'Launcher',
    description: 'Light, light, heavy launches enemies — jump after them for an air combo.',
  },
  {
    id: 'combat.directional', kind: 'toggle', category: 'combat', default: true,
    name: 'Directional Attacks',
    description: 'Forward + heavy lunges; back + light backflip-slashes.',
  },
  {
    id: 'combat.dodgeAttacks', kind: 'toggle', category: 'combat', default: true,
    name: 'Dodge Attacks',
    description: 'Attack out of a roll for a sweep, out of an air dash for a piercing strike.',
  },
  {
    id: 'combat.spin', kind: 'toggle', category: 'combat', default: true,
    name: 'Whirlwind',
    description: 'Light + heavy together: a spinning attack you can move during.',
  },
  {
    id: 'combat.styleMeter', kind: 'toggle', category: 'combat', default: true,
    name: 'Style Meter',
    description: 'Combo counter and D→S style rank.',
  },
];

export type PresetValues = Record<string, boolean | number | string>;

/** Presets apply on top of defaults. */
export const Presets: { id: string; name: string; description: string; values: PresetValues }[] = [
  { id: 'base', name: 'Base', description: 'The starting kit.', values: {} },
  {
    id: 'acrobat', name: 'Acrobat', description: 'Triple jump, wall-runs, slides and echo platforms.',
    values: {
      'move.jumps': 3, 'move.airDashes': 2, 'move.dashDir': 'eight-way', 'move.slide': true, 'move.wallRun': true,
      'move.ledgeGrab': true, 'echo.body': 'platform', 'echo.count': 2, 'echo.duration': 9,
    },
  },
  {
    id: 'assassin', name: 'Assassin', description: 'Shadow clones that fight with you; swap and vanish.',
    values: {
      'echo.aerial': true, 'echo.count': 3, 'echo.recall': 'swap', 'echo.body': 'mimic', 'echo.shockwave': true,
      'move.jumps': 2, 'move.airDashes': 2, 'defense.style': 'perfect-dodge',
    },
  },
  {
    id: 'brawler', name: 'Brawler', description: 'Grounded fighter: counters, launchers and charged heavies.',
    values: { 'defense.style': 'counter', 'move.jumps': 2, 'echo.recall': 'rewind', 'echo.shockwave': true },
  },
  {
    id: 'everything', name: 'Everything', description: 'Every non-exclusive upgrade maxed.',
    values: {
      'echo.aerial': true, 'echo.count': 3, 'echo.shockwave': true, 'echo.duration': 12, 'move.jumps': 3,
      'move.airDashes': 2, 'move.dashDir': 'eight-way', 'move.slide': true, 'move.wallRun': true, 'move.ledgeGrab': true,
    },
  },
];
