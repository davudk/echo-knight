import {
  Box3,
  Color,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SkinnedMesh,
  SphereGeometry,
  Vector3,
} from 'three';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import { angleDelta, clamp, dampAngle } from '../core/math';
import { CharacterModel } from '../player/CharacterModel';
import type { HitResult } from '../player/Player';
import type { HitInfo, Hittable } from '../world/World';

/** Every enemy number in one place (metres, seconds). */
export const EnemyTuning = {
  height: 1.8,
  radius: 0.5,
  maxHealth: 75,
  noticeRange: 12,
  leashRange: 30,
  chaseSpeed: 4.4,
  walkSpeed: 1.5,
  strafeSpeed: 1.9,
  /** distance at which chasing turns into circling */
  engageRange: 2.6,
  strafeRadius: 2.4,
  waitRadius: 3.7,
  gravity: 30,
  /** reduced gravity right after a juggle hit */
  juggleGravity: 11,
  juggleFloat: 0.45,
  juggleHitPop: 2.4,
  guardChance: 0.25,
  respawnDelay: 6,
  parryStagger: 1.2,
  parryBonus: 1.5,
  recover: 0.7,
} as const;

const T = EnemyTuning;

interface AttackDef {
  clip: string;
  /** telegraph (wind-up) duration in seconds; the clip plays 0 → wind during it */
  tele: number;
  wind: number;
  /** clip time of the hit frame / end */
  hit: number;
  end: number;
  speed: number;
  damage: number;
  range: number;
  arcDeg: number;
  knockback: number;
  heavy: boolean;
  lunge: number;
}

const ATTACKS: AttackDef[] = [
  {
    clip: '1H_Melee_Attack_Chop', tele: 0.65, wind: 0.32, hit: 0.52, end: 0.95, speed: 1.15,
    damage: 16, range: 2.3, arcDeg: 100, knockback: 5, heavy: true, lunge: 3.2,
  },
  {
    clip: '1H_Melee_Attack_Slice_Diagonal', tele: 0.55, wind: 0.24, hit: 0.44, end: 0.92, speed: 1.2,
    damage: 13, range: 2.4, arcDeg: 140, knockback: 4, heavy: false, lunge: 2.6,
  },
];

export type EnemyState =
  | 'idle' | 'patrol' | 'return' | 'chase' | 'strafe' | 'telegraph' | 'attack' | 'recover'
  | 'hurt' | 'stagger' | 'block' | 'air' | 'down' | 'dead';

/** Interface the enemy needs from its manager (attack tokens). */
export interface EnemyDirector {
  /** would `requestToken` succeed right now? (no side effects) */
  canAttack(e: Enemy): boolean;
  requestToken(e: Enemy): boolean;
  releaseToken(e: Enemy): void;
}

const BODY_TINT = new Color(0.32, 0.27, 0.34);
const HIT_FLASH = new Color(1.0, 0.85, 0.75);
const GLOW = new Color(2.6, 0.35, 0.12);
const EYE_IDLE = new Color(1.6, 0.15, 0.05);
const EYE_HOT = new Color(5.5, 1.4, 0.4);
const EYE_DAZED = new Color(0.9, 0.8, 0.25);

const tmp = new Vector3();
const tmp2 = new Vector3();
const tmpC = new Color();

/**
 * Melee grunt: patrol → notice → chase → circle → telegraph → attack → recovery.
 * Reacts to hits (flinch, stagger, knockback, launch/juggle, guard) and dies / respawns.
 */
export class Enemy implements Hittable {
  readonly position = new Vector3();
  readonly radius = T.radius;
  readonly lockable = true;
  alive = true;
  airborne = false;

  readonly feet = new Vector3();
  readonly velocity = new Vector3();
  readonly spawn = new Vector3();
  facing = 0;
  grounded = true;
  health: number = T.maxHealth;
  readonly maxHealth: number = T.maxHealth;
  state: EnemyState = 'idle';
  stateTime = 0;
  /** game time of the last damage taken (health bar visibility) */
  lastHitAt = -99;
  /** extra damage taken while true (parry / counter stagger) */
  vulnerable = false;
  hasToken = false;

