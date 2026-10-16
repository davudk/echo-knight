import { AdditiveBlending, Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, type Scene } from 'three';
import type { TelegraphKind } from './types';

/**
 * Pooled ground decals for telegraphs: circle, ring, sector (cone / sweep) and rect (line / laser).
 * One shared plane geometry + one ShaderMaterial per pooled decal; no allocations per frame.
 *
 *   const d = decals.acquire().circle(x, y, z, 3).tint('unblockable');
 *   d.fill = progress;          // 0..1 — the inside fills up as the impact approaches
 *   d.release(0.25);            // fade out, then back to the pool
 */
export const TelegraphColors: Record<TelegraphKind, Color> = {
  parryable: new Color(2.6, 1.75, 0.45),
  unblockable: new Color(3.0, 0.14, 0.08),
  magic: new Color(0.35, 1.7, 2.6),
};

const SHAPE = { circle: 0, ring: 1, sector: 2, rect: 3 } as const;
type Shape = keyof typeof SHAPE;

const VERT = /* glsl */ `
  varying vec2 vP;
  void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uShape; uniform float uFill; uniform float uAlpha; uniform float uArc;
  uniform float uInner; uniform float uEdge; uniform float uTime; uniform float uFlash;
  varying vec2 vP;
  void main() {
    float d = length(vP);
    float inside = 0.0; float edge = 0.0; float prog = d;
    if (uShape < 0.5) {            // circle
      inside = step(d, 1.0); edge = 1.0 - d;
    } else if (uShape < 1.5) {     // ring band [uInner, 1]
      inside = step(uInner, d) * step(d, 1.0); edge = min(d - uInner, 1.0 - d); prog = 0.0;
    } else if (uShape < 2.5) {     // sector, centred on +z, half-angle uArc
      float a = abs(atan(vP.x, vP.y));
      inside = step(d, 1.0) * step(a, uArc); edge = min(1.0 - d, (uArc - a) * max(d, 0.05));
    } else {                        // rect, filling from -z to +z
      inside = step(abs(vP.x), 1.0) * step(abs(vP.y), 1.0); edge = min(1.0 - abs(vP.x), 1.0 - abs(vP.y));
      prog = (vP.y + 1.0) * 0.5;
    }
    if (inside < 0.5) discard;
    float outline = 1.0 - smoothstep(0.0, uEdge, edge);
    float filled = step(prog, uFill);
    float pulse = 0.85 + 0.15 * sin(uTime * 18.0);
    float a = (outline * 0.95 * pulse + 0.10 + filled * 0.3 + uFlash * 0.35) * uAlpha;
    gl_FragColor = vec4(uColor * (1.0 + uFlash * 0.4), a);
  }`;

const geo = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

export class Decal {
  readonly mesh: Mesh;
  readonly mat: ShaderMaterial;
  inUse = false;
  /** 0..1 inside fill */
  fill = 0;
  /** extra brightness (impact flash) 0..1, decays automatically */
  flash = 0;
  /** opacity multiplier */
  alpha = 1;
  private fadeLeft = 0;
  private fadeTotal = 0;

  constructor(scene: Scene) {
    this.mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: {
        uColor: { value: new Color() }, uShape: { value: 0 }, uFill: { value: 0 }, uAlpha: { value: 1 },
        uArc: { value: 1 }, uInner: { value: 0.8 }, uEdge: { value: 0.05 }, uTime: { value: 0 }, uFlash: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  private shape(s: Shape, size: number) {
    this.mat.uniforms.uShape.value = SHAPE[s];
    this.mat.uniforms.uEdge.value = Math.min(0.5, 0.14 / Math.max(0.2, size));
  }

  /** Disc of `radius` centred at (x, y, z). */
  circle(x: number, y: number, z: number, radius: number) {
    this.shape('circle', radius);
    this.mesh.position.set(x, y + 0.04, z);
    this.mesh.rotation.set(0, 0, 0);
    this.mesh.scale.set(radius, 1, radius);
    return this;
  }

  /** Ring band: outer `radius`, `thickness` metres wide. */
  ring(x: number, y: number, z: number, radius: number, thickness: number) {
    this.shape('ring', thickness);
    this.mesh.position.set(x, y + 0.05, z);
    this.mesh.rotation.set(0, 0, 0);
    const r = Math.max(0.05, radius);
    this.mesh.scale.set(r, 1, r);
    this.mat.uniforms.uInner.value = Math.max(0, 1 - thickness / r);
    return this;
  }

  /** Pie slice from (x, z), centred on `yaw` (facing convention: forward = (sin yaw, cos yaw)), full `arcRad` wide. */
  sector(x: number, y: number, z: number, yaw: number, radius: number, arcRad: number) {
    this.shape('sector', radius);
    this.mesh.position.set(x, y + 0.04, z);
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.scale.set(radius, 1, radius);
    this.mat.uniforms.uArc.value = Math.min(Math.PI, arcRad / 2);
    return this;
  }

  /** Strip starting at (x, z) going `length` along `yaw`, `width` wide (line / laser). */
  rect(x: number, y: number, z: number, yaw: number, length: number, width: number) {
    this.shape('rect', width);
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    this.mesh.position.set(x + s * length * 0.5, y + 0.04, z + c * length * 0.5);
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.scale.set(width / 2, 1, length / 2);
    return this;
  }

  tint(kind: TelegraphKind | Color) {
    (this.mat.uniforms.uColor.value as Color).copy(kind instanceof Color ? kind : TelegraphColors[kind]);
    return this;
  }

  /** Fade out over `seconds`, then return to the pool. */
  release(seconds = 0.2) {
    if (!this.inUse || this.fadeTotal > 0) return;
    this.fadeTotal = Math.max(0.01, seconds);
    this.fadeLeft = this.fadeTotal;
  }

  /** @internal */
  activate() {
    this.inUse = true;
    this.fill = 0;
    this.flash = 0;
    this.alpha = 1;
    this.fadeLeft = 0;
    this.fadeTotal = 0;
    this.mesh.visible = true;
  }

  /** @internal returns false when it went back to the pool */
  tick(dt: number, time: number): boolean {
    let fade = 1;
    if (this.fadeTotal > 0) {
      this.fadeLeft -= dt;
      if (this.fadeLeft <= 0) {
        this.inUse = false;
        this.mesh.visible = false;
        return false;
      }
      fade = this.fadeLeft / this.fadeTotal;
    }
    this.flash = Math.max(0, this.flash - dt * 4);
    const u = this.mat.uniforms;
    u.uFill.value = this.fill;
    u.uAlpha.value = this.alpha * fade;
    u.uTime.value = time;
    u.uFlash.value = this.flash;
    return true;
  }
}

export class Decals {
  private readonly pool: Decal[] = [];
  private time = 0;

  constructor(private readonly scene: Scene, prealloc = 24) {
    for (let i = 0; i < prealloc; i++) this.pool.push(new Decal(scene));
  }

  acquire(): Decal {
    let d = this.pool.find((x) => !x.inUse);
    if (!d) {
      d = new Decal(this.scene);
      this.pool.push(d);
    }
    d.activate();
    return d;
  }

  /** Hide everything immediately (boss reset). */
  clear() {
    for (const d of this.pool) {
      d.inUse = false;
      d.mesh.visible = false;
    }
  }

  update(dt: number) {
    this.time += dt;
    for (const d of this.pool) if (d.inUse) d.tick(dt, this.time);
  }
}
