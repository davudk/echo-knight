import type { Game } from '../core/Game';
import { installCombat } from '../player/states/combat';
import { installLocomotion } from '../player/states/locomotion';
import { installParkour } from '../player/states/parkour';
import { gymFeature } from '../world/Gym';
import { echoFeature } from '../abilities/echoFeature';
import { audioFeature } from '../audio/audioFeature';
import { styleMeterFeature } from '../ui/StyleMeter';
import { trainingFeature } from '../ui/Training';
import { loadoutFeature } from '../ui/LoadoutPanel';
import { townFeature } from '../world/Town';
import { enemyFeature } from '../enemy/enemyFeature';
import { offenseFeature } from '../player/states/moves';
import { defenseFeature } from '../player/states/defense';
import { healFeature } from '../player/states/heal';
import { bossFeature } from '../boss/bossFeature';
import { twinsFeature } from '../boss/twins/feature';
import { stormcallerFeature } from '../boss/stormcaller/feature';
import { colossusFeature } from '../boss/colossus/arena';
import { wardenFeature } from '../boss/warden/wardenFeature';

/**
 * A feature plugs into the game without the game knowing its internals.
 *  - install: called once after the player exists (register states, interrupts, HUD widgets, listeners)
 *  - update:  gameplay tick (scaled by hitstop / slow-mo)
 *  - lateUpdate: after the camera moved (UI that projects to screen), real-time dt
 */
export interface Feature {
  name: string;
  install(game: Game): void;
  update?(dt: number, game: Game): void;
  lateUpdate?(dt: number, game: Game): void;
  /** runs while the game is paused (menus) */
  pausedUpdate?(dt: number, game: Game): void;
}

const playerCore: Feature = {
  name: 'player-core',
  install(game) {
    installLocomotion(game.player);
    installCombat(game.player);
    installParkour(game.player);
  },
};

/**
 * Feature list — order matters for install (later features can override interrupts by priority).
 * Workstreams add ONE line each here.
 */
export const features: Feature[] = [
  playerCore,
  echoFeature,
  audioFeature,
  styleMeterFeature,
  trainingFeature,
  loadoutFeature,
  townFeature,
  enemyFeature,
  offenseFeature,
  gymFeature,
  defenseFeature,
  healFeature,
  bossFeature,
  twinsFeature,
  stormcallerFeature,
  colossusFeature,
  wardenFeature,
];
