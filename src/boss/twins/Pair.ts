import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { events } from '../../core/Events';
import type { Game } from '../../core/Game';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitResult } from '../../player/Player';
import type { HitInfo, Hittable } from '../../world/World';
import { createHologramMaterial } from '../../fx/HologramMaterial';
import type { ShaderMaterial } from 'three';
import { TelegraphColors } from '../Decals';
import { Difficulty } from '../difficulty';
import type { BossHitSpec, EffectOwner } from '../Hitboxes';
import type { AttackDef } from '../types';
import { isDamaging } from './attacks';
import { playTwinSound } from './sounds';
import type { Selene } from './Selene';
import type { TwinBoss } from './TwinBoss';
import type { Varek } from './Varek';

const tmp = new Vector3();
const tmp2 = new Vector3();
const CYAN = new Color(0.35, 1.1, 1.6);

/**
 * THE PAIR DIRECTOR — keeps the twins (and Selene's smoke clones) from making overlapping
 * unavoidable attacks:
 *
 *  - A DAMAGING attack (any hitbox) may only start when no other actor is "threatening" (a damaging
 *    step winding up / live, or its knives / shockwave still travelling) and the last finisher's
 *    short breather (`release`) has passed. Support moves (ward, heal, smoke, clone cast, blink)
 *    are always allowed — that is Selene's job while Varek presses.
 *  - Selene's ranged / melee attacks additionally wait for Varek to be recovering (final recovery,
 *    stagger, idle ≥ 1.4 s) or far from the player (> 7 m), unless the player is right on top of her.
 *  - The PINCER is the one deliberate double: both glow, Varek thrusts from the front and Selene
 *    (after blinking behind you) 0.55 s later from behind, both along the same axis — sidestep.
 *
 * Also owns the shared visuals: ward bubble, heal tether, smoke clouds, smoke clones.
 */
export class TwinPair {
  lockUntil = -1;
  lockOwner: unknown = null;
  pincerCooldown = 0;
  pincerActive = false;
  private pincerT = 0;
  fightTime = 0;

  // ward
  wardTimer = 0;
  private readonly bubble: Mesh;
  private readonly bubbleMat: MeshBasicMaterial;
  // heal tether
  private readonly beam: Mesh;
  private readonly beamMat: MeshBasicMaterial;
  // smoke clouds
  private readonly clouds: SmokeCloud[] = [];
  readonly clones: SmokeClone[] = [];

  constructor(
    readonly game: Game,
    readonly varek: Varek,
    readonly selene: Selene,
    cloneModels: CharacterModel[],
  ) {
    varek.pair = this;
    selene.pair = this;
    this.bubbleMat = new MeshBasicMaterial({ color: new Color(0.25, 0.8, 1.3), wireframe: false, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
    this.bubble = new Mesh(new IcosahedronGeometry(1, 2), this.bubbleMat);
    this.bubble.visible = false;
    game.scene.add(this.bubble);

    this.beamMat = new MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending });
    const bg = new CylinderGeometry(0.035, 0.035, 1, 6, 1, true);
    bg.rotateX(Math.PI / 2); // along +z
    this.beam = new Mesh(bg, this.beamMat);
    this.beam.visible = false;
    game.scene.add(this.beam);

    for (let i = 0; i < 2; i++) this.clouds.push(new SmokeCloud(game));
    for (const m of cloneModels) this.clones.push(new SmokeClone(game, this, m));
  }

  get actors(): { threatening(): boolean }[] {
    return [this.varek, this.selene, ...this.clones];
  }

  // ---------------------------------------------------------------- token
  mayStart(who: unknown, def: AttackDef) {
    if (!isDamaging(def)) return true;
    if (this.pincerActive && (def.id === 'v_pincer' || def.id === 's_pincer')) return true;
    if (this.pincerActive) return false;
    for (const a of this.actors) if (a !== who && a.threatening()) return false;
    if (this.game.time < this.lockUntil && this.lockOwner !== who) return false;
    if (who === this.selene && this.varek.alive && !this.selene.enraged) {
      const v = this.varek;
      const p = this.game.player.position;
      const varekFar = Math.hypot(p.x - v.feet.x, p.z - v.feet.z) > 7;
      const pressed = this.selene.distanceToPlayer() < 3;
      if (!varekFar && !pressed && !v.recovering()) return false;
    }
    return true;
  }

