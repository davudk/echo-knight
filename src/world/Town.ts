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
  PointLight,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/Game';
import { rng, smoothstep } from '../core/math';
import type { Feature } from '../features';
import { Regions } from './Terrain';
import type { World } from './World';

/**
 * Ruined town / keep in the north region (centre Regions.town = (0, -62)).
 *
 * Everything solid is an axis-aligned-in-its-own-frame box built through `solid()`, which adds
 * the exact same box to the render batch and to `world.addBox`, so collision matches visuals.
 * All static geometry is merged into one vertex-coloured mesh (+ one glow mesh, + instanced
 * flames), so the whole town costs a handful of draw calls.
 *
 * Local coordinates: origin at the town centre, +z = south (towards the arena), y relative to
 * the flattened town ground height.
 *
 * Height ladder (gameplay):
 *  - 1.0–1.2 m  crates, low walls, ruin stubs (jump / vault)
 *  - 2.2–3.0 m  shed, eaves, scaffold, broken walls (jump + ledge grab)
 *  - 4.2–6.2 m  curtain walls, flat roofs, gatehouse (double jump / wall-run / echo)
 *  - 7.5–8.6 m  keep wall walk and turret
 *  - 10.4 m     watchtower top (corbelled ledges spiral up, 1.6 m apart)
 */

// ---------------------------------------------------------------- palette
const PAL = {
  stone: '#8d867a',
  stoneWarm: '#9a8e7a',
  stoneDark: '#6c665e',
  stoneMoss: '#78785f',
  plaster: '#d6c6a4',
  plaster2: '#c9b58f',
  timber: '#5a3d28',
  timberLight: '#7a5634',
  roof: '#8e4a35',
  roof2: '#7a3e2e',
  roof3: '#6e4a36',
  crate: '#8a6a44',
  iron: '#3a3836',
  dirt: '#76634a',
  cobble: '#7f7a70',
  banner: '#7e2a24',
  bannerTrim: '#c49a4a',
  door: '#3e2a1c',
  window: '#26201c',
} as const;
type Pal = keyof typeof PAL;

/** colour variation per cell (masonry) by palette entry */
const VARIATION: Partial<Record<Pal, number>> = {
  stone: 0.09, stoneWarm: 0.09, stoneDark: 0.08, stoneMoss: 0.1, roof: 0.1, roof2: 0.1, roof3: 0.1,
  plaster: 0.035, plaster2: 0.035, cobble: 0.14, dirt: 0.08,
};
/** masonry / tile cell size (m) */
const CELL: Partial<Record<Pal, number>> = {
  stone: 0.75, stoneWarm: 0.75, stoneDark: 0.75, stoneMoss: 0.75, roof: 0.42, roof2: 0.42, roof3: 0.42,
};

const GLOW_WINDOW = new Color(2.2, 1.15, 0.45);
const FLAME = new Color(5.0, 2.2, 0.6);

export interface Frame {
  x: number;
  z: number;
  yaw: number;
}
const ROOT: Frame = { x: 0, z: 0, yaw: 0 };

interface SolidOpts {
  tag?: string;
  /** false = decorative only (no collider) */
  collide?: boolean;
  /** extra yaw relative to the frame */
  yaw?: number;
  /** cell size override (0 = no masonry pattern) */
  cell?: number;
}

const hash = (a: number, b: number, c: number, d: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7 + d * 19.3) * 43758.5453;
  return s - Math.floor(s);
};

/** World-space spots enemies / other systems can use (patrol loop around the plaza, rooftops). */
export const TownSpots = {
  centre: { x: Regions.town.x, z: Regions.town.z },
  gate: { x: Regions.town.x, z: Regions.town.z + 25 },
  patrol: [
    [0, -6], [7, -3], [7, 6], [0, 9], [-7, 6], [-7, -3],
  ].map(([x, z]) => ({ x: Regions.town.x + x, z: Regions.town.z + z })),
};

class TownBuilder {
  readonly geos: BufferGeometry[] = [];
  readonly glow: BufferGeometry[] = [];
  readonly flames: Vector3[] = [];
  readonly lights: Vector3[] = [];
  private boxId = 0;
  private readonly tmp = new Color();
  readonly rand = rng(4242);

  constructor(
    readonly world: World,
    /** town ground height */
    readonly H: number,
  ) {}

  /** town-local point in frame `f` → world (x, z) */
  at(f: Frame, lx: number, lz: number) {
    const c = Math.cos(f.yaw);
    const s = Math.sin(f.yaw);
    return { x: Regions.town.x + f.x + lx * c + lz * s, z: Regions.town.z + f.z - lx * s + lz * c };
  }

  /** child frame of `f` at local (lx, lz) */
  sub(f: Frame, lx: number, lz: number, yaw = 0): Frame {
    const c = Math.cos(f.yaw);
    const s = Math.sin(f.yaw);
    return { x: f.x + lx * c + lz * s, z: f.z - lx * s + lz * c, yaw: f.yaw + yaw };
  }

