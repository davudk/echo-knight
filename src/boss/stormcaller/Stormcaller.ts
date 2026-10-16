import { Color, Vector3 } from 'three';
import { playSfx } from '../../audio/audioFeature';
import { Tuning } from '../../config/tuning';
import { events } from '../../core/Events';
import type { Game } from '../../core/Game';
import { clamp } from '../../core/math';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitInfo } from '../../world/World';
import type { BossArena } from '../Arena';
import { Boss, type BossDef } from '../Boss';
import type { Decal } from '../Decals';
import { Difficulty } from '../difficulty';
import type { Decision, DirectorContext, IdleMode } from '../Director';
import type { EffectOwner } from '../Hitboxes';
import type { AttackDef, ProjectileBox, TelegraphKind } from '../types';
import type { Perch, StormArena } from './arena';
import { StormAttacks } from './attacks';
import { Mirrors } from './Decoys';
import { BoltMarkers, BoltRenderer, LIGHTNING, Orbs, ScreenFlash, StrikeField, SweepLines, ThunderfallDecal, type SweepKind } from './storm';

/**
 * YSOLDE, THE STORMCALLER — a teleporting storm mage on the north-east plateau.
 *
 *  Phase 1 "Gale" (100–60 %): blinks between 9 perches (5 pylon tops + 4 floor points; a shimmer
 *    marks the destination), reflectable bolts (single / 3-fan), rune fields (checker / radiating
 *    lines), chain lightning sweeping the plateau (low: jump, high: slide / roll), and a static nova
 *    + blink when you get close.
 *  Storm event at 60 % and 30 %: she rises above the arena and the storm attacks — strikes at your
 *    feet, floor tiles crack and fall (pits), gusts push you to the electrified edge. Reflect three
 *    bolts to bring her down (long stagger + riposte), or survive ~17 s (shorter stagger).
 *  Phase 2 "Tempest" (60–30 %): adds homing orbs (pop them), stormwalls (walk the gap), mirror images
 *    (find the real one — she has glowing eyes, they glitch), a five-bolt volley, smite; faster blinks.
 *  Phase 3 "Thunderhead" (≤ 30 %): everything combines, a storm aura strikes you if you stand still,
 *    and Thunderfall: the whole plateau is struck except two green pockets around pylons.
 *
 * Poise breaks (reflected bolts deal big poise) knock her off her perch → riposte from the front.
 */
export const StormDef: BossDef = {
  id: 'stormcaller',
  name: 'Ysolde, the Stormcaller',
  title: 'Voice of the Tempest',
  maxHealth: 1050,
  radius: 0.6,
  height: Tuning.player.height * 1.5,
  phases: [
    { threshold: 1, name: 'Gale' },
    { threshold: 0.6, name: 'Tempest' },
    { threshold: 0.3, name: 'Thunderhead' },
  ],
  poise: { max: 100, regen: 6, regenDelay: 6, damageMul: 0.55, staggerTime: 3.0, vulnerableMul: 1.35 },
  parryPoise: 30,
  counterPoise: 40,
  onParry: 'recoil',
  riposte: { damage: 120, range: 2.8, arcDeg: 180, knockdown: 2.0 },
  speeds: { walk: 1.5, run: 3, strafe: 1.2, back: 1.2, turn: 4 },
  trackRate: { windup: 4, active: 2, recovery: 1 },
  anims: {
    idle: 'Idle', walk: 'Walking_A', run: 'Running_A', strafeLeft: 'Running_Strafe_Left', strafeRight: 'Running_Strafe_Right',
    back: 'Walking_Backwards', roar: 'Spellcast_Raise', stagger: 'Hit_B', recoil: 'Hit_A', knockdown: 'Lie_StandUp', death: 'Death_B',
  },
  attacks: StormAttacks,
  director: {
    phases: [
      {
        aggression: 0.4,
        idleTime: [0.9, 2.0],
        attacks: [
          { attack: 'bolt', weight: 3, angle: 'any', cooldown: 1.5, followUps: [{ attack: 'fan', chance: 0.25 }] },
          { attack: 'fan', weight: 2.2, angle: 'any', cooldown: 4, range: [4, 60] },
          { attack: 'runes', weight: 1.8, angle: 'any', cooldown: 6, followUps: [{ attack: 'bolt', chance: 0.4 }] },
          { attack: 'chain', weight: 1.2, angle: 'any', cooldown: 10 },
        ],
        punish: { heal: ['bolt', 'fan'], reaction: 0.3 },
      },
      {
        aggression: 0.6,
        idleTime: [0.6, 1.5],
        attacks: [
          { attack: 'bolt', weight: 2, angle: 'any', cooldown: 1.5 },
          { attack: 'fan', weight: 1.5, angle: 'any', cooldown: 4, range: [4, 60] },
          { attack: 'volley', weight: 2, angle: 'any', cooldown: 6, range: [5, 60], followUps: [{ attack: 'wall', chance: 0.3 }] },
          { attack: 'runes', weight: 1.4, angle: 'any', cooldown: 7 },
          { attack: 'chain', weight: 1, angle: 'any', cooldown: 10, followUps: [{ attack: 'orbs', chance: 0.3 }] },
          { attack: 'wall', weight: 1.3, angle: 'any', cooldown: 10, followUps: [{ attack: 'smite', chance: 0.35 }] },
          { attack: 'orbs', weight: 1.3, angle: 'any', cooldown: 12, followUps: [{ attack: 'bolt', chance: 0.4 }], when: (c) => (c.boss as Stormcaller).orbs.count === 0 },
          { attack: 'mirrors', weight: 1.1, angle: 'any', cooldown: 22, when: (c) => !(c.boss as Stormcaller).mirrors.active },
          { attack: 'smite', weight: 1.4, angle: 'any', cooldown: 5 },
        ],
        punish: { heal: ['smite', 'bolt'], reaction: 0.25 },
      },
      {
        aggression: 0.75,
        idleTime: [0.45, 1.1],
        attacks: [
          { attack: 'bolt', weight: 1.6, angle: 'any', cooldown: 1.5, followUps: [{ attack: 'smite', chance: 0.25 }] },
          { attack: 'fan', weight: 1.4, angle: 'any', cooldown: 3.5, range: [4, 60] },
          { attack: 'volley', weight: 1.8, angle: 'any', cooldown: 5, range: [5, 60], followUps: [{ attack: 'runes', chance: 0.3 }] },
          { attack: 'runes', weight: 1.4, angle: 'any', cooldown: 6, followUps: [{ attack: 'volley', chance: 0.4 }] },
          { attack: 'chain', weight: 1.2, angle: 'any', cooldown: 8, followUps: [{ attack: 'wall', chance: 0.45 }] },
          { attack: 'wall', weight: 1.2, angle: 'any', cooldown: 9, followUps: [{ attack: 'runes', chance: 0.35 }] },
          { attack: 'orbs', weight: 1.2, angle: 'any', cooldown: 11, when: (c) => (c.boss as Stormcaller).orbs.count === 0 },
          { attack: 'mirrors', weight: 1, angle: 'any', cooldown: 20, when: (c) => !(c.boss as Stormcaller).mirrors.active },
          { attack: 'smite', weight: 1.4, angle: 'any', cooldown: 4, followUps: [{ attack: 'chain', chance: 0.25 }] },
        ],
        punish: { heal: ['smite', 'volley'], reaction: 0.2 },
      },
    ],
  },
  echoDamageMul: 0.6,
  tint: new Color(0.78, 0.74, 0.98),
  eyeColor: new Color(0.9, 0.7, 2.6),
  weapon: '2H_Staff',
  introTime: 2.2,
  chainDelay: 0.15,
};

