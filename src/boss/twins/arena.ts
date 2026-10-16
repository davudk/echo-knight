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
  RingGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../../core/math';
import { Regions } from '../../world/Terrain';
import type { World } from '../../world/World';

/**
 * The Duelling Ring — the Twin Wardens' arena in the south region (Regions.twins = (0, 66), r 18).
 *
 * A ruined colosseum floor: a sand ring (r 14) fenced by a low wall (1.0 m, vaultable) with an
 * entrance gap facing the fog gate (north), four pillars at r 8.5 (Selene blinks behind them),
 * four braziers, a broken outer colosseum wall (r 18.6–19.6, just outside the fog) with banners
 * and a gate frame at the north gap. Everything solid is a box / cylinder whose collider is built
 * from the very same numbers as its mesh. All static geometry is merged into one vertex-coloured
 * mesh (+ instanced flames + two point lights).
 *
 * Angles: `a` is a facing-convention direction from the centre (sin a, cos a); north (the gate) = π.
 */

const R = Regions.twins;
const NORTH = Math.PI;

const PAL = {
  sand: '#b9a27c',
  sandDark: '#a58e6a',
  stone: '#9a917f',
  stoneDark: '#756d61',
  stoneWarm: '#a39278',
  iron: '#3a3634',
  banner: '#6e2430',
  bannerTrim: '#c49a4a',
  coal: '#2a201a',
} as const;
type Pal = keyof typeof PAL;

/** pillar positions (world) for Selene's blink + lock-on cover. `r` = footprint radius */
export const TwinPillars: { x: number; z: number; r: number }[] = [];

const FLAME = new Color(5.0, 2.2, 0.6);

class Builder {
  readonly geos: BufferGeometry[] = [];
  readonly flames: Vector3[] = [];
  readonly lights: Vector3[] = [];
  readonly rand = rng(6611);
  private readonly c = new Color();

  constructor(readonly world: World, readonly H: number) {}

  /** point at angle a, radius r from the centre */
  polar(a: number, r: number) {
    return { x: R.x + Math.sin(a) * r, z: R.z + Math.cos(a) * r };
  }

  /** solid box (mesh + identical collider). y0 <= 0 sinks it into the ground. */
  box(x: number, z: number, w: number, d: number, y0: number, y1: number, yaw: number, pal: Pal, collide = true, vary = 0.07) {
    let bottom = y0 <= 0.001 ? this.lowGround(x, z, w, d, yaw) - 0.6 : this.H + y0;
    if (y0 > 0.001) bottom = this.H + y0;
    const top = this.H + y1;
    const g = new BoxGeometry(w, top - bottom, d).toNonIndexed();
    g.deleteAttribute('uv');
    this.paint(g, pal, vary, true);
    g.applyMatrix4(new Matrix4().makeRotationY(yaw).setPosition(x, (top + bottom) / 2, z));
    this.geos.push(g);
    if (collide) this.world.addBox(x, z, w, d, bottom, top, yaw, 'twins-arena');
  }

  /** vertical cylinder (pillars, braziers); collider radius = max visual radius */
  cyl(x: number, z: number, rBottom: number, rTop: number, y0: number, y1: number, pal: Pal, collide = true, sides = 8) {
    const bottom = y0 <= 0.001 ? this.H - 0.5 : this.H + y0;
    const top = this.H + y1;
    const g = new CylinderGeometry(rTop, rBottom, top - bottom, sides, 1).toNonIndexed();
    g.deleteAttribute('uv');
    this.paint(g, pal, 0.06, true);
    g.applyMatrix4(new Matrix4().makeRotationY(this.rand() * 3).setPosition(x, (top + bottom) / 2, z));
    this.geos.push(g);
    if (collide) this.world.addCollider({ x, z, r: Math.max(rBottom, rTop), bottom, top });
  }

  /** flat decorative geometry lying on the floor */
  flat(g: BufferGeometry, y: number, pal: Pal, vary = 0.05) {
    const n = g.toNonIndexed();
    n.deleteAttribute('uv');
    n.rotateX(-Math.PI / 2);
    n.translate(R.x, this.H + y, R.z);
    this.paint(n, pal, vary, false);
    this.geos.push(n);
  }

  rubble(x: number, z: number, count: number, spread: number) {
    for (let i = 0; i < count; i++) {
      const s = 0.12 + this.rand() * 0.25;
      const g = new DodecahedronGeometry(1, 0).toNonIndexed();
      g.deleteAttribute('uv');
      this.paint(g, this.rand() < 0.5 ? 'stoneDark' : 'stone', 0.08, false);
      const m = new Matrix4().makeRotationY(this.rand() * 6);
      m.scale(new Vector3(s * (1 + this.rand() * 0.6), s * 0.7, s * (1 + this.rand() * 0.6)));
      m.setPosition(x + (this.rand() - 0.5) * spread * 2, this.H + s * 0.15, z + (this.rand() - 0.5) * spread * 2);
      g.applyMatrix4(m);
      this.geos.push(g);
    }
  }

