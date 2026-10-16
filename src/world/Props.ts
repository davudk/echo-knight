import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  BoxGeometry,
} from 'three';
import { rng } from '../core/math';
import type { World } from './World';

const stoneMat = new MeshStandardMaterial({ color: '#8a8378', roughness: 0.9, flatShading: true });
const stoneDarkMat = new MeshStandardMaterial({ color: '#6c665e', roughness: 0.95, flatShading: true });
const barkMat = new MeshStandardMaterial({ color: '#4a3526', roughness: 1, flatShading: true });
const leafMat = new MeshStandardMaterial({ color: '#3f5a32', roughness: 0.9, flatShading: true });
const leafMat2 = new MeshStandardMaterial({ color: '#56693a', roughness: 0.9, flatShading: true });

function shadow<T extends Object3D>(o: T, cast = true, receive = true): T {
  o.traverse((c) => {
    if ((c as Mesh).isMesh) {
      c.castShadow = cast;
      c.receiveShadow = receive;
    }
  });
  return o;
}

function jitterGeometry(geo: BufferGeometry, amount: number, rand: () => number) {
  // Displace shared positions consistently so the faceted mesh stays closed.
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

/** Populates the world with ruins (climbable), rocks, trees and grass. */
export function buildProps(world: World, seed = 7) {
  const rand = rng(seed);
  const { scene, terrain } = world;
  const root = new Group();
  root.name = 'props';
  scene.add(root);

  // --- Ruined ring of pillars around the arena: standable, different heights ----------
  const ringR = 13;
  const pillarCount = 10;
  for (let i = 0; i < pillarCount; i++) {
    if (i === 7) continue; // gap = entrance
    const a = (i / pillarCount) * Math.PI * 2 + 0.2;
    const x = Math.cos(a) * ringR;
    const z = Math.sin(a) * ringR;
    const h = [1.2, 2.0, 3.0, 4.2, 1.6, 2.6, 5.2, 0, 3.6, 2.2][i];
    addPillar(root, world, x, z, h, 0.85, rand);
  }

  // Stepping stones up to a high ledge (practice jumping / dashing / echo)
  const steps: [number, number, number, number][] = [
    [-5, -20, 0.9, 1.3],
    [-8, -23.5, 1.8, 1.2],
    [-12.5, -25, 2.8, 1.2],
    [-17.5, -24, 3.8, 1.1],
    [-22, -20.5, 4.6, 2.2],
  ];
  for (const [x, z, top, r] of steps) addBlock(root, world, x, z, top, r, rand);

  // A broken arch
  {
    const x = 0;
    const z = 22;
    const g = terrain.heightAt(x, z);
    addPillar(root, world, x - 3, z, 5.5, 0.7, rand);
    addPillar(root, world, x + 3, z, 5.5, 0.7, rand);
    const lintel = shadow(new Mesh(new BoxGeometry(8, 0.9, 1.4), stoneMat));
    lintel.position.set(x + 0.4, g + 5.9, z);
    lintel.rotation.z = 0.06;
    root.add(lintel);
    world.colliders.push({ x: x - 1.5, z, r: 0.9, bottom: g + 5.4, top: g + 6.35 });
    world.colliders.push({ x: x + 2.2, z, r: 0.9, bottom: g + 5.4, top: g + 6.35 });
  }

  // --- Rocks ----------------------------------------------------------------
  for (let i = 0; i < 70; i++) {
    const a = rand() * Math.PI * 2;
    const d = 18 + rand() * (world.bounds - 20);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const s = 0.5 + Math.pow(rand(), 2.5) * 3.2;
    const geo = jitterGeometry(new DodecahedronGeometry(1, 0), 0.35, rand);
    const rock = shadow(new Mesh(geo, rand() > 0.5 ? stoneMat : stoneDarkMat));
    rock.scale.set(s * (0.8 + rand() * 0.6), s * (0.5 + rand() * 0.5), s * (0.8 + rand() * 0.6));
    rock.rotation.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
    const y = terrain.heightAt(x, z);
    rock.position.set(x, y + rock.scale.y * 0.35, z);
    root.add(rock);
    if (s > 0.9) {
      world.colliders.push({ x, z, r: Math.max(rock.scale.x, rock.scale.z) * 0.8, bottom: y - 1, top: y + rock.scale.y * 1.1 });
    }
  }

  // --- Trees ----------------------------------------------------------------
  for (let i = 0; i < 90; i++) {
    const a = rand() * Math.PI * 2;
    const d = 26 + rand() * (world.bounds - 28);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const y = terrain.heightAt(x, z);
    if (terrain.normalAt(x, z).y < 0.85) continue;
    const tree = makeTree(rand);
    tree.position.set(x, y, z);
    tree.rotation.y = rand() * Math.PI * 2;
    tree.scale.setScalar(0.8 + rand() * 0.8);
    root.add(tree);
    world.colliders.push({ x, z, r: 0.35 * tree.scale.x, bottom: y - 1, top: Infinity });
  }

  // --- Grass tufts (instanced) --------------------------------------------------
  addGrass(root, world, rand);
}

function addPillar(root: Group, world: World, x: number, z: number, height: number, r: number, rand: () => number) {
  const g = world.terrain.heightAt(x, z);
  const pillar = new Group();
  const shaft = new Mesh(jitterGeometry(new CylinderGeometry(r * 0.85, r, height + 0.6, 8, 3), 0.08, rand), stoneMat);
  shaft.position.y = (height + 0.6) / 2 - 0.6;
  const cap = new Mesh(new BoxGeometry(r * 2.3, 0.35, r * 2.3), stoneDarkMat);
  cap.position.y = height - 0.17;
  cap.rotation.y = rand();
  pillar.add(shaft, cap);
  pillar.position.set(x, g, z);
  root.add(shadow(pillar));
  world.colliders.push({ x, z, r: r * 1.05, bottom: g - 1, top: g + height });
  // rubble at the base
  for (let k = 0; k < 3; k++) {
    const rub = shadow(new Mesh(jitterGeometry(new DodecahedronGeometry(0.3 + rand() * 0.3, 0), 0.1, rand), stoneDarkMat));
    const a = rand() * Math.PI * 2;
    const rx = x + Math.cos(a) * (r + 0.6);
    const rz = z + Math.sin(a) * (r + 0.6);
    rub.position.set(rx, world.terrain.heightAt(rx, rz) + 0.1, rz);
    root.add(rub);
  }
}

function addBlock(root: Group, world: World, x: number, z: number, top: number, r: number, rand: () => number) {
  const g = world.terrain.heightAt(x, z);
  const h = top + 1;
  const block = shadow(new Mesh(jitterGeometry(new CylinderGeometry(r, r * 1.1, h, 7, 1), 0.06, rand), stoneMat));
  block.position.set(x, g + top - h / 2, z);
  block.rotation.y = rand() * 3;
  root.add(block);
  world.colliders.push({ x, z, r, bottom: g - 1, top: g + top });
}

function makeTree(rand: () => number) {
  const t = new Group();
  const h = 2.2 + rand() * 1.2;
  const trunk = new Mesh(new CylinderGeometry(0.16, 0.26, h, 6), barkMat);
  trunk.position.y = h / 2;
  t.add(trunk);
  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const s = 1.7 - i * 0.42;
    const cone = new Mesh(new ConeGeometry(s, 1.9, 7), i % 2 ? leafMat2 : leafMat);
    cone.position.y = h * 0.65 + i * 1.05;
    cone.rotation.y = rand() * 3;
    t.add(cone);
  }
  return shadow(t);
}

