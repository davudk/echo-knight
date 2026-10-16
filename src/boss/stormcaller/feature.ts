import type { Game } from '../../core/Game';
import type { Feature } from '../../features';
import { Regions } from '../../world/Terrain';
import { BossArena, HazardZone } from '../Arena';
import { loadBossModel } from '../models';
import { StormArena } from './arena';
import { StormDef, Stormcaller } from './Stormcaller';

/**
 * Ysolde, the Stormcaller — arena (north-east plateau, fog gate south-west toward the spawn arena)
 * + boss. Travel menu: pause → Travel → "Storm Plateau".
 */
let boss: Stormcaller | null = null;
let stormArena: StormArena | null = null;

const GEAR = ['2H_Staff', 'Mage_Hat', 'Mage_Cape'];

export const stormcallerFeature: Feature = {
  name: 'boss-stormcaller',
  install(game: Game) {
    const region = Regions.stormcaller;
    const arena = new BossArena(game, { id: 'stormcaller', name: 'Storm Plateau', region, gateWidth: 4.6 });
    const sa = (stormArena = new StormArena(game, arena.gate.yaw));
    // pits (fallen tiles) and, during the storm event, the electrified lower ring
    arena.addHazard(new HazardZone(game, {
      x: region.x, z: region.z, radius: 0.001, damage: 7, interval: 0.5, airborneToo: true,
      contains: (x, y, z) => sa.inHazard(x, y, z),
    }));
    void Promise.all([
      loadBossModel('Mage', StormDef.height, GEAR),
      loadBossModel('Mage', StormDef.height, GEAR),
      loadBossModel('Mage', StormDef.height, GEAR),
    ]).then(([model, d1, d2]) => {
      boss = new Stormcaller(game, model, [d1, d2], sa, arena);
      const home = boss.perch;
      boss.placeAt(home.x, home.z, Math.atan2(arena.entry.x - home.x, arena.entry.z - home.z));
      game.bosses.add(boss);
      arena.addBoss(boss);
    });
  },
  update(dt: number) {
    if (boss) boss.tick(dt);
    else stormArena?.update(dt);
  },
};
