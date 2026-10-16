import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Mesh,
  PointLight,
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { Tuning } from '../config/tuning';
import { Colors, type Fx } from '../fx/Fx';
import { Ghost } from '../fx/Ghost';
import type { Input } from '../core/Input';
import type { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import type { Player } from '../player/Player';
import type { World } from '../world/World';

const E = Tuning.echo;

export type EchoState = 'ready' | 'active' | 'cooldown';

/**
 * Echo: press to leave a holographic copy of yourself (frozen pose). Press again within
 * its lifetime to swap into it — you teleport to the echo's position/facing and it vanishes.
 */
export class EchoRecall {
  state: EchoState = 'ready';
  /** seconds left (active) or cooldown remaining */
  timer = 0;
  readonly position = new Vector3();
  private facing = 0;
  private sinceAction = 0;
  private time = 0;
  private emit = 0;
  private readonly ghost: Ghost;
  private readonly ring: Mesh;
  private readonly ringMat: ShaderMaterial;
  private readonly light: PointLight;

  constructor(
    private readonly player: Player,
    private readonly world: World,
    private readonly fx: Fx,
    private readonly cam: ThirdPersonCamera,
    private readonly input: Input,
    private readonly onEvent: (e: 'placed' | 'recalled' | 'expired') => void = () => {},
  ) {
    this.ghost = new Ghost(player.model.model, Colors.echo.clone());
    world.scene.add(this.ghost.root);

    this.ringMat = new ShaderMaterial({
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
          float r = vUv.y; // 0 inner .. 1 outer (RingGeometry uv)
          float a = smoothstep(0.0, 0.3, r) * (1.0 - smoothstep(0.7, 1.0, r));
          float dash = step(0.35, fract(vUv.x * 12.0 + uT * 0.4));
          gl_FragColor = vec4(uColor, a * (0.35 + dash * 0.5) * uO);
        }`,
    });
    this.ring = new Mesh(new RingGeometry(0.75, 1.0, 48, 1).rotateX(-Math.PI / 2), this.ringMat);
    // RingGeometry uvs aren't polar; remap so x = angle, y = radius
    const uv = this.ring.geometry.getAttribute('uv');
    const pos = this.ring.geometry.getAttribute('position');
    for (let i = 0; i < uv.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      uv.setXY(i, (Math.atan2(z, x) / (Math.PI * 2) + 1) % 1, (Math.hypot(x, z) - 0.75) / 0.25);
    }
    this.ring.visible = false;
    this.ring.renderOrder = 3;
    world.scene.add(this.ring);

    this.light = new PointLight(new Color('#6fd8ff'), 0, 7, 1.6);
    world.scene.add(this.light);
  }

  /** 0..1 for the HUD: remaining lifetime when active, cooldown progress otherwise. */
  get progress() {
    if (this.state === 'active') return this.timer / E.lifetime;
    if (this.state === 'cooldown') return 1 - this.timer / E.cooldown;
    return 1;
  }

  update(dt: number) {
    this.time += dt;
    this.sinceAction += dt;

    if (this.input.consume('echo', 0.15)) {
      if (this.state === 'ready') this.place();
      else if (this.state === 'active' && this.sinceAction >= E.armDelay) this.recall();
    }

    if (this.state === 'active') {
      this.timer -= dt;
      if (this.timer <= 0) return this.expire();
      // Flicker as it's about to expire.
      let o = 1;
      if (this.timer < E.flickerLast) {
        const k = 1 - this.timer / E.flickerLast;
        o = 0.55 + 0.45 * Math.sin(this.time * (14 + k * 30)) * (1 - k * 0.5);
        o *= 1 - k * 0.4;
      }
      // Fade in.
      o *= Math.min(1, this.sinceAction / 0.15);
      this.ghost.setOpacity(o);
      this.ghost.setTime(this.time);
      this.ringMat.uniforms.uT.value = this.time;
      this.ringMat.uniforms.uO.value = o;
      this.light.intensity = 2.2 * o;

      this.emit -= dt;
      if (this.emit <= 0) {
        this.emit = 0.06;
        this.fx.sparks.emit({
          count: 2, position: this.position.clone().setY(this.position.y + 0.9), spread: 0.45,
          velocity: new Vector3(0, 1.1, 0), speed: 0.3, life: [0.6, 1.1], size: [0.04, 0.09],
          color: Colors.echoParticle, color2: Colors.echoParticle2, drag: 0.5,
        });
      }
    } else if (this.state === 'cooldown') {
      this.timer -= dt;
      if (this.timer <= 0) this.state = 'ready';
    }
  }

  private place() {
    const p = this.player;
    this.position.copy(p.position);
    this.facing = p.facing;
    this.ghost.capture();
    this.ghost.setOpacity(0);
    this.state = 'active';
    this.timer = E.lifetime;
    this.sinceAction = 0;

    const g = this.world.groundAt(this.position.x, this.position.z, this.position.y + 0.1);
    this.ring.position.set(this.position.x, g + 0.05, this.position.z);
    this.ring.visible = true;
    this.light.position.copy(this.position).setY(this.position.y + 1.2);

    this.fx.echoBurst(this.position.clone().setY(this.position.y + 1), 36, 3);
    this.fx.waves.spawn(this.ring.position, 2.2, Colors.echo, 0.4, 0.2);
    this.onEvent('placed');
  }

  private recall() {
    const from = this.player.position.clone();
    // Leave an afterimage where we were, then swap.
    this.fx.afterimage(0.4, Colors.echo);
    this.fx.streak(from, this.position);
    this.fx.echoBurst(from.clone().setY(from.y + 1), 24, 2);
    this.player.teleport(this.position, this.facing);
    this.fx.echoBurst(this.position.clone().setY(this.position.y + 1), 50, 5);
    this.fx.waves.spawn(this.ring.position, 3, Colors.echo, 0.45, 0.25);
    this.cam.kickFov(9);
    this.cam.shake(0.15);
    this.hide();
    this.state = 'cooldown';
    this.timer = E.cooldown;
    this.onEvent('recalled');
  }

  private expire() {
    this.fx.echoBurst(this.position.clone().setY(this.position.y + 1), 30, 1.5);
    this.hide();
    this.state = 'cooldown';
    this.timer = E.cooldown;
    this.onEvent('expired');
  }

  private hide() {
    this.ghost.root.visible = false;
    this.ring.visible = false;
    this.light.intensity = 0;
  }
}
