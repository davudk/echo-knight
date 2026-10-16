import { Color, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import type { Game } from '../../core/Game';
import { Tuning } from '../../config/tuning';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitInfo } from '../../world/World';
import type { BossDef } from '../Boss';
import { TelegraphColors } from '../Decals';
import type { Decision, DirectorConfig, DirectorContext } from '../Director';
import type { AttackDef } from '../types';
import { TwinPillars } from './arena';
import { SeleneAttacks } from './attacks';
import { playTwinSound } from './sounds';
import { TwinBoss } from './TwinBoss';
import type { Varek } from './Varek';

const tmp = new Vector3();
const tmpC = new Color();

const PHASES: DirectorConfig['phases'] = [
  {
    // Phase 1: support. Keeps her distance, knives when Varek gives her room, quick daggers if cornered.
    aggression: 0.35,
    idleTime: [0.8, 2.0],
    preferredRange: [6, 10],
    attacks: [
      { attack: 's_knife', weight: 3, range: [4, 22], cooldown: 2.5 },
      { attack: 's_slash2', weight: 3, range: [0, 2.8] },
      { attack: 's_lunge', weight: 2, range: [2.5, 5], cooldown: 3 },
    ],
    punish: { heal: ['s_knife'], reaction: 0.35 },
  },
  {
    // Phase 2 (≤ 50 %): knife fans, the delayed flurry, more blinks and smoke.
    aggression: 0.5,
    idleTime: [0.6, 1.6],
    preferredRange: [6, 10],
    attacks: [
      { attack: 's_knife', weight: 2, range: [4, 22], cooldown: 2.5 },
      { attack: 's_fan', weight: 2, range: [4, 22], cooldown: 4 },
      { attack: 's_slash2', weight: 2, range: [0, 2.8], followUps: [{ attack: 's_lunge', chance: 0.3, range: [2, 5] }] },
      { attack: 's_flurry', weight: 2, range: [0, 3], cooldown: 4 },
      { attack: 's_lunge', weight: 2, range: [2.5, 5], cooldown: 3 },
    ],
    punish: { heal: ['s_fan', 's_knife'], reaction: 0.3 },
  },
];

/** Varek fell: his axe (slow, huge reach) mixed with her speed, knives and smoke clones. */
const ENRAGED: DirectorConfig['phases'] = [
  {
    aggression: 0.6,
    idleTime: [0.5, 1.4],
    preferredRange: [3.5, 6],
    attacks: [
      { attack: 'a_cleave', weight: 3, range: [0, 5.2], followUps: [{ attack: 's_slash2', chance: 0.3, range: [0, 2.8] }] },
      { attack: 'a_sweep', weight: 2.5, range: [0, 5.4], followUps: [{ attack: 's_knife', chance: 0.3, range: [5, 20] }] },
      { attack: 'a_sweep', weight: 4, range: [0, 5.4], angle: 'behind' },
      { attack: 'a_spin', weight: 1.6, range: [0, 4.4], cooldown: 6 },
      { attack: 's_slash2', weight: 1.5, range: [0, 2.8] },
      { attack: 'a_leap', weight: 1.2, range: [5.5, 13], cooldown: 8, player: 'grounded' },
      { attack: 's_knife', weight: 1.6, range: [6, 22], cooldown: 3 },
    ],
    punish: { heal: ['s_knife', 'a_leap', 'a_cleave'], reaction: 0.25 },
  },
  {
    aggression: 0.75,
    idleTime: [0.35, 1.1],
    preferredRange: [3.5, 6],
    attacks: [
      { attack: 'a_cleave', weight: 2.5, range: [0, 5.2], followUps: [{ attack: 'a_spin', chance: 0.3, range: [0, 4.4] }, { attack: 's_flurry', chance: 0.25, range: [0, 3] }] },
      { attack: 'a_sweep', weight: 2.5, range: [0, 5.4], followUps: [{ attack: 's_fan', chance: 0.3, range: [5, 20] }] },
      { attack: 'a_sweep', weight: 4, range: [0, 5.4], angle: 'behind' },
      { attack: 'a_spin', weight: 1.8, range: [0, 4.4], cooldown: 5 },
      { attack: 's_flurry', weight: 1.5, range: [0, 3], cooldown: 4 },
      { attack: 'a_leap', weight: 1.3, range: [5.5, 13], cooldown: 7, player: 'grounded' },
      { attack: 's_fan', weight: 1.6, range: [6, 22], cooldown: 3.5 },
    ],
    punish: { heal: ['s_fan', 'a_leap', 'a_cleave'], reaction: 0.2 },
  },
];

