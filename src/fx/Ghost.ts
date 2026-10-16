import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Color,
  Group,
  LoopOnce,
  Mesh,
  Object3D,
  Quaternion,
  ShaderMaterial,
  SkinnedMesh,
  Vector3,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createHologramMaterial } from './HologramMaterial';

const _q = new Quaternion();
const _one = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);

/**
 * A holographic copy of a skinned character that can snapshot another instance's pose.
 * Used by the Echo ability and by dash afterimages.
 *
 * Optionally animated (`enableAnimation`): the mimic echo replays the player's attack clips
 * on its own skeleton.
 */
export class Ghost {
  readonly root = new Group();
  readonly material: ShaderMaterial;
  private readonly model: Object3D;
  private readonly source: Object3D;
  private readonly pairs: [Object3D, Object3D][] = [];
  private mixer: AnimationMixer | null = null;
  private action: AnimationAction | null = null;
  private clipFor: ((name: string) => AnimationClip | undefined) | null = null;

  constructor(source: Object3D, color?: Color) {
    this.source = source;
    this.model = cloneSkinned(source);
    this.material = createHologramMaterial(color);
    this.model.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.material = this.material;
        m.castShadow = false;
        m.receiveShadow = false;
        m.frustumCulled = false;
      }
    });
    // Pair nodes by traversal order (clone preserves hierarchy).
    const src: Object3D[] = [];
    const dst: Object3D[] = [];
    source.traverse((o) => src.push(o));
    this.model.traverse((o) => dst.push(o));
    for (let i = 0; i < src.length; i++) this.pairs.push([src[i], dst[i]]);

    this.model.matrixAutoUpdate = false;
    this.root.add(this.model);
    this.root.visible = false;
  }

  /** Copy the full pose + world transform of the source right now. */
  capture() {
    this.stopAnimation();
    const [srcRoot] = this.pairs[0];
    srcRoot.updateWorldMatrix(true, false);
    this.model.matrix.copy(srcRoot.matrixWorld);
    for (let i = 1; i < this.pairs.length; i++) {
      const [s, d] = this.pairs[i];
      d.position.copy(s.position);
      d.quaternion.copy(s.quaternion);
      d.scale.copy(s.scale);
      d.visible = s.visible;
    }
    this.model.matrixWorldNeedsUpdate = true;
    this.root.visible = true;
    return this;
  }

  /**
   * Place the ghost upright at `pos` facing `yaw`, dropping any procedural lean/flip that was
   * captured (used before replaying a clip so attacks don't play tilted).
   */
  setUpright(pos: Vector3, yaw: number) {
    this.source.updateMatrix();
    _q.setFromAxisAngle(_up, yaw);
    this.model.matrix.compose(pos, _q, _one).multiply(this.source.matrix);
    this.model.matrixWorldNeedsUpdate = true;
  }

  // ---------------------------------------------------------------- animation (mimic)
  /** Give this ghost its own mixer. `clipFor` resolves clip names (shared with the source). */
  enableAnimation(clipFor: (name: string) => AnimationClip | undefined) {
    if (this.mixer) return;
    this.mixer = new AnimationMixer(this.model);
    this.clipFor = clipFor;
  }

  get animated() {
    return this.mixer !== null;
  }

  /** Play a one-shot clip (held on its last frame). Returns the clip's remaining real duration. */
  playOnce(name: string, speed = 1, startAt = 0, fade = 0.06): number {
    if (!this.mixer || !this.clipFor) return 0;
    const clip = this.clipFor(name);
    if (!clip) return 0;
    const next = this.mixer.clipAction(clip);
    const prev = this.action;
    next.enabled = true;
    next.reset();
    next.setLoop(LoopOnce, 1);
    next.clampWhenFinished = true;
    next.timeScale = speed;
    next.time = startAt;
    next.setEffectiveWeight(1);
    if (prev && prev !== next) next.crossFadeFrom(prev, fade, false);
    else if (fade > 0) next.fadeIn(fade);
    next.play();
    this.action = next;
    return Math.max(0, clip.duration - startAt) / Math.max(0.01, speed);
  }

  updateAnimation(dt: number) {
    this.mixer?.update(dt);
  }

  stopAnimation() {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    this.action = null;
  }

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
  }
  setTime(t: number) {
    this.material.uniforms.uTime.value = t;
  }

  dispose() {
    this.stopAnimation();
    this.root.removeFromParent();
    this.material.dispose();
    this.model.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).skeleton.dispose();
    });
  }
}