  /**
   * Solid (or decorative) box. y0/y1 relative to town ground; y0 <= 0 sinks the box 0.6 m
   * into the ground so it never floats.
   */
  solid(f: Frame, lx: number, lz: number, w: number, d: number, y0: number, y1: number, pal: Pal, o: SolidOpts = {}) {
    const p = this.at(f, lx, lz);
    const yaw = f.yaw + (o.yaw ?? 0);
    const bottom = y0 <= 0.001 ? this.H - 0.6 : this.H + y0;
    const top = this.H + y1;
    const geo = this.boxGeo(w, top - bottom, d, pal, o.cell ?? CELL[pal] ?? 0, (top + bottom) / 2 - this.H);
    geo.applyMatrix4(new Matrix4().makeRotationY(yaw).setPosition(p.x, (top + bottom) / 2, p.z));
    this.geos.push(geo);
    if (o.collide !== false) this.world.addBox(p.x, p.z, w, d, bottom, top, yaw, o.tag);
  }

  deco(f: Frame, lx: number, lz: number, w: number, d: number, y0: number, y1: number, pal: Pal, yaw = 0) {
    this.solid(f, lx, lz, w, d, y0, y1, pal, { collide: false, yaw, cell: 0 });
  }

  /** emissive box (lit windows) */
  glowBox(f: Frame, lx: number, lz: number, w: number, d: number, y0: number, y1: number, color = GLOW_WINDOW) {
    const p = this.at(f, lx, lz);
    const g = new BoxGeometry(w, y1 - y0, d).toNonIndexed();
    g.deleteAttribute('uv');
    paint(g, () => color);
    g.applyMatrix4(new Matrix4().makeRotationY(f.yaw).setPosition(p.x, this.H + (y0 + y1) / 2, p.z));
    this.glow.push(g);
  }

  /** vertical cylinder (barrels, braziers); collider radius = visual radius */
  cyl(f: Frame, lx: number, lz: number, r: number, y0: number, y1: number, pal: Pal, collide = true, r2 = r, sides = 9) {
    const p = this.at(f, lx, lz);
    const g = new CylinderGeometry(r2, r, y1 - y0, sides, 1).toNonIndexed();
    g.deleteAttribute('uv');
    this.tint(g, pal, 0.06);
    g.applyMatrix4(new Matrix4().makeRotationY(this.rand() * 3).setPosition(p.x, this.H + (y0 + y1) / 2, p.z));
    this.geos.push(g);
    if (collide) this.world.addCollider({ x: p.x, z: p.z, r: Math.max(r, r2), bottom: this.H + y0 - (y0 <= 0 ? 0.5 : 0), top: this.H + y1 });
  }

  /** small decorative rubble (half buried, never blocks) */
  rubble(f: Frame, lx: number, lz: number, count: number, spread: number, pal: Pal = 'stoneDark') {
    for (let i = 0; i < count; i++) {
      const s = 0.12 + this.rand() * 0.22;
      const g = jitter(new DodecahedronGeometry(1, 0), 0.3, this.rand).toNonIndexed();
      g.deleteAttribute('uv');
      this.tint(g, pal, 0.08);
      const p = this.at(f, lx + (this.rand() - 0.5) * spread * 2, lz + (this.rand() - 0.5) * spread);
      const m = new Matrix4().makeRotationY(this.rand() * 6);
      m.scale(new Vector3(s * (1 + this.rand() * 0.6), s * 0.7, s * (1 + this.rand() * 0.6)));
      m.setPosition(p.x, this.H + s * 0.15, p.z);
      g.applyMatrix4(m);
      this.geos.push(g);
    }
  }

  flame(f: Frame, lx: number, lz: number, y: number) {
    const p = this.at(f, lx, lz);
    this.flames.push(new Vector3(p.x, this.H + y, p.z));
  }

  /** wall-mounted torch on the face of a box: bracket + flame, `out` = local outward normal */
  torch(f: Frame, lx: number, lz: number, y: number, outX: number, outZ: number) {
    this.deco(f, lx + outX * 0.12, lz + outZ * 0.12, 0.14, 0.14, y - 0.55, y - 0.05, 'iron');
    this.deco(f, lx + outX * 0.25, lz + outZ * 0.25, 0.22, 0.22, y - 0.12, y + 0.05, 'iron');
    this.flame(f, lx + outX * 0.25, lz + outZ * 0.25, y + 0.22);
  }

  /** box with per-cell colour variation (masonry / tile rows) and a grounding gradient */
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
      const lift = ny > 0.5 ? 1.05 : ny < -0.5 ? 0.7 : 1;
      for (let v = t; v < t + 3; v++) {
        const yAbove = pos.getY(v) + cy; // height above town ground
        const ao = 0.66 + 0.34 * smoothstep(-0.2, 1.3, yAbove);
        this.tmp.copy(base).multiplyScalar(k * lift * ao);
        col[v * 3] = this.tmp.r;
        col[v * 3 + 1] = this.tmp.g;
        col[v * 3 + 2] = this.tmp.b;
      }
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    return g;
  }

  private tint(g: BufferGeometry, pal: Pal, vary: number) {
    const base = new Color(PAL[pal]);
    const c = new Color();
    paint(g, () => c.copy(base).multiplyScalar(1 + (this.rand() - 0.5) * 2 * vary));
  }
}