const SELENE_HEIGHT = Tuning.player.height * 1.36;

function makeDef(): BossDef {
  return {
    id: 'selene',
    name: 'Selene the Veil',
    title: 'Twin Warden',
    maxHealth: 430,
    radius: 0.6,
    height: SELENE_HEIGHT,
    phases: [
      { threshold: 1, name: 'Veil' },
      { threshold: 0.5, name: 'Shroud', transition: { duration: 1.8, clip: 'Spellcast_Raise', speed: 1, startAt: 0.2, shake: 0.4 } },
    ],
    poise: { max: 75, regen: 10, regenDelay: 2.5, damageMul: 1, staggerTime: 2.0, vulnerableMul: 1.4 },
    parryPoise: 30,
    counterPoise: 40,
    onParry: 'recoil',
    riposte: { damage: 75, range: 2.4, arcDeg: 160, knockdown: 1.8 },
    speeds: { walk: 2.6, run: 6.0, strafe: 2.6, back: 2.4, turn: 4.2 },
    trackRate: { windup: 4, active: 0, recovery: 1 },
    anims: {
      idle: 'Idle', walk: 'Walking_B', run: 'Running_B', strafeLeft: 'Running_Strafe_Left', strafeRight: 'Running_Strafe_Right',
      back: 'Walking_Backwards', roar: 'Cheer', stagger: 'Hit_B', recoil: 'Hit_A', knockdown: 'Lie_StandUp', death: 'Death_B',
    },
    attacks: SeleneAttacks,
    director: { phases: PHASES },
    echoDamageMul: 0.6,
    tint: new Color(0.85, 0.88, 1.0),
    eyeColor: new Color(0.5, 1.4, 1.8),
    weapon: 'Knife',
    introTime: 3.2,
    chainDelay: 0.12,
  };
}

const CASTS = new Set(['s_ward', 's_heal', 's_clones']);

/**
 * SELENE THE VEIL — the support of the Twin Wardens (Rogue_Hooded, 1.36×, twin daggers).
 * Keeps her distance, throws reflectable knives when Varek gives her room, wards Varek
 * (invulnerable, cyan bubble — hit her to break it), heals him with an interruptible channel
 * (cyan tether), blinks behind pillars, vanishes in smoke and ambushes from behind.
 * Enraged (Varek fell first): takes up his axe — slow, huge reach — keeps her knives and blink,
 * and summons smoke clones that throw knives.
 */
export class Selene extends TwinBoss {
  static readonly height = SELENE_HEIGHT;
  varek!: Varek;
  protected readonly introClip = 'Block';
  protected readonly enragedPhases = ENRAGED;
  /** set by the pair while she blinks into a pincer */
  pendingPincer = false;
  private wardCd = 12;
  private healCd = 8;
  private heals = 0;
  private smokeCd = 6;
  private blinkCd = 3;
  private clonesCd = 4;
  private closeTime = 0;
  private pendingHide = false;
  private axe: Object3D | null = null;
  private axeMats: MeshStandardMaterial[] = [];
  private readonly knives: Object3D[] = [];

  constructor(game: Game, model: CharacterModel) {
    super(game, makeDef(), model);
    this.introBreather = 1.2;
    for (const n of ['Knife', 'Knife_Offhand']) {
      const o = model.model.getObjectByName(n);
      if (o) this.knives.push(o);
    }
  }

  protected get partner() {
    return this.varek;
  }

  get channelingHeal() {
    return this.state === 'attack' && this.runner.def?.id === 's_heal' && this.runner.phase === 'active';
  }

  private get casting() {
    return this.state === 'attack' && !!this.runner.def && CASTS.has(this.runner.def.id) && this.runner.phase !== 'recovery';
  }

  // ---------------------------------------------------------------- hooks
  protected override onPhaseEnter(phase: number) {
    if (phase === 1) this.game.hud.flash(this.enraged ? 'Selene’s veil turns to ash' : 'Selene draws the shroud', 2);
    this.blinkCd = 0.5;
  }

