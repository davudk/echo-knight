import { Color, Mesh, MeshBasicMaterial, SphereGeometry, Vector3, type Scene } from 'three';
import { events } from '../core/Events';
import { angleDelta } from '../core/math';
import type { Fx } from '../fx/Fx';
import type { HitResult, Player } from '../player/Player';
import type { World } from '../world/World';
import { TelegraphColors, type Decal, type Decals } from './Decals';
import type { TelegraphKind } from './types';

/**
 * Hitbox geometry tests (pure functions, player = vertical capsule at its feet) and the
 * long-lived boss effects that outlive an attack step: expanding shockwave rings and projectiles
 * (both pooled). Angles follow the game's yaw convention: forward = (sin yaw, cos yaw),
 * relative angles are + to the left.
 */

export const PLAYER_RADIUS = 0.45;
/** player feet within this height of the ground count as "grounded" for shockwave rings */
export const RING_GROUND_CLEARANCE = 0.35;

/** A hit the boss (or one of its effects) wants to deal to the player. */
export interface BossHitSpec {
  damage: number;
  knockback: number;
  heavy: boolean;
  telegraph: TelegraphKind;
  parryable: boolean;
  unblockable: boolean;
  /** where the hit comes from (knockback / block direction is from here toward the player) */
  from: Vector3;
  /** set for projectile hits (parry → reflect) */
  projectile?: Projectile;
}

/** What effects need from their owner (the Boss). */
export interface EffectOwner {
  readonly id: string;
  readonly position: Vector3;
  readonly radius: number;
  readonly alive: boolean;
  hitPlayer(spec: BossHitSpec): HitResult;
  /** a reflected projectile struck the owner */
  onReflectHit(damage: number, poise: number, at: Vector3): void;
}

// ------------------------------------------------------------------ geometry
/** Relative angle (rad, + = left) from a yaw at (ox, oz) toward (px, pz). */
export function relAngle(ox: number, oz: number, yaw: number, px: number, pz: number) {
  return angleDelta(yaw, Math.atan2(px - ox, pz - oz));
}

/** Player inside a horizontal cone (with the player's radius as tolerance)? */
export function inCone(ox: number, oz: number, yaw: number, range: number, arcDeg: number, px: number, pz: number, pr = PLAYER_RADIUS) {
  const d = Math.hypot(px - ox, pz - oz);
  if (d > range + pr) return false;
  if (d < pr + 0.3) return true;
  const half = (arcDeg * Math.PI) / 360 + Math.asin(Math.min(1, pr / d));
  return Math.abs(relAngle(ox, oz, yaw, px, pz)) <= half;
}

/** Player inside the angular band [a0, a1] (rad, relative) of a ring sector between `inner` and `range`? */
export function inArcBand(ox: number, oz: number, yaw: number, a0: number, a1: number, inner: number, range: number, px: number, pz: number, pr = PLAYER_RADIUS) {
  const d = Math.hypot(px - ox, pz - oz);
  if (d > range + pr || d < inner - pr) return false;
  if (d < pr + 0.3) return inner <= 0.3;
  const tol = Math.asin(Math.min(1, pr / d));
  const a = relAngle(ox, oz, yaw, px, pz);
  const lo = Math.min(a0, a1) - tol;
  const hi = Math.max(a0, a1) + tol;
  return a >= lo && a <= hi;
}

/** Distance from the player (xz) to the segment start→start+dir*length. */
export function segmentDistance(sx: number, sz: number, yaw: number, length: number, px: number, pz: number) {
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  const t = Math.max(0, Math.min(length, (px - sx) * dx + (pz - sz) * dz));
  return Math.hypot(px - (sx + dx * t), pz - (sz + dz * t));
}

export function inCircle(cx: number, cz: number, radius: number, px: number, pz: number, pr = PLAYER_RADIUS) {
  return Math.hypot(px - cx, pz - cz) <= radius + pr;
}