/** Bolts she throws from the sky during the storm event (reflect three to bring her down). */
const SKY_BOLT: ProjectileBox = { shape: 'projectile', speed: 13, homing: 0.6, lifetime: 4, radius: 0.36, reflectable: true, reflectDamage: 40, reflectPoise: 0 };
const SKY_BOLT_DEF: AttackDef = { id: 'skybolt', name: 'Sky Bolt', telegraph: 'magic', steps: [] };
const STORM_REFLECTS = 3;
const ALTITUDE = 9;

type StormStage = 'rise' | 'storm' | 'fall' | 'descend';

interface StormEvent {
  t: number;
  stage: StormStage;
  stageT: number;
  dur: number;
  reflects: number;
  nextStrike: number;
  collapses: number[];
  nextGust: number;
  gustWarn: number;
  gustT: number;
  gustX: number;
  gustZ: number;
  nextBolt: number;
  boltWind: number;
  from: Vector3;
}

const tmp = new Vector3();
const tmp2 = new Vector3();

export class Stormcaller extends Boss {
  readonly bolts: BoltRenderer;
  readonly strikes: StrikeField;
  readonly lines: SweepLines;
  readonly orbs: Orbs;
  readonly markers: BoltMarkers;
  readonly tf: ThunderfallDecal;
  readonly screen: ScreenFlash;
  readonly mirrors: Mirrors;
  private readonly owners: EffectOwner[];
  /** current perch (where she stands) */
  perch: Perch;
  private readonly homePerch: Perch;
  private blinkDest: Perch | null = null;
  private blinkDecal: Decal | null = null;
  private forcedDest: Perch | null = null;
  private wantBlink = false;
  private sinceBlink = 0;
  private closeTime = 0;
  private novaCd = 0;
  private lastDecide = 0;
  private revealed = false;
  private hover = 0.35;
  private vanish = 0;
  private appear = 1;
  private runePattern = 0;
  private chainLow = true;
  storm: StormEvent | null = null;
  private pendingStorm = false;
  private tfTimer = 0;
  private tfFade = 0;
  private readonly tfPockets: { x: number; z: number; r: number; pylon: number }[] = [];
  private auraX = 0;
  private auraZ = 0;
  private auraT = 0;
  private deathT = -1;
  private time = 0;
  private readonly later: { t: number; fn: () => void }[] = [];

  constructor(game: Game, model: CharacterModel, decoyModels: CharacterModel[], readonly sa: StormArena, readonly bossArena: BossArena) {
    super(game, StormDef, model);
    this.bolts = new BoltRenderer(game.scene);
    this.strikes = new StrikeField(game, this, this.bolts, (x, z) => sa.surface(x, z));
    this.strikes.onImpact = (_x, _y, _z, big) => {
      if (big) {
        this.screen.pulse(0.35);
        sa.sky.pulse(0.35);
        sa.flashClouds(0.6);
      }
    };
    this.lines = new SweepLines(game, this, this.bolts, sa.cx, sa.cz, bossArena.region.radius - 0.4, sa.floor);
    this.orbs = new Orbs(game, this, sa.floor, () => this.screen.pulse(0.2));
    this.markers = new BoltMarkers(game.scene);
    this.tf = new ThunderfallDecal(game.scene, sa.cx, sa.cz, sa.floor, bossArena.region.radius - 0.4);
    this.screen = new ScreenFlash(game);
    this.mirrors = new Mirrors(this, decoyModels, this.markers);
    for (const d of this.mirrors.decoys) game.world.targets.push(d);
    this.owners = [this, ...this.mirrors.decoys];
    this.homePerch = sa.perches.find((p) => p.pylon === 2) ?? sa.perches[0];
    this.perch = this.homePerch;
  }

  get centrePerch() {
    return this.sa.perches[5];
  }

  // ==================================================================== lifecycle hooks
  protected override onEngage() {
    this.revealed = true;
    this.appear = 0;
    this.sa.sky.target = 0.5;
    this.sa.energy = 0.6;
    for (const h of this.bossArena.hazards) h.setActive(true);
    // intro: a lightning strike reveals her
    this.strikes.flashBolt(this.feet.x, this.feet.y, this.feet.z, 'magic', 22);
    this.screen.pulse(0.9);
    this.sa.sky.pulse(1);
    this.sa.flashClouds(1);
    this.game.fx.sparks.emit({ count: 60, position: tmp.copy(this.feet).setY(this.feet.y + 0.3), spread: 0.4, speed: 7, upBias: 0.8, life: [0.2, 0.7], size: [0.05, 0.15], color: LIGHTNING.cyan, color2: LIGHTNING.violet, gravity: 4, drag: 2 });
    playSfx('stormThunder', { pos: this.position, intensity: 1.2 });
    this.sinceBlink = 0;
  }

