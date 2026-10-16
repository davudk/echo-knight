import type { Feature } from '../features';
import { deathInfo, installHurt, tickHurt } from '../player/states/hurt';
import { EnemyHealthBars, PlayerHealthBar } from '../ui/HealthBars';
import { EnemyManager } from './EnemyManager';

declare module '../core/Game' {
  interface Game {
    /** Enemy grunts. Dev: `game.enemies.spawnNear(game.player)` drops one in front of you. */
    enemies: EnemyManager;
  }
}

let playerBar: PlayerHealthBar;
let enemyBars: EnemyHealthBars;

/** Enemies + player health (hurt / death / respawn) + their HUD. */
export const enemyFeature: Feature = {
  name: 'enemies',
  install(game) {
    installHurt(game.player);
    game.enemies = new EnemyManager(game);
    playerBar = new PlayerHealthBar(game.hud, game.player);
    enemyBars = new EnemyHealthBars(game.hud);
  },
  update(dt, game) {
    tickHurt(game.player, dt);
    game.enemies.update(dt);
  },
  lateUpdate(dt, game) {
    playerBar.update(dt, deathInfo.time);
    enemyBars.update(dt, game.enemies.list, game.cam.camera, game.time, window.innerWidth, window.innerHeight);
  },
};
