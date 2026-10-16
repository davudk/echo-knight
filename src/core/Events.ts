import type { Vector3 } from 'three';
import type { HitInfo, Hittable } from '../world/World';

/**
 * Typed game events. Gameplay emits *what happened*; audio, HUD, echo-mimic, style meter etc.
 * subscribe. Add new events here (keep payloads plain data).
 */
export interface GameEvents {
  'player:jump': { position: Vector3; airJump: number };
  'player:land': { position: Vector3; impact: number };
  'player:dodge': { position: Vector3; backstep: boolean };
  'player:airdash': { position: Vector3; dir: Vector3 };
  'player:footstep': { position: Vector3; sprint: boolean };
  // Movement kit (movement stream)
  'player:slide': { position: Vector3; speed: number };
  'player:longjump': { position: Vector3; speed: number };
  'player:wallrun': { position: Vector3; normal: Vector3; side: 'left' | 'right' };
  'player:wallrun-end': { position: Vector3; reason: 'jump' | 'time' | 'release' | 'edge' | 'land' | 'other' };
  'player:walljump': { position: Vector3; dir: Vector3 };
  'player:ledge': { position: Vector3; action: 'grab' | 'vault' | 'climb' | 'drop' | 'jump' };
  'gym:start': { position: Vector3 };
  'gym:finish': { time: number; best: number };
  /** An attack started. Carries everything needed to replay it (echo mimic, training log). */
  'player:attack': {
    move: string;
    clip: string;
    speed: number;
    clipStart: number;
    heavy: boolean;
    position: Vector3;
    facing: number;
  };
  /** Player's attack connected with a target. */
  'player:hit': { target: Hittable; info: HitInfo; move: string };
  'player:slam': { position: Vector3; radius: number };
  'player:damaged': { damage: number; health: number; position: Vector3 };
  'player:blocked': { damage: number; position: Vector3 };
  'player:parry': { position: Vector3 };
  'player:perfect-dodge': { position: Vector3 };
  /** counter style: an enemy's swing was reversed */
  'player:counter': { position: Vector3 };
  /** stamina ran out while blocking */
  'player:guard-break': { position: Vector3 };
  /** post-parry riposte connected (bonus damage dealt) */
  'player:riposte': { position: Vector3; damage: number };
  'player:died': { position: Vector3 };
  'player:respawn': { position: Vector3 };
  'echo:placed': { position: Vector3; index: number };
  'echo:recalled': { from: Vector3; to: Vector3; mode: string };
  'echo:expired': { position: Vector3 };
  /** Echo press refused (e.g. mid-air without Aerial Echo). */
  'echo:fizzle': { position: Vector3; reason: string };
  /** A mimic echo repeated one of the player's attacks. */
  'echo:mimic': { position: Vector3; move: string };
  /** Arrival shockwave after a recall. */
  'echo:shockwave': { position: Vector3; radius: number };
  'enemy:hit': { position: Vector3; damage: number; heavy: boolean };
  'enemy:died': { position: Vector3 };
  'enemy:attack': { position: Vector3 };
  /** an enemy started winding up; `duration` = seconds until its hit frame */
  'enemy:telegraph': { position: Vector3; duration: number };
  'enemy:blocked': { position: Vector3 };
  'enemy:staggered': { position: Vector3; duration: number; parried: boolean };
  'enemy:respawn': { position: Vector3 };
  // Bosses (src/boss/*) — `id` is the boss id, payloads are plain data.
  'boss:engage': { id: string; name: string; position: Vector3 };
  /** a new phase started (0 = first); fired at the start of the transition beat */
  'boss:phase': { id: string; phase: number; position: Vector3 };
  /** poise broken / parry reaction; `riposte` = open to a finisher */
  'boss:stagger': { id: string; position: Vector3; duration: number; cause: 'poise' | 'parry' | 'counter' | 'reflect' | 'custom'; riposte: boolean };
  /** an attack step started winding up; `telegraph` = colour class, `windup` = seconds until it is active */
  'boss:attack': { id: string; attackId: string; step: number; telegraph: 'parryable' | 'unblockable' | 'magic'; windup: number; position: Vector3 };
  /** the boss took damage */
  'boss:hit': { id: string; damage: number; position: Vector3; heavy: boolean; critical: boolean };
  /** riposte / execution finisher landed */
  'boss:riposte': { id: string; damage: number; position: Vector3 };
  'boss:grab': { id: string; phase: 'catch' | 'throw' | 'escape'; position: Vector3 };
  /** a boss projectile was parried back */
  'boss:reflect': { id: string; position: Vector3 };
  'boss:defeated': { id: string; name: string; position: Vector3 };
  /** the fight was reset (player died / left) */
  'boss:reset': { id: string };
  /** arena kit: fog gate sealed / opened, music / ambience cues (audio subscribes) */
  'arena:seal': { id: string; sealed: boolean; position: Vector3 };
  'arena:music': { id: string; cue: 'fight' | 'phase' | 'victory' | 'stop'; phase?: number };
  'arena:checkpoint': { id: string; position: Vector3 };
  /** flasks (player/states/heal.ts) */
  'player:heal-start': { position: Vector3; charges: number };
  'player:heal': { position: Vector3; amount: number; charges: number };
  'player:heal-empty': { position: Vector3 };
  'player:grabbed': { position: Vector3 };
  'input:action': { action: string };
  'loadout:changed': { id: string; value: LoadoutValue };
  'ui:pause': { paused: boolean };
}

export type LoadoutValue = boolean | number | string;

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}

/** Global bus — systems are created once per page, so a singleton keeps wiring simple. */
export const events = new EventBus();
