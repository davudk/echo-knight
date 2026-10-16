import {
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

/** Dusky gradient sky dome, sun + hemisphere light and matching fog. */
export class Sky {
  readonly sun: DirectionalLight;
  readonly sunDir = new Vector3(-0.78, 0.5, 0.15).normalize();
  private readonly dome: Mesh;

  constructor(scene: Scene) {
    const horizon = new Color('#d9a77a');
    const zenith = new Color('#2d3d5c');
    const ground = new Color('#3a3530');

    this.dome = new Mesh(
      new SphereGeometry(450, 32, 16),
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uHorizon: { value: horizon },
          uZenith: { value: zenith },
          uGround: { value: ground },
          uSunDir: { value: this.sunDir },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uHorizon, uZenith, uGround, uSunDir;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
            col = mix(col, uGround, smoothstep(0.0, -0.15, h));
            float s = max(dot(d, uSunDir), 0.0);
            col += vec3(1.0, 0.75, 0.45) * (pow(s, 600.0) * 6.0 + pow(s, 12.0) * 0.35);
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    scene.fog = new FogExp2(horizon.clone().lerp(zenith, 0.25), 0.0095);
    scene.background = horizon;

    scene.add(new HemisphereLight('#c4cee0', '#5a4c3a', 1.6));

    this.sun = new DirectionalLight('#ffd7a8', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = 22;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 120 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);
  }

  /** Keep the shadow frustum centred on the player and the dome on the camera. */
  update(focus: Vector3, cameraPos: Vector3) {
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 60);
    this.sun.target.position.copy(focus);
    this.dome.position.copy(cameraPos);
  }
}