/** per-triangle flat colours */
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

// ---------------------------------------------------------------- structures

type Side = 'n' | 's' | 'e' | 'w';

/** Decorations on a face of a w×d box in frame f: returns (lx, lz, outX, outZ, faceW) for offset t along the face. */
function onFace(w: number, d: number, side: Side, t: number, proud = 0.04) {
  switch (side) {
    case 's': return { lx: t, lz: d / 2 + proud, ox: 0, oz: 1, along: 'x' as const };
    case 'n': return { lx: -t, lz: -d / 2 - proud, ox: 0, oz: -1, along: 'x' as const };
    case 'e': return { lx: w / 2 + proud, lz: -t, ox: 1, oz: 0, along: 'z' as const };
    case 'w': return { lx: -w / 2 - proud, lz: t, ox: -1, oz: 0, along: 'z' as const };
  }
}

function faceBox(b: TownBuilder, f: Frame, w: number, d: number, side: Side, t: number, width: number, y0: number, y1: number, pal: Pal | 'glow', depth = 0.1) {
  const p = onFace(w, d, side, t, depth / 2 - 0.02);
  const bw = p.along === 'x' ? width : depth;
  const bd = p.along === 'x' ? depth : width;
  if (pal === 'glow') b.glowBox(f, p.lx, p.lz, bw, bd, y0, y1);
  else b.deco(f, p.lx, p.lz, bw, bd, y0, y1, pal);
}

interface HouseOpts {
  w: number;
  d: number;
  wallH: number;
  wall: Pal;
  roof: 'gable' | 'flat';
  roofPal?: Pal;
  timber?: boolean;
  door?: [Side, number];
  windows?: [Side, number, boolean?][];
  /** flat roof: sides without a parapet (stair arrival) */
  openSides?: Side[];
  tag?: string;
}

function house(b: TownBuilder, f: Frame, o: HouseOpts) {
  const { w, d, wallH } = o;
  // stone plinth (solid, slightly proud) + walls
  b.solid(f, 0, 0, w + 0.16, d + 0.16, 0, 0.55, 'stoneDark');
  b.solid(f, 0, 0, w, d, 0, wallH, o.wall, { tag: o.tag ?? (wallH >= 4 ? 'wall' : undefined) });

  if (o.timber) {
    // corner posts + belt beams (decorative, 4 cm proud)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.deco(f, sx * (w / 2 - 0.08), sz * (d / 2 - 0.08), 0.28, 0.28, 0.5, wallH, 'timber');
    }
    for (const y of [wallH * 0.52, wallH - 0.18]) {
      b.deco(f, 0, 0, w + 0.08, d + 0.08, y - 0.1, y + 0.1, 'timber');
    }
    // diagonal-ish braces read as vertical studs on long faces
    for (const side of ['s', 'n'] as Side[]) {
      for (const t of [-w / 4, w / 4]) faceBox(b, f, w, d, side, t, 0.18, 0.55, wallH * 0.52, 'timber', 0.08);
    }
  }
  if (o.door) {
    const [side, t] = o.door;
    faceBox(b, f, w, d, side, t, 1.15, 0.5, 2.35, 'timber', 0.12);
    faceBox(b, f, w, d, side, t, 0.9, 0.5, 2.2, 'door', 0.16);
  }
  for (const [side, t, lit] of o.windows ?? []) {
    const y = wallH > 4 ? [1.4, wallH - 1.4] : [Math.min(1.5, wallH * 0.5)];
    for (const wy of y) {
      faceBox(b, f, w, d, side, t, 0.9, wy - 0.05, wy + 0.95, 'timber', 0.1);
      faceBox(b, f, w, d, side, t, 0.65, wy + 0.05, wy + 0.85, lit ? 'glow' : 'window', 0.14);
      faceBox(b, f, w, d, side, t, 1.0, wy - 0.12, wy, 'stoneDark', 0.22); // sill
    }
  }

  const roofPal = o.roofPal ?? 'roof';
  if (o.roof === 'gable') {
    // stepped gable: tiers 0.4 m high (walkable steps), ridge along local x
    const tiers = 3;
    const D0 = d + 0.6;
    for (let i = 0; i < tiers; i++) {
      const dd = (D0 * (tiers - i)) / tiers;
      b.solid(f, 0, 0, w + 0.5, dd, wallH + i * 0.4, wallH + (i + 1) * 0.4, roofPal);
    }
    b.solid(f, 0, 0, w + 0.6, 0.35, wallH + tiers * 0.4, wallH + tiers * 0.4 + 0.18, 'timber');
    // chimney
    b.solid(f, w * 0.28, -D0 / 6, 0.6, 0.6, wallH + 0.4, wallH + tiers * 0.4 + 0.9, 'stoneDark');
  } else {
    const top = wallH + 0.25;
    b.solid(f, 0, 0, w + 0.3, d + 0.3, wallH, top, roofPal === 'roof' ? 'stoneDark' : roofPal, { cell: 0.6 });
    const open = o.openSides ?? [];
    const pw = 0.3;
    const W = w + 0.3;
    const D = d + 0.3;
    if (!open.includes('s')) b.solid(f, 0, D / 2 - pw / 2, W, pw, top, top + 0.4, o.wall, { cell: 0 });
    if (!open.includes('n')) b.solid(f, 0, -D / 2 + pw / 2, W, pw, top, top + 0.4, o.wall, { cell: 0 });
    if (!open.includes('e')) b.solid(f, W / 2 - pw / 2, 0, pw, D, top, top + 0.4, o.wall, { cell: 0 });
    if (!open.includes('w')) b.solid(f, -W / 2 + pw / 2, 0, pw, D, top, top + 0.4, o.wall, { cell: 0 });
  }
}