  /** A damaging attack finished its last active frame: the partner waits `gap` more seconds. */
  release(who: unknown, gap: number) {
    this.lockUntil = this.game.time + gap;
    this.lockOwner = who;
  }

  // ---------------------------------------------------------------- ward
  applyWard(seconds: number) {
    if (!this.varek.alive) return;
    this.wardTimer = seconds;
    this.varek.invulnerable = true;
    playTwinSound('twinWard', this.varek.position);
    this.game.hud.flash('Selene veils Varek — strike her to break the ward', 2.2);
    this.game.fx.sparks.emit({
      count: 40, position: this.varek.position, spread: 0.6, speed: 4, upBias: 0.5, life: [0.3, 0.7], size: [0.05, 0.14],
      color: TelegraphColors.magic, drag: 2,
    });
  }

  breakWard(reason: string) {
    if (this.wardTimer <= 0) return;
    this.wardTimer = 0;
    if (this.varek.state !== 'transition' && this.varek.state !== 'custom') this.varek.invulnerable = false;
    playTwinSound('twinWardBreak', this.varek.position);
    this.game.fx.sparks.emit({
      count: 50, position: this.varek.position, spread: 0.9, speed: 7, upBias: 0.3, life: [0.2, 0.6], size: [0.05, 0.14],
      color: TelegraphColors.magic, color2: new Color(2, 2, 2), gravity: 6, drag: 2,
    });
    this.game.hud.flash(reason, 1.6);
  }

  // ---------------------------------------------------------------- smoke / clones
  spawnSmoke(at: Vector3, radius = 3.2) {
    const c = this.clouds.find((k) => !k.active) ?? this.clouds[0];
    c.spawn(at, radius);
    playTwinSound('twinSmoke', at);
  }

  spawnClones() {
    const p = this.game.player.position;
    const s = this.selene;
    const base = Math.atan2(s.feet.x - p.x, s.feet.z - p.z);
    let k = 0;
    for (const c of this.clones) {
      const a = base + (k === 0 ? 2.1 : -2.1);
      tmp.set(p.x + Math.sin(a) * 7, 0, p.z + Math.cos(a) * 7);
      s.clampToArena(tmp);
      c.spawn(tmp, 1.2 + k * 1.6);
      this.spawnSmoke(tmp, 1.6);
      k++;
    }
    this.game.hud.flash('Smoke takes Selene’s shape', 1.6);
  }

  // ---------------------------------------------------------------- lifecycle
  onDefeated(who: TwinBoss) {
    const other = who === this.varek ? this.selene : this.varek;
    if (who === this.varek) this.breakWard('The ward fades');
    this.wardTimer = 0;
    for (const c of this.clones) if (who === this.selene) c.dispel(false);
    if (other.alive) {
      other.queueEnrage();
      this.game.hud.flash(other === this.varek ? 'Varek roars in fury' : 'Selene takes up Varek’s axe', 2.6);
    }
  }

  reset() {
    this.lockUntil = -1;
    this.lockOwner = null;
    this.pincerCooldown = 0;
    this.pincerActive = false;
    this.pincerT = 0;
    this.fightTime = 0;
    this.wardTimer = 0;
    this.bubble.visible = false;
    this.beam.visible = false;
    for (const c of this.clouds) c.clear();
    for (const c of this.clones) c.dispel(false);
  }

