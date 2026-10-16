import { Color } from 'three';
import { events } from '../../core/Events';
import type { Game } from '../../core/Game';
import { Tuning } from '../../config/tuning';
import { Boss, type BossDef } from '../Boss';
import type { Decision, DirectorContext } from '../Director';
import { loadBossModel } from '../models';
import { SentinelAttacks } from './attacks';

/**
 * THE GATE SENTINEL — the framework's example boss (copy this folder to start a new boss).
 *
 *  - Knight model at 1.6× with the two-handed sword.
 *  - Phase 1 (100–50%): cleave, sweep, delayed three-hit string, leap slam + shockwave ring,
 *    grab, homing bolt, Judgement circle.
 *  - Phase 2 (≤ 50%): kneels and roars (invulnerable beat), more aggressive; adds bolt volley,
 *    triple Judgement, the rotating Radiant Lance and new combo follow-ups.
 *  - Poise: three parries (or a reflected bolt + parries, a counter, heavy hits) break it → 2.2 s
 *    stagger, attack from the front for the riposte finisher.
 *
 * Spawn for testing: `game.bosses.spawnTest()` (dev), or Shift+B.
 */
export const SentinelDef: BossDef = {
  id: 'sentinel',
  name: 'The Gate Sentinel',
  title: 'Warden of the Threshold',
  maxHealth: 650,
  radius: 0.85,
  height: Tuning.player.height * 1.6,
  phases: [
    { threshold: 1, name: 'Vigil' },
    { threshold: 0.5, name: 'Wrath', transition: { duration: 2.4, clip: 'Cheer', speed: 0.8, shake: 0.7 } },
  ],
  poise: { max: 100, regen: 12, regenDelay: 3, damageMul: 0.9, staggerTime: 2.2, vulnerableMul: 1.4 },
  parryPoise: 34,
  counterPoise: 45,
  onParry: 'recoil',
  riposte: { damage: 110, range: 2.6, arcDeg: 150, knockdown: 1.9 },
  speeds: { walk: 2.0, run: 5.2, strafe: 1.8, back: 1.6, turn: 3.2 },
  trackRate: { windup: 3.5, active: 0, recovery: 0.8 },
  anims: {
    idle: '2H_Melee_Idle', walk: 'Walking_A', run: 'Running_A', strafeLeft: 'Running_Strafe_Left', strafeRight: 'Running_Strafe_Right',
    back: 'Walking_Backwards', roar: 'Cheer', stagger: 'Hit_B', recoil: 'Hit_A', knockdown: 'Lie_StandUp', death: 'Death_A',
  },
  attacks: SentinelAttacks,
  director: {
    phases: [
      {
        // Phase 1: deliberate. Gaps of ~0.6–1.8 s, close-range melee, ranged tools to stop turtling at range.
        aggression: 0.45,
        idleTime: [0.5, 1.8],
        preferredRange: [2.8, 6],
        attacks: [
          { attack: 'cleave', weight: 3, range: [0, 4.2], followUps: [{ attack: 'sweep', chance: 0.3, range: [0, 4.5] }] },
          { attack: 'sweep', weight: 2.5, range: [0, 4.4], followUps: [{ attack: 'cleave', chance: 0.25, range: [0, 4.2] }] },
          // anti-flank: sweeps when you sit behind or beside it
          { attack: 'sweep', weight: 4, range: [0, 4.4], angle: 'behind' },
          { attack: 'sweep', weight: 2, range: [0, 4.4], angle: 'side' },
          { attack: 'triple', weight: 2, range: [0, 4.0], cooldown: 4 },
          { attack: 'grab', weight: 1.2, range: [0, 3.2], cooldown: 7, player: 'grounded' },
          { attack: 'quake', weight: 1.6, range: [4.5, 11], cooldown: 7 },
          { attack: 'bolt', weight: 1.6, range: [6, 22], cooldown: 3.5 },
          { attack: 'judgement', weight: 1, range: [3.5, 22], cooldown: 8 },
        ],
        punish: { heal: ['bolt', 'quake', 'cleave'], reaction: 0.3 },
      },
      {
        // Phase 2: relentless. Shorter gaps, longer chains, magic mixups.
        aggression: 0.75,
        idleTime: [0.35, 1.3],
        preferredRange: [3, 7],
        attacks: [
          { attack: 'cleave', weight: 2.5, range: [0, 4.2], followUps: [{ attack: 'triple', chance: 0.35, range: [0, 4.2] }, { attack: 'sweep', chance: 0.3 }] },
          { attack: 'sweep', weight: 2, range: [0, 4.4], followUps: [{ attack: 'grab', chance: 0.25, range: [0, 3] }] },
          { attack: 'sweep', weight: 4, range: [0, 4.4], angle: 'behind' },
          { attack: 'sweep', weight: 2, range: [0, 4.4], angle: 'side' },
          { attack: 'triple', weight: 2.2, range: [0, 4.0], cooldown: 3.5, followUpOnly: false },
          { attack: 'grab', weight: 1.3, range: [0, 3.2], cooldown: 6, player: 'grounded' },
          { attack: 'quake', weight: 1.8, range: [4, 12], cooldown: 6, followUps: [{ attack: 'volley', chance: 0.4, range: [5, 20] }] },
          { attack: 'volley', weight: 1.5, range: [6, 22], cooldown: 4 },
          { attack: 'bolt', weight: 1, range: [5, 22], cooldown: 3 },
          { attack: 'judgement3', weight: 1.2, range: [3, 22], cooldown: 9 },
          { attack: 'lance', weight: 1.2, range: [4, 12], cooldown: 10 },
        ],
        punish: { heal: ['volley', 'quake', 'cleave'], reaction: 0.25 },
      },
    ],
  },
  echoDamageMul: 0.6,
  tint: new Color(0.58, 0.54, 0.66),
  eyeColor: new Color(1.8, 0.5, 0.1),
  weapon: '2H_Sword',
  introTime: 1.7,
  chainDelay: 0.12,
};

export class Sentinel extends Boss {
  /** Example of a custom mechanic hook: after a stagger in phase 2 it answers with a quake. */
  private answerQuake = false;
  private readonly off: () => void;

  constructor(game: Game, model: Awaited<ReturnType<typeof loadBossModel>>) {
    super(game, SentinelDef, model);
    this.off = events.on('boss:stagger', ({ id, riposte }) => {
      if (id === this.id && riposte && this.phase >= 1) this.answerQuake = true;
    });
  }

  override dispose() {
    this.off();
    super.dispose();
  }

  protected override onPhaseEnter(phase: number) {
    if (phase === 1) this.game.hud.flash('The Sentinel’s wrath awakens', 2);
  }

  protected override onReset() {
    this.answerQuake = false;
  }

  /** Director override: forced follow-up after recovering from a stagger in phase 2. */
  override decide(ctx: DirectorContext): Decision {
    if (this.answerQuake && ctx.dist > 3 && ctx.dist < 11) {
      this.answerQuake = false;
      return { attack: 'quake' };
    }
    return null;
  }
}

/** Load the model and create the Sentinel at (x, z) facing `facing`. */
export async function spawnSentinel(game: Game, x: number, z: number, facing = 0): Promise<Sentinel> {
  const model = await loadBossModel('Knight', SentinelDef.height, ['2H_Sword', 'Knight_Helmet', 'Knight_Cape']);
  const boss = new Sentinel(game, model);
  boss.placeAt(x, z, facing);
  game.bosses.add(boss);
  return boss;
}
