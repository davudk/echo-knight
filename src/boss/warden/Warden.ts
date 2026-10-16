import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { lockOn } from '../../camera/LockOn';
import { Tuning } from '../../config/tuning';
import { events } from '../../core/Events';
import type { Game } from '../../core/Game';
import { angleDelta, clamp } from '../../core/math';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitResult } from '../../player/Player';
import type { HitInfo } from '../../world/World';
import type { BossArena } from '../Arena';
import { Boss, type BossDef } from '../Boss';
import { TelegraphColors, type Decal } from '../Decals';
import { Difficulty } from '../difficulty';
import type { Decision, DirectorContext, DirectorEntry, IdleMode } from '../Director';
import type { BossHitSpec } from '../Hitboxes';
import type { AttackDef, TelegraphKind } from '../types';
import { WardenAttacks, baseId } from './attacks';
import type { KeepLayout } from './Keep';
import { playWardenSfx } from './sounds';
import { VoidFlood } from './VoidFlood';
import { VOID, VOID_BRIGHT, WardenEcho, type EchoMaster } from './WardenEcho';

/**
 * THE HOLLOW WARDEN — the dark mirror of the player: a giant hollow knight who learned the echo.
 *
 *  Phase 1  The Knight   (100–70 %)  slow, heavy, readable: Hollow Rend (delayed 3rd hit — parry it
 *                                     to stagger him) and its quick / short variants, Cleave, Hollow
 *                                     Slam (+ shockwave ring: jump), Hollow Lance (11 m thrust lunge),
 *                                     Hollow Grasp (red grab → slam), Rampart Charge, Turning Reap
 *                                     (behind him), Rising Cut / Hollow Pursuit vs. high ground.
 *  Phase 2  The Echo     (70–40 %)   + Leave an Echo → Echo Ambush (recalls to it mid-combo),
 *                                     Echo mimicry (a hologram repeats his attack ~1 s later from your
 *                                     flank), Mirror Swap (lock on to him → he trades places with an
 *                                     echo behind you, lock-on breaks), Echoing Slam (two rings).
 *                                     Hitting / parrying any echo shatters it and poise-damages him.
 *  Phase 3  Unbound      (40–15 %)   faster copies of everything (`_u`), Void Reap (low arc: jump),
 *                                     Void Rays (low: jump, high: slide / roll), the courtyard floods
 *                                     with void in waves (high ground + echo platforms), he leaps
 *                                     after you onto the high ground (knock him out of the air).
 *  Desperation (< 15 %)              Echo Storm: three echoes strike in a fixed, lit-up order;
 *                                     perfect-dodge one (witch time) or shatter all three → long
 *                                     stagger → cinematic EXECUTION finisher.
 */

const H = Tuning.player.height * 2.5; // ≈ 4.6 m

const W = (c: DirectorContext) => c.boss as Warden;
/** Unbound-phase entries: same as phase 1/2 but using the `_u` ids. */
const U = (e: DirectorEntry): DirectorEntry => ({
  ...e,
  attack: `${e.attack}_u`,
  followUps: e.followUps?.map((f) => ({ ...f, attack: f.attack.endsWith('_u') ? f.attack : `${f.attack}_u` })),
});

const knightMoves: DirectorEntry[] = [
  { attack: 'rend', weight: 3, range: [0, 5.2], cooldown: 3 },
  { attack: 'rendQuick', weight: 1.6, range: [0, 5.2], cooldown: 4 },
  { attack: 'rend2', weight: 1.4, range: [0, 5.0] },
  { attack: 'cleave', weight: 2.2, range: [0, 5.4], followUps: [{ attack: 'turnSweep', chance: 0.25, range: [0, 5] }] },
  { attack: 'thrust', weight: 2.4, range: [5.5, 14], cooldown: 4 },
  { attack: 'grab', weight: 1.1, range: [0, 3.8], cooldown: 8, player: 'grounded' },
  { attack: 'charge', weight: 1.5, range: [4, 10], cooldown: 6 },
  { attack: 'turnSweep', weight: 4, range: [0, 5.4], angle: 'behind' },
  { attack: 'turnSweep', weight: 2, range: [0, 5.4], angle: 'side' },
  { attack: 'heaven', weight: 4, range: [0, 6.5], player: 'above', angle: 'any', cooldown: 3 },
  { attack: 'heaven', weight: 2, range: [0, 6], player: 'airborne', cooldown: 4 },
];