  /** lowest terrain under a box footprint (outer walls stand in the terrain blend zone) */
  private lowGround(x: number, z: number, w: number, d: number, yaw: number) {
    const t = this.world.terrain;
    let lo = t.heightAt(x, z);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
      lo = Math.min(lo, t.heightAt(x + lx * c + lz * s, z - lx * s + lz * c));
    }
    return Math.min(lo, this.H);
  }

  /** per-triangle colour variation + a dark grounding gradient on vertical faces */
  private paint(g: BufferGeometry, pal: Pal, vary: number, ao: boolean) {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const col = new Float32Array(pos.count * 3);
    const base = new Color(PAL[pal]);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    for (let t = 0; t < pos.count; t += 3) {
      const k = 1 + (this.rand() - 0.5) * 2 * vary;
      const up = nrm ? nrm.getY(t) : 1;
      const lift = up > 0.5 ? 1.05 : up < -0.5 ? 0.7 : 1;
      for (let v = t; v < t + 3; v++) {
        const h = maxY - minY > 0.01 ? (pos.getY(v) - minY) / (maxY - minY) : 1;
        const shade = ao ? 0.72 + 0.28 * Math.min(1, h * 2.2) : 1;
        this.c.copy(base).multiplyScalar(k * lift * shade);
        col[v * 3] = this.c.r;
        col[v * 3 + 1] = this.c.g;
        col[v * 3 + 2] = this.c.b;
      }
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
  }
}

function angleDiff(a: number, b: number) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function build(b: Builder) {
  // ---------------------------------------------------------------- floor (decorative, on the flat terrain)
  b.flat(new RingGeometry(0, 14.1, 48, 3), 0.015, 'sand', 0.05);
  b.flat(new RingGeometry(5.6, 6.1, 48, 1), 0.025, 'sandDark', 0.04);
  b.flat(new RingGeometry(0, 1.5, 12, 1), 0.025, 'stoneWarm', 0.06);
  b.flat(new RingGeometry(13.6, 14.15, 48, 1), 0.025, 'stoneDark', 0.06);

  // ---------------------------------------------------------------- low wall (r 14.5, 1.0 m, entrance gap north)
  const n = 40;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    if (angleDiff(a, NORTH) < 0.21) continue; // entrance (~6 m)
    const p = b.polar(a, 14.5);
    const broken = i === 7 || i === 8 || i === 27;
    const h = broken ? 0.45 : 1.0;
    b.box(p.x, p.z, 2.32, 0.6, 0, h, a, 'stone');
    if (!broken) b.box(p.x, p.z, 2.32, 0.72, h, h + 0.1, a, 'stoneWarm'); // coping
    else b.rubble(p.x, p.z, 4, 0.9);
  }
  // entrance posts
  for (const s of [-1, 1]) {
    const p = b.polar(NORTH + s * 0.16, 14.5);
    b.box(p.x, p.z, 0.8, 0.8, 0, 1.5, NORTH, 'stoneWarm');
  }

  // ---------------------------------------------------------------- pillars (r 8.5)
  const pillarH = [5.2, 3.0, 4.4, 5.2];
  const pillarA = [NORTH - Math.PI / 4, NORTH + Math.PI / 4, -Math.PI / 4, Math.PI / 4];
  TwinPillars.length = 0;
  pillarA.forEach((a, i) => {
    const p = b.polar(a, 8.5);
    const h = pillarH[i];
    b.box(p.x, p.z, 1.5, 1.5, 0, 0.3, a, 'stoneWarm');
    b.cyl(p.x, p.z, 0.62, 0.56, 0.3, h, 'stone', true, 10);
    if (h > 4) b.box(p.x, p.z, 1.3, 1.3, h, h + 0.3, a, 'stoneWarm');
    else b.rubble(p.x, p.z, 7, 1.4);
    TwinPillars.push({ x: p.x, z: p.z, r: 0.75 });
  });

  // ---------------------------------------------------------------- braziers (r 12.4)
  const brazierA = [NORTH - 0.5, NORTH + 0.5, -0.45, 0.45];
  brazierA.forEach((a, i) => {
    const p = b.polar(a, 12.4);
    b.cyl(p.x, p.z, 0.3, 0.22, 0, 0.9, 'iron', false, 6);
    b.cyl(p.x, p.z, 0.36, 0.6, 0.9, 1.25, 'iron', false, 8);
    b.world.addCollider({ x: p.x, z: p.z, r: 0.6, bottom: b.H - 0.5, top: b.H + 1.25 });
    b.cyl(p.x, p.z, 0.5, 0.5, 1.2, 1.3, 'coal', false, 8);
    b.flames.push(new Vector3(p.x, b.H + 1.55, p.z));
    if (i >= 2) b.lights.push(new Vector3(p.x, b.H + 2.2, p.z));
  });

  // ---------------------------------------------------------------- walkway stumps (r 16.4)
  for (const a of [NORTH - 1.0, NORTH + 1.3, -1.9, 1.2, 0.1, 2.3]) {
    const p = b.polar(a, 16.4);
    const h = 0.6 + b.rand() * 0.8;
    b.cyl(p.x, p.z, 0.48, 0.44, 0, h, 'stoneDark', true, 8);
    b.rubble(p.x, p.z, 3, 0.8);
  }

  // ---------------------------------------------------------------- outer colosseum wall (r 19.1, outside the fog)
  const m = 44;
  for (let i = 0; i < m; i++) {
    const a = (i / m) * Math.PI * 2 + Math.PI / m;
    if (angleDiff(a, NORTH) < 0.2) continue; // gate gap
    const p = b.polar(a, 19.1);
    const h = 3.2 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 2.2;
    b.box(p.x, p.z, 2.78, 1.0, 0, h, a, i % 2 ? 'stone' : 'stoneWarm');
    if (i % 4 === 0) {
      const q = b.polar(a, 20.0);
      b.box(q.x, q.z, 1.0, 0.9, 0, h - 0.6, a, 'stoneDark'); // buttress (outside)
    }
    if (i % 6 === 3 && h > 3.8) {
      // banner on the inner face (behind the fog wall)
      const q = b.polar(a, 18.56);
      b.box(q.x, q.z, 1.0, 0.06, h - 2.9, h - 0.5, a, 'banner', false, 0.03);
      b.box(q.x, q.z, 1.1, 0.08, h - 0.6, h - 0.45, a, 'bannerTrim', false, 0.03);
    }
  }
  // gate frame at the north gap (the fog gate stands at r 18, 5 m wide)
  for (const s of [-1, 1]) {
    const x = R.x + s * 3.2;
    const z = R.z - 18.4;
    b.box(x, z, 1.0, 1.2, 0, 5.4, 0, 'stoneWarm');
    b.flames.push(new Vector3(x, b.H + 5.75, z));
  }
  b.box(R.x, R.z - 18.4, 7.4, 1.2, 5.4, 6.1, 0, 'stone');

  // scattered rubble on the sand
  for (let i = 0; i < 10; i++) {
    const a = b.rand() * Math.PI * 2;
    if (angleDiff(a, NORTH) < 0.4) continue;
    const p = b.polar(a, 11 + b.rand() * 2.5);
    b.rubble(p.x, p.z, 2, 0.5);
  }
}