/** Is the player's feet height within [yMin, yMax] of a reference height? */
export function inHeight(refY: number, playerY: number, yMin: number, yMax: number) {
  const dy = playerY - refY;
  return dy >= yMin && dy <= yMax;
}

// ------------------------------------------------------------------ shockwave rings
class Ring {
  active = false;
  owner!: EffectOwner;
  readonly origin = new Vector3();
  r = 0;
  speed = 0;
  max = 0;
  thickness = 0.7;
  damage = 0;
  knockback = 0;
  telegraph: TelegraphKind = 'unblockable';
  hit = false;
  decal: Decal | null = null;
  dustTimer = 0;
}

// ------------------------------------------------------------------ projectiles
export class Projectile {
  active = false;
  owner!: EffectOwner;
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  speed = 10;
  homing = 0;
  life = 0;
  radius = 0.3;
  damage = 10;
  knockback = 4;
  telegraph: TelegraphKind = 'magic';
  parryable = false;
  reflectable = false;
  reflected = false;
  reflectDamage = 0;
  reflectPoise = 0;
  /** ignore the player until this age (after a dodge passed through) */
  ignoreUntil = 0;
  age = 0;
  readonly mesh: Mesh;
  readonly mat: MeshBasicMaterial;

  constructor(geo: SphereGeometry, scene: Scene) {
    this.mat = new MeshBasicMaterial({ color: new Color(), toneMapped: false });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
}

export interface ProjectileSpawn {
  owner: EffectOwner;
  position: Vector3;
  direction: Vector3;
  speed: number;
  homing?: number;
  lifetime?: number;
  radius?: number;
  damage: number;
  knockback?: number;
  telegraph: TelegraphKind;
  reflectable?: boolean;
  reflectDamage?: number;
  reflectPoise?: number;
}

export interface RingSpawn {
  owner: EffectOwner;
  origin: Vector3;
  speed: number;
  maxRadius: number;
  thickness?: number;
  startRadius?: number;
  damage: number;
  knockback?: number;
  telegraph?: TelegraphKind;
}

const tmp = new Vector3();
const tmp2 = new Vector3();
const spec: BossHitSpec = {
  damage: 0, knockback: 0, heavy: false, telegraph: 'magic', parryable: false, unblockable: false, from: new Vector3(),
};

/**
 * Rings + projectiles for every boss (one instance on `game.bosses.effects`). Pooled; update once per frame.
 */
export class BossEffects {
  private readonly rings: Ring[] = [];
  private readonly shots: Projectile[] = [];
  private readonly geo = new SphereGeometry(1, 14, 10);

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
    private readonly fx: Fx,
    private readonly decals: Decals,
    private readonly player: () => Player,
  ) {
    for (let i = 0; i < 24; i++) this.shots.push(new Projectile(this.geo, scene));
    for (let i = 0; i < 6; i++) this.rings.push(new Ring());
  }

  spawnRing(o: RingSpawn) {
    let ring = this.rings.find((r) => !r.active);
    if (!ring) this.rings.push((ring = new Ring()));
    ring.active = true;
    ring.owner = o.owner;
    ring.origin.copy(o.origin);
    ring.r = o.startRadius ?? 0.6;
    ring.speed = o.speed;
    ring.max = o.maxRadius;
    ring.thickness = o.thickness ?? 0.7;
    ring.damage = o.damage;
    ring.knockback = o.knockback ?? 7;
    ring.telegraph = o.telegraph ?? 'unblockable';
    ring.hit = false;
    ring.dustTimer = 0;
    ring.decal = this.decals.acquire().tint(ring.telegraph).ring(ring.origin.x, ring.origin.y, ring.origin.z, ring.r, ring.thickness);
    ring.decal.fill = 1;
    ring.decal.flash = 1;
    return ring;
  }

