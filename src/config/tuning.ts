/**
 * Every gameplay number lives here so feel can be tuned without touching logic.
 * Units: metres, seconds, radians unless noted.
 */

export interface ComboStep {
  clip: string;
  /** playback speed of the clip */
  speed: number;
  /** clip-time (s) to start from — skips slow wind-ups */
  clipStart: number;
  // All timings below are in *real* seconds from the start of the attack.
  /** forward lunge window and distance */
  lunge: { start: number; end: number; distance: number };
  /** when the hit is evaluated (ignored for slams: they hit on landing) */
  hitAt: number;
  /** sword-trail window */
  trail: [number, number];
  /** from here the next attack input chains */
  chainAt: number;
  /** from here dodge / jump / echo can cancel the attack */
  cancelAt: number;
  /** from here movement input breaks out of recovery */
  moveCancelAt: number;
  /** attack ends */
  end: number;
  hit: { range: number; arcDeg: number; damage: number; knockback: number };
  /** Riven-Q3 style hop that turns the attack into a slam on landing */
  leap?: { at: number; vy: number };
  aoe?: { radius: number; damage: number; knockback: number };
}

export const Tuning = {
  player: {
    height: 1.85,
    radius: 0.45,
    walkSpeed: 2.4,
    runSpeed: 6.2,
    sprintSpeed: 9.0,
    accel: 55,
    decel: 38,
    /** exponential turn rate toward move direction */
    turnRate: 18,
    stepHeight: 0.45,
    groundSnap: 0.4,
  },

  jump: {
    velocity: 10.5,
    gravity: 30,
    fallGravityMul: 1.55,
    /** extra gravity while rising with the button released (variable jump height) */
    lowJumpGravityMul: 2.3,
    maxFallSpeed: 38,
    coyoteTime: 0.12,
    bufferTime: 0.15,
    airAccel: 22,
    airTurnRate: 7,
  },

  dodge: {
    duration: 0.5,
    distance: 5.6,
    iframes: [0.03, 0.36] as [number, number],
    /** jump / attack / dodge may cancel the roll from here */
    cancelAt: 0.34,
    backstepDistance: 3.0,
    backstepDuration: 0.36,
    /** procedural somersault layered over the dodge clip */
    flip: true,
  },

  airDash: {
    duration: 0.2,
    speed: 23,
    /** horizontal speed kept after the dash */
    exitSpeed: 8.5,
    /** small upward pop so the dash never feels like it drops you */
    exitVy: 1.5,
    charges: 1,
    afterimageInterval: 0.03,
  },

  combo: {
    /** time after an attack ends during which the next press continues the chain */
    resetWindow: 0.85,
    inputBuffer: 0.3,
    steps: [
      {
        clip: '1H_Melee_Attack_Slice_Diagonal',
        speed: 1.75,
        clipStart: 0.12,
        lunge: { start: 0.0, end: 0.16, distance: 2.0 },
        hitAt: 0.17,
        trail: [0.08, 0.3],
        chainAt: 0.2,
        cancelAt: 0.2,
        moveCancelAt: 0.38,
        end: 0.5,
        hit: { range: 2.8, arcDeg: 150, damage: 12, knockback: 3 },
      },
      {
        clip: '1H_Melee_Attack_Slice_Horizontal',
        speed: 1.75,
        clipStart: 0.15,
        lunge: { start: 0.0, end: 0.16, distance: 2.0 },
        hitAt: 0.18,
        trail: [0.06, 0.3],
        chainAt: 0.22,
        cancelAt: 0.22,
        moveCancelAt: 0.4,
        end: 0.52,
        hit: { range: 2.8, arcDeg: 170, damage: 14, knockback: 3 },
      },
      {
        clip: '1H_Melee_Attack_Chop',
        speed: 1.25,
        clipStart: 0.0,
        lunge: { start: 0.02, end: 0.42, distance: 3.6 },
        hitAt: 0.42,
        trail: [0.18, 0.5],
        chainAt: 0.7,
        cancelAt: 0.5,
        moveCancelAt: 0.62,
        end: 0.8,
        hit: { range: 2.8, arcDeg: 120, damage: 10, knockback: 2 },
        leap: { at: 0.04, vy: 7.2 },
        aoe: { radius: 4.2, damage: 28, knockback: 9 },
      },
    ] as ComboStep[],
  },

  plunge: {
    hang: 0.08,
    speed: 26,
    aoe: { radius: 3.4, damage: 22, knockback: 7 },
    recovery: 0.32,
  },

  echo: {
    lifetime: 6,
    flickerLast: 1.5,
    cooldown: 1.2,
    /** short lockout after placing so a double-tap doesn't instantly recall */
    armDelay: 0.2,
  },

  camera: {
    distance: 6.2,
    minDistance: 1.4,
    pivotHeight: 1.55,
    fov: 58,
    mouseSensitivity: 0.0022,
    stickSpeed: 3.2, // rad/s at full deflection
    pitchMin: -0.45,
    pitchMax: 1.15,
    followSharpness: 14,
    verticalFollowSharpness: 7,
  },

  feel: {
    hitstop: 0.065,
    hitstopHeavy: 0.12,
  },

  // ---------------------------------------------------------------- movement kit (movement stream)
  movement: {
    /** collision body height (World.resolveCollisions); slides temporarily lower it */
    bodyHeight: 1.6,
    /** air-jump velocity multipliers (2nd, 3rd jump) */
    airJumpScale: [0.9, 0.82],
    /** front-flip duration on air jumps */
    airJumpFlip: 0.42,
    /** eight-way air dash: vertical angle when holding jump (up) / sprint (down) */
    dashUpAngle: (35 * Math.PI) / 180,
    dashDownAngle: (35 * Math.PI) / 180,

    slide: {
      /** minimum horizontal speed to slide instead of roll (sprinting always qualifies) */
      minSpeed: 7.0,
      startSpeed: 12.5,
      duration: 0.6,
      /** speed decay per second (exponential) */
      friction: 1.1,
      /** extra acceleration along a downhill slope (m/s² per unit of slope) */
      slopeAccel: 26,
      /** keeps sliding downhill while above this speed, up to maxDuration */
      keepSpeed: 7,
      maxDuration: 1.6,
      /** forced crawl speed while something is overhead */
      ceilingSpeed: 4.5,
      bodyHeight: 0.8,
      steer: 2.5,
      /** jumps / attacks may cancel from here */
      cancelAt: 0.12,
    },

    longJump: {
      speed: 14,
      velocity: 9.5,
    },

    wallRun: {
      minSpeed: 4.0,
      minAlong: 3.0,
      speed: 8.5,
      maxTime: 1.2,
      /** gravity scale ramps from start to end over the run */
      gravity: [0.12, 0.7] as [number, number],
      startVy: 2.2,
      minWallHeight: 2.5,
      /** probe distance from the body surface */
      reach: 0.35,
      kickOut: 6.5,
      kickUp: 10,
      kickAlong: 0.55,
      /** same wall can't be re-used for this long (seconds of airtime) */
      wallCooldown: 0.55,
      releaseGrace: 0.15,
    },

    ledge: {
      /** ledge top relative to feet: [min, max] */
      reach: [0.55, 2.45] as [number, number],
      /** below this a grab becomes a quick vault */
      vaultBelow: 1.15,
      /** feet below the ledge top while hanging */
      hangDrop: 1.65,
      probe: 0.35,
      climbTime: 0.42,
      vaultTime: 0.28,
      shimmySpeed: 1.6,
      dropCooldown: 0.4,
      kickOut: 5.5,
      kickUp: 9.5,
      /** max upward speed at which a grab can happen */
      maxVy: 2.5,
    },
  },
};