/** Builds the arena meshes + colliders. Call `update(dt)` for flame flicker. */
export class TwinArena {
  readonly root = new Group();
  private readonly flames: InstancedMesh;
  private readonly flamePos: Vector3[];
  private readonly lights: PointLight[] = [];
  private readonly dummy = new Object3D();
  private t = 0;

  constructor(world: World) {
    const H = world.terrain.heightAt(R.x, R.z);
    const b = new Builder(world, H);
    build(b);
    this.root.name = 'twins-arena';
    const mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
    const mesh = new Mesh(mergeGeometries(b.geos), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'twins-static';
    this.root.add(mesh);

    const fg = new OctahedronGeometry(0.2, 0);
    fg.scale(1, 2.0, 1);
    this.flames = new InstancedMesh(fg, new MeshBasicMaterial({ color: FLAME }), b.flames.length);
    this.flamePos = b.flames;
    this.root.add(this.flames);
    for (const p of b.lights) {
      const l = new PointLight('#ff9a4a', 16, 14, 1.6);
      l.position.copy(p);
      this.lights.push(l);
      this.root.add(l);
    }
    world.scene.add(this.root);
    this.update(0);
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    for (let i = 0; i < this.flamePos.length; i++) {
      const k = Math.sin(t * 11 + i * 1.7) * 0.5 + Math.sin(t * 23.3 + i * 4.1) * 0.3;
      this.dummy.position.copy(this.flamePos[i]);
      this.dummy.scale.set(1 - k * 0.08, 1 + k * 0.22, 1 - k * 0.08);
      this.dummy.rotation.y = t * 2 + i;
      this.dummy.updateMatrix();
      this.flames.setMatrixAt(i, this.dummy.matrix);
    }
    this.flames.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.lights.length; i++) {
      this.lights[i].intensity = 16 * (1 + Math.sin(t * 9 + i * 2) * 0.08 + Math.sin(t * 21 + i) * 0.05);
    }
  }
}
