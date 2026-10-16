import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';
import { playSfx } from '../../audio/audioFeature';
import type { Game } from '../../core/Game';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitResult } from '../../player/Player';
import type { HitInfo, Hittable } from '../../world/World';
import { Boss, type BossDef } from '../Boss';
import { TelegraphColors } from '../Decals';
import { Difficulty } from '../difficulty';
import type { Decision, DirectorContext } from '../Director';
import type { BossHitSpec } from '../Hitboxes';
import type { AttackDef, TelegraphKind } from '../types';
import { ColossusAttacks } from './attacks';
import { ColossusEffects } from './effects';
import { BELL_R, ColossusRig, type Rubble } from './rig';

/**
 * THE BELL COLOSSUS — a 12 m giant of stone and bronze with a great bell for a head.
 *
 *  - Procedural rig (rig.ts): every block of its body is also a moving collider — stand on its feet,
 *    climb the hammer + forearm when the hammer rests after a slam, grab the belt / shoulder ledges,
 *    wall-run the shins. Moving parts carry the player (Player's generic moving-platform hook).
 *  - Damage model: steel on stone chips (×0.1, "clang"); glowing RUNES take ×1.5. Breaking a rune
 *    (back of each calf, top of the hammer fist; phase 3 also between the shoulder blades) staggers it
 *    and fills its poise. Full poise → it kneels for ~7 s and the BELL CORE in its chest opens:
 *    strike it for the finisher (Critical, ~260).
 *  - Phase 1 Toll: stomps (jump the ring), committed overhead slam (hammer stays down = ramp),
 *    ground sweep (jump / slide / roll), stone backhand (gold), bell toll (cyan wave, knocks climbers off).
 *  - Phase 2 Tremor (≤ 66 %): shake-off (standing climbers thrown, hanging ones hold on), swat along
 *    its body (gold), crumbling hail (falling debris), faster stomp chains with a delayed third stomp.
 *  - Phase 3 Cracked Bell (≤ 33 %): arena-wide double toll every ~15 s (jump / high ground), march
 *    across the arena trailing shockwaves, the calf runes orbit their legs, a back rune appears,
 *    desperation leap-slam across the arena.
 */
