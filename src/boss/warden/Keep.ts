import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, smoothstep } from '../../core/math';
import type { Region } from '../Arena';
import type { World } from '../../world/World';

/**
 * WARDEN'S KEEP — a walled courtyard (25 × 25 m inside) in the `warden` region.
 *
 * Local frame: origin = region centre, +x = east (the fog gate / the road to the town),
 * heights relative to the flattened ground. Every solid is a box built by `solid()`, which adds
 * the same box to the merged render batch and to `world.addBox`, so collision matches visuals
 * exactly (same approach as world/Town.ts). One merged mesh + one glow mesh + two instanced
 * flame meshes: a handful of draw calls, no lights.
 *
 * Height ladder (gameplay — the Warden's melee reaches 2.8 m above his feet):
 *  - 1.2–1.4 m  pillar stubs, steps, fallen drum (jump onto)
 *  - 2.9–3.3 m  broken pillars (stub → jump + ledge grab), north ledge 2.9 m
 *  - 3.6 m      west wall walk (broken in the middle — jump the gap), stairs at its south end
 *  - 4.6–5.2 m  curtain walls / gatehouse (wall-run surfaces)
 */

const PAL = {
  stone: '#7b7880',
  stoneDark: '#5d5964',
  stoneCold: '#6e7480',
  stoneMoss: '#6b6f62',
  flag: '#6f6c72',
  iron: '#34323a',
  banner: '#3e2a5c',
  bannerTrim: '#8f7bc4',
  wood: '#4a3628',
} as const;
type Pal = keyof typeof PAL;

const VARIATION: Partial<Record<Pal, number>> = { stone: 0.09, stoneDark: 0.08, stoneCold: 0.08, stoneMoss: 0.1, flag: 0.12 };
const CELL: Partial<Record<Pal, number>> = { stone: 0.8, stoneDark: 0.8, stoneCold: 0.8, stoneMoss: 0.8 };

const FLAME_WARM = new Color(5.0, 2.2, 0.6);
const FLAME_VOID = new Color(1.6, 0.7, 4.2);
const GLOW_RUNE = new Color(1.0, 0.5, 2.6);

const hash = (a: number, b: number, c: number, d: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7 + d * 19.3) * 43758.5453;
  return s - Math.floor(s);
};

/** A perch the Warden / tests care about (top surface of a solid). */
export interface Perch {
  x: number;
  z: number;
  top: number;
  hx: number;
  hz: number;
  name: string;
}

export interface KeepLayout {
  /** world-space centre + ground height */
  cx: number;
  cz: number;
  H: number;
  /** courtyard inner half size */
  half: number;
  pillars: Perch[];
  perches: Perch[];
  /** spot the Warden kneels at (world) */
  throne: { x: number; z: number };
  /** where echo platforms appear during floods (world, top height relative) */
  platformSpots: { x: number; z: number }[];
}

class KeepBuilder {
  readonly geos: BufferGeometry[] = [];
  readonly glow: BufferGeometry[] = [];
  readonly flamesWarm: Vector3[] = [];
  readonly flamesVoid: Vector3[] = [];
  readonly rand = rng(7177);
  private boxId = 0;
  private readonly tmp = new Color();

  constructor(readonly world: World, readonly cx: number, readonly cz: number, readonly H: number) {}

  /** Solid box centred at local (lx, lz); y0 ≤ 0 sinks 0.6 m into the ground. Returns the world box. */
  solid(lx: number, lz: number, w: number, d: number, y0: number, y1: number, pal: Pal, o: { yaw?: number; collide?: boolean; tag?: string; cell?: number } = {}) {
    const x = this.cx + lx;
    const z = this.cz + lz;
    const yaw = o.yaw ?? 0;
    const bottom = y0 <= 0.001 ? this.H - 0.6 : this.H + y0;
    const top = this.H + y1;
    const g = this.boxGeo(w, top - bottom, d, pal, o.cell ?? CELL[pal] ?? 0, (top + bottom) / 2 - this.H);
    g.applyMatrix4(new Matrix4().makeRotationY(yaw).setPosition(x, (top + bottom) / 2, z));
    this.geos.push(g);
    if (o.collide !== false) this.world.addBox(x, z, w, d, bottom, top, yaw, o.tag);
    return { x, z, top, hx: w / 2, hz: d / 2 };
  }