  protected override onReset() {
    this.clearSpells();
    this.storm = null;
    this.pendingStorm = false;
    this.sa.reset();
    this.sa.sky.target = 0;
    this.sa.sky.restore();
    this.sa.energy = 0.25;
    this.revealed = false;
    this.perch = this.homePerch;
    this.wantBlink = false;
    this.forcedDest = null;
    this.sinceBlink = 0;
    this.closeTime = 0;
    this.novaCd = 0;
    this.tfTimer = 0;
    this.auraT = 0;
    this.deathT = -1;
    this.vanish = 0;
    this.appear = 1;
    this.later.length = 0;
    this.screen.clear();
  }

  protected override onPhaseEnter(phase: number) {
    this.clearSpells();
    this.endStorm(false);
    this.pendingStorm = true;
    this.sa.sky.target = 0.5 + phase * 0.15;
    this.game.hud.flash(phase === 1 ? 'Ysolde calls down the storm' : 'The storm rages — Thunderhead', 2.2);
    this.startStorm();
  }

  protected override onDefeated() {
    this.clearSpells();
    this.endStorm(false);
    this.deathT = 0;
    this.sa.sky.target = 0;
    this.sa.energy = 0;
    this.game.hud.flash('The storm breaks', 2.5);
  }

  /** Remove every spell in flight (phase change, reset, death). */
  private clearSpells() {
    this.strikes.clear();
    this.lines.clear();
    this.orbs.clear();
    this.mirrors.dismiss(false);
    this.markers.clear();
    this.tf.hide();
    this.tfFade = 0;
    for (const p of this.tfPockets) this.sa.highlight(p.pylon, 0);
    this.tfPockets.length = 0;
    this.releaseBlinkDecal();
    this.blinkDest = null;
    this.later.length = 0;
  }

  override dispose() {
    this.clearSpells();
    this.orbs.dispose();
    this.mirrors.dispose();
    for (const d of this.mirrors.decoys) {
      const i = this.game.world.targets.indexOf(d);
      if (i >= 0) this.game.world.targets.splice(i, 1);
    }
    this.bolts.dispose(this.game.scene);
    super.dispose();
  }

  // ==================================================================== AI
  override decide(ctx: DirectorContext): Decision {
    const now = this.game.time;
    const dt = clamp(now - this.lastDecide, 0, 0.1);
    this.lastDecide = now;
    if (this.pendingStorm || this.storm) return { idle: 'wait', duration: 0.2 };
    const blinkId = this.phase >= 1 ? 'blinkFast' : 'blink';
    if (this.forcedDest || this.wantBlink) {
      this.wantBlink = false;
      return { attack: blinkId };
    }
    // the player is in her face: nova (if ready) or blink away, after a short reaction time
    const dy = ctx.player.position.y - this.feet.y;
    if (ctx.dist < 4 && Math.abs(dy) < 1.8 && !ctx.player.dead) {
      this.closeTime += dt;
      const reaction = [0.45, 0.35, 0.28][this.phase] ?? 0.3;
      if (this.closeTime > reaction) {
        this.closeTime = 0;
        if (this.novaCd <= 0) {
          this.novaCd = [5.5, 4.5, 3.8][this.phase] ?? 4;
          return { attack: 'nova' };
        }
        return { attack: blinkId };
      }
    } else {
      this.closeTime = Math.max(0, this.closeTime - dt);
    }
    // desperation: Thunderfall from the centre
    if (this.phase >= 2 && this.tfTimer <= 0) {
      if (this.perch === this.centrePerch) return { attack: 'thunderfall' };
      this.forcedDest = this.centrePerch;
      return { attack: blinkId };
    }
    const every = [8, 6.5, 5.5][this.phase] ?? 6;
    if (this.sinceBlink > every) return { attack: blinkId };
    return null;
  }

  /** She doesn't walk: she hovers, turns to face you and teleports. */
  override idleMove(_mode: IdleMode, _dir: 1 | -1, _ctx: DirectorContext, dt: number) {
    this.friction(8, dt);
    this.turnToward(this.game.player.position, this.def.speeds.turn, dt);
    this.model.play(this.def.anims.idle, { fade: 0.3 });
  }

  /** Pick a perch: not too close to the player, not where she is; phase 1 favours pylon tops. */
  private pickPerch(exclude: (Perch | null)[] = []): Perch {
    const p = this.game.player.position;
    let best: Perch = this.sa.perches[0];
    let bestScore = -Infinity;
    for (const pe of this.sa.perches) {
      if (pe === this.perch || exclude.includes(pe)) continue;
      const d = Math.hypot(pe.x - p.x, pe.z - p.z);
      let s = Math.random() * 3;
      if (d < 5) s -= 10;
      else if (d < 8) s -= 2;
      else if (d > 17) s -= 1.5;
      if (pe.pylon >= 0) s += this.phase === 0 ? 1.2 : 0.4;
      if (s > bestScore) {
        bestScore = s;
        best = pe;
      }
    }
    return best;
  }

  // ==================================================================== attacks
  override beginTelegraph(def: AttackDef, step: number, kind: TelegraphKind, windup: number, flash: boolean) {
    super.beginTelegraph(def, step, kind, windup, flash);
    switch (def.id) {
      case 'blink':
      case 'blinkFast': {
        this.blinkDest = this.forcedDest ?? this.pickPerch();
        this.forcedDest = null;
        this.releaseBlinkDecal();
        const d = this.blinkDest;
        this.blinkDecal = this.game.bosses.decals.acquire().tint('magic').ring(d.x, d.y, d.z, 1.3, 0.35);
        playSfx('stormBlink', { pos: tmp.set(d.x, d.y + 1, d.z), variant: 'charge' });
        break;
      }
      case 'runes':
        this.spawnRunes(windup);
        break;
      case 'chain':
        this.spawnChain(windup);
        break;
      case 'wall':
        this.spawnWall(windup);
        break;
      case 'smite':
        for (let k = 0; k < 3; k++) {
          this.after(Math.max(0, windup - 0.55) + k * 0.42, () => {
            const pp = this.game.player.position;
            this.strikes.spawn(pp.x, pp.z, 1.8, 0.6 * Difficulty.telegraph(), 18, 'magic', 'bolt');
          });
        }
        break;
      case 'thunderfall':
        this.beginThunderfall(windup);
        break;
      case 'bolt':
      case 'fan':
      case 'volley':
        if (this.mirrors.active) this.mirrors.cast('Spellcast_Shoot');
        break;
      default:
        break;
    }
  }

