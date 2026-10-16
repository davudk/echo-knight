import {
  AdditiveBlending,
  Color,
  DodecahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Game } from '../../core/Game';
import type { Decal } from '../Decals';
import { TelegraphColors } from '../Decals';
import type { BossHitSpec, EffectOwner } from '../Hitboxes';
import { PLAYER_RADIUS } from '../Hitboxes';

/**
 * Colossus-only effects that the framework's ground ring can't express:
 *  - BellWave: a SPHERICAL cyan shell from the bell — it reaches climbers on the body and on ruins,
 *    not just the ground. Block it (magic: chip), roll through it (i-frames) or be out of reach.
 *  - Debris: rubble shaken loose from its body; a red decal fills under each rock until it lands.
 */

const spec: BossHitSpec = {
  damage: 0, knockback: 0, heavy: true, telegraph: 'magic', parryable: false, unblockable: false, from: new Vector3(),
};

class Wave {
  active = false;
  readonly c = new Vector3();
  r = 0;
  speed = 0;
  max = 0;
  thick = 1.4;
  damage = 0;
  knockback = 0;
  hit = false;
  decal: Decal | null = null;
  readonly mesh: Mesh;
  readonly mat: MeshBasicMaterial;
  constructor(geo: SphereGeometry) {
    this.mat = new MeshBasicMaterial({
      color: TelegraphColors.magic.clone().multiplyScalar(0.35), transparent: true, opacity: 0.3, blending: AdditiveBlending,
      depthWrite: false, wireframe: true,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }
}

interface Rock {
  active: boolean;
  x: number;
  z: number;
  gy: number;
  /** seconds until impact */
  left: number;
  total: number;
  radius: number;
  damage: number;
  decal: Decal | null;
  mesh: Mesh;
}

const FALL = 0.85;
const DROP = 13;

export class ColossusEffects {
  private readonly waves: Wave[] = [];
  private readonly rocks: Rock[] = [];
  private readonly sphere = new SphereGeometry(1, 20, 12);
  private readonly rockGeo = new DodecahedronGeometry(0.75, 0);
  private readonly rockMat = new MeshStandardMaterial({ color: '#7d766b', flatShading: true, roughness: 1 });
  onRockLand: (at: Vector3) => void = () => {};

  constructor(private readonly game: Game, private readonly owner: EffectOwner) {}

  // ---------------------------------------------------------------- bell wave
  wave(at: Vector3, o: { speed: number; max: number; damage: number; knockback: number; thick?: number }) {
    let w = this.waves.find((x) => !x.active);
    if (!w) {
      w = new Wave(this.sphere);
      this.game.scene.add(w.mesh);
      this.waves.push(w);
    }
    w.active = true;
    w.c.copy(at);
    w.r = 0.8;
    w.speed = o.speed;
    w.max = o.max;
    w.thick = o.thick ?? 1.4;
    w.damage = o.damage;
    w.knockback = o.knockback;
    w.hit = false;
    w.mesh.visible = true;
    w.decal = this.game.bosses.decals.acquire().tint('magic');
    w.decal.fill = 1;
    return w;
  }

  // ---------------------------------------------------------------- debris
  rock(x: number, z: number, impactIn: number, radius: number, damage: number) {
    let r = this.rocks.find((k) => !k.active);
    if (!r) {
      const mesh = new Mesh(this.rockGeo, this.rockMat);
      mesh.castShadow = true;
      mesh.visible = false;
      this.game.scene.add(mesh);
      r = { active: false, x: 0, z: 0, gy: 0, left: 0, total: 0, radius: 0, damage: 0, decal: null, mesh };
      this.rocks.push(r);
    }
    r.active = true;
    r.x = x;
    r.z = z;
    r.gy = this.game.world.terrain.heightAt(x, z);
    r.left = impactIn;
    r.total = impactIn;
    r.radius = radius;
    r.damage = damage;
    r.decal = this.game.bosses.decals.acquire().tint('unblockable').circle(x, r.gy, z, radius);
    r.decal.fill = 0;
    r.mesh.visible = false;
    r.mesh.scale.setScalar(radius * 0.55);
    return r;
  }

  clear() {
    for (const w of this.waves) this.killWave(w);
    for (const r of this.rocks) this.killRock(r);
  }

  private killWave(w: Wave) {
    w.active = false;
    w.mesh.visible = false;
    w.decal?.release(0.2);
    w.decal = null;
  }

  private killRock(r: Rock) {
    r.active = false;
    r.mesh.visible = false;
    r.decal?.release(0.25);
    r.decal = null;
  }

  update(dt: number) {
    const p = this.game.player;
    for (const w of this.waves) {
      if (!w.active) continue;
      w.r += w.speed * dt;
      const k = w.r / w.max;
      w.mesh.position.copy(w.c);
      w.mesh.scale.setScalar(w.r);
      w.mesh.rotation.y += dt * 0.6;
      w.mat.opacity = 0.32 * (1 - k * k);
      // ground footprint of the shell
      const gy = this.game.world.terrain.heightAt(w.c.x, w.c.z);
      const h = w.c.y - gy;
      const gr = w.r > h ? Math.sqrt(w.r * w.r - h * h) : 0;
      if (w.decal) {
        w.decal.ring(w.c.x, gy, w.c.z, Math.max(0.1, gr), Math.min(w.thick, Math.max(0.1, gr)));
        w.decal.alpha = gr > 0 ? 1 - k * 0.6 : 0;
      }
      if (!w.hit && !p.dead && this.owner.alive) {
        const dx = p.position.x - w.c.x;
        const dz = p.position.z - w.c.z;
        // nearest point of the player's capsule to the centre
        const cy = Math.max(p.position.y + 0.2, Math.min(p.position.y + 1.6, w.c.y));
        const d = Math.hypot(dx, cy - w.c.y, dz);
        if (Math.abs(d - w.r) < w.thick / 2 + PLAYER_RADIUS) {
          spec.damage = w.damage;
          spec.knockback = w.knockback;
          spec.telegraph = 'magic';
          spec.parryable = false;
          spec.unblockable = false;
          spec.heavy = true;
          spec.from.copy(w.c);
          const res = this.owner.hitPlayer(spec);
          if (res === 'hit' || res === 'blocked' || res === 'parried') w.hit = true;
          if (res === 'hit') p.velocity.y = Math.max(p.velocity.y, 4.5);
        }
      }
      if (w.r >= w.max) this.killWave(w);
    }

    for (const r of this.rocks) {
      if (!r.active) continue;
      r.left -= dt;
      if (r.decal) r.decal.fill = Math.min(1, 1 - r.left / r.total);
      if (r.left < FALL) {
        const u = 1 - Math.max(0, r.left) / FALL;
        r.mesh.visible = true;
        r.mesh.position.set(r.x, r.gy + DROP * (1 - u * u) + r.radius * 0.3, r.z);
        r.mesh.rotation.x += dt * 4;
        r.mesh.rotation.z += dt * 3;
      }
      if (r.left <= 0) {
        const at = new Vector3(r.x, r.gy, r.z);
        this.game.fx.slam(at, r.radius * 1.2);
        this.game.fx.dustPuff(at, 16, 3);
        this.onRockLand(at);
        if (!p.dead && Math.hypot(p.position.x - r.x, p.position.z - r.z) <= r.radius + PLAYER_RADIUS && p.position.y - r.gy < 2.4) {
          spec.damage = r.damage;
          spec.knockback = 7;
          spec.telegraph = 'unblockable';
          spec.parryable = false;
          spec.unblockable = true;
          spec.heavy = true;
          spec.from.copy(at);
          this.owner.hitPlayer(spec);
        }
        r.decal && (r.decal.flash = 1);
        this.killRock(r);
      }
    }
  }
}

export const CRACK_GLOW = new Color(3.2, 1.6, 0.5);
