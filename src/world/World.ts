import { Scene, Vector3 } from 'three';
import { Terrain } from './Terrain';

/** Vertical cylinder collider. `top` = Infinity for things you can't stand on (tree trunks). */
export interface Collider {
  x: number;
  z: number;
  r: number;
  bottom: number;
  top: number;
}

export interface HitInfo {
  damage: number;
  /** horizontal knockback direction (normalised) */
  dir: Vector3;
  knockback: number;
  heavy: boolean;
}

/** Anything the player can hit. Enemies will implement this later. */
export interface Hittable {
  readonly position: Vector3;
  readonly radius: number;
  onHit(info: HitInfo): void;
}

/** Spatial queries for gameplay: ground height, collision, targets. */
export class World {
  readonly colliders: Collider[] = [];
  readonly targets: Hittable[] = [];
  readonly bounds: number;

  constructor(
    readonly scene: Scene,
    readonly terrain: Terrain,
  ) {
    this.bounds = terrain.half * 0.9;
  }

  /**
   * Highest walkable surface under (x, z) that is not above `fromY + step`.
   * Lets the player stand on pillars/blocks but not get teleported onto them from below.
   */
  groundAt(x: number, z: number, fromY = Infinity, step = 0.45): number {
    let g = this.terrain.heightAt(x, z);
    for (const c of this.colliders) {
      if (c.top === Infinity) continue;
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz > c.r * c.r) continue;
      if (c.top <= fromY + step && c.top > g) g = c.top;
    }
    return g;
  }

  /** Push a circle out of any collider it overlaps at its current height. */
  resolveCollisions(pos: Vector3, radius: number, step = 0.45) {
    for (const c of this.colliders) {
      if (pos.y >= c.top - step) continue; // standing on / above it
      if (pos.y + 1.6 < c.bottom) continue; // fully beneath it
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const min = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const push = min - d;
      pos.x += (dx / d) * push;
      pos.z += (dz / d) * push;
    }
    const b = this.bounds;
    pos.x = Math.max(-b, Math.min(b, pos.x));
    pos.z = Math.max(-b, Math.min(b, pos.z));
  }

  /** Targets inside a horizontal cone in front of `origin`. */
  queryCone(origin: Vector3, forward: Vector3, range: number, arcDeg: number, verticalReach = 2.2): Hittable[] {
    const cosHalf = Math.cos(((arcDeg / 2) * Math.PI) / 180);
    return this.targets.filter((t) => {
      const dx = t.position.x - origin.x;
      const dz = t.position.z - origin.z;
      const dy = t.position.y - origin.y;
      if (Math.abs(dy) > verticalReach) return false;
      const d = Math.hypot(dx, dz);
      if (d > range + t.radius) return false;
      if (d < t.radius + 0.3) return true;
      return (dx * forward.x + dz * forward.z) / d >= cosHalf;
    });
  }

  querySphere(center: Vector3, radius: number, verticalReach = 2.5): Hittable[] {
    return this.targets.filter((t) => {
      const d = Math.hypot(t.position.x - center.x, t.position.z - center.z);
      return d <= radius + t.radius && Math.abs(t.position.y - center.y) < verticalReach;
    });
  }
}