  protected override onAttackStep(attack: AttackDef, _step: number, phase: 'active' | 'recovery') {
    if (phase === 'recovery') {
      if (attack.id === 'nova') this.wantBlink = true;
      if (attack.id === 'bolt' || attack.id === 'fan' || attack.id === 'volley') this.mirrors.idle();
      return;
    }
    switch (attack.id) {
      case 'blink':
      case 'blinkFast':
        if (this.blinkDest) this.teleportTo(this.blinkDest);
        if (this.mirrors.active) this.mirrors.moveTo([this.pickPerch([this.perch]), this.pickPerch([this.perch])].filter((x, i, a) => a.indexOf(x) === i));
        this.blinkDest = null;
        break;
      case 'orbs': {
        const n = this.phase >= 2 ? 4 : 3;
        this.orbs.speed = this.phase >= 2 ? 5.0 : 4.4;
        for (let k = 0; k < n; k++) {
          const a = this.facing + ((k / (n - 1)) - 0.5) * 2.1;
          this.orbs.spawn(this.feet.x + Math.sin(a) * 1.2, this.feet.y + 2, this.feet.z + Math.cos(a) * 1.2, Math.sin(a) * 4, Math.cos(a) * 4);
        }
        playSfx('stormCrackle', { pos: this.position, intensity: 1 });
        break;
      }
      case 'mirrors': {
        const real = this.pickPerch();
        const a = this.pickPerch([real]);
        const b = this.pickPerch([real, a]);
        this.mirrors.spawn([a, b], 14);
        this.teleportTo(real);
        // the lock-on may now pick a decoy
        playSfx('stormBlink', { pos: this.position, variant: 'arrive' });
        break;
      }
      case 'thunderfall':
        this.detonateThunderfall();
        break;
      case 'bolt':
        if (this.mirrors.active) this.mirrors.fire(15);
        break;
      case 'fan':
        if (this.mirrors.active) this.mirrors.fire(13, 2, 0.4);
        break;
      case 'volley':
        if (this.mirrors.active) this.mirrors.fire(14);
        break;
      default:
        break;
    }
  }

  /** Bolts: like the base, but from her staff (hover-aware) and marked with a gold halo. */
  override fireProjectile(box: ProjectileBox, i: number, n: number, tele: TelegraphKind, damage: number) {
    const f = this.facing;
    const off = box.offset ?? this.radius + 0.4;
    const origin = tmp.set(this.feet.x + Math.sin(f) * off, this.feet.y + this.hover + (box.height ?? this.def.height * 0.75), this.feet.z + Math.cos(f) * off);
    const p = this.game.player.position;
    let yaw = f;
    let pitch = 0;
    if ((box.aim ?? 'player') === 'player') {
      yaw = Math.atan2(p.x - origin.x, p.z - origin.z);
      pitch = Math.atan2(p.y + 1.0 - origin.y, Math.hypot(p.x - origin.x, p.z - origin.z));
    }
    const spread = n > 1 ? (box.spread ?? 30) * (Math.PI / 180) : 0;
    yaw += n > 1 ? -spread / 2 + (spread * i) / (n - 1) : 0;
    const cp = Math.cos(pitch);
    const dir = tmp2.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const shot = this.game.bosses.effects.spawnProjectile({
      owner: this, position: origin, direction: dir, speed: box.speed, homing: box.homing, lifetime: box.lifetime,
      radius: box.radius, damage, knockback: box.knockback, telegraph: tele, reflectable: box.reflectable,
      reflectDamage: box.reflectDamage, reflectPoise: box.reflectPoise,
    });
    if (box.reflectable) this.markers.track(shot);
    playSfx('stormZap', { pos: origin });
  }

  private after(t: number, fn: () => void) {
    this.later.push({ t, fn });
  }