  // ---------------------------------------------------------------- pincer
  private tryPincer(dt: number) {
    const v = this.varek;
    const s = this.selene;
    this.pincerCooldown -= dt;
    if (this.pincerActive) {
      this.pincerT += dt;
      // ends once both are past their thrusts (or something interrupted them)
      const vBusy = v.state === 'attack' && v.runner.def?.id === 'v_pincer' && v.runner.phase !== 'recovery';
      const sBusy = (s.state === 'attack' && s.runner.def?.id === 's_pincer' && s.runner.phase !== 'recovery') || s.pendingPincer;
      if ((!vBusy && !sBusy && this.pincerT > 0.6) || this.pincerT > 5) {
        this.pincerActive = false;
        s.pendingPincer = false;
        this.release(null, 0.6);
      }
      return;
    }
    if (this.pincerCooldown > 0 || this.fightTime < 22) return;
    if (!v.alive || !s.alive || v.enraged || s.enraged || v.state !== 'idle' || s.state !== 'idle' || s.hidden) return;
    if (this.game.player.dead || this.game.time < this.lockUntil) return;
    if (v.threatening() || s.threatening() || this.clones.some((c) => c.threatening())) return;
    const d = v.distanceToPlayer();
    if (d < 2.6 || d > 7.5) return;
    // go
    this.pincerActive = true;
    this.pincerT = 0;
    this.pincerCooldown = (v.phase > 0 || s.phase > 0 ? 17 : 22) + Math.random() * 6;
    v.forceAttack('v_pincer');
    // Selene blinks to the far side of the player (same axis as Varek), then thrusts
    const p = this.game.player.position;
    tmp.set(p.x - v.feet.x, 0, p.z - v.feet.z).normalize();
    tmp2.set(p.x + tmp.x * 3.6, 0, p.z + tmp.z * 3.6);
    s.clampToArena(tmp2);
    s.pendingPincer = true;
    s.beginBlink(tmp2, 's_pincer');
    playTwinSound('twinPincer', this.game.player.position);
    this.game.hud.flash('The Twins close in!', 1.4);
  }

  // ---------------------------------------------------------------- frame
  update(dt: number) {
    const v = this.varek;
    const s = this.selene;
    const fighting = v.engaged && (v.alive || s.alive) && v.state !== 'dormant';
    if (fighting) this.fightTime += dt;
    if (fighting) this.tryPincer(dt);

    // ward
    if (this.wardTimer > 0) {
      this.wardTimer -= dt;
      if (!v.alive) this.wardTimer = 0;
      else v.invulnerable = true;
      if (this.wardTimer <= 0 && v.alive) {
        this.wardTimer = 0;
        if (v.state !== 'transition' && v.state !== 'custom') v.invulnerable = false;
        playTwinSound('twinWardBreak', v.position, 0.5);
      }
    }
    const showBubble = this.wardTimer > 0;
    this.bubble.visible = showBubble;
    if (showBubble) {
      const t = this.game.time;
      const r = v.def.height * 0.62;
      this.bubble.position.set(v.feet.x, v.feet.y + v.def.height * 0.5, v.feet.z);
      this.bubble.scale.set(r * 0.85, r, r * 0.85);
      this.bubble.rotation.y = t * 0.6;
      const ending = this.wardTimer < 1 ? 0.5 + 0.5 * Math.sin(t * 30) : 1;
      this.bubbleMat.opacity = (0.09 + 0.03 * Math.sin(t * 6)) * ending;
    }

    // heal tether
    const healing = s.channelingHeal && v.alive;
    this.beam.visible = healing;
    if (healing) {
      tmp.set(s.feet.x, s.feet.y + s.def.height * 0.62, s.feet.z);
      tmp2.set(v.feet.x, v.feet.y + v.def.height * 0.55, v.feet.z);
      const len = tmp.distanceTo(tmp2);
      this.beam.position.copy(tmp).lerp(tmp2, 0.5);
      this.beam.lookAt(tmp2);
      this.beam.scale.set(1 + 0.3 * Math.sin(this.game.time * 20), 1, len);
      if (Math.random() < 0.5) {
        const u = Math.random();
        this.game.fx.sparks.emit({
          count: 1, position: tmp.clone().lerp(tmp2, u), spread: 0.1, speed: 0.6, life: [0.2, 0.4], size: [0.06, 0.12],
          color: TelegraphColors.magic, drag: 2,
        });
      }
    }

    for (const c of this.clouds) c.update(dt);
    for (const c of this.clones) c.update(dt);
  }
}

// ==================================================================== smoke cloud
class SmokeCloud {
  active = false;
  private t = 0;
  private readonly group = new Group();
  private readonly mat: MeshStandardMaterial;
  private readonly puffs: Mesh[] = [];
  private readonly seeds: number[] = [];
  private radius = 3;

  constructor(private readonly game: Game) {
    this.mat = new MeshStandardMaterial({
      color: new Color(0.66, 0.67, 0.7), emissive: new Color(0.12, 0.13, 0.15), roughness: 1, transparent: true, opacity: 0, depthWrite: false,
    });
    const geo = new IcosahedronGeometry(1, 1);
    for (let i = 0; i < 12; i++) {
      const m = new Mesh(geo, this.mat);
      this.puffs.push(m);
      this.seeds.push(Math.random() * 10);
      this.group.add(m);
    }
    this.group.visible = false;
    game.scene.add(this.group);
  }

