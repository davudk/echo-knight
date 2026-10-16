import { AdditiveBlending, Color, NormalBlending, Object3D, Scene, Vector3 } from 'three';
import { Ghost } from './Ghost';
import { ParticleSystem } from './Particles';
import { Shockwaves } from './Shockwave';

export const Colors = {
  echo: new Color(0.3, 1.0, 1.5),
  echoParticle: new Color(0.5, 1.4, 2.0),
  echoParticle2: new Color(0.9, 0.7, 2.2),
  spark: new Color(2.2, 1.6, 0.8),
  spark2: new Color(2.4, 0.9, 0.35),
  dust: new Color('#a89a80'),
  dust2: new Color('#7e7262'),
  slam: new Color(1.1, 0.68, 0.3),
  dash: new Color(0.45, 0.8, 1.7),
};

interface Afterimage {
  ghost: Ghost;
  age: number;
  life: number;
}

/** Central effects facade so gameplay code says *what* happened, not how to draw it. */
export class Fx {
  readonly sparks = new ParticleSystem(1500, AdditiveBlending, 0.9);
  readonly dust = new ParticleSystem(1200, NormalBlending, 0.8);
  readonly waves: Shockwaves;
  private afterimages: Afterimage[] = [];
  private time = 0;

  constructor(private readonly scene: Scene) {
    scene.add(this.sparks.points, this.dust.points);
    this.waves = new Shockwaves(scene);
  }

  setViewportHeight(h: number) {
    this.sparks.setViewportHeight(h);
    this.dust.setViewportHeight(h);
  }

  /** Pre-build a pool of afterimage ghosts from the character model. */
  initAfterimages(source: Object3D, count = 10) {
    for (let i = 0; i < count; i++) {
      const ghost = new Ghost(source, Colors.dash.clone());
      ghost.material.uniforms.uScan.value = 0;
      this.scene.add(ghost.root);
      this.afterimages.push({ ghost, age: 1, life: 1 });
    }
  }

  afterimage(life = 0.28, color?: Color) {
    let a = this.afterimages.find((x) => x.age >= x.life);
    if (!a) a = this.afterimages.reduce((o, x) => (x.age > o.age ? x : o));
    a.age = 0;
    a.life = life;
    if (color) (a.ghost.material.uniforms.uColor.value as Color).copy(color);
    else (a.ghost.material.uniforms.uColor.value as Color).copy(Colors.dash);
    a.ghost.capture();
  }

  hitSpark(pos: Vector3, dir: Vector3, heavy = false) {
    this.sparks.emit({
      count: heavy ? 40 : 22,
      position: pos,
      spread: 0.1,
      velocity: dir.clone().multiplyScalar(heavy ? 5 : 4),
      speed: heavy ? 9 : 7,
      life: [0.15, 0.4],
      size: [0.05, 0.12],
      color: Colors.spark,
      color2: Colors.spark2,
      gravity: 12,
      drag: 4,
    });
    this.sparks.emit({ count: 1, position: pos, speed: 0, life: [0.12, 0.12], size: [heavy ? 0.8 : 0.55, heavy ? 0.8 : 0.55], color: Colors.spark });
  }

  dustPuff(pos: Vector3, count = 10, speed = 2.2, size: [number, number] = [0.25, 0.5]) {
    this.dust.emit({
      count,
      position: pos,
      spread: 0.25,
      speed,
      flat: true,
      upBias: 0.35,
      life: [0.4, 0.8],
      size,
      color: Colors.dust,
      color2: Colors.dust2,
      gravity: -0.4,
      drag: 3.5,
    });
  }

  slam(pos: Vector3, radius: number) {
    this.waves.spawn(pos, radius, Colors.slam, 0.45, 0.16);
    this.waves.spawn(pos, radius * 0.55, new Color(0.5, 0.42, 0.32), 0.3, 0.3);
    this.dust.emit({
      count: 50, position: pos, spread: 0.4, speed: 9, flat: true, upBias: 0.25,
      life: [0.5, 1.0], size: [0.4, 0.9], color: Colors.dust, color2: Colors.dust2, gravity: -0.3, drag: 3,
    });
    this.sparks.emit({
      count: 26, position: pos.clone().setY(pos.y + 0.2), spread: 0.3, speed: 10, upBias: 0.9,
      life: [0.25, 0.6], size: [0.05, 0.12], color: Colors.spark, color2: Colors.spark2, gravity: 18, drag: 2,
    });
  }

  echoBurst(pos: Vector3, count = 50, outward = 4) {
    this.sparks.emit({
      count, position: pos, spread: 0.5, speed: outward, upBias: 0.4,
      life: [0.4, 0.9], size: [0.05, 0.14], color: Colors.echoParticle, color2: Colors.echoParticle2, gravity: -1.5, drag: 2.5,
    });
  }

  /** Particles streaming from `a` to `b` (teleport). */
  streak(a: Vector3, b: Vector3) {
    const d = b.clone().sub(a);
    const len = d.length();
    const n = Math.min(120, Math.max(12, Math.floor(len * 6)));
    const p = new Vector3();
    for (let i = 0; i < n; i++) {
      const t = i / n;
      p.copy(a).addScaledVector(d, t);
      p.y += 1 + Math.sin(t * Math.PI) * 0.3;
      this.sparks.emit({
        count: 1, position: p, spread: 0.2, speed: 0.6,
        velocity: d.clone().multiplyScalar(0.25 / Math.max(1, len) * 6),
        life: [0.25, 0.55], size: [0.06, 0.14], color: Colors.echoParticle, color2: Colors.echoParticle2, drag: 3,
      });
    }
  }

  update(dt: number) {
    this.time += dt;
    this.sparks.update(dt);
    this.dust.update(dt);
    this.waves.update(dt);
    for (const a of this.afterimages) {
      if (a.age >= a.life) {
        a.ghost.root.visible = false;
        continue;
      }
      a.age += dt;
      const t = Math.min(1, a.age / a.life);
      a.ghost.setOpacity((1 - t) * 0.75);
      a.ghost.setTime(this.time);
    }
  }
}