/** Merlons along local x from xa to xb at lz, standing on yTop. */
function merlons(b: TownBuilder, f: Frame, xa: number, xb: number, lz: number, yTop: number, thick: number, pal: Pal = 'stone') {
  const span = xb - xa;
  const n = Math.max(1, Math.round(span / 1.3));
  for (let i = 0; i < n; i++) {
    const x = xa + ((i + 0.5) * span) / n;
    b.solid(f, x, lz, 0.62, thick, yTop, yTop + 0.75, pal, { cell: 0 });
  }
}

/**
 * Curtain wall from a to b (town-local), with a height profile [[fraction, height], ...].
 * Height 0 = gap (rubble only). Full-height pieces get merlons on the outer side.
 */
function wallSeg(
  b: TownBuilder, a: [number, number], c: [number, number], thick: number, profile: [number, number][],
  o: { full?: number; outer?: 1 | -1; pal?: Pal } = {},
) {
  const dx = c[0] - a[0];
  const dz = c[1] - a[1];
  const L = Math.hypot(dx, dz);
  const f: Frame = { x: (a[0] + c[0]) / 2, z: (a[1] + c[1]) / 2, yaw: Math.atan2(-dz, dx) };
  const full = o.full ?? Math.max(...profile.map((p) => p[1]));
  let x = -L / 2;
  for (const [frac, h] of profile) {
    const len = frac * L;
    const mid = x + len / 2;
    if (h > 0) {
      b.solid(f, mid, 0, len + 0.02, thick, 0, h, o.pal ?? 'stone', { tag: h >= 2.5 ? 'wall' : undefined });
      if (h >= full - 0.01) merlons(b, f, x + 0.2, x + len - 0.2, (o.outer ?? 1) * (thick / 2 - 0.22), h, 0.44);
      else b.rubble(f, mid, (o.outer ?? 1) * -1.1, 3, len * 0.4);
    } else {
      b.rubble(f, mid, 0, 9, len * 0.45);
    }
    x += len;
  }
  return f;
}

