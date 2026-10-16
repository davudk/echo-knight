import type { Game } from '../../core/Game';
import type { Feature } from '../../features';
import { counterThreatSources } from '../../player/states/defense';
import { Regions } from '../../world/Terrain';
import { BossArena } from '../Arena';
import { loadBossModel } from '../models';
import { buildKeep } from './Keep';
import { registerWardenSounds } from './sounds';
import { Warden, WardenDef } from './Warden';

declare module '../../core/Game' {
  interface Game {
    /** The Hollow Warden (dev / tests); null until its models have loaded. */
    warden?: Warden | null;
  }
}

/**
 * Warden's Keep: arena geometry, fog gate (east, toward the town road), the Hollow Warden and
 * his three echo puppets. Travel menu: pause → Travel → "Warden's Keep".
 */
export const wardenFeature: Feature = {
  name: 'boss-warden',
  install(game: Game) {
    registerWardenSounds();
    const r = Regions.warden;
    const keep = buildKeep(game.world, r);
    const arena = new BossArena(game, { id: 'warden', name: "Warden's Keep", region: r, gateDir: Math.PI / 2, gateWidth: 5 });
    keepUpdate = keep.update;
    game.warden = null;
    const gear = ['2H_Sword', 'Knight_Helmet', 'Knight_Cape'];
    void Promise.all([
      loadBossModel('Knight', WardenDef.height, gear),
      loadBossModel('Knight', WardenDef.height, gear),
      loadBossModel('Knight', WardenDef.height, gear),
      loadBossModel('Knight', WardenDef.height, gear),
    ]).then(([main, ...echoModels]) => {
      const boss = new Warden(game, main, echoModels, keep.layout, r.radius, arena);
      const t = keep.layout.throne;
      boss.placeAt(t.x, t.z, Math.PI / 2); // kneels on the dais, facing the gate
      game.bosses.add(boss);
      game.warden = boss;
      // the counter style can reverse the echoes' gold swings too
      counterThreatSources.push(() => boss.echoes.filter((e) => e.active));
    });
  },
  update(dt) {
    keepUpdate?.(dt);
  },
};

let keepUpdate: ((dt: number) => void) | null = null;
