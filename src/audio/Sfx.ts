import { Vector3, type Camera } from 'three';
import { Sounds, type SoundName } from './sounds';

/**
 * Procedural sound engine (WebAudio, no assets).
 *
 * Graph:  voice → voiceGain → panner ─┬→ world bus → pause lowpass ─┐
 *                                     └→ ui bus ────────────────────┴→ master → compressor → destination
 *
 * Every sound is a *recipe* (see sounds.ts) built from two primitives — enveloped oscillators
 * and filtered noise from pre-rendered buffers — so a new sound is a few lines. Voices are capped,
 * repeated sounds get a little random pitch, and positioned sounds are panned/attenuated
 * relative to the camera.
 */

export interface PlayOpts {
  /** world position (pans + attenuates relative to the camera) */
  pos?: Vector3;
  /** 0..1+ intensity passed to the recipe (e.g. landing impact) */
  intensity?: number;
  /** extra gain multiplier */
  gain?: number;
  /** recipe variant (e.g. echo recall mode) */
  variant?: string;
  /** delay in seconds */
  delay?: number;
  /** route through the UI bus (not muffled while paused, not slowed) */
  ui?: boolean;
  /** source tag for the debug log (event name) */
  from?: string;
}

/** Builder handed to a recipe: schedule layers relative to `t0` into `out`. */
export class VoiceBuilder {
  /** sources scheduled in this voice (for lifetime tracking) */
  readonly sources: AudioScheduledSourceNode[] = [];
  end = 0;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly out: AudioNode,
    readonly t0: number,
    /** global pitch multiplier (random variance × slow-mo) */
    readonly pitch: number,
    private readonly noiseBuf: { white: AudioBuffer; brown: AudioBuffer },
    readonly intensity: number,
    readonly variant: string,
  ) {}

  private envelope(g: GainNode, start: number, attack: number, dur: number, peak: number, hold = 0) {
    const p = g.gain;
    p.setValueAtTime(0.0001, start);
    p.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + Math.max(0.002, attack));
    if (hold > 0) p.setValueAtTime(Math.max(0.0002, peak), start + attack + hold);
    p.exponentialRampToValueAtTime(0.0001, start + Math.max(attack + hold + 0.01, dur));
  }

  private track(src: AudioScheduledSourceNode, start: number, stop: number) {
    src.start(start);
    src.stop(stop + 0.02);
    this.sources.push(src);
    this.end = Math.max(this.end, stop + 0.02);
  }

  /** Enveloped oscillator with an exponential pitch glide f0 → f1. */
  osc(o: {
    type?: OscillatorType;
    f0: number;
    f1?: number;
    dur: number;
    attack?: number;
    hold?: number;
    gain: number;
    delay?: number;
    detune?: number;
    /** glide time (defaults to dur) */
    glide?: number;
    /** optional lowpass on this layer */
    lowpass?: number;
  }) {
    const { ctx } = this;
    const start = this.t0 + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    const f0 = Math.max(20, o.f0 * this.pitch);
    osc.frequency.setValueAtTime(f0, start);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 * this.pitch), start + (o.glide ?? o.dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    this.envelope(g, start, o.attack ?? 0.005, o.dur, o.gain, o.hold);
    let node: AudioNode = osc;
    if (o.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lowpass;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(this.out);
    this.track(osc, start, start + o.dur);
  }

  /** Enveloped filtered noise with a filter sweep f0 → f1. */
  noise(o: {
    color?: 'white' | 'brown';
    filter?: BiquadFilterType;
    f0: number;
    f1?: number;
    q?: number;
    dur: number;
    attack?: number;
    hold?: number;
    gain: number;
    delay?: number;
    /** playback rate of the buffer (coarser / finer grain) */
    rate?: number;
  }) {
    const { ctx } = this;
    const start = this.t0 + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    const buf = this.noiseBuf[o.color ?? 'white'];
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.playbackRate.value = (o.rate ?? 1) * this.pitch;
    const f = ctx.createBiquadFilter();
    f.type = o.filter ?? 'bandpass';
    f.Q.value = o.q ?? 1;
    const top = ctx.sampleRate * 0.45;
    const f0 = Math.min(top, Math.max(30, o.f0 * this.pitch));
    f.frequency.setValueAtTime(f0, start);
    if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.min(top, Math.max(30, o.f1 * this.pitch)), start + o.dur);
    const g = ctx.createGain();
    this.envelope(g, start, o.attack ?? 0.004, o.dur, o.gain, o.hold);
    src.connect(f).connect(g).connect(this.out);
    // random offset so repeated bursts don't share the same grain
    src.start(start, Math.random() * (buf.duration - 0.05));
    src.stop(start + o.dur + 0.02);
    this.sources.push(src);
    this.end = Math.max(this.end, start + o.dur + 0.02);
  }

  /** Inharmonic partial stack (bells, metal, glass). ratios × base, higher partials decay faster. */
  partials(o: { base: number; ratios: number[]; dur: number; gain: number; type?: OscillatorType; delay?: number; attack?: number; spread?: number }) {
    o.ratios.forEach((r, i) => {
      this.osc({
        type: o.type ?? 'sine',
        f0: o.base * r,
        dur: o.dur / (1 + i * (o.spread ?? 0.35)),
        gain: o.gain / (1 + i * 0.5),
        attack: o.attack ?? 0.003,
        delay: o.delay,
        detune: (Math.random() - 0.5) * 8,
      });
    });
  }
}

