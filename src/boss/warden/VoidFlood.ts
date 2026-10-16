import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Game } from '../../core/Game';
import type { BoxCollider } from '../../world/World';
import { HazardZone, type BossArena } from '../Arena';
import { Difficulty } from '../difficulty';
import { playWardenSfx } from './sounds';
import type { KeepLayout } from './Keep';
import { VOID, VOID_BRIGHT } from './WardenEcho';

/**
 * Phase 3 arena pressure: the courtyard floor floods with void in waves.
 *
 *   calm ─▶ warn (mist rises, ripples, hum; echo platforms form) ─▶ rise ─▶ flooded (damage)
 *        ◀─ recede ◀──────────────────────────────────────────────────────────┘
 *
 * The damage is a `HazardZone` (registered on the arena, so a reset switches it off) whose
 * `contains` test is "feet below 0.45 m above the courtyard floor, inside the fog circle".
 * Safe: pillar stubs / pillars, the north ledge, the wall walk, and the hologram echo platforms
 * that form at the start of every wave (and vanish when it recedes).
 */

type FloodState = 'off' | 'calm' | 'warn' | 'rise' | 'flooded' | 'recede';

const LEVEL = 0.32; // visual surface height above the floor
const SAFE = 0.45; // feet at / above this are dry

const VERT = /* glsl */ `
  varying vec2 vP;
  void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uTime; uniform float uAlpha; uniform float uRadius;
  varying vec2 vP;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    float d = length(vP);
    float rip = sin(d * 2.2 - uTime * 3.0) * 0.5 + 0.5;
    float f = n(vP * 0.35 + vec2(uTime * 0.3, -uTime * 0.2)) * 0.6 + n(vP * 1.1 - vec2(uTime * 0.5, uTime * 0.4)) * 0.4;
    float edge = smoothstep(uRadius, uRadius - 1.5, d);
    float a = (0.35 + 0.45 * f + 0.2 * rip) * edge * uAlpha;
    gl_FragColor = vec4(uColor * (0.6 + f * 0.9 + rip * 0.3), a);
  }`;

const tmp = new Vector3();
const PLATFORM = new Color(0.9, 0.5, 2.2);

export class VoidFlood {
  state: FloodState = 'off';
  private t = 0;
  private dur = 0;
  /** 0..1 how high the void is */
  level = 0;
  readonly hazard: HazardZone;
  private readonly plane: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly platforms: { mesh: Mesh; collider: BoxCollider | null; x: number; z: number }[] = [];
  private readonly platMat: MeshBasicMaterial;
  private platAlpha = 0;
  /** waves survived (tests) */
  waves = 0;

