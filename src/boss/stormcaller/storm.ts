import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
  type Scene,
} from 'three';
import { playSfx } from '../../audio/audioFeature';
import type { Game } from '../../core/Game';
import type { HitInfo, Hittable } from '../../world/World';
import type { Boss } from '../Boss';
import { TelegraphColors, type Decal } from '../Decals';
import { PLAYER_RADIUS, type BossHitSpec, type Projectile } from '../Hitboxes';
import type { TelegraphKind } from '../types';

/**
 * The Stormcaller's long-lived effects, all pooled and allocation-free per frame:
 *
 *  - `BoltRenderer`  one instanced draw call for every lightning segment (strikes, chains, arcs)
 *  - `StrikeField`   timed ground strikes (runes, lightning strikes, aura) with filling decals
 *  - `SweepLines`    chain lightning (jump / slide under) and lightning walls (walk the gap)
 *  - `Orbs`          slow homing orbs that explode on contact and pop when hit
 *  - `BoltMarkers`   gold halo rings that mark reflectable (parryable) bolts
 *  - `ThunderfallDecal` arena-wide red telegraph with safe pockets cut out
 *  - `ScreenFlash`   subtle full-screen flash on strikes
 */

export const LIGHTNING = {
  cyan: new Color(0.9, 2.0, 3.2),
  core: new Color(2.6, 2.9, 3.4),
  violet: new Color(1.6, 0.9, 3.0),
  red: new Color(3.2, 0.3, 0.45),
  redCore: new Color(3.4, 1.6, 1.6),
  safe: new Color(0.7, 2.6, 1.2),
};

const UP = new Vector3(0, 1, 0);
const tmp = new Vector3();
const tmp2 = new Vector3();

const spec: BossHitSpec = {
  damage: 0, knockback: 0, heavy: false, telegraph: 'magic', parryable: false, unblockable: false, from: new Vector3(),
};

/** Deliver a hit from a stormcaller effect through the boss (difficulty scaling, defenses). */
export function stormHit(boss: Boss, damage: number, knockback: number, kind: TelegraphKind, fx: number, fy: number, fz: number, heavy = false) {
  spec.damage = damage;
  spec.knockback = knockback;
  spec.heavy = heavy;
  spec.telegraph = kind;
  spec.parryable = false;
  spec.unblockable = kind === 'unblockable';
  spec.from.set(fx, fy, fz);
  spec.projectile = undefined;
  return boss.hitPlayer(spec);
}

// ====================================================================== bolts
/** Every lightning segment in one instanced, additive draw call. Call `begin` / `seg…` / `end` each frame. */
export class BoltRenderer {
  readonly mesh: InstancedMesh;
  private n = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly p = new Vector3();
  private readonly d = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  constructor(scene: Scene, private readonly max = 900) {
    const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, max);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, new Color());
    this.mesh.instanceColor!.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }

  begin() {
    this.n = 0;
  }

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, c: Color) {
    if (this.n >= this.max) return;
    const d = this.d.set(bx - ax, by - ay, bz - az);
    const len = d.length();
    if (len < 1e-4) return;
    d.divideScalar(len);
    this.q.setFromUnitVectors(UP, d);
    this.p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    this.s.set(w, len, w);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, c);
    this.n++;
  }

  /** A jagged bolt from a to b (fresh random jitter every call → flicker), core + glow layers. */
  jagged(ax: number, ay: number, az: number, bx: number, by: number, bz: number, segs: number, amp: number, w: number, glow: Color, core: Color) {
    const a = this.a.set(ax, ay, az);
    const b = this.b;
    let px = ax;
    let py = ay;
    let pz = az;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const j = i === segs ? 0 : amp * Math.sin(t * Math.PI);
      const nx = a.x + (bx - a.x) * t + (Math.random() - 0.5) * 2 * j;
      const ny = a.y + (by - a.y) * t + (Math.random() - 0.5) * j;
      const nz = a.z + (bz - a.z) * t + (Math.random() - 0.5) * 2 * j;
      this.seg(px, py, pz, nx, ny, nz, w * 3.2, glow);
      this.seg(px, py, pz, nx, ny, nz, w, core);
      b.set(nx, ny, nz);
      px = nx;
      py = ny;
      pz = nz;
    }
  }

  end() {
    this.mesh.count = this.n;
    if (this.n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }

  dispose(scene: Scene) {
    scene.remove(this.mesh);
  }
}

