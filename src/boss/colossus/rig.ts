import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Scene,
} from 'three';
import { clamp, lerp } from '../../core/math';
import type { BoxCollider, CylinderCollider, World } from '../../world/World';
import { ClipMap, STAND, type ClipDef, type Ease, type Pose, type V3 } from './clips';

/**
 * THE BELL COLOSSUS RIG — a procedural, code-animated skeleton that stands in for a KayKit
 * `CharacterModel` (same `play / update / currentAction / currentName / root / model` surface, so
 * the Boss base class and the AttackRunner drive it unchanged).
 *
 * Every body part is a chain of UPRIGHT (yaw-only) stone blocks. Each block's mesh and its world
 * `BoxCollider` are the very same box, updated every frame — so what you see is exactly what you
 * stand on, ledge-grab and wall-run on. The bell head is a cylinder collider. Blocks that move fast
 * (> 7 m/s: a swinging hammer, a leap) are switched off as platforms for that frame — fast parts are
 * hitboxes, slow parts are terrain.
 *
 * Colliders are tagged `colossus-<part>` (feet, shin, thigh, belt, torso, shoulder, arm, fist,
 * hammer, bell). Moving colliders carry the player through `Player`'s generic moving-platform hook.
 */

// ---------------------------------------------------------------- sizes
const THIGH = 2.9;
const SHIN = 2.9;
const UPPER_ARM = 3.0;
const FOREARM = 3.0;
const FOOT_H = 0.85;
const HIP_X = 1.25;
const SHOULDER_X = 2.4;
const TORSO_H = 3.4;
const BELL_H = 2.4;
export const BELL_R = 1.3;
/** handle: butt is 0.8 behind the hand, head centre 3.8 in front */
const HAM_BACK = 0.8;
const HAM_FRONT = 3.8;
const FAST = 9;

const PAL = {
  stone: new Color('#aaa294'),
  stoneDark: new Color('#8a8377'),
  moss: new Color('#8d9070'),
  bronze: new Color('#b08a4a'),
  bronzeDark: new Color('#86683a'),
};

export type BlockPart = 'foot' | 'shin' | 'thigh' | 'belt' | 'torso' | 'shoulder' | 'arm' | 'fist' | 'hammer';

interface Block {
  mesh: Mesh;
  col: BoxCollider;
  part: BlockPart;
  /** body-space layout (this frame) */
  cx: number;
  cz: number;
  y0: number;
  y1: number;
  hx: number;
  hz: number;
  yaw: number;
  /** previous world centre (speed test) */
  px: number;
  py: number;
  pz: number;
  fresh: boolean;
}

export interface FakeAction {
  time: number;
  timeScale: number;
  getClip(): { duration: number };
}

export interface PlayOpts {
  fade?: number;
  loop?: boolean;
  speed?: number;
  startAt?: number;
  restart?: boolean;
}

/** Minimum cross-fade per clip: a 12 m stone giant never snaps. */
const MIN_FADE: Record<string, number> = { idle: 1.0, walk: 0.5, kneel: 0.15, flinch: 0.12, buried: 0 };

// ---------------------------------------------------------------- helpers
const v = (a: V3, out = new Vector3()) => out.set(a[0], a[1], a[2]);

function ease(e: Ease, u: number) {
  switch (e) {
    case 'linear': return u;
    case 'in': return u * u * u;
    case 'out': return 1 - (1 - u) ** 3;
    default: return u * u * (3 - 2 * u);
  }
}

function lerpPose(a: Pose, b: Pose, u: number, out: Pose): Pose {
  out.rise = lerp(a.rise, b.rise, u);
  out.hip = lerp(a.hip, b.hip, u);
  out.pz = lerp(a.pz, b.pz, u);
  out.lean = lerp(a.lean, b.lean, u);
  out.drop = lerp(a.drop, b.drop, u);
  out.twist = lerp(a.twist, b.twist, u);
  out.tilt = lerp(a.tilt, b.tilt, u);
  for (const k of ['lf', 'rf', 'lh', 'rh', 'ham'] as const) {
    const o = (out[k] ??= [0, 0, 0]);
    o[0] = lerp(a[k][0], b[k][0], u);
    o[1] = lerp(a[k][1], b[k][1], u);
    o[2] = lerp(a[k][2], b[k][2], u);
  }
  return out;
}