  spawnProjectile(o: ProjectileSpawn) {
    let p = this.shots.find((s) => !s.active);
    if (!p) this.shots.push((p = new Projectile(this.geo, this.scene)));
    p.active = true;
    p.owner = o.owner;
    p.pos.copy(o.position);
    p.speed = o.speed;
    p.vel.copy(o.direction).normalize().multiplyScalar(o.speed);
    p.homing = o.homing ?? 0;
    p.life = o.lifetime ?? 4;
    p.radius = o.radius ?? 0.3;
    p.damage = o.damage;
    p.knockback = o.knockback ?? 4;
    p.telegraph = o.telegraph;
    p.reflectable = !!o.reflectable;
    p.parryable = o.telegraph === 'parryable' || p.reflectable;
    p.reflected = false;
    p.reflectDamage = o.reflectDamage ?? o.damage * 3;
    p.reflectPoise = o.reflectPoise ?? 25;
    p.ignoreUntil = 0;
    p.age = 0;
    p.mat.color.copy(TelegraphColors[o.telegraph]).multiplyScalar(1.3);
    p.mesh.scale.setScalar(p.radius);
    p.mesh.position.copy(p.pos);
    p.mesh.visible = true;
    return p;
  }

  /** Remove everything owned by `owner` (reset / death), or everything. */
  clear(owner?: EffectOwner) {
    for (const r of this.rings) if (r.active && (!owner || r.owner === owner)) this.killRing(r);
    for (const p of this.shots) if (p.active && (!owner || p.owner === owner)) this.killShot(p, false);
  }

  get activeProjectiles() {
    return this.shots.filter((s) => s.active);
  }

  update(dt: number) {
    const pl = this.player();
    for (const r of this.rings) if (r.active) this.updateRing(r, pl, dt);
    for (const p of this.shots) if (p.active) this.updateShot(p, pl, dt);
  }

  private killRing(r: Ring) {
    r.active = false;
    r.decal?.release(0.15);
    r.decal = null;
  }

