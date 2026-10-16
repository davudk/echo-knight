import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { playSfx } from '../../audio/audioFeature';
import { Tuning } from '../../config/tuning';
import { events } from '../../core/Events';
import type { Game } from '../../core/Game';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitResult } from '../../player/Player';
import type { HitInfo } from '../../world/World';
import { Boss, type BossDef } from '../Boss';
import { TelegraphColors } from '../Decals';
import type { Decision, DirectorContext } from '../Director';
import { Difficulty } from '../difficulty';
import type { BossHitSpec } from '../Hitboxes';
import { loadBossModel } from '../models';
import type { AttackDef } from '../types';
import { HunterAttacks } from './attacks';
import type { HunterHud } from './HunterHud';

/**
 * KAEDE, THE LAST HUNTER — a fast Sekiro-style duelist (south-east shrine).
 *
 * The fight is about POSTURE, not HP:
 *  - Deflects (block-parry) build his posture a lot and do NOT interrupt his strings (onParry 'none');
 *    hits build a little; counters, stomps on his thrust, air strikes after jumping his sweep and the
 *    lightning reversal build a lot. Posture regenerates quickly while he is healthy and unpressured
 *    (rate scales with HP, ×0.35 while you keep up the pressure).
 *  - Full posture → stagger with a DEATHBLOW window: attacking from the front takes a whole LIFE.
 *    HP reaching 0 opens the same window. He has 2 lives; after the first deathblow he falls, rises
 *    and enters phase 2 (lightning blade).
 *  - The PLAYER has posture too: blocking (not deflecting) fills it; full = guard broken.
 *  - While idle he guards your swings (clang, tiny posture); keep swinging and he deflects you and cuts back.
 *    His guard stance ("Still Water") does that to the very first swing — wait it out.
 *  - Perilous (red, 危 kanji): sweep (jump — air attack on his head = posture), thrust (sidestep, dodge
 *    INTO it = stomp, or counter style), grab (dodge).
 *  - Smoke vanish → shimmer + sound behind you → ambush. Phase 2: lightning — be airborne when it strikes,
 *    then attack before landing to hurl it back.
 */
