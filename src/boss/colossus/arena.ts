import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../../core/Game';
import { rng } from '../../core/math';
import type { Feature } from '../../features';
import { Regions } from '../../world/Terrain';
import { BossArena } from '../Arena';
import { Colossus } from './Colossus';

/**
 * WEST RUINS — the Bell Colossus's arena (Regions.colossus, radius 24).
 *
 * A broken ring of old walls (1–4.5 m) around an open paved floor, broken columns and two ruined
 * stair towers (tops at 4.2 m and 5.0 m, plus a 6.2 m column) that let the player reach the giant's
 * belt / runes and stand above the cracked bell's arena-wide toll. The fog gate is on the east side
 * facing the spawn. Every solid piece is one box / cylinder used both for the mesh and the collider.
 *
 * Height ladder: rubble 0.8–1.2 · wall stubs 1.2–2.4 (vault / ledge) · walls 3.5–4.5 · stair steps
 * 0.7 apart → 4.2 / 5.0 platforms · columns 2.2–6.2.
 */

const PAL = {
  stone: new Color('#8f887b'),
  stoneDark: new Color('#6d675e'),
  moss: new Color('#7a7c60'),
  pave: new Color('#7e786d'),
  paveDark: new Color('#6c675e'),
};

class RuinBuilder {
  readonly geos: BufferGeometry[] = [];
  readonly obstacles: { x: number; z: number; r: number }[] = [];
  readonly rand = rng(1717);
  constructor(readonly game: Game, readonly H: number) {}

