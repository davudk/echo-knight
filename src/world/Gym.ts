import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PointLight,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import type { Feature } from '../features';
import { HUD } from '../ui/HUD';
import { Regions } from './Terrain';
import type { BoxCollider, World } from './World';

/**
 * Parkour gym (east, Regions.gym). A serpentine course with one station per movement upgrade:
 *
 *   lane 1 (z +9, eastward):  start gate → slide bar → raised runway → long-jump gap → platform
 *   lane 2 (z  0, westward):  platform → wall-run wall beside an 11 m gap → platform
 *   lane 3 (z -11, eastward): ledge stairs (+1.4 / +2.6 / +3.2) → tower (13.6 m) with a chimney
 *                             wall beside it for wall-kick climbing → finish marker on the tower top
 *
 * Every mesh is a box exactly matching its collider. Walls you can run on are tagged 'wall'.
 * A timer starts when you cross the start line and stops on the tower top (best time persisted).
 */
const C = Regions.gym;

const mats = {
  stone: new MeshStandardMaterial({ color: '#948c80', roughness: 0.9, flatShading: true }),
  stoneDark: new MeshStandardMaterial({ color: '#6f685f', roughness: 0.95, flatShading: true }),
  wall: new MeshStandardMaterial({ color: '#a39a8b', roughness: 0.92, flatShading: true }),
  timber: new MeshStandardMaterial({ color: '#6b4a2f', roughness: 1, flatShading: true }),
  timberDark: new MeshStandardMaterial({ color: '#4d3522', roughness: 1, flatShading: true }),
  cloth: (c: string) => new MeshStandardMaterial({ color: c, roughness: 0.8, flatShading: true }),
  glow: new MeshStandardMaterial({ color: '#7fdfff', emissive: new Color(0.35, 1.2, 1.8), emissiveIntensity: 1.0, roughness: 0.3 }),
  line: new MeshStandardMaterial({ color: '#cfe9ff', emissive: new Color(0.3, 0.8, 1.3), emissiveIntensity: 1.2 }),
};

interface Course {
  ground: number;
  start: { x: number; zMin: number; zMax: number };
  finish: BoxCollider;
  marker: Group;
}