export const HunterDef: BossDef = {
  id: 'hunter',
  name: 'Kaede, the Last Hunter',
  title: 'Shrine of Falling Petals',
  maxHealth: 480,
  radius: 0.6,
  height: Tuning.player.height * 1.3,
  phases: [
    { threshold: 1, name: 'First Life' },
    // never reached by HP: entered by the revival after the first deathblow (see Hunter.loseLife)
    { threshold: -1, name: 'Second Life', transition: { duration: 2.7, clip: 'Lie_StandUp', speed: 1.0, shake: 0.9 } },
  ],
  // regen is driven by the class (HP / pressure dependent) — the base regen is disabled
  poise: { max: 100, regen: 0, regenDelay: 999, damageMul: 0.22, staggerTime: 2.6, vulnerableMul: 1 },
  parryPoise: 9,
  counterPoise: 8,
  onParry: 'none',
  riposte: { damage: 0, range: 2.8, arcDeg: 170, knockdown: 2 },
  speeds: { walk: 2.6, run: 7.0, strafe: 2.8, back: 2.4, turn: 6 },
  trackRate: { windup: 6, active: 0.6, recovery: 2 },
  anims: {
    idle: 'Idle', walk: 'Walking_B', run: 'Running_A', strafeLeft: 'Running_Strafe_Left', strafeRight: 'Running_Strafe_Right',
    back: 'Walking_Backwards', roar: 'Unarmed_Idle', stagger: 'Hit_B', recoil: 'Hit_A', knockdown: 'Lie_StandUp', death: 'Death_A',
  },
  attacks: HunterAttacks,
  director: {
    phases: [
      {
        // FIRST LIFE: fast, varied strings, few perilous attacks; a duel at 2.5–5.5 m.
        aggression: 0.62,
        idleTime: [0.35, 1.35],
        preferredRange: [2.6, 5.5],
        attacks: [
          { attack: 'flurry2', weight: 3, range: [0, 4.4], followUps: [{ attack: 'thrust', chance: 0.18, range: [1.5, 5] }, { attack: 'flurry2', chance: 0.15, range: [0, 4.4] }] },
          { attack: 'flurry3', weight: 2.4, range: [0, 4.2], cooldown: 3 },
          { attack: 'flurry3b', weight: 2, range: [0, 4.4], cooldown: 3, followUps: [{ attack: 'sweep', chance: 0.2, range: [0, 4] }] },
          { attack: 'feint', weight: 1.6, range: [0, 4.2], cooldown: 5 },
          { attack: 'sweep', weight: 1.2, range: [0, 3.9], cooldown: 6 },
          { attack: 'sweep', weight: 3, range: [0, 3.9], angle: 'behind', cooldown: 3 },
          { attack: 'flurry2', weight: 2, range: [0, 4.2], angle: 'side' },
          { attack: 'thrust', weight: 1.2, range: [2.4, 5.8], cooldown: 6 },
          { attack: 'grab', weight: 0.9, range: [0, 3], cooldown: 9, player: 'grounded' },
          { attack: 'dash', weight: 2.2, range: [5, 15], cooldown: 3.5 },
          { attack: 'shuriken', weight: 1.6, range: [5, 16], cooldown: 5, followUps: [{ attack: 'dash', chance: 0.45, range: [5, 15] }] },
          { attack: 'plunge', weight: 1.1, range: [4.5, 12], cooldown: 8 },
          { attack: 'vanish', weight: 0.8, range: [2.5, 12], cooldown: 15 },
          { attack: 'stance', weight: 0.8, range: [0, 4.4], cooldown: 9, followUps: [{ attack: 'flurry2', chance: 0.6, range: [0, 4.4] }] },
          { attack: 'stanceCut', weight: 1, followUpOnly: true },
          { attack: 'ambush', weight: 1, followUpOnly: true },
        ],
        punish: { heal: ['dash', 'shuriken', 'flurry2'], whiff: ['stance'], reaction: 0.25 },
      },
      {
        // SECOND LIFE: lightning blade — faster strings, more feints, lightning strike, double dash.
        aggression: 0.78,
        idleTime: [0.25, 1.0],
        preferredRange: [2.6, 6],
        attacks: [
          { attack: 'flurry4', weight: 2.4, range: [0, 4.4], cooldown: 3 },
          { attack: 'flurry2', weight: 2, range: [0, 4.4], followUps: [{ attack: 'feintThrust', chance: 0.25, range: [0, 5] }] },
          { attack: 'flurry3b', weight: 1.6, range: [0, 4.4], cooldown: 3 },
          { attack: 'feint2', weight: 1.6, range: [0, 4.2], cooldown: 5 },
          { attack: 'feintThrust', weight: 1.4, range: [1.5, 5.5], cooldown: 6 },
          { attack: 'thunderCut', weight: 2, range: [0, 4.4], cooldown: 5 },
          { attack: 'sweep', weight: 1.2, range: [0, 3.9], cooldown: 6 },
          { attack: 'sweep', weight: 3, range: [0, 3.9], angle: 'behind', cooldown: 3 },
          { attack: 'flurry2', weight: 2, range: [0, 4.2], angle: 'side' },
          { attack: 'grab', weight: 0.9, range: [0, 3], cooldown: 9, player: 'grounded' },
          { attack: 'dash2', weight: 2, range: [5, 15], cooldown: 4.5 },
          { attack: 'shuriken', weight: 1, range: [5, 16], cooldown: 6, followUps: [{ attack: 'dash', chance: 0.5, range: [5, 15] }] },
          { attack: 'lightning', weight: 1.6, range: [3, 15], cooldown: 10 },
          { attack: 'plunge', weight: 0.9, range: [4.5, 12], cooldown: 9 },
          { attack: 'vanish', weight: 0.8, range: [2.5, 12], cooldown: 14 },
          { attack: 'stance', weight: 0.8, range: [0, 4.4], cooldown: 9, followUps: [{ attack: 'thunderCut', chance: 0.5, range: [0, 4.4] }] },
          { attack: 'dash', weight: 1, followUpOnly: true },
          { attack: 'stanceCut', weight: 1, followUpOnly: true },
          { attack: 'ambush', weight: 1, followUpOnly: true },
        ],
        punish: { heal: ['dash2', 'lightning', 'flurry2'], whiff: ['stance'], reaction: 0.22 },
      },
    ],
  },
  echoDamageMul: 0.6,
  tint: new Color(0.62, 0.6, 0.72),
  eyeColor: new Color(1.4, 0.25, 0.2),
  weapon: 'Katana',
  introTime: 2.6,
  chainDelay: 0.1,
};

const MAX_LIVES = 2;
const PLAYER_POSTURE_MAX = 100;
/** boss posture regen: seconds without posture damage, then [base, +per HP fraction] per second, ×pressured */
const POSTURE_REGEN_DELAY = 0.9;
const POSTURE_REGEN = [6, 20];
const POSTURE_PRESSURED = 0.42;
const CYAN = new Color(0.6, 1.9, 3.2);
const CYAN2 = new Color(0.3, 0.9, 2.6);
const CLANG = new Color(3, 2.6, 1.6);
const SMOKE = new Color(0.55, 0.55, 0.6);
const BLOOD = new Color(2.6, 0.25, 0.15);

const tmp = new Vector3();
const tmp2 = new Vector3();
const BEND_Q = new Quaternion();
const AXIS_X = new Vector3(1, 0, 0);