// ====================================================================== flash
/** Subtle full-screen flash (strikes). `pulse(0.6)` → at most ~16 % white, decays in ~0.2 s. */
export class ScreenFlash {
  private readonly el: HTMLElement;
  private v = 0;
  private shown = -1;

  constructor(game: Game) {
    const el = document.createElement('div');
    el.className = 'storm-flash';
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;z-index:2;' +
      'background:radial-gradient(ellipse at 50% 30%, rgba(225,240,255,0.95), rgba(190,210,255,0.55) 70%);';
    this.el = game.hud.mount(el);
  }

  pulse(k: number) {
    this.v = Math.max(this.v, Math.min(1, k));
  }

  update(dt: number) {
    this.v = Math.max(0, this.v - dt * 5);
    const o = Math.round(this.v * 0.16 * 100) / 100;
    if (o !== this.shown) {
      this.shown = o;
      this.el.style.opacity = String(o);
    }
  }

  clear() {
    this.v = 0;
  }
}

// ====================================================================== strikes
export type StrikeStyle = 'bolt' | 'rune';

interface Strike {
  active: boolean;
  x: number;
  y: number;
  z: number;
  r: number;
  t: number;
  warn: number;
  dmg: number;
  kb: number;
  kind: TelegraphKind;
  style: StrikeStyle;
  decal: Decal | null;
}

interface FlashBolt {
  life: number;
  x: number;
  y: number;
  z: number;
  h: number;
  kind: TelegraphKind;
  rune: boolean;
}

/**
 * Timed circular strikes. The decal fills during `warn`, then it erupts (a sky bolt or a rune column)
 * and hits the player if they stand inside (height-limited: a player on a pylon top is above a
 * floor strike).
 */
export class StrikeField {
  private readonly pool: Strike[] = [];
  private readonly flashes: FlashBolt[] = [];
  private soundGap = 0;
  /** called on every impact (camera / sky flash) */
  onImpact: ((x: number, y: number, z: number, big: boolean) => void) | null = null;

  constructor(private readonly game: Game, private readonly boss: Boss, private readonly bolts: BoltRenderer, private readonly surface: (x: number, z: number) => number) {
    for (let i = 0; i < 48; i++) this.pool.push({ active: false, x: 0, y: 0, z: 0, r: 1, t: 0, warn: 1, dmg: 0, kb: 0, kind: 'magic', style: 'bolt', decal: null });
    for (let i = 0; i < 24; i++) this.flashes.push({ life: 0, x: 0, y: 0, z: 0, h: 14, kind: 'magic', rune: false });
  }

  spawn(x: number, z: number, r: number, warn: number, dmg: number, kind: TelegraphKind = 'magic', style: StrikeStyle = 'bolt', kb = 5) {
    const s = this.pool.find((p) => !p.active);
    if (!s) return null;
    s.active = true;
    s.x = x;
    s.z = z;
    s.y = this.surface(x, z);
    s.r = r;
    s.t = 0;
    s.warn = Math.max(0.05, warn);
    s.dmg = dmg;
    s.kb = kb;
    s.kind = kind;
    s.style = style;
    s.decal = this.game.bosses.decals.acquire().tint(kind).circle(x, s.y, z, r);
    s.decal.fill = 0;
    return s;
  }

  get count() {
    let n = 0;
    for (const s of this.pool) if (s.active) n++;
    return n;
  }

  /** visual-only bolt from the sky (intro, thunderfall scatter, flavour) */
  flashBolt(x: number, y: number, z: number, kind: TelegraphKind = 'magic', h = 16, rune = false) {
    const f = this.flashes.find((b) => b.life <= 0) ?? this.flashes[0];
    f.life = rune ? 0.3 : 0.24;
    f.x = x;
    f.y = y;
    f.z = z;
    f.h = h;
    f.kind = kind;
    f.rune = rune;
  }

