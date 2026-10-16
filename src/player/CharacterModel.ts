import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  Group,
  LoopOnce,
  LoopRepeat,
  Mesh,
  Object3D,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Gear on the KayKit knight we don't want for a pure swordsman. */
const HIDDEN_NODES = ['1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Round_Shield', 'Spike_Shield', '2H_Sword'];
/** Clips whose root bone carries horizontal root motion — we drive movement from code instead. */
const STRIP_ROOT_MOTION = /^Dodge_/;

export interface PlayOptions {
  fade?: number;
  loop?: boolean;
  speed?: number;
  startAt?: number;
  restart?: boolean;
}

/**
 * Loaded character: visual hierarchy + animation controller.
 *
 *   root  (feet position, yaw)
 *    └ pivot (at hip height: procedural flips / leans)
 *       └ offset (-hip height)
 *          └ model (glTF scene, scaled)
 */
export class CharacterModel {
  readonly root = new Group();
  readonly pivot = new Group();
  readonly model: Object3D;
  readonly mixer: AnimationMixer;
  readonly sword: Object3D | null;
  readonly swordBase = new Vector3();
  readonly swordTip = new Vector3();
  readonly hipHeight: number;
  private readonly actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;
  currentName = '';

  private constructor(scene: Object3D, clips: AnimationClip[], height: number) {
    this.model = scene;

    for (const name of HIDDEN_NODES) {
      const n = scene.getObjectByName(name);
      if (n) n.visible = false;
    }
    scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });

    // Normalise height.
    scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(scene);
    const h = box.max.y - box.min.y;
    const s = height / h;
    scene.scale.setScalar(s);
    scene.position.y = -box.min.y * s;
    this.hipHeight = height * 0.45;

    const offset = new Group();
    offset.position.y = -this.hipHeight;
    this.pivot.position.y = this.hipHeight;
    offset.add(scene);
    this.pivot.add(offset);
    this.root.add(this.pivot);

    this.sword = scene.getObjectByName('1H_Sword') ?? null;
    if (this.sword) this.measureSword(this.sword);

    this.mixer = new AnimationMixer(scene);
    for (const clip of clips) {
      if (STRIP_ROOT_MOTION.test(clip.name)) stripRootMotion(clip);
      this.actions.set(clip.name, this.mixer.clipAction(clip));
    }
  }

  static async load(url: string, height: number): Promise<CharacterModel> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new CharacterModel(gltf.scene, gltf.animations, height);
  }

  /** Find hilt→tip along the blade's longest local axis. */
  private measureSword(sword: Object3D) {
    const box = new Box3();
    sword.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.computeBoundingBox();
        const b = m.geometry.boundingBox!.clone();
        if (o !== sword) b.applyMatrix4(o.matrix);
        box.union(b);
      }
    });
    const size = box.getSize(new Vector3());
    const axis = size.x > size.y ? (size.x > size.z ? 'x' : 'z') : size.y > size.z ? 'y' : 'z';
    const tipAtMax = Math.abs(box.max[axis]) > Math.abs(box.min[axis]);
    const hilt = tipAtMax ? box.min[axis] : box.max[axis];
    const tip = tipAtMax ? box.max[axis] : box.min[axis];
    const center = box.getCenter(new Vector3());
    this.swordTip.copy(center);
    this.swordTip[axis] = tip;
    this.swordBase.copy(center);
    this.swordBase[axis] = hilt + (tip - hilt) * 0.3;
  }

  has(name: string) {
    return this.actions.has(name);
  }

  clipDuration(name: string) {
    return this.actions.get(name)?.getClip().duration ?? 0;
  }

  play(name: string, o: PlayOptions = {}): AnimationAction | null {
    const next = this.actions.get(name);
    if (!next) {
      console.warn('missing clip', name);
      return null;
    }
    const { fade = 0.15, loop = true, speed = 1, startAt = 0, restart = false } = o;
    if (next === this.current && !restart) {
      next.timeScale = speed;
      return next;
    }
    const prev = this.current;
    next.enabled = true;
    next.reset();
    next.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    next.timeScale = speed;
    next.time = startAt;
    next.setEffectiveWeight(1);
    if (prev && prev !== next && fade > 0) next.crossFadeFrom(prev, fade, false);
    else if (prev && prev !== next) prev.stop();
    next.play();
    this.current = next;
    this.currentName = name;
    return next;
  }

  get currentAction() {
    return this.current;
  }

  update(dt: number) {
    this.mixer.update(dt);
  }
}

function stripRootMotion(clip: AnimationClip) {
  for (const track of clip.tracks) {
    if (track instanceof VectorKeyframeTrack && track.name === 'root.position') {
      const v = track.values;
      for (let i = 0; i < v.length; i += 3) {
        v[i] = 0;
        v[i + 2] = 0;
      }
    }
  }
}
