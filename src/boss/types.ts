/**
 * Boss attack data format. Attacks are plain data: a boss lists `AttackDef`s, the
 * `AttackRunner` plays them (animation retiming, movement, telegraph glow/decals, hitboxes),
 * and the `Director` picks which one to use. See src/boss/README.md for a guided reference.
 *
 * Time model — every attack is a list of STEPS (one swing each; strings have several):
 *
 *    | windup (telegraph) | active (hitboxes live) | recovery |  → next step (or attack end)
 *
 * windup  × Difficulty.telegraph()   (story 1.3 / normal 1 / souls 0.85)
 * recovery × Difficulty.recovery()   (only the LAST step's recovery is the punish window;
 *                                     mid-string recoveries are short gaps and are not scaled)
 * Movement segments and decal timings are expressed as fractions of those phases, so they
 * stay correct when difficulty stretches or squeezes a phase.
 */

/** Telegraph colour class — fairness rule #1: gold = parryable, red = unblockable / grab, cyan = magic. */
export type TelegraphKind = 'parryable' | 'unblockable' | 'magic';

/** How the clip is shown during a step. */
export interface StepAnim {
  clip: string;
  /** clip time the windup starts at (skip slow starts) */
  startAt?: number;
  /** clip time of the impact frame: the windup is retimed so this frame lands exactly when `active` begins */
  hitFrame: number;
  /** playback speed after the impact frame (active + recovery) */
  speed?: number;
  fade?: number;
  /**
   * Windup pacing. 'linear' (default) slows/speeds the clip evenly. 'hold' plays the first ~80%
   * of the wind-up quickly, freezes in the raised pose, then snaps through the last bit — this is
   * how a *delayed* hit reads (the Souls "delayed third hit" mixup).
   */
  pacing?: 'linear' | 'hold';
}

export type MovePhase = 'windup' | 'active' | 'recovery';

/** Movement during a step. `from`/`to` are 0..1 fractions of the given phase. */
export type MoveSeg =
  /** dash forward (along facing) `distance` metres; stops `stopAt` metres short of the player */
  | { kind: 'lunge'; during: MovePhase; from?: number; to?: number; distance: number; stopAt?: number }
  /** walk/step backwards `distance` metres */
  | { kind: 'retreat'; during: MovePhase; from?: number; to?: number; distance: number }
  /**
   * Ballistic leap toward the player's position (captured when the leap starts, clamped to
   * `maxDistance`, landing `stopAt` short). Lands exactly at the end of the segment, so put it at
   * the end of the windup to slam on the first active frame.
   */
  | { kind: 'leap'; during: MovePhase; from?: number; to?: number; height: number; maxDistance: number; stopAt?: number }
  /** sidestep `distance` metres (+ = boss's left) */
  | { kind: 'strafe'; during: MovePhase; from?: number; to?: number; distance: number };

/** Turn rate limits (rad/s) toward the player during each phase. 0 = locked in. */
export interface TrackDef {
  windup?: number;
  active?: number;
  recovery?: number;
}

/** Common to every hitbox. */
interface HitboxBase {
  /** seconds after the step's active start before this hitbox goes live (staggered circles, volleys) */
  delay?: number;
  /** how long it stays live; default = the step's active duration (rings/projectiles ignore this) */
  duration?: number;
  /** override step damage / knockback / telegraph for this hitbox */
  damage?: number;
  knockback?: number;
  telegraph?: TelegraphKind;
  /** player feet height range (relative to the boss's feet) that can be hit. Default [-1, 2.6]. A low sweep
   *  with yMax 0.7 can be jumped over. Rings ignore this (they use `grounded`). */
  yMin?: number;
  yMax?: number;
  /** show a ground decal during the windup (default: true for circle, ring, line; false for cone/sweep) */
  decal?: boolean;
}

/** Horizontal cone in front of the boss, evaluated every active frame. */
export interface ConeBox extends HitboxBase {
  shape: 'cone';
  range: number;
  /** full arc in degrees */
  arc: number;
  /** origin pushed forward (m) */
  offset?: number;
}

/** A blade arc that rotates over the active window from `from`° to `to`° (0 = facing, + = boss's left). Hits what it passes. */
export interface SweepBox extends HitboxBase {
  shape: 'sweep';
  range: number;
  from: number;
  to: number;
  /** angular thickness of the blade (deg), default 25 */
  width?: number;
  /** ignore the inner radius (sweeps that miss when you hug the boss) */
  inner?: number;
}

/** Capsule from the boss along a direction (laser / thrust). Can rotate (`yawFrom`→`yawTo`) or track the player. */
export interface LineBox extends HitboxBase {
  shape: 'line';
  length: number;
  width: number;
  /** origin offset along facing */
  offset?: number;
  /** relative yaw at active start / end (deg), default 0 / 0 */
  yawFrom?: number;
  yawTo?: number;
  /** if set, the beam turns toward the player at this rate (rad/s) instead of the yaw sweep */
  trackRate?: number;
  /** keep hitting while live (lasers), with this many seconds between ticks; default: hit once */
  tick?: number;
}