  update(dt: number) {
    this.soundGap -= dt;
    const p = this.game.player;
    for (const s of this.pool) {
      if (!s.active) continue;
      s.t += dt;
      if (s.decal) s.decal.fill = Math.min(1, s.t / s.warn);
      if (s.t < s.warn) continue;
      // impact
      s.active = false;
      s.decal?.release(0.25);
      s.decal = null;
      this.flashBolt(s.x, s.y, s.z, s.kind, s.style === 'rune' ? 2.6 : 16, s.style === 'rune');
      const c = TelegraphColors[s.kind];
      tmp.set(s.x, s.y + 0.1, s.z);
      this.game.fx.waves.spawn(tmp, s.r, c, 0.35, 0.18);
      this.game.fx.sparks.emit({ count: s.style === 'rune' ? 14 : 18, position: tmp, spread: s.r * 0.4, speed: 5, upBias: 1.2, life: [0.15, 0.45], size: [0.05, 0.13], color: c, color2: LIGHTNING.core, gravity: 5, drag: 2 });
      this.onImpact?.(s.x, s.y, s.z, s.style === 'bolt');
      if (this.soundGap <= 0) {
        this.soundGap = 0.07;
        playSfx(s.style === 'rune' ? 'stormRune' : 'stormStrike', { pos: tmp });
      }
      if (!p.dead && Math.hypot(p.position.x - s.x, p.position.z - s.z) <= s.r + PLAYER_RADIUS) {
        const dy = p.position.y - s.y;
        if (dy > -0.6 && dy < (s.style === 'rune' ? 1.9 : 2.4)) stormHit(this.boss, s.dmg, s.kb, s.kind, s.x, s.y, s.z);
      }
    }
  }

  /** draw flash bolts (inside BoltRenderer begin/end) */
  draw(dt: number) {
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const glow = f.kind === 'unblockable' ? LIGHTNING.red : f.rune ? LIGHTNING.violet : LIGHTNING.cyan;
      const core = f.kind === 'unblockable' ? LIGHTNING.redCore : LIGHTNING.core;
      if (f.rune) {
        for (let k = 0; k < 2; k++) this.bolts.jagged(f.x, f.y, f.z, f.x + (Math.random() - 0.5), f.y + f.h * (0.6 + Math.random() * 0.4), f.z + (Math.random() - 0.5), 4, 0.35, 0.05, glow, core);
      } else {
        this.bolts.jagged(f.x + (Math.random() - 0.5) * 3, f.y + f.h, f.z + (Math.random() - 0.5) * 3, f.x, f.y, f.z, 10, 1.1, 0.07, glow, core);
        if (Math.random() < 0.6) {
          const t = 0.4 + Math.random() * 0.3;
          const bx = f.x;
          const by = f.y + f.h * (1 - t);
          this.bolts.jagged(bx, by, f.z, bx + (Math.random() - 0.5) * 4, by - 3, f.z + (Math.random() - 0.5) * 4, 4, 0.5, 0.035, glow, core);
        }
      }
    }
  }

  clear() {
    for (const s of this.pool) {
      if (!s.active) continue;
      s.active = false;
      s.decal?.release(0.1);
      s.decal = null;
    }
    for (const f of this.flashes) f.life = 0;
  }
}

// ====================================================================== sweeping lines
export type SweepKind = 'chain-low' | 'chain-high' | 'wall';

interface Sweep {
  active: boolean;
  kind: SweepKind;
  nx: number;
  nz: number;
  d: number;
  d1: number;
  prevSd: number;
  speed: number;
  t: number;
  warn: number;
  yMin: number;
  yMax: number;
  gapC: number;
  gapW: number;
  dmg: number;
  hit: boolean;
  decalA: Decal | null;
  decalB: Decal | null;
  wallA: Mesh;
  wallB: Mesh;
}

const WALL_H = 4.2;
const WALL_FRAG = /* glsl */ `
  uniform float uTime; uniform float uAlpha; uniform vec3 uColor; varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float y = vUv.y;
    float band = abs(fract(vUv.x * 6.0 - uTime * 2.3 + sin(y * 9.0 + uTime * 7.0) * 0.12) - 0.5);
    float arcs = smoothstep(0.08, 0.0, band) * (0.6 + 0.4 * h(floor(vec2(vUv.x * 40.0, uTime * 20.0))));
    float edge = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x);
    float vert = (0.35 + 0.65 * smoothstep(1.0, 0.0, y)) * smoothstep(0.0, 0.04, y);
    float a = (0.22 + arcs * 0.8) * vert * edge * uAlpha;
    gl_FragColor = vec4(uColor * (0.8 + arcs), a);
  }`;