function addGrass(root: Group, world: World, rand: () => number) {
  const blade = new ConeGeometry(0.05, 0.5, 3, 1);
  blade.translate(0, 0.25, 0);
  const tuftGeo = mergeBlades(blade, rand);
  const mat = new MeshStandardMaterial({ color: '#7d9548', roughness: 1, flatShading: true });
  const count = 4500;
  const mesh = new InstancedMesh(tuftGeo, mat, count);
  mesh.receiveShadow = true;
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const up = new Vector3(0, 1, 0);
  const color = new Color();
  let placed = 0;
  for (let i = 0; i < count * 3 && placed < count; i++) {
    const x = (rand() * 2 - 1) * world.bounds;
    const z = (rand() * 2 - 1) * world.bounds;
    if (Math.hypot(x, z) < 11) continue;
    const n = world.terrain.normalAt(x, z);
    if (n.y < 0.9) continue;
    p.set(x, world.terrain.heightAt(x, z) - 0.02, z);
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    s.setScalar(0.6 + rand() * 0.9);
    m.compose(p, q, s);
    mesh.setMatrixAt(placed, m);
    color.setHSL(0.2 + rand() * 0.06, 0.35 + rand() * 0.15, 0.32 + rand() * 0.12);
    mesh.setColorAt(placed, color);
    placed++;
  }
  mesh.count = placed;
  root.add(mesh);
}

function mergeBlades(blade: ConeGeometry, rand: () => number) {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const g = blade.clone();
    g.rotateZ((rand() - 0.5) * 0.7);
    g.rotateY(rand() * Math.PI * 2);
    g.translate((rand() - 0.5) * 0.25, 0, (rand() - 0.5) * 0.25);
    parts.push(g.toNonIndexed());
  }
  const total = parts.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    const a = g.getAttribute('position').array as Float32Array;
    pos.set(a, o);
    o += a.length;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}