// ====================================================================== combat (offense stream)

/** Input notation for combo-graph edges: L = light (attack), H = heavy. */
export type ComboInput = 'L' | 'H';

/**
 * One node of the combo graph. Same timing model as `ComboStep` (all times are real seconds
 * from the start of the move), plus optional extras.
 */
export interface MoveDef extends ComboStep {
  /** heavy hit: bigger hitstop / shake, `heavy: true` on the HitInfo */
  heavy?: boolean;
  /** additional swing evaluations (multi-hit) at these times */
  extraHits?: number[];
  /** extra HitInfo fields: launch (vertical velocity, negative = spike down), stagger, guardBreak */
  effect?: { launch?: number; stagger?: number; guardBreak?: boolean };
  /** ground shockwave (doSlam with `aoe`) at this time, without a leap */
  slamAt?: number;
  /** player hop at `at`: vertical velocity and horizontal speed along facing (negative = backwards) */
  hop?: { at: number; vy: number; forward: number };
  /** procedural body pose layered on the clip */
  pose?: 'backflip' | 'low' | 'rise' | 'dive';
  /** loadout toggle this move needs; when off the graph resolves to `fallback` instead */
  requires?: string;
  fallback?: string;
  /** holding heavy through the wind-up turns this move into a charge (combat.chargeHeavy) */
  chargeable?: boolean;
  /** aerial move: gravity scale while active and the upward pop on enter */
  air?: { gravity: number; pop: number };
  /** override hitstop (seconds) / camera shake for this move */
  hitstop?: number;
  shake?: number;
}