const WALL_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * Lines that sweep across the arena (a chord of the arena circle moving along its normal):
 *  - chain-low  : crackling chain at knee height → jump over it (or roll)
 *  - chain-high : at head height → slide / roll under it (or stand on a pylon)
 *  - wall       : a 4 m curtain with a gap → walk through the gap (or roll through)
 * All are unblockable (red). Each hits at most once.
 */
export class SweepLines {
  private readonly pool: Sweep[] = [];
  private readonly wallMat: ShaderMaterial;
  private readonly wallGeo = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
  private time = 0;

  constructor(
    private readonly game: Game,
    private readonly boss: Boss,
    private readonly bolts: BoltRenderer,
    /** arena centre / radius / floor top */
    private readonly cx: number,
    private readonly cz: number,
    private readonly R: number,
    private readonly floor: number,
  ) {
    this.wallMat = new ShaderMaterial({
      transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uColor: { value: LIGHTNING.red.clone().multiplyScalar(0.6) } },
      vertexShader: WALL_VERT, fragmentShader: WALL_FRAG,
    });
    for (let i = 0; i < 4; i++) {
      const wallA = new Mesh(this.wallGeo, this.wallMat);
      const wallB = new Mesh(this.wallGeo, this.wallMat);
      wallA.visible = wallB.visible = false;
      wallA.frustumCulled = wallB.frustumCulled = false;
      wallA.renderOrder = wallB.renderOrder = 5;
      game.scene.add(wallA, wallB);
      this.pool.push({
        active: false, kind: 'wall', nx: 0, nz: 1, d: 0, d1: 0, prevSd: 0, speed: 0, t: 0, warn: 1, yMin: 0, yMax: 0, gapC: 0, gapW: 0,
        dmg: 0, hit: false, decalA: null, decalB: null, wallA, wallB,
      });
    }
  }

  /**
   * Start a sweep moving along direction `yaw` (facing convention), from offset `-span` to `+span`
   * (relative to the arena centre), after `warn` seconds of telegraph.
   */
  spawn(kind: SweepKind, yaw: number, warn: number, speed: number, dmg: number, gapC = 0, gapW = 0, span = this.R - 1.5) {
    const s = this.pool.find((p) => !p.active);
    if (!s) return null;
    s.active = true;
    s.kind = kind;
    s.nx = Math.sin(yaw);
    s.nz = Math.cos(yaw);
    s.d = -span;
    s.d1 = span;
    s.prevSd = NaN;
    s.speed = speed;
    s.t = 0;
    s.warn = warn;
    s.dmg = dmg;
    s.hit = false;
    s.gapC = gapC;
    s.gapW = kind === 'wall' ? gapW : 0;
    const F = this.floor;
    if (kind === 'chain-low') {
      s.yMin = F - 0.3;
      s.yMax = F + 0.55;
    } else if (kind === 'chain-high') {
      s.yMin = F + 1.0;
      s.yMax = F + 1.55;
    } else {
      s.yMin = F - 3;
      s.yMax = F + WALL_H;
    }
    const decals = this.game.bosses.decals;
    s.decalA = decals.acquire().tint('unblockable');
    s.decalB = s.gapW > 0 ? decals.acquire().tint('unblockable') : null;
    s.wallA.visible = s.wallB.visible = false;
    this.place(s, 0);
    playSfx('stormCrackle', { pos: tmp.set(this.cx + s.nx * s.d, F + 1, this.cz + s.nz * s.d), intensity: 0.8 });
    return s;
  }

  get active() {
    return this.pool.some((s) => s.active);
  }

  private place(s: Sweep, fill: number) {
    const half = Math.sqrt(Math.max(1, this.R * this.R - s.d * s.d));
    const tx = -s.nz;
    const tz = s.nx;
    const ox = this.cx + s.nx * s.d;
    const oz = this.cz + s.nz * s.d;
    const yaw = Math.atan2(tx, tz);
    const w = s.kind === 'wall' ? 0.9 : 0.6;
    const y = this.floor;
    if (s.gapW > 0) {
      const g0 = Math.max(-half, s.gapC - s.gapW / 2);
      const g1 = Math.min(half, s.gapC + s.gapW / 2);
      s.decalA?.rect(ox - tx * half, y, oz - tz * half, yaw, Math.max(0.05, g0 + half), w);
      s.decalB?.rect(ox + tx * g1, y, oz + tz * g1, yaw, Math.max(0.05, half - g1), w);
      if (s.kind === 'wall' && s.t >= s.warn) {
        this.placeWall(s.wallA, ox - tx * half, oz - tz * half, yaw, g0 + half);
        this.placeWall(s.wallB, ox + tx * g1, oz + tz * g1, yaw, half - g1);
      }
    } else {
      s.decalA?.rect(ox - tx * half, y, oz - tz * half, yaw, 2 * half, w);
    }
    if (s.decalA) s.decalA.fill = fill;
    if (s.decalB) s.decalB.fill = fill;
  }

  private placeWall(m: Mesh, x: number, z: number, yaw: number, len: number) {
    m.visible = len > 0.1;
    // the plane spans local x (centred) → shift by half its length along the tangent
    m.position.set(x + Math.sin(yaw) * len * 0.5, this.floor - 0.2, z + Math.cos(yaw) * len * 0.5);
    m.rotation.set(0, yaw + Math.PI / 2, 0);
    m.scale.set(Math.max(0.1, len), WALL_H + 0.2, 1);
  }

  update(dt: number) {
    this.time += dt;
    this.wallMat.uniforms.uTime.value = this.time;
    const p = this.game.player;
    for (const s of this.pool) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t < s.warn) {
        this.place(s, s.t / s.warn);
        continue;
      }
      const moving = s.t - s.warn;
      if (moving > 0) s.d += s.speed * dt;
      this.place(s, 1);
      if (s.decalA) s.decalA.flash = 0.4;
      if (s.decalB) s.decalB.flash = 0.4;
      // hit test
      if (!s.hit && !p.dead) {
        const rx = p.position.x - this.cx;
        const rz = p.position.z - this.cz;
        const sd = rx * s.nx + rz * s.nz - s.d;
        const ts = -rx * s.nz + rz * s.nx;
        const thick = (s.kind === 'wall' ? 0.25 : 0.2) + PLAYER_RADIUS;
        const crossed = Math.abs(sd) < thick || (!Number.isNaN(s.prevSd) && s.prevSd * sd < 0);
        s.prevSd = sd;
        const inGap = s.gapW > 0 && Math.abs(ts - s.gapC) < s.gapW / 2 - PLAYER_RADIUS * 0.6;
        const py0 = p.position.y;
        const py1 = py0 + p.bodyHeight;
        if (crossed && !inGap && py1 > s.yMin && py0 < s.yMax) {
          const res = stormHit(this.boss, s.dmg, 8, 'unblockable', p.position.x - s.nx, py0 + 1, p.position.z - s.nz, true);
          if (res === 'hit' || res === 'blocked') s.hit = true;
        }
      }
      if (s.d >= s.d1) this.kill(s);
    }
  }

  /** draw the chains / wall crowns (inside BoltRenderer begin/end) */
  draw() {
    for (const s of this.pool) {
      if (!s.active) continue;
      const half = Math.sqrt(Math.max(1, this.R * this.R - s.d * s.d)) - 0.2;
      const tx = -s.nz;
      const tz = s.nx;
      const ox = this.cx + s.nx * s.d;
      const oz = this.cz + s.nz * s.d;
      const live = s.t >= s.warn;
      if (s.kind === 'wall') {
        if (!live) {
          // telegraph: a thin crackle along the floor where the wall will rise
          if (Math.random() < 0.5) this.chord(ox, oz, tx, tz, -half, half, this.floor + 0.15, 8, 0.15, 0.02, s);
          continue;
        }
        this.chord(ox, oz, tx, tz, -half, s.gapC - s.gapW / 2, this.floor + WALL_H, 6, 0.3, 0.05, s);
        this.chord(ox, oz, tx, tz, s.gapC + s.gapW / 2, half, this.floor + WALL_H, 6, 0.3, 0.05, s);
        // gap posts
        for (const e of [s.gapC - s.gapW / 2, s.gapC + s.gapW / 2]) {
          const x = ox + tx * e;
          const z = oz + tz * e;
          this.bolts.jagged(x, this.floor, z, x, this.floor + WALL_H, z, 6, 0.25, 0.06, LIGHTNING.red, LIGHTNING.redCore);
        }
        continue;
      }
      const y = (s.yMin + s.yMax) / 2;
      if (!live) {
        if (Math.random() < 0.45) this.chord(ox, oz, tx, tz, -half, half, y, 12, 0.12, 0.02, s);
      } else {
        this.chord(ox, oz, tx, tz, -half, half, y, 16, 0.22, 0.06, s);
        if (Math.random() < 0.5) this.chord(ox, oz, tx, tz, -half, half, y, 10, 0.35, 0.03, s);
      }
    }
  }

  private chord(ox: number, oz: number, tx: number, tz: number, a: number, b: number, y: number, segs: number, amp: number, w: number, _s: Sweep) {
    if (b - a < 0.2) return;
    this.bolts.jagged(ox + tx * a, y, oz + tz * a, ox + tx * b, y, oz + tz * b, segs, amp, w, LIGHTNING.red, LIGHTNING.redCore);
  }

  private kill(s: Sweep) {
    s.active = false;
    s.decalA?.release(0.2);
    s.decalB?.release(0.2);
    s.decalA = s.decalB = null;
    s.wallA.visible = s.wallB.visible = false;
  }

  clear() {
    for (const s of this.pool) if (s.active) this.kill(s);
  }
}

