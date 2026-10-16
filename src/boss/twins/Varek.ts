import { Color, Vector3 } from 'three';
import type { Game } from '../../core/Game';
import { Tuning } from '../../config/tuning';
import type { CharacterModel } from '../../player/CharacterModel';
import type { BossDef } from '../Boss';
import type { Decision, DirectorConfig, DirectorContext } from '../Director';
import type { AttackDef } from '../types';
import { VarekAttacks } from './attacks';
import type { Selene } from './Selene';
import { TwinBoss } from './TwinBoss';

const tmp = new Vector3();

// ------------------------------------------------------------------ director
const PHASES: DirectorConfig['phases'] = [
  {
    // Phase 1: the aggressor. Steady pressure, parry checks, kicks for turtles, gap closers at range.
    aggression: 0.55,
    idleTime: [0.5, 1.6],
    preferredRange: [2.5, 5.5],
    attacks: [
      { attack: 'v_chop', weight: 3, range: [0, 4], followUps: [{ attack: 'v_sweep', chance: 0.3, range: [0, 4.2] }, { attack: 'v_kick', chance: 0.2, range: [0, 2.8] }] },
      { attack: 'v_sweep', weight: 2.5, range: [0, 4.2], followUps: [{ attack: 'v_chop', chance: 0.25, range: [0, 4] }] },
      { attack: 'v_sweep', weight: 4, range: [0, 4.2], angle: 'behind' },
      { attack: 'v_sweep', weight: 2, range: [0, 4.2], angle: 'side' },
      { attack: 'v_rend', weight: 2, range: [0, 3.8], cooldown: 5 },
      { attack: 'v_kick', weight: 1, range: [0, 2.8], followUpOnly: true },
      { attack: 'v_leap', weight: 1.6, range: [5, 13], cooldown: 7, player: 'grounded' },
      { attack: 'v_charge', weight: 1.5, range: [6, 17], cooldown: 8 },
    ],
    punish: { heal: ['v_charge', 'v_leap', 'v_chop'], reaction: 0.3 },
  },
  {
    // Phase 2 (≤ 50 %): relentless — the four-hit Breaker Storm, double leaps, more chains.
    aggression: 0.75,
    idleTime: [0.35, 1.2],
    preferredRange: [2.5, 5.5],
    attacks: [
      { attack: 'v_chop', weight: 2.5, range: [0, 4], followUps: [{ attack: 'v_rend', chance: 0.3, range: [0, 3.8] }, { attack: 'v_kick', chance: 0.25, range: [0, 2.8] }] },
      { attack: 'v_sweep', weight: 2, range: [0, 4.2], followUps: [{ attack: 'v_charge', chance: 0.25, range: [5, 12] }, { attack: 'v_chop', chance: 0.25, range: [0, 4] }] },
      { attack: 'v_sweep', weight: 4, range: [0, 4.2], angle: 'behind' },
      { attack: 'v_sweep', weight: 2, range: [0, 4.2], angle: 'side' },
      { attack: 'v_rend', weight: 1.4, range: [0, 3.8], cooldown: 5 },
      { attack: 'v_rend4', weight: 2, range: [0, 3.8], cooldown: 6 },
      { attack: 'v_kick', weight: 1, range: [0, 2.8], followUpOnly: true },
      { attack: 'v_leap', weight: 1, range: [5, 13], cooldown: 7, player: 'grounded' },
      { attack: 'v_leap2', weight: 1.4, range: [5, 14], cooldown: 9, player: 'grounded' },
      { attack: 'v_charge', weight: 1.5, range: [6, 17], cooldown: 7 },
    ],
    punish: { heal: ['v_charge', 'v_leap2', 'v_chop'], reaction: 0.25 },
  },
];

/** Selene fell: faster variants, five-hit string, her blink (decide) and her knives. */
const ENRAGED: DirectorConfig['phases'] = [
  {
    aggression: 0.8,
    idleTime: [0.3, 1.1],
    preferredRange: [2.5, 5.5],
    attacks: [
      { attack: 'e_chop', weight: 2.5, range: [0, 4], followUps: [{ attack: 'e_sweep', chance: 0.35, range: [0, 4.2] }, { attack: 'e_kick', chance: 0.25, range: [0, 2.8] }] },
      { attack: 'e_sweep', weight: 2, range: [0, 4.2], followUps: [{ attack: 'e_chop', chance: 0.3, range: [0, 4] }] },
      { attack: 'e_sweep', weight: 4, range: [0, 4.2], angle: 'behind' },
      { attack: 'e_sweep', weight: 2, range: [0, 4.2], angle: 'side' },
      { attack: 'e_rend5', weight: 1.3, range: [0, 3.8], cooldown: 8 },
      { attack: 'e_kick', weight: 1, range: [0, 2.8], followUpOnly: true },
      { attack: 'e_leap', weight: 1.3, range: [5, 13], cooldown: 7, player: 'grounded' },
      { attack: 'e_charge', weight: 1.2, range: [6, 17], cooldown: 8 },
      { attack: 'e_knives', weight: 1.6, range: [5.5, 20], cooldown: 4, followUps: [{ attack: 'e_charge', chance: 0.35, range: [6, 17] }] },
    ],
    punish: { heal: ['e_knives', 'e_leap', 'e_chop'], reaction: 0.2 },
  },
  {
    aggression: 0.88,
    idleTime: [0.25, 0.9],
    preferredRange: [2.5, 5.5],
    attacks: [
      { attack: 'e_chop', weight: 2.2, range: [0, 4], followUps: [{ attack: 'e_rend4', chance: 0.3, range: [0, 3.8] }, { attack: 'e_kick', chance: 0.25, range: [0, 2.8] }] },
      { attack: 'e_sweep', weight: 2, range: [0, 4.2], followUps: [{ attack: 'e_knives', chance: 0.3, range: [5, 14] }, { attack: 'e_chop', chance: 0.25, range: [0, 4] }] },
      { attack: 'e_sweep', weight: 4, range: [0, 4.2], angle: 'behind' },
      { attack: 'e_sweep', weight: 2, range: [0, 4.2], angle: 'side' },
      { attack: 'e_rend5', weight: 1.4, range: [0, 3.8], cooldown: 7 },
      { attack: 'e_rend4', weight: 1.5, range: [0, 3.8], cooldown: 5 },
      { attack: 'e_kick', weight: 1, range: [0, 2.8], followUpOnly: true },
      { attack: 'v_leap2', weight: 1.4, range: [5, 14], cooldown: 8, player: 'grounded' },
      { attack: 'e_charge', weight: 1.2, range: [6, 17], cooldown: 7 },
      { attack: 'e_knives', weight: 1.8, range: [5.5, 20], cooldown: 3.5 },
    ],
    punish: { heal: ['e_knives', 'v_leap2', 'e_chop'], reaction: 0.2 },
  },
];