export const ColossusDef: BossDef = {
  id: 'colossus',
  name: 'The Bell Colossus',
  title: 'Tollkeeper of the West Ruins',
  maxHealth: 1500,
  radius: 0.6,
  height: 12,
  phases: [
    { threshold: 1, name: 'Toll' },
    { threshold: 0.66, name: 'Tremor', transition: { duration: 3.0, clip: 'roar', speed: 0.85, shake: 0.9 } },
    { threshold: 0.33, name: 'Cracked Bell', transition: { duration: 3.2, clip: 'roar', speed: 0.8, shake: 1.2 } },
  ],
  poise: { max: 100, regen: 4, regenDelay: 6, damageMul: 1, staggerTime: 7, vulnerableMul: 1.3 },
  parryPoise: 30,
  counterPoise: 35,
  onParry: 'recoil',
  riposte: { damage: 260, range: 3, arcDeg: 360, knockdown: 3.0 },
  speeds: { walk: 1.6, run: 2.6, strafe: 1.2, back: 1.0, turn: 0.75 },
  trackRate: { windup: 0.9, active: 0, recovery: 0.3 },
  anims: {
    idle: 'idle', walk: 'walk', run: 'walk', strafeLeft: 'walk', strafeRight: 'walk', back: 'walk',
    roar: 'roar', stagger: 'kneel', recoil: 'flinch', knockdown: 'knockdown', death: 'kneel',
  },
  attacks: ColossusAttacks,
  director: {
    phases: [
      {
        // Toll: slow, heavy, readable. Long gaps; stomps punish standing under / behind it.
        aggression: 0.35,
        idleTime: [1.0, 2.4],
        preferredRange: [5, 10],
        attacks: [
          { attack: 'stomp', weight: 2.2, range: [0, 6], angle: 'any', followUps: [{ attack: 'backhand', chance: 0.25, range: [2, 7] }] },
          { attack: 'stompL', weight: 2.2, range: [0, 6], angle: 'any' },
          { attack: 'stomp', weight: 3, range: [0, 7], angle: 'behind' },
          { attack: 'slam', weight: 3, range: [6, 12.5], cooldown: 5 },
          { attack: 'sweep', weight: 2.5, range: [2.5, 8.5], cooldown: 4 },
          { attack: 'backhand', weight: 2, range: [1.5, 7.5], followUps: [{ attack: 'stomp', chance: 0.3, range: [0, 5] }] },
          { attack: 'toll', weight: 1.2, range: [0, 14], cooldown: 9 },
        ],
        punish: { heal: ['slam', 'toll'], reaction: 0.4 },
      },
      {
        // Tremor: shorter gaps, stomp chains, debris; anti-climber tools (decide()).
        aggression: 0.55,
        idleTime: [0.7, 1.8],
        preferredRange: [5, 10],
        attacks: [
          { attack: 'stompChain', weight: 2.2, range: [0, 7], angle: 'any', cooldown: 6 },
          { attack: 'stomp', weight: 1.5, range: [0, 6], angle: 'any' },
          { attack: 'stompL', weight: 1.5, range: [0, 6], angle: 'any' },
          { attack: 'slam', weight: 2.5, range: [6, 12.5], cooldown: 5, followUps: [{ attack: 'debris', chance: 0.35 }] },
          { attack: 'sweep', weight: 2.5, range: [2.5, 8.5], cooldown: 4, followUps: [{ attack: 'backhand', chance: 0.3, range: [1.5, 7.5] }] },
          { attack: 'backhand', weight: 2, range: [1.5, 7.5], followUps: [{ attack: 'sweep', chance: 0.3, range: [2.5, 8.5] }] },
          { attack: 'debris', weight: 1.6, range: [0, 22], cooldown: 9 },
          { attack: 'swat', weight: 3, range: [0, 6], player: 'above', angle: 'any', cooldown: 4 },
          { attack: 'toll', weight: 1.2, range: [0, 14], cooldown: 8 },
        ],
        punish: { heal: ['slam', 'debris', 'toll'], reaction: 0.3 },
      },
      {
        // Cracked Bell: relentless; marches, leaps, arena-wide tolls (forced on a timer in decide()).
        aggression: 0.72,
        idleTime: [0.5, 1.4],
        preferredRange: [4, 9],
        attacks: [
          { attack: 'stompChain', weight: 2.2, range: [0, 7], angle: 'any', cooldown: 5 },
          { attack: 'stomp', weight: 1.2, range: [0, 6], angle: 'any' },
          { attack: 'slam', weight: 2.2, range: [6, 12.5], cooldown: 5, followUps: [{ attack: 'sweep', chance: 0.35, range: [2.5, 8.5] }] },
          { attack: 'sweep', weight: 2.2, range: [2.5, 8.5], cooldown: 4, followUps: [{ attack: 'backhand', chance: 0.35, range: [1.5, 7.5] }] },
          { attack: 'backhand', weight: 1.6, range: [1.5, 7.5], followUps: [{ attack: 'stompChain', chance: 0.25, range: [0, 6] }] },
          { attack: 'march', weight: 2.2, range: [6, 24], cooldown: 8 },
          { attack: 'leap', weight: 1.6, range: [10, 34], cooldown: 14 },
          { attack: 'debris', weight: 1.4, range: [0, 22], cooldown: 9 },
          { attack: 'swat', weight: 3, range: [0, 6], player: 'above', angle: 'any', cooldown: 4 },
          { attack: 'greatToll', weight: 0.6, range: [0, 40], cooldown: 12 },
        ],
        punish: { heal: ['leap', 'debris', 'slam'], reaction: 0.25 },
      },
    ],
  },
  echoDamageMul: 0.6,
  eyeColor: new Color(2.4, 1.3, 0.4),
  weapon: 'colossus-hammer',
  introTime: 4.4,
  chainDelay: 0.25,
};

// ====================================================================== targets
const RUNE_IDLE = new Color(3.0, 1.55, 0.45);
const RUNE_DEAD = new Color(0.12, 0.1, 0.09);
const CORE = new Color(3.6, 2.4, 1.0);

type RuneId = 'kneeL' | 'kneeR' | 'wrist' | 'back' | 'core';

/** A glowing weak point: its own Hittable (the player's swings query it like any target). */
class WeakPoint implements Hittable {
  readonly position = new Vector3();
  /** the side the rune faces (world, horizontal); hits from behind it land on stone. null = any side */
  normal: Vector3 | null = new Vector3();
  readonly radius: number;
  alive = false;
  lockable = false;
  hp: number;
  maxHp: number;
  broken = false;
  rearm = 0;
  readonly mesh: Mesh;
  readonly halo: Mesh;
  readonly mat: MeshBasicMaterial;