// ====================================================================== orbs
class Orb implements Hittable {
  readonly position = new Vector3();
  readonly vel = new Vector3();
  readonly radius = 0.55;
  alive = false;
  readonly lockable = false;
  readonly airborne = true;
  life = 0;
  age = 0;
  constructor(readonly owner: Orbs, readonly mesh: Mesh, readonly shell: Mesh) {}
  onHit(_info: HitInfo) {
    if (this.alive) this.owner.pop(this);
  }
}

/** Slow homing orbs: outrun them, or hit them (one hit pops them). They explode on contact. */
export class Orbs {
  readonly list: Orb[] = [];
  private readonly scratch = new Vector3();
  speed = 4.4;
  turn = 1.7;

  constructor(private readonly game: Game, private readonly boss: Boss, private readonly floor: number, private readonly onBurst: (x: number, y: number, z: number) => void) {
    const geo = new IcosahedronGeometry(1, 1);
    const shellGeo = new IcosahedronGeometry(1, 0);
    for (let i = 0; i < 8; i++) {
      const mesh = new Mesh(geo, new MeshBasicMaterial({ color: LIGHTNING.cyan.clone().multiplyScalar(0.9), toneMapped: false }));
      const shell = new Mesh(shellGeo, new MeshBasicMaterial({ color: LIGHTNING.violet.clone().multiplyScalar(0.5), transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false, wireframe: true, toneMapped: false }));
      mesh.visible = shell.visible = false;
      game.scene.add(mesh, shell);
      const o = new Orb(this, mesh, shell);
      this.list.push(o);
      game.world.targets.push(o);
    }
  }