  private spawnRunes(windup: number) {
    const p = this.game.player.position;
    const S = this.strikes;
    const T = Difficulty.telegraph();
    const inside = (x: number, z: number) => Math.hypot(x - this.sa.cx, z - this.sa.cz) < 18.6;
    const choices = this.phase === 0 ? 2 : 3;
    const pattern = this.phase === 0 ? this.runePattern++ % 2 : Math.floor(Math.random() * choices);
    const dmg = 16;
    if (pattern === 0) {
      // checker: wave A, then wave B. The grid corners are always safe; or step into A once it fired.
      const f = this.facing;
      const c = Math.cos(f);
      const s = Math.sin(f);
      const sp = 3.0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const lx = (i - 1.5) * sp + sp / 2; // you stand on a cell centre: standing still gets hit
          const lz = (j - 1.5) * sp + sp / 2;
          const x = p.x + lx * c + lz * s;
          const z = p.z - lx * s + lz * c;
          if (!inside(x, z)) continue;
          const wave = (i + j) % 2;
          S.spawn(x, z, 1.3, windup + (wave ? 0.95 : 0.25) * T, dmg, 'magic', 'rune', 2);
        }
      }
    } else if (pattern === 1) {
      // three lines radiating from her toward you, erupting outward
      const base = Math.atan2(p.x - this.feet.x, p.z - this.feet.z);
      for (const off of [-0.45, 0, 0.45]) {
        const a = base + off;
        for (let k = 0; k < 7; k++) {
          const d = 2.4 + k * 2.4;
          const x = this.feet.x + Math.sin(a) * d;
          const z = this.feet.z + Math.cos(a) * d;
          if (!inside(x, z)) continue;
          S.spawn(x, z, 1.15, windup + (0.15 + k * 0.12) * T, dmg, 'magic', 'rune', 2);
        }
      }
    } else {
      // rings around you: centre, inner ring, then outer ring (gaps between the runes)
      S.spawn(p.x, p.z, 1.4, windup + 0.2 * T, dmg, 'magic', 'rune', 2);
      const r0 = Math.random() * Math.PI;
      for (let k = 0; k < 6; k++) {
        const a = r0 + (k / 6) * Math.PI * 2;
        const x = p.x + Math.sin(a) * 3.3;
        const z = p.z + Math.cos(a) * 3.3;
        if (inside(x, z)) S.spawn(x, z, 1.25, windup + 0.55 * T, dmg, 'magic', 'rune', 2);
      }
      for (let k = 0; k < 9; k++) {
        const a = r0 + ((k + 0.5) / 9) * Math.PI * 2;
        const x = p.x + Math.sin(a) * 6.2;
        const z = p.z + Math.cos(a) * 6.2;
        if (inside(x, z)) S.spawn(x, z, 1.25, windup + 1.0 * T, dmg, 'magic', 'rune', 2);
      }
    }
    playSfx('stormCrackle', { pos: this.position, intensity: 0.6 });
  }

  private spawnChain(windup: number) {
    const p = this.game.player.position;
    const yaw = Math.atan2(p.x - this.feet.x, p.z - this.feet.z);
    const speed = this.phase >= 2 ? 9.5 : 8.5;
    const kind: SweepKind = this.chainLow ? 'chain-low' : 'chain-high';
    this.chainLow = !this.chainLow;
    const T = Difficulty.telegraph();
    this.lines.spawn(kind, yaw, windup + 0.25 * T, speed, 22);
    if (this.phase >= 2 && Math.random() < 0.35) {
      // a second chain of the other height right behind it
      this.lines.spawn(kind === 'chain-low' ? 'chain-high' : 'chain-low', yaw, windup + 1.35 * T, speed, 22);
    }
  }

  private spawnWall(windup: number) {
    const p = this.game.player.position;
    const yaw = Math.atan2(p.x - this.feet.x, p.z - this.feet.z);
    const T = Difficulty.telegraph();
    const gap = this.phase >= 2 ? 3.4 : 3.8;
    this.lines.spawn('wall', yaw, windup + 0.35 * T, 5.5, 24, (Math.random() - 0.5) * 12, gap);
    if (this.phase >= 2 && Math.random() < 0.4) {
      this.lines.spawn('wall', yaw + Math.PI / 2, windup + 1.8 * T, 5.5, 24, (Math.random() - 0.5) * 12, gap);
    }
  }

  // -------------------------------------------------------------------- thunderfall
  private beginThunderfall(windup: number) {
    const p = this.game.player.position;
    const order = this.sa.pylons.map((py, k) => ({ k, d: Math.hypot(py.x - p.x, py.z - p.z) })).sort((a, b) => a.d - b.d);
    // the second-nearest pylon (always reachable in the windup) + one random far one
    const picks = [order[1].k, order[2 + Math.floor(Math.random() * (order.length - 2))].k];
    this.tfPockets.length = 0;
    for (const k of picks) {
      const py = this.sa.pylons[k];
      this.tfPockets.push({ x: py.x, z: py.z, r: 3.4, pylon: k });
      this.sa.highlight(k, 1);
    }
    this.tf.show(this.tfPockets);
    this.tfFade = 1;
    this.tf.set(0, this.time);
    this.sa.sky.target = 1;
    this.game.hud.flash('Thunderfall — find the green light', 2);
    playSfx('stormThunder', { pos: this.position, intensity: 0.6, variant: 'far' });
    void windup;
  }

  private detonateThunderfall() {
    const p = this.game.player;
    const safe = this.tfPockets.some((k) => Math.hypot(p.position.x - k.x, p.position.z - k.z) <= k.r);
    if (!safe) {
      const res = this.hitPlayerFrom(46, 10, 'unblockable', p.position.x, p.position.y + 6, p.position.z, true);
      void res;
    }
    // visual scatter
    for (let k = 0; k < 16; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 17;
      const x = this.sa.cx + Math.sin(a) * r;
      const z = this.sa.cz + Math.cos(a) * r;
      if (this.tfPockets.some((q) => Math.hypot(x - q.x, z - q.z) < q.r)) continue;
      this.strikes.flashBolt(x, this.sa.surface(x, z), z, 'unblockable', 20);
    }
    this.screen.pulse(1);
    this.sa.sky.pulse(1.2);
    this.sa.flashClouds(1);
    this.game.cam.shake(0.9);
    playSfx('stormThunder', { pos: this.position, intensity: 1.4 });
    for (const k of this.tfPockets) this.sa.highlight(k.pylon, 0);
    this.tfTimer = 24;
    this.sa.sky.target = 0.8;
  }

  private hitPlayerFrom(dmg: number, kb: number, kind: TelegraphKind, x: number, y: number, z: number, heavy: boolean) {
    return this.hitPlayer({ damage: dmg, knockback: kb, heavy, telegraph: kind, parryable: false, unblockable: kind === 'unblockable', from: tmp.set(x, y, z) });
  }

  // -------------------------------------------------------------------- teleport
  private teleportTo(pe: Perch) {
    const from = tmp2.copy(this.position);
    this.game.fx.sparks.emit({ count: 26, position: from, spread: 0.5, speed: 3, upBias: 0.6, life: [0.2, 0.5], size: [0.05, 0.12], color: LIGHTNING.cyan, color2: LIGHTNING.violet, gravity: -2, drag: 2 });
    this.feet.set(pe.x, pe.y, pe.z);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    const p = this.game.player.position;
    this.facing = Math.atan2(p.x - pe.x, p.z - pe.z);
    this.syncPosition();
    this.perch = pe;
    this.sinceBlink = 0;
    this.closeTime = 0;
    this.vanish = 0;
    this.appear = 0;
    this.strikes.flashBolt(pe.x, pe.y, pe.z, 'magic', 14);
    this.screen.pulse(0.25);
    this.sa.flashClouds(0.5);
    this.releaseBlinkDecal();
    playSfx('stormBlink', { pos: this.position, variant: 'arrive' });
  }

  private releaseBlinkDecal() {
    this.blinkDecal?.release(0.15);
    this.blinkDecal = null;
  }

  // ==================================================================== damage overrides
  override onHit(info: HitInfo) {
    if (this.mirrors.active && this.alive && !this.invulnerable && this.state !== 'dormant') this.reveal();
    super.onHit(info);
  }

  override onReflectHit(damage: number, poise: number, at: Vector3) {
    if (!this.alive || this.invulnerable) return;
    if (this.mirrors.active) this.reveal();
    const st = this.storm;
    if (st && st.stage === 'storm') {
      st.reflects++;
      this.applyDamage(Math.round(damage), true, false, at.clone());
      this.game.hud.flash(`The storm falters (${st.reflects}/${STORM_REFLECTS})`, 1.2);
      if (this.alive && st.reflects >= STORM_REFLECTS && this.storm === st) this.setStormStage('fall');
      return;
    }
    super.onReflectHit(damage, poise, at);
  }

  /** Hitting the real one while the mirrors are up: violet burst, the images shatter, she flinches. */
  private reveal() {
    this.mirrors.dismiss(true);
    this.game.fx.sparks.emit({ count: 50, position: this.position, spread: 0.4, speed: 6, upBias: 0.3, life: [0.2, 0.6], size: [0.06, 0.16], color: LIGHTNING.violet, color2: LIGHTNING.core, gravity: 2, drag: 2 });
    this.screen.pulse(0.4);
    if (this.state === 'idle' || (this.state === 'attack' && this.runner.phase === 'windup')) {
      this.runner.cancel();
      this.go('recoil', 0.7);
      events.emit('boss:stagger', { id: this.id, position: this.position.clone(), duration: 0.7, cause: 'custom', riposte: false });
    }
  }

  /** Staggered on a pylon top → she is knocked off it, toward the arena centre. */
  override stagger(duration: number, cause: 'poise' | 'parry' | 'counter' | 'reflect' | 'custom', riposte: boolean) {
    if (this.storm && cause !== 'custom' && cause !== 'reflect') this.endStorm(true);
    super.stagger(duration, cause, riposte);
    this.mirrors.dismiss(true);
    this.releaseBlinkDecal();
    this.blinkDest = null;
    if (this.perch.pylon >= 0 && this.feet.y > this.sa.floor + 1) {
      const py = this.sa.pylons[this.perch.pylon];
      const dx = this.sa.cx - py.x;
      const dz = this.sa.cz - py.z;
      const d = Math.hypot(dx, dz) || 1;
      this.feet.x = py.x + (dx / d) * 2.4;
      this.feet.z = py.z + (dz / d) * 2.4;
      this.grounded = false;
      this.velocity.set(0, 0, 0);
      this.perch = { x: this.feet.x, z: this.feet.z, y: this.sa.floor, pylon: -1 };
    }
    this.wantBlink = true; // she recovers by blinking away
  }

  // ==================================================================== storm event
  private startStorm() {
    this.pendingStorm = false;
    this.setCustom(Infinity);
    this.kinematic = true;
    this.invulnerable = true;
    const T = Difficulty.telegraph();
    this.storm = {
      t: 0, stage: 'rise', stageT: 0, dur: this.phase >= 2 ? 15 : 17, reflects: 0,
      nextStrike: 1.0, collapses: [1.5, 6.5, 11.5], nextGust: 3.5, gustWarn: 0, gustT: 0, gustX: 0, gustZ: 0,
      nextBolt: 2.2 * T, boltWind: -1, from: this.feet.clone(),
    };
    this.model.play('Spellcast_Raise', { fade: 0.15, loop: false, restart: true, speed: 0.8 });
    this.sa.sky.target = 1;
    this.sa.energy = 1;
    this.game.cam.shake(0.6);
    playSfx('stormThunder', { pos: this.position, intensity: 1.1 });
  }

  private setStormStage(stage: StormStage) {
    const st = this.storm;
    if (!st) return;
    st.stage = stage;
    st.stageT = 0;
    st.from.copy(this.feet);
    if (stage === 'storm') {
      this.invulnerable = false;
      this.sa.setEdgeCharged(true);
      this.model.play('Spellcasting', { fade: 0.3, loop: true });
      this.game.hud.flash('Survive the storm — or parry her bolts back', 2.4);
    } else if (stage === 'fall') {
      this.model.play(this.def.anims.stagger, { fade: 0.1, loop: false, restart: true, speed: 0.6 });
      this.game.cam.shake(0.5);
      playSfx('stormThunder', { pos: this.position, intensity: 0.9 });
    } else if (stage === 'descend') {
      this.model.play('Idle', { fade: 0.3 });
    }
  }

  /** Leave the storm event: hazards off, tiles rise again. */
  private endStorm(dropped: boolean) {
    if (!this.storm) return;
    this.storm = null;
    this.kinematic = false;
    if (!dropped) this.invulnerable = false;
    this.sa.setEdgeCharged(false);
    this.sa.restoreAll(false);
    this.sa.energy = 0.6 + this.phase * 0.15;
    this.sa.sky.target = 0.5 + this.phase * 0.15;
    this.perch = this.centrePerch;
    this.sinceBlink = 0;
    if (this.phase >= 2) this.tfTimer = 7;
  }

  protected override onCustomState(dt: number) {
    const st = this.storm;
    if (!st) {
      this.toIdle(0.3);
      return;
    }
    st.t += dt;
    st.stageT += dt;
    const p = this.game.player;
    const cx = this.sa.cx;
    const cz = this.sa.cz;
    const top = this.sa.floor + ALTITUDE;
    this.turnToward(p.position, 3, dt);
    this.velocity.set(0, 0, 0);
    const T = Difficulty.telegraph();

    if (st.stage === 'rise') {
      const u = clamp(st.stageT / 2.0, 0, 1);
      const e = u * u * (3 - 2 * u);
      this.feet.set(st.from.x + (cx - st.from.x) * e, st.from.y + (top - st.from.y) * e, st.from.z + (cz - st.from.z) * e);
      if (Math.random() < 0.5) this.strikes.flashBolt(cx + (Math.random() - 0.5) * 30, this.sa.surface(cx, cz), cz + (Math.random() - 0.5) * 30, 'magic', 20);
      if (u >= 1) this.setStormStage('storm');
    } else if (st.stage === 'storm') {
      this.feet.set(cx + Math.sin(st.t * 0.5) * 1.5, top + Math.sin(st.t * 1.3) * 0.3, cz + Math.cos(st.t * 0.5) * 1.5);
      // strikes at your feet — keep moving
      st.nextStrike -= dt;
      if (st.nextStrike <= 0 && !p.dead) {
        st.nextStrike = this.phase >= 2 ? 0.85 : 1.05;
        this.strikes.spawn(p.position.x, p.position.z, 1.7, 0.95 * T, 16, 'magic', 'bolt');
      }
      // the floor gives way
      const ts = st.stageT;
      if (st.collapses.length && ts >= st.collapses[0]) {
        st.collapses.shift();
        this.collapseNear(p.position.x, p.position.z, 1.6 * T);
      }
      // gusts toward the electrified edge
      this.updateGusts(st, dt);
      // reflectable bolts from the sky
      if (st.boltWind < 0) {
        st.nextBolt -= dt;
        if (st.nextBolt <= 0) {
          st.boltWind = 0.75 * T;
          this.beginTelegraph(SKY_BOLT_DEF, 0, 'magic', st.boltWind, true);
          this.model.play('Spellcast_Shoot', { fade: 0.1, loop: false, restart: true, speed: 0.9 });
        }
      } else {
        st.boltWind -= dt;
        this.glow = clamp(1 - st.boltWind / (0.75 * T), 0, 1);
        if (st.boltWind <= 0) {
          st.boltWind = -1;
          st.nextBolt = (this.phase >= 2 ? 1.9 : 2.3) * T;
          this.fireProjectile(SKY_BOLT, 0, 1, 'magic', 18);
          this.model.play('Spellcasting', { fade: 0.3, loop: true });
        }
      }
      if (st.stageT >= st.dur) this.setStormStage('descend');
    } else {
      // fall (fast, reflected down) or descend (exhausted after the storm)
      const dur = st.stage === 'fall' ? 0.55 : 1.4;
      const u = clamp(st.stageT / dur, 0, 1);
      const e = st.stage === 'fall' ? u * u : u * u * (3 - 2 * u);
      const fy = this.sa.floor;
      this.feet.set(st.from.x + (cx - st.from.x) * e, st.from.y + (fy - st.from.y) * e, st.from.z + (cz - st.from.z) * e);
      if (u >= 1) {
        const fell = st.stage === 'fall';
        this.feet.y = fy;
        this.endStorm(false);
        this.game.fx.slam(this.feet, 3);
        this.game.cam.shake(0.5);
        this.game.hud.flash(fell ? 'She falls — strike!' : 'The storm is spent', 1.6);
        this.stagger(fell ? 4.0 : 2.4, 'custom', true);
      }
    }
    this.syncPosition();
  }

  private collapseNear(x: number, z: number, warn: number) {
    const seeds = this.sa.collapsibleNear(x, z, 5);
    if (!seeds.length) return;
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    const t = this.sa.tiles[seed];
    const near = this.sa.collapsibleNear(t.x, t.z, 4.6, [seed]);
    const pick = [seed];
    while (near.length && pick.length < 3) pick.push(near.splice(Math.floor(Math.random() * near.length), 1)[0]);
    this.sa.crack(pick, warn);
  }

  private updateGusts(st: StormEvent, dt: number) {
    const p = this.game.player;
    if (st.gustWarn <= 0 && st.gustT <= 0) {
      st.nextGust -= dt;
      if (st.nextGust <= 0) {
        // blow outward, past the player, toward the nearest edge
        let dx = p.position.x - this.sa.cx;
        let dz = p.position.z - this.sa.cz;
        const d = Math.hypot(dx, dz);
        if (d < 1) {
          const a = Math.random() * Math.PI * 2;
          dx = Math.sin(a);
          dz = Math.cos(a);
        } else {
          dx /= d;
          dz /= d;
        }
        st.gustX = dx;
        st.gustZ = dz;
        st.gustWarn = 1.0 * Difficulty.telegraph();
        playSfx('stormWind', { pos: p.position, variant: 'warn' });
      }
      return;
    }
    if (st.gustWarn > 0) {
      st.gustWarn -= dt;
      this.windFx(st, 0.4);
      if (st.gustWarn <= 0) {
        st.gustT = 1.7;
        playSfx('stormWind', { pos: p.position });
      }
      return;
    }
    st.gustT -= dt;
    this.windFx(st, 1);
    if (!p.dead && p.state !== 'grabbed') {
      const k = 4.6;
      p.position.x += st.gustX * k * dt;
      p.position.z += st.gustZ * k * dt;
    }
    if (st.gustT <= 0) st.nextGust = this.phase >= 2 ? 4 : 5;
  }

  private windFx(st: StormEvent, k: number) {
    if (Math.random() > 0.8 * k) return;
    const p = this.game.player.position;
    tmp.set(p.x - st.gustX * 6 + (Math.random() - 0.5) * 8, p.y + 0.3 + Math.random() * 2.2, p.z - st.gustZ * 6 + (Math.random() - 0.5) * 8);
    tmp2.set(st.gustX * 16 * k, 0, st.gustZ * 16 * k);
    this.game.fx.sparks.emit({ count: 2, position: tmp, spread: 0.6, velocity: tmp2, speed: 0.3, life: [0.35, 0.6], size: [0.04, 0.08], color: WIND, drag: 0.2 });
  }

  // ==================================================================== frame
  protected override onUpdate(dt: number) {
    if (this.storm && this.state !== 'custom') this.endStorm(true);
    this.sinceBlink += dt;
    this.novaCd = Math.max(0, this.novaCd - dt);
    if (this.phase >= 2 && !this.storm && this.state !== 'transition') this.tfTimer -= dt;
    this.updateAura(dt);
  }

  /** Phase 3: standing still too long in one spot calls a strike down on you. */
  private updateAura(dt: number) {
    const p = this.game.player;
    // (paused while Thunderfall asks you to hold a safe pocket)
    if (this.phase < 2 || this.storm || p.dead || !this.alive || this.tfFade > 0) {
      this.auraT = 0;
      return;
    }
    if (Math.hypot(p.position.x - this.auraX, p.position.z - this.auraZ) > 2.4) {
      this.auraX = p.position.x;
      this.auraZ = p.position.z;
      this.auraT = Math.min(this.auraT, 0);
      return;
    }
    this.auraT += dt;
    if (this.auraT > 1.0 && Math.random() < 0.5) {
      tmp.set(p.position.x + (Math.random() - 0.5) * 2.4, p.position.y + 0.1, p.position.z + (Math.random() - 0.5) * 2.4);
      this.game.fx.sparks.emit({ count: 1, position: tmp, spread: 0.1, speed: 1.5, upBias: 2, life: [0.2, 0.4], size: [0.05, 0.1], color: LIGHTNING.cyan, drag: 1 });
    }
    if (this.auraT >= 2.0) {
      this.auraT = -1.2;
      this.strikes.spawn(this.auraX, this.auraZ, 2.2, 0.75 * Difficulty.telegraph(), 18, 'magic', 'bolt');
    }
  }

  /** Every frame (from the feature), also while dormant / dead: effects and their rendering. */
  tick(dt: number) {
    this.time += dt;
    this.sa.update(dt);
    // scheduled spawns
    for (let i = this.later.length - 1; i >= 0; i--) {
      const l = this.later[i];
      l.t -= dt;
      if (l.t <= 0) {
        this.later.splice(i, 1);
        if (this.alive && this.engaged) l.fn();
      }
    }
    this.strikes.update(dt);
    this.lines.update(dt);
    this.orbs.update(dt);
    this.mirrors.update(dt);
    this.markers.update(dt, this.owners);
    this.screen.update(dt);

    // blink: shimmer at the destination, dissolve at the origin
    const blinking = this.state === 'attack' && (this.runner.def?.id === 'blink' || this.runner.def?.id === 'blinkFast') && this.runner.phase === 'windup';
    if (blinking && this.blinkDest && this.blinkDecal) {
      const u = clamp(this.runner.phaseTime / Math.max(0.05, this.runner.windup), 0, 1);
      this.blinkDecal.fill = u;
      this.vanish = clamp((u - 0.55) / 0.45, 0, 1);
      const d = this.blinkDest;
      if (Math.random() < 0.7) {
        tmp.set(d.x + (Math.random() - 0.5) * 1.2, d.y + Math.random() * 2.6, d.z + (Math.random() - 0.5) * 1.2);
        this.game.fx.sparks.emit({ count: 2, position: tmp, spread: 0.2, speed: 1, upBias: 1.5, life: [0.2, 0.45], size: [0.05, 0.12], color: LIGHTNING.cyan, color2: LIGHTNING.violet, gravity: -2, drag: 2 });
      }
    } else {
      if (this.blinkDecal && !blinking) this.releaseBlinkDecal();
      this.vanish = Math.max(0, this.vanish - dt * 6);
    }
    this.appear = Math.min(1, this.appear + dt * 4);

    // thunderfall telegraph
    if (this.tfFade > 0) {
      const tfRunning = this.state === 'attack' && this.runner.def?.id === 'thunderfall';
      if (tfRunning && this.runner.phase === 'windup') {
        this.tf.set(clamp(this.runner.phaseTime / this.runner.windup, 0, 1), this.time, 1);
      } else {
        this.tfFade = Math.max(0, this.tfFade - dt * 2.5);
        this.tf.set(1, this.time, this.tfFade);
        if (this.tfFade <= 0) {
          this.tf.hide();
          for (const k of this.tfPockets) this.sa.highlight(k.pylon, 0);
          this.tfPockets.length = 0;
        }
      }
    }

    // lightning rendering
    this.bolts.begin();
    this.strikes.draw(dt);
    this.lines.draw();
    this.drawBodyArcs(dt);
    if (this.tfPockets.length && this.tfFade > 0) {
      for (const k of this.tfPockets) {
        const c = this.sa.pylons[k.pylon].crystal;
        if (Math.random() < 0.5) this.bolts.jagged(c.x, c.y, c.z, c.x, this.sa.pylons[k.pylon].top + 0.4, c.z, 4, 0.25, 0.04, LIGHTNING.safe, LIGHTNING.core);
      }
    }
    this.bolts.end();
  }

  /** Crackles around her staff, stagger sparks, the death dispersal. */
  private drawBodyArcs(dt: number) {
    if (!this.revealed) return;
    const B = this.bolts;
    const f = this.feet;
    const h = this.def.height;
    if (this.state === 'dead') {
      if (this.deathT < 0) return;
      this.deathT += dt;
      const t = this.deathT;
      if (t < 2.6) {
        const n = 1 + Math.floor(t * 2);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const y0 = f.y + Math.random() * h;
          const len = 0.6 + t * 1.2;
          B.jagged(f.x, y0, f.z, f.x + Math.sin(a) * len, y0 + (Math.random() - 0.3) * len, f.z + Math.cos(a) * len, 4, 0.3, 0.035, LIGHTNING.violet, LIGHTNING.core);
        }
      } else if (t - dt < 2.6) {
        // she disperses: a last strike, the storm clears
        this.strikes.flashBolt(f.x, f.y, f.z, 'magic', 24);
        this.screen.pulse(1);
        this.sa.sky.pulse(1.2);
        this.sa.flashClouds(1);
        this.game.fx.sparks.emit({ count: 90, position: tmp.copy(f).setY(f.y + h * 0.5), spread: 0.6, speed: 9, upBias: 0.6, life: [0.3, 1.0], size: [0.06, 0.16], color: LIGHTNING.cyan, color2: LIGHTNING.violet, gravity: -1, drag: 1.5 });
        playSfx('stormThunder', { pos: this.position, intensity: 1.3 });
        this.model.root.visible = false;
      }
      return;
    }
    // staff crackle (stronger while winding up a spell)
    const k = this.state === 'attack' ? 0.6 : 0.2;
    if (Math.random() < k) {
      const yaw = this.facing + 0.5;
      const sx = f.x + Math.sin(yaw) * 0.6;
      const sz = f.z + Math.cos(yaw) * 0.6;
      const sy = f.y + this.hover + h * 0.8;
      B.jagged(sx, sy, sz, sx + (Math.random() - 0.5) * 1.2, sy + (Math.random() - 0.2) * 1.0, sz + (Math.random() - 0.5) * 1.2, 3, 0.2, 0.025, LIGHTNING.cyan, LIGHTNING.core);
    }
    if (this.state === 'stagger' && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2;
      B.jagged(f.x, f.y + 0.2, f.z, f.x + Math.sin(a) * 1.4, f.y + 0.05, f.z + Math.cos(a) * 1.4, 3, 0.2, 0.03, LIGHTNING.violet, LIGHTNING.core);
    }
  }

  protected override syncVisual(dt: number) {
    super.syncVisual(dt);
    const grounded = this.state === 'stagger' || this.state === 'knockdown' || this.state === 'dead' || this.state === 'recoil';
    const want = grounded ? 0 : 0.35;
    this.hover += (want - this.hover) * Math.min(1, dt * 6);
    const r = this.model.root;
    r.position.y += this.hover + (grounded ? 0 : Math.sin(this.time * 2.1) * 0.08);
    const v = this.vanish;
    const a = this.appear;
    const sy = (1 - v * 0.95) * (0.3 + 0.7 * a);
    r.scale.set(1 - v * 0.7, Math.max(0.02, sy), 1 - v * 0.7);
    if (!this.revealed) r.visible = false;
    else if (this.state !== 'dead') r.visible = true;
    else if (this.deathT >= 2.6) r.visible = false;
  }
}

const WIND = new Color(0.5, 0.6, 0.75);