  spawn(at: Vector3, radius: number) {
    this.active = true;
    this.t = 0;
    this.radius = radius;
    this.group.position.set(at.x, this.game.world.groundAt(at.x, at.z, at.y + 1), at.z);
    this.group.visible = true;
    this.game.fx.dustPuff(this.group.position, 30, 5, [0.6, 1.3]);
  }

  clear() {
    this.active = false;
    this.group.visible = false;
  }

  update(dt: number) {
    if (!this.active) return;
    this.t += dt;
    const life = 3.6;
    const t = this.t;
    const grow = Math.min(1, t / 0.35);
    const fade = t > life - 1 ? Math.max(0, (life - t) / 1) : 1;
    this.mat.opacity = 0.42 * fade;
    for (let i = 0; i < this.puffs.length; i++) {
      const m = this.puffs[i];
      const sd = this.seeds[i];
      const a = (i / this.puffs.length) * Math.PI * 2 + sd;
      const rr = this.radius * (0.25 + 0.5 * ((i * 0.37) % 1)) * grow;
      m.position.set(Math.sin(a + t * 0.3) * rr, 0.6 + ((i * 0.53) % 1) * 1.6 + t * 0.15, Math.cos(a + t * 0.3) * rr);
      const s = (0.7 + ((i * 0.71) % 1) * 0.6) * grow * (1 + t * 0.15) * Math.min(1.2, this.radius / 2.6);
      m.scale.setScalar(s);
      m.rotation.set(sd + t * 0.4, sd * 2 + t * 0.2, 0);
    }
    if (t >= life) this.clear();
  }
}

// ==================================================================== smoke clone
/**
 * A hologram copy of Selene (enraged phase): appears in smoke, winds up a GOLD knife throw
 * (reflectable) twice, then dissolves. One hit — or its own reflected knife — dispels it.
 * Its throws go through the pair token like the twins' own attacks.
 */
class SmokeClone implements Hittable, EffectOwner {
  readonly id = 'selene-clone';
  readonly position = new Vector3();
  readonly radius = 0.55;
  readonly lockable = false;
  alive = false;
  private readonly feet = new Vector3();
  private facing = 0;
  private state: 'off' | 'appear' | 'wait' | 'windup' | 'recover' | 'fade' = 'off';
  private t = 0;
  private delay = 0;
  private throws = 0;
  private life = 0;
  private threatTill = -1;
  private readonly mat: ShaderMaterial;

