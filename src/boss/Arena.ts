import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import type { BoxCollider } from '../world/World';
import type { Boss } from './Boss';
import type { Decal } from './Decals';
import { Difficulty } from './difficulty';

/**
 * Arena kit: fog gate, checkpoint, fight lifecycle (seal → reset on death → victory), hazard zones,
 * music cues and arena bounds. One `BossArena` per boss fight.
 *
 *   const arena = new BossArena(game, { id: 'warden', name: "Warden's Keep", region: Regions.warden });
 *   arena.addBoss(warden);              // boss.home must be set (boss.placeAt) — reset returns there
 *   arena.addHazard(new HazardZone(...))
 *
 * Flow: the fog gate stands on the arena edge facing `entry` (default: toward the world centre).
 * Walking into the arena (through the gate) starts the fight: the gate seals (collider + a fog
 * wall around the whole arena keeps the player in), the checkpoint moves to the gate and flasks
 * refill. If the player dies the bosses reset, the gate reopens and the player respawns at the
 * gate. When every boss is dead the fog lifts for good.
 */

export interface Region {
  x: number;
  z: number;
  radius: number;
}

/** Travel registry entry (pause menu → Travel). */
export interface BossArenaInfo {
  id: string;
  name: string;
  region: Region;
  /** where the player is put (outside the fog gate), facing into the arena */
  entry: { x: number; z: number; facing: number };
}

const registry: BossArenaInfo[] = [];

/** Add an arena to the Travel menu (BossArena does this for you). Re-registering an id replaces it. */
export function registerBossArena(info: BossArenaInfo) {
  const i = registry.findIndex((r) => r.id === info.id);
  if (i >= 0) registry[i] = info;
  else registry.push(info);
}

export function unregisterBossArena(id: string) {
  const i = registry.findIndex((r) => r.id === id);
  if (i >= 0) registry.splice(i, 1);
}

export function bossArenas(): readonly BossArenaInfo[] {
  return registry;
}

