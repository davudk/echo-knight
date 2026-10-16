import { Scene, Vector3 } from 'three';
import { Terrain } from './Terrain';

/** Vertical cylinder. `top` = Infinity for things you can't stand on (tree trunks). */
export interface CylinderCollider {
  kind?: 'cylinder';
  x: number;
  z: number;
  r: number;
  bottom: number;
  top: number;
  /** optional tag for gameplay queries (e.g. 'wall', 'ledge', 'echo-platform') */
  tag?: string;
}

/**
 * Yaw-rotated box (walls, buildings, ledges, roofs). Matches a mesh with
 * `BoxGeometry(2*hx, top-bottom, 2*hz)` and `rotation.y = yaw` centred at (x, (top+bottom)/2, z).
 */
export interface BoxCollider {
  kind: 'box';
  x: number;
  z: number;
  hx: number;
  hz: number;
  yaw: number;
  bottom: number;
  top: number;
  tag?: string;
}

export type Collider = CylinderCollider | BoxCollider;

export interface Contact {
  collider: Collider;
  /** horizontal push-out normal (unit, y = 0) */
  normal: Vector3;
}

export interface WallHit {
  collider: Collider;
  /** horizontal surface normal pointing away from the wall (unit, y = 0) */
  normal: Vector3;
  /** closest point on the wall surface at the probe height */
  point: Vector3;
  /** top of the collider (ledge height) */
  top: number;
}

export interface HitInfo {
  damage: number;
  /** horizontal knockback direction (normalised) */
  dir: Vector3;
  knockback: number;
  heavy: boolean;
  /** upward launch velocity (launchers / juggles); 0/undefined = none */
  launch?: number;
  /** stagger duration in seconds the target should be stunned for */
  stagger?: number;
  /** who dealt it */
  source?: 'player' | 'echo';
  /** move id from the move list (for style meter / training log) */
  move?: string;
}

/** Anything the player can hit. Enemies and dummies implement this. */
export interface Hittable {
  readonly position: Vector3;
  readonly radius: number;
  onHit(info: HitInfo): void;
  /** false = ignore in queries (dead) */
  alive?: boolean;
  /** can be lock-on targeted */
  lockable?: boolean;
  /** currently airborne (juggle state) */
  airborne?: boolean;
}

/** Spatial queries for gameplay: ground height, collision, targets. */
export class World {
  readonly colliders: Collider[] = [];
  readonly targets: Hittable[] = [];
  readonly bounds: number;
  /** contacts from the last `resolveCollisions` call */
  readonly contacts: Contact[] = [];

  constructor(
    readonly scene: Scene,
    readonly terrain: Terrain,
  ) {
    this.bounds = terrain.half * 0.9;
  }

  addCollider<T extends Collider>(c: T): T {
    this.colliders.push(c);
    return c;
  }
  removeCollider(c: Collider) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  /** Convenience: box collider from centre, size and yaw. */
  addBox(x: number, z: number, width: number, depth: number, bottom: number, top: number, yaw = 0, tag?: string) {
    return this.addCollider<BoxCollider>({ kind: 'box', x, z, hx: width / 2, hz: depth / 2, yaw, bottom, top, tag });
  }

  /** Is (x, z) inside the collider's footprint (grown by `margin`)? */
  contains2D(c: Collider, x: number, z: number, margin = 0): boolean {
    if (c.kind === 'box') {
      const { lx, lz } = toLocal(c, x, z);
      return Math.abs(lx) <= c.hx + margin && Math.abs(lz) <= c.hz + margin;
    }
    const dx = x - c.x;
    const dz = z - c.z;
    const r = c.r + margin;
    return dx * dx + dz * dz <= r * r;
  }

  /**
   * Highest walkable surface under (x, z) that is not above `fromY + step`.
   * Lets the player stand on pillars/roofs but not get teleported onto them from below.
   */
  groundAt(x: number, z: number, fromY = Infinity, step = 0.45): number {
    let g = this.terrain.heightAt(x, z);
    for (const c of this.colliders) {
      if (c.top === Infinity || c.top <= g || c.top > fromY + step) continue;
      if (this.contains2D(c, x, z)) g = c.top;
    }
    return g;
  }

  /** Push a circle out of any collider it overlaps at its current height. Fills `contacts`. */
  resolveCollisions(pos: Vector3, radius: number, step = 0.45, height = 1.6) {
    this.contacts.length = 0;
    for (let iter = 0; iter < 2; iter++) {
      for (const c of this.colliders) {
        if (pos.y >= c.top - step) continue; // standing on / above it
        if (pos.y + height < c.bottom) continue; // fully beneath it
        const n = this.pushOut(c, pos, radius);
        if (n && iter === 0) this.contacts.push({ collider: c, normal: n });
      }
    }
    const b = this.bounds;
    pos.x = Math.max(-b, Math.min(b, pos.x));
    pos.z = Math.max(-b, Math.min(b, pos.z));
  }