  deco(lx: number, lz: number, w: number, d: number, y0: number, y1: number, pal: Pal, yaw = 0) {
    this.solid(lx, lz, w, d, y0, y1, pal, { collide: false, yaw, cell: 0 });
  }

  glowBox(lx: number, lz: number, w: number, d: number, y0: number, y1: number, color: Color, yaw = 0) {
    const g = new BoxGeometry(w, y1 - y0, d).toNonIndexed();
    g.deleteAttribute('uv');
    paint(g, () => color);
    g.applyMatrix4(new Matrix4().makeRotationY(yaw).setPosition(this.cx + lx, this.H + (y0 + y1) / 2, this.cz + lz));
    this.glow.push(g);
  }

  cyl(lx: number, lz: number, r: number, y0: number, y1: number, pal: Pal, collide = true, r2 = r, sides = 8) {
    const x = this.cx + lx;
    const z = this.cz + lz;
    const g = new CylinderGeometry(r2, r, y1 - y0, sides, 1).toNonIndexed();
    g.deleteAttribute('uv');
    this.tint(g, pal, 0.06);
    g.applyMatrix4(new Matrix4().makeRotationY(this.rand() * 3).setPosition(x, this.H + (y0 + y1) / 2, z));
    this.geos.push(g);
    if (collide) this.world.addCollider({ x, z, r: Math.max(r, r2), bottom: this.H + y0 - (y0 <= 0 ? 0.5 : 0), top: this.H + y1 });
  }

  rubble(lx: number, lz: number, count: number, spread: number, pal: Pal = 'stoneDark', size = 1) {
    for (let i = 0; i < count; i++) {
      const s = (0.14 + this.rand() * 0.24) * size;
      const g = jitter(new DodecahedronGeometry(1, 0), 0.3, this.rand).toNonIndexed();
      g.deleteAttribute('uv');
      this.tint(g, pal, 0.08);
      const m = new Matrix4().makeRotationY(this.rand() * 6);
      m.scale(new Vector3(s * (1 + this.rand() * 0.6), s * 0.7, s * (1 + this.rand() * 0.6)));
      m.setPosition(this.cx + lx + (this.rand() - 0.5) * spread * 2, this.H + s * 0.15, this.cz + lz + (this.rand() - 0.5) * spread * 2);
      g.applyMatrix4(m);
      this.geos.push(g);
    }
  }

  flame(lx: number, lz: number, y: number, voidFlame = false) {
    (voidFlame ? this.flamesVoid : this.flamesWarm).push(new Vector3(this.cx + lx, this.H + y, this.cz + lz));
  }

  /** wall torch: bracket + flame on a face, (ox, oz) = outward normal */
  torch(lx: number, lz: number, y: number, ox: number, oz: number) {
    this.deco(lx + ox * 0.12, lz + oz * 0.12, 0.14, 0.14, y - 0.55, y - 0.05, 'iron');
    this.deco(lx + ox * 0.26, lz + oz * 0.26, 0.24, 0.24, y - 0.12, y + 0.05, 'iron');
    this.flame(lx + ox * 0.26, lz + oz * 0.26, y + 0.24);
  }