export const WardenDef: BossDef = {
  id: 'warden',
  name: 'The Hollow Warden',
  title: 'Echo of the Keep',
  maxHealth: 1300,
  radius: 1.2,
  height: H,
  phases: [
    { threshold: 1, name: 'The Knight' },
    { threshold: 0.7, name: 'The Echo', transition: { duration: 2.4, clip: 'Cheer', speed: 0.8, shake: 0.7 } },
    { threshold: 0.4, name: 'Unbound', transition: { duration: 2.6, clip: 'Spellcast_Raise', speed: 0.8, shake: 0.9 } },
    { threshold: 0.15, name: 'Desperation', transition: { duration: 2.4, clip: 'Cheer', speed: 0.6, shake: 1.0 } },
  ],
  poise: { max: 140, regen: 10, regenDelay: 3.5, damageMul: 0.8, staggerTime: 2.6, vulnerableMul: 1.4 },
  parryPoise: 30,
  counterPoise: 42,
  onParry: 'recoil',
  riposte: { damage: 120, range: 3.0, arcDeg: 150, knockdown: 2.2 },
  speeds: { walk: 2.1, run: 5.6, strafe: 1.9, back: 1.7, turn: 3.0 },
  trackRate: { windup: 3.5, active: 0, recovery: 0.8 },
  anims: {
    idle: '2H_Melee_Idle', walk: 'Walking_A', run: 'Running_A', strafeLeft: 'Running_Strafe_Left', strafeRight: 'Running_Strafe_Right',
    back: 'Walking_Backwards', roar: 'Cheer', stagger: 'Hit_B', recoil: 'Hit_A', knockdown: 'Lie_StandUp', death: 'Death_B',
  },
  attacks: WardenAttacks,
  director: {
    phases: [
      {
        // The Knight: deliberate, readable.
        aggression: 0.4,
        idleTime: [0.6, 1.8],
        preferredRange: [3.5, 7],
        attacks: [
          ...knightMoves,
          { attack: 'slam', weight: 1.6, range: [3, 9], cooldown: 6 },
          { attack: 'pursuit', weight: 2.5, range: [0, 18], player: 'above', angle: 'any', cooldown: 7 },
        ],
        punish: { heal: ['thrust', 'charge', 'cleave'], reaction: 0.35 },
      },
      {
        // The Echo: echoes join in.
        aggression: 0.55,
        idleTime: [0.5, 1.5],
        preferredRange: [3.5, 7],
        attacks: [
          ...knightMoves,
          { attack: 'slam2', weight: 1.6, range: [3, 9], cooldown: 6 },
          { attack: 'plantEcho', weight: 1.8, range: [3.5, 16], cooldown: 9, when: (c) => W(c).canPlant() },
          { attack: 'ambushCombo', weight: 5, range: [0, 5.4], cooldown: 4, when: (c) => W(c).ambushReady() },
          { attack: 'pursuit', weight: 2.5, range: [0, 18], player: 'above', angle: 'any', cooldown: 6 },
        ],
        punish: { heal: ['thrust', 'charge', 'slam2'], reaction: 0.3 },
      },
      {
        // Unbound: everything faster, the floor floods.
        aggression: 0.72,
        idleTime: [0.35, 1.1],
        preferredRange: [3.5, 8],
        attacks: [
          ...knightMoves.map(U),
          { attack: 'slam2_u', weight: 1.4, range: [3, 9], cooldown: 6 },
          { attack: 'reap_u', weight: 2, range: [3, 8.5], cooldown: 5 },
          { attack: 'beamLow_u', weight: 1.6, range: [5, 22], cooldown: 7 },
          { attack: 'beamHigh_u', weight: 1.6, range: [5, 22], cooldown: 7 },
          // while the floor is flooded he presses you on your perch
          { attack: 'beamHigh_u', weight: 3, range: [3, 22], cooldown: 5, when: (c) => W(c).flood.pressing },
          { attack: 'pursuit_u', weight: 3.5, range: [0, 18], player: 'above', angle: 'any', cooldown: 4 },
        ],
        punish: { heal: ['thrust_u', 'charge_u', 'beamLow_u'], reaction: 0.25 },
      },
      {
        // Desperation: Unbound moves + the Echo Storm (forced by decide()).
        aggression: 0.75,
        idleTime: [0.35, 1.0],
        preferredRange: [3.5, 8],
        attacks: [
          ...knightMoves.map(U),
          { attack: 'slam2_u', weight: 1.4, range: [3, 9], cooldown: 6 },
          { attack: 'reap_u', weight: 2, range: [3, 8.5], cooldown: 5 },
          { attack: 'beamLow_u', weight: 1.2, range: [5, 22], cooldown: 8 },
          { attack: 'beamHigh_u', weight: 1.2, range: [5, 22], cooldown: 8 },
          { attack: 'pursuit_u', weight: 3.5, range: [0, 18], player: 'above', angle: 'any', cooldown: 4 },
        ],
        punish: { heal: ['thrust_u', 'charge_u'], reaction: 0.25 },
      },
    ],
  },
  echoDamageMul: 0.6,
  tint: new Color(0.3, 0.29, 0.4),
  eyeColor: new Color(1.0, 0.55, 2.6),
  weapon: '2H_Sword',
  introTime: 3.3,
  chainDelay: 0.12,
};

/** The echoes' def: same moves, no director. */
const EchoDef: BossDef = {
  ...WardenDef,
  id: 'warden-echo',
  name: 'Echo of the Warden',
  director: { phases: [{ attacks: [] }] },
  introTime: 0,
  tint: undefined,
};

/** attacks an echo may repeat (mimicry) */
const MIMIC = new Set(['cleave', 'thrust', 'slam', 'slam2', 'charge', 'reap']);
/** attacks that show a ground path for the lunge */
const PATHS: Record<string, [number, number]> = { thrust: [12.5, 1.7], charge: [8.8, 2.4] };

const tmp = new Vector3();
const tmp2 = new Vector3();
const BEAM_COLOR = new Color(1.0, 0.6, 3.2);

interface StormTurn {
  echo: WardenEcho;
  at: number;
  started: boolean;
  marker: Decal | null;
}

