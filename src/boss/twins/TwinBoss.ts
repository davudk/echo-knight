import { Vector3 } from 'three';
import type { Game } from '../../core/Game';
import { clamp } from '../../core/math';
import type { CharacterModel } from '../../player/CharacterModel';
import type { HitInfo } from '../../world/World';
import { Boss, type BossDef } from '../Boss';
import { TelegraphColors } from '../Decals';
import { Difficulty } from '../difficulty';
import type { DirectorConfig } from '../Director';
import type { AttackDef } from '../types';
import { isDamaging } from './attacks';
import type { TwinPair } from './Pair';
import { playTwinSound } from './sounds';

const tmp = new Vector3();

type CustomMode = 'intro' | 'blink' | 'hide' | 'enrage' | null;

/**
 * Shared base of Varek and Selene: the pair token gate on `startAttack`, blink / hide (custom
 * state), the intro salute, the enrage hand-off when the partner falls, threat bookkeeping.
 */
export abstract class TwinBoss extends Boss {
  pair!: TwinPair;
  /** vanished (blink / smoke): not hittable, not lockable, invisible */
  hidden = false;
  enraged = false;
  /** game time until which this boss's rings / projectiles are still dangerous */
  threatUntil = -1;
  /** game time this boss last became idle (Selene waits for Varek's breathing room) */
  idleSince = 0;

  protected mode: CustomMode = null;
  protected modeT = 0;
  /** blink: destination and the attack to start on arrival */
  protected readonly blinkTo = new Vector3();
  protected blinkThen: string | null = null;
  /** attack to start after the next `startAttack('blink')` */
  protected blinkNext: string | null = null;
  protected blinkHideAt = 0.16;
  protected blinkShowAt = 0.42;
  protected pendingEnrage = false;
  private readonly baseSpeeds: BossDef['speeds'];
  private readonly basePhases: DirectorConfig['phases'];

  constructor(game: Game, def: BossDef, model: CharacterModel) {
    super(game, def, model);
    this.baseSpeeds = { ...def.speeds };
    this.basePhases = def.director.phases;
  }

  protected abstract get partner(): TwinBoss;
  /** salute clip toward the player at the end of the intro */
  protected abstract readonly introClip: string;
  /** director phases used once the partner has fallen */
  protected abstract readonly enragedPhases: DirectorConfig['phases'];
  protected abstract onEnrage(): void;

  // ---------------------------------------------------------------- token gate
  /** Dev: start an attack ignoring the pair token. */
  forceAttack(id: string) {
    super.startAttack(id);
  }

  override startAttack(id: string) {
    if (id === 'blink') {
      // pseudo attack (director / decide): vanish, reappear, then `blinkNext` (if any)
      const then = this.blinkNext;
      this.blinkNext = null;
      this.beginBlink(this.pickBlinkSpot(), then);
      return;
    }
    const def = this.attacks.get(id);
    if (def && this.pair && !this.pair.mayStart(this, def)) {
      this.director.delay(0.2);
      return;
    }
    super.startAttack(id);
  }

  /** Is one of our damaging hits wound up / live / in flight right now? */
  threatening() {
    if (!this.alive) return false;
    if (this.game.time < this.threatUntil) return true;
    if (this.state !== 'attack') return false;
    const r = this.runner;
    if (!r.def || !isDamaging(r.def)) return false;
    return !(r.isLastStep && r.phase === 'recovery');
  }

  /** In a punishable / harmless state (recovering, staggered, transitioning, far away). */
  recovering() {
    if (!this.alive) return true;
    switch (this.state) {
      case 'attack':
        return this.runner.isLastStep && this.runner.phase === 'recovery';
      case 'recoil': case 'stagger': case 'knockdown': case 'transition': case 'dead': case 'dormant':
        return true;
      case 'idle':
        return this.game.time - this.idleSince > 1.4;
      default:
        return false;
    }
  }