  constructor(private readonly game: Game, private readonly layout: KeepLayout, arena: BossArena, radius: number) {
    const L = layout;
    this.hazard = arena.addHazard(new HazardZone(game, {
      x: L.cx, z: L.cz, radius, damage: 8, interval: 0.85, telegraph: 'unblockable',
      contains: (x, y, z) => this.wet && Math.hypot(x - L.cx, z - L.cz) < radius - 0.3 && y < L.H + SAFE,
    }));
    this.mat = new ShaderMaterial({
      transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending,
      uniforms: { uColor: { value: VOID.clone().multiplyScalar(0.55) }, uTime: { value: 0 }, uAlpha: { value: 0 }, uRadius: { value: radius } },
      vertexShader: VERT, fragmentShader: FRAG,
    });
    this.plane = new Mesh(new CircleGeometry(radius, 48), this.mat);
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.position.set(L.cx, L.H, L.cz);
    this.plane.visible = false;
    this.plane.renderOrder = 4;
    game.scene.add(this.plane);

    this.platMat = new MeshBasicMaterial({ color: PLATFORM, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
    const geo = new BoxGeometry(2.4, 2.0, 2.4);
    for (const s of L.platformSpots) {
      const mesh = new Mesh(geo, this.platMat);
      mesh.position.set(s.x, L.H + 0.5, s.z);
      mesh.visible = false;
      game.scene.add(mesh);
      this.platforms.push({ mesh, collider: null, x: s.x, z: s.z });
    }
  }

  /** The floor is wet enough to hurt. */
  get wet() {
    return this.state === 'flooded' || (this.state === 'rise' && this.level > 0.5);
  }

  /** Waves are running (warn → recede): the Warden prefers ranged pressure. */
  get pressing() {
    return this.state === 'warn' || this.state === 'rise' || this.state === 'flooded';
  }

  /** Begin the cycle; first warning after `delay` s. */
  start(delay = 2) {
    this.go('calm', delay);
  }

  /** Drain (desperation / death): recede now, then off. */
  stop() {
    if (this.state === 'off') return;
    if (this.level > 0.01) this.go('recede', 1.0);
    else this.go('off', 0);
    this.stopping = true;
  }

  /** Immediate reset. */
  reset() {
    this.stopping = false;
    this.state = 'off';
    this.level = 0;
    this.plane.visible = false;
    this.hazard.setActive(false);
    this.setPlatforms(false);
    this.platAlpha = 0;
    this.platMat.opacity = 0;
    for (const p of this.platforms) p.mesh.visible = false;
  }

  private stopping = false;

  private go(s: FloodState, dur: number) {
    this.state = s;
    this.t = 0;
    this.dur = dur;
    const tel = Difficulty.telegraph();
    if (s === 'warn') {
      this.setPlatforms(true);
      playWardenSfx('voidRise', this.center());
      this.game.hud.flash('The void wells up — find high ground', 2.2);
    } else if (s === 'flooded') {
      this.hazard.setActive(true);
      this.waves++;
    } else if (s === 'recede') {
      this.hazard.setActive(false);
    } else if (s === 'calm') {
      this.setPlatforms(false);
    } else if (s === 'off') {
      this.hazard.setActive(false);
      this.setPlatforms(false);
    }
    void tel;
  }

  private center() {
    return tmp.set(this.layout.cx, this.layout.H + 1, this.layout.cz);
  }

  private setPlatforms(on: boolean) {
    const w = this.game.world;
    const H = this.layout.H;
    for (const p of this.platforms) {
      if (on && !p.collider) {
        p.collider = w.addBox(p.x, p.z, 2.4, 2.4, H - 0.5, H + 1.5, 0, 'echo-platform');
        p.mesh.visible = true;
        this.game.fx.echoBurst(tmp.set(p.x, H + 1.5, p.z), 20, 2);
      } else if (!on && p.collider) {
        w.removeCollider(p.collider);
        p.collider = null;
      }
    }
  }

  update(dt: number) {
    if (this.state === 'off' && this.level <= 0 && this.platAlpha <= 0) return;
    this.t += dt;
    const tel = Difficulty.telegraph();
    switch (this.state) {
      case 'calm':
        this.level = Math.max(0, this.level - dt);
        if (this.t >= this.dur) this.go('warn', 2.8 * tel);
        break;
      case 'warn': {
        // mist rising from the whole floor, faster as the wave approaches
        const u = this.t / this.dur;
        this.level = 0.08 * u;
        this.mist(4 + Math.floor(u * 10));
        if (this.t >= this.dur) this.go('rise', 0.7);
        break;
      }
      case 'rise':
        this.level = Math.min(1, 0.08 + (this.t / this.dur) * 0.92);
        this.mist(6);
        if (this.t >= this.dur) this.go('flooded', 6.5);
        break;
      case 'flooded':
        this.level = 1;
        this.mist(2);
        if (this.t >= this.dur) this.go('recede', 1.4);
        break;
      case 'recede':
        this.level = Math.max(0, 1 - this.t / this.dur);
        if (this.t >= this.dur) {
          if (this.stopping) {
            this.stopping = false;
            this.go('off', 0);
          } else {
            this.go('calm', 9 + Math.random() * 3);
          }
        }
        break;
      case 'off':
        this.level = Math.max(0, this.level - dt);
        break;
    }
    // visuals
    const showPlat = this.state === 'warn' || this.state === 'rise' || this.state === 'flooded';
    this.platAlpha = Math.max(0, Math.min(1, this.platAlpha + (showPlat ? dt * 2 : -dt * 2)));
    this.platMat.opacity = 0.45 * this.platAlpha * (0.85 + 0.15 * Math.sin(this.game.time * 6));
    for (const p of this.platforms) p.mesh.visible = this.platAlpha > 0.01;
    this.plane.visible = this.level > 0.002;
    this.plane.position.y = this.layout.H + 0.02 + this.level * LEVEL;
    this.mat.uniforms.uTime.value = this.game.time;
    this.mat.uniforms.uAlpha.value = Math.min(1, this.level * 1.6);
  }

  private mist(n: number) {
    const L = this.layout;
    const fx = this.game.fx;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 18.5;
      tmp.set(L.cx + Math.cos(a) * r, L.H + 0.05 + this.level * LEVEL, L.cz + Math.sin(a) * r);
      fx.sparks.emit({
        count: 1, position: tmp, spread: 0.3, speed: 0.6, upBias: 1, life: [0.6, 1.4], size: [0.08, 0.22],
        color: VOID, color2: VOID_BRIGHT, gravity: -1.5, drag: 1.5,
      });
    }
  }

  dispose() {
    this.reset();
    this.game.scene.remove(this.plane);
    for (const p of this.platforms) this.game.scene.remove(p.mesh);
  }
}
