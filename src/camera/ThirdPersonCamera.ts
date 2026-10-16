import { PerspectiveCamera, Vector3 } from 'three';
import { Tuning } from '../config/tuning';
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
  private trauma = 0;
  private fovKick = 0;
  private recenterTarget: number | null = null;
  private time = 0;
  private readonly tmp = new Vector3();
  private readonly desired = new Vector3();

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
    if (dx !== 0 || dy !== 0) this.recenterTarget = null;
    this.yaw -= dx;
    this.pitch = clamp(this.pitch + dy, T.pitchMin, T.pitchMax);
  }

  /** Swing behind the character (yaw = character facing). */
  recenter(facing: number) {
    this.recenterTarget = facing;
  }

  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  kickFov(amount: number) {
    this.fovKick = Math.max(this.fovKick, amount);
  }

  update(target: Vector3, dt: number) {
    this.time += dt;
    if (this.recenterTarget !== null) {
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
    let maxD = T.distance;
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * T.distance;
      const x = this.pivot.x + dir.x * d;
      const y = this.pivot.y + dir.y * d;
      const z = this.pivot.z + dir.z * d;
      if (this.world.pointBlocked(x, y, z, 0.3)) {
        maxD = Math.max(T.minDistance, ((i - 1) / steps) * T.distance);
        break;
      }
    }
    // Pull in fast, ease out slowly.
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
    this.camera.lookAt(this.pivot.x, this.pivot.y, this.pivot.z);
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
}
