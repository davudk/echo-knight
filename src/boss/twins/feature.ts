import type { Feature } from '../../features';
import { Regions } from '../../world/Terrain';
import { BossArena } from '../Arena';
import { loadBossModel } from '../models';
import { TwinArena } from './arena';
import { TwinPair } from './Pair';
import { Selene } from './Selene';
import { registerTwinSounds } from './sounds';
import { Varek } from './Varek';

/**
 * THE TWIN WARDENS — Varek the Breaker (aggressor) and Selene the Veil (support) in the Duelling
 * Ring (south, Regions.twins). Kill order matters: the survivor enrages and inherits the fallen
 * twin's tools. See Pair.ts for the coordination rules.
 *
 * Dev: `twins` on window → { varek, selene, pair, arena }.
 */
let arenaFx: TwinArena | null = null;
let pair: TwinPair | null = null;

export const twinsFeature: Feature = {
  name: 'boss-twins',
  install(game) {
    registerTwinSounds();
    const r = Regions.twins;
    arenaFx = new TwinArena(game.world);
    const arena = new BossArena(game, { id: 'twins', name: 'The Duelling Ring', region: r });
    const vh = Varek.height;
    const sh = Selene.height;
    void Promise.all([
      loadBossModel('Barbarian', vh, ['2H_Axe', 'Barbarian_Cape']),
      loadBossModel('Rogue_Hooded', sh, ['Knife', 'Knife_Offhand', 'Rogue_Cape']),
      loadBossModel('Rogue_Hooded', sh, ['Knife', 'Knife_Offhand']),
      loadBossModel('Rogue_Hooded', sh, ['Knife', 'Knife_Offhand']),
    ]).then(([vm, sm, c1, c2]) => {
      const varek = new Varek(game, vm);
      const selene = new Selene(game, sm);
      varek.selene = selene;
      selene.varek = varek;
      pair = new TwinPair(game, varek, selene, [c1, c2]);
      const face = (x: number, z: number) => Math.atan2(arena.entry.x - x, arena.entry.z - z);
      varek.placeAt(r.x - 2.4, r.z + 1.5, face(r.x - 2.4, r.z + 1.5));
      selene.placeAt(r.x + 2.4, r.z + 2.5, face(r.x + 2.4, r.z + 2.5));
      game.bosses.add(varek);
      game.bosses.add(selene);
      arena.addBoss(varek);
      arena.addBoss(selene);
      if (import.meta.env.DEV) Object.assign(window as object, { twins: { varek, selene, pair, arena } });
    });
  },
  update(dt) {
    arenaFx?.update(dt);
    pair?.update(dt);
  },
};