/** AoE disc somewhere on the ground, with a decal that fills during the windup (+ delay). */
export interface CircleBox extends HitboxBase {
  shape: 'circle';
  radius: number;
  /** where: on the boss, in front of it, where the player stands when the centre locks, or the landing
   *  point of this step's leap (set `lockAt` just after the leap segment starts) */
  at: 'self' | 'forward' | 'player' | 'leap';
  /** metres forward (at 'forward') or a fixed offset around the player (at 'player': [x, z] in boss space) */
  distance?: number;
  around?: [number, number];
  /** when to lock the target point: fraction of the windup (default 0 = at windup start — fair) */
  lockAt?: number;
}

/**
 * Expanding shockwave on the ground. Hits only if the player is GROUNDED (≤ 0.35 m above the ground)
 * when the ring's edge passes them — jump over it. Rolls/slides with i-frames also avoid it.
 */
export interface RingBox extends HitboxBase {
  shape: 'ring';
  /** origin: boss feet, or in front of it */
  at?: 'self' | 'forward';
  distance?: number;
  speed: number;
  maxRadius: number;
  /** ring band thickness (m), default 0.7 */
  thickness?: number;
  startRadius?: number;
}

/**
 * Grab: if the player is in the cone during the active window, they are caught (unblockable,
 * not parryable; only i-frames — a well-timed dodge — avoid it). Caught players are held for
 * `hold` seconds then thrown for `damage`.
 */
export interface GrabBox extends HitboxBase {
  shape: 'grab';
  range: number;
  arc: number;
  /** seconds held before the throw */
  hold: number;
  /** clip played while holding / throwing (boss), optional */
  holdClip?: string;
  throwClip?: string;
  /** player is pinned this far in front of the boss, at this height */
  holdOffset?: number;
  holdHeight?: number;
  throwKnockback?: number;
}

/** Fires pooled projectiles. Parry (block-parry style) reflects `reflectable` ones back at the boss. */
export interface ProjectileBox extends HitboxBase {
  shape: 'projectile';
  count?: number;
  /** total fan spread for count > 1 (deg) */
  spread?: number;
  /** seconds between consecutive shots (0 = all at once) */
  interval?: number;
  speed: number;
  /** turn rate toward the player (rad/s), 0 = straight */
  homing?: number;
  lifetime?: number;
  radius?: number;
  reflectable?: boolean;
  /** muzzle height above the boss's feet and forward offset */
  height?: number;
  offset?: number;
  /** aim at the player (default) or along facing */
  aim?: 'player' | 'forward';
  /** damage the boss takes when a reflected shot hits it (default 3× damage) and poise damage */
  reflectDamage?: number;
  reflectPoise?: number;
}

export type HitboxDef = ConeBox | SweepBox | LineBox | CircleBox | RingBox | GrabBox | ProjectileBox;

/** What parrying this step does to the boss. */
export type ParryReaction =
  /** short flinch, cancels the rest of the string (default) */
  | 'recoil'
  /** full stagger (riposte opening) */
  | 'stagger'
  /** only poise damage — the boss keeps going (Sekiro-style deflect) */
  | 'none';

/** One swing. */
export interface AttackStep {
  windup: number;
  active: number;
  /** gap after the active window (last step: the punish window, ~1–1.5 s for big attacks) */
  recovery: number;
  anim?: StepAnim;
  /** clip(s) played at other moments, e.g. a held recovery pose: [phase, clip, options] */
  extraAnims?: { during: MovePhase; at?: number; clip: string; speed?: number; startAt?: number; fade?: number; loop?: boolean }[];
  track?: TrackDef;
  move?: MoveSeg[];
  hitboxes: HitboxDef[];
  damage: number;
  knockback?: number;
  heavy?: boolean;
  /** telegraph colour for this step (default: the attack's) */
  telegraph?: TelegraphKind;
  /** parryable? default: telegraph === 'parryable'. Unblockable: default telegraph === 'unblockable'. */
  parryable?: boolean;
  unblockable?: boolean;
  /** poise damage dealt to the boss when this step is parried (default: boss def `parryPoise`) */
  parryPoise?: number;
  onParry?: ParryReaction;
  /** hyper armour during this step: player hits never interrupt it (bosses default to true) */
  armor?: boolean;
  /** sound/sparkle at the windup start (default true) */
  flash?: boolean;
  /** camera shake on active start (slams) */
  shake?: number;
}

export interface AttackDef {
  id: string;
  /** shown in dev tools only */
  name?: string;
  telegraph: TelegraphKind;
  steps: AttackStep[];
}

/** Read-only view of an attack in progress (hooks, director, HUD, counter). */
export interface AttackProgress {
  def: AttackDef;
  stepIndex: number;
  step: AttackStep;
  phase: MovePhase;
  /** seconds into the current phase */
  phaseTime: number;
  /** scaled durations of the current step */
  windup: number;
  active: number;
  recovery: number;
}