export type Recipe = (v: VoiceBuilder) => void;

const MAX_VOICES = 28;
const LOW_PRIORITY = new Set<SoundName>(['footstep', 'uiClick']);
const STORAGE_KEY = 'echo-knight.audio.v1';

/** Live audio graph on one context (an AudioContext, or an OfflineAudioContext for tests). */
export class SfxEngine {
  readonly master: GainNode;
  readonly world: GainNode;
  readonly ui: GainNode;
  readonly pauseFilter: BiquadFilterNode;
  private readonly noiseBuf: { white: AudioBuffer; brown: AudioBuffer };
  voices = 0;
  /** pause lowpass cutoff when open (just under Nyquist) */
  readonly open: number;

  constructor(readonly ctx: BaseAudioContext) {
    this.open = ctx.sampleRate * 0.45;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(comp);
    this.pauseFilter = ctx.createBiquadFilter();
    this.pauseFilter.type = 'lowpass';
    this.pauseFilter.frequency.value = this.open;
    this.pauseFilter.Q.value = 0.5;
    this.pauseFilter.connect(this.master);
    this.world = ctx.createGain();
    this.world.connect(this.pauseFilter);
    this.ui = ctx.createGain();
    this.ui.connect(this.master);
    this.noiseBuf = { white: makeNoise(ctx, 'white'), brown: makeNoise(ctx, 'brown') };
  }

  play(recipe: Recipe, opts: { pitch: number; gain: number; pan: number; delay: number; ui: boolean; intensity: number; variant: string }) {
    const { ctx } = this;
    const vg = ctx.createGain();
    vg.gain.value = opts.gain;
    let tail: AudioNode = vg;
    if (opts.pan !== 0 && 'createStereoPanner' in ctx) {
      const p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      vg.connect(p);
      tail = p;
    }
    tail.connect(opts.ui ? this.ui : this.world);
    const v = new VoiceBuilder(ctx, vg, ctx.currentTime + 0.005 + opts.delay, opts.pitch, this.noiseBuf, opts.intensity, opts.variant);
    recipe(v);
    if (!v.sources.length) {
      vg.disconnect();
      return;
    }
    this.voices++;
    let left = v.sources.length;
    const done = () => {
      if (--left > 0) return;
      this.voices--;
      tail.disconnect();
      if (tail !== vg) vg.disconnect();
    };
    for (const s of v.sources) s.onended = done;
  }
}

function makeNoise(ctx: BaseAudioContext, color: 'white' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 1.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'white') d[i] = w;
    else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

export interface SfxLogEntry {
  t: number;
  sound: SoundName;
  from?: string;
  variant?: string;
  played: boolean;
}

/**
 * Game-facing facade: lazy AudioContext (created on the first trusted user gesture, so the
 * browser never warns about autoplay), volume / mute persistence, voice cap, slow-mo pitch,
 * spatialisation, and a debug log of what played for which event.
 */
