import { Color, Mesh, MeshBasicMaterial, ShaderMaterial, Vector3 } from 'three';
import type { Game } from '../../core/Game';
import { createHologramMaterial } from '../../fx/HologramMaterial';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitResult } from '../../player/Player';
import type { HitInfo } from '../../world/World';
import { Boss, type BossDef } from '../Boss';
import { TelegraphColors } from '../Decals';
import type { BossHitSpec } from '../Hitboxes';

/** The Warden's echo palette (void violet). */
export const VOID = new Color(0.75, 0.35, 1.8);
export const VOID_BRIGHT = new Color(1.6, 0.9, 3.0);
const tmpC = new Color();
const tmp = new Vector3();

export type EchoRole = 'ambush' | 'mimic' | 'decoy' | 'storm' | 'swap' | 'dissolve';

/** What the Warden must provide to its echoes. */
export interface EchoMaster {
  onEchoShattered(echo: WardenEcho, cause: 'hit' | 'parry' | 'counter' | 'reflect'): void;
}

/**
 * A hologram copy of the Warden (void-violet) that can play any of his attacks with real
 * hitboxes, telegraphs and decals — it is a `Boss` driven by the Warden instead of the director:
 *  - not in `game.bosses.list` (no HUD bar, not lockable), updated by the Warden,
 *  - a world target while visible: ANY player hit (sword, plunge, echo shockwave) shatters it,
 *    and so does parrying / countering one of its swings; the Warden then takes poise damage,
 *  - its hits deal `damageMul` of the Warden's.
 */
export class WardenEcho extends Boss {
  active = false;
  role: EchoRole = 'mimic';
  /** seconds left before it fades on its own (Infinity = until told) */
  life = Infinity;
  /** materialise / fade 0..1 */
  private opacity = 0;
  private fading = false;
  private idleClip = '2H_Melee_Idle';
  private readonly holo: ShaderMaterial;
  damageMul = 0.8;
  /** extra glow (storm turn marker, ambush charge) 0..1 */
  charge = 0;