/** A jagged lightning bolt (a few stretched boxes between jittered points), flashed for a moment. */
class Bolt {
  readonly group = new Group();
  private readonly segs: Mesh[] = [];
  private readonly mat = new MeshBasicMaterial({ color: new Color(1.2, 2.6, 4), transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
  private life = 0;
  private total = 1;
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  constructor(parent: Object3D, n = 8) {
    const geo = new BoxGeometry(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const m = new Mesh(geo, this.mat);
      m.frustumCulled = false;
      this.segs.push(m);
      this.group.add(m);
    }
    this.group.visible = false;
    parent.add(this.group);
  }

  /** zigzag from → to, `width` m thick, visible for `life` s */
  show(from: Vector3, to: Vector3, width = 0.16, life = 0.22, jitter = 0.6) {
    const n = this.segs.length;
    this.a.copy(from);
    for (let i = 0; i < n; i++) {
      const u = (i + 1) / n;
      this.b.copy(from).lerp(to, u);
      if (i < n - 1) {
        this.b.x += (Math.random() - 0.5) * jitter;
        this.b.y += (Math.random() - 0.5) * jitter * 0.4;
        this.b.z += (Math.random() - 0.5) * jitter;
      }
      const m = this.segs[i];
      const len = this.a.distanceTo(this.b);
      m.position.copy(this.a).lerp(this.b, 0.5);
      m.lookAt(this.b);
      m.scale.set(width, width, len + width);
      this.a.copy(this.b);
    }
    this.life = life;
    this.total = life;
    this.group.visible = true;
  }

  update(dt: number) {
    if (this.life <= 0) return;
    this.life -= dt;
    this.mat.opacity = Math.max(0, this.life / this.total) * (0.75 + Math.random() * 0.25);
    if (this.life <= 0) this.group.visible = false;
  }
}

type CustomMode = 'vanish' | 'guard' | 'revive' | null;

export class Hunter extends Boss {
  /** set by the feature (the duel HUD) */
  hud: HunterHud | null = null;
  lives = MAX_LIVES;
  readonly maxLives = MAX_LIVES;
  /** player posture 0..PLAYER_POSTURE_MAX */
  playerPosture = 0;
  playerBroken = 0;

  private executing = false;
  private refill = false;
  private mode: CustomMode = null;
  private vanishMoved = false;
  private pendingVanish = false;
  private sincePoise = 99;
  private prevPoise = 0;
  private sincePlayerPosture = 99;
  private guardHits = 0;
  private guardTimer = 0;
  private punishBreak = false;
  private sweepAt = -99;
  private perilAt = -99;
  /** lightning */
  private strikeLocked = false;
  private readonly strikePos = new Vector3();
  private charge = 0;
  private chargeAge = 0;
  private sparkAcc = 0;
  private readonly off: (() => void)[] = [];
  private readonly bladeTip: Object3D | null;
  private readonly bones: { spine: Object3D | null; chest: Object3D | null };
  private readonly bolt: Bolt;

  constructor(game: Game, model: CharacterModel) {
    super(game, HunterDef, model);
    this.bladeTip = model.model.getObjectByName('KatanaTip') ?? null;
    this.bolt = new Bolt(game.scene);
    this.bones = { spine: model.model.getObjectByName('spine') ?? null, chest: model.model.getObjectByName('chest') ?? null };
    this.off.push(
      events.on('boss:attack', ({ id, telegraph, attackId }) => {
        if (id !== this.id) return;
        if (attackId === 'lightning') this.strikeLocked = false;
        if (telegraph === 'unblockable' && this.game.time - this.perilAt > 0.8) {
          this.perilAt = this.game.time;
          this.hud?.peril(tmp.copy(this.feet).setY(this.feet.y + this.def.height + 0.35));
          this.game.fx.sparks.emit({
            count: 1, position: this.eyePoint(tmp), speed: 0, life: [0.35, 0.35], size: [2.4, 2.4], color: TelegraphColors.unblockable,
          });
        }
      }),
      events.on('player:attack', () => {
        if (this.charge > 0 && !this.game.player.grounded) this.reverseLightning();
      }),
      events.on('player:perfect-dodge', () => {
        // a perfect dodge (witch time) unbalances him a little, like a deflect
        if (this.engaged && this.alive && this.distanceToPlayer() < 6) this.addPoise(8, 'custom');
      }),
      events.on('player:respawn', () => {
        this.playerPosture = 0;
        this.playerBroken = 0;
        this.charge = 0;
      }),
    );
  }

  override dispose() {
    for (const f of this.off) f();
    this.game.scene.remove(this.bolt.group);
    super.dispose();
  }

  // ================================================================ queries
  /** A thrust (red) step is coming / live. */
  private get thrusting() {
    const r = this.runner;
    if (this.state !== 'attack' || !r.def || !r.step) return false;
    return r.telegraph === 'unblockable' && r.step.hitboxes[0]?.shape === 'line';
  }

  /** Counter style can also reverse the perilous thrust (a Mikiri-like answer). */
  override get attacking() {
    return super.attacking || (this.thrusting && this.runner.phase === 'windup');
  }

  private get inStance() {
    return this.state === 'attack' && this.runner.def?.id === 'stance' && this.runner.phase === 'windup';
  }

  private playerInFront(arcDeg: number) {
    return Math.abs(this.angleTo(this.game.player.position)) <= (arcDeg * Math.PI) / 360;
  }

  // ================================================================ lifecycle hooks
  protected override onEngage() {
    // intro: the bow (spine bend in syncVisual) then he draws into his stance
    this.model.play('Idle', { fade: 0.2 });
  }

  protected override onReset() {
    this.lives = MAX_LIVES;
    this.executing = false;
    this.refill = false;
    this.mode = null;
    this.pendingVanish = false;
    this.vanishMoved = false;
    this.playerPosture = 0;
    this.playerBroken = 0;
    this.charge = 0;
    this.guardHits = 0;
    this.punishBreak = false;
    this.sincePoise = 99;
    this.prevPoise = 0;
    this.model.root.visible = true;
    this.hud?.hide();
  }

  protected override onPhaseEnter(phase: number) {
    if (phase !== 1) return;
    this.refill = true;
    this.game.hud.flash('Kaede rises — the storm answers her blade', 2.4);
    this.lightningBurst(this.feet, 3.5);
    playSfx('thunder', { pos: this.position });
  }

  protected override onAttackStep(attack: AttackDef, step: number, phase: 'active' | 'recovery') {
    if (!attack) return;
    if (phase !== 'active') return;
    if (attack.id === 'vanish') this.pendingVanish = true;
    else if (attack.id === 'sweep') this.sweepAt = this.game.time;
    else if (attack.id === 'lightning') this.strike();
    else if (this.phase === 1 && attack.steps[step].hitboxes.length) {
      // lightning blade: a crackle on every swing
      this.bladeSparks(6);
    }
  }

  /** After a player guard break: punish immediately. */
  override decide(ctx: DirectorContext): Decision {
    if (this.punishBreak) {
      this.punishBreak = false;
      return { attack: ctx.dist < 4.4 ? 'flurry2' : 'dash' };
    }
    return null;
  }

  // ================================================================ damage to the player (player posture)
  override hitPlayer(spec: BossHitSpec): HitResult {
    const res = super.hitPlayer(spec);
    if (res === 'blocked') this.addPlayerPosture(spec.damage * (spec.telegraph === 'magic' ? 1.1 : 1.6), spec.from);
    else if (res === 'parried' && !spec.projectile) this.addPlayerPosture(spec.damage * 0.3, spec.from);
    return res;
  }

  private addPlayerPosture(n: number, from: Vector3) {
    const p = this.game.player;
    if (this.playerBroken > 0 || p.dead) return;
    this.playerPosture += n;
    this.sincePlayerPosture = 0;
    if (this.playerPosture < PLAYER_POSTURE_MAX) return;
    // guard broken: stunned, and he punishes
    this.playerPosture = PLAYER_POSTURE_MAX;
    this.playerBroken = 1.1;
    this.punishBreak = true;
    const dir = tmp.set(p.position.x - from.x, 0, p.position.z - from.z);
    if (dir.lengthSq() < 1e-4) this.forwardVec(dir);
    dir.normalize();
    events.emit('player:guard-break', { position: p.position.clone() });
    if (p.states.has('guardbreak')) p.go('guardbreak', { damage: 0, dir: dir.clone(), knockback: 5, heavy: true });
    this.hud?.callout('Posture broken');
  }

  // ================================================================ damage to the boss
  override onHit(info: HitInfo) {
    const p = this.game.player;
    const live = this.alive && this.state !== 'dead' && this.state !== 'dormant' && !this.invulnerable;
    const fromPlayer = info.source !== 'echo' && info.move !== 'riposte';
    if (live && fromPlayer && !this.riposteOpen) {
      // 1. guard stance: the first swing is deflected and answered
      if (this.inStance && this.playerInFront(150)) {
        this.deflectPlayer();
        return;
      }
      // 2. idle guard: blocks careless swings; keep mashing and he deflects you
      const guarding = (this.state === 'idle' || (this.state === 'custom' && this.mode === 'guard')) && p.grounded &&
        info.move !== 'counter' && this.playerInFront(150);
      if (guarding) {
        this.guardHits++;
        this.guardTimer = 1.6;
        if (this.guardHits >= 3) this.deflectPlayer();
        else this.guardBlock(info);
        return;
      }
    }

    // the counter style's strike: its guard-break bonus would make counters dwarf deflects here
    if (info.move === 'counter' && info.guardBreak) info = { ...info, guardBreak: false };
    const wasOpen = this.riposteOpen;
    const air = !p.grounded || p.state === 'plunge';
    const above = p.position.y - this.feet.y > 1.0;
    super.onHit(info);
    // air strike bonus: jumped his sweep and struck him from above (Sekiro's jump kick)
    if (live && fromPlayer && !wasOpen && air && this.alive && this.state !== 'stagger' && this.state !== 'knockdown') {
      const afterSweep = this.game.time - this.sweepAt < 1.4;
      if (afterSweep || above) {
        this.addPoise(afterSweep ? 24 : 6, 'custom');
        if (afterSweep) {
          this.sweepAt = -99;
          this.hud?.callout('Leaping strike');
          this.game.fx.sparks.emit({
            count: 30, position: tmp.copy(this.feet).setY(this.feet.y + this.def.height), spread: 0.2, speed: 5, upBias: 0.6,
            life: [0.2, 0.5], size: [0.05, 0.12], color: CLANG, gravity: 6, drag: 2,
          });
        }
      }
    }
  }

  /** Idle guard: clang, no HP damage, a little posture. */
  private guardBlock(info: HitInfo) {
    const at = tmp.copy(this.position).addScaledVector(info.dir, -this.radius * 0.8);
    this.clangFx(at, 0.6);
    playSfx('block', { pos: at });
    this.setCustom(0.32);
    this.mode = 'guard';
    this.model.play('Block_Hit', { fade: 0.04, loop: false, speed: 1.6, restart: true });
    this.turnToward(this.game.player.position, 99, 1);
    this.addPoise(3, 'custom');
  }

  /** He deflects the player's swing and answers with a fast cut. */
  private deflectPlayer() {
    const p = this.game.player;
    const at = tmp.copy(this.position).lerp(p.position.clone().setY(p.position.y + 1.2), 0.45);
    this.clangFx(at, 1.2);
    playSfx('deflectClang', { pos: at });
    this.hud?.callout('Deflected');
    this.game.hitstop(0.08);
    this.game.cam.shake(0.3);
    this.guardHits = 0;
    // the player's swing is knocked aside
    const dx = p.position.x - this.feet.x;
    const dz = p.position.z - this.feet.z;
    const d = Math.hypot(dx, dz) || 1;
    if (p.attacking) p.goFree();
    p.velocity.x = (dx / d) * 4;
    p.velocity.z = (dz / d) * 4;
    this.addPlayerPosture(22, this.feet);
    this.facing = Math.atan2(dx, dz);
    this.model.play('Block_Attack', { fade: 0.04, loop: false, speed: 2, restart: true });
    this.startAttack('stanceCut');
  }

  override onParried() {
    super.onParried();
    const p = this.game.player;
    const at = tmp.copy(p.position).addScaledVector(p.forward, 0.6).setY(p.position.y + 1.3);
    this.clangFx(at, 1);
    playSfx('deflectClang', { pos: at });
  }

  override onCountered() {
    const thrust = this.thrusting;
    const r = this.runner;
    if (!thrust && this.alive && this.state === 'attack' && r.def && !r.isLastStep) {
      // like a deflect: a countered swing mid-string does not stop the string (the next cut is coming)
      this.addPoise(this.def.counterPoise ?? 8, 'counter');
      return;
    }
    super.onCountered();
    if (thrust && this.alive) {
      this.hud?.callout('Thrust countered');
      this.addPoise(20, 'counter');
    }
  }

  // ---------------------------------------------------------------- deathblow / lives
  /** The deathblow: takes a whole life. */
  protected override riposte() {
    const g = this.game;
    this.finisherAt = g.time;
    this.riposteOpen = false;
    this.vulnerable = false;
    g.hitstop(0.28);
    g.slowmo(0.2, 1.0);
    g.cam.shake(0.9);
    g.cam.kickFov(-10);
    this.hud?.deathblow('斬');
    playSfx('deathblow', { pos: this.position });
    g.fx.sparks.emit({
      count: 90, position: tmp.copy(this.position), spread: 0.25, speed: 9, upBias: 0.4, life: [0.25, 0.8], size: [0.05, 0.16],
      color: BLOOD, color2: new Color(3, 2.2, 1), gravity: 8, drag: 2,
    });
    events.emit('boss:riposte', { id: this.id, damage: this.health, position: this.position.clone() });
    this.executing = true;
    this.applyDamage(Math.max(1, this.health), true, true, tmp.copy(this.position));
    this.executing = false;
  }

  protected override die() {
    if (!this.executing) {
      // HP ran out: he is open to a deathblow (like a posture break)
      this.health = 1;
      this.stagger(this.def.poise.staggerTime + 0.8, 'custom', true);
      this.hud?.callout('Deathblow!');
      return;
    }
    if (this.lives > 1) {
      this.loseLife();
      return;
    }
    this.lives = 0;
    super.die();
  }

  private loseLife() {
    this.lives--;
    this.runner.cancel();
    this.game.bosses.effects.clear(this);
    this.setCustom(Infinity);
    this.mode = 'revive';
    this.invulnerable = true;
    this.health = 0;
    this.poise = 0;
    this.model.play('Death_B', { fade: 0.1, loop: false, restart: true, speed: 1.2 });
  }

  // ================================================================ custom states
  protected override onCustomState(dt: number) {
    const t = this.stateTime;
    this.friction(10, dt);
    if (this.mode === 'revive') {
      if (t > 0.9) this.model.play('Lie_Idle', { fade: 0.3 });
      if (t > 2.0) {
        this.mode = null;
        this.enterPhase(1);
      }
    } else if (this.mode === 'vanish') {
      this.updateVanish(t);
    }
  }

  private beginVanish() {
    this.pendingVanish = false;
    const at = tmp.copy(this.feet).setY(this.feet.y + 1);
    this.smokeFx(at);
    playSfx('smokeVanish', { pos: at });
    this.setCustom(1.6);
    this.mode = 'vanish';
    this.vanishMoved = false;
    this.invulnerable = true;
    this.model.root.visible = false;
  }

  private updateVanish(t: number) {
    const p = this.game.player;
    if (!this.vanishMoved && t >= 0.55) {
      this.vanishMoved = true;
      // behind the player, ~50° off their back so the camera still sees him arrive
      const back = p.facing + Math.PI + (Math.random() < 0.5 ? -0.85 : 0.85);
      tmp.set(p.position.x + Math.sin(back) * 2.7, 0, p.position.z + Math.cos(back) * 2.7);
      this.clampToArena(tmp);
      this.feet.set(tmp.x, this.game.world.groundAt(tmp.x, tmp.z), tmp.z);
      this.velocity.set(0, 0, 0);
      this.facing = Math.atan2(p.position.x - this.feet.x, p.position.z - this.feet.z);
      this.syncPosition();
      playSfx('shimmer', { pos: this.position });
    }
    if (this.vanishMoved && t < 1.05) {
      // the shimmer: a faint heat-haze of sparks where he will appear
      this.game.fx.sparks.emit({
        count: 2, position: tmp.copy(this.feet).setY(this.feet.y + 0.3 + Math.random() * 1.8), spread: 0.35, speed: 0.4, upBias: 1,
        life: [0.3, 0.6], size: [0.04, 0.09], color: new Color(1.6, 1.7, 2.2), drag: 2, gravity: -1,
      });
    }
    if (t >= 1.05) {
      this.mode = null;
      this.invulnerable = false;
      this.model.root.visible = true;
      this.smokeFx(tmp.copy(this.feet).setY(this.feet.y + 1), 0.5);
      this.facing = Math.atan2(p.position.x - this.feet.x, p.position.z - this.feet.z);
      this.startAttack('ambush');
    }
  }

  // ================================================================ lightning (phase 2)
  private strike() {
    const p = this.game.player;
    if (!this.strikeLocked) this.strikePos.set(p.position.x, this.game.world.groundAt(p.position.x, p.position.z), p.position.z);
    const at = this.strikePos;
    // bolt FX: a column from the sky
    this.bolt.show(tmp2.set(at.x + (Math.random() - 0.5) * 3, at.y + 22, at.z + (Math.random() - 0.5) * 3), at, 0.22, 0.28, 1.4);
    for (let i = 0; i < 26; i++) {
      tmp.set(at.x + (Math.random() - 0.5) * 0.5, at.y + i * 0.7, at.z + (Math.random() - 0.5) * 0.5);
      this.game.fx.sparks.emit({ count: 2, position: tmp, spread: 0.12, speed: 1.2, life: [0.12, 0.3], size: [0.12, 0.3], color: CYAN, color2: CYAN2, drag: 3 });
    }
    this.lightningBurst(at, 2.3);
    playSfx('thunder', { pos: at });
    // airborne inside the strike → caught the lightning (no damage; the circle only hits ≤ 0.5 m)
    const d = Math.hypot(p.position.x - at.x, p.position.z - at.z);
    if (!p.dead && d <= 2.3 + 0.45 && p.position.y - at.y > 0.5) {
      this.charge = 2.4;
      this.chargeAge = 0;
      this.hud?.callout('Lightning caught — strike before you land!');
      this.game.hitstop(0.06);
    }
  }

  private reverseLightning() {
    const p = this.game.player;
    this.charge = 0;
    const from = tmp2.copy(p.position).setY(p.position.y + 1.2);
    const to = this.position;
    this.bolt.show(from, to, 0.18, 0.3, 0.7);
    for (let i = 0; i <= 20; i++) {
      tmp.copy(from).lerp(to, i / 20);
      this.game.fx.sparks.emit({ count: 3, position: tmp, spread: 0.15, speed: 1.5, life: [0.15, 0.4], size: [0.1, 0.24], color: CYAN, color2: CYAN2, drag: 3 });
    }
    this.lightningBurst(this.feet, 2.5);
    playSfx('thunder', { pos: this.position, intensity: 1.3 });
    events.emit('boss:reflect', { id: this.id, position: this.position.clone() });
    this.hud?.callout('Lightning reversal');
    this.game.slowmo(0.35, 0.35);
    this.onReflectHit(60, 60, this.position);
  }

  private updateCharge(dt: number) {
    if (this.charge <= 0) return;
    const p = this.game.player;
    this.charge -= dt;
    this.chargeAge += dt;
    this.game.fx.sparks.emit({
      count: 2, position: tmp.copy(p.position).setY(p.position.y + 0.6 + Math.random() * 1.2), spread: 0.4, speed: 2,
      life: [0.08, 0.2], size: [0.05, 0.12], color: CYAN, color2: CYAN2, drag: 4,
    });
    if (p.dead) {
      this.charge = 0;
    } else if (p.grounded && this.chargeAge > 0.1) {
      // landed with the lightning still in you
      this.charge = 0;
      const dir = this.forwardVec(tmp2).clone();
      p.receiveHit({ damage: Difficulty.scaleDamage(18), dir, knockback: 3, heavy: false, unblockable: true, parryable: false, attacker: this });
      this.lightningBurst(p.position, 1.4);
      playSfx('thunder', { pos: p.position, intensity: 0.6 });
    }
  }

  // ================================================================ frame
  protected override onUpdate(dt: number) {
    const p = this.game.player;
    this.bolt.update(dt);
    if (this.pendingVanish && this.state === 'attack') this.beginVanish();
    this.pendingVanish = false;

    // ---- boss posture regen: fast while healthy and left alone
    if (this.poise > this.prevPoise + 0.01) this.sincePoise = 0;
    else this.sincePoise += dt;
    const regenOk = this.state !== 'stagger' && this.state !== 'knockdown' && this.state !== 'transition' && this.mode !== 'revive';
    if (regenOk && this.sincePoise > POSTURE_REGEN_DELAY && this.poise > 0) {
      const dist = this.distanceToPlayer();
      const pressured = this.game.time - this.lastHitAt < 1.5 || (dist < 4 && (p.attacking || p.state === 'block'));
      let rate = POSTURE_REGEN[0] + POSTURE_REGEN[1] * this.healthFrac;
      if (pressured) rate *= POSTURE_PRESSURED;
      this.poise = Math.max(0, this.poise - rate * dt);
    }
    this.prevPoise = this.poise;

    // ---- player posture regen (faster while guarding, like Sekiro)
    this.sincePlayerPosture += dt;
    if (this.playerBroken > 0) {
      this.playerBroken -= dt;
      if (this.playerBroken <= 0) this.playerPosture = 0;
    } else if (this.sincePlayerPosture > 1.0) {
      this.playerPosture = Math.max(0, this.playerPosture - (p.state === 'block' ? 24 : 12) * dt);
    }

    this.guardTimer -= dt;
    if (this.guardTimer <= 0) this.guardHits = 0;

    // ---- lightning: lock the strike point with the runner's circle (lockAt 0.8)
    const r = this.runner;
    if (this.state === 'attack' && r.def?.id === 'lightning' && r.phase === 'windup' && !this.strikeLocked && r.phaseTime >= r.windup * 0.8) {
      this.strikeLocked = true;
      this.strikePos.set(p.position.x, this.game.world.groundAt(p.position.x, p.position.z), p.position.z);
    }
    if (this.state === 'attack' && r.def?.id === 'lightning' && r.phase === 'windup') this.bladeSparks(2);
    this.updateCharge(dt);

    // ---- stomp: dodge INTO the perilous thrust
    if (this.thrusting && (r.phase === 'active' || (r.phase === 'windup' && r.timeToActive < 0.42)) && p.state === 'dodge' && p.stateTime < 0.3) {
      const dx = this.feet.x - p.position.x;
      const dz = this.feet.z - p.position.z;
      const d = Math.hypot(dx, dz);
      const vs = Math.hypot(p.velocity.x, p.velocity.z);
      if (d < 5.5 && vs > 2 && (p.velocity.x * dx + p.velocity.z * dz) / (d * vs) > 0.55) this.stomp();
    }

    // ---- refill HP while rising for the second life
    if (this.refill) {
      this.health = Math.min(this.maxHealth, this.health + (this.maxHealth * dt) / 2.2);
      if (this.health >= this.maxHealth || this.state !== 'transition') {
        this.health = this.maxHealth;
        this.refill = false;
      }
    }

    // ---- lightning blade ambience
    if (this.phase === 1 && this.alive && this.model.root.visible) {
      this.sparkAcc += dt * 14;
      if (this.sparkAcc >= 1) {
        this.sparkAcc = 0;
        this.bladeSparks(1);
      }
    }
  }

  /** Dodged into the thrust: stomp the blade down (big posture). */
  private stomp() {
    const p = this.game.player;
    this.runner.cancel();
    const at = tmp.copy(this.feet).lerp(p.position, 0.5).setY(this.feet.y + 0.3);
    this.clangFx(at, 1.3);
    playSfx('deflectClang', { pos: at, intensity: 1.2 });
    this.game.hitstop(0.12);
    this.game.slowmo(0.4, 0.3);
    this.game.cam.shake(0.4);
    this.hud?.callout('Stomp!');
    p.velocity.set(0, p.velocity.y, 0);
    if (p.state === 'dodge') p.goFree();
    this.addPoise(30, 'custom');
    if (this.state !== 'stagger') this.stagger(1.0, 'custom', false);
  }

  // ================================================================ visuals
  protected override syncVisual(dt: number) {
    super.syncVisual(dt);
    if (!this.eyesPlaced) this.placeEyes();
    // intro bow: bend the spine after the mixer posed it
    // (the clip may not key these bones every frame, so remove last frame's offset before adding this one)
    let k = 0;
    if (this.state === 'intro') {
      const t = this.stateTime;
      const bow = t < 0.2 ? 0 : t < 0.7 ? (t - 0.2) / 0.5 : t < 1.3 ? 1 : t < 1.7 ? 1 - (t - 1.3) / 0.4 : 0;
      k = bow * bow * (3 - 2 * bow);
      if (t >= 1.6 && this.model.currentName !== 'Block') this.model.play('Block', { fade: 0.15, loop: false, speed: 1.4, restart: true });
    }
    if (k !== 0 || this.bowApplied !== 0) {
      this.bend(0, this.bones.spine, 0.3 * k);
      this.bend(1, this.bones.chest, 0.25 * k);
      this.bowApplied = k;
    }
  }

  private eyesPlaced = false;
  private bowApplied = 0;
  /**
   * The framework puts the glowing eyes from the head mesh's bounds, which the hood inflates on this
   * model: re-seat them on the face once the first pose is evaluated (head-bone local, so they follow).
   */
  private placeEyes() {
    this.eyesPlaced = true;
    const head = this.model.model.getObjectByName('head');
    if (!head) return;
    const eyes = head.children.filter((c) => (c as Mesh).isMesh && (c as Mesh).geometry.type === 'SphereGeometry');
    if (eyes.length !== 2) return;
    this.model.root.updateMatrixWorld(true);
    const f = this.forwardVec(new Vector3());
    const h = this.def.height;
    eyes.forEach((e, i) => {
      const s = i === 0 ? -1 : 1;
      const w = new Vector3(
        this.feet.x + f.x * h * 0.155 + f.z * h * 0.05 * s,
        this.feet.y + h * 0.655,
        this.feet.z + f.z * h * 0.155 - f.x * h * 0.05 * s,
      );
      head.worldToLocal(w);
      e.position.copy(w);
      e.scale.multiplyScalar(0.75);
    });
  }

  private readonly bendBase = [new Quaternion(), new Quaternion()];
  private readonly bendSet = [new Quaternion(), new Quaternion()];
  /** Pitch a bone by `angle` on top of its animated pose (works whether or not the clip keys it). */
  private bend(i: number, bone: Object3D | null, angle: number) {
    if (!bone) return;
    // the mixer rewrote it → that's the new base; otherwise keep the base we bent from last frame
    if (!bone.quaternion.equals(this.bendSet[i])) this.bendBase[i].copy(bone.quaternion);
    bone.quaternion.copy(this.bendBase[i]).multiply(BEND_Q.setFromAxisAngle(AXIS_X, angle));
    this.bendSet[i].copy(bone.quaternion);
  }

  private bladeTipWorld(out: Vector3) {
    if (this.bladeTip) return this.bladeTip.getWorldPosition(out);
    return out.copy(this.position);
  }

  private bladeSparks(n: number) {
    if (!this.model.root.visible) return;
    const at = this.bladeTipWorld(tmp2);
    this.game.fx.sparks.emit({ count: n, position: at, spread: 0.18, speed: 1.6, life: [0.08, 0.22], size: [0.04, 0.1], color: CYAN, color2: CYAN2, drag: 4 });
  }

  private lightningBurst(at: Vector3, radius: number) {
    this.game.fx.waves.spawn(tmp2.copy(at).setY(at.y + 0.08), radius, CYAN2, 0.4, 0.22);
    this.game.fx.sparks.emit({ count: 40, position: tmp2.copy(at).setY(at.y + 0.3), spread: radius * 0.4, speed: 6, upBias: 1, life: [0.15, 0.45], size: [0.05, 0.14], color: CYAN, color2: CYAN2, gravity: 4, drag: 2 });
    this.game.cam.shake(0.35);
  }

  private clangFx(at: Vector3, s: number) {
    const fx = this.game.fx;
    fx.sparks.emit({ count: Math.round(34 * s), position: at, spread: 0.08, speed: 7 * s, life: [0.12, 0.4], size: [0.04, 0.1], color: CLANG, color2: new Color(2.4, 1.4, 0.4), gravity: 9, drag: 3 });
    fx.sparks.emit({ count: 1, position: at, speed: 0, life: [0.12, 0.12], size: [1.3 * s, 1.3 * s], color: CLANG });
  }

  private smokeFx(at: Vector3, s = 1) {
    this.game.fx.dust.emit({
      count: Math.round(36 * s), position: at, spread: 0.7, speed: 2.2, upBias: 0.4, life: [0.6, 1.3], size: [0.5, 1.1],
      color: SMOKE, color2: new Color(0.35, 0.35, 0.4), gravity: -0.6, drag: 2.5,
    });
  }
}

// ==================================================================== model + katana
/** A low-poly katana (blade, guard, wrapped grip) replacing the Rogue's knife in the right hand. */
function attachKatana(model: CharacterModel) {
  const knife = model.model.getObjectByName('Knife');
  if (!knife || !knife.parent) return;
  model.model.updateMatrixWorld(true);
  // knife axis (hilt → tip) in the knife's local space
  const box = new Box3();
  knife.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!.clone();
    if (o !== knife) b.applyMatrix4(o.matrix);
    box.union(b);
  });
  const size = box.getSize(new Vector3());
  const axis = size.x > size.y ? (size.x > size.z ? 'x' : 'z') : size.y > size.z ? 'y' : 'z';
  const tipAtMax = Math.abs(box.max[axis]) > Math.abs(box.min[axis]);
  const dir = new Vector3();
  dir[axis] = tipAtMax ? 1 : -1;
  const hilt = box.getCenter(new Vector3());
  hilt[axis] = tipAtMax ? box.min[axis] : box.max[axis];
  const guardAt = hilt.clone().addScaledVector(dir, size[axis] * 0.3);