  protected override onAttackStep(attack: AttackDef, step: number, phase: 'active' | 'recovery') {
    const s = attack.steps[step];
    if (phase === 'active') {
      // rings / knives outlive the step: keep the token until they have passed
      let extra = 0;
      for (const h of s.hitboxes) {
        if (h.shape === 'ring') extra = Math.max(extra, (h.maxRadius - (h.startRadius ?? 0.6)) / h.speed + 0.15);
        if (h.shape === 'projectile') extra = Math.max(extra, (h.count ?? 1) * (h.interval ?? 0) + 0.75);
      }
      if (extra > 0) this.threatUntil = Math.max(this.threatUntil, this.game.time + s.active + extra);
    } else if (step === attack.steps.length - 1 && s.hitboxes.length) {
      // a short breather before the partner may start a damaging attack
      this.pair?.release(this, 0.45 * Difficulty.telegraph());
    }
    this.onTwinStep(attack, step, phase);
  }

  protected onTwinStep(_attack: AttackDef, _step: number, _phase: 'active' | 'recovery') {}

  // ---------------------------------------------------------------- hidden / blink
  protected override syncPosition() {
    super.syncPosition();
    // vanished: move the hit / lock point out of the world (queries skip it)
    if (this.hidden) this.position.y -= 200;
  }

  setHidden(v: boolean) {
    this.hidden = v;
    (this as unknown as { lockable: boolean }).lockable = !v;
    this.model.root.visible = !v;
    this.syncPosition();
  }

  /** A spot to blink to (override per boss). */
  protected pickBlinkSpot(): Vector3 {
    return this.flankSpot(3, Math.random() < 0.5 ? 1 : -1, tmp);
  }

  /** Spot `dist` m from the player on its side (side = ±1) or behind (side = 0). */
  flankSpot(dist: number, side: number, out: Vector3) {
    const p = this.game.player.position;
    let dx = this.feet.x - p.x;
    let dz = this.feet.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    // rotate the boss→player bearing: side ±1 → 90°, 0 → behind the player (180°)
    const a = side === 0 ? Math.PI : (Math.PI / 2) * side;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.set(p.x + (dx * c - dz * s) * dist, 0, p.z + (dx * s + dz * c) * dist);
    this.clampToArena(out);
    return out;
  }

  /** Vanish → reappear at `to` → optional attack. */
  beginBlink(to: Vector3, then: string | null) {
    this.blinkTo.copy(to);
    this.blinkThen = then;
    this.mode = 'blink';
    this.modeT = 0;
    this.setCustom(this.blinkShowAt + 0.2);
    this.model.play('Dodge_Backward', { fade: 0.05, loop: false, restart: true, speed: 1.2 });
    this.vanishFx();
    playTwinSound('twinBlink', this.position);
  }

  protected vanishFx() {
    const at = tmp.copy(this.feet).setY(this.feet.y + this.def.height * 0.5);
    this.game.fx.dustPuff(this.feet, 16, 2.6, [0.4, 0.9]);
    this.game.fx.sparks.emit({
      count: 24, position: at, spread: 0.4, speed: 3, upBias: 0.4, life: [0.2, 0.5], size: [0.05, 0.12],
      color: TelegraphColors.magic, drag: 3,
    });
  }

  private updateBlink() {
    const t = this.modeT;
    if (!this.hidden && t >= this.blinkHideAt && t < this.blinkShowAt) {
      this.setHidden(true);
      this.feet.x = this.blinkTo.x;
      this.feet.z = this.blinkTo.z;
      this.feet.y = this.game.world.groundAt(this.feet.x, this.feet.z, this.feet.y + 2);
      this.velocity.set(0, 0, 0);
      this.syncPosition();
    }
    if (this.hidden && t >= this.blinkShowAt) {
      this.setHidden(false);
      this.facing = Math.atan2(this.game.player.position.x - this.feet.x, this.game.player.position.z - this.feet.z);
      this.vanishFx();
      this.model.play(this.def.anims.idle, { fade: 0.1 });
      const then = this.blinkThen;
      this.blinkThen = null;
      this.mode = null;
      if (then) {
        this.toIdle(0);
        this.startAttack(then);
        if (this.state !== 'attack') this.toIdle(0.3);
      } else {
        this.toIdle(0.35);
      }
    }
  }

