import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  Points,
  ShaderMaterial,
  Vector3,
  type Blending,
} from 'three';

export interface EmitOptions {
  count: number;
  position: Vector3;
  /** random spawn offset radius */
  spread?: number;
  /** base velocity applied to all */
  velocity?: Vector3;
  /** random speed magnitude */
  speed?: number;
  /** restrict random direction to the horizontal plane (dust rings) */
  flat?: boolean;
  upBias?: number;
  life?: [number, number];
  size?: [number, number];
  color: Color;
  color2?: Color;
  gravity?: number;
  drag?: number;
}

/**
 * Pooled CPU particle system rendered as a single Points draw call.
 * One instance per blend mode (glowy sparks vs. soft dust).
 */
export class ParticleSystem {
  readonly points: Points;
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly alpha: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private cursor = 0;
  private readonly geo: BufferGeometry;

  constructor(max: number, blending: Blending = AdditiveBlending, softness = 1) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);

    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new BufferAttribute(this.col, 3));
    this.geo.setAttribute('size', new BufferAttribute(this.size, 1));
    this.geo.setAttribute('alpha', new BufferAttribute(this.alpha, 1));

    const additive = blending === AdditiveBlending;
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      uniforms: { uScale: { value: 400 }, uSoft: { value: softness } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uSoft;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          float a = 1.0 - smoothstep(1.0 - uSoft, 1.0, d);
          if (a <= 0.0 || vAlpha <= 0.0) discard;
          gl_FragColor = vec4(vColor, a * vAlpha);
        }`,
    });
    this.points = new Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  setViewportHeight(h: number) {
    (this.points.material as ShaderMaterial).uniforms.uScale.value = h * 0.6;
  }

  emit(o: EmitOptions) {
    const spread = o.spread ?? 0;
    const speed = o.speed ?? 1;
    const [l0, l1] = o.life ?? [0.4, 0.8];
    const [s0, s1] = o.size ?? [0.1, 0.2];
    for (let n = 0; n < o.count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const i3 = i * 3;
      // random direction
      let dx = Math.random() * 2 - 1;
      let dy = o.flat ? 0 : Math.random() * 2 - 1;
      let dz = Math.random() * 2 - 1;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      dy += o.upBias ?? 0;
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.pos[i3] = o.position.x + (Math.random() * 2 - 1) * spread;
      this.pos[i3 + 1] = o.position.y + (o.flat ? 0 : (Math.random() * 2 - 1) * spread);
      this.pos[i3 + 2] = o.position.z + (Math.random() * 2 - 1) * spread;
      this.vel[i3] = dx * sp + (o.velocity?.x ?? 0);
      this.vel[i3 + 1] = dy * sp + (o.velocity?.y ?? 0);
      this.vel[i3 + 2] = dz * sp + (o.velocity?.z ?? 0);
      const t = Math.random();
      const c2 = o.color2 ?? o.color;
      this.col[i3] = o.color.r + (c2.r - o.color.r) * t;
      this.col[i3 + 1] = o.color.g + (c2.g - o.color.g) * t;
      this.col[i3 + 2] = o.color.b + (c2.b - o.color.b) * t;
      this.baseSize[i] = s0 + Math.random() * (s1 - s0);
      this.maxLife[i] = this.life[i] = l0 + Math.random() * (l1 - l0);
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 2;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const i3 = i * 3;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= k;
      this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.grav[i] * dt;
      this.vel[i3 + 2] *= k;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = t < 0.7 ? t / 0.7 : 1 - (t - 0.7) / 0.3 * 0.3;
      this.size[i] = this.baseSize[i] * (0.6 + 0.4 * t + (1 - t) * 0.6);
    }
    for (const name of ['position', 'color', 'size', 'alpha']) this.geo.getAttribute(name).needsUpdate = true;
  }
}