  private boxGeo(w: number, h: number, d: number, pal: Pal, cell: number, cy: number) {
    const id = this.boxId++;
    const seg = (v: number) => (cell > 0 ? Math.max(1, Math.min(24, Math.round(v / cell))) : 1);
    const sx = seg(w);
    const sy = seg(h);
    const sz = seg(d);
    const g = new BoxGeometry(w, h, d, sx, sy, sz).toNonIndexed();
    g.deleteAttribute('uv');
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const col = new Float32Array(pos.count * 3);
    const base = new Color(PAL[pal]);
    const vary = VARIATION[pal] ?? 0.04;
    for (let t = 0; t < pos.count; t += 3) {
      const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
      const cyy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
      const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
      const nx = nrm.getX(t);
      const ny = nrm.getY(t);
      let iu: number, iv: number, face: number;
      if (Math.abs(nx) > 0.5) {
        iu = Math.floor(((cz + d / 2) / d) * sz); iv = Math.floor(((cyy + h / 2) / h) * sy); face = nx > 0 ? 0 : 1;
      } else if (Math.abs(ny) > 0.5) {
        iu = Math.floor(((cx + w / 2) / w) * sx); iv = Math.floor(((cz + d / 2) / d) * sz); face = ny > 0 ? 2 : 3;
      } else {
        iu = Math.floor(((cx + w / 2) / w) * sx); iv = Math.floor(((cyy + h / 2) / h) * sy); face = nrm.getZ(t) > 0 ? 4 : 5;
      }
      const k = 1 + (hash(id, face, iu, iv) - 0.5) * 2 * vary;
      const lift = ny > 0.5 ? 1.06 : ny < -0.5 ? 0.7 : 1;
      for (let v = t; v < t + 3; v++) {
        const yAbove = pos.getY(v) + cy;
        const ao = 0.62 + 0.38 * smoothstep(-0.2, 1.4, yAbove);
        this.tmp.copy(base).multiplyScalar(k * lift * ao);
        col[v * 3] = this.tmp.r;
        col[v * 3 + 1] = this.tmp.g;
        col[v * 3 + 2] = this.tmp.b;
      }
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    return g;
  }

  tint(g: BufferGeometry, pal: Pal, vary: number) {
    const base = new Color(PAL[pal]);
    const c = new Color();
    paint(g, () => c.copy(base).multiplyScalar(1 + (this.rand() - 0.5) * 2 * vary));
  }
}

function paint(g: BufferGeometry, color: () => Color) {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    const c = color();
    for (let v = t; v < t + 3; v++) {
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
    }
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
}

function jitter(geo: BufferGeometry, amount: number, rand: () => number) {
  const pos = geo.getAttribute('position');
  const map = new Map<string, Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let off = map.get(key);
    if (!off) {
      off = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(amount);
      map.set(key, off);
    }
    pos.setXYZ(i, pos.getX(i) + off.x, pos.getY(i) + off.y, pos.getZ(i) + off.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Merlons along x (z fixed) or along z (x fixed). */
function merlonsX(b: KeepBuilder, xa: number, xb: number, lz: number, yTop: number, thick: number) {
  const n = Math.max(1, Math.round((xb - xa) / 1.4));
  for (let i = 0; i < n; i++) b.solid(xa + ((i + 0.5) * (xb - xa)) / n, lz, 0.7, thick, yTop, yTop + 0.8, 'stone', { cell: 0 });
}
function merlonsZ(b: KeepBuilder, za: number, zb: number, lx: number, yTop: number, thick: number) {
  const n = Math.max(1, Math.round((zb - za) / 1.4));
  for (let i = 0; i < n; i++) b.solid(lx, za + ((i + 0.5) * (zb - za)) / n, thick, 0.7, yTop, yTop + 0.8, 'stone', { cell: 0 });
}

/** Build the keep into the world. Returns the gameplay layout. */
export function buildKeep(world: World, region: Region): { root: Group; layout: KeepLayout; update(dt: number): void } {
  const H = world.terrain.heightAt(region.x, region.z);
  const b = new KeepBuilder(world, region.x, region.z, H);
  const A = 12.5; // inner half size
  const T = 1.4; // wall thickness
  const W = A + T / 2; // wall centre line
  const WH = 4.6;
  const perches: Perch[] = [];
  const perch = (r: { x: number; z: number; top: number; hx: number; hz: number }, name: string) => {
    const p = { ...r, top: r.top - H, name };
    perches.push(p);
    return p;
  };

  // ------------------------------------------------ curtain walls
  // south (z+) and north (z−): full span; west (x−) full span; east (x+) split by the gate.
  b.solid(0, W, 2 * (A + T), T, 0, WH, 'stone', { tag: 'wall' });
  merlonsX(b, -A - T + 0.4, A + T - 0.4, W + T / 2 - 0.25, WH, 0.5);
  b.solid(0, -W, 2 * (A + T), T, 0, WH, 'stone', { tag: 'wall' });
  merlonsX(b, -A - T + 0.4, A + T - 0.4, -W - T / 2 + 0.25, WH, 0.5);
  b.solid(-W, 0, T, 2 * A, 0, WH + 0.4, 'stoneCold', { tag: 'wall' });
  merlonsZ(b, -A, A, -W - T / 2 + 0.25, WH + 0.4, 0.5);
  const gateHalf = 2.7;
  const eastLen = A - gateHalf;
  for (const s of [-1, 1]) {
    b.solid(W, s * (gateHalf + eastLen / 2), T, eastLen, 0, WH, 'stone', { tag: 'wall' });
    merlonsZ(b, s > 0 ? gateHalf + 0.3 : -A, s > 0 ? A : -gateHalf - 0.3, W + T / 2 - 0.25, WH, 0.5);
  }
  // gate arch (lintel over the opening) + gatehouse corridor out to the fog gate (r = 20)
  b.solid(W, 0, T + 0.2, 2 * gateHalf + 0.4, 4.4, 5.4, 'stoneDark', { cell: 0 });
  const ghLen = region.radius - 0.4 - (W + T / 2);
  const ghX = W + T / 2 + ghLen / 2;
  for (const s of [-1, 1]) {
    b.solid(ghX, s * (gateHalf + 0.45), ghLen, 0.9, 0, 5.2, 'stoneDark', { tag: 'wall' });
    merlonsX(b, W + T / 2 + 0.3, region.radius - 0.7, s * (gateHalf + 0.45), 5.2, 0.6);
  }
  b.solid(region.radius - 0.9, 0, 0.9, 2 * gateHalf + 1.8, 4.3, 5.4, 'stoneDark', { cell: 0 });
  // corner towers
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.solid(sx * (A + 0.45), sz * (A + 0.45), 2.4, 2.4, 0, 6.2, 'stoneDark', { tag: 'wall' });
    b.solid(sx * (A + 0.45), sz * (A + 0.45), 2.8, 2.8, 6.2, 6.6, 'stone', { cell: 0 });
  }

  // ------------------------------------------------ west wall walk (3.6 m, broken) + stairs
  const walkX = -A + 1.2; // depth 2.4 → x ∈ [−12.5, −10.1]
  perch(b.solid(walkX, -8.0, 2.4, 9.0, 0, 3.6, 'stoneCold', { tag: 'ledge' }), 'walk-north');
  perch(b.solid(walkX, 3.5, 2.4, 9.0, 0, 3.6, 'stoneCold', { tag: 'ledge' }), 'walk-south');
  b.rubble(walkX, -2.25, 10, 0.9, 'stoneDark', 1.6); // the collapsed gap
  for (const z of [-12, -8, -4.0]) b.deco(walkX + 1.24, z, 0.08, 1.0, 0.0, 2.6, 'stoneDark'); // buttress lines
  perch(b.solid(walkX, 8.8, 2.4, 1.6, 0, 2.4, 'stoneCold'), 'stair-2');
  perch(b.solid(walkX, 10.4, 2.4, 1.6, 0, 1.2, 'stoneCold'), 'stair-1');
  // parapet stubs on the inner edge (low, decorative, no collision so they never snag)
  for (const z of [-11.5, -6.5, 1.5, 6.5]) b.deco(walkX + 1.05, z, 0.3, 0.6, 3.6, 3.95, 'stone');

  // ------------------------------------------------ north ledge (2.9 m), joins the wall walk
  perch(b.solid(-3.5, -A + 1.0, 13.2, 2.0, 0, 2.9, 'stoneMoss', { tag: 'ledge' }), 'north-ledge');
  b.rubble(3.8, -A + 1.4, 8, 0.8, 'stoneMoss', 1.4);

  // ------------------------------------------------ pillars (square, broken tops) + stubs
  const pillars: Perch[] = [];
  const pillar = (lx: number, lz: number, h: number, yaw: number, name: string) => {
    const r = b.solid(lx, lz, 1.8, 1.8, 0, h, 'stone', { yaw, tag: 'pillar' });
    // plinth + broken capital chunks (decorative, inside the footprint)
    b.deco(lx, lz, 2.2, 2.2, 0, 0.35, 'stoneDark', yaw);
    b.deco(lx + 0.35, lz - 0.3, 0.8, 0.7, h, h + 0.22, 'stoneDark', yaw + 0.4);
    b.rubble(lx + 1.6, lz + 0.8, 4, 0.6, 'stoneDark');
    const p = perch(r, name);
    pillars.push(p);
  };
  pillar(-5.0, -5.0, 3.0, 0.15, 'pillar-nw');
  pillar(5.5, -6.0, 3.3, -0.2, 'pillar-ne');
  pillar(6.0, 6.0, 2.9, 0.35, 'pillar-se');
  pillar(-4.0, 6.8, 3.1, -0.1, 'pillar-sw');
  perch(b.solid(-7.0, -2.4, 1.6, 1.6, 0, 1.3, 'stoneDark', { yaw: 0.3 }), 'stub-nw');
  perch(b.solid(3.0, -8.4, 1.5, 1.5, 0, 1.4, 'stoneDark', { yaw: -0.4 }), 'stub-ne');
  perch(b.solid(8.6, 3.4, 1.5, 1.5, 0, 1.3, 'stoneDark', { yaw: 0.2 }), 'stub-se');
  perch(b.solid(-1.4, 9.0, 1.6, 1.6, 0, 1.2, 'stoneDark', { yaw: 0.6 }), 'stub-sw');
  // fallen drum (cover)
  perch(b.solid(9.4, -8.8, 3.4, 1.2, 0, 1.0, 'stone', { yaw: 0.55 }), 'fallen-drum');

  // ------------------------------------------------ dais (throne spot) + rune ring
  const throne = { x: region.x - 6.5, z: region.z };
  b.cyl(-6.5, 0, 3.0, 0, 0.06, 'stoneDark', false, 3.0, 12);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.glowBox(-6.5 + Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0.5, 0.12, 0.05, 0.075, GLOW_RUNE, -a);
  }

  // ------------------------------------------------ braziers (void flame), wall torches, banners
  for (const [x, z] of [[10.4, -10.4], [10.4, 10.4], [-8.6, 10.6], [-8.4, -9.0]] as [number, number][]) {
    b.cyl(x, z, 0.42, 0, 0.8, 'stoneDark', true, 0.32, 7);
    b.cyl(x, z, 0.64, 0.8, 1.1, 'iron', false, 0.44, 8);
    b.flame(x, z, 1.4, true);
  }
  for (const s of [-1, 1]) b.torch(A - 0.0, s * (gateHalf + 1.6), 3.0, -1, 0); // inside, flanking the gate
  for (const x of [-6, 0, 6]) b.torch(x, A, 3.2, 0, -1);
  for (const x of [5.5, 10]) b.torch(x, -A, 3.2, 0, 1);
  for (const s of [-1, 1]) b.torch(region.radius - 0.9, s * (gateHalf + 1.3), 3.2, 1, 0); // outside the gatehouse
  // torn void banners on the west wall above the walk
  for (const z of [-7, 3]) {
    b.deco(-A + 0.06, z, 0.06, 1.5, 4.6, 5.6, 'banner');
    b.deco(-A + 0.07, z, 0.06, 1.0, 4.0, 4.6, 'banner');
    b.deco(-A + 0.08, z, 0.06, 1.6, 5.55, 5.65, 'bannerTrim');
  }

  // ------------------------------------------------ flagstone floor (thin, no collision)
  const floor = flagstones(world, region.x, region.z, H, A, b.rand);

  // ------------------------------------------------ assemble
  const root = new Group();
  root.name = 'warden-keep';
  const mesh = new Mesh(mergeGeometries(b.geos), new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh, floor);
  if (b.glow.length) root.add(new Mesh(mergeGeometries(b.glow), new MeshBasicMaterial({ vertexColors: true, toneMapped: false })));
  const fg = new OctahedronGeometry(0.17, 0);
  fg.scale(1, 2.0, 1);
  const flameSets: [InstancedMesh, Vector3[]][] = [];
  for (const [list, color] of [[b.flamesWarm, FLAME_WARM], [b.flamesVoid, FLAME_VOID]] as [Vector3[], Color][]) {
    if (!list.length) continue;
    const im = new InstancedMesh(fg, new MeshBasicMaterial({ color, toneMapped: false }), list.length);
    root.add(im);
    flameSets.push([im, list]);
  }
  world.scene.add(root);

  const dummy = new Object3D();
  let t = 0;
  const update = (dt: number) => {
    t += dt;
    for (const [im, list] of flameSets) {
      for (let i = 0; i < list.length; i++) {
        const k = Math.sin(t * 11 + i * 1.7) * 0.5 + Math.sin(t * 23.3 + i * 4.1) * 0.3;
        dummy.position.copy(list[i]);
        dummy.scale.set(1 - k * 0.08, 1 + k * 0.22, 1 - k * 0.08);
        dummy.rotation.y = t * 2 + i;
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  };
  update(0);

  return {
    root,
    update,
    layout: {
      cx: region.x, cz: region.z, H, half: A, pillars, perches, throne,
      platformSpots: [{ x: region.x + 1.5, z: region.z - 1.0 }, { x: region.x + 9.5, z: region.z + 0.0 }, { x: region.x + 0.5, z: region.z + 6.5 }, { x: region.x - 0.5, z: region.z - 8.5 }],
    },
  };
}

/** Irregular flagstone quads covering the courtyard + gatehouse (polygon-offset, no collision). */
function flagstones(world: World, cx: number, cz: number, H: number, A: number, rand: () => number) {
  const verts: number[] = [];
  const cols: number[] = [];
  const c = new Color();
  const quad = (x0: number, z0: number, x1: number, z1: number, base: string, lift = 0.045, vary = true) => {
    c.set(base).multiplyScalar(vary ? 0.88 + rand() * 0.24 : 1);
    const y = H + lift;
    const pts = [[x0, z0], [x0, z1], [x1, z1], [x1, z0]];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      verts.push(cx + pts[i][0], y, cz + pts[i][1]);
      cols.push(c.r, c.g, c.b);
    }
  };
  // grout bed under the slabs
  quad(-A, -A, A, A, '#3b3940', 0.02, false);
  quad(A, -2.7, 19.5, 2.7, '#3b3940', 0.02, false);
  const S = 1.25;
  for (let x = -A; x < A - 0.01; x += S) {
    for (let z = -A; z < A - 0.01; z += S) {
      const g = 0.06;
      quad(x + g, z + g, Math.min(A, x + S) - g, Math.min(A, z + S) - g, Math.hypot(x + 6, z) < 3.2 ? '#4f4a58' : '#6c6970');
    }
  }
  for (let x = A; x < 19.4; x += S) for (let z = -2.6; z < 2.6; z += S) quad(x + 0.06, z + 0.06, Math.min(19.4, x + S) - 0.06, Math.min(2.6, z + S) - 0.06, '#66636a');
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(cols), 3));
  g.computeVertexNormals();
  const mesh = new Mesh(g, new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mesh.receiveShadow = true;
  void world;
  return mesh;
}