  constructor(
    private readonly game: Game,
    private readonly pair: TwinPair,
    private readonly model: CharacterModel,
  ) {
    this.mat = createHologramMaterial(new Color(0.6, 0.9, 1.3));
    this.mat.uniforms.uFill.value = 0.25;
    model.model.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.material = this.mat;
        m.castShadow = false;
        m.frustumCulled = false;
      }
    });
    model.root.visible = false;
    game.scene.add(model.root);
    game.world.targets.push(this);
  }

  threatening() {
    return this.alive && (this.state === 'windup' || this.game.time < this.threatTill);
  }

  spawn(at: Vector3, delay: number) {
    this.alive = true;
    this.feet.set(at.x, this.game.world.groundAt(at.x, at.z), at.z);
    this.state = 'appear';
    this.t = 0;
    this.delay = delay;
    this.throws = 0;
    this.life = 0;
    this.model.root.visible = true;
    this.model.play('Idle', { fade: 0 });
    playTwinSound('twinClone', this.feet);
  }

  dispel(fx = true) {
    if (!this.alive && this.state === 'off') return;
    if (fx) {
      this.game.fx.sparks.emit({
        count: 30, position: this.position, spread: 0.5, speed: 3, upBias: 0.6, life: [0.3, 0.7], size: [0.05, 0.12],
        color: TelegraphColors.magic, drag: 2,
      });
      this.game.fx.dustPuff(this.feet, 14, 2);
      playTwinSound('twinClone', this.feet, 0.6);
    }
    this.alive = false;
    this.state = fx ? 'fade' : 'off';
    this.t = 0;
    this.threatTill = -1;
    if (!fx) this.model.root.visible = false;
    this.game.bosses.effects.clear(this);
  }

  // Hittable
  onHit(_info: HitInfo) {
    if (this.alive) this.dispel(true);
  }

  // EffectOwner: knives hit through Selene (difficulty scaling, parry handling)
  hitPlayer(spec: BossHitSpec): HitResult {
    return this.pair.selene.hitPlayer(spec);
  }

  onReflectHit(_damage: number, _poise: number, _at: Vector3) {
    this.dispel(true);
  }

  update(dt: number) {
    if (this.state === 'off') return;
    const g = this.game;
    this.t += dt;
    this.life += dt;
    const p = g.player.position;
    this.facing = Math.atan2(p.x - this.feet.x, p.z - this.feet.z);
    this.position.set(this.feet.x, this.feet.y + 1.4, this.feet.z);
    this.model.root.position.copy(this.feet);
    this.model.root.rotation.y = this.facing;
    this.model.update(dt);
    this.mat.uniforms.uTime.value = g.time;
    const base = new Color(0.6, 0.9, 1.3);
    let op = 1;

    switch (this.state) {
      case 'appear':
        op = Math.min(1, this.t / 0.4);
        if (this.t >= 0.4) this.go('wait');
        break;
      case 'wait':
        if (this.t >= this.delay && !g.player.dead && this.pair.mayStart(this, CLONE_THROW)) {
          this.go('windup');
          this.model.play('Throw', { fade: 0.1, loop: false, restart: true, startAt: 0.1, speed: 0.5 / (0.95 * Difficulty.telegraph()) });
          g.fx.sparks.emit({ count: 1, position: this.position, speed: 0, life: [0.3, 0.3], size: [1.2, 1.2], color: TelegraphColors.parryable });
          events.emit('boss:attack', { id: 'selene', attackId: 'clone_knife', step: 0, telegraph: 'parryable', windup: 0.95, position: this.position.clone() });
        }
        if (this.life > 10) this.dispel(true);
        break;
      case 'windup': {
        const w = 0.95 * Difficulty.telegraph();
        base.lerp(TelegraphColors.parryable, Math.min(1, this.t / w) * 0.8);
        if (this.t >= w) {
          this.fire();
          this.throws++;
          this.threatTill = g.time + 0.8;
          this.pair.release(this, 0.4);
          this.go('recover');
        }
        break;
      }
      case 'recover':
        if (this.t >= 1.0) {
          if (this.throws >= 2) this.dispel(true);
          else {
            this.delay = 1.2;
            this.go('wait');
            this.model.play('Idle', { fade: 0.2 });
          }
        }
        break;
      case 'fade':
        op = Math.max(0, 1 - this.t / 0.5);
        if (this.t >= 0.5) {
          this.state = 'off';
          this.model.root.visible = false;
        }
        break;
      default:
        break;
    }
    (this.mat.uniforms.uColor.value as Color).copy(base);
    this.mat.uniforms.uOpacity.value = op;
  }

  private go(s: SmokeClone['state']) {
    this.state = s;
    this.t = 0;
  }

  private fire() {
    const p = this.game.player.position;
    const origin = tmp.set(this.feet.x + Math.sin(this.facing) * 0.6, this.feet.y + 1.5, this.feet.z + Math.cos(this.facing) * 0.6);
    const hd = Math.hypot(p.x - origin.x, p.z - origin.z);
    const pitch = Math.atan2(p.y + 1.0 - origin.y, hd);
    const cp = Math.cos(pitch);
    const dir = tmp2.set(Math.sin(this.facing) * cp, Math.sin(pitch), Math.cos(this.facing) * cp);
    this.game.bosses.effects.spawnProjectile({
      owner: this, position: origin, direction: dir, speed: 16, homing: 0.3, lifetime: 2.2, radius: 0.2,
      damage: 9, knockback: 3, telegraph: 'parryable', reflectable: true, reflectDamage: 1, reflectPoise: 0,
    });
  }
}

/** token key for clone throws (damaging) */
const CLONE_THROW: AttackDef = {
  id: 'clone_knife', telegraph: 'parryable',
  steps: [{ windup: 0.95, active: 0.1, recovery: 1, hitboxes: [{ shape: 'projectile', speed: 16 }], damage: 9 }],
};
