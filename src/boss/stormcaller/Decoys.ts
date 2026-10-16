import { Color, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { playSfx } from '../../audio/audioFeature';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitResult } from '../../player/Player';
import type { HitInfo, Hittable } from '../../world/World';
import type { Boss } from '../Boss';
import type { BossHitSpec, EffectOwner, Projectile } from '../Hitboxes';
import type { Perch } from './arena';
import { LIGHTNING, type BoltMarkers } from './storm';

const tmp = new Vector3();
const tmp2 = new Vector3();
const GLASS = new Color(1.4, 2.2, 3.0);

/**
 * A mirror image of the Stormcaller. Looks like her (same model + tint) but has no glowing eyes
 * and glitches every ~1.5 s (the tells). Casts weaker fake bolts. One hit — or one of its own
 * bolts parried back — shatters it.
 */
export class Decoy implements Hittable, EffectOwner {
  readonly id: string;
  readonly position = new Vector3();
  readonly feet = new Vector3();
  readonly radius = 0.6;
  alive = false;
  readonly lockable = true;
  facing = 0;
  private glitch = 0;
  private nextGlitch = 1.2;
  private appear = 0;
  private readonly mats: MeshStandardMaterial[] = [];

  constructor(readonly owner: Mirrors, readonly boss: Boss, readonly model: CharacterModel) {
    this.id = boss.id;
    const cache = new Map<unknown, MeshStandardMaterial>();
    model.model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const src = m.material as MeshStandardMaterial;
      let mat = cache.get(src);
      if (!mat) {
        mat = src.clone();
        if (boss.def.tint) mat.color.multiply(boss.def.tint);
        mat.emissive = new Color(0.02, 0.05, 0.08);
        mat.transparent = true;
        cache.set(src, mat);
        this.mats.push(mat);
      }
      m.material = mat;
    });
    model.root.visible = false;
    boss.game.scene.add(model.root);
  }

  get height() {
    return this.boss.def.height;
  }

  show(p: Perch) {
    this.alive = true;
    this.appear = 0;
    this.moveTo(p);
    this.model.root.visible = true;
    this.model.play('Idle', { fade: 0.1 });
  }

  moveTo(p: Perch) {
    this.feet.set(p.x, p.y, p.z);
    this.position.set(p.x, p.y + this.height * 0.55, p.z);
    this.appear = 0;
  }

  // -------------------------------------------------------------- EffectOwner (fake bolts)
  hitPlayer(spec: BossHitSpec): HitResult {
    const d = spec.damage;
    spec.damage = Math.max(1, Math.round(d * 0.5));
    const res = this.boss.hitPlayer(spec);
    spec.damage = d;
    return res;
  }

  onReflectHit(_damage: number, _poise: number, _at: Vector3) {
    this.owner.shatter(this, true);
  }

  // -------------------------------------------------------------- Hittable
  onHit(_info: HitInfo) {
    if (this.alive) this.owner.shatter(this, true);
  }

  update(dt: number, time: number) {
    if (!this.alive) return;
    const p = this.boss.game.player.position;
    const want = Math.atan2(p.x - this.feet.x, p.z - this.feet.z);
    let d = want - this.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.facing += Math.max(-4 * dt, Math.min(4 * dt, d));
    this.appear = Math.min(1, this.appear + dt * 4);
    this.nextGlitch -= dt;
    if (this.nextGlitch <= 0) {
      this.glitch = 0.12;
      this.nextGlitch = 1.1 + Math.random() * 0.9;
    }
    this.glitch = Math.max(0, this.glitch - dt);
    const g = this.glitch > 0;
    const r = this.model.root;
    r.position.set(this.feet.x + (g ? (Math.random() - 0.5) * 0.25 : 0), this.feet.y + 0.35 + Math.sin(time * 2.1 + this.facing) * 0.08, this.feet.z);
    r.rotation.y = this.facing;
    r.scale.set(1, this.appear, 1);
    const op = g ? 0.35 : 1;
    for (const m of this.mats) m.opacity = op;
    this.model.update(dt);
  }

  hide() {
    this.alive = false;
    this.model.root.visible = false;
  }
}