  spawn(x: number, y: number, z: number, vx: number, vz: number) {
    const o = this.list.find((q) => !q.alive);
    if (!o) return;
    o.alive = true;
    o.position.set(x, y, z);
    o.vel.set(vx, 0, vz);
    o.life = 10;
    o.age = 0;
    o.mesh.visible = o.shell.visible = true;
  }

  get count() {
    let n = 0;
    for (const o of this.list) if (o.alive) n++;
    return n;
  }

  /** popped by a player attack: harmless burst */
  pop(o: Orb) {
    this.kill(o);
    this.game.fx.sparks.emit({ count: 22, position: o.position, spread: 0.2, speed: 5, life: [0.15, 0.4], size: [0.05, 0.12], color: LIGHTNING.cyan, color2: LIGHTNING.violet, gravity: 3, drag: 3 });
    playSfx('stormOrb', { pos: o.position, variant: 'pop' });
  }

  private explode(o: Orb) {
    this.kill(o);
    const p = this.game.player;
    this.game.fx.waves.spawn(o.position, 1.8, TelegraphColors.magic, 0.35, 0.25);
    this.game.fx.sparks.emit({ count: 34, position: o.position, spread: 0.3, speed: 7, life: [0.15, 0.45], size: [0.06, 0.15], color: LIGHTNING.cyan, color2: LIGHTNING.core, gravity: 4, drag: 3 });
    playSfx('stormOrb', { pos: o.position, variant: 'boom' });
    this.onBurst(o.position.x, o.position.y, o.position.z);
    const cy = Math.max(p.position.y + 0.3, Math.min(p.position.y + 1.6, o.position.y));
    if (Math.hypot(p.position.x - o.position.x, cy - o.position.y, p.position.z - o.position.z) < 1.8 + PLAYER_RADIUS) {
      stormHit(this.boss, 20, 7, 'magic', o.position.x, o.position.y, o.position.z);
    }
  }