export class Sfx {
  engine: SfxEngine | null = null;
  private ctx: AudioContext | null = null;
  volume = 0.8;
  muted = false;
  /** pitch multiplier for slow-mo (set by the feature each frame) */
  timePitch = 1;
  camera: Camera | null = null;
  /** log every play() to the console */
  debug = false;
  /** ring buffer of the last plays (always recorded; for tests / debugging) */
  readonly history: SfxLogEntry[] = [];
  private readonly lastPlay = new Map<SoundName, number>();
  private paused = false;
  private readonly tmp = new Vector3();

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (s) {
        this.volume = typeof s.volume === 'number' ? s.volume : this.volume;
        this.muted = !!s.muted;
      }
      this.debug = localStorage.getItem('echo-knight.sfxDebug') === '1' || location.search.includes('sfxdebug');
    } catch {
      /* storage unavailable */
    }
    const unlock = (e: Event) => {
      if (!e.isTrusted) return; // synthetic (debug) events are not user activation
      this.unlock();
    };
    for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, { capture: true });
  }

  get ready() {
    return !!this.engine && this.ctx?.state === 'running';
  }

  /** Create / resume the AudioContext. Call from a user gesture. */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.engine = new SfxEngine(this.ctx);
        this.applyVolume(true);
        this.setPaused(this.paused);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch (err) {
      console.warn('[sfx] audio unavailable', err);
    }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    } catch {
      /* ignore */
    }
  }

  private applyVolume(instant = false) {
    if (!this.engine) return;
    const target = this.muted ? 0 : this.volume * this.volume; // perceptual curve
    const g = this.engine.master.gain;
    if (instant) g.value = target;
    else g.setTargetAtTime(target, this.engine.ctx.currentTime, 0.03);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
    this.save();
    return this.muted;
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.volume > 0) this.muted = false;
    this.applyVolume();
    this.save();
  }

  /** Muffle world sounds while a menu is open (UI clicks stay crisp). */
  setPaused(p: boolean) {
    this.paused = p;
    if (!this.engine) return;
    this.engine.pauseFilter.frequency.setTargetAtTime(p ? 700 : this.engine.open, this.engine.ctx.currentTime, 0.08);
  }

  play(name: SoundName, opts: PlayOpts = {}) {
    const now = performance.now();
    const recipe = Sounds[name];
    let played = false;
    // Don't stack the exact same sound within a few ms (multi-target hits, preset changes).
    const last = this.lastPlay.get(name) ?? -1e9;
    const tooSoon = now - last < (name === 'uiClick' ? 45 : 28);
    if (recipe && !tooSoon) {
      this.lastPlay.set(name, now);
      const eng = this.engine;
      if (eng && this.ctx?.state === 'running' && !this.muted) {
        const overCap = eng.voices >= MAX_VOICES + (LOW_PRIORITY.has(name) ? 0 : 10);
        const lowCut = LOW_PRIORITY.has(name) && eng.voices >= MAX_VOICES * 0.7;
        if (!overCap && !lowCut) {
          const { pan, att } = this.spatial(opts.pos);
          const variance = 1 + (Math.random() - 0.5) * 0.08;
          eng.play(recipe, {
            pitch: variance * (opts.ui ? 1 : this.timePitch),
            gain: (opts.gain ?? 1) * att,
            pan,
            delay: opts.delay ?? 0,
            ui: !!opts.ui,
            intensity: opts.intensity ?? 1,
            variant: opts.variant ?? '',
          });
          played = true;
        }
      }
    }
    const entry: SfxLogEntry = { t: Math.round(now), sound: name, from: opts.from, variant: opts.variant, played };
    this.history.push(entry);
    if (this.history.length > 80) this.history.shift();
    if (this.debug) console.debug(`[sfx] ${name}${opts.variant ? `:${opts.variant}` : ''} <- ${opts.from ?? '?'}${played ? '' : ' (silent)'}`);
  }

  /** Pan by camera-space x, attenuate by distance beyond the player's usual distance. */
  private spatial(pos?: Vector3): { pan: number; att: number } {
    if (!pos || !this.camera) return { pan: 0, att: 1 };
    const v = this.tmp.copy(pos).applyMatrix4(this.camera.matrixWorldInverse);
    const d = v.length();
    const pan = Math.max(-0.8, Math.min(0.8, (v.x / (d + 0.5)) * 1.2));
    const att = 1 / (1 + Math.max(0, d - 6) / 10);
    return { pan, att };
  }
}

/**
 * Test helper: render one recipe offline and measure it (no speakers, no user gesture needed).
 * Returns peak / rms so a broken recipe (silence, NaN, clipping) is easy to spot.
 */
export async function renderSound(name: SoundName, variant = '', intensity = 1) {
  const sr = 22050;
  const ctx = new OfflineAudioContext(2, sr * 2, sr);
  const eng = new SfxEngine(ctx);
  eng.play(Sounds[name], { pitch: 1, gain: 1, pan: 0, delay: 0, ui: false, intensity, variant });
  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);
  let peak = 0;
  let sum = 0;
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (Number.isNaN(a)) return { name, peak: NaN, rms: NaN, length: 0 };
    if (a > peak) peak = a;
    sum += a * a;
    if (a > 0.001) last = i;
  }
  return { name, variant, peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4), length: +(last / sr).toFixed(2) };
}
