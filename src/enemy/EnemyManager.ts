import type { AnimationClip, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Game } from '../core/Game';
import { CharacterModel } from '../player/CharacterModel';
import type { Player } from '../player/Player';
import { Enemy, EnemyTuning, type EnemyDirector } from './Enemy';

const MODEL_URL = `${import.meta.env.BASE_URL}models/Knight.glb`;
/** Grunts carry sword + spiked shield; the player's spare gear stays hidden. */
const ENEMY_HIDDEN = ['1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Round_Shield', '2H_Sword', 'Knight_Cape'];

/** Open ground between arena and town, plus the town plaza around (0, -62). */
export const ENEMY_SPAWNS: [number, number][] = [
  [10, -26],
  [-12, -30],
  [-4, -58],
  [4.5, -61],
  [0, -67],
];

const MAX_ENEMIES = 6;
/** at most this many enemies wind up / swing at the same time */
const MAX_ATTACKERS = 2;
/** minimum gap between two attack starts, so swings don't land on the same frame */
const ATTACK_GAP = 0.45;

/**
 * Owns all enemies: loading, spawning, attack tokens (fairness), separation.
 * Exposed as `game.enemies` — e.g. `game.enemies.spawnNear(game.player)` in the console.
 */
export class EnemyManager implements EnemyDirector {
  readonly list: Enemy[] = [];
  private source: { scene: Object3D; clips: AnimationClip[] } | null = null;
  private readonly holders = new Set<Enemy>();
  private sinceAttack = 99;
  readonly ready: Promise<void>;

  constructor(private readonly game: Game) {
    this.ready = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
      this.source = { scene: gltf.scene, clips: gltf.animations };
      for (const [x, z] of ENEMY_SPAWNS) this.spawn(x, z);
    });
  }

  /** Spawn a grunt at (x, z). Recycles the farthest one when at the cap. */
  spawn(x: number, z: number): Enemy | null {
    if (!this.source) return null;
    if (this.list.length >= MAX_ENEMIES) {
      const p = this.game.player.position;
      const far = this.list.reduce((a, b) => (a.feet.distanceToSquared(p) > b.feet.distanceToSquared(p) ? a : b));
      far.relocate(x, z);
      return far;
    }
    const scene = cloneSkinned(this.source.scene);
    const model = CharacterModel.fromScene(scene, this.source.clips, EnemyTuning.height, { hide: ENEMY_HIDDEN });
    const e = new Enemy(model, this.game, this, x, z);
    this.list.push(e);
    this.game.world.targets.push(e);
    return e;
  }

  /** Dev hook: drop a grunt ~5 m in front of the player. */
  spawnNear(player: Player = this.game.player, distance = 5): Enemy | null {
    const f = player.forward;
    return this.spawn(player.position.x + f.x * distance, player.position.z + f.z * distance);
  }

  // ------------------------------------------------------------------ tokens
  canAttack(e: Enemy): boolean {
    return e.hasToken || (this.holders.size < MAX_ATTACKERS && this.sinceAttack >= ATTACK_GAP);
  }

  requestToken(e: Enemy): boolean {
    if (e.hasToken) return true;
    if (!this.canAttack(e)) return false;
    this.holders.add(e);
    e.hasToken = true;
    this.sinceAttack = 0;
    return true;
  }

  releaseToken(e: Enemy) {
    this.holders.delete(e);
    e.hasToken = false;
  }

  /** Enemy currently winding up / swinging that will connect soonest (defense stream helper). */
  get nextThreat(): Enemy | null {
    let best: Enemy | null = null;
    for (const e of this.list) {
      if (e.attacking && (!best || e.attackTimeRemaining < best.attackTimeRemaining)) best = e;
    }
    return best;
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    this.sinceAttack += dt;
    for (const e of this.list) e.update(dt);
    this.separate();
  }

  /** Soft push-apart between enemies, and between enemies and the player. */
  private separate() {
    const list = this.list;
    const minEE = EnemyTuning.radius * 2;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive || Math.abs(a.feet.y - b.feet.y) > 1.5) continue;
        const dx = b.feet.x - a.feet.x;
        const dz = b.feet.z - a.feet.z;
        const d = Math.hypot(dx, dz);
        if (d >= minEE || d < 1e-4) continue;
        const push = (minEE - d) * 0.5;
        a.feet.x -= (dx / d) * push;
        a.feet.z -= (dz / d) * push;
        b.feet.x += (dx / d) * push;
        b.feet.z += (dz / d) * push;
      }
    }
    const p = this.game.player;
    if (p.dead) return;
    const minPE = EnemyTuning.radius + 0.4;
    for (const e of list) {
      if (!e.alive || e.airborne || Math.abs(e.feet.y - p.position.y) > 1.2) continue;
      const dx = e.feet.x - p.position.x;
      const dz = e.feet.z - p.position.z;
      const d = Math.hypot(dx, dz);
      if (d >= minPE || d < 1e-4) continue;
      const push = minPE - d;
      e.feet.x += (dx / d) * push * 0.2;
      e.feet.z += (dz / d) * push * 0.2;
      const f = p.forward;
      const wf = -(dx * f.x + dz * f.z); // (player - enemy) · forward
      if (p.attacking && wf < 0) {
        // Attack lunges stop against the enemy instead of sliding around it:
        // back the player up along its facing until it just touches.
        const wx = -(e.feet.x - p.position.x);
        const wz = -(e.feet.z - p.position.z);
        const w2 = wx * wx + wz * wz;
        const wf2 = wx * f.x + wz * f.z;
        const disc = wf2 * wf2 - (w2 - minPE * minPE);
        if (disc > 0) {
          const back = wf2 + Math.sqrt(disc);
          p.position.x -= f.x * back;
          p.position.z -= f.z * back;
          continue;
        }
      }
      // enemies are solid: the player mostly stops against them
      p.position.x -= (dx / d) * push * 0.8;
      p.position.z -= (dz / d) * push * 0.8;
    }
  }
}