const VAREK_HEIGHT = Tuning.player.height * 1.4;

function makeDef(): BossDef {
  return {
    id: 'varek',
    name: 'Varek the Breaker',
    title: 'Twin Warden',
    maxHealth: 620,
    radius: 0.75,
    height: VAREK_HEIGHT,
    phases: [
      { threshold: 1, name: 'Breaker' },
      { threshold: 0.5, name: 'Unbroken', transition: { duration: 2.2, clip: 'Cheer', speed: 0.85, shake: 0.6 } },
    ],
    poise: { max: 110, regen: 12, regenDelay: 3, damageMul: 0.9, staggerTime: 2.2, vulnerableMul: 1.4 },
    parryPoise: 32,
    counterPoise: 45,
    onParry: 'recoil',
    riposte: { damage: 95, range: 2.4, arcDeg: 150, knockdown: 1.9 },
    speeds: { walk: 2.2, run: 5.4, strafe: 2.0, back: 1.7, turn: 3.4 },
    trackRate: { windup: 3.5, active: 0, recovery: 0.8 },
    anims: {
      idle: '2H_Melee_Idle', walk: 'Walking_A', run: 'Running_A', strafeLeft: 'Running_Strafe_Left', strafeRight: 'Running_Strafe_Right',
      back: 'Walking_Backwards', roar: 'Cheer', stagger: 'Hit_B', recoil: 'Hit_A', knockdown: 'Lie_StandUp', death: 'Death_A',
    },
    attacks: VarekAttacks,
    director: { phases: PHASES },
    echoDamageMul: 0.6,
    tint: new Color(0.95, 0.85, 0.8),
    eyeColor: new Color(1.8, 0.45, 0.1),
    weapon: '2H_Axe',
    introTime: 3.2,
    chainDelay: 0.12,
  };
}

/**
 * VAREK THE BREAKER — the aggressor of the Twin Wardens (Barbarian, 1.4×, two-handed axe).
 * Relentless strings with delayed hits, a red guard-breaking kick for players who turtle,
 * leap slams with jumpable shockwaves, a red charge down a previewed lane.
 * Enraged (Selene fell first): faster variants, a five-hit string, her blink and knives.
 */
export class Varek extends TwinBoss {
  static readonly height = VAREK_HEIGHT;
  selene!: Selene;
  protected readonly introClip = 'Cheer';
  protected readonly enragedPhases = ENRAGED;
  private blockTime = 0;
  private kickCd = 0;
  private blinkCd = 0;

  constructor(game: Game, model: CharacterModel) {
    super(game, makeDef(), model);
  }

  protected get partner() {
    return this.selene;
  }

  protected override onPhaseEnter(phase: number) {
    if (phase === 1) this.game.hud.flash(this.enraged ? 'Varek’s grief knows no end' : 'Varek will not break', 2);
  }

  protected onEnrage() {
    this.scaleSpeeds(1.18);
    this.blinkCd = 3;
  }

  protected override onReset() {
    super.onReset();
    this.blockTime = 0;
    this.kickCd = 0;
    this.blinkCd = 0;
  }

  protected override twinUpdate(dt: number) {
    const p = this.game.player;
    this.blockTime = p.state === 'block' ? this.blockTime + dt : 0;
    this.kickCd -= dt;
    this.blinkCd -= dt;
  }

  protected override onTwinStep(attack: AttackDef, _step: number, phase: 'active' | 'recovery') {
    if (phase === 'active' && (attack.id === 'v_kick' || attack.id === 'e_kick')) this.kickCd = 4;
  }

  protected override pickBlinkSpot() {
    return this.flankSpot(2.8, Math.random() < 0.5 ? 1 : -1, tmp);
  }

  /** Kick a turtling player; enraged: blink in when you keep your distance. */
  override decide(ctx: DirectorContext): Decision {
    if (this.blockTime > 0.4 && ctx.dist < 2.8 && this.kickCd <= 0 && ctx.side === 'front') {
      this.kickCd = 4;
      return { attack: this.enraged ? 'e_kick' : 'v_kick' };
    }
    if (this.enraged && this.blinkCd <= 0 && (ctx.dist > 7 || (ctx.dist < 2.2 && Math.random() < 0.01))) {
      if (this.pair.mayStart(this, this.attacks.get('e_blinkChop')!)) {
        this.blinkCd = 7;
        this.blinkNext = 'e_blinkChop';
        return { attack: 'blink' };
      }
    }
    return null;
  }
}
