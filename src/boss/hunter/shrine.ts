import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../../core/Game';
import { rng } from '../../core/math';
import type { Region } from '../Arena';

/**
 * The Hunter's arena: a moonlit shrine clearing (south-east). An octagonal wooden duel deck (~22 m)
 * inside a gravel ring, a vermilion torii as the fog-gate entrance (north-west, toward the spawn),
 * stone lanterns and rocks on the rim, a small shrine hall and trees (sakura / pine) outside the
 * fight circle, and falling petals. No cover in the middle — it's a duel.
 *
 * All static pieces are merged into one flat-shaded vertex-coloured mesh (+ one glow mesh); every
 * solid prop registers the matching collider (posts / lanterns / rocks / trunks / shrine hall).
 */
const PAL = {
  wood: '#6e4b31',
  woodDark: '#4a3122',
  plank: '#7d5838',
  stone: '#8a857c',
  stoneDark: '#615d58',
  gravel: '#9c968a',
  vermilion: '#b43a26',
  black: '#1e1a1a',
  roof: '#3b3634',
  paper: '#efe1c0',
  trunk: '#4b3527',
  sakura: '#e2a2b6',
  sakura2: '#cf8aa3',
  pine: '#3c5a3e',
  pine2: '#2f4a33',
  rope: '#d8c79a',
} as const;
type Pal = keyof typeof PAL;

const GLOW = new Color(2.4, 1.35, 0.6);

class Builder {
  readonly geos: BufferGeometry[] = [];
  readonly glow: BufferGeometry[] = [];
  readonly rand = rng(6060);
  private readonly c = new Color();

  constructor(readonly game: Game) {}

  ground(x: number, z: number) {
    return this.game.world.groundAt(x, z);
  }

  private paint(g: BufferGeometry, pal: Pal | Color, vary: number) {
    const base = pal instanceof Color ? pal : new Color(PAL[pal]);
    const pos = g.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (let t = 0; t < pos.count; t += 3) {
      this.c.copy(base).multiplyScalar(1 + (this.rand() - 0.5) * 2 * vary);
      for (let v = t; v < t + 3 && v < pos.count; v++) {
        col[v * 3] = this.c.r;
        col[v * 3 + 1] = this.c.g;
        col[v * 3 + 2] = this.c.b;
      }
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
  }

  add(geo: BufferGeometry, pal: Pal | Color, m: Matrix4, vary = 0.05, glow = false) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    this.paint(g, pal, vary);
    g.applyMatrix4(m);
    (glow ? this.glow : this.geos).push(g);
  }

  /** box centred at (x, y, z) with yaw */
  box(x: number, y: number, z: number, w: number, h: number, d: number, yaw: number, pal: Pal | Color, vary = 0.05, glow = false) {
    this.add(new BoxGeometry(w, h, d), pal, new Matrix4().makeRotationY(yaw).setPosition(x, y, z), vary, glow);
  }

  cyl(x: number, y0: number, z: number, rTop: number, rBot: number, h: number, pal: Pal, sides = 8, vary = 0.05) {
    this.add(new CylinderGeometry(rTop, rBot, h, sides, 1), pal, new Matrix4().makeRotationY(this.rand() * 3).setPosition(x, y0 + h / 2, z), vary);
  }

  collideCyl(x: number, z: number, r: number, bottom: number, top: number) {
    this.game.world.addCollider({ x, z, r, bottom, top, tag: 'hunter-shrine' });
  }
}

/** world point at polar (angle in the facing convention, radius) around the region centre */
function polar(r: Region, a: number, d: number) {
  return { x: r.x + Math.sin(a) * d, z: r.z + Math.cos(a) * d };
}

export interface ShrineHandle {
  update(dt: number): void;
}