/** Light-chain moves come from `Tuning.combo.steps` (unchanged); everything else lives here. */
export const CombatTuning = {
  /** combo graph edges by input; 'root' = first press on the ground, 'airRoot' = first air press */
  edges: {
    root: { L: 'light1', H: 'heavy1' },
    light1: { L: 'light2', H: 'spinSlash' },
    light2: { L: 'slam', H: 'launcher' },
    heavy1: { H: 'heavy2' },
    heavy2: { H: 'heavy3' },
    airRoot: { L: 'air1' },
    air1: { L: 'air2' },
    air2: { L: 'airSpike' },
  } as Record<string, Partial<Record<ComboInput, string>>>,

  moves: {
    // ---------------------------------------------------------------- heavy string
    heavy1: {
      clip: '2H_Melee_Attack_Chop', speed: 1.1, clipStart: 0.25, heavy: true, chargeable: true,
      lunge: { start: 0.22, end: 0.48, distance: 1.6 },
      hitAt: 0.5, trail: [0.36, 0.62], chainAt: 0.5, cancelAt: 0.6, moveCancelAt: 0.8, end: 0.95,
      hit: { range: 3.0, arcDeg: 110, damage: 24, knockback: 6 },
      effect: { stagger: 0.5 },
    },
    heavy2: {
      clip: 'Unarmed_Melee_Attack_Kick', speed: 1.25, clipStart: 0.1, heavy: true,
      lunge: { start: 0.0, end: 0.2, distance: 1.8 },
      hitAt: 0.22, trail: [0, 0], chainAt: 0.3, cancelAt: 0.36, moveCancelAt: 0.5, end: 0.62,
      hit: { range: 2.6, arcDeg: 90, damage: 14, knockback: 9 },
      effect: { guardBreak: true, stagger: 0.9 },
    },
    heavy3: {
      clip: '2H_Melee_Attack_Slice', speed: 1.0, clipStart: 0.05, heavy: true,
      lunge: { start: 0.05, end: 0.36, distance: 2.4 },
      hitAt: 0.4, trail: [0.18, 0.62], chainAt: 9, cancelAt: 0.62, moveCancelAt: 0.8, end: 1.0,
      hit: { range: 3.2, arcDeg: 220, damage: 26, knockback: 8 },
      slamAt: 0.42, aoe: { radius: 3.4, damage: 12, knockback: 10 },
      effect: { stagger: 0.8 },
    },
    // ---------------------------------------------------------------- string branches
    spinSlash: {
      clip: '2H_Melee_Attack_Spin', speed: 1.7, clipStart: 0.7, heavy: true,
      lunge: { start: 0.05, end: 0.35, distance: 2.4 },
      hitAt: 0.34, trail: [0.16, 0.52], chainAt: 9, cancelAt: 0.5, moveCancelAt: 0.7, end: 0.9,
      hit: { range: 3.1, arcDeg: 360, damage: 20, knockback: 6 },
      effect: { stagger: 0.5 },
    },
    launcher: {
      // 2H chop played backwards = rising uppercut
      clip: '2H_Melee_Attack_Chop', speed: -1.7, clipStart: 1.0, heavy: true,
      requires: 'combat.launcher', fallback: 'heavy1',
      lunge: { start: 0.0, end: 0.14, distance: 1.4 },
      hitAt: 0.16, trail: [0.04, 0.3], chainAt: 9, cancelAt: 0.24, moveCancelAt: 0.5, end: 0.62,
      hit: { range: 2.8, arcDeg: 120, damage: 14, knockback: 1 },
      effect: { launch: 12, stagger: 1.4 },
      hop: { at: 0.12, vy: 2.5, forward: 0 },
      pose: 'rise',
    },
    // ---------------------------------------------------------------- directional
    lungeStab: {
      clip: '2H_Melee_Attack_Stab', speed: 1.5, clipStart: 0.12, heavy: true,
      requires: 'combat.directional', fallback: 'heavy1',
      lunge: { start: 0.0, end: 0.24, distance: 6.5 },
      hitAt: 0.2, trail: [0.06, 0.34], chainAt: 9, cancelAt: 0.38, moveCancelAt: 0.55, end: 0.7,
      hit: { range: 3.4, arcDeg: 70, damage: 22, knockback: 7 },
      effect: { stagger: 0.6 },
    },
    backflip: {
      clip: '1H_Melee_Attack_Slice_Horizontal', speed: 1.6, clipStart: 0.12,
      requires: 'combat.directional', fallback: 'light1',
      lunge: { start: 0, end: 0, distance: 0 },
      hitAt: 0.12, trail: [0.04, 0.3], chainAt: 9, cancelAt: 0.42, moveCancelAt: 0.5, end: 0.62,
      hit: { range: 2.9, arcDeg: 180, damage: 12, knockback: 4 },
      hop: { at: 0.02, vy: 6.8, forward: -6.5 },
      pose: 'backflip',
    },
    // ---------------------------------------------------------------- dodge attack (roll)
    sweep: {
      clip: '2H_Melee_Attack_Slice', speed: 1.5, clipStart: 0.12,
      requires: 'combat.dodgeAttacks', fallback: 'light1',
      lunge: { start: 0.0, end: 0.18, distance: 2.4 },
      hitAt: 0.2, trail: [0.06, 0.38], chainAt: 9, cancelAt: 0.38, moveCancelAt: 0.5, end: 0.62,
      hit: { range: 3.0, arcDeg: 240, damage: 12, knockback: 3 },
      effect: { launch: 5, stagger: 0.8 },
      pose: 'low',
    },
    // ---------------------------------------------------------------- air string
    air1: {
      clip: '1H_Melee_Attack_Slice_Diagonal', speed: 1.75, clipStart: 0.12,
      lunge: { start: 0.0, end: 0.12, distance: 1.0 },
      hitAt: 0.15, trail: [0.06, 0.28], chainAt: 0.18, cancelAt: 0.24, moveCancelAt: 9, end: 0.42,
      hit: { range: 2.8, arcDeg: 160, damage: 10, knockback: 1 },
      effect: { launch: 4.5, stagger: 0.8 },
      air: { gravity: 0.12, pop: 3.0 },
    },
    air2: {
      clip: '1H_Melee_Attack_Slice_Horizontal', speed: 1.75, clipStart: 0.15,
      lunge: { start: 0.0, end: 0.12, distance: 1.0 },
      hitAt: 0.16, trail: [0.05, 0.3], chainAt: 0.2, cancelAt: 0.26, moveCancelAt: 9, end: 0.44,
      hit: { range: 2.8, arcDeg: 170, damage: 11, knockback: 1 },
      effect: { launch: 4.5, stagger: 0.8 },
      air: { gravity: 0.12, pop: 2.5 },
    },
    airSpike: {
      clip: '1H_Melee_Attack_Chop', speed: 1.4, clipStart: 0.2, heavy: true,
      lunge: { start: 0.0, end: 0.1, distance: 0.8 },
      hitAt: 0.22, trail: [0.08, 0.34], chainAt: 9, cancelAt: 0.34, moveCancelAt: 9, end: 0.5,
      hit: { range: 3.0, arcDeg: 150, damage: 18, knockback: 2 },
      effect: { launch: -18, stagger: 1.0 }, shake: 0.45,
      air: { gravity: 0.15, pop: 2.0 },
      pose: 'dive',
    },
    // ---------------------------------------------------------------- charged heavy releases (tiers 1-3)
    charged1: {
      clip: '2H_Melee_Attack_Chop', speed: 1.4, clipStart: 0.58, heavy: true,
      lunge: { start: 0.0, end: 0.16, distance: 2.0 },
      hitAt: 0.16, trail: [0.0, 0.3], chainAt: 9, cancelAt: 0.4, moveCancelAt: 0.55, end: 0.7,
      hit: { range: 3.2, arcDeg: 120, damage: 34, knockback: 8 },
      effect: { stagger: 0.8 },
    },
    charged2: {
      clip: '2H_Melee_Attack_Chop', speed: 1.4, clipStart: 0.58, heavy: true,
      lunge: { start: 0.0, end: 0.16, distance: 2.6 },
      hitAt: 0.16, trail: [0.0, 0.3], chainAt: 9, cancelAt: 0.4, moveCancelAt: 0.55, end: 0.75,
      hit: { range: 3.4, arcDeg: 130, damage: 48, knockback: 10 },
      effect: { stagger: 1.0 }, hitstop: 0.16, shake: 0.5,
    },
    charged3: {
      clip: '2H_Melee_Attack_Chop', speed: 1.4, clipStart: 0.58, heavy: true,
      lunge: { start: 0.0, end: 0.16, distance: 3.0 },
      hitAt: 0.16, trail: [0.0, 0.3], chainAt: 9, cancelAt: 0.45, moveCancelAt: 0.6, end: 0.85,
      hit: { range: 3.6, arcDeg: 140, damage: 70, knockback: 12 },
      slamAt: 0.17, aoe: { radius: 5.5, damage: 30, knockback: 13 },
      effect: { guardBreak: true, stagger: 1.4 }, hitstop: 0.2, shake: 0.7,
    },
  } as Record<string, MoveDef>,

  /** light + heavy pressed within this many seconds = whirlwind */
  simultaneousWindow: 0.09,
  /** stick-vs-facing dot product for directional attacks (forward > x, back < -x) */
  directionalDot: 0.6,

  charge: {
    /** hold heavy this long to start charging */
    holdTime: 0.28,
    /** seconds of charging to reach tier 1 / 2 / 3 */
    tierTimes: [0, 0.45, 1.0],
    walkSpeed: 1.3,
    /** sword-trail colour per tier */
    colors: [[2.4, 1.3, 0.5], [2.8, 2.2, 0.9], [1.4, 2.4, 3.2]] as [number, number, number][],
  },

  spin: {
    clip: '2H_Melee_Attack_Spinning',
    clipSpeed: 1.5,
    duration: 1.2,
    hitInterval: 0.2,
    moveSpeed: 4.2,
    hit: { range: 2.7, arcDeg: 360, damage: 7, knockback: 2.5 },
    cancelAt: 0.3,
  },

  dashStrike: {
    clip: '1H_Melee_Attack_Stab',
    clipStart: 0.35,
    clipSpeed: 1.6,
    speed: 22,
    duration: 0.26,
    radius: 1.5,
    damage: 18,
    knockback: 5,
    exitSpeed: 7,
  },

  air: {
    /** a target within this horizontal / vertical distance enables air slashes (instead of plunge) */
    nearRange: 3.6,
    nearHeight: 3.0,
    /** after a launcher hit, air slashes are allowed for this long without a nearby target */
    launchWindow: 2.0,
    /** the jump that follows a launcher goes this much higher */
    launchJumpVy: 13.5,
    maxHits: 3,
  },

  lockOn: {
    range: 20,
    breakRange: 25,
    /** camera yaw offset so the player doesn't cover the target */
    yawOffset: 0.12,
    pitch: 0.24,
    sharpness: 8,
    /** accumulated look input (rad) that counts as a target-switch flick */
    flickThreshold: 0.09,
    switchCooldown: 0.3,
    strafeSpeed: 4.2,
    walkBackSpeed: 2.6,
  },
};
