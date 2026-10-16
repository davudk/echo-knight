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