  constructor(private readonly boss: Colossus, readonly id: RuneId, hp: number, size: number) {
    this.radius = id === 'core' ? 1.0 : 0.6;
    if (id === 'wrist') this.normal = null;
    this.hp = this.maxHp = hp;
    this.mat = new MeshBasicMaterial({ color: RUNE_IDLE.clone(), toneMapped: false });
    this.mesh = new Mesh(new OctahedronGeometry(size, 0), this.mat);
    this.halo = new Mesh(
      new RingGeometry(size * 1.3, size * 1.9, 16),
      new MeshBasicMaterial({ color: RUNE_IDLE.clone().multiplyScalar(0.5), transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.mesh.add(this.halo);
    this.mesh.visible = false;
  }

  onHit(info: HitInfo) {
    this.boss.queueHit(this, info);
  }
}

/** The stone body: a target that sits on the surface point nearest to the player (chip damage). */
class StoneBody implements Hittable {
  readonly position = new Vector3();
  readonly radius = 0.35;
  alive = false;
  readonly lockable = false;
  constructor(private readonly boss: Colossus) {}
  onHit(info: HitInfo) {
    this.boss.queueHit(null, info);
  }
}

const tmp = new Vector3();
const tmp2 = new Vector3();
const tmpC = new Color();

// ====================================================================== boss
export class Colossus extends Boss {
  readonly rig: ColossusRig;
  readonly fx: ColossusEffects;
  readonly runes: WeakPoint[];
  readonly stone: StoneBody;
  /** circles the giant's legs can't walk through (arena columns / stair towers) */
  obstacles: { x: number; z: number; r: number }[] = [];
  private readonly queue: { wp: WeakPoint | null; info: HitInfo }[] = [];
  private readonly glowMat = new MeshBasicMaterial({ color: new Color(2.4, 1.3, 0.4), toneMapped: false });
  private readonly cracks: Mesh[] = [];
  private rubble: Rubble | null = null;
  private onBodyTime = 0;
  /** seconds since the player last STOOD (grounded, not hanging) on our body */
  private sinceStood = 99;
  private greatTollTimer = 0;
  private tollCd = 0;
  private bodyCd = 0;
  private lastBodyMove = '';
  private prevState = '';
  private runeT = 0;
  private hints = new Set<string>();
  private clangCd = 0;

  constructor(game: Game) {
    const rig = new ColossusRig();
    super(game, ColossusDef, rig as unknown as CharacterModel);
    this.rig = rig;
    this.fx = new ColossusEffects(game, this);
    this.fx.onRockLand = (at) => {
      playSfx('stoneShatter', { pos: at });
      this.shakeFrom(at, 0.35, 18);
    };

    // bell eye slit + glowing mouth (telegraph colour), added after the base cloned the materials
    const eye = new Mesh(new BoxGeometry(1.5, 0.22, 0.2), this.glowMat);
    eye.position.set(0, 1.25, BELL_R * 0.76);
    rig.bellGroup.add(eye);
    const mouth = new Mesh(new RingGeometry(0.2, BELL_R * 0.95, 14), this.glowMat);
    mouth.rotation.x = Math.PI / 2;
    mouth.position.y = 0.06;
    rig.bellGroup.add(mouth);
    // phase-3 cracks: glowing seams down the bell
    const crackMat = new MeshBasicMaterial({ color: new Color(3.2, 1.5, 0.45), toneMapped: false });
    for (const [a, h, tilt] of [[0.5, 1.6, 0.35], [2.4, 1.3, -0.4], [4.1, 1.8, 0.2]] as const) {
      const c = new Mesh(new BoxGeometry(0.08, h, 0.08), crackMat);
      const r = BELL_R * 0.8;
      c.position.set(Math.sin(a) * r, 0.5 + h / 2, Math.cos(a) * r);
      c.rotation.set(0, a, tilt);
      c.visible = false;
      rig.bellGroup.add(c);
      this.cracks.push(c);
    }

    const s = Difficulty.bossHealth();
    this.runes = [
      new WeakPoint(this, 'kneeL', 60 * s, 0.38),
      new WeakPoint(this, 'kneeR', 60 * s, 0.38),
      new WeakPoint(this, 'wrist', 70 * s, 0.38),
      new WeakPoint(this, 'back', 80 * s, 0.42),
      new WeakPoint(this, 'core', 1, 0.62),
    ];
    for (const r of this.runes) {
      game.scene.add(r.mesh);
      game.world.targets.push(r);
    }
    this.stone = new StoneBody(this);
    game.world.targets.push(this.stone);

    rig.onFootfall = (_side, at) => this.footfall(at);
    rig.onMark = (name) => this.mark(name);
    this.model.play('buried', { fade: 0 });
  }

  // ==================================================================== queries
  /** The player stands on / hangs from one of our blocks. */
  playerOnBody() {
    const p = this.game.player;
    return ColossusRig.isOwnTag((p.attached ?? p.platform)?.tag);
  }

  private hint(key: string, text: string, seconds = 2.6) {
    if (this.hints.has(key)) return;
    this.hints.add(key);
    this.game.hud.flash(text, seconds);
  }

  /** Camera shake that falls off with distance from the player. */
  shakeFrom(at: Vector3, amount: number, falloff = 30) {
    const d = at.distanceTo(this.game.player.position);
    const k = Math.max(0, 1 - d / falloff);
    if (k > 0.02) this.game.cam.shake(amount * k * k);
  }

  bellCenter(out: Vector3) {
    return this.rig.toWorld(tmp2.copy(this.rig.bellBase).setY(this.rig.bellBase.y + 1.2), out);
  }

  // ==================================================================== lifecycle hooks
  protected override onEngage() {
    this.model.play('rise', { fade: 0, restart: true });
    this.rig.resetMotion();
    this.hints.clear();
    playSfx('rumble', { pos: this.position });
    this.game.cam.shake(0.6);
  }

  protected override onReset() {
    this.rubble?.dispose();
    this.rubble = null;
    this.fx.clear();
    this.model.play('buried', { fade: 0 });
    this.rig.shudder = 0;
    this.rig.ring = 0;
    this.rig.resetMotion();
    this.onBodyTime = 0;
    this.greatTollTimer = 0;
    this.tollCd = 0;
    this.bodyCd = 0;
    this.queue.length = 0;
    const s = Difficulty.bossHealth();
    for (const r of this.runes) {
      r.maxHp = r.id === 'wrist' ? 70 * s : r.id === 'back' ? 80 * s : 60 * s;
      this.rearmRune(r);
    }
    for (const c of this.cracks) c.visible = false;
  }

  protected override onPhaseEnter(phase: number) {
    this.fx.clear();
    this.rig.shudder = 0;
    if (phase === 1) {
      this.game.hud.flash('The Colossus trembles — it will shake you off', 2.6);
    } else if (phase === 2) {
      for (const c of this.cracks) c.visible = true;
      playSfx('bellCrack', { pos: this.position });
      this.game.hud.flash('The bell cracks — its toll will sweep the whole ruin', 2.8);
      this.greatTollTimer = 5;
    }
  }

  protected override onDefeated() {
    this.fx.clear();
    this.rig.shudder = 0;
    this.rubble?.dispose();
    this.rubble = this.rig.collapse(this.game.scene);
    this.rubble.onBellLand = (at) => {
      playSfx('bellFall', { pos: at });
      this.game.cam.shake(0.9);
      this.game.fx.slam(at, 5);
    };
    this.rubble.onPieceLand = (at, big) => {
      if (big) this.shakeFrom(at, 0.25, 25);
      this.game.fx.dustPuff(at, big ? 14 : 6, 2.5);
    };
    playSfx('stoneShatter', { pos: this.position, intensity: 1.4 });
    this.rig.root.visible = false;
    this.rig.attach(this.game.world, false);
    for (const r of this.runes) {
      r.alive = false;
      r.mesh.visible = false;
    }
    this.stone.alive = false;
  }

  /** Wind-up start of every step: custom telegraphs. */
  override beginTelegraph(def: AttackDef, step: number, kind: TelegraphKind, windup: number, flash: boolean) {
    super.beginTelegraph(def, step, kind, windup, flash);
    if (def.id === 'debris') this.spawnDebris(windup);
    if (def.id === 'shakeoff') {
      playSfx('rumble', { pos: this.position });
      if (this.playerOnBody()) this.hint('shake', 'It shudders — HANG from a ledge or jump clear!');
    }
    if (def.id === 'greatToll') this.hint('gtoll', 'Cracked Toll — jump the rings or take the high ground', 2.4);
  }

  protected override onAttackStep(def: AttackDef, _step: number, phase: 'active' | 'recovery') {
    if (phase !== 'active') return;
    const bell = this.bellCenter(tmp);
    switch (def.id) {
      case 'toll':
        this.fx.wave(bell, { speed: 12, max: 15, damage: 12, knockback: 13 });
        this.toll(bell, 1);
        break;
      case 'greatToll':
        this.toll(bell, 1.4);
        break;
      case 'shakeoff':
        this.shakeOff();
        break;
      case 'slam':
      case 'leap':
        playSfx('slam', { pos: this.rig.toWorld(tmp2.copy(this.rig.hamHead)) });
        playSfx('colossusStep', { pos: this.position, intensity: 1.2 });
        if (def.id === 'slam') this.hint('ramp', 'The hammer rests — climb it to the rune on its fist', 2.2);
        break;
      default:
        break;
    }
  }

  // ==================================================================== mechanics
  private toll(at: Vector3, intensity: number) {
    this.rig.ring = 1;
    playSfx('bellToll', { pos: at, intensity, variant: intensity > 1.2 ? 'great' : '' });
    this.game.fx.waves.spawn(at, 6, TelegraphColors.magic, 0.6, 0.3);
    this.shakeFrom(at, 0.5 * intensity, 40);
  }

  private mark(name: string) {
    if (!this.engaged && name !== 'kneel') return;
    if (name === 'toll' || name === 'toll2') this.toll(this.bellCenter(tmp), name === 'toll2' ? 1.4 : 1);
    if (name === 'kneel') {
      playSfx('colossusStep', { pos: this.position, intensity: 1.3 });
      this.game.fx.slam(this.feet, 5);
      this.shakeFrom(this.feet, 0.6);
    }
  }

  private footfall(at: Vector3) {
    if (!this.engaged || this.state === 'dead') return;
    const big = this.state === 'attack';
    playSfx('colossusStep', { pos: at, intensity: big ? 1.1 : 0.7 });
    this.game.fx.dustPuff(at, big ? 16 : 8, big ? 3.5 : 2.2, [0.4, 0.9]);
    this.shakeFrom(at, big ? 0.45 : 0.28, 32);
  }

  private shakeOff() {
    const p = this.game.player;
    if (p.dead) return;
    // standing on it this frame or a moment ago (the jerk itself can drop you a frame early)
    const standing = this.sinceStood < 0.3 && p.state !== 'ledgehang' && p.state !== 'ledgeclimb' && p.velocity.y < 3;
    if (!standing) {
      if (this.playerOnBody()) this.hint('held', 'You held on!', 1.4);
      return;
    }
    const from = this.rig.toWorld(tmp2.copy(this.rig.torsoC));
    from.y = p.position.y;
    const res = this.hitPlayer({
      damage: this.runner.step?.damage ?? 16, knockback: 13, heavy: true, telegraph: 'unblockable', parryable: false, unblockable: true, from,
    });
    if (res === 'hit') p.velocity.y = 7.5;
  }

  private spawnDebris(windup: number) {
    const n = this.phase >= 2 ? 7 : 5;
    const p = this.game.player.position;
    const dmg = 20;
    // the first rock falls where you stand; the rest around the giant
    this.fx.rock(p.x, p.z, windup + 0.6, 1.9, dmg);
    for (let i = 1; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 3 + Math.random() * 8;
      tmp.set(this.feet.x + Math.sin(a) * d, 0, this.feet.z + Math.cos(a) * d);
      if (this.arena) {
        const r = this.arena.region;
        const dd = Math.hypot(tmp.x - r.x, tmp.z - r.z);
        if (dd > r.radius - 2) {
          tmp.x = r.x + ((tmp.x - r.x) / dd) * (r.radius - 2);
          tmp.z = r.z + ((tmp.z - r.z) / dd) * (r.radius - 2);
        }
      }
      this.fx.rock(tmp.x, tmp.z, windup + 0.6 + i * 0.28, 1.7, dmg);
    }
  }

  // ==================================================================== AI
  override decide(ctx: DirectorContext): Decision {
    // Phase 3: the cracked bell tolls across the whole arena on a timer.
    if (this.phase >= 2 && this.greatTollTimer <= 0) {
      this.greatTollTimer = 15 + Math.random() * 3;
      return { attack: 'greatToll' };
    }
    // Climbers: answer after a moment (never instantly — reaching a rune must be possible).
    if (this.onBodyTime > 1.8 && this.bodyCd <= 0) {
      const p = this.game.player;
      this.bodyCd = 3.5;
      if (this.phase === 0) {
        if (this.tollCd <= 0) {
          this.tollCd = 7;
          return { attack: 'toll' };
        }
        return null;
      }
      const hanging = p.state === 'ledgehang' || p.state === 'ledgeclimb';
      let pick = hanging ? 'swat' : Math.random() < 0.6 ? 'shakeoff' : 'swat';
      if (pick === this.lastBodyMove && Math.random() < 0.5) pick = pick === 'swat' ? 'shakeoff' : 'swat';
      if (this.tollCd <= 0 && Math.random() < 0.25) {
        this.tollCd = 7;
        pick = 'toll';
      }
      this.lastBodyMove = pick;
      return { attack: pick };
    }
    void ctx;
    return null;
  }

  override clampToArena(v: Vector3) {
    for (const o of this.obstacles) {
      const dx = v.x - o.x;
      const dz = v.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + 2.4;
      if (d < min && d > 1e-4) {
        v.x = o.x + (dx / d) * min;
        v.z = o.z + (dz / d) * min;
      }
    }
    const a = this.arena;
    if (!a) return v;
    const r = a.region.radius - 5;
    const dx = v.x - a.region.x;
    const dz = v.z - a.region.z;
    const d = Math.hypot(dx, dz);
    if (d > r) {
      v.x = a.region.x + (dx / d) * r;
      v.z = a.region.z + (dz / d) * r;
    }
    return v;
  }

  override hitPlayer(spec: BossHitSpec): HitResult {
    const p = this.game.player;
    // slide under the low hammer sweep
    if (this.state === 'attack' && this.runner.def?.id === 'sweep' && p.state === 'slide') return 'dodged';
    return super.hitPlayer(spec);
  }

  override stagger(duration: number, cause: 'poise' | 'parry' | 'counter' | 'reflect' | 'custom', riposte: boolean) {
    this.fx.clear();
    this.rig.shudder = 0;
    super.stagger(riposte ? duration * Difficulty.recovery() : duration, cause, riposte);
    if (riposte) this.hint('core', 'It kneels — strike the BELL CORE in its chest!', 2.6);
  }

  // ==================================================================== damage model
  override onHit(info: HitInfo) {
    this.queueHit(null, info);
  }

  /** @internal targets queue hits; one swing touching stone + rune counts once, as the rune. */
  queueHit(wp: WeakPoint | null, info: HitInfo) {
    this.queue.push({ wp, info });
  }

  private resolveHits() {
    const q = this.queue;
    if (!q.length) return;
    const fight = this.alive && this.engaged && this.state !== 'dormant' && this.state !== 'dead';
    if (!fight) {
      q.length = 0;
      return;
    }
    if (this.invulnerable) {
      this.game.hud.damageNumber(this.position.clone().setY(this.feet.y + this.def.height + 0.3), 'Immune' as unknown as number, false);
      q.length = 0;
      return;
    }
    const core = q.find((h) => h.wp?.id === 'core');
    if (core && this.riposteOpen && core.info.source !== 'echo' && this.facingRune(core.wp!)) {
      q.length = 0;
      this.riposte();
      playSfx('bellCrack', { pos: core.wp!.position });
      return;
    }
    // one swing strikes ONE rune (the nearest it touched), never stone + rune
    const pp = this.game.player.position;
    let rune: { wp: WeakPoint; info: HitInfo } | null = null;
    let best = Infinity;
    for (const h of q) {
      if (!h.wp || h.wp.id === 'core' || !h.wp.alive || !this.facingRune(h.wp)) continue;
      const d = h.wp.position.distanceToSquared(pp);
      if (d < best) {
        best = d;
        rune = { wp: h.wp, info: h.info };
      }
    }
    if (rune) this.damageRune(rune.wp, rune.info);
    else if (this.alive) {
      let best = q[0].info;
      for (const h of q) if (h.info.damage > best.damage) best = h.info;
      this.chip(best);
    }
    q.length = 0;
  }

  /** The player strikes the rune from its side (a calf rune can't be hit through the shin). */
  private facingRune(w: WeakPoint) {
    if (!w.normal) return true;
    const p = this.game.player.position;
    const dx = p.x - w.position.x;
    const dz = p.z - w.position.z;
    const d = Math.hypot(dx, dz) || 1;
    return (dx * w.normal.x + dz * w.normal.z) / d > -0.15;
  }

  private chip(info: HitInfo) {
    if (info.move === 'riposte') return;
    const raw = info.damage * (info.source === 'echo' ? this.def.echoDamageMul ?? 0.6 : 1);
    const dmg = Math.max(1, Math.round(raw * 0.1 * (this.vulnerable ? 1.5 : 1)));
    const at = tmp.copy(this.stone.alive ? this.stone.position : this.position);
    this.applyDamage(dmg, false, false, at.clone(), info.dir);
    this.game.fx.sparks.emit({
      count: 18, position: at, spread: 0.15, speed: 6, upBias: 0.4, life: [0.1, 0.35], size: [0.04, 0.09],
      color: new Color(2.4, 2.0, 1.4), gravity: 14, drag: 3,
    });
    if (this.clangCd <= 0) {
      playSfx('stoneClang', { pos: at });
      this.clangCd = 0.08;
    }
    if (this.alive && this.state !== 'stagger' && this.state !== 'knockdown') this.addPoise(dmg * 1.2, 'poise');
    this.hint('stone', 'Steel barely scratches the stone — strike its glowing runes', 2.6);
  }

  private damageRune(wp: WeakPoint, info: HitInfo) {
    const raw = info.damage * (info.source === 'echo' ? this.def.echoDamageMul ?? 0.6 : 1);
    const dmg = Math.max(1, Math.round(raw * 1.5 * (this.vulnerable ? 1.3 : 1)));
    wp.hp -= raw;
    this.applyDamage(dmg, true, false, wp.position.clone(), info.dir);
    this.game.fx.sparks.emit({
      count: 26, position: wp.position, spread: 0.2, speed: 7, upBias: 0.3, life: [0.15, 0.5], size: [0.06, 0.14],
      color: RUNE_IDLE, color2: new Color(3, 0.9, 0.2), gravity: 6, drag: 2,
    });
    if (!this.alive) return;
    const reacting = this.state === 'stagger' || this.state === 'knockdown' || this.state === 'transition';
    if (!reacting) this.addPoise(raw * 0.3 + 3, 'poise');
    if (wp.hp <= 0) this.breakRune(wp);
  }

  private breakRune(wp: WeakPoint) {
    wp.broken = true;
    wp.alive = false;
    wp.lockable = false;
    wp.rearm = 22;
    playSfx('stoneShatter', { pos: wp.position, intensity: 1.2 });
    this.game.fx.sparks.emit({
      count: 70, position: wp.position, spread: 0.3, speed: 10, upBias: 0.5, life: [0.3, 0.9], size: [0.06, 0.18],
      color: RUNE_IDLE, color2: new Color(3, 0.6, 0.1), gravity: 10, drag: 2,
    });
    this.game.fx.dustPuff(wp.position, 20, 4);
    this.game.hitstop(0.1);
    this.game.cam.shake(0.5);
    const reacting = this.state === 'stagger' || this.state === 'knockdown' || this.state === 'transition' || this.state === 'dead';
    if (reacting) return;
    this.addPoise(32, 'custom');
    if (this.state !== 'stagger') {
      // the broken limb buckles: the current attack is cancelled
      this.fx.clear();
      this.rig.shudder = 0;
      this.runner.cancel();
      this.go('recoil', 1.3);
      this.hint('broke', 'A rune shatters! Break another to bring it to its knees', 2.4);
    }
  }

  private rearmRune(r: WeakPoint) {
    r.broken = false;
    r.hp = r.maxHp;
    r.rearm = 0;
  }

  // ==================================================================== frame
  override update(dt: number) {
    const world = this.game.world;
    this.rig.attach(world, false); // our own blocks must not push / carry ourselves
    super.update(dt);
    if (this.state !== 'dead') this.rig.attach(world, true);
    this.fx.update(dt);
    this.resolveHits();
    this.updateTargets(dt);
    if (this.rubble) this.rubble.update(dt, (x, z) => world.terrain.heightAt(x, z));
    this.clangCd -= dt;
  }

  protected override onUpdate(dt: number) {
    // timers
    this.greatTollTimer -= this.state === 'idle' || this.state === 'attack' ? dt : 0;
    this.tollCd -= dt;
    this.bodyCd -= dt;
    this.onBodyTime = this.playerOnBody() ? this.onBodyTime + dt : 0;
    const pl = this.game.player;
    this.sinceStood = pl.grounded && !pl.attached && ColossusRig.isOwnTag(pl.platform?.tag) ? 0 : this.sinceStood + dt;

    // shake-off: the body shudders harder as the windup runs out
    const r = this.runner;
    if (this.state === 'attack' && r.def?.id === 'shakeoff') {
      const u = r.phase === 'windup' ? r.phaseTime / Math.max(0.1, r.windup) : r.phase === 'active' ? 1 : Math.max(0, 1 - r.phaseTime / 0.6);
      this.rig.shudder = u;
      if (r.phase === 'windup' && Math.random() < 0.5) {
        const y = 2 + Math.random() * 8;
        this.game.fx.dustPuff(tmp.set(this.feet.x + (Math.random() - 0.5) * 4, this.feet.y + y, this.feet.z + (Math.random() - 0.5) * 3), 3, 1.2);
      }
    } else if (this.rig.shudder > 0) {
      this.rig.shudder = Math.max(0, this.rig.shudder - dt * 3);
    }

    // re-arm runes after a kneel, or on their timer
    const st = this.state;
    if ((this.prevState === 'stagger' || this.prevState === 'knockdown') && st !== 'stagger' && st !== 'knockdown') {
      for (const w of this.runes) if (w.broken) this.rearmRune(w);
    }
    this.prevState = st;
    for (const w of this.runes) {
      if (w.broken && (w.rearm -= dt) <= 0) this.rearmRune(w);
    }
  }

  /** Rune / stone target placement + visuals. */
  private updateTargets(dt: number) {
    this.runeT += dt;
    const rig = this.rig;
    const fight = this.alive && this.engaged && this.state !== 'dormant' && this.state !== 'intro';
    const tw = rig.twist;
    const twv = (x: number, y: number, z: number, out: Vector3) =>
      out.set(x * Math.cos(tw) + z * Math.sin(tw), y, -x * Math.sin(tw) + z * Math.cos(tw));
    const orbit = this.phase >= 2;
    for (const w of this.runes) {
      let enabled = fight;
      switch (w.id) {
        case 'kneeL':
        case 'kneeR': {
          const knee = w.id === 'kneeL' ? rig.kneeL : rig.kneeR;
          const ank = w.id === 'kneeL' ? rig.ankleL : rig.ankleR;
          // on the back of the calf, a third of the way down the shin; orbits the leg in phase 3
          const a = orbit ? this.runeT * 0.8 * (w.id === 'kneeL' ? 1 : -1) : 0;
          tmp.lerpVectors(knee, ank, 0.25);
          tmp.x += Math.sin(a) * 0.72;
          tmp.z += -Math.cos(a) * 0.72;
          w.normal!.set(Math.sin(a), 0, -Math.cos(a));
          break;
        }
        case 'wrist':
          tmp.copy(rig.handR).y += 0.7;
          break;
        case 'back':
          twv(0, 0.9, -1.1, tmp).add(rig.torsoC);
          twv(0, 0, -1, w.normal!);
          enabled = enabled && this.phase >= 2;
          break;
        case 'core':
          twv(0, 0.3, 1.1, tmp).add(rig.torsoC);
          twv(0, 0, 1, w.normal!);
          enabled = this.alive && this.riposteOpen;
          break;
      }
      rig.toWorld(tmp, w.position);
      if (w.normal) {
        // body space → world (yaw only)
        const f = this.facing;
        const nx = w.normal.x * Math.cos(f) + w.normal.z * Math.sin(f);
        const nz = -w.normal.x * Math.sin(f) + w.normal.z * Math.cos(f);
        w.normal.set(nx, 0, nz);
      }
      const visible = this.alive && this.state !== 'dormant' && (w.id === 'core' ? enabled : w.id === 'back' ? this.phase >= 2 : true);
      w.alive = enabled && !w.broken;
      // runes are lock-on targets only up close and from their side (the body is the default lock)
      w.lockable = w.alive && w.position.distanceTo(this.game.player.position) < 6.5 && this.facingRune(w);
      w.mesh.visible = visible && rig.root.visible;
      w.mesh.position.copy(w.position);
      const pulse = 1 + 0.15 * Math.sin(this.runeT * (w.id === 'core' ? 9 : 4) + w.position.x);
      w.mesh.scale.setScalar(w.broken ? 0.6 : pulse);
      w.mesh.rotation.y += dt * 1.5;
      if (w.broken) w.mat.color.copy(RUNE_DEAD);
      else w.mat.color.copy(w.id === 'core' ? CORE : RUNE_IDLE).multiplyScalar(0.8 + 0.2 * pulse);
      w.halo.visible = !w.broken;
      // halo faces the camera
      w.halo.quaternion.copy(this.game.cam.camera.quaternion);
      w.halo.quaternion.premultiply(tmpQinv(w.mesh));
    }

    // stone body proxy: the block surface nearest the player's chest
    const s = this.stone;
    s.alive = false;
    if (fight && rig.attached) {
      const p = this.game.player.position;
      const cy = p.y + 1;
      let best = Infinity;
      for (const b of rig.blocks) {
        const c = b.col;
        if (c.top < -900) continue;
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const cs = Math.cos(c.yaw);
        const sn = Math.sin(c.yaw);
        const lx = Math.max(-c.hx, Math.min(c.hx, dx * cs - dz * sn));
        const lz = Math.max(-c.hz, Math.min(c.hz, dx * sn + dz * cs));
        const wx = c.x + lx * cs + lz * sn;
        const wz = c.z - lx * sn + lz * cs;
        const wy = Math.max(c.bottom, Math.min(c.top, cy));
        const d = Math.hypot(wx - p.x, wy - cy, wz - p.z);
        if (d < best) {
          best = d;
          s.position.set(wx, wy, wz);
        }
      }
      s.alive = best < 4.5;
    }
  }

  protected override syncVisual(dt: number) {
    super.syncVisual(dt);
    const c = this.glowMat.color;
    if (this.state === 'dead') c.setRGB(0, 0, 0);
    else if (this.state === 'dormant') c.setRGB(0.25, 0.14, 0.05);
    else if (this.state === 'stagger') c.copy(CORE).multiplyScalar(0.4 + 0.3 * Math.sin(this.stateTime * 14));
    else c.copy(this.def.eyeColor!).lerp(tmpC.copy(TelegraphColors[this.glowKind]).multiplyScalar(1.6), this.glow);
  }

  override dispose() {
    this.rig.attach(this.game.world, false);
    this.rubble?.dispose();
    this.fx.clear();
    for (const r of this.runes) {
      this.game.scene.remove(r.mesh);
      const i = this.game.world.targets.indexOf(r);
      if (i >= 0) this.game.world.targets.splice(i, 1);
    }
    const i = this.game.world.targets.indexOf(this.stone);
    if (i >= 0) this.game.world.targets.splice(i, 1);
    super.dispose();
  }
}

/** inverse of a mesh's own rotation (so a child can be oriented in world space) */
const qTmp = new Quaternion();
function tmpQinv(m: Mesh) {
  return qTmp.copy(m.quaternion).invert();
}
