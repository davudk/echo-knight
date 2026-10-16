import type { Recipe, VoiceBuilder } from './Sfx';

/**
 * Sound recipes. Each one layers `v.osc` (enveloped oscillator + glide), `v.noise`
 * (filtered noise + sweep) and `v.partials` (bell/metal stacks). `v.intensity` (0..1+)
 * and `v.variant` come from the caller. Gains are pre-compressor; ~1 is loud.
 */
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function thud(v: VoiceBuilder, f0: number, f1: number, dur: number, gain: number, delay = 0) {
  v.osc({ f0, f1, dur, gain, attack: 0.002, delay, glide: dur * 0.7 });
}

export const Sounds = {
  // ---------------------------------------------------------------- blades
  swingLight(v) {
    v.noise({ f0: 700, f1: 2800, q: 1.4, dur: 0.17, attack: 0.04, gain: 0.55 });
    v.noise({ f0: 4500, f1: 6500, filter: 'highpass', q: 0.5, dur: 0.1, attack: 0.03, gain: 0.05 });
  },
  swingHeavy(v) {
    v.noise({ f0: 280, f1: 1500, q: 1.1, dur: 0.34, attack: 0.1, gain: 0.48 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 260, dur: 0.3, attack: 0.08, gain: 0.35 });
    v.osc({ f0: 90, f1: 140, dur: 0.25, attack: 0.08, gain: 0.08 });
  },
  hit(v) {
    thud(v, 150, 48, 0.17, 0.85);
    v.noise({ f0: 2600, f1: 1200, q: 0.9, dur: 0.07, gain: 0.45 });
    v.osc({ type: 'square', f0: 1900, f1: 500, dur: 0.025, gain: 0.08, lowpass: 3500 });
  },
  hitHeavy(v) {
    thud(v, 120, 34, 0.32, 1.0);
    v.noise({ f0: 1900, f1: 600, q: 0.8, dur: 0.14, gain: 0.55 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 420, f1: 120, dur: 0.35, gain: 0.6 });
    v.osc({ type: 'square', f0: 1400, f1: 300, dur: 0.04, gain: 0.1, lowpass: 2500 });
  },
  /** glassy tint added on echo-dealt hits */
  hitEcho(v) {
    v.partials({ base: 1250, ratios: [1, 1.5, 2.01], dur: 0.35, gain: 0.05 });
  },
  slam(v) {
    thud(v, 85, 26, 0.75, 1.0);
    v.noise({ color: 'brown', filter: 'lowpass', f0: 360, f1: 70, dur: 0.95, attack: 0.005, gain: 0.9 });
    v.noise({ f0: 1400, f1: 400, q: 0.6, dur: 0.18, gain: 0.35 });
    // debris: a scatter of small ticks
    for (let i = 0; i < 7; i++) {
      v.noise({ f0: rnd(1800, 5200), q: 4, dur: rnd(0.02, 0.05), gain: rnd(0.05, 0.14), delay: 0.06 + i * rnd(0.04, 0.08) });
    }
  },
  // ---------------------------------------------------------------- body
  footstep(v) {
    const loud = v.variant === 'sprint' ? 1.3 : 1;
    v.noise({ color: 'brown', filter: 'lowpass', f0: rnd(350, 600), dur: 0.07, gain: 0.4 * loud });
    v.noise({ f0: rnd(1500, 2600), q: 2, dur: 0.035, gain: 0.07 * loud, delay: 0.01 });
  },
  jump(v) {
    v.noise({ f0: 500, f1: 1300, q: 1, dur: 0.13, attack: 0.01, gain: 0.3 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 300, dur: 0.06, gain: 0.35 });
  },
  airJump(v) {
    v.noise({ filter: 'bandpass', f0: 1400, f1: 4200, q: 0.8, dur: 0.26, attack: 0.02, gain: 0.2 });
    const base = v.variant === '2' ? 1568 : 1318;
    v.partials({ base, ratios: [1, 1.335, 2], dur: 0.45, gain: 0.035, attack: 0.01 });
  },
  land(v) {
    const i = clamp01(v.intensity);
    v.noise({ color: 'brown', filter: 'lowpass', f0: 260 + 200 * i, dur: 0.1 + 0.15 * i, gain: 0.18 + 0.5 * i });
    if (i > 0.2) thud(v, 95, 38, 0.12 + 0.15 * i, 0.5 * i);
    v.noise({ f0: 1800, q: 1.5, dur: 0.04, gain: 0.04 + 0.05 * i });
  },
  roll(v) {
    v.noise({ f0: 450, f1: 750, q: 0.8, dur: 0.18, attack: 0.04, gain: 0.2 });
    v.noise({ f0: 700, f1: 380, q: 0.8, dur: 0.22, attack: 0.05, gain: 0.18, delay: 0.14 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 380, dur: 0.08, gain: 0.2, delay: 0.32 });
  },
  airDash(v) {
    v.noise({ f0: 3200, f1: 700, q: 1.2, dur: 0.24, attack: 0.006, gain: 0.42 });
    v.noise({ filter: 'highpass', f0: 5000, dur: 0.08, gain: 0.06 });
    v.osc({ f0: 620, f1: 190, dur: 0.14, gain: 0.08 });
  },
  slide(v) {
    v.noise({ color: 'brown', filter: 'bandpass', f0: 900, f1: 500, q: 0.7, dur: 0.5, attack: 0.03, gain: 0.35 });
    v.noise({ f0: 3000, f1: 1800, q: 1.5, dur: 0.45, attack: 0.03, gain: 0.05 });
  },
  grab(v) {
    v.noise({ color: 'brown', filter: 'lowpass', f0: 500, dur: 0.06, gain: 0.5 });
    v.noise({ f0: 900, q: 1, dur: 0.12, attack: 0.02, gain: 0.12, delay: 0.03 });
  },
  damaged(v) {
    // grunt-ish: a buzzy source through a vowel-like formant, plus a body thud
    v.osc({ type: 'sawtooth', f0: 175, f1: 95, dur: 0.2, attack: 0.01, gain: 0.22, lowpass: 750 });
    v.noise({ f0: 650, q: 4, dur: 0.15, attack: 0.01, gain: 0.12 });
    thud(v, 110, 45, 0.22, 0.7);
  },
  died(v) {
    thud(v, 70, 24, 1.2, 0.9);
    v.osc({ type: 'sawtooth', f0: 160, f1: 55, dur: 0.9, attack: 0.02, gain: 0.12, lowpass: 600 });
    v.partials({ base: 220, ratios: [1, 1.19, 1.5], dur: 1.8, gain: 0.05, attack: 0.3 });
  },
  respawn(v) {
    v.noise({ f0: 600, f1: 5000, q: 1, dur: 0.6, attack: 0.5, gain: 0.12 });
    v.partials({ base: 523, ratios: [1, 1.5, 2, 3], dur: 1.2, gain: 0.05, attack: 0.05, delay: 0.5 });
  },
  // ---------------------------------------------------------------- echo
  echoPlace(v) {
    const base = 880 * [1, 1.122, 1.26][Math.min(2, Number(v.variant) || 0)];
    for (const r of [1, 1.26, 1.5, 2]) v.osc({ f0: base * r, dur: 1.1, attack: 0.015, gain: 0.045, detune: rnd(-6, 6) });
    v.osc({ type: 'triangle', f0: base / 2, dur: 0.6, attack: 0.01, gain: 0.04 });
    v.noise({ filter: 'highpass', f0: 6000, dur: 0.25, attack: 0.01, gain: 0.04 });
  },
  echoRecall(v) {
    const mode = v.variant || 'teleport';
    const swell = 0.24;
    if (mode === 'rewind') {
      // tape-rewind: descending warble that snaps back
      v.noise({ f0: 3500, f1: 450, q: 2, dur: swell + 0.05, attack: swell * 0.8, gain: 0.25 });
      v.osc({ type: 'sawtooth', f0: 900, f1: 220, dur: swell + 0.05, attack: swell * 0.8, gain: 0.05, lowpass: 1500 });
      v.osc({ f0: 300, f1: 900, dur: 0.1, gain: 0.25, delay: swell });
    } else {
      // reverse swell → pop
      v.noise({ f0: 400, f1: 3200, q: 1.5, dur: swell + 0.02, attack: swell * 0.9, gain: 0.28 });
      v.osc({ f0: 220, f1: 880, dur: swell + 0.02, attack: swell * 0.9, gain: 0.07 });
      v.osc({ f0: 1300, f1: 320, dur: 0.09, gain: 0.35, delay: swell });
      if (mode === 'swap') v.osc({ f0: 1700, f1: 500, dur: 0.08, gain: 0.25, delay: swell + 0.07 });
    }
    v.noise({ filter: 'highpass', f0: 3000, dur: 0.06, gain: 0.15, delay: swell });
    v.partials({ base: mode === 'swap' ? 1175 : mode === 'rewind' ? 784 : 988, ratios: [1, 1.5, 2], dur: 0.5, gain: 0.04, delay: swell });
  },
  echoExpire(v) {
    v.osc({ f0: 660, f1: 520, dur: 0.7, attack: 0.06, gain: 0.04 });
    v.osc({ f0: 880, f1: 700, dur: 0.6, attack: 0.06, gain: 0.03 });
    v.noise({ filter: 'lowpass', f0: 2000, f1: 400, dur: 0.5, attack: 0.05, gain: 0.05 });
  },
  echoShockwave(v) {
    thud(v, 140, 40, 0.4, 0.6);
    v.noise({ f0: 4000, f1: 600, q: 1, dur: 0.4, gain: 0.25 });
    v.partials({ base: 660, ratios: [1, 1.5, 2.25], dur: 0.6, gain: 0.04 });
  },
  // ---------------------------------------------------------------- defense
  parry(v) {
    v.partials({ base: 640, ratios: [1, 2.76, 5.4, 8.93], dur: 1.1, gain: 0.16, spread: 0.6 });
    v.noise({ filter: 'highpass', f0: 4000, dur: 0.035, gain: 0.35 });
    thud(v, 200, 90, 0.08, 0.3);
  },
  block(v) {
    v.partials({ base: 290, ratios: [1, 2.3, 3.9], dur: 0.2, gain: 0.1, type: 'square' });
    v.noise({ filter: 'lowpass', f0: 1600, dur: 0.08, gain: 0.35 });
    thud(v, 130, 60, 0.12, 0.45);
  },
  perfectDodge(v) {
    v.noise({ f0: 2400, f1: 260, q: 1.5, dur: 0.85, attack: 0.08, gain: 0.3 });
    v.osc({ f0: 420, f1: 110, dur: 0.85, attack: 0.05, gain: 0.1 });
    v.partials({ base: 1046, ratios: [1, 1.5], dur: 0.9, gain: 0.03, attack: 0.04 });
  },
  // ---------------------------------------------------------------- enemies
  enemyHit(v) {
    v.noise({ color: 'brown', filter: 'lowpass', f0: 700, dur: 0.09, gain: 0.6 * (v.variant === 'heavy' ? 1.5 : 1) });
  },
  enemyDied(v) {
    thud(v, 90, 30, 0.6, 0.6);
    v.osc({ type: 'sawtooth', f0: 210, f1: 60, dur: 0.6, attack: 0.02, gain: 0.08, lowpass: 700 });
    for (let i = 0; i < 5; i++) v.noise({ f0: rnd(2000, 5000), q: 5, dur: 0.04, gain: 0.07, delay: 0.1 + i * 0.06 });
  },
  enemyAttack(v) {
    // short warning glint before the swing lands
    v.noise({ f0: 5000, f1: 7000, q: 3, dur: 0.12, attack: 0.03, gain: 0.18 });
    v.osc({ f0: 2093, dur: 0.18, attack: 0.005, gain: 0.03 });
  },
  // ---------------------------------------------------------------- bosses
  /** wind-up cue; variant = telegraph colour (parryable / unblockable / magic) */
  bossTelegraph(v) {
    if (v.variant === 'unblockable') {
      v.osc({ type: 'sawtooth', f0: 110, f1: 70, dur: 0.45, attack: 0.02, gain: 0.12, lowpass: 900 });
      v.partials({ base: 220, ratios: [1, 1.06, 2.1], dur: 0.5, gain: 0.07, type: 'square' });
      v.noise({ color: 'brown', filter: 'lowpass', f0: 300, dur: 0.3, gain: 0.25 });
    } else if (v.variant === 'magic') {
      v.partials({ base: 880, ratios: [1, 1.5, 2.25, 3.01], dur: 0.7, gain: 0.05, attack: 0.03, spread: 0.4 });
      v.noise({ f0: 3000, f1: 6000, q: 2, dur: 0.4, attack: 0.1, gain: 0.08 });
    } else {
      v.noise({ f0: 5200, f1: 7400, q: 3, dur: 0.16, attack: 0.02, gain: 0.2 });
      v.partials({ base: 1320, ratios: [1, 2.4], dur: 0.35, gain: 0.04 });
    }
  },
  bossRoar(v) {
    v.osc({ type: 'sawtooth', f0: 95, f1: 60, dur: 1.4, attack: 0.15, gain: 0.16, lowpass: 600 });
    v.osc({ type: 'sawtooth', f0: 142, f1: 88, dur: 1.3, attack: 0.2, gain: 0.08, lowpass: 900 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 500, f1: 180, dur: 1.4, attack: 0.15, gain: 0.5 });
  },
  bossStagger(v) {
    v.partials({ base: 330, ratios: [1, 2.76, 5.4], dur: 0.9, gain: 0.12, spread: 0.5 });
    thud(v, 140, 50, 0.35, 0.7);
  },
  bossDefeated(v) {
    thud(v, 70, 24, 1.4, 0.9);
    v.partials({ base: 196, ratios: [1, 1.5, 2, 3], dur: 2.6, gain: 0.06, attack: 0.3 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 400, f1: 80, dur: 1.6, gain: 0.5 });
  },
  // ---- The Bell Colossus (src/boss/colossus)
  /** deep inharmonic bell (minor-third bell partials); variant 'great' = lower, longer */
  bellToll(v) {
    const great = v.variant === 'great';
    const base = great ? 73 : 98;
    const i = Math.max(0.6, v.intensity || 1);
    v.partials({ base, ratios: [0.5, 1, 1.19, 1.5, 2, 2.51, 2.66, 3.01, 4.1], dur: great ? 7 : 5.2, gain: 0.2 * i, attack: 0.004, spread: 0.3 });
    thud(v, 70, 32, 0.5, 0.5 * i);
    v.noise({ color: 'brown', filter: 'lowpass', f0: 600, f1: 150, dur: 0.6, gain: 0.35 * i });
    v.noise({ f0: 2400, f1: 900, q: 1.2, dur: 0.08, gain: 0.25 });
  },
  bellCrack(v) {
    v.partials({ base: 104, ratios: [1, 1.07, 1.9, 2.31, 3.3, 4.7], dur: 2.8, gain: 0.16, attack: 0.003, spread: 0.8, type: 'square' });
    for (let i = 0; i < 9; i++) v.noise({ f0: rnd(1500, 4500), q: 3, dur: rnd(0.02, 0.06), gain: rnd(0.08, 0.2), delay: i * rnd(0.02, 0.06) });
    thud(v, 90, 30, 0.6, 0.7);
  },
  /** the bell hits the ground: a dull clank and a long, wavering ring */
  bellFall(v) {
    thud(v, 60, 22, 1.2, 1.0);
    v.partials({ base: 82, ratios: [0.5, 1, 1.19, 1.5, 2, 2.51, 3.01], dur: 6, gain: 0.22, attack: 0.003, spread: 0.6 });
    v.noise({ color: 'brown', filter: 'lowpass', f0: 500, f1: 90, dur: 1.4, gain: 0.8 });
  },
  /** giant footfall; intensity scales weight */
  colossusStep(v) {
    const i = Math.max(0.4, v.intensity || 1);
    thud(v, 62, 21, 0.9, 0.9 * i);
    v.noise({ color: 'brown', filter: 'lowpass', f0: 280, f1: 60, dur: 1.0, attack: 0.005, gain: 0.7 * i });
    for (let k = 0; k < 4; k++) v.noise({ f0: rnd(1200, 3600), q: 4, dur: 0.04, gain: 0.05 * i, delay: 0.08 + k * rnd(0.05, 0.1) });
  },
  /** steel glancing off stone */
  stoneClang(v) {
    v.partials({ base: rnd(480, 560), ratios: [1, 2.43, 3.9, 5.1], dur: 0.32, gain: 0.07, type: 'square' });
    v.noise({ filter: 'highpass', f0: 3500, dur: 0.05, gain: 0.3 });
    thud(v, 160, 90, 0.07, 0.25);
  },
  stoneShatter(v) {
    const i = Math.max(0.6, v.intensity || 1);
    thud(v, 110, 35, 0.4, 0.7 * i);
    v.noise({ color: 'brown', filter: 'lowpass', f0: 900, f1: 200, dur: 0.6, gain: 0.6 * i });
    for (let k = 0; k < 10; k++) v.noise({ f0: rnd(1500, 5000), q: 4, dur: rnd(0.02, 0.05), gain: rnd(0.05, 0.15), delay: 0.03 + k * rnd(0.03, 0.07) });
  },
  /** low earth rumble (rising from the ground / shudder wind-up) */
  rumble(v) {
    v.noise({ color: 'brown', filter: 'lowpass', f0: 160, f1: 90, dur: 2.0, attack: 0.5, gain: 0.8 });
    v.osc({ type: 'sawtooth', f0: 38, f1: 30, dur: 1.8, attack: 0.4, gain: 0.08, lowpass: 200 });
  },
  fogGate(v) {
    v.noise({ f0: 400, f1: 1600, q: 0.7, dur: 0.9, attack: 0.25, gain: 0.25 });
    v.partials({ base: 262, ratios: [1, 1.5, 2], dur: 1.0, gain: 0.04, attack: 0.2 });
  },
  flask(v) {
    v.partials({ base: 660, ratios: [1, 1.5, 2, 3], dur: 0.8, gain: 0.05, attack: 0.02 });
    v.noise({ f0: 1200, f1: 3000, q: 1, dur: 0.3, attack: 0.05, gain: 0.08 });
  },
  // ---------------------------------------------------------------- ui
  uiClick(v) {
    v.osc({ f0: 1800, f1: 1400, dur: 0.035, gain: 0.1 });
    v.osc({ type: 'triangle', f0: 900, dur: 0.03, gain: 0.04 });
  },
  uiPause(v) {
    const open = v.variant !== 'resume';
    v.osc({ type: 'triangle', f0: open ? 660 : 440, dur: 0.09, gain: 0.07 });
    v.osc({ type: 'triangle', f0: open ? 440 : 660, dur: 0.14, gain: 0.07, delay: 0.07 });
  },
  rankUp(v) {
    const base = 523 * (1 + clamp01(v.intensity) * 0.5);
    v.partials({ base, ratios: [1, 1.25, 1.5, 2], dur: 0.7, gain: 0.05, attack: 0.005 });
  },
} satisfies Record<string, Recipe>;

export type SoundName = keyof typeof Sounds;
