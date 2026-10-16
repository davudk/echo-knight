import { PerspectiveCamera, Vector3 } from 'three';
import { CombatTuning, Tuning } from '../config/tuning';
import { clamp, damp, dampAngle, lerp } from '../core/math';
import type { World } from '../world/World';

const T = Tuning.camera;

/**
 * Orbit camera with damped follow, terrain collision, trauma-based shake and FOV kicks.
 * yaw = horizontal look direction, pitch = elevation of the camera above the pivot.
 */
export class ThirdPersonCamera {
  readonly camera: PerspectiveCamera;
  yaw = Math.PI; // looking toward -Z at start
  pitch = 0.32;

  private pivot = new Vector3();
  private distance: number = T.distance;
  /** current boom length (after collision) */
  get boomLength() {
    return this.distance;
  }
  private trauma = 0;
  private fovKick = 0;
  private recenterTarget: number | null = null;
  private time = 0;
  private readonly tmp = new Vector3();
  private readonly desired = new Vector3();

  /** Lock-on: world point to keep framed (set every frame by the lock-on controller), null = free. */
  lockPoint: Vector3 | null = null;
  /** horizontal look input accumulated while locked (target-switch flicks) */
  private flick = 0;
  private readonly lookAtPoint = new Vector3();

  constructor(
    aspect: number,
    private readonly world: World,
  ) {
    this.camera = new PerspectiveCamera(T.fov, aspect, 0.1, 900);
  }

  /** Forward vector on the ground plane. */
  forward(out = new Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  right(out = new Vector3()) {
    return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  snapTo(target: Vector3) {
    this.pivot.set(target.x, target.y + T.pivotHeight, target.z);
  }

  addLook(dx: number, dy: number) {
    if (this.lockPoint) {
      // Locked: the camera frames the target; horizontal input becomes target-switch flicks.
      this.flick += dx;
      return;
    }
    if (dx !== 0 || dy !== 0) this.recenterTarget = null;
    this.yaw -= dx;
    this.pitch = clamp(this.pitch + dy, T.pitchMin, T.pitchMax);
  }

  /** Swing behind the character (yaw = character facing). */
  recenter(facing: number) {
    this.recenterTarget = facing;
  }

  /** Accumulated horizontal flick since the last call (radians, + = right); decays over time. */
  takeFlick(threshold: number): number {
    if (Math.abs(this.flick) < threshold) return 0;
    const f = this.flick;
    this.flick = 0;
    return f;
  }

  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  kickFov(amount: number) {
    this.fovKick = Math.max(this.fovKick, amount);
  }

  update(target: Vector3, dt: number) {
    this.time += dt;
    this.flick *= Math.exp(-10 * dt);
    if (this.lockPoint) this.trackLock(target, dt);
    else if (this.recenterTarget !== null) {
      this.yaw = dampAngle(this.yaw, this.recenterTarget, 10, dt);
      if (Math.abs(this.yaw - this.recenterTarget) < 0.01) this.recenterTarget = null;
    }

    // Pivot: snappy horizontally, softer vertically so jumps don't yank the view.
    const kx = damp(T.followSharpness, dt);
    const ky = damp(T.verticalFollowSharpness, dt);
    this.pivot.x = lerp(this.pivot.x, target.x, kx);
    this.pivot.z = lerp(this.pivot.z, target.z, kx);
    this.pivot.y = lerp(this.pivot.y, target.y + T.pivotHeight, ky);
    // Never let the target escape the frame on big drops / teleports.
    const dy = target.y + T.pivotHeight - this.pivot.y;
    if (Math.abs(dy) > 3) this.pivot.y += dy - Math.sign(dy) * 3;

    const cp = Math.cos(this.pitch);
    const dir = this.tmp.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);

    // Collision: march along the boom and stop before terrain / buildings.
    // Fine steps (0.25 m) so thin walls are caught; with your back to a wall the camera may come
    // in very close (the character fades out, see Game) instead of ending up inside the wall.
    let maxD = T.distance;
    const steps = Math.ceil(T.distance / 0.25);
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * T.distance;
      const x = this.pivot.x + dir.x * d;
      const y = this.pivot.y + dir.y * d;
      const z = this.pivot.z + dir.z * d;
      if (this.world.pointBlocked(x, y, z, 0.3)) {
        maxD = Math.max(0.45, ((i - 1) / steps) * T.distance);
        break;
      }
    }
    // Pull in fast, ease out slowly.
    if (maxD < T.minDistance && maxD > 0.45) maxD = Math.min(T.minDistance, maxD);
    this.distance = maxD < this.distance ? lerp(this.distance, maxD, damp(30, dt)) : lerp(this.distance, maxD, damp(4, dt));

    this.desired.copy(this.pivot).addScaledVector(dir, this.distance);
    const minY = this.world.terrain.heightAt(this.desired.x, this.desired.z) + 0.3;
    if (this.desired.y < minY) this.desired.y = minY;

    // Shake (trauma^2 for a nice falloff).
    this.trauma = Math.max(0, this.trauma - dt * 2.2);
    const s = this.trauma * this.trauma;
    const t = this.time * 38;
    const ox = (Math.sin(t * 1.1) + Math.sin(t * 2.3) * 0.5) * 0.18 * s;
    const oy = (Math.sin(t * 1.7 + 1) + Math.sin(t * 3.1) * 0.5) * 0.18 * s;

    this.camera.position.copy(this.desired);
    // While locked, aim a little toward the target so both stay framed (launched targets too).
    this.lookAtPoint.copy(this.pivot);
    if (this.lockPoint) this.lookAtPoint.y += clamp((this.lockPoint.y - this.pivot.y) * 0.35, -0.6, 2.2);
    this.camera.lookAt(this.lookAtPoint);
    this.camera.position.x += ox * Math.cos(this.yaw);
    this.camera.position.y += oy;
    this.camera.position.z -= ox * Math.sin(this.yaw);

    this.fovKick = Math.max(0, this.fovKick - dt * 40);
    const fov = T.fov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private trackLock(player: Vector3, dt: number) {
    const L = CombatTuning.lockOn;
    const lp = this.lockPoint!;
    const dx = lp.x - player.x;
    const dz = lp.z - player.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.5) this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz) + L.yawOffset, L.sharpness, dt);
    // Lower the camera when the target is above us (juggles), raise it a touch when close.
    const elev = Math.atan2(lp.y - (player.y + T.pivotHeight), Math.max(2, d));
    const want = clamp(L.pitch - elev * 0.6 + (d < 3 ? 0.1 : 0), T.pitchMin, 0.8);
    this.pitch = lerp(this.pitch, want, damp(L.sharpness * 0.5, dt));
    this.recenterTarget = null;
  }
}