export function buildShrine(game: Game, region: Region, gateDir: number): ShrineHandle {
  const b = new Builder(game);
  const H = b.ground(region.x, region.z);

  // ------------------------------------------------ floor: gravel ring, stone kerb, wooden deck
  b.add(new CylinderGeometry(region.radius + 0.4, region.radius + 0.4, 0.04, 32, 1), 'gravel',
    new Matrix4().setPosition(region.x, H + 0.0, region.z), 0.06);
  b.add(new CylinderGeometry(11.9, 12.1, 0.1, 8, 1), 'stone',
    new Matrix4().makeRotationY(Math.PI / 8 + gateDir).setPosition(region.x, H + 0.01, region.z), 0.07);
  // deck: an octagon of planks running across the duel line
  const deck = new CylinderGeometry(11.3, 11.3, 0.1, 8, 1).toNonIndexed();
  b.add(deck, 'plank', new Matrix4().makeRotationY(Math.PI / 8 + gateDir).setPosition(region.x, H + 0.03, region.z), 0.03);
  for (let i = -10; i <= 10; i += 1.25) {
    // plank seams (thin dark strips just above the deck), clipped to the octagon's inscribed width
    const half = Math.sqrt(Math.max(0, 10.4 * 10.4 - i * i));
    if (half < 1) continue;
    const cx = region.x + Math.cos(gateDir) * i;
    const cz = region.z - Math.sin(gateDir) * i;
    b.box(cx, H + 0.085, cz, 0.05, 0.012, half * 2, gateDir, 'woodDark', 0.02);
  }
  // a painted ring where duellists stand
  b.add(new CylinderGeometry(3.2, 3.2, 0.012, 24, 1, true), 'vermilion', new Matrix4().setPosition(region.x, H + 0.09, region.z), 0);

  // ------------------------------------------------ torii (the fog gate stands inside it)
  {
    const g = polar(region, gateDir, region.radius + 0.1);
    const yaw = gateDir;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const gy = b.ground(g.x, g.z);
    for (const s of [-1, 1]) {
      const px = g.x + rx * 3.15 * s;
      const pz = g.z + rz * 3.15 * s;
      b.cyl(px, gy - 0.3, pz, 0.24, 0.28, 5.4, 'vermilion', 10, 0.03);
      b.cyl(px, gy - 0.3, pz, 0.34, 0.34, 0.75, 'black', 10, 0.02);
      b.collideCyl(px, pz, 0.32, gy - 1, gy + 5.1);
    }
    b.box(g.x, gy + 4.05, g.z, 7.4, 0.26, 0.22, yaw, 'vermilion', 0.02); // nuki
    b.box(g.x, gy + 4.55, g.z, 0.3, 0.75, 0.2, yaw, 'vermilion', 0.02); // gakuzuka
    b.box(g.x, gy + 4.55, g.z, 1.0, 0.55, 0.06, yaw, 'black', 0.02); // name plaque
    b.box(g.x, gy + 5.02, g.z, 8.2, 0.3, 0.36, yaw, 'vermilion', 0.02); // shimaki
    // kasagi with upturned ends: centre + two tilted tips
    b.box(g.x, gy + 5.32, g.z, 7.0, 0.32, 0.5, yaw, 'black', 0.02);
    for (const s of [-1, 1]) {
      const m = new Matrix4().makeRotationY(yaw).multiply(new Matrix4().makeRotationZ(0.12 * s));
      m.setPosition(g.x + rx * 4.0 * s, gy + 5.42, g.z + rz * 4.0 * s);
      b.add(new BoxGeometry(1.8, 0.32, 0.52), 'black', m, 0.02);
    }
    // shimenawa rope sagging between the posts + paper streamers
    for (let i = 0; i <= 10; i++) {
      const u = i / 10 - 0.5;
      const sag = 0.35 * (1 - (2 * u) ** 2);
      b.add(new SphereGeometry(0.11, 5, 4), 'rope', new Matrix4().setPosition(g.x + rx * u * 6.0, gy + 3.75 - sag, g.z + rz * u * 6.0), 0.04);
    }
    for (const u of [-0.25, 0, 0.25]) {
      b.box(g.x + rx * u * 6, gy + 3.2, g.z + rz * u * 6, 0.16, 0.6, 0.02, yaw, 'paper', 0.02);
    }
  }

  // ------------------------------------------------ stone lanterns (tōrō) on the rim
  const lanternAngles: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = gateDir + Math.PI / 8 + (i * Math.PI * 2) / 8;
    lanternAngles.push(a);
  }
  for (const a of lanternAngles) {
    const p = polar(region, a, 13.4);
    const gy = b.ground(p.x, p.z);
    b.box(p.x, gy + 0.12, p.z, 0.8, 0.3, 0.8, a, 'stoneDark', 0.06);
    b.cyl(p.x, gy + 0.25, p.z, 0.14, 0.18, 0.75, 'stone', 6);
    b.box(p.x, gy + 1.05, p.z, 0.66, 0.12, 0.66, a, 'stone', 0.06);
    b.box(p.x, gy + 1.33, p.z, 0.5, 0.44, 0.5, a, 'stone', 0.06);
    b.box(p.x, gy + 1.33, p.z, 0.54, 0.3, 0.3, a, GLOW, 0, true);
    b.box(p.x, gy + 1.33, p.z, 0.3, 0.3, 0.54, a, GLOW, 0, true);
    b.add(new CylinderGeometry(0.06, 0.62, 0.32, 6, 1), 'stoneDark', new Matrix4().makeRotationY(a).setPosition(p.x, gy + 1.71, p.z), 0.05);
    b.add(new SphereGeometry(0.1, 5, 4), 'stone', new Matrix4().setPosition(p.x, gy + 1.92, p.z), 0.05);
    b.collideCyl(p.x, p.z, 0.42, gy - 0.5, gy + 1.95);
  }

  // ------------------------------------------------ rocks on the rim (between lanterns)
  for (let i = 0; i < 8; i++) {
    const a = gateDir + (i * Math.PI * 2) / 8 + (b.rand() - 0.5) * 0.25;
    if (Math.abs(Math.atan2(Math.sin(a - gateDir), Math.cos(a - gateDir))) < 0.45) continue; // keep the gate clear
    const d = 14.9 + b.rand() * 0.8;
    const p = polar(region, a, d);
    const gy = b.ground(p.x, p.z);
    const s = 0.55 + b.rand() * 0.45;
    const g = new DodecahedronGeometry(1, 0);
    const pos = g.getAttribute('position');
    for (let k = 0; k < pos.count; k++) pos.setXYZ(k, pos.getX(k) * (0.8 + b.rand() * 0.4), pos.getY(k) * (0.8 + b.rand() * 0.4), pos.getZ(k) * (0.8 + b.rand() * 0.4));
    const m = new Matrix4().makeRotationY(b.rand() * 6).scale(new Vector3(s * 1.2, s * 0.8, s)).setPosition(p.x, gy + s * 0.35, p.z);
    b.add(g, b.rand() < 0.5 ? 'stone' : 'stoneDark', m, 0.1);
    b.collideCyl(p.x, p.z, s * 1.0, gy - 0.5, gy + s * 1.05);
  }

  // ------------------------------------------------ small shrine hall behind the far rim
  {
    const a = gateDir + Math.PI;
    const p = polar(region, a, region.radius + 3.6);
    const gy = b.ground(p.x, p.z);
    const yaw = a;
    b.box(p.x, gy + 0.3, p.z, 5.2, 0.9, 4.0, yaw, 'stoneDark', 0.06);
    b.box(p.x, gy + 1.85, p.z, 4.0, 2.2, 2.9, yaw, 'wood', 0.05);
    // pillars at the front
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    for (const s of [-1, 1]) {
      b.cyl(p.x + fx * 1.7 + rx * 1.9 * s, gy + 0.75, p.z + fz * 1.7 + rz * 1.9 * s, 0.13, 0.13, 2.3, 'vermilion', 8);
    }
    b.box(p.x + fx * 1.48, gy + 1.7, p.z + fz * 1.48, 1.4, 1.5, 0.06, yaw, GLOW, 0, true); // lit doorway
    for (const s of [-1, 1]) {
      const m = new Matrix4().makeRotationY(yaw).multiply(new Matrix4().makeRotationX(0.55 * s));
      m.setPosition(p.x + Math.sin(yaw) * 1.05 * s, gy + 3.35, p.z + Math.cos(yaw) * 1.05 * s);
      b.add(new BoxGeometry(5.0, 0.18, 2.75), 'roof', m, 0.05);
    }
    b.box(p.x, gy + 3.95, p.z, 5.0, 0.16, 0.24, yaw, 'black', 0.02);
    game.world.addBox(p.x, p.z, 5.2, 4.0, gy - 1, gy + 3.0, yaw, 'hunter-shrine');
  }

  // ------------------------------------------------ trees outside the fight circle
  for (let i = 0; i < 11; i++) {
    const a = gateDir + 0.55 + (i / 11) * (Math.PI * 2 - 1.1) + (b.rand() - 0.5) * 0.2;
    if (Math.abs(Math.atan2(Math.sin(a - gateDir - Math.PI), Math.cos(a - gateDir - Math.PI))) < 0.32) continue; // shrine hall
    const d = region.radius + 2.5 + b.rand() * 4;
    const p = polar(region, a, d);
    const gy = b.ground(p.x, p.z);
    const sakura = b.rand() < 0.55;
    const h = 2.6 + b.rand() * 1.4;
    b.cyl(p.x, gy - 0.3, p.z, 0.16, 0.26, h + 0.3, 'trunk', 7);
    b.collideCyl(p.x, p.z, 0.3, gy - 0.5, gy + h);
    const blobs = sakura ? 4 : 3;
    for (let k = 0; k < blobs; k++) {
      const s = sakura ? 1.2 + b.rand() * 0.6 : 1.0 + b.rand() * 0.4;
      const ox = (b.rand() - 0.5) * 1.8;
      const oz = (b.rand() - 0.5) * 1.8;
      const y = sakura ? gy + h + 0.2 + b.rand() * 0.8 : gy + h - 0.3 + k * 1.1;
      const g = sakura ? new DodecahedronGeometry(s, 0) : new CylinderGeometry(0, s * (1.4 - k * 0.3), 1.8, 7, 1);
      const m = new Matrix4().makeRotationY(b.rand() * 6).setPosition(p.x + (sakura ? ox : 0), y, p.z + (sakura ? oz : 0));
      b.add(g, sakura ? (b.rand() < 0.5 ? 'sakura' : 'sakura2') : (b.rand() < 0.5 ? 'pine' : 'pine2'), m, 0.08);
    }
  }

  // ------------------------------------------------ meshes
  const mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
  const mesh = new Mesh(mergeGeometries(b.geos), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'hunter-shrine';
  game.scene.add(mesh);
  const glow = new Mesh(mergeGeometries(b.glow), new MeshBasicMaterial({ vertexColors: true }));
  game.scene.add(glow);

  // ------------------------------------------------ falling petals (one Points draw call)
  const N = 150;
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 2);
  const R = region.radius + 4;
  const rand = rng(77);
  const seed = (i: number, top: boolean) => {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * R;
    pos[i * 3] = region.x + Math.sin(a) * d;
    pos[i * 3 + 1] = H + (top ? 7 + rand() * 2 : rand() * 9);
    pos[i * 3 + 2] = region.z + Math.cos(a) * d;
    vel[i * 2] = 0.35 + rand() * 0.45;
    vel[i * 2 + 1] = rand() * 6.28;
  };
  for (let i = 0; i < N; i++) seed(i, false);
  const pg = new BufferGeometry();
  pg.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const petals = new Points(pg, new PointsMaterial({ color: new Color('#f3b8c8'), size: 0.11, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false }));
  petals.frustumCulled = false;
  game.scene.add(petals);
  let t = 0;

  return {
    update(dt: number) {
      const p = game.player.position;
      const near = Math.hypot(p.x - region.x, p.z - region.z) < 60;
      petals.visible = near;
      if (!near) return;
      t += dt;
      for (let i = 0; i < N; i++) {
        const ph = vel[i * 2 + 1];
        pos[i * 3] += (Math.sin(t * 1.3 + ph) * 0.45 + 0.25) * dt;
        pos[i * 3 + 1] -= vel[i * 2] * dt;
        pos[i * 3 + 2] += Math.cos(t * 0.9 + ph * 1.7) * 0.35 * dt;
        if (pos[i * 3 + 1] < H + 0.05) seed(i, true);
      }
      (pg.getAttribute('position') as Float32BufferAttribute).needsUpdate = true;
    },
  };
}
