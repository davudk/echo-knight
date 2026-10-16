import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  Object3D,
  ShaderMaterial,
  Vector3,
} from 'three';

interface Sample {
  base: Vector3;
  tip: Vector3;
  t: number;
}

/**
 * Ribbon trail between two points on the blade. Samples age out after `life`
 * seconds, so the trail length naturally follows swing speed. Each new frame
 * segment is subdivided with Catmull-Rom so fast swings stay smooth.
 */
export class SwordTrail {
  readonly mesh: Mesh;
  active = false;
  private samples: Sample[] = [];
  private readonly maxSamples = 64;
  private readonly geo: BufferGeometry;
  private readonly pos: Float32Array;
  private readonly fade: Float32Array;
  private readonly baseLocal: Vector3;
  private readonly tipLocal: Vector3;
  private time = 0;
  private hasPrev = false;

  constructor(
    private readonly blade: Object3D,
    baseLocal: Vector3,
    tipLocal: Vector3,
    private readonly life = 0.14,
    color = new Color(1.6, 1.25, 0.85),
  ) {
    this.baseLocal = baseLocal.clone();
    this.tipLocal = tipLocal.clone();
    this.pos = new Float32Array(this.maxSamples * 2 * 3);
    this.fade = new Float32Array(this.maxSamples * 2);
    const idx: number[] = [];
    for (let i = 0; i < this.maxSamples - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('fade', new BufferAttribute(this.fade, 1));
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);

    this.mesh = new Mesh(
      this.geo,
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
        uniforms: { uColor: { value: color } },
        vertexShader: /* glsl */ `
          attribute float fade;
          varying float vFade;
          void main() {
            vFade = fade;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vFade;
          void main() {
            // vFade.x = age (1 new -> 0 old); edge brightening toward the tip handled by vertex order
            float a = pow(vFade, 1.6);
            gl_FragColor = vec4(uColor * (0.6 + a), a * 0.85);
          }`,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  setColor(c: Color) {
    ((this.mesh.material as ShaderMaterial).uniforms.uColor.value as Color).copy(c);
  }

  update(dt: number) {
    this.time += dt;
    if (this.active) {
      this.blade.updateWorldMatrix(true, false);
      const base = this.baseLocal.clone().applyMatrix4(this.blade.matrixWorld);
      const tip = this.tipLocal.clone().applyMatrix4(this.blade.matrixWorld);
      if (this.hasPrev && this.samples.length >= 2) {
        // subdivide between the previous sample and this one
        const n = this.samples.length;
        const p0 = this.samples[n - 2];
        const p1 = this.samples[n - 1];
        const sub = 3;
        for (let k = 1; k < sub; k++) {
          const u = k / sub;
          this.samples.push({
            base: catmull(p0.base, p1.base, base, base, u),
            tip: catmull(p0.tip, p1.tip, tip, tip, u),
            t: this.time - dt * (1 - u),
          });
        }
      }
      this.samples.push({ base, tip, t: this.time });
      this.hasPrev = true;
    } else {
      this.hasPrev = false;
    }

    // drop old samples
    while (this.samples.length && this.time - this.samples[0].t > this.life) this.samples.shift();
    while (this.samples.length > this.maxSamples) this.samples.shift();

    const n = this.samples.length;
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const age = 1 - (this.time - s.t) / this.life;
      const o = i * 6;
      this.pos[o] = s.base.x; this.pos[o + 1] = s.base.y; this.pos[o + 2] = s.base.z;
      this.pos[o + 3] = s.tip.x; this.pos[o + 4] = s.tip.y; this.pos[o + 5] = s.tip.z;
      this.fade[i * 2] = age * 0.35;
      this.fade[i * 2 + 1] = age;
    }
    this.geo.setDrawRange(0, n > 1 ? (n - 1) * 6 : 0);
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('fade').needsUpdate = true;
  }
}

function catmull(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return new Vector3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}
