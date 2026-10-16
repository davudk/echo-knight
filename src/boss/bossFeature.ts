import { Vector3 } from 'three';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import type { Feature } from '../features';
import { counterThreatSources } from '../player/states/defense';
import { flasks } from '../player/states/heal';
import { BossBar } from '../ui/BossBar';
import { installTravelMenu, type TravelDest, type TravelMenu } from '../ui/TravelMenu';
import { BossArena, bossArenas } from './Arena';
import type { Boss } from './Boss';
import { Decals } from './Decals';
import { installGrab } from './grab';
import { BossEffects } from './Hitboxes';

declare module '../core/Game' {
  interface Game {
    /** Boss framework. Dev: `game.bosses.spawnTest()` drops the Gate Sentinel (with a test arena) near you. */
    bosses: BossManager;
  }
}

/**
 * Owns every boss and arena: per-frame updates, shared decal / effect pools, the boss HUD,
 * the counter-threat hook, flask refills, travel.
 */
export class BossManager {
  readonly list: Boss[] = [];
  readonly arenas: BossArena[] = [];
  readonly decals: Decals;
  readonly effects: BossEffects;
  readonly bar: BossBar;
  private readonly shown: Boss[] = [];
  private readonly deadAt = new Map<Boss, number>();
  private testArena: BossArena | null = null;
  /** seconds until the victory banner (game time, so scripted tests see it) */
  bannerDelay = -1;

  constructor(private readonly game: Game) {
    this.decals = new Decals(game.scene);
    this.effects = new BossEffects(game.scene, game.world, game.fx, this.decals, () => game.player);
    this.bar = new BossBar(game.hud);
  }

  /** Register a boss: it updates, can be hit / locked on, and shows up in the HUD when engaged. */
  add<B extends Boss>(b: B): B {
    if (!this.list.includes(b)) {
      this.list.push(b);
      this.game.world.targets.push(b);
    }
    return b;
  }

  remove(b: Boss) {
    const i = this.list.indexOf(b);
    if (i >= 0) this.list.splice(i, 1);
    const t = this.game.world.targets.indexOf(b);
    if (t >= 0) this.game.world.targets.splice(t, 1);
    this.bar.remove(b.id);
    b.dispose();
  }

  /** @internal BossArena registers itself */
  addArena(a: BossArena) {
    if (!this.arenas.includes(a)) this.arenas.push(a);
  }
  /** @internal */
  removeArena(a: BossArena) {
    const i = this.arenas.indexOf(a);
    if (i >= 0) this.arenas.splice(i, 1);
  }

  get engaged(): Boss[] {
    return this.list.filter((b) => b.engaged);
  }

  /** Refill the player's flasks (checkpoints). Returns true if any were missing. */
  refillFlasks() {
    return flasks.refill();
  }

  /**
   * Dev hook: spawn the Gate Sentinel ~12 m in front of the player inside a temporary test arena
   * (fog gate between you and it). Calling again resets / moves it.
   */
  async spawnTest(opts: { distance?: number; arena?: boolean } = {}) {
    const { spawnSentinel } = await import('./sentinel/Sentinel');
    const p = this.game.player;
    const f = p.forward;
    const dist = opts.distance ?? 13;
    const cx = p.position.x + f.x * dist;
    const cz = p.position.z + f.z * dist;
    const old = this.list.find((b) => b.id === 'sentinel');
    if (old) this.remove(old);
    if (this.testArena) {
      this.testArena.dispose();
      this.testArena = null;
    }
    let arena: BossArena | null = null;
    if (opts.arena !== false) {
      arena = new BossArena(this.game, {
        id: 'sentinel-test', name: 'Test Arena', region: { x: cx, z: cz, radius: 11 },
        gateDir: Math.atan2(p.position.x - cx, p.position.z - cz),
      });
      this.testArena = arena;
    }
    const boss = await spawnSentinel(this.game, cx, cz, Math.atan2(p.position.x - cx, p.position.z - cz));
    if (arena) arena.addBoss(boss);
    return boss;
  }

