import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';

interface Wave {
  mesh: Mesh;
  mat: ShaderMaterial;
  age: number;
  life: number;
  radius: number;
}

/** Expanding ground ring (slam AoE, echo placement, teleport arrival). */
export class Shockwaves {
  private readonly pool: Wave[] = [];
  private readonly geo = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

  constructor(private readonly parent: { add(o: Mesh): void }) {}

  spawn(pos: Vector3, radius: number, color: Color, life = 0.45, thickness = 0.18) {
    let w = this.pool.find((p) => p.age >= p.life);
    if (!w) {
      const mat = new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
        uniforms: { uColor: { value: new Color() }, uT: { value: 0 }, uThick: { value: 0.18 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uT; uniform float uThick;
          varying vec2 vUv;
          void main() {
            float r = length(vUv);
            float ring = 1.0 - smoothstep(0.0, uThick, abs(r - (0.25 + 0.75 * sqrt(uT))));
            float fill = (1.0 - smoothstep(0.0, 1.0, r)) * 0.1 * (1.0 - uT);
            float a = (ring * 0.8 + fill) * (1.0 - uT);
            if (a < 0.01) discard;
            gl_FragColor = vec4(uColor, a);
          }`,
      });
      const mesh = new Mesh(this.geo, mat);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      this.parent.add(mesh);
      w = { mesh, mat, age: 0, life: 1, radius: 1 };
      this.pool.push(w);
    }
    w.age = 0;
    w.life = life;
    w.radius = radius;
    w.mesh.visible = true;
    w.mesh.position.copy(pos).y += 0.06;
    w.mesh.scale.setScalar(radius);
    (w.mat.uniforms.uColor.value as Color).copy(color);
    w.mat.uniforms.uThick.value = thickness;
  }

  update(dt: number) {
    for (const w of this.pool) {
      if (w.age >= w.life) continue;
      w.age += dt;
      const t = Math.min(1, w.age / w.life);
      w.mat.uniforms.uT.value = t;
      if (t >= 1) w.mesh.visible = false;
    }
  }
}