function buildTown(b: TownBuilder) {
  // ----------------------------------------------------------- gatehouse (south, faces the arena)
  {
    const f: Frame = { x: 0, z: 25, yaw: 0 };
    const top = 6.2;
    const D = 3.2;
    for (const s of [-1, 1]) {
      b.solid(f, s * 4, 0, 3, D, 0, top, 'stoneWarm', { tag: 'wall' });
      // corbels softening the opening
      b.solid(f, s * 2.3, 0, 0.4, D, 3.8, 4.45, 'stoneDark', { cell: 0 });
      // banners (front)
      b.deco(f, s * 4, D / 2 + 0.03, 1.1, 0.05, 2.5, 5.2, 'banner');
      b.deco(f, s * 4, D / 2 + 0.05, 1.15, 0.05, 5.05, 5.25, 'bannerTrim');
      b.deco(f, s * 4, D / 2 + 0.05, 0.25, 0.05, 3.6, 4.4, 'bannerTrim');
      b.torch(f, s * 2.85, D / 2, 3.2, 0, 1);
      b.torch(f, s * 2.85, -D / 2, 3.2, 0, -1);
    }
    b.solid(f, 0, 0, 5.02, D, 4.45, top, 'stoneWarm');
    b.deco(f, 0, D / 2 + 0.04, 5.2, 0.1, 4.45, 4.7, 'stoneDark');
    merlons(b, f, -5.3, 5.3, D / 2 - 0.22, top, 0.44, 'stoneWarm');
    merlons(b, f, -5.3, 5.3, -D / 2 + 0.22, top, 0.44, 'stoneWarm');
    b.lights.push(new Vector3(0, 3.6, 25 + D / 2 + 1.6));
  }

  // ----------------------------------------------------------- curtain walls
  // east: full → broken → stub
  wallSeg(b, [5.2, 25], [14.5, 21.5], 1.4, [[1, 4.5]]);
  wallSeg(b, [14.5, 21.5], [21.5, 13.5], 1.4, [[0.5, 4.5], [0.2, 3.0], [0.3, 1.3]], { full: 4.5 });
  wallSeg(b, [21.5, 13.5], [25, 4], 1.4, [[0.3, 1.2], [0.7, 0]], { full: 4.5 });
  // west: full → corner tower → broken
  wallSeg(b, [-5.2, 25], [-15.5, 21], 1.4, [[1, 4.5]], { outer: -1 });
  {
    const f: Frame = { x: -17.5, z: 19.5, yaw: 0.45 };
    b.solid(f, 0, 0, 4.2, 4.2, 0, 7, 'stone', { tag: 'wall' });
    b.solid(f, 0, 0, 4.6, 4.6, 0, 0.9, 'stoneDark');
    for (const s of [-1, 1]) {
      merlons(b, f, -1.9, 1.9, s * 1.88, 7, 0.44);
      merlons(b, { ...f, yaw: f.yaw + Math.PI / 2 }, -1.2, 1.2, s * 1.88, 7, 0.44);
    }
    b.rubble(f, 2.8, 0, 6, 1.5);
  }
  wallSeg(b, [-19.5, 17], [-25.5, 8], 1.4, [[0.35, 4.5], [0.25, 2.4], [0.15, 1.1], [0.25, 0]], { outer: -1, full: 4.5 });

  // ----------------------------------------------------------- keep wall (north)
  {
    const f: Frame = { x: -2, z: -24, yaw: 0.04 };
    const D = 2.4;
    b.solid(f, -0.5, 0, 13, D, 0, 7.5, 'stone', { tag: 'wall' });
    merlons(b, f, -6.8, 5.8, -D / 2 + 0.22, 7.5, 0.44);
    merlons(b, f, -6.8, 5.8, D / 2 - 0.22, 7.5, 0.44);
    // turret at the west end
    b.solid(f, -8.5, 0, 3.4, 3.6, 0, 8.6, 'stoneMoss', { tag: 'wall' });
    merlons(b, f, -10, -7, -1.58, 8.6, 0.44, 'stoneMoss');
    merlons(b, f, -10, -7, 1.58, 8.6, 0.44, 'stoneMoss');
    // broken east end steps down
    b.solid(f, 7.5, 0, 3, D, 0, 5.2, 'stone', { tag: 'wall' });
    b.solid(f, 10, 0.1, 2, D - 0.2, 0, 2.8, 'stone');
    b.rubble(f, 11.5, 1.5, 10, 1.6);
    // arrow slits + a big door on the inner (south) face
    for (const x of [-4, 0, 4]) b.deco(f, x, D / 2 + 0.02, 0.22, 0.1, 3.4, 4.9, 'window');
    b.deco(f, -2, D / 2 + 0.03, 2.2, 0.12, 0, 3.0, 'timber');
    b.deco(f, -2, D / 2 + 0.06, 1.8, 0.12, 0, 2.8, 'door');
    b.torch(f, -3.6, D / 2, 2.8, 0, 1);
    // timber scaffold on the inner face: 2.6 m and 4.7 m platforms
    const scaffold = (cx: number, w: number, top: number) => {
      const lz = D / 2 + 1.0;
      b.solid(f, cx, lz, w, 1.9, top - 0.25, top, 'timberLight', { cell: 0.35 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        b.solid(f, cx + sx * (w / 2 - 0.15), lz + sz * 0.8, 0.2, 0.2, 0, top - 0.25, 'timber');
      }
    };
    scaffold(-2.5 + 3, 3, 2.6);
    scaffold(4, 3, 4.7);
    // crate stair up to the low scaffold
    b.solid(f, -0.6, D / 2 + 2.6, 1, 1, 0, 1.0, 'crate');
  }

  // ----------------------------------------------------------- watchtower (NE, ~10.4 m)
  {
    const f: Frame = { x: 10.5, z: -17, yaw: 0.2 };
    const S = 4.4;
    const top = 10.4;
    b.solid(f, 0, 0, S + 0.8, S + 0.8, 0, 0.8, 'stoneDark');
    b.solid(f, 0, 0, S, S, 0, top, 'stoneWarm', { tag: 'wall' });
    b.deco(f, 0, 0, S + 0.2, S + 0.2, top - 0.6, top - 0.35, 'stoneDark');
    for (const side of [-1, 1]) {
      for (const [a, c] of [[-1.7, 1.7]]) {
        merlons(b, f, a - 0.2, c + 0.2, side * (S / 2 - 0.22), top, 0.44, 'stoneWarm');
        merlons(b, { ...f, yaw: f.yaw + Math.PI / 2 }, a + 0.3, c - 0.3, side * (S / 2 - 0.22), top, 0.44, 'stoneWarm');
      }
    }
    // corbelled ledges spiralling up (1.6 m apart: a plain jump reaches each one)
    const ledges: [Side, number, number][] = [
      ['s', -1.1, 2.4], ['s', 1.1, 4.0], ['e', -1.1, 5.6], ['e', 1.1, 7.2], ['n', -1.1, 8.8],
    ];
    for (const [side, t, y] of ledges) {
      const p = onFace(S, S, side, t, 0.6);
      const along = p.along === 'x';
      b.solid(f, p.lx, p.lz, along ? 2 : 1.2, along ? 1.2 : 2, y - 0.4, y, 'stoneDark', { tag: 'ledge', cell: 0 });
      const q = onFace(S, S, side, t, 0.3);
      b.deco(f, q.lx, q.lz, along ? 0.5 : 0.6, along ? 0.6 : 0.5, y - 0.9, y - 0.4, 'stoneDark');
    }
    faceBox(b, f, S, S, 'w', 0, 1.2, 0.8, 2.9, 'door', 0.12);
    faceBox(b, f, S, S, 's', 0, 0.3, 6, 7.4, 'window', 0.1);
    faceBox(b, f, S, S, 'w', 0, 0.5, 6.4, 7.6, 'glow', 0.1);
    // beacon on top
    b.cyl(f, 0, 0, 0.35, top, top + 0.55, 'stoneDark', true, 0.5);
    b.cyl(f, 0, 0, 0.55, top + 0.55, top + 0.8, 'iron', false, 0.45);
    b.flame(f, 0, 0, top + 1.05);
  }

  // ----------------------------------------------------------- houses
  // two-storey stone house (W) with an outside stair to its 4.8 m roof
  {
    const f: Frame = { x: -20, z: -2, yaw: 0.08 };
    house(b, f, {
      w: 6, d: 8, wallH: 4.55, wall: 'stone', roof: 'flat', roofPal: 'stoneDark', openSides: ['e'],
      door: ['s', 0.8], windows: [['e', -2.2], ['e', 2.4, true], ['w', 0]],
    });
    // stair: 12 steps × 0.4 m along the east face, rising northwards
    for (let k = 1; k <= 12; k++) {
      b.solid(f, 3 + 0.7, 4 - k * 0.6 + 0.3, 1.4, 0.6, 0, 0.4 * k, k % 2 ? 'stoneWarm' : 'stone', { cell: 0 });
    }
    b.solid(f, 3 + 0.7, -3.65, 1.4, 0.9, 0, 4.8, 'stone');
  }
  // plaster bakery (SW), stepped gable roof
  {
    const f: Frame = { x: -13, z: 12.5, yaw: 0.25 };
    house(b, f, {
      w: 6, d: 4.6, wallH: 2.6, wall: 'plaster', roof: 'gable', roofPal: 'roof', timber: true,
      door: ['e', 0.6], windows: [['s', -1.4, true], ['s', 1.6], ['n', 0]],
    });
    b.torch(f, 3.05, 0.7, 2.1, 1, 0);
    b.cyl(f, 3.7, 1.2, 0.38, 0, 0.95, 'crate');
    b.cyl(f, 4.3, 1.9, 0.38, 0, 0.95, 'crate');
  }
  // timber-framed house (NE), stepped gable
  {
    const f: Frame = { x: 18.5, z: -7.5, yaw: -0.3 };
    house(b, f, {
      w: 5, d: 7, wallH: 3.0, wall: 'plaster2', roof: 'gable', roofPal: 'roof2', timber: true,
      door: ['w', -0.8], windows: [['w', 1.8, true], ['s', 0], ['n', 0]],
    });
    b.torch(f, -2.55, 0.6, 2.3, -1, 0);
  }
  // flat-roofed house (E), 4.2 m, crate stack up
  {
    const f: Frame = { x: 16.5, z: 5, yaw: 0.35 };
    house(b, f, {
      w: 6, d: 5, wallH: 4.2, wall: 'plaster', roof: 'flat', roofPal: 'roof3',
      door: ['w', 1.2], windows: [['w', -1.2, true], ['s', 0.5]],
    });
    b.solid(f, -3.6, -1.5, 1, 1, 0, 1.0, 'crate', { cell: 0.5 });
    b.solid(f, -3.6, -0.4, 1.05, 1.05, 0, 1.0, 'crate', { cell: 0.5 });
    b.solid(f, -3.6, -0.4, 0.95, 0.95, 1.0, 2.0, 'crate', { cell: 0.5, yaw: 0.2 });
  }
  // shed against the east curtain wall (2.2 m) → wall walk (4.5 m)
  {
    const a = [14.5, 21.5];
    const c = [21.5, 13.5];
    const yaw = Math.atan2(-(c[1] - a[1]), c[0] - a[0]);
    const f: Frame = { x: 16.3, z: 15.9, yaw };
    b.solid(f, 0, 0, 4, 3, 0, 2.0, 'timberLight', { cell: 0.3 });
    b.solid(f, 0, 0, 4.4, 3.4, 2.0, 2.25, 'roof3', { cell: 0.4 });
    faceBox(b, f, 4, 3, 'n', 0.5, 1.4, 0, 1.8, 'door', 0.1);
    b.solid(f, -2.6, -1.0, 0.9, 0.9, 0, 0.9, 'crate', { cell: 0.45, yaw: 0.3 });
  }

  // ----------------------------------------------------------- open ruin (NW) — walk-in
  {
    const f: Frame = { x: -14, z: -15, yaw: -0.15 };
    const t = 0.8;
    const piece = (lx: number, lz: number, w: number, d: number, h: number) =>
      b.solid(f, lx, lz, w, d, 0, h, 'stoneMoss', { tag: h >= 2.5 ? 'wall' : undefined });
    // south (doorway in the middle)
    piece(-2.5, 3.6, 3, t, 2.2);
    piece(2.5, 3.6, 3, t, 1.2);
    // west: tall with a stepped break
    piece(-3.6, -2, t, 4.0, 3.6);
    piece(-3.6, 1.0, t, 2.0, 3.6);
    piece(-3.6, 3.0, t, 2.0, 2.6);
    // north
    piece(-2, -3.6, 4, t, 4.2);
    piece(1, -3.6, 2, t, 3.0);
    piece(3, -3.6, 2, t, 1.8);
    // east (broken gap)
    piece(3.6, -2.5, t, 3, 2.5);
    piece(3.6, 2.75, t, 2.5, 1.2);
    b.rubble(f, 3.8, 0.3, 10, 1.0);
    // interior: flagstones, a fallen beam, a broken column to climb from
    b.deco(f, 0, 0, 6.4, 6.4, -0.05, 0.03, 'cobble');
    b.solid(f, -1.6, -1.6, 0.9, 0.9, 0, 1.6, 'stoneDark');
    b.deco(f, 0.8, 0.5, 4.2, 0.28, 0.0, 0.25, 'timber', 0.6);
    b.rubble(f, -1, 1, 8, 1.8);
  }

  // ----------------------------------------------------------- plaza edge: low walls, crates, barrels, braziers
  b.solid(ROOT, 11.6, -1, 0.7, 5, 0, 1.2, 'stone', { yaw: 0.05 });
  b.solid(ROOT, -10.3, -7.2, 4, 0.7, 0, 1.2, 'stone', { yaw: 0.85 });
  b.solid(ROOT, -11.2, 4.2, 3, 0.7, 0, 1.0, 'stoneDark', { yaw: -0.3 });
  b.rubble(ROOT, -12.8, 5.2, 5, 1.2);
  // inside the gate
  b.solid(ROOT, 4.6, 20.6, 1, 1, 0, 1.0, 'crate', { cell: 0.5, yaw: 0.1 });
  b.solid(ROOT, 5.5, 19.4, 1, 1, 0, 1.0, 'crate', { cell: 0.5, yaw: -0.2 });
  b.solid(ROOT, 4.7, 20.5, 0.9, 0.9, 1.0, 1.9, 'crate', { cell: 0.45, yaw: 0.5 });
  b.cyl(ROOT, -4.4, 21.2, 0.4, 0, 1.0, 'crate');
  b.cyl(ROOT, -5.3, 20.4, 0.4, 0, 1.0, 'crate');
  b.cyl(ROOT, -4.6, 19.9, 0.38, 0, 0.95, 'crate');
  // market stalls: counter (1.0 m) → canopy (2.45 m) → nearby roofs
  for (const [x, z, yaw] of [[9.4, -9.6, -0.75], [-6.8, 13.2, 0.2], [12.6, 11.6, 0.9]] as [number, number, number][]) {
    const f: Frame = { x, z, yaw };
    b.solid(f, 0, 0.2, 2.4, 0.9, 0, 1.0, 'timberLight', { cell: 0.3 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.solid(f, sx * 1.25, sz * 0.75, 0.14, 0.14, 0, 2.3, 'timber');
    b.solid(f, 0, 0, 2.8, 1.9, 2.3, 2.45, 'banner', { cell: 0 });
    for (const sx of [-1.05, 0, 1.05]) b.deco(f, sx, 0, 0.35, 1.92, 2.3, 2.47, 'bannerTrim');
    b.solid(f, -0.6, 0.25, 0.6, 0.5, 1.0, 1.25, 'crate', { cell: 0, yaw: 0.2 });
  }
  // well
  {
    const f: Frame = { x: -4, z: -14.5, yaw: 0.3 };
    b.cyl(f, 0, 0, 0.95, 0, 0.9, 'stone', true, 0.95, 10);
    b.cyl(f, 0, 0, 0.7, 0.86, 0.92, 'window', false, 0.7, 10);
    for (const s of [-1, 1]) b.solid(f, s * 0.8, 0, 0.16, 0.16, 0.9, 2.3, 'timber');
    b.solid(f, 0, 0, 2.0, 1.3, 2.3, 2.42, 'roof3', { cell: 0 });
  }
  // braziers at the plaza rim (fight lighting)
  for (const [x, z, light] of [[-7.2, -6.6, true], [7.6, 6.2, false]] as [number, number, boolean][]) {
    b.cyl(ROOT, x, z, 0.42, 0, 0.75, 'stoneDark', true, 0.32, 7);
    b.cyl(ROOT, x, z, 0.62, 0.75, 1.05, 'iron', false, 0.42, 8);
    b.flame(ROOT, x, z, 1.35);
    if (light) b.lights.push(new Vector3(x, 2.2, z));
  }
}

// ---------------------------------------------------------------- ground dressing (no collision)

/** Thin surface following the terrain (roads, plaza cobbles). */
function groundPatch(world: World, rand: () => number) {
  const verts: number[] = [];
  const cols: number[] = [];
  const t = world.terrain;
  const c = new Color();
  const quad = (pts: [number, number][], base: string, vary: number, lift: number) => {
    c.set(base).multiplyScalar(1 + (rand() - 0.5) * 2 * vary);
    const ys = pts.map(([x, z]) => t.heightAt(x, z) + lift);
    // keep faces pointing up (normal y = cross(p1 - p0, p2 - p0).y > 0)
    const up = (pts[2][0] - pts[0][0]) * (pts[1][1] - pts[0][1]) - (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) > 0;
    for (const i of up ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      verts.push(pts[i][0], ys[i], pts[i][1]);
      cols.push(c.r, c.g, c.b);
    }
  };
  const T = Regions.town;
  // plaza: rings of irregular cobble slabs
  const R = 10.5;
  for (let r = 0.0; r < R; r += 1.05) {
    const n = Math.max(6, Math.round((2 * Math.PI * (r + 0.5)) / 1.1));
    const off = rand() * 6;
    for (let i = 0; i < n; i++) {
      const a0 = off + (i / n) * Math.PI * 2;
      const a1 = off + ((i + 0.88) / n) * Math.PI * 2;
      const r0 = r + 0.06;
      const r1 = r + 0.98;
      const pts: [number, number][] = [
        [T.x + Math.cos(a0) * r0, T.z + Math.sin(a0) * r0],
        [T.x + Math.cos(a0) * r1, T.z + Math.sin(a0) * r1],
        [T.x + Math.cos(a1) * r1, T.z + Math.sin(a1) * r1],
        [T.x + Math.cos(a1) * r0, T.z + Math.sin(a1) * r0],
      ];
      quad(pts, '#837d72', 0.12, 0.035);
    }
  }
  // road: arena (z≈-11) → gate → plaza edge. Short segments so it hugs the terrain.
  const z0 = -11;
  const z1 = T.z + R - 0.3;
  const half = 2.1;
  for (let z = z0; z > z1; z -= 0.75) {
    const za = z;
    const zb = Math.max(z1, z - 0.75);
    const wob = (zz: number) => Math.sin(zz * 0.21) * 0.35;
    for (let k = 0; k < 4; k++) {
      const xa = -half + (k / 4) * half * 2;
      const xb = -half + ((k + 1) / 4) * half * 2;
      quad([[xa + wob(za), za], [xa + wob(zb), zb], [xb + wob(zb), zb], [xb + wob(za), za]],
        Math.abs(za - (T.z + 25)) < 2 ? '#6f6a62' : '#7a6649', 0.07, 0.05);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(cols), 3));
  g.computeVertexNormals();
  const mat = new MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.name = 'town-ground';
  return mesh;
}

// ---------------------------------------------------------------- feature

class Town {
  readonly root = new Group();
  private flames!: InstancedMesh;
  private flamePos: Vector3[] = [];
  private lights: PointLight[] = [];
  private readonly dummy = new Object3D();
  private t = 0;

  constructor(world: World) {
    const T = Regions.town;
    const H = world.terrain.heightAt(T.x, T.z);
    const b = new TownBuilder(world, H);
    buildTown(b);
    this.root.name = 'town';

    const mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
    const mesh = new Mesh(mergeGeometries(b.geos), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'town-static';
    this.root.add(mesh);

    if (b.glow.length) {
      const glow = new Mesh(mergeGeometries(b.glow), new MeshBasicMaterial({ vertexColors: true }));
      glow.name = 'town-glow';
      this.root.add(glow);
    }

    // flames: one instanced draw call, flickered in update()
    const fg = new OctahedronGeometry(0.16, 0);
    fg.scale(1, 2.0, 1);
    this.flames = new InstancedMesh(fg, new MeshBasicMaterial({ color: FLAME }), b.flames.length);
    this.flamePos = b.flames;
    this.root.add(this.flames);
    for (const p of b.lights) {
      const l = new PointLight('#ff9a4a', 18, 13, 1.6);
      l.position.set(T.x + p.x, H + p.y, T.z + p.z);
      this.lights.push(l);
      this.root.add(l);
    }
    this.root.add(groundPatch(world, rng(99)));
    world.scene.add(this.root);
    this.update(0);
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    for (let i = 0; i < this.flamePos.length; i++) {
      const p = this.flamePos[i];
      const k = Math.sin(t * 11 + i * 1.7) * 0.5 + Math.sin(t * 23.3 + i * 4.1) * 0.3;
      this.dummy.position.copy(p);
      this.dummy.scale.set(1 - k * 0.08, 1 + k * 0.22, 1 - k * 0.08);
      this.dummy.rotation.y = t * 2 + i;
      this.dummy.updateMatrix();
      this.flames.setMatrixAt(i, this.dummy.matrix);
    }
    this.flames.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.lights.length; i++) {
      this.lights[i].intensity = 18 * (1 + Math.sin(t * 9 + i * 2) * 0.08 + Math.sin(t * 21 + i) * 0.05);
    }
  }
}

let town: Town | null = null;

export const townFeature: Feature = {
  name: 'town',
  install(game: Game) {
    town = new Town(game.world);
    (game as unknown as { town?: Town }).town = town;
  },
  update(dt) {
    town?.update(dt);
  },
};