  // ---------------------------------------------------------------- engage / intro
  protected override onEngage() {
    this.idleSince = this.game.time;
    this.mode = 'intro';
    this.modeT = 0;
    this.setCustom(3.2);
    this.invulnerable = true;
    this.model.play('Interact', { fade: 0.2, loop: false, restart: true, speed: 0.9 });
  }

  private updateIntro(dt: number) {
    const t = this.modeT;
    if (t < 1.5) {
      // salute each other
      this.turnToward(this.partner.feet, 5, dt);
    } else {
      if (t - dt < 1.5) this.model.play(this.introClip, { fade: 0.25, loop: false, restart: true });
      this.turnToward(this.game.player.position, 3.5, dt);
    }
    if (t >= 3.15) {
      this.mode = null;
      this.invulnerable = false;
      this.toIdle(this.introBreather);
    }
  }

  /** extra idle time after the intro (Selene lets Varek open) */
  protected introBreather = 0.3;

  // ---------------------------------------------------------------- enrage
  /** The partner fell: enrage as soon as we're on our feet. */
  queueEnrage() {
    if (!this.alive || this.enraged) return;
    this.pendingEnrage = true;
  }

  private doEnrage() {
    this.pendingEnrage = false;
    this.enraged = true;
    this.setHidden(false);
    this.director.config.phases = this.enragedPhases;
    this.director.reset();
    // the grief heals a quarter of the survivor's health
    this.health = Math.min(this.maxHealth, this.health + this.maxHealth * 0.25);
    this.mode = 'enrage';
    this.modeT = 0;
    this.setCustom(2.6);
    this.invulnerable = true;
    this.poise = 0;
    this.model.play('Cheer', { fade: 0.15, loop: false, restart: true, speed: 0.8 });
    this.game.cam.shake(0.8);
    this.game.fx.slam(this.feet, 5);
    playTwinSound('twinFury', this.position);
    this.game.bosses.effects.clear(this);
    this.onEnrage();
  }

  // ---------------------------------------------------------------- custom state / frame
  protected override onCustomState(dt: number) {
    this.modeT += dt;
    this.friction(8, dt);
    switch (this.mode) {
      case 'intro': this.updateIntro(dt); break;
      case 'blink': this.updateBlink(); break;
      case 'enrage':
        this.turnToward(this.game.player.position, 2, dt);
        if (this.modeT >= 2.55) {
          this.mode = null;
          this.invulnerable = false;
          this.toIdle(0.3);
        }
        break;
      case 'hide': this.updateHide(dt); break;
      default: this.toIdle(); break;
    }
  }

  protected updateHide(_dt: number) {
    this.toIdle();
  }

  protected override onUpdate(dt: number) {
    if (this.state === 'idle' && this.idleSince < 0) this.idleSince = this.game.time;
    if (this.state !== 'idle') this.idleSince = -1;
    if (this.pendingEnrage && (this.state === 'idle' || this.state === 'attack' || this.state === 'recoil')) this.doEnrage();
    // never stay hidden outside a custom state (stagger interrupts etc.)
    if (this.hidden && this.state !== 'custom') this.setHidden(false);
    this.twinUpdate(dt);
  }

  protected twinUpdate(_dt: number) {}

  override onHit(info: HitInfo) {
    if (this.hidden) return;
    super.onHit(info);
  }

  protected override onReset() {
    this.mode = null;
    this.modeT = 0;
    this.blinkThen = null;
    this.pendingEnrage = false;
    this.enraged = false;
    this.threatUntil = -1;
    this.idleSince = 0;
    this.setHidden(false);
    Object.assign(this.def.speeds, this.baseSpeeds);
    this.director.config.phases = this.basePhases;
    this.director.reset();
    this.pair?.reset();
  }

  protected override onDefeated() {
    this.setHidden(false);
    this.pair?.onDefeated(this);
  }

  /** Speed-up helper for enrages. */
  protected scaleSpeeds(k: number) {
    const s = this.def.speeds;
    s.walk = this.baseSpeeds.walk * k;
    s.run = this.baseSpeeds.run * k;
    s.strafe = this.baseSpeeds.strafe * k;
    s.turn = this.baseSpeeds.turn * clamp(k, 1, 1.4);
  }
}