  private kill(o: Orb) {
    o.alive = false;
    o.mesh.visible = o.shell.visible = false;
  }

  update(dt: number) {
    const p = this.game.player;
    const w = this.game.world;
    for (const o of this.list) {
      if (!o.alive) continue;
      o.age += dt;
      o.life -= dt;
      if (o.life <= 0) {
        this.pop(o);
        continue;
      }
      // steer (after a short drift-out) toward the player, turn-rate limited, constant speed
      if (o.age > 0.6 && !p.dead) {
        const want = Math.atan2(p.position.x - o.position.x, p.position.z - o.position.z);
        const cur = Math.atan2(o.vel.x, o.vel.z);
        let d = want - cur;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const nyaw = cur + Math.max(-this.turn * dt, Math.min(this.turn * dt, d));
        o.vel.set(Math.sin(nyaw) * this.speed, 0, Math.cos(nyaw) * this.speed);
      } else {
        o.vel.multiplyScalar(Math.exp(-1.5 * dt));
      }
      o.position.addScaledVector(o.vel, dt);
      // hover over the floor, slide around pylons
      const g = w.groundAt(o.position.x, o.position.z, o.position.y);
      const targetY = Math.max(g, this.floor - 0.2) + 1.25;
      o.position.y += (targetY - o.position.y) * Math.min(1, dt * 4);
      const s = this.scratch.set(o.position.x, o.position.y - 0.6, o.position.z);
      w.resolveCollisions(s, 0.5, 0.2, 1.2);
      o.position.x = s.x;
      o.position.z = s.z;
      // visuals
      const pulse = 1 + 0.12 * Math.sin(o.age * 14);
      o.mesh.position.copy(o.position);
      o.mesh.scale.setScalar(0.32 * pulse);
      o.shell.position.copy(o.position);
      o.shell.scale.setScalar(0.62 / pulse);
      o.shell.rotation.set(o.age * 2.1, o.age * 3.3, 0);
      if (Math.random() < 0.35) {
        this.game.fx.sparks.emit({ count: 1, position: o.position, spread: 0.35, speed: 0.8, life: [0.15, 0.3], size: [0.05, 0.1], color: LIGHTNING.cyan, drag: 2 });
      }
      // contact
      if (!p.dead && o.age > 0.4) {
        const cy = Math.max(p.position.y + 0.3, Math.min(p.position.y + 1.6, o.position.y));
        if (Math.hypot(p.position.x - o.position.x, cy - o.position.y, p.position.z - o.position.z) < o.radius + PLAYER_RADIUS + 0.1) this.explode(o);
      }
    }
  }

  clear() {
    for (const o of this.list) if (o.alive) this.kill(o);
  }

  dispose() {
    for (const o of this.list) {
      const i = this.game.world.targets.indexOf(o);
      if (i >= 0) this.game.world.targets.splice(i, 1);
      this.game.scene.remove(o.mesh, o.shell);
    }
  }
}