  private atk: AttackDef = ATTACKS[0];
  private hitDone = false;
  private parriedThisSwing = false;
  private stateDur = 0;
  private strafeDir = 1;
  private strafeRadius: number = T.strafeRadius;
  private patrolTarget = new Vector3();
  private floatTimer = 0;
  private bounced = false;
  private flash = 0;
  private glow = 0;
  private tumble = 0;
  private fade = 1;
  private hurtFlip = false;
  private deadTime = 0;

  private readonly bodyMats: MeshStandardMaterial[] = [];
  private readonly swordMat: MeshStandardMaterial | null = null;
  private readonly eyeMat = new MeshBasicMaterial({ color: EYE_IDLE.clone(), toneMapped: false });

  constructor(
    readonly model: CharacterModel,
    private readonly game: Game,
    private readonly director: EnemyDirector,
    x: number,
    z: number,
  ) {
    // Dark armour: one cloned, tinted material per enemy so flashes / fades are independent.
    const cache = new Map<Material, MeshStandardMaterial>();
    model.model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const src = m.material as MeshStandardMaterial;
      let mat = cache.get(src);
      if (!mat) {
        mat = src.clone();
        mat.color.copy(BODY_TINT);
        mat.roughness = 0.75;
        mat.emissive = new Color(0, 0, 0);
        cache.set(src, mat);
      }
      m.material = mat;
    });
    const sword = model.sword as Mesh | null;
    if (sword?.isMesh) {
      const sm = (sword.material as MeshStandardMaterial).clone();
      sm.color.set(0.35, 0.3, 0.32);
      sword.material = sm;
      this.swordMat = sm;
    }
    this.bodyMats.push(...cache.values());
    if (this.swordMat) this.bodyMats.push(this.swordMat);
    this.addEyes();

    this.spawn.set(x, game.world.groundAt(x, z), z);
    this.placeAtSpawn();
    game.scene.add(model.root);
  }

  /** Two glowing eyes parented to the head bone, positioned from the head mesh's bind pose. */
  private addEyes() {
    const scene = this.model.model;
    const headBone = scene.getObjectByName('head');
    const headMesh = scene.getObjectByName('Knight_Head') as SkinnedMesh | undefined;
    if (!headBone || !headMesh) return;
    scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(headMesh);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    // face is on +z (model faces +z)
    const geo = new SphereGeometry(size.x * 0.07, 8, 6);
    for (const side of [-1, 1]) {
      const eye = new Mesh(geo, this.eyeMat);
      const wp = new Vector3(center.x + side * size.x * 0.17, center.y - size.y * 0.02, box.max.z - size.z * 0.06);
      headBone.worldToLocal(wp);
      eye.position.copy(wp);
      // undo the bone's world scale so the sphere keeps its intended size
      const ws = headBone.getWorldScale(new Vector3());
      const ss = scene.getWorldScale(new Vector3());
      eye.scale.setScalar(ss.x / ws.x);
      headBone.add(eye);
    }
  }

  // ------------------------------------------------------------------ public API
  /** Winding up an attack (defense stream reads this for parry windows / UI). */
  get telegraphing() {
    return this.state === 'telegraph';
  }

  /** Seconds until the current swing's hit frame; Infinity when not attacking. */
  get attackTimeRemaining() {
    const hitDelay = (this.atk.hit - this.atk.wind) / this.atk.speed;
    if (this.state === 'telegraph') return this.atk.tele - this.stateTime + hitDelay;
    if (this.state === 'attack' && !this.hitDone) return Math.max(0, hitDelay - this.stateTime);
    return Infinity;
  }

  get attacking() {
    return this.state === 'telegraph' || this.state === 'attack';
  }

  get dead() {
    return this.state === 'dead';
  }

  /** Move the enemy's home (used to recycle an enemy next to the player). */
  relocate(x: number, z: number) {
    this.spawn.set(x, this.game.world.groundAt(x, z), z);
    this.placeAtSpawn();
  }

  // ------------------------------------------------------------------ player hooks
  /** Called by the player's defense when this enemy's swing is parried. */
  onParried() {
    this.parryStagger();
  }

  /** Called by the player's defense when this enemy's swing is countered. */
  onCountered() {
    this.parryStagger();
  }

  private parryStagger() {
    if (this.dead || this.parriedThisSwing) return;
    this.parriedThisSwing = true;
    this.releaseToken();
    this.vulnerable = true;
    this.go('stagger', T.parryStagger);
    const fwd = this.fwd(tmp);
    this.velocity.x = -fwd.x * 4;
    this.velocity.z = -fwd.z * 4;
    const p = this.position.clone().addScaledVector(fwd, 0.6).setY(this.feet.y + 1.4);
    this.game.fx.hitSpark(p, fwd.clone().setY(0.6), true);
    events.emit('enemy:staggered', { position: this.position.clone(), duration: T.parryStagger, parried: true });
  }

  // ------------------------------------------------------------------ hits
  onHit(info: HitInfo) {
    if (this.dead) return;
    const { fx, hud } = this.game;
    const fwd = this.fwd(tmp);
    // dir points from the attacker toward us → attacker is in front if fwd·(-dir) > 0
    const frontal = -(fwd.x * info.dir.x + fwd.z * info.dir.z) > 0.45;
    const sparkPos = this.position.clone().addScaledVector(info.dir, -0.35);
    sparkPos.y += 0.2;

    // Guard: occasional frontal block of light hits while not committed to anything.
    const canGuard = ['idle', 'patrol', 'chase', 'strafe', 'block'].includes(this.state);
    if (canGuard && frontal && !info.heavy && !info.guardBreak && !info.launch && Math.random() < T.guardChance) {
      this.go('block');
      this.facing = Math.atan2(-info.dir.x, -info.dir.z);
      this.velocity.x = info.dir.x * info.knockback * 0.6;
      this.velocity.z = info.dir.z * info.knockback * 0.6;
      fx.sparks.emit({
        count: 18, position: sparkPos, spread: 0.08, velocity: info.dir.clone().multiplyScalar(-3).setY(1.5), speed: 5,
        life: [0.12, 0.3], size: [0.04, 0.1], color: new Color(1.4, 1.6, 2.2), color2: new Color(0.8, 0.9, 1.6), gravity: 10, drag: 4,
      });
      // HUD numbers render `${value}`, so a label works here.
      hud.damageNumber(this.position.clone().setY(this.feet.y + 2.2), 'Blocked' as unknown as number, false);
      events.emit('enemy:blocked', { position: this.position.clone() });
      return;
    }

    let dmg = info.damage;
    if (this.vulnerable) dmg = Math.round(dmg * T.parryBonus);
    this.health = Math.max(0, this.health - dmg);
    this.lastHitAt = this.game.time;
    this.flash = 1;
    fx.hitSpark(sparkPos, info.dir.clone().negate().setY(0.3), info.heavy || this.vulnerable);
    hud.damageNumber(this.position.clone().setY(this.feet.y + 2.1), dmg, info.heavy || this.vulnerable);
    events.emit('enemy:hit', { position: this.position.clone(), damage: dmg, heavy: info.heavy });

    if (this.health <= 0) return this.die(info);

    const launched = (info.launch ?? 0) > 0;
    if (launched) {
      this.releaseToken();
      this.velocity.set(info.dir.x * info.knockback * 0.25, info.launch!, info.dir.z * info.knockback * 0.25);
      this.grounded = false;
      this.floatTimer = T.juggleFloat;
      this.facing = Math.atan2(-info.dir.x, -info.dir.z);
      if (this.state !== 'air') this.go('air');
      return;
    }
    if (this.state === 'air') {
      // Juggle: every hit keeps it floating a little longer.
      this.velocity.y = Math.max(this.velocity.y, T.juggleHitPop);
      this.velocity.x = info.dir.x * info.knockback * 0.3;
      this.velocity.z = info.dir.z * info.knockback * 0.3;
      this.floatTimer = T.juggleFloat;
      return;
    }
    if (this.state === 'down') {
      this.velocity.x = info.dir.x * info.knockback * 0.5;
      this.velocity.z = info.dir.z * info.knockback * 0.5;
      this.stateTime = Math.min(this.stateTime, 0.3); // OTG hits keep it down a bit longer
      return;
    }

    const committed = this.state === 'telegraph' || this.state === 'attack';
    const stagger = info.stagger ?? 0;
    const interrupts = !committed || info.heavy || stagger > 0 || info.guardBreak;
    const kb = info.knockback * (interrupts ? 1.5 : 0.5);
    this.velocity.x = info.dir.x * kb;
    this.velocity.z = info.dir.z * kb;
    if (!interrupts) return; // hyper-armour flinch: flash only
    if (this.state === 'stagger') {
      // already reeling (e.g. parried): hits don't cut the stagger short, a bigger one extends it
      this.stateDur = Math.max(this.stateDur, this.stateTime + Math.min(stagger, 0.6));
      return;
    }

    this.releaseToken();
    this.facing = Math.atan2(-info.dir.x, -info.dir.z);
    if (stagger > 0.45 || (info.heavy && committed) || info.guardBreak) {
      this.go('stagger', Math.max(stagger, 0.7));
      events.emit('enemy:staggered', { position: this.position.clone(), duration: Math.max(stagger, 0.7), parried: false });
    } else {
      this.go('hurt', Math.max(stagger, info.heavy ? 0.5 : 0.38));
    }
  }

  private die(info: HitInfo) {
    this.releaseToken();
    this.alive = false;
    this.vulnerable = false;
    this.deadTime = 0;
    this.velocity.x = info.dir.x * info.knockback * 1.2;
    this.velocity.z = info.dir.z * info.knockback * 1.2;
    if (info.launch) this.velocity.y = info.launch * 0.7;
    this.facing = Math.atan2(-info.dir.x, -info.dir.z);
    this.go('dead');
    this.game.hitstop(0.1);
    this.game.cam.shake(0.3);
    events.emit('enemy:died', { position: this.position.clone() });
  }

  // ------------------------------------------------------------------ state machine
  private go(state: EnemyState, dur = 0) {
    if (state !== 'stagger') this.vulnerable = false;
    if (this.state === 'attack' || this.state === 'telegraph') this.glow = Math.min(this.glow, 0.5);
    this.state = state;
    this.stateTime = 0;
    this.stateDur = dur;
    const m = this.model;
    switch (state) {
      case 'idle':
        this.stateDur = 1.2 + Math.random() * 2;
        m.play('Idle', { fade: 0.3 });
        break;
      case 'patrol': {
        const a = Math.random() * Math.PI * 2;
        const r = 1.5 + Math.random() * 3.5;
        this.patrolTarget.set(this.spawn.x + Math.cos(a) * r, 0, this.spawn.z + Math.sin(a) * r);
        this.stateDur = 6;
        m.play('Walking_A', { fade: 0.3 });
        break;
      }
      case 'return':
        m.play('Walking_A', { fade: 0.3, speed: 1.3 });
        break;
      case 'chase':
        m.play('Running_A', { fade: 0.2 });
        break;
      case 'strafe':
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        if (!this.stateDur) this.stateDur = 0.6 + Math.random() * 1.0;
        break;
      case 'telegraph': {
        this.atk = ATTACKS[Math.floor(Math.random() * ATTACKS.length)];
        this.hitDone = false;
        this.parriedThisSwing = false;
        m.play(this.atk.clip, { fade: 0.12, loop: false, speed: this.atk.wind / this.atk.tele, restart: true });
        events.emit('enemy:telegraph', { position: this.position.clone(), duration: this.attackTimeRemaining });
        // little warning glint
        this.game.fx.sparks.emit({
          count: 1, position: this.position.clone().setY(this.feet.y + 1.75), speed: 0,
          life: [0.25, 0.25], size: [0.9, 0.9], color: GLOW,
        });
        break;
      }
      case 'attack': {
        const a = m.currentAction;
        if (a) a.timeScale = this.atk.speed;
        events.emit('enemy:attack', { position: this.position.clone() });
        break;
      }
      case 'recover':
        this.stateDur = T.recover;
        break;
      case 'hurt':
        this.hurtFlip = !this.hurtFlip;
        m.play(this.hurtFlip ? 'Hit_A' : 'Hit_B', { fade: 0.05, loop: false, speed: 1.5, restart: true });
        break;
      case 'stagger':
        m.play('Hit_B', { fade: 0.05, loop: false, speed: clamp(0.87 / dur, 0.5, 1.4), restart: true });
        break;
      case 'block':
        this.stateDur = 0.45;
        m.play('Block_Hit', { fade: 0.05, loop: false, speed: 1.6, restart: true });
        break;
      case 'air':
        this.bounced = false;
        this.airborne = true;
        m.play('Hit_B', { fade: 0.06, loop: false, speed: 1.2, restart: true });
        break;
      case 'down':
        this.stateDur = 1.5;
        m.play('Lie_StandUp', { fade: 0.12, loop: false, speed: 1.6, restart: true });
        break;
      case 'dead':
        m.play('Death_A', { fade: 0.08, loop: false, speed: 1, restart: true });
        break;
    }
  }

  private releaseToken() {
    if (this.hasToken) this.director.releaseToken(this);
  }

  private fwd(out: Vector3) {
    return out.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  private faceToward(x: number, z: number, rate: number, dt: number) {
    const target = Math.atan2(x - this.feet.x, z - this.feet.z);
    this.facing = dampAngle(this.facing, target, rate, dt);
  }

  private steer(dirX: number, dirZ: number, speed: number, accel: number, dt: number) {
    const tx = dirX * speed;
    const tz = dirZ * speed;
    const dx = tx - this.velocity.x;
    const dz = tz - this.velocity.z;
    const d = Math.hypot(dx, dz);
    const max = accel * dt;
    if (d <= max) {
      this.velocity.x = tx;
      this.velocity.z = tz;
    } else {
      this.velocity.x += (dx / d) * max;
      this.velocity.z += (dz / d) * max;
    }
  }

  private friction(k: number, dt: number) {
    const f = Math.exp(-k * dt);
    this.velocity.x *= f;
    this.velocity.z *= f;
  }

  update(dt: number) {
    this.stateTime += dt;
    const p = this.game.player;
    const toP = tmp2.set(p.position.x - this.feet.x, 0, p.position.z - this.feet.z);
    const dist = toP.length();
    const dy = p.position.y - this.feet.y;
    if (dist > 1e-4) toP.divideScalar(dist);
    const playerValid = !p.dead && Math.abs(dy) < 4.5;
    const homeDist = Math.hypot(this.feet.x - this.spawn.x, this.feet.z - this.spawn.z);
    const t = this.stateTime;

    switch (this.state) {
      case 'idle':
        this.friction(10, dt);
        if (playerValid && dist < T.noticeRange) this.go('chase');
        else if (t > this.stateDur) this.go('patrol');
        break;

      case 'patrol': {
        if (playerValid && dist < T.noticeRange) {
          this.go('chase');
          break;
        }
        const dx = this.patrolTarget.x - this.feet.x;
        const dz = this.patrolTarget.z - this.feet.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.4 || t > this.stateDur) {
          this.go('idle');
          break;
        }
        this.steer(dx / d, dz / d, T.walkSpeed, 10, dt);
        this.faceToward(this.patrolTarget.x, this.patrolTarget.z, 5, dt);
        break;
      }

      case 'return': {
        const dx = this.spawn.x - this.feet.x;
        const dz = this.spawn.z - this.feet.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.5) {
          this.go('idle');
          break;
        }
        if (playerValid && dist < T.noticeRange * 0.6 && homeDist < T.leashRange * 0.6) {
          this.go('chase');
          break;
        }
        this.steer(dx / d, dz / d, T.walkSpeed * 1.5, 10, dt);
        this.faceToward(this.spawn.x, this.spawn.z, 6, dt);
        // regenerate while walking home
        this.health = Math.min(this.maxHealth, this.health + dt * 20);
        break;
      }

      case 'chase':
        if (!playerValid || homeDist > T.leashRange || dist > T.noticeRange * 1.8) {
          this.go('return');
          break;
        }
        if (dist < T.engageRange) {
          this.strafeRadius = T.strafeRadius;
          this.go('strafe', 0.3 + Math.random() * 0.6);
          break;
        }
        this.steer(toP.x, toP.z, T.chaseSpeed, 18, dt);
        this.faceToward(p.position.x, p.position.z, 9, dt);
        break;

      case 'strafe': {
        if (!playerValid || homeDist > T.leashRange) {
          this.go('return');
          break;
        }
        if (dist > T.waitRadius + 2) {
          this.go('chase');
          break;
        }
        // circle the player, correcting toward the desired radius
        const radial = clamp((dist - this.strafeRadius) * 1.5, -1, 1);
        const tx = -toP.z * this.strafeDir;
        const tz = toP.x * this.strafeDir;
        let mx = tx * 0.8 + toP.x * radial;
        let mz = tz * 0.8 + toP.z * radial;
        const ml = Math.hypot(mx, mz) || 1;
        mx /= ml;
        mz /= ml;
        this.steer(mx, mz, T.strafeSpeed, 12, dt);
        this.faceToward(p.position.x, p.position.z, 10, dt);
        // pick the clip from the lateral component relative to our facing
        const f = this.fwd(tmp);
        const lateral = f.z * this.velocity.x - f.x * this.velocity.z; // + = moving to our left
        const back = -(f.x * this.velocity.x + f.z * this.velocity.z);
        if (back > 1 && Math.abs(lateral) < 1) this.model.play('Walking_Backwards', { fade: 0.25 });
        else if (Math.abs(lateral) > 0.4) this.model.play(lateral > 0 ? 'Running_Strafe_Left' : 'Running_Strafe_Right', { fade: 0.25, speed: 0.7 });
        else this.model.play('2H_Melee_Idle', { fade: 0.25 });

        if (t > this.stateDur) {
          const free = this.director.canAttack(this);
          if (free && dist < T.strafeRadius + 0.8 && Math.abs(dy) < 1.5 && this.director.requestToken(this)) {
            this.go('telegraph');
          } else {
            // close in while a token is free, otherwise hang back and wait for one
            this.strafeRadius = free ? T.strafeRadius : T.waitRadius;
            this.stateDur = this.stateTime + (free ? 0.25 : 0.4 + Math.random() * 0.6);
            if (Math.random() < 0.3) this.strafeDir *= -1;
          }
        }
        break;
      }

      case 'telegraph':
        this.friction(12, dt);
        if (!p.dead) this.faceToward(p.position.x, p.position.z, 7, dt);
        this.glow = Math.min(1, t / this.atk.tele);
        if (t >= this.atk.tele) this.go('attack');
        break;

      case 'attack': {
        const hitDelay = (this.atk.hit - this.atk.wind) / this.atk.speed;
        const endAt = (this.atk.end - this.atk.wind) / this.atk.speed;
        const f = this.fwd(tmp);
        if (t < hitDelay && dist > 1.4) {
          this.velocity.x = f.x * this.atk.lunge;
          this.velocity.z = f.z * this.atk.lunge;
        } else {
          this.friction(14, dt);
        }
        if (!this.hitDone && t >= hitDelay) {
          this.hitDone = true;
          this.swing();
        }
        this.glow = this.hitDone ? Math.max(0, 1 - (t - hitDelay) * 4) : 1;
        if (t >= endAt) this.go('recover');
        break;
      }

      case 'recover':
        this.friction(10, dt);
        if (t > 0.25 && this.model.currentName !== '2H_Melee_Idle') this.model.play('2H_Melee_Idle', { fade: 0.35 });
        if (t >= this.stateDur) {
          this.releaseToken();
          this.strafeRadius = T.waitRadius;
          this.go('strafe', 0.9 + Math.random() * 1.2);
        }
        break;

      case 'hurt':
      case 'block':
        this.friction(7, dt);
        if (t >= this.stateDur) this.go(playerValid ? 'strafe' : 'idle', 0.2 + Math.random() * 0.4);
        break;

      case 'stagger':
        this.friction(6, dt);
        if (t >= this.stateDur) {
          this.vulnerable = false;
          this.go(playerValid ? 'strafe' : 'idle', 0.3);
        }
        break;

      case 'air':
        this.friction(1.5, dt);
        this.tumble = Math.min(1.35, this.tumble + dt * 4.5);
        break;

      case 'down':
        this.friction(8, dt);
        if (t >= this.stateDur) this.go(playerValid ? 'strafe' : 'idle', 0.4);
        break;

      case 'dead':
        this.friction(5, dt);
        this.deadTime += dt;
        if (this.deadTime > 1.3) this.fade = Math.max(0, 1 - (this.deadTime - 1.3) / 1.4);
        if (this.deadTime >= T.respawnDelay) this.respawn();
        break;
    }

    this.integrate(dt);
    this.syncVisual(dt);
  }

  /** The hit frame of a swing: cone test against the player. */
  private swing() {
    const p = this.game.player;
    const f = this.fwd(tmp);
    const dx = p.position.x - this.feet.x;
    const dz = p.position.z - this.feet.z;
    const d = Math.hypot(dx, dz);
    const dy = p.position.y - this.feet.y;
    const inArc = d < 0.6 || (dx * f.x + dz * f.z) / d >= Math.cos(((this.atk.arcDeg / 2) * Math.PI) / 180);
    if (p.dead || d > this.atk.range + 0.45 || Math.abs(dy) > 1.6 || !inArc) return;
    const dir = new Vector3(dx, 0, dz);
    if (d < 1e-3) dir.copy(f);
    dir.normalize();
    const result: HitResult = p.receiveHit({
      damage: this.atk.damage, dir, knockback: this.atk.knockback, heavy: this.atk.heavy, attacker: this,
    });
    switch (result) {
      case 'hit':
        this.game.hitstop(this.atk.heavy ? 0.11 : 0.08);
        this.game.cam.shake(this.atk.heavy ? 0.45 : 0.32);
        break;
      case 'blocked':
        this.releaseToken();
        this.velocity.x = -f.x * 3;
        this.velocity.z = -f.z * 3;
        this.go('hurt', 0.45);
        this.model.play('Block_Hit', { fade: 0.05, loop: false, speed: 1.4, restart: true });
        break;
      case 'parried':
      case 'countered':
        this.parryStagger();
        break;
      default:
        break;
    }
  }

  private integrate(dt: number) {
    const { world } = this.game;
    const wasGrounded = this.grounded;
    if (!this.grounded || this.velocity.y > 0) {
      this.floatTimer -= dt;
      const g = this.floatTimer > 0 && this.state === 'air' ? T.juggleGravity : T.gravity;
      this.velocity.y = Math.max(-30, this.velocity.y - g * dt);
    }
    this.feet.addScaledVector(this.velocity, dt);
    world.resolveCollisions(this.feet, 0.42, 0.45);
    const ground = world.groundAt(this.feet.x, this.feet.z, this.feet.y, 0.45);
    const snap = wasGrounded ? 0.4 : 0;
    if (this.velocity.y <= 0 && this.feet.y <= ground + snap) {
      const impact = this.velocity.y;
      this.feet.y = ground;
      this.velocity.y = 0;
      this.grounded = true;
      if (!wasGrounded) this.onLand(impact);
    } else {
      this.grounded = false;
    }
    if (this.feet.y < -30) this.placeAtSpawn();
    this.position.set(this.feet.x, this.feet.y + 1.0, this.feet.z);
  }

  private onLand(impact: number) {
    if (this.state === 'air') {
      this.game.fx.dustPuff(this.feet, 10, 2.4);
      if (!this.bounced && impact < -5) {
        // one bounce off the ground
        this.bounced = true;
        this.velocity.y = Math.min(5, -impact * 0.32);
        this.grounded = false;
        this.floatTimer = 0;
        this.game.cam.shake(0.15);
        return;
      }
      this.airborne = false;
      this.tumble = 0;
      this.go('down');
    } else if (this.state !== 'dead' && impact < -6) {
      this.game.fx.dustPuff(this.feet, 6, 1.8);
    }
  }

  private respawn() {
    this.placeAtSpawn();
    this.health = this.maxHealth;
    this.alive = true;
    this.vulnerable = false;
    this.lastHitAt = -99;
    this.fade = 0;
    this.game.fx.echoBurst(this.position.clone(), 30, 2);
    this.go('idle');
    events.emit('enemy:respawn', { position: this.position.clone() });
  }

  private placeAtSpawn() {
    this.feet.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.airborne = false;
    this.tumble = 0;
    this.facing = Math.random() * Math.PI * 2;
    this.position.set(this.feet.x, this.feet.y + 1.0, this.feet.z);
    if (this.state !== 'dead') this.go('idle');
  }

  private syncVisual(dt: number) {
    const m = this.model;
    m.root.position.copy(this.feet);
    m.root.rotation.y = this.facing;
    if (this.state !== 'air') this.tumble = Math.max(0, this.tumble - dt * 8);
    m.pivot.rotation.x = -this.tumble;
    m.update(dt);

    if (this.state !== 'dead' && this.fade < 1) this.fade = Math.min(1, this.fade + dt * 2);
    if (this.state === 'dead' && this.deadTime > 1.3) m.root.position.y -= (this.deadTime - 1.3) * 0.25;
    m.root.visible = this.fade > 0.01;

    this.flash = Math.max(0, this.flash - dt * 7);
    if (this.state !== 'telegraph' && this.state !== 'attack') this.glow = Math.max(0, this.glow - dt * 3);
    const fl = this.flash * this.flash;
    // telegraph: pulsing emissive that ramps up and spikes just before the hit
    const pulse = this.state === 'telegraph' ? 0.6 + 0.4 * Math.sin(this.stateTime * 40) : 1;
    const g = this.glow * pulse;
    const transparent = this.fade < 1;
    for (const mat of this.bodyMats) {
      mat.emissive.copy(HIT_FLASH).multiplyScalar(fl * 0.8);
      if (mat !== this.swordMat) mat.emissive.add(tmpC.copy(GLOW).multiplyScalar(g * 0.035));
      if (mat.transparent !== transparent) {
        mat.transparent = transparent;
        mat.needsUpdate = true;
      }
      mat.opacity = this.fade;
      mat.depthWrite = !transparent;
    }
    if (this.swordMat) this.swordMat.emissive.copy(GLOW).multiplyScalar(g * 1.4).add(tmpC.copy(HIT_FLASH).multiplyScalar(fl * 0.5));
    const eye = this.eyeMat.color;
    if (this.state === 'dead') eye.setRGB(0, 0, 0);
    else if (this.vulnerable) eye.copy(EYE_DAZED).multiplyScalar(0.6 + 0.4 * Math.sin(this.stateTime * 18));
    else eye.copy(EYE_IDLE).lerp(EYE_HOT, this.glow);
    this.eyeMat.opacity = this.fade;
    this.eyeMat.transparent = transparent;
  }

  /** Signed yaw offset from our facing to a point (radians). */
  angleTo(pos: Vector3) {
    return angleDelta(this.facing, Math.atan2(pos.x - this.feet.x, pos.z - this.feet.z));
  }

  dispose() {
    this.game.scene.remove(this.model.root);
  }
}