  protected onEnrage() {
    this.scaleSpeeds(1.1);
    this.equipAxe();
    this.clonesCd = 5;
    this.blinkCd = 3;
  }

  protected override onReset() {
    super.onReset();
    this.pendingPincer = false;
    this.wardCd = 12;
    this.healCd = 8;
    this.heals = 0;
    this.smokeCd = 6;
    this.blinkCd = 3;
    this.clonesCd = 4;
    this.closeTime = 0;
    this.pendingHide = false;
    this.unequipAxe();
  }

  protected override onTwinStep(attack: AttackDef, _step: number, phase: 'active' | 'recovery') {
    if (phase !== 'active') return;
    switch (attack.id) {
      case 's_ward':
        this.pair.applyWard(this.phase > 0 ? 6 : 5);
        break;
      case 's_heal':
        playTwinSound('twinHeal', this.position);
        this.heals++;
        break;
      case 's_smoke':
        this.pendingHide = true;
        break;
      case 's_clones':
        this.pair.spawnClones();
        break;
      default:
        break;
    }
  }

  override startAttack(id: string) {
    if (id === 's_pincer') this.pendingPincer = false;
    super.startAttack(id);
  }

  // ---------------------------------------------------------------- damage
  override onHit(info: HitInfo) {
    if (this.hidden || !this.alive) return;
    const wasCasting = this.casting;
    const castId = this.runner.def?.id;
    super.onHit(info);
    if (this.pair.wardTimer > 0) this.pair.breakWard('The ward shatters');
    // interrupt casts / the heal channel
    if (wasCasting && this.alive && this.state === 'attack' && !this.invulnerable) {
      this.runner.cancel();
      this.go('recoil', 1.1);
      this.game.fx.sparks.emit({
        count: 30, position: this.position, spread: 0.4, speed: 5, upBias: 0.4, life: [0.2, 0.5], size: [0.05, 0.12],
        color: TelegraphColors.magic, drag: 2,
      });
      if (castId === 's_heal') this.game.hud.flash('Mending interrupted', 1.2);
      else if (castId === 's_ward') this.game.hud.flash('Ward interrupted', 1.2);
    }
  }

  override onReflectHit(damage: number, poise: number, at: Vector3) {
    if (this.hidden) return;
    super.onReflectHit(damage, poise, at);
    if (this.pair.wardTimer > 0) this.pair.breakWard('The ward shatters');
  }

