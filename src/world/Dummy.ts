import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { HitInfo, Hittable } from './World';

export interface DummyHooks {
  onHit(d: Dummy, info: HitInfo): void;
}

/** Straw training dummy on a post. Wobbles and flashes when struck. */
export class Dummy implements Hittable {
  readonly root = new Group();
  readonly position = new Vector3();
  readonly radius = 0.55;
  private readonly body = new Group();
  private readonly mats: MeshStandardMaterial[] = [];
  private tilt = new Vector3(); // x/z = tilt angles
  private tiltVel = new Vector3();
  private flash = 0;

  constructor(
    x: number,
    groundY: number,
    z: number,
    private readonly hooks: DummyHooks,
  ) {
    const wood = new MeshStandardMaterial({ color: '#5b4330', roughness: 1, flatShading: true });
    const straw = new MeshStandardMaterial({ color: '#c9a55f', roughness: 1, flatShading: true });
    const cloth = new MeshStandardMaterial({ color: '#7a2f2a', roughness: 1, flatShading: true });
    this.mats.push(straw, cloth);

    const post = new Mesh(new CylinderGeometry(0.09, 0.12, 1.0, 6), wood);
    post.position.y = 0.5;
    const torso = new Mesh(new CylinderGeometry(0.36, 0.3, 0.95, 8), straw);
    torso.position.y = 1.35;
    const sash = new Mesh(new CylinderGeometry(0.375, 0.375, 0.16, 8), cloth);
    sash.position.y = 1.2;
    const head = new Mesh(new SphereGeometry(0.27, 8, 6), straw);
    head.position.y = 2.05;
    const arms = new Mesh(new BoxGeometry(1.5, 0.14, 0.14), wood);
    arms.position.y = 1.6;
    this.body.add(torso, sash, head, arms);
    this.root.add(post, this.body);
    this.body.position.y = 0.9;
    for (const m of [torso, sash, head, arms]) m.position.y -= 0.9;
    this.root.traverse((o) => {
      if ((o as Mesh).isMesh) o.castShadow = o.receiveShadow = true;
    });

    this.root.position.set(x, groundY, z);
    this.root.rotation.y = Math.random() * Math.PI * 2;
    this.position.set(x, groundY + 1.1, z);
  }

  onHit(info: HitInfo) {
    const k = info.heavy ? 7 : 4;
    // Angular kick: tilt away from the hit direction.
    this.tiltVel.x += info.dir.z * k;
    this.tiltVel.z += -info.dir.x * k;
    this.flash = 1;
    this.hooks.onHit(this, info);
  }

  update(dt: number) {
    // Damped spring back to upright.
    const stiffness = 90;
    const damping = 7;
    this.tiltVel.x += (-stiffness * this.tilt.x - damping * this.tiltVel.x) * dt;
    this.tiltVel.z += (-stiffness * this.tilt.z - damping * this.tiltVel.z) * dt;
    this.tilt.addScaledVector(this.tiltVel, dt);
    // tilt is in world space; convert into the root's local frame
    const ry = this.root.rotation.y;
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    this.body.rotation.x = this.tilt.x * c - this.tilt.z * s;
    this.body.rotation.z = this.tilt.x * s + this.tilt.z * c;

    this.flash = Math.max(0, this.flash - dt * 8);
    const e = this.flash * this.flash;
    for (const m of this.mats) m.emissive.copy(FLASH).multiplyScalar(e);
  }
}

const FLASH = new Color(0.55, 0.42, 0.3);