  private updateRing(r: Ring, pl: Player, dt: number) {
    const prev = r.r;
    r.r = Math.min(r.max, r.r + r.speed * dt);
    r.decal?.ring(r.origin.x, r.origin.y, r.origin.z, r.r, r.thickness);
    if (r.decal) r.decal.alpha = 1 - Math.max(0, (r.r / r.max - 0.75) / 0.25) * 0.7;
    r.dustTimer -= dt;
    if (r.dustTimer <= 0) {
      r.dustTimer = 0.05;
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        tmp.set(r.origin.x + Math.sin(a) * r.r, r.origin.y + 0.1, r.origin.z + Math.cos(a) * r.r);
        this.fx.dustPuff(tmp, 2, 1.4, [0.3, 0.6]);
      }
    }
    if (!r.hit && r.owner.alive && !pl.dead) {
      const dp = Math.hypot(pl.position.x - r.origin.x, pl.position.z - r.origin.z);
      const half = r.thickness / 2 + PLAYER_RADIUS;
      const crossed = dp >= prev - half && dp <= r.r + half;
      const ground = this.world.groundAt(pl.position.x, pl.position.z, pl.position.y);
      const grounded = pl.grounded || pl.position.y - ground <= RING_GROUND_CLEARANCE;
      if (crossed && grounded && Math.abs(pl.position.y - r.origin.y) < 1.2) {
        spec.damage = r.damage;
        spec.knockback = r.knockback;
        spec.heavy = true;
        spec.telegraph = r.telegraph;
        spec.parryable = false;
        spec.unblockable = r.telegraph === 'unblockable';
        spec.from.copy(r.origin);
        spec.projectile = undefined;
        const res = r.owner.hitPlayer(spec);
        // one hit per ring; a dodge (i-frames) or a jump lets it pass
        if (res === 'hit' || res === 'blocked' || res === 'parried') r.hit = true;
      }
    }
    if (r.r >= r.max) this.killRing(r);
  }

  private killShot(p: Projectile, burst: boolean) {
    p.active = false;
    p.mesh.visible = false;
    if (burst) {
      this.fx.sparks.emit({
        count: 16, position: p.pos, spread: 0.1, speed: 4, life: [0.12, 0.35], size: [0.05, 0.12],
        color: TelegraphColors[p.telegraph], color2: TelegraphColors[p.telegraph], gravity: 4, drag: 3,
      });
    }
  }

  private updateShot(p: Projectile, pl: Player, dt: number) {
    p.age += dt;
    p.life -= dt;
    if (p.life <= 0) return this.killShot(p, true);
    const owner = p.owner;
    if (!p.reflected && p.homing > 0 && !pl.dead) {
      // steer toward the player's chest, limited turn rate
      tmp.set(pl.position.x - p.pos.x, pl.position.y + 1.1 - p.pos.y, pl.position.z - p.pos.z).normalize();
      tmp2.copy(p.vel).normalize();
      const ang = Math.acos(Math.max(-1, Math.min(1, tmp2.dot(tmp))));
      if (ang > 1e-4) {
        const k = Math.min(1, (p.homing * dt) / ang);
        tmp2.lerp(tmp, k).normalize();
        p.vel.copy(tmp2).multiplyScalar(p.speed);
      }
    }
    p.pos.addScaledVector(p.vel, dt);
    p.mesh.position.copy(p.pos);
    const s = p.radius * (1 + 0.15 * Math.sin(p.age * 30));
    p.mesh.scale.setScalar(s);
    if (Math.random() < 0.6) {
      this.fx.sparks.emit({
        count: 1, position: p.pos, spread: p.radius * 0.5, speed: 0.4, life: [0.15, 0.3], size: [p.radius * 0.6, p.radius],
        color: TelegraphColors[p.telegraph], drag: 2,
      });
    }

    // world
    const ground = this.world.terrain.heightAt(p.pos.x, p.pos.z);
    if (p.pos.y < ground + 0.05 || this.world.pointBlocked(p.pos.x, p.pos.y, p.pos.z, 0)) return this.killShot(p, true);

    if (p.reflected) {
      if (!owner.alive) return;
      const d = tmp.copy(owner.position).sub(p.pos).length();
      if (d < owner.radius + p.radius + 0.4) {
        owner.onReflectHit(p.reflectDamage, p.reflectPoise, p.pos);
        this.killShot(p, true);
      }
      return;
    }

    if (pl.dead || p.age < p.ignoreUntil) return;
    // player capsule: segment from feet+0.3 to feet+1.6
    const cy = Math.max(pl.position.y + 0.3, Math.min(pl.position.y + 1.6, p.pos.y));
    const d = Math.hypot(p.pos.x - pl.position.x, p.pos.y - cy, p.pos.z - pl.position.z);
    if (d > p.radius + PLAYER_RADIUS) return;
    spec.damage = p.damage;
    spec.knockback = p.knockback;
    spec.heavy = false;
    spec.telegraph = p.telegraph;
    spec.parryable = p.parryable;
    spec.unblockable = p.telegraph === 'unblockable';
    spec.from.copy(p.pos).addScaledVector(p.vel, -0.05);
    spec.projectile = p;
    const res = owner.hitPlayer(spec);
    if (res === 'parried' && p.reflectable) {
      // send it back at the caster, faster
      p.reflected = true;
      p.life = 3;
      p.homing = 0;
      tmp.copy(owner.position).sub(p.pos).normalize();
      p.speed *= 1.5;
      p.vel.copy(tmp).multiplyScalar(p.speed);
      p.mat.color.copy(TelegraphColors.parryable).multiplyScalar(1.6);
      events.emit('boss:reflect', { id: owner.id, position: p.pos.clone() });
    } else if (res === 'dodged' || res === 'ignored') {
      p.ignoreUntil = p.age + 0.35;
    } else {
      this.killShot(p, true);
    }
  }
}
