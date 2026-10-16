import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  DynamicDrawUsage,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { playSfx } from '../../audio/audioFeature';
import type { Game } from '../../core/Game';
import { clamp, rng } from '../../core/math';
import { Regions } from '../../world/Terrain';
import type { BoxCollider } from '../../world/World';
import type { Decal } from '../Decals';

/**
 * The north-east storm plateau (Regions.stormcaller): a raised tiled stone platform (~31 m) with
 * five conductive pylons (her perches, cover from bolts), broken edges, stairs up from the fog
 * gate (south-west), ruined columns around the rim and a permanent storm cloud overhead.
 *
 * Local frame: origin at the region centre, +lz points at the fog gate, +lx to its right.
 * Every tile is its own box collider so the storm event can drop tiles (pits) and restore them.
 */
export const SC = Regions.stormcaller;
export const TILE = 4.5;
/** plateau floor height above the flattened ground */
export const RAISE = 1.0;
/** pylon top above the plateau floor (her perches) */
export const PERCH_H = 2.6;
const PYLON_W = 2.6;
const PLATEAU_R = 16.5;

export interface Perch {
  x: number;
  z: number;
  y: number;
  /** pylon index, -1 = plateau floor */
  pylon: number;
}

export interface Pylon {
  x: number;
  z: number;
  top: number;
  crystal: Vector3;
}

type TileState = 'solid' | 'crack' | 'fall' | 'gone' | 'rise';

interface Tile {
  i: number;
  j: number;
  x: number;
  z: number;
  collapsible: boolean;
  state: TileState;
  t: number;
  dur: number;
  collider: BoxCollider | null;
  decal: Decal | null;
  y: number;
  vy: number;
  tilt: number;
}

const PAL = {
  slate: new Color('#7a7886'),
  slate2: new Color('#6c6a78'),
  slate3: new Color('#858393'),
  dark: new Color('#4e4c58'),
  pylon: new Color('#5d5b69'),
  band: new Color('#8a8798'),
  cloud: new Color('#3b3f4b'),
  cloud2: new Color('#2d3039'),
  rubble: new Color('#5f5c66'),
};

const CRYSTAL_HL = new Color(1.2, 3, 1.6);

