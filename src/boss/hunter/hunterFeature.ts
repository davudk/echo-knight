import { Vector3 } from 'three';
import type { Feature } from '../../features';
import { Regions } from '../../world/Terrain';
import { BossArena } from '../Arena';
import { Hunter, loadHunterModel } from './Hunter';
import { HunterHud } from './HunterHud';
import { buildShrine, type ShrineHandle } from './shrine';

/**
 * The Hunter's arena + boss: the south-east shrine (Regions.hunter), fog gate inside the torii on the
 * north-west rim (toward the spawn arena), Travel menu entry "Shrine of Falling Petals", and the duel HUD
 * (posture bars, lives, 危 / 斬 flashes). Dev: `dbg.game.bosses.list.find(b => b.id === 'hunter')`.
 */
let hunter: Hunter | null = null;
let hud: HunterHud;
let shrine: ShrineHandle;
const head = new Vector3();

export const hunterFeature: Feature = {
  name: 'boss-hunter',
  install(game) {
    const r = Regions.hunter;
    const gateDir = Math.atan2(-r.x, -r.z); // toward the world centre = north-west
    shrine = buildShrine(game, r, gateDir);
    const arena = new BossArena(game, { id: 'hunter', name: 'Shrine of Falling Petals', region: r, gateDir, gateWidth: 5.4 });
    hud = new HunterHud(game.hud);
    void loadHunterModel().then((model) => {
      const boss = new Hunter(game, model);
      boss.hud = hud;
      // he waits kneeling-still at the far side of the deck, facing the gate
      const hx = r.x - Math.sin(gateDir) * 4;
      const hz = r.z - Math.cos(gateDir) * 4;
      boss.placeAt(hx, hz, Math.atan2(arena.entry.x - hx, arena.entry.z - hz));
      game.bosses.add(boss);
      arena.addBoss(boss);
      hunter = boss;
    });
  },
  update(dt) {
    shrine?.update(dt);
  },
  lateUpdate(dt, game) {
    const b = hunter;
    if (!b) return;
    const show = b.engaged && (b.alive || b.state === 'dead') && b.model.root.visible && b.state !== 'dead';
    head.copy(b.feet).setY(b.feet.y + b.def.height + 0.25);
    hud.update(dt, game.cam.camera, window.innerWidth, window.innerHeight, {
      head: show ? head : null,
      posture: b.poise / b.def.poise.max,
      broken: b.state === 'stagger' && b.riposteOpen,
      lives: b.lives,
      maxLives: b.maxLives,
      playerPosture: b.engaged ? b.playerPosture / 100 : 0,
      playerBroken: b.playerBroken > 0,
    });
  },
};