// ====================================================================== markers
/** Spinning gold halos around reflectable bolts ("parry me"). */
export class BoltMarkers {
  readonly mesh: InstancedMesh;
  private readonly tracked: Projectile[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private t = 0;

  constructor(scene: Scene) {
    const mat = new MeshBasicMaterial({ color: TelegraphColors.parryable.clone().multiplyScalar(0.9), transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mesh = new InstancedMesh(new TorusGeometry(1, 0.13, 4, 14), mat, 32);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  track(p: Projectile) {
    if (this.tracked.length < 32 && !this.tracked.includes(p)) this.tracked.push(p);
  }

  update(dt: number, owners: readonly unknown[]) {
    this.t += dt;
    let n = 0;
    for (let i = this.tracked.length - 1; i >= 0; i--) {
      const p = this.tracked[i];
      if (!p.active || p.reflected || !owners.includes(p.owner)) {
        this.tracked.splice(i, 1);
        continue;
      }
      tmp.copy(p.vel).normalize();
      this.q.setFromUnitVectors(tmp2.set(0, 0, 1), tmp);
      const r = p.radius * (1.9 + 0.25 * Math.sin(this.t * 20 + i));
      this.s.set(r, r, r);
      this.m.compose(p.pos, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.tracked.length = 0;
    this.mesh.count = 0;
  }
}

// ====================================================================== thunderfall
const TF_VERT = /* glsl */ `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const TF_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform vec3 uSafe; uniform vec3 uPockets[3]; uniform float uFill; uniform float uAlpha; uniform float uTime;
  uniform vec2 uCentre; uniform float uRadius;
  varying vec3 vW;
  void main() {
    vec2 p = vW.xz;
    float ring = 0.0;
    for (int i = 0; i < 3; i++) {
      vec3 k = uPockets[i];
      if (k.z <= 0.0) continue;
      float d = length(p - k.xy);
      if (d < k.z - 0.12) {
        // inside a safe pocket: only a faint safe tint
        gl_FragColor = vec4(uSafe * 0.25, 0.12 * uAlpha);
        return;
      }
      ring = max(ring, smoothstep(0.35, 0.0, abs(d - k.z)));
    }
    float r = length(p - uCentre) / uRadius;
    if (r > 1.0) discard;
    float pulse = 0.85 + 0.15 * sin(uTime * 16.0);
    float grid = smoothstep(0.4, 0.5, abs(fract(length(p - uCentre) * 0.5 - uTime * 0.6) - 0.5));
    float filled = step(1.0 - uFill, r) * 0.18 + uFill * 0.06;
    vec3 col = mix(uColor * (0.12 + filled + grid * 0.2) * pulse * 0.5, uSafe * 1.4, ring);
    float a = (0.08 + filled + grid * 0.15 + ring * 0.9) * uAlpha;
    gl_FragColor = vec4(col, a);
  }`;

/** Arena-wide red telegraph with up to three safe pockets (bright green rings). */
export class ThunderfallDecal {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly pockets = [new Vector3(), new Vector3(), new Vector3()];

  constructor(scene: Scene, cx: number, cz: number, y: number, radius: number) {
    this.mat = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      uniforms: {
        uColor: { value: TelegraphColors.unblockable.clone() }, uSafe: { value: LIGHTNING.safe.clone() },
        uPockets: { value: this.pockets }, uFill: { value: 0 }, uAlpha: { value: 1 }, uTime: { value: 0 },
        uCentre: { value: new Vector2(cx, cz) }, uRadius: { value: radius },
      },
      vertexShader: TF_VERT, fragmentShader: TF_FRAG,
    });
    this.mesh = new Mesh(new CircleGeometry(radius, 64).rotateX(-Math.PI / 2), this.mat);
    this.mesh.position.set(cx, y + 0.06, cz);
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  show(pockets: { x: number; z: number; r: number }[]) {
    for (let i = 0; i < 3; i++) {
      const k = pockets[i];
      this.pockets[i].set(k ? k.x : 0, k ? k.z : 0, k ? k.r : 0);
    }
    this.mesh.visible = true;
    this.mat.uniforms.uAlpha.value = 1;
  }

  set(fill: number, time: number, alpha = 1) {
    this.mat.uniforms.uFill.value = fill;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uAlpha.value = alpha;
  }

  hide() {
    this.mesh.visible = false;
  }
}