/** The mirror-image mechanic (phase 2+): two decoys mimic her casts until revealed or shattered. */
export class Mirrors {
  readonly decoys: Decoy[] = [];
  private timer = 0;
  private time = 0;

  constructor(private readonly boss: Boss, models: CharacterModel[], private readonly markers: BoltMarkers) {
    for (const m of models) this.decoys.push(new Decoy(this, boss, m));
  }

  get active() {
    return this.decoys.some((d) => d.alive);
  }

  get owners(): readonly EffectOwner[] {
    return this.decoys;
  }

  spawn(perches: Perch[], duration: number) {
    for (let i = 0; i < this.decoys.length && i < perches.length; i++) {
      this.decoys[i].show(perches[i]);
      this.burst(this.decoys[i].position, false);
    }
    this.timer = duration;
  }

  /** decoys copy her cast animation */
  cast(clip: string) {
    for (const d of this.decoys) if (d.alive) d.model.play(clip, { fade: 0.1, loop: false, restart: true });
  }

  idle() {
    for (const d of this.decoys) if (d.alive) d.model.play('Idle', { fade: 0.25 });
  }

  /** every decoy fires a (weaker) reflectable bolt at the player */
  fire(speed: number, count = 1, spread = 0) {
    const p = this.boss.game.player.position;
    for (const d of this.decoys) {
      if (!d.alive) continue;
      const o = tmp.set(d.feet.x + Math.sin(d.facing) * 0.9, d.feet.y + d.height * 0.78, d.feet.z + Math.cos(d.facing) * 0.9);
      for (let i = 0; i < count; i++) {
        const yaw = Math.atan2(p.x - o.x, p.z - o.z) + (count > 1 ? ((i / (count - 1)) - 0.5) * spread : 0);
        const hd = Math.hypot(p.x - o.x, p.z - o.z);
        const pitch = Math.atan2(p.y + 1 - o.y, hd);
        tmp2.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
        const shot: Projectile = this.boss.game.bosses.effects.spawnProjectile({
          owner: d, position: o, direction: tmp2, speed, homing: 0.5, lifetime: 3, radius: 0.3, damage: 16,
          telegraph: 'magic', reflectable: true, reflectDamage: 0, reflectPoise: 0,
        });
        this.markers.track(shot);
      }
    }
  }

  moveTo(perches: Perch[]) {
    let k = 0;
    for (const d of this.decoys) {
      if (!d.alive || k >= perches.length) continue;
      this.burst(d.position, false);
      d.moveTo(perches[k++]);
      this.burst(d.position, false);
    }
  }

  private burst(at: Vector3, shatter: boolean) {
    const fx = this.boss.game.fx;
    fx.sparks.emit({
      count: shatter ? 46 : 18, position: at, spread: shatter ? 0.5 : 0.3, speed: shatter ? 7 : 3, upBias: 0.6,
      life: [0.2, 0.7], size: [0.05, 0.14], color: shatter ? GLASS : LIGHTNING.cyan, color2: LIGHTNING.violet, gravity: shatter ? 8 : -1, drag: 2,
    });
  }

  shatter(d: Decoy, sound: boolean) {
    if (!d.alive) return;
    this.burst(d.position, true);
    this.boss.game.bosses.effects.clear(d);
    d.hide();
    if (sound) playSfx('stormOrb', { pos: d.position, variant: 'glass' });
  }

  /** remove every decoy (revealed / timeout / reset) */
  dismiss(shatter: boolean) {
    if (!this.active) return;
    for (const d of this.decoys) {
      if (!d.alive) continue;
      if (shatter) this.shatter(d, false);
      else {
        this.boss.game.bosses.effects.clear(d);
        d.hide();
      }
    }
    if (shatter) playSfx('stormOrb', { pos: this.boss.position, variant: 'glass' });
  }

  update(dt: number) {
    this.time += dt;
    if (this.active) {
      this.timer -= dt;
      if (this.timer <= 0) this.dismiss(true);
    }
    for (const d of this.decoys) d.update(dt, this.time);
  }

  dispose() {
    for (const d of this.decoys) {
      this.boss.game.bosses.effects.clear(d);
      this.boss.game.scene.remove(d.model.root);
    }
  }
}