  // ---------------------------------------------------------------- blink / hide
  /** Behind a pillar, away from the player (or wide to the side). */
  protected override pickBlinkSpot(): Vector3 {
    if (this.enraged) return this.flankSpot(3, Math.random() < 0.5 ? 1 : -1, tmp);
    const p = this.game.player.position;
    const opts: Vector3[] = [];
    for (const c of TwinPillars) {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < 5 || d > 14) continue;
      const k = 1 / d;
      opts.push(new Vector3(c.x + (c.x - p.x) * k * (c.r + 1.0), 0, c.z + (c.z - p.z) * k * (c.r + 1.0)));
    }
    if (opts.length) return tmp.copy(opts[Math.floor(Math.random() * opts.length)]);
    return this.flankSpot(7, Math.random() < 0.5 ? 1 : -1, tmp);
  }

  protected override updateHide(dt: number) {
    const t = this.modeT;
    if (t >= 0.12 && t < 1.9 && !this.hidden) {
      this.setHidden(true);
    }
    if (this.hidden && t >= 1.6 && t - dt < 1.6) {
      // pick the ambush spot behind the player now (not at the throw)
      const pl = this.game.player;
      tmp.set(pl.position.x - Math.sin(pl.facing) * 3, 0, pl.position.z - Math.cos(pl.facing) * 3);
      this.clampToArena(tmp);
      this.feet.set(tmp.x, this.game.world.groundAt(tmp.x, tmp.z, this.feet.y + 2), tmp.z);
      this.velocity.set(0, 0, 0);
      this.syncPosition();
    }
    if (t >= 1.9) {
      this.setHidden(false);
      this.mode = null;
      this.facing = Math.atan2(this.game.player.position.x - this.feet.x, this.game.player.position.z - this.feet.z);
      this.vanishFx();
      playTwinSound('twinBlink', this.position);
      this.toIdle(0);
      this.startAttack('s_ambush');
      if (this.state !== 'attack') this.toIdle(0.5);
    }
  }

  // ---------------------------------------------------------------- frame
  protected override twinUpdate(dt: number) {
    const v = this.varek;
    this.wardCd -= dt;
    this.healCd -= dt;
    this.smokeCd -= dt;
    this.blinkCd -= dt;
    this.clonesCd -= dt;
    this.closeTime = this.distanceToPlayer() < 3 ? this.closeTime + dt : 0;
    if (this.state === 'attack' && this.runner.def?.id === 's_pincer') this.pendingPincer = false;

    if (this.pendingHide) {
      this.pendingHide = false;
      if (this.state === 'attack' || this.state === 'idle') {
        this.pair.spawnSmoke(this.feet, 3.2);
        this.mode = 'hide';
        this.modeT = 0;
        this.setCustom(2.4);
      }
    }

    // heal channel: Varek regains 12 % over the channel
    if (this.channelingHeal && v.alive) {
      const rate = (v.maxHealth * 0.12) / (this.runner.step?.active ?? 2.6);
      v.health = Math.min(v.maxHealth, v.health + rate * dt);
    }

    // inherited axe glows with the telegraph like a boss weapon
    if (this.axe) {
      const k = TelegraphColors[this.glowKind];
      for (const m of this.axeMats) m.emissive.copy(tmpC.copy(k).multiplyScalar(this.glow * 1.3));
    }
  }

  override decide(ctx: DirectorContext): Decision {
    const v = this.varek;
    if (this.enraged) {
      if (this.clonesCd <= 0 && ctx.dist > 3.5) {
        this.clonesCd = this.phase > 0 ? 13 : 16;
        return { attack: 's_clones' };
      }
      if (this.blinkCd <= 0 && ctx.dist > 7.5 && this.pair.mayStart(this, this.attacks.get('a_blinkCleave')!)) {
        this.blinkCd = 6;
        this.blinkNext = 'a_blinkCleave';
        return { attack: 'blink' };
      }
      return null;
    }
    if (!v.alive) return null;
    const vDist = v.distanceToPlayer();
    // mend Varek from a safe distance
    if (v.healthFrac < 0.6 && this.healCd <= 0 && this.heals < 3 && ctx.dist > 5.5 && v.state !== 'dead') {
      this.healCd = 24;
      return { attack: 's_heal' };
    }
    // ward Varek while he presses
    if (this.wardCd <= 0 && this.pair.wardTimer <= 0 && vDist < 5 && ctx.dist > 4 && (v.state === 'attack' || v.state === 'idle')) {
      this.wardCd = this.phase > 0 ? 15 : 19;
      return { attack: 's_ward' };
    }
    // cornered: vanish in smoke, or blink behind a pillar
    if (this.closeTime > 0.6 && this.smokeCd <= 0 && Math.random() < (this.phase > 0 ? 0.6 : 0.4)) {
      this.smokeCd = this.phase > 0 ? 10 : 14;
      this.closeTime = 0;
      return { attack: 's_smoke' };
    }
    if (this.closeTime > 0.35 && this.blinkCd <= 0) {
      this.blinkCd = this.phase > 0 ? 4 : 6;
      this.closeTime = 0;
      return { attack: 'blink' };
    }
    return null;
  }

  // ---------------------------------------------------------------- axe
  private equipAxe() {
    if (this.axe) return;
    const src = this.varek.weaponNode;
    const hand = this.model.model.getObjectByName('handslotr');
    if (!src || !hand) return;
    const axe = src.clone(true);
    axe.visible = true;
    this.axeMats = [];
    axe.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const mat = (m.material as MeshStandardMaterial).clone();
      mat.emissive = new Color(0, 0, 0);
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      m.material = mat;
      this.axeMats.push(mat);
    });
    hand.add(axe);
    this.axe = axe;
    for (const k of this.knives) k.visible = false;
  }

  private unequipAxe() {
    if (this.axe) {
      this.axe.removeFromParent();
      this.axe = null;
      this.axeMats = [];
    }
    for (const k of this.knives) k.visible = true;
  }
}
