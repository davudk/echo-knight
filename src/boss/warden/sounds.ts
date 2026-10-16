import type { Vector3 } from 'three';
import { playSfx } from '../../audio/audioFeature';
import type { Recipe } from '../../audio/Sfx';
import { Sounds, type SoundName } from '../../audio/sounds';

/**
 * The Warden's own sound recipes. Registered into the shared `Sounds` table at runtime (Sfx looks
 * recipes up by name when playing), so the shared audio files stay untouched.
 */
const WardenSounds: Record<string, Recipe> = {
  /** an echo forms (glassy shimmer, low breath) */
  wardenEcho(v) {
    v.partials({ base: 520, ratios: [1, 1.5, 2.02, 3.01], dur: 0.6, gain: 0.05, attack: 0.04, spread: 0.3 });
    v.noise({ f0: 900, f1: 3200, q: 1.2, dur: 0.45, attack: 0.12, gain: 0.12 });
  },
  /** an echo shatters */
  wardenShatter(v) {
    v.partials({ base: 1480, ratios: [1, 1.34, 2.1, 2.9], dur: 0.5, gain: 0.07 });
    for (let i = 0; i < 6; i++) v.noise({ f0: 3000 + i * 600, q: 6, dur: 0.05, gain: 0.08, delay: i * 0.035 });
    v.osc({ f0: 180, f1: 60, dur: 0.3, gain: 0.25 });
  },
  /** teleport / swap / recall arrival */
  wardenBlink(v) {
    v.noise({ f0: 4000, f1: 400, q: 1.4, dur: 0.3, attack: 0.01, gain: 0.3 });
    v.osc({ type: 'sawtooth', f0: 70, f1: 140, dur: 0.25, gain: 0.1, lowpass: 700 });
    v.partials({ base: 392, ratios: [1, 1.5], dur: 0.5, gain: 0.04 });
  },
  /** the void wells up (flood warning) */
  voidRise(v) {
    v.osc({ type: 'sawtooth', f0: 45, f1: 70, dur: 2.6, attack: 0.8, gain: 0.14, lowpass: 400 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 160, f1: 420, dur: 2.6, attack: 1.0, gain: 0.5 });
    v.partials({ base: 110, ratios: [1, 1.5, 2.01], dur: 2.4, gain: 0.05, attack: 1.2 });
  },
  /** void beam hum */
  voidBeam(v) {
    v.osc({ type: 'sawtooth', f0: 220, f1: 180, dur: 1.4, attack: 0.05, gain: 0.08, lowpass: 1800 });
    v.noise({ f0: 2000, f1: 800, q: 1.5, dur: 1.4, attack: 0.05, gain: 0.12 });
  },
  /** execution finisher */
  wardenExecution(v) {
    v.osc({ f0: 90, f1: 22, dur: 1.6, gain: 0.9, attack: 0.002 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 600, f1: 60, dur: 1.6, gain: 0.8 });
    v.partials({ base: 196, ratios: [1, 1.5, 2, 2.5, 3], dur: 2.4, gain: 0.07, attack: 0.05 });
  },
};

let registered = false;
export function registerWardenSounds() {
  if (registered) return;
  registered = true;
  Object.assign(Sounds as unknown as Record<string, Recipe>, WardenSounds);
}

export type WardenSound = keyof typeof WardenSounds;

export function playWardenSfx(name: WardenSound | SoundName, pos?: Vector3, intensity?: number) {
  registerWardenSounds();
  playSfx(name as SoundName, { pos: pos?.clone(), intensity });
}
