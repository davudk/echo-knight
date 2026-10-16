import { Color, Group, Mesh, Object3D, ShaderMaterial, SkinnedMesh } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createHologramMaterial } from './HologramMaterial';

/**
 * A holographic copy of a skinned character that can snapshot another instance's pose.
 * Used by the Echo ability and by dash afterimages.
 */
export class Ghost {
  readonly root = new Group();
  readonly material: ShaderMaterial;
  private readonly model: Object3D;
  private readonly pairs: [Object3D, Object3D][] = [];

  constructor(source: Object3D, color?: Color) {
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

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
  }
  setTime(t: number) {
    this.material.uniforms.uTime.value = t;
  }

  dispose() {
    this.root.removeFromParent();
    this.material.dispose();
    this.model.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).skeleton.dispose();
    });
  }
}