// ====================================================================== fog material
const FOG_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vW;
  void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FOG_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uTime; uniform float uAlpha; uniform float uRepeat;
  varying vec2 vUv; varying vec3 vW;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    vec2 p = vec2(vUv.x * uRepeat, vUv.y * 2.0);
    float f = n(p * 3.0 + vec2(uTime * 0.25, -uTime * 0.6)) * 0.6 + n(p * 7.0 - vec2(uTime * 0.4, uTime * 0.9)) * 0.4;
    float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
    float vert = smoothstep(1.0, 0.25, vUv.y) * smoothstep(0.0, 0.06, vUv.y);
    float a = (0.25 + 0.75 * f) * vert * edge * uAlpha;
    gl_FragColor = vec4(uColor * (0.7 + f * 0.8), a);
  }`;

function fogMaterial(color: Color, repeat: number) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: { uColor: { value: color }, uTime: { value: 0 }, uAlpha: { value: 1 }, uRepeat: { value: repeat } },
    vertexShader: FOG_VERT,
    fragmentShader: FOG_FRAG,
  });
}

// ====================================================================== fog gate
export class FogGate {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  collider: BoxCollider | null = null;
  sealed = false;
  /** 1 = present, fades to 0 when lifted */
  presence = 1;
  private target = 1;

  constructor(
    private readonly game: Game,
    readonly x: number,
    readonly z: number,
    /** yaw of the gate's normal (pointing out of the arena) */
    readonly yaw: number,
    readonly width = 5,
    readonly height = 4.2,
  ) {
    this.mat = fogMaterial(new Color(0.5, 0.46, 0.36), 2);
    this.mesh = new Mesh(new PlaneGeometry(width, height), this.mat);
    const y = game.world.groundAt(x, z);
    this.mesh.position.set(x, y + height / 2 - 0.1, z);
    this.mesh.rotation.y = yaw; // plane faces +z locally → along the normal
    this.mesh.renderOrder = 5;
    game.scene.add(this.mesh);
  }

  setSealed(v: boolean) {
    if (v === this.sealed) return;
    this.sealed = v;
    const w = this.game.world;
    if (v) {
      const y = w.groundAt(this.x, this.z);
      // the plane spans local x; a thin box along it
      this.collider = w.addBox(this.x, this.z, this.width, 0.5, y - 1, y + this.height, this.yaw, 'fog-gate');
    } else if (this.collider) {
      w.removeCollider(this.collider);
      this.collider = null;
    }
  }

  /** Lift (victory) or restore the fog. */
  setPresent(v: boolean) {
    this.target = v ? 1 : 0;
  }

  update(dt: number, time: number) {
    this.presence += (this.target - this.presence) * Math.min(1, dt * 1.5);
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uAlpha.value = this.presence * (this.sealed ? 0.8 : 0.6);
    (this.mat.uniforms.uColor.value as Color).setRGB(this.sealed ? 0.75 : 0.5, this.sealed ? 0.5 : 0.46, this.sealed ? 0.28 : 0.36);
    this.mesh.visible = this.presence > 0.01;
  }

  /** Signed distance of a point in front of the gate (outside the arena = +). */
  side(x: number, z: number) {
    return (x - this.x) * Math.sin(this.yaw) + (z - this.z) * Math.cos(this.yaw);
  }

  dispose() {
    this.setSealed(false);
    this.game.scene.remove(this.mesh);
  }
}

// ====================================================================== hazards
/**
 * Damaging floor area. Toggle with `active`, animate by changing `radius` / position, or drive
 * `level` for a flooding effect. Damage ticks every `interval` while the player stands in it
 * (grounded, unless `airborneToo`). Goes through `player.receiveHit` as unblockable.
 */
export class HazardZone {
  active = false;
  readonly center = new Vector3();
  private tickTimer = 0;
  private decal: Decal | null = null;

  constructor(
    private readonly game: Game,
    readonly opts: {
      x: number;
      z: number;
      radius: number;
      damage: number;
      interval?: number;
      airborneToo?: boolean;
      /** decal colour class (default unblockable red) */
      telegraph?: 'parryable' | 'unblockable' | 'magic';
      /** optional custom test (e.g. "below water level") replaces the circle test */
      contains?: (x: number, y: number, z: number) => boolean;
    },
  ) {
    this.center.set(opts.x, game.world.groundAt(opts.x, opts.z), opts.z);
  }

  radius = 0;

  setActive(v: boolean) {
    if (v === this.active) return;
    this.active = v;
    this.tickTimer = 0.25; // a short grace when it switches on
    if (v) {
      this.radius = this.radius || this.opts.radius;
      this.decal = this.game.bosses.decals.acquire().tint(this.opts.telegraph ?? 'unblockable');
      this.decal.fill = 1;
      this.decal.alpha = 0.7;
    } else {
      this.decal?.release(0.4);
      this.decal = null;
    }
  }

  update(dt: number) {
    if (!this.active) return;
    if (this.decal) this.decal.circle(this.center.x, this.center.y, this.center.z, this.radius || this.opts.radius);
    const p = this.game.player;
    if (p.dead) return;
    const inside = this.opts.contains
      ? this.opts.contains(p.position.x, p.position.y, p.position.z)
      : Math.hypot(p.position.x - this.center.x, p.position.z - this.center.z) <= (this.radius || this.opts.radius) &&
        (this.opts.airborneToo || p.position.y - this.center.y < 0.4);
    this.tickTimer -= dt;
    if (!inside || this.tickTimer > 0) return;
    this.tickTimer = this.opts.interval ?? 0.5;
    const dir = new Vector3(p.position.x - this.center.x, 0, p.position.z - this.center.z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    p.receiveHit({ damage: Difficulty.scaleDamage(this.opts.damage), dir, knockback: 1.5, heavy: false, unblockable: true, parryable: false });
  }

  dispose() {
    this.setActive(false);
  }
}

// ====================================================================== arena
export interface ArenaDef {
  id: string;
  name: string;
  region: Region;
  /** where the fog gate stands, as a direction from the arena centre (rad, facing convention).
   *  Default: pointing at the world centre (the spawn arena). */
  gateDir?: number;
  gateWidth?: number;
  /** show in the Travel menu (default true) */
  travel?: boolean;
}

export type ArenaState = 'idle' | 'fight' | 'cleared';

export class BossArena {
  readonly id: string;
  readonly name: string;
  readonly region: Region;
  readonly gate: FogGate;
  readonly bosses: Boss[] = [];
  readonly hazards: HazardZone[] = [];
  readonly entry: { x: number; z: number; facing: number };
  state: ArenaState = 'idle';
  private readonly wall: Mesh;
  private readonly wallMat: ShaderMaterial;
  private wallAlpha = 0;
  private readonly savedSpawn = new Vector3();
  private hasSaved = false;
  private pendingReset = false;
  private promptCooldown = 0;
  private readonly off: (() => void)[] = [];

  constructor(private readonly game: Game, def: ArenaDef) {
    this.id = def.id;
    this.name = def.name;
    this.region = def.region;
    const r = def.region;
    const dir = def.gateDir ?? Math.atan2(-r.x, -r.z);
    const gx = r.x + Math.sin(dir) * r.radius;
    const gz = r.z + Math.cos(dir) * r.radius;
    this.gate = new FogGate(game, gx, gz, dir, def.gateWidth ?? 5);
    const ex = r.x + Math.sin(dir) * (r.radius + 2.5);
    const ez = r.z + Math.cos(dir) * (r.radius + 2.5);
    this.entry = { x: ex, z: ez, facing: dir + Math.PI };

    // fog wall around the whole arena while sealed
    this.wallMat = fogMaterial(new Color(0.55, 0.38, 0.22), Math.round(r.radius * 1.2));
    this.wall = new Mesh(new CylinderGeometry(r.radius, r.radius, 4.5, 64, 1, true), this.wallMat);
    this.wall.position.set(r.x, game.world.groundAt(r.x, r.z) + 2.15, r.z);
    this.wall.renderOrder = 5;
    this.wall.visible = false;
    game.scene.add(this.wall);

    if (def.travel !== false) registerBossArena({ id: this.id, name: this.name, region: r, entry: this.entry });
    game.bosses.addArena(this);

    this.off.push(events.on('player:died', () => {
      if (this.state === 'fight') this.pendingReset = true;
    }));
    this.off.push(events.on('player:respawn', () => {
      if (!this.pendingReset) return;
      this.pendingReset = false;
      this.resetFight();
      const p = this.game.player;
      p.facing = this.entry.facing;
      this.game.cam.recenter(p.facing);
    }));
  }

  addBoss(b: Boss) {
    b.arena = this;
    this.bosses.push(b);
    return b;
  }

  addHazard(h: HazardZone) {
    this.hazards.push(h);
    return h;
  }

  contains(x: number, z: number, margin = 0) {
    return Math.hypot(x - this.region.x, z - this.region.z) <= this.region.radius - margin;
  }

  /** Begin the fight: seal, checkpoint, engage bosses. */
  startFight() {
    if (this.state !== 'idle') return;
    if (!this.bosses.some((b) => b.alive)) return;
    this.state = 'fight';
    const p = this.game.player;
    if (!this.hasSaved) {
      this.savedSpawn.copy(p.spawnPoint);
      this.hasSaved = true;
    }
    p.spawnPoint.set(this.entry.x, this.game.world.groundAt(this.entry.x, this.entry.z), this.entry.z);
    this.gate.setSealed(true);
    for (const b of this.bosses) if (b.alive) b.engage();
    events.emit('arena:seal', { id: this.id, sealed: true, position: new Vector3(this.gate.x, 0, this.gate.z) });
    events.emit('arena:checkpoint', { id: this.id, position: p.spawnPoint.clone() });
    events.emit('arena:music', { id: this.id, cue: 'fight' });
  }

  /** Player died / left: bosses back home, gate open, hazards off. */
  resetFight() {
    for (const b of this.bosses) b.reset();
    for (const h of this.hazards) h.setActive(false);
    this.gate.setSealed(false);
    this.gate.setPresent(true);
    this.state = 'idle';
    this.game.bosses.refillFlasks();
    events.emit('arena:seal', { id: this.id, sealed: false, position: new Vector3(this.gate.x, 0, this.gate.z) });
    events.emit('arena:music', { id: this.id, cue: 'stop' });
  }

  /** Every boss is dead: the fog lifts for good (until `rematch`). */
  private victory() {
    this.state = 'cleared';
    for (const h of this.hazards) h.setActive(false);
    this.gate.setSealed(false);
    this.gate.setPresent(false);
    if (this.hasSaved) {
      this.game.player.spawnPoint.copy(this.savedSpawn);
      this.hasSaved = false;
    }
    events.emit('arena:seal', { id: this.id, sealed: false, position: new Vector3(this.gate.x, 0, this.gate.z) });
    events.emit('arena:music', { id: this.id, cue: 'victory' });
  }

  /** Dev / demo: bring a cleared arena back. */
  rematch() {
    this.resetFight();
  }

  update(dt: number) {
    const p = this.game.player;
    const r = this.region;
    this.gate.update(dt, this.game.time);
    for (const h of this.hazards) h.update(dt);

    const target = this.state === 'fight' ? 1 : 0;
    this.wallAlpha += (target - this.wallAlpha) * Math.min(1, dt * 2);
    this.wall.visible = this.wallAlpha > 0.01;
    this.wallMat.uniforms.uAlpha.value = this.wallAlpha * 0.45;
    this.wallMat.uniforms.uTime.value = this.game.time;

    this.promptCooldown -= dt;
    if (this.state === 'idle' && !p.dead) {
      const d = Math.hypot(p.position.x - r.x, p.position.z - r.z);
      const nearGate = Math.hypot(p.position.x - this.gate.x, p.position.z - this.gate.z) < 3.2;
      if (nearGate && this.promptCooldown <= 0 && d > r.radius - 0.3) {
        // the gate is the checkpoint: resting here refills the flasks
        const refilled = this.game.bosses.refillFlasks();
        this.game.hud.flash(`${this.name} — walk through the fog${refilled ? ' · flasks refilled' : ''}`, 2.2);
        this.promptCooldown = 6;
      }
      if (d < r.radius - 0.8 && this.bosses.some((b) => b.alive)) this.startFight();
    } else if (this.state === 'fight') {
      // sealed: keep the player inside (soft wall)
      const dx = p.position.x - r.x;
      const dz = p.position.z - r.z;
      const d = Math.hypot(dx, dz);
      const max = r.radius - 0.6;
      if (d > max && !p.dead) {
        p.position.x = r.x + (dx / d) * max;
        p.position.z = r.z + (dz / d) * max;
        const vr = (p.velocity.x * dx + p.velocity.z * dz) / d;
        if (vr > 0) {
          p.velocity.x -= (dx / d) * vr;
          p.velocity.z -= (dz / d) * vr;
        }
      }
      if (this.bosses.length && this.bosses.every((b) => !b.alive)) this.victory();
    }
  }

  dispose() {
    for (const f of this.off) f();
    this.gate.dispose();
    for (const h of this.hazards) h.dispose();
    this.game.scene.remove(this.wall);
    unregisterBossArena(this.id);
    this.game.bosses.removeArena(this);
  }
}