export class Warden extends Boss implements EchoMaster {
  readonly echoes: WardenEcho[];
  readonly flood: VoidFlood;
  /** the planted echo (phase 2 ambush) */
  ambush: WardenEcho | null = null;
  private ambushAge = 0;
  private swapEcho: WardenEcho | null = null;
  private pendingMimic: { t: number; id: string; echo: WardenEcho | null; attackIn: number } | null = null;
  private mimicCd = 0;
  private swapCd = 0;
  private stormCd = 0;
  private lockHeld = 0;
  private forced: string | null = null;
  private storm: { t: number; turns: StormTurn[]; broken: boolean } | null = null;
  private pathDecal: Decal | null = null;
  private chargeDecal: Decal | null = null;
  private readonly beam: Mesh;
  private readonly beamMat: MeshBasicMaterial;
  private beamSound = false;
  private introRoared = false;
  private deathT = -1;
  private readonly off: (() => void)[] = [];
  /** for tests: counts of mechanics that fired */
  readonly stats = { mimic: 0, ambush: 0, swap: 0, storm: 0, shattered: 0, executions: 0, intercepts: 0 };

  constructor(game: Game, model: CharacterModel, echoModels: CharacterModel[], readonly layout: KeepLayout, arenaRadius: number, arena: BossArena) {
    super(game, WardenDef, model);
    arena.addBoss(this);
    // void-blackened greatsword (the telegraph glow is emissive, so it still reads in every colour)
    this.weaponNode?.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) (m.material as MeshStandardMaterial).color.multiply(new Color(0.42, 0.4, 0.58));
    });
    this.echoes = echoModels.map((m) => {
      const e = new WardenEcho(game, EchoDef, m, this);
      e.arena = arena;
      return e;
    });
    this.flood = new VoidFlood(game, layout, arena, arenaRadius - 0.4);

    // the void ray: a glowing rod from the blade, length set per frame
    this.beamMat = new MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    const geo = new CylinderGeometry(1, 1, 1, 8, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, 0.5);
    this.beam = new Mesh(geo, this.beamMat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    game.scene.add(this.beam);

    this.off.push(events.on('player:perfect-dodge', () => {
      if (this.storm && !this.storm.broken && this.state === 'attack') this.breakStorm('Witch time — the storm breaks');
    }));
    this.off.push(events.on('player:died', () => {
      this.flood.stop();
    }));
  }

  override dispose() {
    for (const f of this.off) f();
    for (const e of this.echoes) e.dispose();
    this.flood.dispose();
    this.game.scene.remove(this.beam);
    super.dispose();
  }

  // ==================================================================== director hooks
  canPlant() {
    return !this.ambush && this.echoes.some((e) => !e.active);
  }

  ambushReady() {
    return !!this.ambush && this.ambush.active && this.ambushAge > 2.5;
  }

  override decide(ctx: DirectorContext): Decision {
    if (this.forced) {
      const id = this.forced;
      this.forced = null;
      return { attack: id };
    }
    // Desperation: the storm returns every ~20 s
    if (this.phase >= 3 && this.stormCd <= 0 && ctx.dist < 14 && !ctx.healing) {
      this.stormCd = 20;
      return { attack: 'storm' };
    }
    // Mirror Swap: punish holding lock-on (phase 2+)
    if (this.phase >= 1 && this.swapCd <= 0 && this.lockHeld > 1.0 && ctx.dist > 2.5 && ctx.dist < 10 && !ctx.airborne && Math.random() < 0.025) {
      this.swapCd = 13;
      return { attack: this.phase >= 2 ? 'swap_u' : 'swap' };
    }
    return null;
  }

  /** Approach around pillars instead of grinding into them. */
  override idleMove(mode: IdleMode, dir: 1 | -1, ctx: DirectorContext, dt: number) {
    super.idleMove(mode, dir, ctx, dt);
    if (mode !== 'approach') return;
    const p = this.game.player.position;
    const dx = p.x - this.feet.x;
    const dz = p.z - this.feet.z;
    const d = Math.hypot(dx, dz) || 1;
    for (const pl of this.layout.pillars) {
      const ox = pl.x - this.feet.x;
      const oz = pl.z - this.feet.z;
      const along = (ox * dx + oz * dz) / d;
      if (along < 0 || along > Math.min(4, d)) continue;
      const lat = (ox * -dz + oz * dx) / d; // + = pillar to our left of the path
      if (Math.abs(lat) > 2.4) continue;
      const side = lat > 0 ? -1 : 1;
      const k = 3.5 * (1 - Math.abs(lat) / 2.4);
      this.velocity.x += (-dz / d) * side * k * dt * 8;
      this.velocity.z += (dx / d) * side * k * dt * 8;
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      const max = this.def.speeds.run;
      if (sp > max) {
        this.velocity.x *= max / sp;
        this.velocity.z *= max / sp;
      }
    }
  }

  // ==================================================================== runner hooks
  override beginTelegraph(def: AttackDef, step: number, kind: TelegraphKind, windup: number, flash: boolean) {
    super.beginTelegraph(def, step, kind, windup, flash);
    const id = baseId(def.id);
    if (this.pathDecal) {
      this.pathDecal.release(0.1);
      this.pathDecal = null;
    }
    const path = PATHS[id];
    if (path && step === 0) this.pathDecal = this.game.bosses.decals.acquire().tint(kind);

    // mimicry: an echo repeats this from your flank ~1 s later
    if (step === 0 && this.phase >= 1 && MIMIC.has(id) && this.mimicCd <= 0 && !this.storm) {
      const chance = this.phase === 1 ? 0.5 : 0.35;
      if (Math.random() < chance) {
        this.pendingMimic = { t: 0.4 * Difficulty.telegraph(), id: def.id, echo: null, attackIn: 0 };
        this.mimicCd = 6.5;
      }
    }
    if (id === 'swap' && step === 0) this.beginSwap();
    if (id === 'ambushCombo' && step === 1 && this.ambush) {
      this.chargeDecal = this.game.bosses.decals.acquire().tint('magic');
      this.chargeDecal.circle(this.ambush.feet.x, this.ambush.feet.y, this.ambush.feet.z, 2.2);
      playWardenSfx('wardenEcho', this.ambush.position, 1);
    }
    if (id === 'storm' && step === 0) this.beginStorm();
    if ((id === 'beamLow' || id === 'beamHigh') && step === 0) this.beamSound = false;
  }

  protected override onAttackStep(def: AttackDef, step: number, phase: 'active' | 'recovery') {
    const id = baseId(def.id);
    if (phase === 'active') {
      if (this.pathDecal) {
        this.pathDecal.fill = 1;
        this.pathDecal.flash = 0.5;
        this.pathDecal.release(0.25);
        this.pathDecal = null;
      }
      if (id === 'plantEcho') this.plantEcho();
      if (id === 'ambushCombo' && step === 1) this.recallToAmbush();
      if (id === 'swap' && step === 0) this.doSwap();
      if (id === 'storm') this.storm && (this.storm.t = 0);
      if ((id === 'beamLow' || id === 'beamHigh') && !this.beamSound) {
        this.beamSound = true;
        playWardenSfx('voidBeam', this.position);
      }
    } else if (id === 'storm' && this.storm) {
      // channel over: remaining storm echoes fade
      for (const t of this.storm.turns) if (t.echo.active && !t.echo.attackingNow) t.echo.dismiss();
    }
  }

  // ==================================================================== mechanics
  private freeEcho(): WardenEcho {
    const free = this.echoes.find((e) => !e.active);
    if (free) return free;
    // reuse the least important one (mimic / decoy first, never the ambush)
    const victim = this.echoes.find((e) => e.role !== 'ambush' && e.role !== 'storm') ?? this.echoes[0];
    if (victim === this.ambush) this.ambush = null;
    victim.hide();
    return victim;
  }

  /** A free spot (no collider, inside the arena) near (x, z); tries rotations around (cx, cz). */
  private findSpot(x: number, z: number, cx: number, cz: number, out: Vector3) {
    const L = this.layout;
    const w = this.game.world;
    const a0 = Math.atan2(x - cx, z - cz);
    const r0 = Math.hypot(x - cx, z - cz);
    for (const da of [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6]) {
      for (const rk of [1, 0.75, 1.25]) {
        const r = r0 * rk;
        const px = cx + Math.sin(a0 + da) * r;
        const pz = cz + Math.cos(a0 + da) * r;
        if (Math.abs(px - L.cx) > L.half - 1.4 || Math.abs(pz - L.cz) > L.half - 1.4) continue;
        if (w.pointBlocked(px, L.H + 1.5, pz, 1.1)) continue; // (margin < 1.5: the ground itself doesn't count)
        if (Math.hypot(px - this.feet.x, pz - this.feet.z) < 2.8) continue;
        if (this.echoes.some((e) => e.active && Math.hypot(px - e.feet.x, pz - e.feet.z) < 2.6)) continue;
        return out.set(px, L.H, pz);
      }
    }
    return out.set(L.cx, L.H, L.cz);
  }

  private plantEcho() {
    const e = this.freeEcho();
    e.appear(this.feet.x, this.feet.z, this.facing, 'ambush', { life: 18, clip: '2H_Melee_Idle', y: this.feet.y });
    this.ambush = e;
    this.ambushAge = 0;
    playWardenSfx('wardenEcho', this.position);
  }

  private teleportTo(x: number, y: number, z: number, faceToPlayer = true) {
    const from = tmp2.copy(this.position);
    this.feet.set(x, y, z);
    this.velocity.set(0, 0, 0);
    if (faceToPlayer) {
      const p = this.game.player.position;
      this.facing = Math.atan2(p.x - x, p.z - z);
    }
    this.syncPosition();
    this.game.fx.streak(from, tmp.copy(this.position));
    this.game.fx.echoBurst(tmp.copy(this.position), 40, 4);
    this.game.fx.waves.spawn(tmp.copy(this.feet).setY(this.feet.y + 0.1), 3.4, VOID, 0.35, 0.2);
    this.game.cam.shake(0.3);
    playWardenSfx('wardenBlink', this.position);
  }

  private recallToAmbush() {
    this.chargeDecal?.release(0.15);
    this.chargeDecal = null;
    const e = this.ambush;
    if (!e || !e.active) return;
    const { x, y, z } = e.feet;
    e.hide();
    this.ambush = null;
    this.teleportTo(x, y, z);
    this.stats.ambush++;
  }

  private beginSwap() {
    const p = this.game.player.position;
    const dx = p.x - this.feet.x;
    const dz = p.z - this.feet.z;
    const d = Math.hypot(dx, dz) || 1;
    const spot = this.findSpot(p.x + (dx / d) * 4.2, p.z + (dz / d) * 4.2, p.x, p.z, tmp);
    const e = this.freeEcho();
    e.appear(spot.x, spot.z, Math.atan2(p.x - spot.x, p.z - spot.z), 'swap', { life: 6 });
    e.charge = 0;
    this.swapEcho = e;
    playWardenSfx('wardenEcho', e.position);
  }

  private doSwap() {
    const e = this.swapEcho;
    this.swapEcho = null;
    if (!e || !e.active) return;
    const ox = this.feet.x;
    const oy = this.feet.y;
    const oz = this.feet.z;
    const of = this.facing;
    this.teleportTo(e.feet.x, e.feet.y, e.feet.z);
    // the echo takes our old place: a decoy (phase 2) or a second attacker (Unbound)
    e.appear(ox, oz, of, 'decoy', { life: this.phase >= 2 ? 3.5 : 2.8, y: oy });
    if (this.phase >= 2) this.pendingMimic = { t: 0, id: 'cleave_u', echo: e, attackIn: 0.45 };
    if (lockOn.target === this) {
      lockOn.target = null;
      this.game.cam.lockPoint = null;
    }
    this.lockHeld = 0;
    this.stats.swap++;
  }

  private beginStorm() {
    const p = this.game.player.position;
    const base = Math.atan2(this.feet.x - p.x, this.feet.z - p.z) + Math.PI / 3;
    this.storm = { t: -99, turns: [], broken: false };
    const tel = Difficulty.telegraph();
    for (let i = 0; i < 3; i++) {
      const a = base + (i * Math.PI * 2) / 3;
      const spot = this.findSpot(p.x + Math.sin(a) * 6, p.z + Math.cos(a) * 6, p.x, p.z, tmp);
      const e = this.freeEcho();
      if (e === this.ambush) this.ambush = null;
      e.appear(spot.x, spot.z, Math.atan2(p.x - spot.x, p.z - spot.z), 'storm', { life: 9 });
      e.damageMul = 1;
      this.storm.turns.push({ echo: e, at: 0.25 + i * 1.05 * tel, started: false, marker: null });
    }
    this.stats.storm++;
    this.game.hud.flash('Echo Storm', 1.6);
    playWardenSfx('wardenEcho', this.position, 1.2);
  }

  /** perfect dodge / all echoes shattered: the storm collapses, he is open to the execution */
  private breakStorm(text: string) {
    const s = this.storm;
    if (!s || s.broken) return;
    s.broken = true;
    for (const t of s.turns) {
      t.marker?.release(0.1);
      t.marker = null;
      if (t.echo.active) {
        this.game.fx.echoBurst(tmp.copy(t.echo.position), 40, 5);
        t.echo.hide();
      }
    }
    playWardenSfx('wardenShatter', this.position, 1.3);
    this.game.hud.flash(text, 1.8);
    this.stagger(3.4, 'custom', true);
  }

  private updateStorm(dt: number) {
    const s = this.storm;
    if (!s) return;
    if (this.state !== 'attack' && !s.broken) {
      // he was interrupted (poise break): echoes that haven't struck yet fade away
      for (const t of s.turns) if (!t.started && t.echo.active) t.echo.dismiss();
    }
    if (s.broken || (this.state !== 'attack' && s.turns.every((t) => !t.echo.active || !t.echo.attackingNow))) {
      this.endStorm();
      return;
    }
    if (s.t < -50) return; // still winding up
    s.t += dt;
    const tel = Difficulty.telegraph();
    for (const t of s.turns) {
      const e = t.echo;
      if (!e.active || e.role !== 'storm') {
        t.marker?.release(0.1);
        t.marker = null;
        continue;
      }
      const lead = 0.5 * tel;
      if (!t.started && s.t >= t.at - lead) {
        // the next echo lights up: a filling ring under it + a flare
        if (!t.marker) {
          t.marker = this.game.bosses.decals.acquire().tint('parryable');
          t.marker.ring(e.feet.x, e.feet.y, e.feet.z, 1.8, 0.35);
          playWardenSfx('wardenEcho', e.position, 0.6);
        }
        t.marker.fill = clamp((s.t - (t.at - lead)) / lead, 0, 1);
        e.charge = t.marker.fill;
      }
      if (!t.started && s.t >= t.at) {
        t.started = true;
        t.marker?.release(0.3);
        t.marker = null;
        e.charge = 0;
        e.attack('stormLunge');
      }
    }
  }

  private endStorm() {
    if (!this.storm) return;
    for (const t of this.storm.turns) {
      t.marker?.release(0.1);
      if (t.echo.role === 'storm' && t.echo.active) t.echo.dismiss();
      t.echo.damageMul = 0.8;
    }
    this.storm = null;
  }

  // ==================================================================== echo feedback
  onEchoShattered(echo: WardenEcho, cause: 'hit' | 'parry' | 'counter' | 'reflect') {
    this.stats.shattered++;
    playWardenSfx('wardenShatter', echo.position);
    const id = this.runner.def ? baseId(this.runner.def.id) : '';
    let poise = 30;
    if (echo === this.ambush) {
      this.ambush = null;
      poise = 40;
      if (this.state === 'attack' && id === 'ambushCombo' && this.runner.stepIndex <= 1) {
        this.chargeDecal?.release(0.1);
        this.chargeDecal = null;
        this.interrupt(1.1, 'Recall broken');
        poise = 30;
      }
    } else if (echo === this.swapEcho) {
      this.swapEcho = null;
      poise = 40;
      if (this.state === 'attack' && id === 'swap') this.interrupt(1.2, 'Swap broken');
    } else if (echo.role === 'storm' && this.storm) {
      poise = 35;
      if (this.storm.turns.every((t) => !t.echo.active)) {
        this.breakStorm('The storm shatters');
        return;
      }
    }
    if (cause === 'parry' || cause === 'counter') poise += 10;
    if (this.alive && this.state !== 'stagger' && this.state !== 'knockdown' && this.state !== 'transition') this.addPoise(poise, 'custom');
  }

  /** cancel the current attack into a flinch */
  private interrupt(seconds: number, text?: string) {
    this.runner.cancel();
    this.go('recoil', seconds);
    events.emit('boss:stagger', { id: this.id, position: this.position.clone(), duration: seconds, cause: 'custom', riposte: false });
    if (text) this.game.hud.flash(text, 1.2);
  }

  // ==================================================================== damage overrides
  override onHit(info: HitInfo) {
    const wasLeaping = this.state === 'attack' && this.kinematic && baseId(this.runner.def?.id ?? '') === 'pursuit' && this.runner.phase === 'windup';
    const p = this.game.player;
    super.onHit(info);
    // meet him in the air: an aerial hit knocks him out of the pursuit leap
    if (wasLeaping && this.alive && this.state === 'attack' && !p.grounded && info.source !== 'echo' && !this.invulnerable) {
      this.stats.intercepts++;
      this.runner.cancel();
      this.velocity.set(0, -2, 0);
      this.grounded = false;
      this.stagger(1.6, 'custom', false);
      this.addPoise(25, 'custom');
      this.game.hud.flash('Intercepted!', 1.0);
    }
  }

  override hitPlayer(spec: BossHitSpec): HitResult {
    // the high void ray passes over a slide / roll
    const id = this.runner.def ? baseId(this.runner.def.id) : '';
    const p = this.game.player;
    if (id === 'beamHigh' && !spec.projectile && (p.state === 'slide' || p.state === 'dodge') && p.position.y - this.feet.y < 1.0) return 'dodged';
    return super.hitPlayer(spec);
  }

  /** Pursuit: land ON the player's perch (pillar top, wall walk), not on the ground below it. */
  override onLeap(to: Vector3) {
    super.onLeap(to);
    const id = this.runner.def ? baseId(this.runner.def.id) : '';
    if (id !== 'pursuit') return;
    const p = this.game.player.position;
    const w = this.game.world;
    const top = w.groundAt(p.x, p.z, p.y + 0.3);
    if (top - this.layout.H > 0.8) {
      // aim for the perch itself
      to.x = p.x;
      to.z = p.z;
      to.y = top;
    } else {
      to.y = w.groundAt(to.x, to.z, this.feet.y + 0.6);
    }
  }

  /** Desperation: the execution — a bigger, slower, cinematic finisher. */
  protected override riposte() {
    if (this.phase < 3) {
      super.riposte();
      return;
    }
    const { game } = this;
    this.finisherAt = game.time;
    this.riposteOpen = false;
    this.vulnerable = false;
    const dmg = Math.round(this.def.riposte.damage * 1.7);
    game.hitstop(0.32);
    game.slowmo(0.15, 1.5);
    game.cam.shake(1.0);
    game.cam.kickFov(-12);
    game.hud.damageNumber(this.position.clone().setY(this.feet.y + this.def.height + 0.6), 'Execution' as unknown as number, true);
    game.hud.flash('EXECUTION', 1.6);
    game.fx.sparks.emit({
      count: 140, position: tmp.copy(this.position), spread: 0.5, speed: 12, upBias: 0.5, life: [0.3, 1.1], size: [0.06, 0.2],
      color: VOID_BRIGHT, color2: new Color(3, 2.2, 1), gravity: 6, drag: 2,
    });
    game.fx.waves.spawn(tmp.copy(this.feet).setY(this.feet.y + 0.1), 6, VOID_BRIGHT, 0.6, 0.3);
    playWardenSfx('wardenExecution', this.position);
    this.stats.executions++;
    events.emit('boss:riposte', { id: this.id, damage: dmg, position: this.position.clone() });
    this.go('knockdown', (this.def.riposte.knockdown ?? 1.8) + 0.6);
    this.applyDamage(dmg, true, true, tmp.copy(this.position));
  }

  // ==================================================================== lifecycle hooks
  protected override onEngage() {
    this.invulnerable = true;
    this.introRoared = false;
    this.model.play('Sit_Floor_StandUp', { fade: 0.2, loop: false, speed: 0.6, restart: true });
    this.game.hud.flash('The Hollow Warden rises', 2.2);
  }

  protected override onPhaseEnter(phase: number) {
    this.endStorm();
    for (const e of this.echoes) if (e.active && e !== this.ambush) e.dismiss();
    this.pendingMimic = null;
    this.voidBurst(phase >= 2 ? 7 : 5);
    if (phase === 1) {
      this.game.hud.flash('The Warden splits into echoes', 2.2);
      this.burstEchoes(3);
    } else if (phase === 2) {
      this.game.hud.flash('Unbound — the void rises', 2.2);
      if (this.ambush) {
        this.ambush.dismiss();
        this.ambush = null;
      }
      this.flood.start(this.def.phases[2].transition?.duration ?? 2.5);
    } else if (phase === 3) {
      this.game.hud.flash('The Warden’s last stand', 2.2);
      this.flood.stop();
      this.stormCd = 0;
      this.forced = 'storm';
      this.stormCd = 20;
    }
  }

  protected override onReset() {
    for (const e of this.echoes) e.hide();
    this.ambush = null;
    this.swapEcho = null;
    this.storm = null;
    this.pendingMimic = null;
    this.forced = null;
    this.mimicCd = 0;
    this.swapCd = 0;
    this.stormCd = 0;
    this.lockHeld = 0;
    this.deathT = -1;
    this.pathDecal?.release(0.1);
    this.pathDecal = null;
    this.chargeDecal?.release(0.1);
    this.chargeDecal = null;
    this.beam.visible = false;
    this.flood.reset();
  }

  protected override onDefeated() {
    this.flood.stop();
    this.endStorm();
    this.pathDecal?.release(0.1);
    this.pathDecal = null;
    this.chargeDecal?.release(0.1);
    this.chargeDecal = null;
    this.beam.visible = false;
    for (const e of this.echoes) e.hide();
    this.ambush = null;
    this.deathT = 0;
    this.game.hud.flash('The Warden dissolves into echoes', 2.6);
  }

  /** Echo silhouettes bursting outward (phase 2 beat, death). */
  private burstEchoes(n: number, life = 1.2) {
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const e = this.freeEcho();
      const a = base + (i * Math.PI * 2) / n;
      e.appear(this.feet.x, this.feet.z, this.facing + a * 0.3, 'dissolve', { life, y: this.feet.y, clip: i % 2 ? 'Cheer' : '2H_Melee_Idle' });
      e.invulnerable = true;
      e.velocity.set(Math.sin(a) * 5, 2.5, Math.cos(a) * 5);
      e.grounded = false;
    }
  }

  private voidBurst(radius: number) {
    const fx = this.game.fx;
    const at = tmp.copy(this.feet).setY(this.feet.y + 0.1);
    fx.waves.spawn(at, radius, VOID_BRIGHT, 0.6, 0.35);
    fx.waves.spawn(at, radius * 0.6, VOID, 0.45, 0.25);
    fx.sparks.emit({
      count: 90, position: tmp.copy(this.position), spread: 0.8, speed: 9, upBias: 0.6, life: [0.4, 1.0], size: [0.06, 0.18],
      color: VOID_BRIGHT, color2: VOID, gravity: -1, drag: 2,
    });
    playWardenSfx('wardenBlink', this.position, 1.2);
  }

  // ==================================================================== frame
  override update(dt: number) {
    super.update(dt);
    if (this.state === 'dormant' && this.model.currentName !== 'Sit_Floor_Idle') this.model.play('Sit_Floor_Idle', { fade: 0.3 });
    for (const e of this.echoes) e.update(dt);
    this.flood.update(dt);
    if (this.deathT >= 0) this.updateDeath(dt);
  }

  private updateDeath(dt: number) {
    const before = this.deathT;
    this.deathT += dt;
    if (before < 1.6 && this.deathT >= 1.6) {
      this.burstEchoes(3, 1.8);
      this.voidBurst(8);
    }
    if (this.deathT > 1.6 && this.deathT < 4.2 && Math.random() < 0.7) {
      this.game.fx.sparks.emit({
        count: 3, position: tmp.copy(this.feet).setY(this.feet.y + Math.random() * this.def.height), spread: this.radius,
        speed: 1.2, upBias: 1, life: [0.6, 1.3], size: [0.06, 0.16], color: VOID_BRIGHT, color2: VOID, gravity: -3, drag: 1,
      });
    }
    if (this.deathT > 5) this.deathT = -1;
  }

  protected override onUpdate(dt: number) {
    const p = this.game.player;
    this.mimicCd -= dt;
    this.swapCd -= dt;
    this.stormCd -= dt;
    this.lockHeld = lockOn.target === this ? this.lockHeld + dt : 0;

    // intro: rise from kneeling, then roar; immune until the fight proper starts
    if (this.state === 'intro') {
      if (!this.introRoared && this.stateTime > 1.9) {
        this.introRoared = true;
        this.model.play('Cheer', { fade: 0.2, loop: false, speed: 0.9, restart: true });
        this.voidBurst(6);
        this.game.cam.shake(0.5);
        playWardenSfx('bossRoar', this.position, 1.1);
      }
    } else if (this.invulnerable && this.state !== 'transition') {
      this.invulnerable = false;
    }

    // planted echo
    if (this.ambush) {
      this.ambushAge += dt;
      if (!this.ambush.active) this.ambush = null;
    }
    // ambush charge-up: the echo glows as he winds up the recall
    const r = this.runner;
    const id = r.def ? baseId(r.def.id) : '';
    if (this.state === 'attack' && id === 'ambushCombo' && r.stepIndex === 1 && r.phase === 'windup' && this.ambush) {
      const u = clamp(r.phaseTime / Math.max(0.05, r.windup), 0, 1);
      this.ambush.charge = u;
      if (this.chargeDecal) this.chargeDecal.fill = u;
      if (Math.random() < 0.8) {
        this.game.fx.sparks.emit({
          count: 2, position: tmp.copy(this.ambush.feet).setY(this.ambush.feet.y + Math.random() * 5), spread: 0.6, speed: 0.4, upBias: 1,
          life: [0.3, 0.6], size: [0.08, 0.2], color: TelegraphColors.magic, color2: VOID_BRIGHT, gravity: -6, drag: 1,
        });
      }
    }
    // swap: the echo behind you glows as the swap charges
    if (this.swapEcho && this.state === 'attack' && id === 'swap' && r.stepIndex === 0) {
      this.swapEcho.charge = clamp(r.phaseTime / Math.max(0.05, r.windup), 0, 1);
    } else if (this.swapEcho && (this.state !== 'attack' || id !== 'swap')) {
      this.swapEcho.dismiss();
      this.swapEcho = null;
    }
    // lunge path decal
    if (this.pathDecal && this.state === 'attack' && r.phase === 'windup') {
      const path = PATHS[id] ?? [10, 1.6];
      this.pathDecal.rect(this.feet.x, this.feet.y, this.feet.z, this.facing, path[0], path[1]);
      this.pathDecal.fill = clamp(r.phaseTime / Math.max(0.05, r.windup), 0, 1);
    } else if (this.pathDecal && this.state !== 'attack') {
      this.pathDecal.release(0.1);
      this.pathDecal = null;
    }
    if (this.chargeDecal && (this.state !== 'attack' || id !== 'ambushCombo')) {
      this.chargeDecal.release(0.1);
      this.chargeDecal = null;
    }

    // mimicry: spawn the copy, then let it attack
    const m = this.pendingMimic;
    if (m) {
      m.t -= dt;
      if (!m.echo && m.t <= 0) {
        const dx = this.feet.x - p.position.x;
        const dz = this.feet.z - p.position.z;
        const d = clamp(Math.hypot(dx, dz), 4.5, 7.5);
        const side = Math.random() < 0.5 ? 1 : -1;
        const a = Math.atan2(dx, dz) + side * 1.45;
        const spot = this.findSpot(p.position.x + Math.sin(a) * d, p.position.z + Math.cos(a) * d, p.position.x, p.position.z, tmp);
        const e = this.freeEcho();
        e.appear(spot.x, spot.z, Math.atan2(p.position.x - spot.x, p.position.z - spot.z), 'mimic', { life: 5 });
        m.echo = e;
        m.attackIn = 0.35;
        playWardenSfx('wardenEcho', e.position);
      }
      if (m.echo) {
        m.attackIn -= dt;
        if (m.attackIn <= 0) {
          if (m.echo.active) {
            const e = m.echo;
            e.life = 4;
            e.attack(m.id);
            this.stats.mimic++;
          }
          this.pendingMimic = null;
        }
      }
    }
    // mimic / decoy echoes fade once their attack is over
    for (const e of this.echoes) {
      if (e.active && e.role === 'mimic' && e.state === 'custom' && e.stateTime > 0.6 && this.pendingMimic?.echo !== e) e.dismiss();
    }

    this.updateStorm(dt);
    this.updateBeam();

    // void wisps
    if (Math.random() < 0.35) {
      this.game.fx.sparks.emit({
        count: 1, position: tmp.copy(this.feet).setY(this.feet.y + 1 + Math.random() * (this.def.height - 1)), spread: this.radius * 0.7,
        speed: 0.5, upBias: 1, life: [0.5, 1.0], size: [0.05, 0.12], color: VOID, gravity: -2, drag: 1,
      });
    }
  }

  /** Turning Reap: the body spins with the blade (the hitbox sweeps relative to a fixed facing). */
  protected override syncVisual(dt: number) {
    super.syncVisual(dt);
    const r = this.runner;
    if (this.state === 'attack' && r.def && baseId(r.def.id) === 'turnSweep' && r.phase === 'active') {
      const u = clamp(r.phaseTime / Math.max(0.05, r.active), 0, 1);
      this.model.root.rotation.y = this.facing - u * Math.PI * 2; // one full turn, continuous at both ends
    }
  }

  /** The void ray's visible rod (the hitbox is the runner's rotating `line`). */
  private updateBeam() {
    const r = this.runner;
    const id = r.def ? baseId(r.def.id) : '';
    const step = r.step;
    const box = step?.hitboxes[0];
    if (this.state !== 'attack' || (id !== 'beamLow' && id !== 'beamHigh') || !box || box.shape !== 'line' || r.phase === 'recovery') {
      this.beam.visible = false;
      return;
    }
    const low = id === 'beamLow';
    const y = this.feet.y + (low ? 0.35 : 1.55);
    let yaw: number;
    let thick: number;
    let alpha: number;
    if (r.phase === 'windup') {
      // preview: a thin flickering rod at the START angle and the true height
      yaw = this.facing + ((box.yawFrom ?? 0) * Math.PI) / 180;
      const u = clamp(r.phaseTime / Math.max(0.05, r.windup), 0, 1);
      thick = 0.04 + 0.06 * u;
      alpha = (0.35 + 0.5 * u) * (0.6 + 0.4 * Math.sin(this.game.time * 40));
    } else {
      const u = clamp(r.phaseTime / Math.max(0.05, r.active), 0, 1);
      yaw = this.facing + (((box.yawFrom ?? 0) + ((box.yawTo ?? 0) - (box.yawFrom ?? 0)) * u) * Math.PI) / 180;
      thick = box.width * 0.32;
      alpha = 0.95;
      // sparks along the rod at its real height
      const t = Math.random() * box.length;
      this.game.fx.sparks.emit({
        count: 2, position: tmp.set(this.feet.x + Math.sin(yaw) * t, y, this.feet.z + Math.cos(yaw) * t), spread: 0.15, speed: 1.5,
        life: [0.1, 0.3], size: [0.08, 0.2], color: BEAM_COLOR, drag: 3,
      });
    }
    const o = box.offset ?? 0;
    this.beam.visible = true;
    this.beam.position.set(this.feet.x + Math.sin(yaw) * o, y, this.feet.z + Math.cos(yaw) * o);
    this.beam.rotation.set(0, yaw, 0);
    this.beam.scale.set(thick, thick, box.length);
    this.beamMat.opacity = alpha;
    void angleDelta;
  }
}
