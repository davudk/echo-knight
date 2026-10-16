import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { Tuning } from '../config/tuning';
import { events } from '../core/Events';
import { Colors, type Fx } from '../fx/Fx';
import { Ghost } from '../fx/Ghost';
import type { Player } from '../player/Player';
import type { CylinderCollider, World } from '../world/World';

export type EchoBody = 'phantom' | 'platform' | 'mimic';

/**
 * Platform echo: a solid hex slab hovering just above the echo's head. Only the slab collides
 * (you can walk through the hologram body underneath; the camera isn't pushed around by it).
 */
export const PLATFORM = {
  radius: 0.85,
  /** top surface above the echo's feet (full jump apex is ~1.84 m; landing tolerance 0.45 m) */
  top: 2.0,
  /** collider thickness (below the top) — the player is 1.6 m tall, so it clears his head */
  depth: 0.3,
  thickness: 0.16,
};

/** Mimic echo: delay behind the player and damage share. */
export const MIMIC = {
  lag: 0.1,
  damageScale: 0.6,
  /** turn toward a target within this distance when repeating an attack */
  aimRange: 4.5,
};

const PLATFORM_COLOR = new Color(0.45, 1.05, 1.25);

let ringGeometry: BufferGeometry | null = null;
function sharedRing() {
  if (ringGeometry) return ringGeometry;
  const g = new RingGeometry(0.75, 1.0, 48, 1).rotateX(-Math.PI / 2);
  // RingGeometry uvs aren't polar; remap so x = angle, y = radius
  const uv = g.getAttribute('uv');
  const pos = g.getAttribute('position');
  for (let i = 0; i < uv.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    uv.setXY(i, (Math.atan2(z, x) / (Math.PI * 2) + 1) % 1, (Math.hypot(x, z) - 0.75) / 0.25);
  }
  ringGeometry = g;
  return g;
}

function ringMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: { uColor: { value: Colors.echo.clone() }, uT: { value: 0 }, uO: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uT; uniform float uO;
      varying vec2 vUv;
      void main() {
        float r = vUv.y; // 0 inner .. 1 outer
        float a = smoothstep(0.0, 0.3, r) * (1.0 - smoothstep(0.7, 1.0, r));
        float dash = step(0.35, fract(vUv.x * 12.0 + uT * 0.4));
        gl_FragColor = vec4(uColor, a * (0.35 + dash * 0.5) * uO);
      }`,
  });
}

/** A pending mimic swing (scheduled relative to the echo's own clock). */
interface MimicSwing {
  move: string;
  clip: string;
  speed: number;
  clipStart: number;
  heavy: boolean;
  /** seconds until the clip starts */
  startIn: number;
  /** seconds after the clip starts that the hit lands */
  hitAt: number;
  started: boolean;
  hitDone: boolean;
}

/**
 * One echo in the stack: hologram ghost, floor ring, light, and the optional platform slab /
 * mimic animation. Pooled — `EchoRecall` owns up to three and re-places them.
 */
export class EchoInstance {
  active = false;
  readonly position = new Vector3();
  facing = 0;
  life = 0;
  maxLife = 6;
  /** seconds since placed (or last swapped) — drives the fade-in */
  age = 0;
  body: EchoBody = 'phantom';
  /** index into the recorded path when this echo was placed (rewind) */
  sampleIndex = 0;
  /** while true the echo is held in place by a rewind and must not expire */
  pinned = false;

  readonly ghost: Ghost;
  private readonly ring: Mesh;
  private readonly ringMat: ShaderMaterial;
  private readonly light: PointLight;
  private emit = 0;

  // platform
  private readonly slab = new Group();
  private readonly slabFill: MeshBasicMaterial;
  private readonly slabEdge: LineBasicMaterial;
  readonly collider: CylinderCollider = { x: 0, z: 0, r: PLATFORM.radius, bottom: 0, top: 0, tag: 'echo-platform' };
  /** collider registered with the world */
  solid = false;
  private solidPulse = 0;

  // mimic
  private swings: MimicSwing[] = [];
  private attackFacing = 0;

  constructor(
    private readonly player: Player,
    private readonly world: World,
    private readonly fx: Fx,
  ) {
    this.ghost = new Ghost(player.model.model, Colors.echo.clone());
    this.ghost.enableAnimation((name) => player.model.getClip(name));
    world.scene.add(this.ghost.root);

    this.ringMat = ringMaterial();
    this.ring = new Mesh(sharedRing(), this.ringMat);
    this.ring.visible = false;
    this.ring.renderOrder = 3;
    world.scene.add(this.ring);

    this.light = new PointLight(new Color('#6fd8ff'), 0, 7, 1.6);
    world.scene.add(this.light);

    // Hex slab: translucent glass fill + glowing rim.
    const hex = new CylinderGeometry(PLATFORM.radius, PLATFORM.radius * 0.92, PLATFORM.thickness, 6, 1);
    this.slabFill = new MeshBasicMaterial({
      color: new Color(0.12, 0.38, 0.48), transparent: true, opacity: 0.55, depthWrite: false,
    });
    this.slabEdge = new LineBasicMaterial({
      color: new Color(0.55, 1.2, 1.5), transparent: true, blending: AdditiveBlending, depthWrite: false,
    });
    const fill = new Mesh(hex, this.slabFill);
    fill.renderOrder = 2;
    const edge = new LineSegments(new EdgesGeometry(hex), this.slabEdge);
    edge.renderOrder = 3;
    this.slab.add(fill, edge);
    this.slab.visible = false;
    world.scene.add(this.slab);
  }

  // ---------------------------------------------------------------- lifecycle
  place(body: EchoBody, lifetime: number, sampleIndex: number) {
    const p = this.player;
    this.active = true;
    this.body = body;
    this.maxLife = lifetime;
    this.life = lifetime;
    this.sampleIndex = sampleIndex;
    this.pinned = false;
    this.swings.length = 0;
    this.capture(p.position, p.facing);
  }

  /** Snapshot the player's pose at `pos` (place, or swap). */
  capture(pos: Vector3, facing: number) {
    this.position.copy(pos);
    this.facing = facing;
    this.attackFacing = facing;
    this.age = 0;
    this.swings.length = 0;
    this.ghost.capture();
    this.ghost.setOpacity(0);
    this.applyBodyLook();

    const g = this.world.groundAt(pos.x, pos.z, pos.y + 0.1);
    this.ring.position.set(pos.x, g + 0.05, pos.z);
    this.ring.visible = true;
    this.light.position.copy(pos).setY(pos.y + 1.2);

    if (this.body === 'platform') {
      this.setSolid(false);
      this.collider.x = pos.x;
      this.collider.z = pos.z;
      this.collider.bottom = pos.y + PLATFORM.top - PLATFORM.depth;
      this.collider.top = pos.y + PLATFORM.top;
      this.slab.position.set(pos.x, pos.y + PLATFORM.top - PLATFORM.thickness / 2, pos.z);
      this.slab.rotation.y = facing;
      this.slab.visible = true;
      this.solidPulse = 0;
    } else {
      this.slab.visible = false;
    }
  }

  /** Remove from the world (recall / expire / dissolve). */
  hide() {
    this.active = false;
    this.pinned = false;
    this.ghost.stopAnimation();
    this.ghost.root.visible = false;
    this.ring.visible = false;
    this.slab.visible = false;
    this.light.intensity = 0;
    this.setSolid(false);
    this.swings.length = 0;
  }

  get chest() {
    return this.position.clone().setY(this.position.y + 1);
  }

  private applyBodyLook() {
    const u = this.ghost.material.uniforms;
    if (this.body === 'platform') {
      (u.uColor.value as Color).copy(PLATFORM_COLOR);
      u.uFill.value = 0.2;
      u.uScan.value = 0.35;
    } else {
      (u.uColor.value as Color).copy(Colors.echo);
      u.uFill.value = 0.06;
      u.uScan.value = 1;
    }
  }

  setSolid(v: boolean) {
    if (v === this.solid) return;
    this.solid = v;
    if (v) this.world.addCollider(this.collider);
    else this.world.removeCollider(this.collider);
  }

  /** Does the player's body currently overlap the slab (it only turns solid once clear)? */
  private playerOverlaps() {
    const p = this.player.position;
    const c = this.collider;
    if (p.y >= c.top - 0.45 || p.y + 1.6 <= c.bottom) return false;
    const r = c.r + Tuning.player.radius + 0.05;
    return (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < r * r;
  }

  // ---------------------------------------------------------------- mimic
  /** Queue a replay of one of the player's attacks. */
  mimic(e: { move: string; clip: string; speed: number; clipStart: number; heavy: boolean }, hitAt: number) {
    if (!this.active || this.body !== 'mimic') return;
    this.swings.push({ ...e, startIn: MIMIC.lag, hitAt, started: false, hitDone: false });
  }

  /** Called by EchoRecall when a mimic swing should deal damage. */
  onSwingHit: (echo: EchoInstance, origin: Vector3, facing: number, swing: { move: string; heavy: boolean }) => void = () => {};

  private updateMimic(dt: number) {
    if (this.body !== 'mimic' || !this.swings.length) return;
    for (const s of this.swings) {
      if (!s.started) {
        s.startIn -= dt;
        if (s.startIn > 0) continue;
        s.started = true;
        // A newer swing supersedes one still winding up.
        for (const o of this.swings) if (o !== s && o.started) o.hitDone = true;
        this.attackFacing = this.aimFacing();
        this.ghost.setUpright(this.position, this.attackFacing);
        this.ghost.playOnce(s.clip, s.speed, s.clipStart);
        this.fx.echoBurst(this.chest, 10, 1.5);
        events.emit('echo:mimic', { position: this.position.clone(), move: s.move });
        continue;
      }
      if (s.hitDone) continue;
      s.hitAt -= dt;
      if (s.hitAt <= 0) {
        s.hitDone = true;
        this.onSwingHit(this, this.chest, this.attackFacing, s);
      }
    }
    this.swings = this.swings.filter((s) => !s.hitDone);
  }

  /** Face the nearest target in range, else keep the echo's own facing. */
  private aimFacing() {
    let best = MIMIC.aimRange;
    let yaw = this.facing;
    for (const t of this.world.targets) {
      if (t.alive === false) continue;
      const dx = t.position.x - this.position.x;
      const dz = t.position.z - this.position.z;
      if (Math.abs(t.position.y - this.position.y) > 2.5) continue;
      const d = Math.hypot(dx, dz);
      if (d < best) {
        best = d;
        yaw = Math.atan2(dx, dz);
      }
    }
    return yaw;
  }

  // ---------------------------------------------------------------- frame
  /** Visual + platform update. Returns false when the echo has run out of time. */
  update(dt: number, time: number): boolean {
    this.age += dt;
    if (!this.pinned) this.life -= dt;
    if (this.life <= 0) return false;

    // Platform turns solid once the player has stepped off its footprint.
    if (this.body === 'platform' && !this.solid && !this.pinned && !this.playerOverlaps()) {
      this.setSolid(true);
      this.solidPulse = 1;
      this.fx.waves.spawn(this.slab.position, 1.4, PLATFORM_COLOR, 0.3, 0.12);
    }

    this.updateMimic(dt);
    this.ghost.updateAnimation(dt);

    // Flicker as it's about to expire.
    const E = Tuning.echo;
    let o = 1;
    if (this.life < E.flickerLast && !this.pinned) {
      const k = 1 - this.life / E.flickerLast;
      o = 0.55 + 0.45 * Math.sin(time * (14 + k * 30)) * (1 - k * 0.5);
      o *= 1 - k * 0.4;
    }
    o *= Math.min(1, this.age / 0.15);
    this.ghost.setOpacity(o);
    this.ghost.setTime(time);
    this.ringMat.uniforms.uT.value = time;
    this.ringMat.uniforms.uO.value = o;
    this.light.intensity = 2.2 * o;

    if (this.slab.visible) {
      this.solidPulse = Math.max(0, this.solidPulse - dt * 3);
      const base = this.solid ? 1 : 0.35;
      this.slabFill.opacity = (0.5 * base + this.solidPulse * 0.3) * o;
      this.slabEdge.opacity = (0.75 * base + this.solidPulse * 0.25) * o;
      const s = 1 + this.solidPulse * 0.08;
      this.slab.scale.set(s, 1, s);
    }

    this.emit -= dt;
    if (this.emit <= 0) {
      this.emit = 0.06;
      this.fx.sparks.emit({
        count: 2, position: this.chest, spread: 0.45,
        velocity: new Vector3(0, 1.1, 0), speed: 0.3, life: [0.6, 1.1], size: [0.04, 0.09],
        color: Colors.echoParticle, color2: Colors.echoParticle2, drag: 0.5,
      });
    }
    return true;
  }
}