function paint(g: BufferGeometry, c: Color, vary: number, r: () => number) {
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const t = new Color();
  for (let i = 0; i < pos.count; i += 3) {
    t.copy(c).multiplyScalar(1 + (r() - 0.5) * 2 * vary);
    for (let k = i; k < i + 3; k++) {
      col[k * 3] = t.r;
      col[k * 3 + 1] = t.g;
      col[k * 3 + 2] = t.b;
    }
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

// ====================================================================== storm sky
/**
 * Global storm mood while the fight runs: fog darkens / thickens, sun and sky dim, lightning
 * flashes brighten the hemisphere light. `level` 0 restores the exact original values.
 */
export class StormSky {
  level = 0;
  target = 0;
  private flash = 0;
  private saved = false;
  private fog: FogExp2 | null = null;
  private hemi: HemisphereLight | null = null;
  private dome: ShaderMaterial | null = null;
  private readonly orig = { fog: new Color(), density: 0, hemi: 0, sun: 0, horizon: new Color(), zenith: new Color(), bg: new Color() };
  private readonly stormFog = new Color('#3d4352');
  private readonly stormHorizon = new Color('#4a4c5a');
  private readonly stormZenith = new Color('#181c26');

  constructor(private readonly game: Game) {}

  private capture() {
    const scene = this.game.scene;
    this.fog = scene.fog instanceof FogExp2 ? scene.fog : null;
    scene.traverse((o) => {
      if (!this.hemi && (o as HemisphereLight).isHemisphereLight) this.hemi = o as HemisphereLight;
      const m = (o as Mesh).material as ShaderMaterial | undefined;
      if (!this.dome && m && (m as ShaderMaterial).isShaderMaterial && m.uniforms?.uZenith) this.dome = m;
    });
    if (this.fog) {
      this.orig.fog.copy(this.fog.color);
      this.orig.density = this.fog.density;
    }
    this.orig.hemi = this.hemi?.intensity ?? 0;
    this.orig.sun = this.game.sky.sun.intensity;
    if (this.dome) {
      this.orig.horizon.copy(this.dome.uniforms.uHorizon.value as Color);
      this.orig.zenith.copy(this.dome.uniforms.uZenith.value as Color);
    }
    this.saved = true;
  }

  pulse(k: number) {
    this.flash = Math.max(this.flash, k);
  }

  update(dt: number) {
    this.level += (this.target - this.level) * Math.min(1, dt * 0.8);
    this.flash = Math.max(0, this.flash - dt * 6);
    if (this.level < 0.004 && this.flash <= 0) {
      if (this.saved) this.restore();
      return;
    }
    if (!this.saved) this.capture();
    const k = this.level;
    const O = this.orig;
    if (this.fog) {
      this.fog.color.copy(O.fog).lerp(this.stormFog, k * 0.85);
      this.fog.density = O.density * (1 + 0.45 * k);
    }
    if (this.hemi) this.hemi.intensity = O.hemi * (1 - 0.4 * k) + this.flash * 1.6;
    this.game.sky.sun.intensity = O.sun * (1 - 0.6 * k);
    if (this.dome) {
      (this.dome.uniforms.uHorizon.value as Color).copy(O.horizon).lerp(this.stormHorizon, k * 0.8);
      (this.dome.uniforms.uZenith.value as Color).copy(O.zenith).lerp(this.stormZenith, k * 0.85);
    }
  }

  /** Put every value back exactly (fight over / reset). */
  restore() {
    if (!this.saved) return;
    const O = this.orig;
    if (this.fog) {
      this.fog.color.copy(O.fog);
      this.fog.density = O.density;
    }
    if (this.hemi) this.hemi.intensity = O.hemi;
    this.game.sky.sun.intensity = O.sun;
    if (this.dome) {
      (this.dome.uniforms.uHorizon.value as Color).copy(O.horizon);
      (this.dome.uniforms.uZenith.value as Color).copy(O.zenith);
    }
    this.saved = false;
    this.level = 0;
    this.flash = 0;
  }
}

// ====================================================================== arena
export class StormArena {
  readonly H: number;
  readonly floor: number;
  readonly cx = SC.x;
  readonly cz = SC.z;
  readonly root = new Group();
  readonly pylons: Pylon[] = [];
  readonly perches: Perch[] = [];
  readonly tiles: Tile[] = [];
  readonly sky: StormSky;
  /** the lower ground ring (off the plateau) is electrified (storm event) */
  edgeCharged = false;
  private readonly tileMesh: InstancedMesh;
  private readonly crystals: InstancedMesh;
  private readonly crystalColor = new Color();
  private readonly crystalHighlight: number[] = [];
  private readonly clouds: Mesh;
  private readonly cloudMat: MeshStandardMaterial;
  private readonly glyph: Mesh;
  private edgeDecal: Decal | null = null;
  private readonly v = new Vector3();
  private readonly o = new Object3D();
  private t = 0;
  private cloudFlash = 0;
  /** gameplay energy of the crystals 0..1 (fight) */
  energy = 0.25;

  constructor(private readonly game: Game, readonly gateYaw: number) {
    const w = game.world;
    this.H = w.terrain.heightAt(SC.x, SC.z);
    this.floor = this.H + RAISE;
    this.sky = new StormSky(game);
    const r = rng(7717);
    const geos: BufferGeometry[] = [];
    const glow: BufferGeometry[] = [];

    // ------------------------------------------------------------ tiles
    const N = 3;
    const tileCandidates: { i: number; j: number }[] = [];
    for (let i = -N; i <= N; i++) {
      for (let j = -N; j <= N; j++) {
        const d = Math.hypot(i * TILE, j * TILE);
        if (d > PLATEAU_R) continue;
        const gateColumn = i === 0 && j > 0;
        // broken edge: some outer tiles are missing (never on the gate path)
        if (d > 13 && !gateColumn && r() < 0.3) continue;
        tileCandidates.push({ i, j });
      }
    }
    this.tileMesh = new InstancedMesh(new BoxGeometry(TILE - 0.1, RAISE + 0.6, TILE - 0.1), new MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0.05 }), tileCandidates.length);
    this.tileMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.tileMesh.castShadow = false;
    this.tileMesh.receiveShadow = true;
    const tc = new Color();
    for (const { i, j } of tileCandidates) {
      const p = this.at(i * TILE, j * TILE);
      const tile: Tile = {
        i, j, x: p.x, z: p.z, collapsible: true, state: 'solid', t: 0, dur: 0, collider: null, decal: null, y: 0, vy: 0, tilt: 0,
      };
      tile.collider = w.addBox(p.x, p.z, TILE, TILE, this.H - 0.6, this.floor, gateYaw, 'storm-tile');
      const k = this.tiles.length;
      this.tiles.push(tile);
      const pick = r();
      tc.copy(pick < 0.33 ? PAL.slate : pick < 0.66 ? PAL.slate2 : PAL.slate3).multiplyScalar(0.92 + r() * 0.16);
      this.tileMesh.setColorAt(k, tc);
      this.placeTile(k);
    }
    this.tileMesh.instanceColor!.needsUpdate = true;
    this.root.add(this.tileMesh);

    // ------------------------------------------------------------ stairs (gate side)
    const edge = N * TILE + TILE / 2;
    for (let s = 0; s < 3; s++) {
      const top = this.floor - 0.25 * (s + 1);
      const lz = edge + 0.45 + s * 0.9;
      this.solid(geos, 0, lz, 4.2, 0.9, this.H - 0.6, top, PAL.slate2, r);
    }

    // ------------------------------------------------------------ pylons (perches)
    const PYLON_R = 10;
    for (let k = 0; k < 5; k++) {
      const a = ((36 + k * 72) * Math.PI) / 180;
      const lx = Math.sin(a) * PYLON_R;
      const lz = Math.cos(a) * PYLON_R;
      const p = this.at(lx, lz);
      const top = this.floor + PERCH_H;
      this.solid(geos, lx, lz, PYLON_W, PYLON_W, this.H - 0.6, top, PAL.pylon, r, 'storm-pylon');
      // capstone band + low corner nubs (bolts fly over them)
      this.deco(geos, lx, lz, PYLON_W + 0.12, PYLON_W + 0.12, top - 0.35, top - 0.05, PAL.band, r);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const ox = lx + sx * (PYLON_W / 2 - 0.2);
        const oz = lz + sz * (PYLON_W / 2 - 0.2);
        this.solid(geos, ox, oz, 0.42, 0.42, top - 0.1, top + 0.35, PAL.dark, r);
      }
      // glowing rune strips on each face
      for (const [fx, fz, ww, dd] of [[0, 1, 1.4, 0.06], [0, -1, 1.4, 0.06], [1, 0, 0.06, 1.4], [-1, 0, 0.06, 1.4]] as const) {
        const gx = lx + fx * (PYLON_W / 2 + 0.02);
        const gz = lz + fz * (PYLON_W / 2 + 0.02);
        const g = new BoxGeometry(ww, 0.12, dd).toNonIndexed();
        g.deleteAttribute('uv');
        paint(g, new Color(0.35, 1.2, 1.9), 0, r);
        const pp = this.at(gx, gz);
        g.applyMatrix4(new Matrix4().makeRotationY(gateYaw).setPosition(pp.x, this.floor + 1.6, pp.z));
        glow.push(g);
      }
      this.pylons.push({ x: p.x, z: p.z, top, crystal: new Vector3(p.x, top + 2.6, p.z) });
      this.perches.push({ x: p.x, z: p.z, y: top, pylon: k });
      this.crystalHighlight.push(0);
    }
    // floor perches
    for (const [lx, lz] of [[0, 0], [5.2, -7.6], [-5.2, -7.6], [0, 8.5]]) {
      const p = this.at(lx, lz);
      this.perches.push({ x: p.x, z: p.z, y: this.floor, pylon: -1 });
    }
    // tiles under pylons, floor perches and the stair landing never collapse
    for (const t of this.tiles) {
      for (const pe of this.perches) if (this.inTile(t, pe.x, pe.z, pe.pylon >= 0 ? PYLON_W / 2 + 0.2 : 1.6)) t.collapsible = false;
      if (t.i === 0 && t.j === N) t.collapsible = false;
    }

    // ------------------------------------------------------------ rim ruins + rubble
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + 0.2;
      if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.45) continue; // keep the gate approach clear
      const rr = 18.2 + r() * 0.6;
      const lx = Math.sin(a) * rr;
      const lz = Math.cos(a) * rr;
      const h = 1.2 + r() * 3.2;
      this.column(geos, lx, lz, 0.55 + r() * 0.15, h, r);
    }
    for (let k = 0; k < 40; k++) {
      const a = r() * Math.PI * 2;
      const rr = 16.3 + r() * 3;
      const lx = Math.sin(a) * rr;
      const lz = Math.cos(a) * rr;
      if (lz > 15 && Math.abs(lx) < 3) continue;
      const s = 0.15 + r() * 0.35;
      const g = new DodecahedronGeometry(1, 0);
      g.deleteAttribute('uv');
      paint(g, PAL.rubble, 0.1, r);
      const p = this.at(lx, lz);
      g.applyMatrix4(new Matrix4().makeRotationY(r() * 6).scale(new Vector3(s * (1 + r()), s * 0.6, s * (1 + r()))).setPosition(p.x, this.H + s * 0.15, p.z));
      geos.push(g);
    }

    const stat = new Mesh(mergeGeometries(geos), new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0.05 }));
    stat.castShadow = true;
    stat.receiveShadow = true;
    stat.name = 'storm-static';
    this.root.add(stat);
    const glowMesh = new Mesh(mergeGeometries(glow), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    this.root.add(glowMesh);

    // central glyph ring (inlay)
    this.glyph = new Mesh(new RingGeometry(3.2, 3.45, 48, 1).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: new Color(0.25, 0.9, 1.4), transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.glyph.position.set(SC.x, this.floor + 0.03, SC.z);
    this.root.add(this.glyph);

    // ------------------------------------------------------------ crystals (one instanced draw)
    const cg = new OctahedronGeometry(0.45, 0);
    cg.scale(1, 1.8, 1);
    this.crystals = new InstancedMesh(cg, new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 5);
    this.crystals.instanceMatrix.setUsage(DynamicDrawUsage);
    this.crystals.setColorAt(0, new Color());
    this.root.add(this.crystals);

    // ------------------------------------------------------------ storm clouds
    const cl: BufferGeometry[] = [];
    for (let k = 0; k < 13; k++) {
      const a = r() * Math.PI * 2;
      const rr = r() * 17;
      const g = new IcosahedronGeometry(1, 1);
      g.deleteAttribute('uv');
      paint(g, r() < 0.5 ? PAL.cloud : PAL.cloud2, 0.12, r);
      g.applyMatrix4(new Matrix4().makeScale(5 + r() * 5, 1.4 + r() * 1.4, 4 + r() * 4).premultiply(new Matrix4().makeRotationY(r() * 6)).setPosition(Math.sin(a) * rr, (r() - 0.5) * 2.5, Math.cos(a) * rr));
      cl.push(g);
    }
    this.cloudMat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, emissive: new Color(0, 0, 0), transparent: true, opacity: 0.92 });
    this.clouds = new Mesh(mergeGeometries(cl), this.cloudMat);
    this.clouds.position.set(SC.x, this.H + 24, SC.z);
    this.root.add(this.clouds);

    game.scene.add(this.root);
    this.update(0);
  }

  // ------------------------------------------------------------------ frame helpers
  /** local (lx, lz) → world */
  at(lx: number, lz: number) {
    const c = Math.cos(this.gateYaw);
    const s = Math.sin(this.gateYaw);
    return { x: SC.x + lx * c + lz * s, z: SC.z - lx * s + lz * c };
  }

  /** world → local */
  local(x: number, z: number) {
    const c = Math.cos(this.gateYaw);
    const s = Math.sin(this.gateYaw);
    const dx = x - SC.x;
    const dz = z - SC.z;
    return { lx: dx * c - dz * s, lz: dx * s + dz * c };
  }

  private inTile(t: Tile, x: number, z: number, margin = 0) {
    const { lx, lz } = this.local(x, z);
    return Math.abs(lx - t.i * TILE) <= TILE / 2 + margin && Math.abs(lz - t.j * TILE) <= TILE / 2 + margin;
  }

  private solid(geos: BufferGeometry[], lx: number, lz: number, w: number, d: number, bottom: number, top: number, c: Color, r: () => number, tag?: string) {
    this.deco(geos, lx, lz, w, d, bottom, top, c, r);
    const p = this.at(lx, lz);
    this.game.world.addBox(p.x, p.z, w, d, bottom, top, this.gateYaw, tag);
  }

  private deco(geos: BufferGeometry[], lx: number, lz: number, w: number, d: number, bottom: number, top: number, c: Color, r: () => number) {
    const g = new BoxGeometry(w, top - bottom, d).toNonIndexed();
    g.deleteAttribute('uv');
    paint(g, c, 0.06, r);
    const p = this.at(lx, lz);
    g.applyMatrix4(new Matrix4().makeRotationY(this.gateYaw).setPosition(p.x, (top + bottom) / 2, p.z));
    geos.push(g);
  }

  private column(geos: BufferGeometry[], lx: number, lz: number, rad: number, h: number, r: () => number) {
    const p = this.at(lx, lz);
    const g = new CylinderGeometry(rad * 0.9, rad, h + 0.5, 8, 1).toNonIndexed();
    g.deleteAttribute('uv');
    paint(g, PAL.pylon, 0.08, r);
    g.applyMatrix4(new Matrix4().makeRotationY(r() * 3).setPosition(p.x, this.H + (h - 0.5) / 2, p.z));
    geos.push(g);
    this.game.world.addCollider({ x: p.x, z: p.z, r: rad, bottom: this.H - 0.5, top: this.H + h });
  }

  private placeTile(k: number) {
    const t = this.tiles[k];
    const cy = (this.H - 0.6 + this.floor) / 2 + t.y;
    this.o.position.set(t.x, cy, t.z);
    this.o.rotation.set(t.tilt, this.gateYaw, t.tilt * 0.6);
    const hidden = t.state === 'gone';
    this.o.scale.setScalar(hidden ? 0.0001 : 1);
    if (t.state === 'crack') {
      this.o.position.x += (Math.random() - 0.5) * 0.06;
      this.o.position.z += (Math.random() - 0.5) * 0.06;
      this.o.position.y -= Math.random() * 0.03;
    }
    this.o.updateMatrix();
    this.tileMesh.setMatrixAt(k, this.o.matrix);
  }

  // ------------------------------------------------------------------ queries
  /** Ground height of the arena under (x, z) as strikes see it (pylon tops count). */
  surface(x: number, z: number) {
    return this.game.world.groundAt(x, z, this.floor + PERCH_H + 0.2);
  }

  /** A collapsible, solid tile index near (x, z) (seed for a collapse cluster). */
  collapsibleNear(x: number, z: number, maxDist: number, exclude: number[] = []): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.tiles.length; k++) {
      const t = this.tiles[k];
      if (!t.collapsible || t.state !== 'solid' || exclude.includes(k)) continue;
      if (Math.hypot(t.x - x, t.z - z) <= maxDist) out.push(k);
    }
    return out;
  }

  tileIndexAt(x: number, z: number) {
    for (let k = 0; k < this.tiles.length; k++) if (this.inTile(this.tiles[k], x, z)) return k;
    return -1;
  }

  /** Is (x, y, z) down in a pit (fallen tile) or on the electrified lower ring? */
  inHazard(x: number, y: number, z: number) {
    if (y > this.floor - 0.4) return false;
    if (Math.hypot(x - SC.x, z - SC.z) > SC.radius) return false;
    for (const t of this.tiles) {
      if ((t.state === 'gone' || t.state === 'fall' || t.state === 'rise') && this.inTile(t, x, z, -0.1)) return true;
    }
    if (this.edgeCharged) {
      // not on the stairs / any tile footprint → lower ring
      return this.tileIndexAt(x, z) < 0;
    }
    return false;
  }

  get collapsedCount() {
    let n = 0;
    for (const t of this.tiles) if (t.state !== 'solid') n++;
    return n;
  }

  // ------------------------------------------------------------------ collapse
  /** Telegraph (red, shaking) then drop the given tiles after `warn` seconds. */
  crack(indices: number[], warn: number) {
    for (const k of indices) {
      const t = this.tiles[k];
      if (!t || t.state !== 'solid' || !t.collapsible) continue;
      t.state = 'crack';
      t.t = 0;
      t.dur = warn;
      t.decal = this.game.bosses.decals.acquire().tint('unblockable');
      this.tileDecal(t, this.floor);
      t.decal.fill = 0;
    }
    if (indices.length) playSfx('stormTile', { pos: this.v.set(this.tiles[indices[0]].x, this.floor, this.tiles[indices[0]].z), variant: 'crack' });
  }

  private tileDecal(t: Tile, y: number) {
    if (!t.decal) return;
    // rect starts at the tile's -lz edge and runs TILE along +lz
    const yaw = this.gateYaw;
    const sx = t.x - Math.sin(yaw) * (TILE / 2);
    const sz = t.z - Math.cos(yaw) * (TILE / 2);
    t.decal.rect(sx, y, sz, yaw, TILE - 0.1, TILE - 0.1);
  }

  /** Raise every fallen tile again (event over). `instant` for resets. */
  restoreAll(instant = false) {
    for (let k = 0; k < this.tiles.length; k++) {
      const t = this.tiles[k];
      if (t.state === 'solid') continue;
      if (instant) {
        this.finishRise(t);
      } else if (t.state !== 'rise') {
        t.state = 'rise';
        t.t = 0;
        t.dur = 1.4;
        t.tilt = 0;
        t.y = -2.5;
        if (t.decal) {
          t.decal.release(0.3);
          t.decal = null;
        }
      }
    }
    if (instant) for (let k = 0; k < this.tiles.length; k++) this.placeTile(k);
    this.tileMesh.instanceMatrix.needsUpdate = true;
  }

  private finishRise(t: Tile) {
    t.state = 'solid';
    t.y = 0;
    t.vy = 0;
    t.tilt = 0;
    if (t.decal) {
      t.decal.release(0.2);
      t.decal = null;
    }
    if (!t.collider) t.collider = this.game.world.addBox(t.x, t.z, TILE, TILE, this.H - 0.6, this.floor, this.gateYaw, 'storm-tile');
    // lift anyone standing in the pit onto the restored tile
    const p = this.game.player;
    if (this.inTile(t, p.position.x, p.position.z) && p.position.y < this.floor - 0.05 && p.position.y > this.H - 1) {
      p.position.y = this.floor;
      p.velocity.y = Math.max(p.velocity.y, 3);
    }
  }

  /** Highlight a pylon's crystal (thunderfall safe pocket / chain anchors). */
  highlight(pylon: number, v: number) {
    this.crystalHighlight[pylon] = v;
  }

  setEdgeCharged(v: boolean) {
    this.edgeCharged = v;
    if (v && !this.edgeDecal) {
      this.edgeDecal = this.game.bosses.decals.acquire().tint('unblockable').ring(SC.x, this.H, SC.z, SC.radius - 0.3, SC.radius - 13);
      this.edgeDecal.fill = 1;
      this.edgeDecal.alpha = 0.55;
    } else if (!v && this.edgeDecal) {
      this.edgeDecal.release(0.5);
      this.edgeDecal = null;
    }
  }

  flashClouds(k: number) {
    this.cloudFlash = Math.max(this.cloudFlash, k);
  }

  update(dt: number) {
    this.t += dt;
    this.sky.update(dt);
    // tiles
    let dirty = false;
    for (let k = 0; k < this.tiles.length; k++) {
      const t = this.tiles[k];
      if (t.state === 'solid') continue;
      t.t += dt;
      dirty = true;
      if (t.state === 'crack') {
        if (t.decal) t.decal.fill = clamp(t.t / t.dur, 0, 1);
        if (t.t >= t.dur) {
          t.state = 'fall';
          t.t = 0;
          t.vy = 0;
          t.tilt = 0;
          if (t.collider) {
            this.game.world.removeCollider(t.collider);
            t.collider = null;
          }
          if (t.decal) {
            // the decal now marks the pit floor
            this.tileDecal(t, this.H);
            t.decal.fill = 1;
            t.decal.alpha = 0.6;
          }
          this.game.fx.dustPuff(this.v.set(t.x, this.floor, t.z), 18, 3, [0.4, 0.9]);
          playSfx('stormTile', { pos: this.v, variant: 'fall' });
        }
      } else if (t.state === 'fall') {
        t.vy -= 22 * dt;
        t.y += t.vy * dt;
        t.tilt += dt * 0.6;
        if (t.y < -3.5) {
          t.state = 'gone';
          t.t = 0;
        }
      } else if (t.state === 'rise') {
        const u = clamp(t.t / t.dur, 0, 1);
        t.y = -2.5 * (1 - u * u * (3 - 2 * u));
        if (u >= 1) this.finishRise(t);
      } else if (t.state === 'gone' && t.decal) {
        t.decal.flash = 0.15 + 0.15 * Math.sin(this.t * 9 + k);
      }
      this.placeTile(k);
    }
    if (dirty) this.tileMesh.instanceMatrix.needsUpdate = true;

    // crystals: bob + energy glow; highlighted pylons go green-white
    for (let k = 0; k < this.pylons.length; k++) {
      const c = this.pylons[k].crystal;
      this.o.position.set(c.x, c.y + Math.sin(this.t * 1.7 + k) * 0.15, c.z);
      this.o.rotation.set(0, this.t * 0.9 + k, 0);
      const hl = this.crystalHighlight[k];
      this.o.scale.setScalar(1 + hl * 0.35 + 0.05 * Math.sin(this.t * 7 + k));
      this.o.updateMatrix();
      this.crystals.setMatrixAt(k, this.o.matrix);
      const e = 0.6 + this.energy * 1.2 + 0.25 * Math.sin(this.t * 5 + k * 1.3);
      this.crystalColor.setRGB(0.35 * e, 1.1 * e, 1.9 * e).lerp(CRYSTAL_HL, hl);
      this.crystals.setColorAt(k, this.crystalColor);
    }
    this.crystals.instanceMatrix.needsUpdate = true;
    this.crystals.instanceColor!.needsUpdate = true;

    // clouds
    this.clouds.rotation.y = this.t * 0.02;
    this.cloudFlash = Math.max(0, this.cloudFlash - dt * 4);
    this.cloudMat.emissive.setRGB(0.35 * this.cloudFlash, 0.5 * this.cloudFlash, 0.8 * this.cloudFlash);
    (this.glyph.material as MeshBasicMaterial).opacity = 0.1 + this.energy * 0.18 + 0.05 * Math.sin(this.t * 2);
  }

  /** Back to the pristine arena (fight reset / victory). */
  reset() {
    for (const t of this.tiles) {
      if (t.decal) {
        t.decal.release(0.1);
        t.decal = null;
      }
    }
    this.restoreAll(true);
    this.setEdgeCharged(false);
    for (let k = 0; k < this.crystalHighlight.length; k++) this.crystalHighlight[k] = 0;
  }

  dispose() {
    this.reset();
    for (const t of this.tiles) if (t.collider) this.game.world.removeCollider(t.collider);
    this.sky.restore();
    this.game.scene.remove(this.root);
  }
}