  constructor(game: Game, def: BossDef, model: CharacterModel, private readonly master: EchoMaster) {
    super(game, def, model);
    // never a lock-on target (Boss declares `lockable = true`)
    (this as unknown as { lockable: boolean }).lockable = false;
    this.holo = createHologramMaterial(VOID.clone());
    this.holo.uniforms.uFill.value = 0.2;
    model.model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      if (m.material instanceof MeshBasicMaterial) return; // the glowing eyes stay
      m.material = this.holo;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
    });
    model.root.visible = false;
    this.alive = false;
  }

  /** Materialise at (x, z) facing `facing` (y = surface under it). */
  appear(x: number, z: number, facing: number, role: EchoRole, opts: { life?: number; clip?: string; y?: number } = {}) {
    this.runner.cancel();
    this.game.bosses.effects.clear(this);
    const w = this.game.world;
    const y = opts.y ?? w.groundAt(x, z, w.terrain.heightAt(x, z) + 1.2);
    this.home.set(x, y, z);
    this.feet.set(x, y, z);
    this.facing = facing;
    this.velocity.set(0, 0, 0);
    this.syncPosition();
    this.role = role;
    this.life = opts.life ?? Infinity;
    this.active = true;
    this.alive = true;
    this.engaged = true;
    this.invulnerable = false;
    this.fading = false;
    this.opacity = 0;
    this.charge = 0;
    this.glow = 0;
    this.idleClip = opts.clip ?? '2H_Melee_Idle';
    this.model.root.visible = true;
    this.setCustom();
    this.model.play(this.idleClip, { fade: 0, restart: true });
    if (!w.targets.includes(this)) w.targets.push(this);
    this.game.fx.echoBurst(tmp.copy(this.position), 26, 2.5);
  }

  /** Fade out (no shatter). */
  dismiss() {
    if (!this.active || this.fading) return;
    this.fading = true;
    this.runner.cancel();
    this.alive = false;
    this.removeTarget();
  }

  /** Immediate removal (reset). */
  hide() {
    this.runner.cancel();
    this.game.bosses.effects.clear(this);
    this.active = false;
    this.alive = false;
    this.fading = false;
    this.model.root.visible = false;
    this.removeTarget();
  }

  /** Burst into shards (hit / parried). */
  shatter(cause: 'hit' | 'parry' | 'counter' | 'reflect') {
    if (!this.active || this.fading) return;
    const fx = this.game.fx;
    fx.sparks.emit({
      count: 70, position: tmp.copy(this.position), spread: 0.8, speed: 7, upBias: 0.4, life: [0.3, 0.8], size: [0.05, 0.16],
      color: VOID_BRIGHT, color2: TelegraphColors.magic, gravity: 4, drag: 2,
    });
    fx.waves.spawn(tmp.copy(this.feet).setY(this.feet.y + 0.1), 3, VOID, 0.35, 0.2);
    this.game.cam.shake(0.25);
    this.hide();
    this.master.onEchoShattered(this, cause);
  }

  private removeTarget() {
    const t = this.game.world.targets;
    const i = t.indexOf(this);
    if (i >= 0) t.splice(i, 1);
  }

  /** Play one of the Warden's attacks from here. */
  attack(id: string) {
    if (!this.active || this.fading) return;
    this.startAttack(id);
  }

  get attackingNow() {
    return this.active && this.state === 'attack';
  }

  // ---------------------------------------------------------------- Boss overrides
  override onHit(info: HitInfo) {
    if (!this.active || this.fading || this.invulnerable) return;
    void info;
    this.game.hitstop(0.06);
    this.shatter('hit');
  }

  override onParried() {
    this.shatter('parry');
  }

  override onCountered() {
    this.shatter('counter');
  }

  override onReflectHit(_d: number, _p: number, _at: Vector3) {
    this.shatter('reflect');
  }

  override hitPlayer(spec: BossHitSpec): HitResult {
    const s = { ...spec, damage: Math.max(1, Math.round(spec.damage * this.damageMul)) };
    return super.hitPlayer(s);
  }

  override decide() {
    return { idle: 'wait' as const, duration: 1 };
  }

  protected override onCustomState(dt: number) {
    if (this.role === 'dissolve') {
      // drifting apart (death / phase beat): no friction, no turning
      this.velocity.y = Math.max(this.velocity.y, 0.5);
      return;
    }
    this.friction(10, dt);
    if (this.role !== 'ambush' && !this.game.player.dead) this.turnToward(this.game.player.position, 1.5, dt);
    this.model.play(this.idleClip, { fade: 0.25 });
  }

  override update(dt: number) {
    if (!this.active) return;
    super.update(dt);
    if (this.state === 'idle') this.setCustom(); // attack finished → stand
    this.life -= dt;
    if (this.life <= 0 && !this.fading) this.dismiss();
    this.opacity = this.fading ? Math.max(0, this.opacity - dt * 2.5) : Math.min(1, this.opacity + dt * 4);
    if (this.fading && this.opacity <= 0) this.hide();
    const u = this.holo.uniforms;
    u.uTime.value = this.game.time;
    u.uOpacity.value = this.opacity * (0.85 + 0.15 * Math.sin(this.game.time * 9 + this.feet.x));
    // telegraph colour bleeds into the hologram while winding up; `charge` flares it
    const c = u.uColor.value as Color;
    c.copy(VOID).lerp(tmpC.copy(TelegraphColors[this.glowKind]).multiplyScalar(0.55), Math.min(1, this.glow));
    if (this.charge > 0) c.lerp(VOID_BRIGHT, Math.min(1, this.charge) * 0.6);
    u.uFill.value = 0.2 + this.glow * 0.1 + this.charge * 0.12;
    if (Math.random() < 0.25 * this.opacity) {
      this.game.fx.sparks.emit({
        count: 1, position: tmp.copy(this.feet).setY(this.feet.y + Math.random() * this.def.height), spread: this.radius * 0.8,
        speed: 0.5, upBias: 1, life: [0.4, 0.8], size: [0.04, 0.1], color: VOID, gravity: -2, drag: 1,
      });
    }
  }
}
