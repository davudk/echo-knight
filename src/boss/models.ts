import type { AnimationClip, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharacterModel } from '../player/CharacterModel';

/**
 * KayKit Adventurers characters (CC0, same rig + 76 animations each) in public/models/.
 * Each glTF is loaded once and cloned per boss.
 */
export type CharacterFile = 'Knight' | 'Barbarian' | 'Mage' | 'Rogue' | 'Rogue_Hooded';

/** Every gear node per character (show only what a boss uses: pass the rest to `hide`). */
export const CharacterGear: Record<CharacterFile, string[]> = {
  Knight: ['1H_Sword', '1H_Sword_Offhand', '2H_Sword', 'Badge_Shield', 'Rectangle_Shield', 'Round_Shield', 'Spike_Shield', 'Knight_Helmet', 'Knight_Cape'],
  Barbarian: ['1H_Axe', '1H_Axe_Offhand', '2H_Axe', 'Barbarian_Round_Shield', 'Mug', 'Barbarian_Hat', 'Barbarian_Cape'],
  Mage: ['1H_Wand', '2H_Staff', 'Spellbook', 'Spellbook_open', 'Mage_Hat', 'Mage_Cape'],
  Rogue: ['Knife', 'Knife_Offhand', '1H_Crossbow', '2H_Crossbow', 'Throwable', 'Rogue_Cape'],
  Rogue_Hooded: ['Knife', 'Knife_Offhand', '1H_Crossbow', '2H_Crossbow', 'Throwable', 'Rogue_Cape'],
};

const cache = new Map<CharacterFile, Promise<{ scene: Object3D; clips: AnimationClip[] }>>();

function source(file: CharacterFile) {
  let p = cache.get(file);
  if (!p) {
    const url = `${import.meta.env.BASE_URL}models/${file}.glb`;
    p = new GLTFLoader().loadAsync(url).then((g) => ({ scene: g.scene, clips: g.animations }));
    cache.set(file, p);
  }
  return p;
}

/**
 * Load (cached) and clone a character for a boss.
 * @param keep gear nodes to SHOW (everything else in `CharacterGear[file]` is hidden)
 * @param height model height in metres (player: 1.85; a 1.6× boss: ~2.96)
 */
export async function loadBossModel(file: CharacterFile, height: number, keep: string[] = []): Promise<CharacterModel> {
  const src = await source(file);
  const scene = cloneSkinned(src.scene);
  const hide = CharacterGear[file].filter((n) => !keep.includes(n));
  return CharacterModel.fromScene(scene, src.clips, height, { hide });
}
