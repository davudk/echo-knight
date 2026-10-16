import type { Vector3 } from 'three';
import { playSfx } from '../../audio/audioFeature';
import type { Recipe } from '../../audio/Sfx';
import { Sounds, type SoundName } from '../../audio/sounds';

/**
 * The Twin Wardens' sound accents. Registered into the shared recipe table at runtime so the
 * shared sounds.ts stays untouched (Sfx.play looks recipes up by name).
 */
const TwinSounds = {
  /** Selene's ward settles on Varek: rising glassy chord */
  twinWard(v) {
    v.partials({ base: 523, ratios: [1, 1.5, 2, 3], dur: 1.1, gain: 0.05, attack: 0.15, spread: 0.3 });
    v.noise({ f0: 2400, f1: 5200, q: 2, dur: 0.6, attack: 0.2, gain: 0.08 });
  },
  /** the ward shatters */
  twinWardBreak(v) {
    v.partials({ base: 1568, ratios: [1, 1.34, 2.1, 2.9], dur: 0.5, gain: 0.05 });
    v.noise({ f0: 6000, f1: 2500, q: 0.8, dur: 0.35, gain: 0.3 });
    v.osc({ type: 'triangle', f0: 880, f1: 220, dur: 0.3, gain: 0.08 });
  },
  /** blink: quick airy whoosh */
  twinBlink(v) {
    v.noise({ f0: 900, f1: 4200, q: 1.2, dur: 0.22, attack: 0.02, gain: 0.4 });
    v.osc({ type: 'sine', f0: 1200, f1: 400, dur: 0.18, gain: 0.05 });
  },
  /** smoke bomb: soft pop and hiss */
  twinSmoke(v) {
    v.osc({ f0: 160, f1: 60, dur: 0.18, gain: 0.5, attack: 0.002 });
    v.noise({ f0: 1800, f1: 600, q: 0.6, dur: 1.0, attack: 0.05, gain: 0.35 });
  },
  /** the survivor's fury (enrage) */
  twinFury(v) {
    v.osc({ type: 'sawtooth', f0: 85, f1: 50, dur: 1.8, attack: 0.1, gain: 0.18, lowpass: 650 });
    v.osc({ type: 'sawtooth', f0: 128, f1: 70, dur: 1.6, attack: 0.15, gain: 0.1, lowpass: 900 });
    v.osc({ type: 'square', f0: 64, f1: 40, dur: 1.2, attack: 0.05, gain: 0.05, lowpass: 400 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 600, f1: 150, dur: 1.8, attack: 0.1, gain: 0.6 });
  },
  /** pincer: both twins wind up — two clashing tones */
  twinPincer(v) {
    v.partials({ base: 392, ratios: [1, 2], dur: 0.9, gain: 0.06, attack: 0.05, type: 'triangle' });
    v.partials({ base: 415, ratios: [1, 2], dur: 0.9, gain: 0.06, attack: 0.05, delay: 0.12, type: 'triangle' });
    v.noise({ f0: 5000, f1: 7000, q: 3, dur: 0.2, gain: 0.15 });
  },
  /** heal channel start */
  twinHeal(v) {
    v.partials({ base: 660, ratios: [1, 1.25, 1.5, 2], dur: 1.6, gain: 0.04, attack: 0.4, spread: 0.3 });
  },
  /** smoke clone appears / dissolves */
  twinClone(v) {
    v.partials({ base: 740, ratios: [1, 1.5, 2.2], dur: 0.6, gain: 0.04, attack: 0.05 });
    v.noise({ f0: 1400, f1: 3600, q: 1, dur: 0.4, gain: 0.15 });
  },
} satisfies Record<string, Recipe>;

export type TwinSoundName = keyof typeof TwinSounds;

let registered = false;
export function registerTwinSounds() {
  if (registered) return;
  registered = true;
  Object.assign(Sounds as unknown as Record<string, Recipe>, TwinSounds);
}

export function playTwinSound(name: TwinSoundName, pos?: Vector3, intensity = 1) {
  playSfx(name as unknown as SoundName, { pos, intensity, from: 'twins' });
}