function shadowed(m: Mesh) {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Box mesh + identical collider. Local coords relative to the gym centre; `top` relative to the gym floor. */
function block(
  root: Group, world: World, ground: number,
  dx: number, dz: number, w: number, d: number, top: number,
  mat: Material, opts: { bottom?: number; tag?: string } = {},
) {
  const bottom = ground + (opts.bottom ?? -0.6);
  const t = ground + top;
  const mesh = shadowed(new Mesh(new BoxGeometry(w, t - bottom, d), mat));
  mesh.position.set(C.x + dx, (t + bottom) / 2, C.z + dz);
  root.add(mesh);
  return world.addBox(C.x + dx, C.z + dz, w, d, bottom, t, 0, opts.tag);
}

/** Decorative banner on a timber pole (thin cylinder collider for the pole). */
function banner(root: Group, world: World, ground: number, dx: number, dz: number, color: string, h = 3.2) {
  const g = new Group();
  const pole = shadowed(new Mesh(new CylinderGeometry(0.07, 0.09, h, 6), mats.timberDark));
  pole.position.y = h / 2;
  const cloth = shadowed(new Mesh(new BoxGeometry(0.05, 0.9, 0.6), mats.cloth(color)));
  cloth.position.set(0, h - 0.6, 0.33);
  g.add(pole, cloth);
  g.position.set(C.x + dx, ground, C.z + dz);
  root.add(g);
  world.addCollider({ x: C.x + dx, z: C.z + dz, r: 0.12, bottom: ground - 0.5, top: Infinity });
}

function buildCourse(world: World): Course {
  const root = new Group();
  root.name = 'gym';
  world.scene.add(root);
  const g = world.terrain.heightAt(C.x, C.z);
  const B = (dx: number, dz: number, w: number, d: number, top: number, mat: Material, o?: { bottom?: number; tag?: string }) =>
    block(root, world, g, dx, dz, w, d, top, mat, o);

  // --------------------------------------------------------------- lane 1 (z = +9), eastward
  // Start slab + gate
  B(-19.5, 9, 4, 6, 0.15, mats.stoneDark);
  const line = new Mesh(new BoxGeometry(0.25, 0.02, 6), mats.line);
  line.position.set(C.x - 17.6, g + 0.16, C.z + 9);
  root.add(line);
  B(-17.3, 5.7, 0.5, 0.5, 3.6, mats.timber);
  B(-17.3, 12.3, 0.5, 0.5, 3.6, mats.timber);
  B(-17.3, 9, 0.6, 7.1, 4.0, mats.timberDark, { bottom: 3.6 });
  banner(root, world, g, -18.2, 4.6, '#2f6fa8');
  banner(root, world, g, -18.2, 13.4, '#2f6fa8');

  // Slide bar: posts + low beam (bottom 0.95 m): only a slide fits under it.
  B(-12, 6.6, 1.6, 0.8, 2.4, mats.stone);
  B(-12, 11.4, 1.6, 0.8, 2.4, mats.stone);
  B(-12, 9, 1.6, 4.0, 2.4, mats.timber, { bottom: 0.95 });
  banner(root, world, g, -13.4, 5.6, '#b8862f');

  // Steps + raised runway, 7 m long-jump gap, landing platform
  B(-8.5, 9, 1, 4, 0.4, mats.stoneDark);
  B(-7.5, 9, 1, 4, 0.8, mats.stoneDark);
  B(-4, 9, 6, 4, 1.2, mats.stone);
  B(9, 9, 6, 4, 1.2, mats.stone);
  banner(root, world, g, -1.4, 6.4, '#a83f2f');

  // --------------------------------------------------------------- lane 2 (z = 0), westward
  B(18.5, -0.8, 1, 4, 0.4, mats.stoneDark);
  B(17.5, -0.8, 1, 4, 0.8, mats.stoneDark);
  B(15, -0.8, 4, 4, 1.2, mats.stone);
  // Wall-run wall beside an 11 m gap
  B(7, -3.2, 12, 0.8, 5.0, mats.wall, { tag: 'wall' });
  B(-1.5, -0.8, 7, 4, 1.2, mats.stone);
  banner(root, world, g, 13.6, 2.6, '#3f8a4a');

  // --------------------------------------------------------------- lane 3 (z = -11), eastward
  // Ledge stairs: +1.4 (jump), +2.6 (vault / grab) and +3.2 (hang + climb)
  B(-16, -11, 3, 3, 1.4, mats.stone);
  B(-13, -11, 3, 3, 4.0, mats.stoneDark);
  B(-10, -11, 3, 3, 7.2, mats.stone);
  banner(root, world, g, -16.5, -8.4, '#7a3fa8');

  // Tower (finish) + chimney wall for wall-kick climbing
  const tower = B(-5, -11, 4, 4, 13.6, mats.stoneDark, { tag: 'wall' });
  B(0.8, -11, 0.8, 4, 12.4, mats.wall, { tag: 'wall' });
  // timber bands on the tower are flush decoration inside the collider footprint
  for (const h of [4.5, 9.0]) {
    const band = shadowed(new Mesh(new BoxGeometry(4.02, 0.3, 4.02), mats.timber));
    band.position.set(C.x - 5, g + h, C.z - 11);
    root.add(band);
  }
  banner(root, world, g, 2.2, -8.2, '#2f6fa8');

  // Finish marker: floating crystal + ring + light on the tower top
  const marker = new Group();
  const crystal = new Mesh(new OctahedronGeometry(0.45, 0), mats.glow);
  crystal.position.y = 1.4;
  crystal.scale.y = 1.6;
  const ring = new Mesh(new TorusGeometry(1.2, 0.06, 6, 28), mats.glow);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.06;
  const light = new PointLight(new Color(0.5, 0.9, 1.0), 1.5, 7, 1.6);
  light.position.y = 1.6;
  marker.add(crystal, ring, light);
  marker.position.set(C.x - 5, g + 13.6, C.z - 11);
  root.add(marker);

  return { ground: g, start: { x: C.x - 17.6, zMin: C.z + 6, zMax: C.z + 12 }, finish: tower, marker };
}

// ------------------------------------------------------------------ timer
const BEST_KEY = 'echo-knight.gym.best';

function loadBest(): number {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}
function saveBest(v: number) {
  try {
    localStorage.setItem(BEST_KEY, String(v));
  } catch {
    /* storage unavailable */
  }
}

const CSS = `
.gym-timer { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
  font: 600 15px/1.2 ui-monospace, Menlo, monospace; color: #e8f6ff; background: rgba(10,18,28,.55);
  border: 1px solid rgba(127,223,255,.35); border-radius: 8px; letter-spacing: .04em; pointer-events: none;
  transition: opacity .3s; opacity: 0; white-space: nowrap; }
.gym-timer.show { opacity: 1; }
.gym-timer .best { color: #8fb4c8; font-weight: 400; margin-left: 10px; }
.gym-timer.done { border-color: #7fdfff; box-shadow: 0 0 18px rgba(127,223,255,.45); }
`;

let course: Course | null = null;
const timer = { running: false, t: 0, best: 0, done: 0 };
let el: HTMLElement | null = null;
let prevX = 0;
let spin = 0;

function render() {
  if (!el) return;
  const best = timer.best ? `<span class="best">best ${timer.best.toFixed(2)}</span>` : '';
  el.innerHTML = `GYM ${timer.t.toFixed(2)} s${best}`;
}

export const gymFeature: Feature = {
  name: 'gym',
  install(game: Game) {
    course = buildCourse(game.world);
    timer.best = loadBest();
    HUD.addStyles('gym-timer-css', CSS);
    el = document.createElement('div');
    el.className = 'gym-timer';
    game.hud.mount(el);
    prevX = game.player.position.x;
    render();
  },
  update(dt: number, game: Game) {
    if (!course || !el) return;
    const p = game.player;
    spin += dt;
    const crystal = course.marker.children[0];
    crystal.rotation.y = spin * 1.4;
    crystal.position.y = 1.4 + Math.sin(spin * 2) * 0.15;

    const near = Math.hypot(p.position.x - C.x, p.position.z - C.z) < C.radius + 6;
    const { start } = course;
    // Start: crossing the line eastward inside the gate.
    if (prevX < start.x && p.position.x >= start.x && p.position.z > start.zMin && p.position.z < start.zMax) {
      timer.running = true;
      timer.t = 0;
      timer.done = 0;
      el.classList.remove('done');
      events.emit('gym:start', { position: p.position.clone() });
    }
    prevX = p.position.x;

    if (timer.running) {
      timer.t += dt;
      const f = course.finish;
      if (p.grounded && Math.abs(p.position.y - f.top) < 0.05 && game.world.contains2D(f, p.position.x, p.position.z)) {
        timer.running = false;
        timer.done = 4;
        const isBest = !timer.best || timer.t < timer.best;
        if (isBest) {
          timer.best = timer.t;
          saveBest(timer.t);
        }
        el.classList.add('done');
        game.hud.flash(isBest ? `course ${timer.t.toFixed(2)} s — new best!` : `course ${timer.t.toFixed(2)} s`, 2.2);
        game.fx.echoBurst(new Vector3().copy(course.marker.position).setY(course.marker.position.y + 1.4), 60, 5);
        game.fx.waves.spawn(course.marker.position.clone(), 3, new Color(0.45, 0.9, 1.6), 0.5, 0.2);
        events.emit('gym:finish', { time: timer.t, best: timer.best });
      } else if (!near) {
        timer.running = false; // left the gym: abandon the run
      }
    }
    if (timer.done > 0) timer.done -= dt;
    el.classList.toggle('show', near && (timer.running || timer.done > 0 || timer.best > 0));
    render();
  },
};