  private paint(g: BufferGeometry, base: Color, vary: number) {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const col = new Float32Array(pos.count * 3);
    const c = new Color();
    for (let t = 0; t < pos.count; t += 3) {
      const k = 1 + (this.rand() - 0.5) * 2 * vary;
      const ny = nrm.getY(t);
      const lift = ny > 0.5 ? 1.06 : ny < -0.5 ? 0.65 : 1;
      for (let i = t; i < t + 3; i++) {
        c.copy(base).multiplyScalar(k * lift);
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
  }

  /** Solid box: world centre (x, z), size, heights relative to the arena floor. Mesh == collider. */
  box(x: number, z: number, w: number, d: number, y0: number, y1: number, yaw: number, pal: Color = PAL.stone, tag = 'ruin') {
    const bottom = y0 <= 0 ? this.H - 0.5 : this.H + y0;
    const top = this.H + y1;
    const segY = Math.max(1, Math.min(8, Math.round((top - bottom) / 0.7)));
    const g = new BoxGeometry(w, top - bottom, d, Math.max(1, Math.round(w / 0.9)), segY, Math.max(1, Math.round(d / 0.9))).toNonIndexed();
    g.deleteAttribute('uv');
    this.paint(g, pal, 0.09);
    g.applyMatrix4(new Matrix4().makeRotationY(yaw).setPosition(x, (top + bottom) / 2, z));
    this.geos.push(g);
    this.game.world.addBox(x, z, w, d, bottom, top, yaw, tag);
  }

  /** Column: cylinder collider radius = visual radius. */
  column(x: number, z: number, r: number, h: number, pal: Color = PAL.stone) {
    const g = new CylinderGeometry(r * 0.92, r, h + 0.5, 9, Math.max(1, Math.round(h / 0.8))).toNonIndexed();
    g.deleteAttribute('uv');
    this.paint(g, pal, 0.07);
    g.applyMatrix4(new Matrix4().makeRotationY(this.rand() * 3).setPosition(x, this.H + h / 2 - 0.25, z));
    this.geos.push(g);
    // capital block (decorative lip, inside the collider radius)
    this.game.world.addCollider({ x, z, r, bottom: this.H - 0.5, top: this.H + h, tag: 'ruin-column' });
    this.obstacles.push({ x, z, r });
  }

  /** Paved floor: polar flagstones, a hair above the flattened terrain. */
  floor(cx: number, cz: number, radius: number) {
    const verts: number[] = [];
    const cols: number[] = [];
    const rings = 9;
    const c = new Color();
    for (let i = 0; i < rings; i++) {
      const r0 = (radius * i) / rings;
      const r1 = (radius * (i + 1)) / rings;
      const n = Math.max(8, Math.round((Math.PI * 2 * r1) / 2.2));
      const off = this.rand() * 0.5;
      for (let k = 0; k < n; k++) {
        if (this.rand() < 0.07 + i * 0.012) continue; // missing flags show the earth
        const a0 = ((k + off) / n) * Math.PI * 2;
        const a1 = ((k + 1 + off) / n) * Math.PI * 2;
        const pts = [[r0, a0], [r1, a0], [r1, a1], [r0, a1]].map(([r, a]) => [cx + Math.sin(a) * r, cz + Math.cos(a) * r]);
        const ys = pts.map(([x, z]) => this.game.world.terrain.heightAt(x, z) + 0.03);
        c.copy(this.rand() < 0.5 ? PAL.pave : PAL.paveDark).multiplyScalar(0.92 + this.rand() * 0.16);
        for (const t of [0, 1, 2, 0, 2, 3]) {
          verts.push(pts[t][0], ys[t], pts[t][1]);
          cols.push(c.r, c.g, c.b);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(cols), 3));
    g.computeVertexNormals();
    // make the floor face up regardless of winding
    const nrm = g.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const mesh = new Mesh(g, new MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: 2,
    }));
    mesh.receiveShadow = true;
    mesh.name = 'colossus-floor';
    return mesh;
  }
}

function buildRuins(game: Game) {
  const R = Regions.colossus;
  const H = game.world.terrain.heightAt(R.x, R.z);
  const b = new RuinBuilder(game, H);
  const gate = Math.atan2(-R.x, -R.z); // toward the world centre (east-ish): the fog gate
  const P = (a: number, r: number) => ({ x: R.x + Math.sin(a) * r, z: R.z + Math.cos(a) * r });
  const D = Math.PI / 180;

  // ---- broken outer ring of walls (gap of ±26° at the gate)
  const segs = 22;
  for (let i = 0; i < segs; i++) {
    const a = gate + ((i + 0.5) / segs) * Math.PI * 2;
    const rel = Math.abs(((a - gate + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
    if (rel < 26 * D) continue;
    if (b.rand() < 0.18) continue; // collapsed gap
    const p = P(a, 22.4);
    const tall = b.rand();
    const h = tall < 0.35 ? 1.2 + b.rand() * 1.2 : tall < 0.8 ? 2.4 + b.rand() * 1.2 : 3.6 + b.rand() * 0.9;
    const w = 4.2 + b.rand() * 1.4;
    b.box(p.x, p.z, w, 1.2, 0, h, a + Math.PI / 2, tall > 0.8 ? PAL.stoneDark : PAL.stone, 'wall');
    // stepped broken top
    if (h > 2.2 && b.rand() < 0.6) {
      const q = P(a + 0.04, 22.4);
      b.box(q.x, q.z, w * 0.4, 1.2, h, h + 0.7, a + Math.PI / 2, PAL.moss, 'wall');
    }
    // fallen block inside the wall
    if (b.rand() < 0.4) {
      const q = P(a + (b.rand() - 0.5) * 0.12, 20.6);
      b.box(q.x, q.z, 1.2 + b.rand() * 0.6, 1.0, 0, 0.8 + b.rand() * 0.4, b.rand() * 3, PAL.stoneDark, 'rubble');
    }
  }
  // gate posts
  for (const s of [-1, 1]) {
    const p = P(gate + s * 9 * D, 22.6);
    b.box(p.x, p.z, 1.6, 1.6, 0, 5.2, gate, PAL.stoneDark, 'wall');
  }

  // ---- stair tower A (north side of the gate axis): steps up to a 4.2 m platform
  const towerA = gate + 95 * D;
  const towerB = gate - 100 * D;
  const stair = (a: number, side: number, topH: number, steps: number) => {
    const base = P(a, 17.5);
    const tx = Math.cos(a) * side; // tangent direction (along the ring)
    const tz = -Math.sin(a) * side;
    const step = topH / (steps + 1);
    for (let k = 0; k < steps; k++) {
      const x = base.x + tx * (k * 1.1 - steps * 1.1);
      const z = base.z + tz * (k * 1.1 - steps * 1.1);
      b.box(x, z, 1.1, 2.2, 0, step * (k + 1), a, PAL.stone, 'stair');
    }
    b.box(base.x + tx * 0.6, base.z + tz * 0.6, 2.8, 2.8, 0, topH, a, PAL.stoneDark, 'tower');
    b.obstacles.push({ x: base.x, z: base.z, r: 2.2 });
    return base;
  };
  stair(towerA, 1, 4.2, 5);
  const bTop = stair(towerB, -1, 5.0, 6);
  // a tall broken column beside tower B (6.2 m): the highest point in the ruin
  {
    const p = P(towerB - 9 * D, 15.2);
    b.column(p.x, p.z, 0.95, 6.2, PAL.moss);
  }
  void bTop;

  // ---- inner broken columns (well clear of the centre)
  const cols: [number, number, number][] = [
    [gate + 40 * D, 15.5, 3.2], [gate + 150 * D, 15.0, 4.6], [gate + 180 * D, 16.0, 2.2],
    [gate + 215 * D, 15.0, 4.0], [gate - 40 * D, 15.5, 2.8],
  ];
  for (const [a, r, h] of cols) {
    const p = P(a, r);
    b.column(p.x, p.z, 0.85, h);
    if (h > 3) {
      // fallen drum next to it
      const q = P(a + 0.08, r - 1.6);
      b.box(q.x, q.z, 1.5, 1.1, 0, 0.9, a + 0.7, PAL.stoneDark, 'rubble');
    }
  }
  // low cover blocks at mid radius
  for (const [a, r] of [[gate + 70 * D, 11], [gate + 250 * D, 12], [gate - 65 * D, 11.5], [gate + 125 * D, 12.5]] as const) {
    const p = P(a, r);
    b.box(p.x, p.z, 2.0, 1.2, 0, 1.0, a, PAL.stone, 'rubble');
  }

  const mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.94, metalness: 0 });
  const mesh = new Mesh(mergeGeometries(b.geos), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'colossus-ruins';
  game.scene.add(mesh);
  game.scene.add(b.floor(R.x, R.z, 21));
  return { obstacles: b.obstacles, gate };
}

/** The West Ruins + the Bell Colossus (Travel menu: "West Ruins"). */
export const colossusFeature: Feature = {
  name: 'boss-colossus',
  install(game) {
    const r = Regions.colossus;
    const { obstacles } = buildRuins(game);
    const arena = new BossArena(game, { id: 'colossus', name: 'West Ruins', region: r, gateWidth: 6 });
    const boss = new Colossus(game);
    boss.obstacles = obstacles;
    boss.placeAt(r.x - 1.5, r.z, Math.atan2(arena.entry.x - r.x, arena.entry.z - r.z));
    game.bosses.add(boss);
    arena.addBoss(boss);
    (game as unknown as { colossus?: Colossus }).colossus = boss;
  },
};