  /** Teleport to a destination; aborts any fight in progress. */
  travel(dest: TravelDest) {
    for (const a of this.arenas) if (a.state === 'fight') a.resetFight();
    const p = this.game.player;
    const y = this.game.world.groundAt(dest.x, dest.z);
    p.teleport(new Vector3(dest.x, y, dest.z), dest.facing);
    this.game.cam.snapTo(p.position);
    this.game.cam.recenter(dest.facing);
    events.emit('player:respawn', { position: p.position.clone() }); // refills flasks, clears witch time
  }

  /** Bosses that can counter-threat the player (defense.ts). */
  threats = (): readonly Boss[] => this.list;

  update(dt: number) {
    for (const b of this.list) b.update(dt);
    for (const a of this.arenas) a.update(dt);
    this.effects.update(dt);
    this.decals.update(dt);
  }

  lateUpdate(dt: number) {
    if (this.bannerDelay >= 0) {
      this.bannerDelay -= dt;
      if (this.bannerDelay < 0) this.bar.victory();
    }
    const shown = this.shown;
    shown.length = 0;
    const now = this.game.time;
    for (const b of this.list) {
      if (!b.engaged) continue;
      if (b.alive) shown.push(b);
      else {
        if (!this.deadAt.has(b)) this.deadAt.set(b, now);
        if (now - this.deadAt.get(b)! < 1.2) shown.push(b);
      }
      if (b.alive) this.deadAt.delete(b);
    }
    this.bar.update(dt, shown);
  }
}

/** Static travel destinations; boss arenas are appended from the registry. */
function destinations(): TravelDest[] {
  const out: TravelDest[] = [
    { id: 'arena', name: 'Arena', note: 'spawn', x: 0, z: 6, facing: Math.PI },
    { id: 'town', name: 'Ruined Town', note: 'north', x: 0, z: -24, facing: Math.PI },
    { id: 'gym', name: 'Parkour Gym', note: 'east', x: 40, z: 9, facing: Math.PI / 2 },
  ];
  for (const a of bossArenas()) out.push({ id: a.id, name: a.name, note: 'boss', x: a.entry.x, z: a.entry.z, facing: a.entry.facing });
  return out;
}

let manager: BossManager;
let travel: TravelMenu;

export const bossFeature: Feature = {
  name: 'bosses',
  install(game) {
    manager = game.bosses = new BossManager(game);
    installGrab(game.player);
    counterThreatSources.push(manager.threats);
    travel = installTravelMenu(game, destinations, (d) => manager.travel(d));

    // The controls panel (bottom-left) would sit under the boss bar: fold it for the fight, restore after.
    let foldedHelp = false;
    const controls = () => document.querySelector('#hud .controls');
    events.on('boss:engage', () => {
      const c = controls();
      if (c && !c.classList.contains('collapsed')) {
        game.hud.toggleHelp();
        foldedHelp = true;
      }
    });
    const restoreHelp = () => {
      if (!foldedHelp || manager.list.some((b) => b.engaged && b.alive)) return;
      foldedHelp = false;
      if (controls()?.classList.contains('collapsed')) game.hud.toggleHelp();
    };
    events.on('boss:reset', restoreHelp);
    events.on('boss:defeated', restoreHelp);
    events.on('boss:defeated', () => {
      // banner once the last engaged boss falls (twin fights: after the second)
      if (!manager.list.some((b) => b.engaged && b.alive)) manager.bannerDelay = 0.9;
    });
    if (import.meta.env.DEV) {
      // dev shortcut: Shift+B spawns / respawns the Gate Sentinel test fight
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyB' && e.shiftKey && !e.repeat && !game.paused) void manager.spawnTest();
      });
    }
  },
  update(dt) {
    manager.update(dt);
  },
  lateUpdate(dt) {
    manager.lateUpdate(dt);
  },
  pausedUpdate(dt) {
    manager.lateUpdate(dt);
    travel.pausedUpdate();
  },
};
