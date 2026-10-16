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