  const ws = knife.getWorldScale(new Vector3()).x || 1;
  const steel = new MeshStandardMaterial({ color: new Color(0.82, 0.86, 0.92), metalness: 0.75, roughness: 0.28, flatShading: true });
  const dark = new MeshStandardMaterial({ color: new Color(0.12, 0.1, 0.12), roughness: 0.8, flatShading: true });
  const gold = new MeshStandardMaterial({ color: new Color(0.7, 0.55, 0.25), metalness: 0.6, roughness: 0.4, flatShading: true });
  // built along +Y in metres, guard at 0
  const blade = new Group();
  const L = 0.98;
  const seg = (h: number, y: number, w: number, d: number, mat: MeshStandardMaterial, bend = 0) => {
    const m = new Mesh(new BoxGeometry(w, h, d), mat);
    m.position.set(0, y, bend);
    m.castShadow = true;
    blade.add(m);
    return m;
  };
  // a gently curved blade in 3 segments
  seg(L * 0.4, L * 0.2, 0.034, 0.011, steel, 0);
  seg(L * 0.36, L * 0.58, 0.031, 0.011, steel, 0.012).rotation.x = -0.05;
  seg(L * 0.26, L * 0.89, 0.024, 0.01, steel, 0.034).rotation.x = -0.12;
  seg(0.022, 0, 0.085, 0.085, gold); // tsuba
  seg(0.26, -0.14, 0.036, 0.03, dark); // tsuka
  const tip = new Object3D();
  tip.name = 'KatanaTip';
  tip.position.set(0, L, 0.05);
  blade.add(tip);

  const holder = new Group();
  holder.name = 'Katana';
  holder.position.copy(knife.position);
  holder.quaternion.copy(knife.quaternion);
  holder.scale.copy(knife.scale);
  const inner = new Group();
  inner.position.copy(guardAt);
  inner.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
  inner.scale.setScalar(1 / ws);
  inner.add(blade);
  holder.add(inner);
  knife.parent.add(holder);
}

export async function loadHunterModel() {
  const model = await loadBossModel('Rogue_Hooded', HunterDef.height, ['Knife', 'Rogue_Cape']);
  const knife = model.model.getObjectByName('Knife');
  attachKatana(model);
  if (knife) knife.visible = false;
  return model;
}

export async function spawnHunter(game: Game, x: number, z: number, facing = 0): Promise<Hunter> {
  const boss = new Hunter(game, await loadHunterModel());
  boss.placeAt(x, z, facing);
  game.bosses.add(boss);
  return boss;
}