function clonePose(p: Pose): Pose {
  return { ...p, lf: [...p.lf], rf: [...p.rf], lh: [...p.lh], rh: [...p.rh], ham: [...p.ham] };
}

/** Two-bone IK: joint between a and the (reach-clamped) target, bending toward `pole`. Writes `end`. */
function ik(a: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, joint: Vector3, end: Vector3) {
  const dir = tmpD.copy(target).sub(a);
  let d = dir.length();
  if (d < 1e-4) dir.set(0, -1, 0), (d = 1e-4);
  dir.divideScalar(d);
  d = clamp(d, Math.abs(l1 - l2) + 0.05, l1 + l2 - 0.02);
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const pp = tmpA.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (pp.lengthSq() < 1e-6) pp.set(0, 0, 1);
  pp.normalize();
  joint.copy(a).addScaledVector(dir, along).addScaledVector(pp, h);
  end.copy(a).addScaledVector(dir, d);
}

const tmpA = new Vector3();
const tmpD = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();

/** Unit box (1×1×1) with flat per-face colours and a darker base. */
function stoneBox(base: Color, vary: number, seed: number): BufferGeometry {
  const g = new BoxGeometry(1, 1, 1, 1, 2, 1).toNonIndexed();
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  const c = new Color();
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < pos.count; t += 3) {
    const k = 1 + (rnd() - 0.5) * 2 * vary;
    const ny = nrm.getY(t);
    const lift = ny > 0.5 ? 1.08 : ny < -0.5 ? 0.6 : 1;
    for (let i = t; i < t + 3; i++) {
      const y = pos.getY(i) + 0.5; // 0 bottom … 1 top
      c.copy(base).multiplyScalar(k * lift * (0.86 + 0.14 * y));
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

function bellGeometry(): BufferGeometry {
  // bell profile (radius, height) from the lip up to the crown; max radius = BELL_R
  const pts = [
    [BELL_R, 0], [BELL_R * 0.98, 0.18], [BELL_R * 0.86, 0.5], [BELL_R * 0.76, 1.1], [BELL_R * 0.72, 1.7],
    [BELL_R * 0.62, 2.15], [BELL_R * 0.36, BELL_H], [0.01, BELL_H],
  ].map(([r, y]) => new Vector2(r, y));
  const g = new LatheGeometry(pts, 12).toNonIndexed();
  g.computeVertexNormals();
  return g;
}

// ====================================================================== rig
export class ColossusRig {
  readonly root = new Group();
  readonly pivot = new Group();
  readonly model = new Group();
  readonly hipHeight = 5;
  readonly hammer = new Group();
  readonly bellMesh: Mesh;
  readonly bellGroup = new Group();
  currentName = '';
  currentAction: FakeAction | null = null;

  /** current (evaluated + procedural) pose */
  readonly pose: Pose = clonePose(STAND);
  /** 0..1 full-body shudder (shake-off wind-up), set by the boss */
  shudder = 0;
  /** bell sway after a toll (decays) */
  ring = 0;
  /** a time accumulator for procedural noise */
  private t = 0;

  private clip: ClipDef = ClipMap.get('idle')!;
  private loop = true;
  private readonly action: FakeAction;
  private readonly from: Pose = clonePose(STAND);
  private readonly sample: Pose = clonePose(STAND);
  private fadeT = 1;
  private fadeDur = 0;
  private prevTime = 0;

  // ---- joints (body space), recomputed every frame
  readonly pelvis = new Vector3();
  readonly hipL = new Vector3();
  readonly hipR = new Vector3();
  readonly kneeL = new Vector3();
  readonly kneeR = new Vector3();
  readonly ankleL = new Vector3();
  readonly ankleR = new Vector3();
  readonly shoulderL = new Vector3();
  readonly shoulderR = new Vector3();
  readonly elbowL = new Vector3();
  readonly elbowR = new Vector3();
  readonly handL = new Vector3();
  readonly handR = new Vector3();
  readonly hamDir = new Vector3();
  readonly hamHead = new Vector3();
  readonly torsoC = new Vector3();
  readonly bellBase = new Vector3();
  torsoY0 = 0;
  twist = 0;

  readonly blocks: Block[] = [];
  readonly bellCol: CylinderCollider = { x: 0, z: 0, r: BELL_R, bottom: -999, top: -998, tag: 'colossus-bell' };
  private nBlock = 0;
  private readonly unit: BufferGeometry[];
  private readonly mat: MeshStandardMaterial;
  private readonly bronze: MeshStandardMaterial;
  private readonly footLift = [false, false];
  /** `true` while the colliders are in `world.colliders` */
  attached = false;

  /** callbacks set by the boss */
  onMark: (name: string) => void = () => {};
  onFootfall: (side: 'L' | 'R', at: Vector3) => void = () => {};

  constructor() {
    this.root.add(this.pivot);
    this.pivot.add(this.model);
    this.model.name = 'colossus';
    this.hammer.name = 'colossus-hammer';
    this.model.add(this.hammer);
    this.mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
    this.bronze = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.25 });
    this.unit = [stoneBox(PAL.stone, 0.08, 7), stoneBox(PAL.stoneDark, 0.08, 13), stoneBox(PAL.moss, 0.1, 29), stoneBox(PAL.bronze, 0.06, 3), stoneBox(PAL.bronzeDark, 0.06, 5)];

    const bellMat = new MeshStandardMaterial({ color: '#7a6233', flatShading: true, roughness: 0.45, metalness: 0.45 });
    this.bellMesh = new Mesh(bellGeometry(), bellMat);
    this.bellMesh.name = 'colossus-bell';
    this.bellMesh.castShadow = true;
    this.bellGroup.add(this.bellMesh);
    this.model.add(this.bellGroup);

    this.action = { time: 0, timeScale: 1, getClip: () => ({ duration: this.clip.duration }) };
    this.play('idle', { fade: 0 });
    this.update(0);
  }

  // ---------------------------------------------------------------- CharacterModel surface
  has(name: string) {
    return ClipMap.has(name);
  }
  clipDuration(name: string) {
    return ClipMap.get(name)?.duration ?? 0;
  }
  setFade(_a: number) {}

  play(name: string, o: PlayOpts = {}): FakeAction | null {
    const c = ClipMap.get(name);
    if (!c) {
      console.warn('[colossus] missing clip', name);
      return null;
    }
    const { fade = 0.15, speed = 1, startAt = 0, restart = false } = o;
    if (name === this.currentName && !restart) {
      this.action.timeScale = speed;
      return this.action;
    }
    this.from.rise = this.pose.rise;
    Object.assign(this.from, clonePose(this.pose));
    this.fadeDur = Math.max(fade, MIN_FADE[name] ?? 0.22);
    if (fade <= 0 && name === 'buried') this.fadeDur = 0;
    this.fadeT = 0;
    this.clip = c;
    this.loop = o.loop ?? c.loop;
    this.action.time = startAt;
    this.prevTime = startAt;
    this.action.timeScale = speed;
    this.currentName = name;
    this.currentAction = this.action;
    return this.action;
  }

  // ---------------------------------------------------------------- frame
  update(dt: number) {
    this.t += dt;
    const a = this.action;
    const c = this.clip;
    a.time += dt * a.timeScale;
    if (this.loop) a.time = ((a.time % c.duration) + c.duration) % c.duration;
    else a.time = clamp(a.time, 0, c.duration);
    // marks crossed this frame (forward only, ignores loop wrap)
    if (c.marks && a.time > this.prevTime) {
      for (const m of c.marks) if (this.prevTime < m.t && a.time >= m.t) this.onMark(m.name);
    }
    this.prevTime = a.time;

    this.evaluate(c, a.time, this.sample);
    this.fadeT = this.fadeDur > 0 ? Math.min(1, this.fadeT + dt / this.fadeDur) : 1;
    const u = this.fadeT;
    lerpPose(this.from, this.sample, u * u * (3 - 2 * u), this.pose);

    // procedural layers
    const p = this.pose;
    const t = this.t;
    if (this.shudder > 0) {
      const s = this.shudder;
      p.rise += s * 0.09 * Math.sin(t * 37);
      p.twist += s * 0.05 * Math.sin(t * 29 + 1);
      p.lean += s * 0.12 * Math.sin(t * 23 + 2);
      p.tilt += s * 0.2 * Math.sin(t * 41);
    }
    this.ring = Math.max(0, this.ring - dt * 0.5);
    if (this.ring > 0) p.tilt += this.ring * 0.18 * Math.sin(t * 8.5);

    this.solve();
    this.layout(dt);
    this.footfalls();
  }

  private evaluate(c: ClipDef, time: number, out: Pose) {
    const k = c.keys;
    if (time <= k[0].t) return lerpPose(k[0].pose, k[0].pose, 0, out);
    for (let i = 1; i < k.length; i++) {
      if (time <= k[i].t) {
        const span = Math.max(1e-4, k[i].t - k[i - 1].t);
        return lerpPose(k[i - 1].pose, k[i].pose, ease(k[i].ease, (time - k[i - 1].t) / span), out);
      }
    }
    return lerpPose(k[k.length - 1].pose, k[k.length - 1].pose, 0, out);
  }

  /** twisted-frame vector → body space */
  private tw(x: number, y: number, z: number, out: Vector3) {
    const c = Math.cos(this.twist);
    const s = Math.sin(this.twist);
    return out.set(x * c + z * s, y, -x * s + z * c);
  }

  private solve() {
    const p = this.pose;
    this.twist = p.twist;
    const P = this.pelvis.set(0, p.hip + p.rise, p.pz);
    this.hipL.set(HIP_X, P.y - 0.2, P.z);
    this.hipR.set(-HIP_X, P.y - 0.2, P.z);
    const pole = tmpB;
    // legs: knees bend forward
    pole.set(0, 0, 1);
    ik(this.hipL, v(p.lf, tmpC).setY(p.lf[1] + p.rise + FOOT_H), THIGH, SHIN, pole, this.kneeL, this.ankleL);
    ik(this.hipR, v(p.rf, tmpC).setY(p.rf[1] + p.rise + FOOT_H), THIGH, SHIN, pole, this.kneeR, this.ankleR);

    // torso
    this.torsoY0 = P.y + 0.6 - p.drop;
    this.tw(0, 0, p.lean * 0.5, this.torsoC).add(P);
    this.torsoC.y = this.torsoY0 + TORSO_H / 2;
    const sy = this.torsoY0 + TORSO_H - 0.5;
    this.tw(SHOULDER_X, 0, p.lean, this.shoulderL).add(P).setY(sy);
    this.tw(-SHOULDER_X, 0, p.lean, this.shoulderR).add(P).setY(sy);
    this.tw(0, 0, p.lean + p.tilt * 0.6, this.bellBase).add(P).setY(this.torsoY0 + TORSO_H);

    // arms: elbows out and back
    this.tw(1, -0.1, -0.7, pole);
    ik(this.shoulderL, this.tw(p.lh[0], p.lh[1], p.lh[2], tmpC).add(this.shoulderL), UPPER_ARM, FOREARM, pole, this.elbowL, this.handL);
    this.tw(-1, -0.1, -0.7, pole);
    ik(this.shoulderR, this.tw(p.rh[0], p.rh[1], p.rh[2], tmpC).add(this.shoulderR), UPPER_ARM, FOREARM, pole, this.elbowR, this.handR);
    this.tw(p.ham[0], p.ham[1], p.ham[2], this.hamDir).normalize();
    this.hamHead.copy(this.handR).addScaledVector(this.hamDir, HAM_FRONT);
  }

  // ---------------------------------------------------------------- blocks
  private block(part: BlockPart, unit: number, cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, yaw: number) {
    let b = this.blocks[this.nBlock];
    if (!b) {
      const isHammer = part === 'hammer';
      const mesh = new Mesh(this.unit[unit], isHammer || unit >= 3 ? this.bronze : this.mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (isHammer ? this.hammer : this.model).add(mesh);
      b = {
        mesh, part, cx: 0, cz: 0, y0: 0, y1: 0, hx: 0, hz: 0, yaw: 0, px: 0, py: 0, pz: 0, fresh: true,
        col: { kind: 'box', x: 0, z: 0, hx: 0.1, hz: 0.1, yaw: 0, bottom: -999, top: -998, tag: `colossus-${part}` },
      };
      this.blocks.push(b);
    }
    this.nBlock++;
    b.cx = cx;
    b.cz = cz;
    b.y0 = y0;
    b.y1 = Math.max(y0 + 0.05, y1);
    b.hx = hx;
    b.hz = hz;
    b.yaw = yaw;
    const m = b.mesh;
    m.position.set(cx, (b.y0 + b.y1) / 2, cz);
    m.scale.set(hx * 2, b.y1 - b.y0, hz * 2);
    m.rotation.y = yaw;
  }

  /** Segment A→B as `n` upright blocks of half-width `w`. */
  private chain(part: BlockPart, unit: number, a: Vector3, b: Vector3, n: number, w: number, fallbackYaw: number) {
    for (let k = 0; k < n; k++) {
      const ax = lerp(a.x, b.x, k / n), ay = lerp(a.y, b.y, k / n), az = lerp(a.z, b.z, k / n);
      const bx = lerp(a.x, b.x, (k + 1) / n), by = lerp(a.y, b.y, (k + 1) / n), bz = lerp(a.z, b.z, (k + 1) / n);
      const dx = bx - ax;
      const dz = bz - az;
      const hl = Math.hypot(dx, dz);
      const yaw = hl > 0.05 ? Math.atan2(dx, dz) : fallbackYaw;
      const hz = Math.max(w, hl / 2 + w * 0.35);
      this.block(part, unit, (ax + bx) / 2, (az + bz) / 2, Math.min(ay, by) - w * 0.7, Math.max(ay, by) + w * 0.7, w, hz, yaw);
    }
  }

  private layout(dt: number) {
    this.nBlock = 0;
    const p = this.pose;
    const tw = this.twist;
    // feet
    for (const [f, ank] of [[p.lf, this.ankleL], [p.rf, this.ankleR]] as const) {
      const fy = f[1] + p.rise;
      this.block('foot', 1, ank.x, ank.z + 0.35, fy, fy + FOOT_H, 0.8, 1.25, 0);
    }
    this.chain('shin', 0, this.ankleL, this.kneeL, 2, 0.6, 0);
    this.chain('shin', 0, this.ankleR, this.kneeR, 2, 0.6, 0);
    this.chain('thigh', 2, this.kneeL, this.hipL, 2, 0.7, 0);
    this.chain('thigh', 2, this.kneeR, this.hipR, 2, 0.7, 0);
    // girdle: the bronze-banded belt is the main ledge (a ~0.8 m rim around the torso)
    const P = this.pelvis;
    this.block('belt', 4, P.x, P.z, P.y - 0.6, P.y + 0.6, 2.6, 2.0, tw * 0.5);
    this.block('torso', 0, this.torsoC.x, this.torsoC.z, this.torsoY0, this.torsoY0 + TORSO_H, 1.8, 1.0, tw);
    for (const s of [this.shoulderL, this.shoulderR]) this.block('shoulder', 1, s.x, s.z, s.y - 0.5, s.y + 0.75, 0.8, 0.85, tw);
    // arms
    this.chain('arm', 0, this.shoulderL, this.elbowL, 2, 0.55, tw);
    this.chain('arm', 0, this.shoulderR, this.elbowR, 2, 0.55, tw);
    this.chain('arm', 2, this.elbowL, this.handL, 3, 0.55, tw);
    this.chain('arm', 2, this.elbowR, this.handR, 3, 0.55, tw);
    for (const h of [this.handL, this.handR]) this.block('fist', 1, h.x, h.z, h.y - 0.6, h.y + 0.6, 0.62, 0.62, tw);
    // hammer: handle (butt → head) + head across the handle
    const d = this.hamDir;
    const butt = tmpA.copy(this.handR).addScaledVector(d, -HAM_BACK);
    this.chain('hammer', 4, butt, this.hamHead, 3, 0.28, tw);
    const hy = Math.hypot(d.x, d.z) > 0.2 ? Math.atan2(d.x, d.z) : tw;
    const H = this.hamHead;
    this.block('hammer', 3, H.x, H.z, H.y - 0.85, H.y + 0.85, 1.35, 0.85, hy);

    // bell head
    const bb = this.bellBase;
    this.bellGroup.position.set(bb.x, bb.y, bb.z);
    this.bellGroup.rotation.set(0, tw, 0);

    this.updateColliders(dt);
  }

  // ---------------------------------------------------------------- world
  /** body space → world (root transform: feet position + facing) */
  toWorld(local: Vector3, out = new Vector3()) {
    const f = this.root.rotation.y;
    const c = Math.cos(f);
    const s = Math.sin(f);
    const r = this.root.position;
    return out.set(r.x + local.x * c + local.z * s, r.y + local.y, r.z - local.x * s + local.z * c);
  }

  private updateColliders(dt: number) {
    const f = this.root.rotation.y;
    const c = Math.cos(f);
    const s = Math.sin(f);
    const r = this.root.position;
    const enabled = this.root.visible;
    for (let i = 0; i < this.nBlock; i++) {
      const b = this.blocks[i];
      const wx = r.x + b.cx * c + b.cz * s;
      const wz = r.z - b.cx * s + b.cz * c;
      const wy = r.y + (b.y0 + b.y1) / 2;
      const speed = dt > 0 && !b.fresh ? Math.hypot(wx - b.px, wy - b.py, wz - b.pz) / dt : 0;
      b.px = wx;
      b.py = wy;
      b.pz = wz;
      b.fresh = false;
      const col = b.col;
      col.x = wx;
      col.z = wz;
      col.hx = b.hx;
      col.hz = b.hz;
      col.yaw = f + b.yaw;
      if (enabled && speed < FAST) {
        col.bottom = r.y + b.y0;
        col.top = r.y + b.y1;
      } else {
        col.bottom = -1000;
        col.top = -999;
      }
    }
    const bb = this.toWorld(this.bellBase, tmpC);
    this.bellCol.x = bb.x;
    this.bellCol.z = bb.z;
    this.bellCol.bottom = enabled ? bb.y : -1000;
    this.bellCol.top = enabled ? bb.y + BELL_H : -999;
  }

  /** Put the colliders into / out of the world (the boss takes them out for its own movement). */
  attach(world: World, on: boolean) {
    if (on === this.attached) return;
    this.attached = on;
    for (const b of this.blocks) {
      if (on) world.addCollider(b.col);
      else world.removeCollider(b.col);
    }
    if (on) world.addCollider(this.bellCol);
    else world.removeCollider(this.bellCol);
  }

  /** Forget the previous positions (teleport / reset) so the speed test doesn't flag a jump. */
  resetMotion() {
    for (const b of this.blocks) b.fresh = true;
  }

  private footfalls() {
    const p = this.pose;
    if (p.rise < -0.5) return;
    const feet = [p.lf, p.rf];
    for (let i = 0; i < 2; i++) {
      const y = feet[i][1];
      if (y > 0.45) this.footLift[i] = true;
      else if (this.footLift[i] && y < 0.06) {
        this.footLift[i] = false;
        const ank = i === 0 ? this.ankleL : this.ankleR;
        this.onFootfall(i === 0 ? 'L' : 'R', this.toWorld(tmpA.set(ank.x, 0, ank.z + 0.35)));
      }
    }
  }

  /** Collider tag test (the player stands / hangs on us). */
  static isOwnTag(tag: string | undefined) {
    return !!tag && tag.startsWith('colossus-');
  }

  // ---------------------------------------------------------------- collapse (death)
  /** Spawn the falling rubble from the current blocks; the rig itself should be hidden after. */
  collapse(scene: Scene): Rubble {
    return new Rubble(scene, this);
  }

  /** @internal */
  get blockList(): readonly Block[] {
    return this.blocks.slice(0, this.nBlock);
  }
  get stoneMaterial() {
    return this.mat;
  }
  get bronzeMaterial() {
    return this.bronze;
  }
}

// ====================================================================== rubble
interface Piece {
  obj: Object3D;
  vel: Vector3;
  spin: Vector3;
  half: number;
  rest: boolean;
  delay: number;
  bell?: boolean;
}

/** The colossus falls apart: every block tumbles to the ground, then the bell drops and rings. */
export class Rubble {
  readonly group = new Group();
  private readonly pieces: Piece[] = [];
  private t = 0;
  onBellLand: (at: Vector3) => void = () => {};
  onPieceLand: (at: Vector3, big: boolean) => void = () => {};

  constructor(private readonly scene: Scene, rig: ColossusRig) {
    const mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    const bronze = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.5 });
    rig.root.updateMatrixWorld(true);
    const centre = rig.toWorld(new Vector3(0, 5, 0));
    for (const b of rig.blockList) {
      const m = new Mesh(b.mesh.geometry, b.part === 'hammer' ? bronze : mat);
      b.mesh.getWorldPosition(m.position);
      m.quaternion.copy(b.mesh.getWorldQuaternion(m.quaternion));
      m.scale.copy(b.mesh.scale).multiplyScalar(0.92);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      const out = m.position.clone().sub(centre).setY(0);
      if (out.lengthSq() < 1e-3) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize();
      const height = m.position.y - centre.y + 5;
      this.pieces.push({
        obj: m,
        vel: out.multiplyScalar(1 + Math.random() * 2.5 + height * 0.25).setY(Math.random() * 2.5),
        spin: new Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3),
        half: Math.min(m.scale.x, m.scale.y, m.scale.z) * 0.45,
        rest: false,
        delay: Math.max(0, (m.position.y - centre.y) * 0.04) + Math.random() * 0.25,
      });
    }
    // the bell: falls last, lands upright-ish, rings, then tips over
    const bell = new Mesh(rig.bellMesh.geometry, (rig.bellMesh.material as MeshStandardMaterial).clone());
    rig.bellMesh.getWorldPosition(bell.position);
    bell.castShadow = true;
    this.group.add(bell);
    this.pieces.push({ obj: bell, vel: new Vector3(0, 0.5, 0), spin: new Vector3(), half: 0, rest: false, delay: 0.9, bell: true });
    scene.add(this.group);
  }

  /** world ground height function (terrain) */
  update(dt: number, ground: (x: number, z: number) => number) {
    this.t += dt;
    for (const p of this.pieces) {
      if (p.rest || this.t < p.delay) continue;
      const o = p.obj;
      p.vel.y -= 22 * dt;
      o.position.addScaledVector(p.vel, dt);
      o.rotation.x += p.spin.x * dt;
      o.rotation.y += p.spin.y * dt;
      o.rotation.z += p.spin.z * dt;
      const g = ground(o.position.x, o.position.z);
      const floor = g + (p.bell ? 0 : p.half);
      if (o.position.y <= floor) {
        const impact = -p.vel.y;
        o.position.y = floor;
        if (p.bell) {
          if (impact > 3) this.onBellLand(o.position.clone());
          p.vel.set(0, impact > 3 ? impact * 0.15 : 0, 0);
          if (impact <= 3) {
            p.rest = true;
            o.rotation.set(0.32, o.rotation.y, 0.12); // tipped onto its lip
          }
          continue;
        }
        if (impact > 4) this.onPieceLand(o.position.clone(), p.half > 0.4);
        p.vel.multiplyScalar(0.35);
        p.vel.y = impact * 0.22;
        p.spin.multiplyScalar(0.4);
        if (impact < 2.5) {
          p.rest = true;
          o.position.y = g + p.half * 0.6; // half-sunk into the earth
        }
      }
    }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