  /** Returns the push normal if it moved `pos`. */
  private pushOut(c: Collider, pos: Vector3, radius: number): Vector3 | null {
    if (c.kind === 'box') {
      const { lx, lz } = toLocal(c, pos.x, pos.z);
      const cx = clamp(lx, -c.hx, c.hx);
      const cz = clamp(lz, -c.hz, c.hz);
      let nx = lx - cx;
      let nz = lz - cz;
      let d = Math.hypot(nx, nz);
      let push: number;
      if (d > 1e-6) {
        if (d >= radius) return null;
        nx /= d;
        nz /= d;
        push = radius - d;
      } else {
        // centre inside the box: exit along the shallowest axis
        const px = c.hx - Math.abs(lx);
        const pz = c.hz - Math.abs(lz);
        if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; push = px + radius; }
        else { nx = 0; nz = Math.sign(lz) || 1; push = pz + radius; }
        d = 0;
      }
      const w = toWorldDir(c, nx, nz);
      pos.x += w.x * push;
      pos.z += w.z * push;
      return new Vector3(w.x, 0, w.z);
    }
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const min = c.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return null;
    const d = Math.sqrt(d2) || 1e-4;
    const push = min - d;
    pos.x += (dx / d) * push;
    pos.z += (dz / d) * push;
    return new Vector3(dx / d, 0, dz / d);
  }

  /**
   * Find a wall within `reach` of `pos` (horizontally) whose vertical span covers [yMin, yMax].
   * Optionally restrict to walls roughly facing `dir` (the normal opposes dir).
   * Used for wall-run and ledge grabs.
   */
  probeWall(pos: Vector3, reach: number, yMin: number, yMax: number, dir?: Vector3, minFacing = 0.3): WallHit | null {
    let best: WallHit | null = null;
    let bestD = Infinity;
    for (const c of this.colliders) {
      if (c.top === Infinity && c.kind !== 'box') continue;
      if (c.bottom > yMax || c.top < yMin) continue;
      let px: number, pz: number, nx: number, nz: number, d: number;
      if (c.kind === 'box') {
        const { lx, lz } = toLocal(c, pos.x, pos.z);
        const cx = clamp(lx, -c.hx, c.hx);
        const cz = clamp(lz, -c.hz, c.hz);
        let lnx = lx - cx;
        let lnz = lz - cz;
        d = Math.hypot(lnx, lnz);
        if (d < 1e-6) continue;
        lnx /= d;
        lnz /= d;
        const wp = toWorldDir(c, cx, cz);
        px = c.x + wp.x;
        pz = c.z + wp.z;
        const wn = toWorldDir(c, lnx, lnz);
        nx = wn.x;
        nz = wn.z;
      } else {
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const dc = Math.hypot(dx, dz) || 1e-4;
        nx = dx / dc;
        nz = dz / dc;
        d = dc - c.r;
        px = c.x + nx * c.r;
        pz = c.z + nz * c.r;
      }
      if (d > reach || d < -0.05) continue;
      if (dir && -(nx * dir.x + nz * dir.z) < minFacing) continue;
      if (d < bestD) {
        bestD = d;
        best = { collider: c, normal: new Vector3(nx, 0, nz), point: new Vector3(px, pos.y, pz), top: c.top };
      }
    }
    return best;
  }

  /** Is a point inside any collider volume (camera occlusion)? */
  pointBlocked(x: number, y: number, z: number, margin = 0.2): boolean {
    if (y < this.terrain.heightAt(x, z) + margin) return true;
    for (const c of this.colliders) {
      if (c.top === Infinity && c.kind !== 'box') continue; // ignore trees / dummies for the camera
      if (y < c.bottom - margin || y > c.top + margin) continue;
      if (this.contains2D(c, x, z, margin)) return true;
    }
    return false;
  }

  private activeTargets() {
    return this.targets.filter((t) => t.alive !== false);
  }

  /** Targets inside a horizontal cone in front of `origin`. */
  queryCone(origin: Vector3, forward: Vector3, range: number, arcDeg: number, verticalReach = 2.2): Hittable[] {
    const cosHalf = Math.cos(((arcDeg / 2) * Math.PI) / 180);
    return this.activeTargets().filter((t) => {
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
    return this.activeTargets().filter((t) => {
      const d = Math.hypot(t.position.x - center.x, t.position.z - center.z);
      return d <= radius + t.radius && Math.abs(t.position.y - center.y) < verticalReach;
    });
  }

  /** Nearest lockable target within range, preferring ones in front of `forward`. */
  nearestLockable(from: Vector3, forward: Vector3, range: number): Hittable | null {
    let best: Hittable | null = null;
    let bestScore = Infinity;
    for (const t of this.activeTargets()) {
      if (!t.lockable) continue;
      const dx = t.position.x - from.x;
      const dz = t.position.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d > range) continue;
      const facing = d > 0 ? (dx * forward.x + dz * forward.z) / d : 1;
      const score = d * (1.5 - facing);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function toLocal(c: BoxCollider, x: number, z: number) {
  const dx = x - c.x;
  const dz = z - c.z;
  const cs = Math.cos(c.yaw);
  const sn = Math.sin(c.yaw);
  return { lx: dx * cs - dz * sn, lz: dx * sn + dz * cs };
}

function toWorldDir(c: BoxCollider, lx: number, lz: number) {
  const cs = Math.cos(c.yaw);
  const sn = Math.sin(c.yaw);
  return { x: lx * cs + lz * sn, z: -lx * sn + lz * cs };
}
