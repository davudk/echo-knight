/**
 * The Bell Colossus's keyframed poses. The rig (rig.ts) is a procedural skeleton driven by a
 * handful of numbers; a "clip" is a list of keyframes over those numbers. The AttackRunner
 * drives clips exactly like KayKit clips (it sets `time` so `hitFrame` lands on the active frame).
 *
 * Body space: origin between the feet on the ground, +z = forward, +x = the giant's LEFT
 * (the game's yaw convention: relative angles + = left). The hammer is in the RIGHT hand (x < 0).
 *
 *  rise   whole-body vertical offset (buried intro: negative)
 *  hip    pelvis height (stand 5.3, kneel 2.9)
 *  pz     pelvis forward offset
 *  lean   chest forward offset (shoulders / bell move forward)
 *  drop   torso sinks into the belt (bowing)
 *  twist  torso yaw (rad, + = turns left)
 *  tilt   bell head forward offset (the toll "nod": back = negative)
 *  lf/rf  foot (sole) targets, body space
 *  lh/rh  hand targets RELATIVE TO THE SHOULDER, in the twisted torso frame
 *  ham    hammer handle direction (hand → head), twisted torso frame (normalised by the rig)
 */
export type V3 = [number, number, number];

export interface Pose {
  rise: number;
  hip: number;
  pz: number;
  lean: number;
  drop: number;
  twist: number;
  tilt: number;
  lf: V3;
  rf: V3;
  lh: V3;
  rh: V3;
  ham: V3;
}

export type Ease = 'linear' | 'smooth' | 'in' | 'out';

export interface ClipDef {
  name: string;
  duration: number;
  loop: boolean;
  /** resolved keyframes (every key is a full pose) */
  keys: { t: number; pose: Pose; ease: Ease }[];
  /** named moments (sounds, intro toll) */
  marks?: { t: number; name: string }[];
}

export const STAND: Pose = {
  rise: 0, hip: 5.3, pz: 0, lean: 0.3, drop: 0, twist: 0, tilt: 0,
  lf: [1.35, 0, 0.35], rf: [-1.35, 0, -0.15],
  lh: [0.5, -4.5, 0.7], rh: [-0.6, -4.0, 1.3], ham: [0, -1, 0.12],
};

export const KNEEL: Pose = {
  rise: 0, hip: 2.6, pz: 0.2, lean: 0.5, drop: 1.0, twist: 0, tilt: 0.5,
  lf: [1.4, 0.1, -2.2], rf: [-1.45, 0, 1.6],
  lh: [1.2, -4.0, 0.2], rh: [-1.2, -3.6, 0.6], ham: [-0.2, -1, 0.15],
};

const BURIED: Partial<Pose> = { ...KNEEL, rise: -6.2, lean: 1.6, tilt: 0.9 };

/** Hammer resting on the ground in front (after a slam / leap): the climbable ramp. */
const SLAM_REST: Partial<Pose> = {
  hip: 3.9, pz: 0.3, lean: 1.6, drop: 0.8, twist: 0, tilt: 0.3,
  lf: [1.5, 0, 1.4], rf: [-1.5, 0, -0.9],
  lh: [0.6, -4.0, 1.6], rh: [-0.4, -4.5, 4.0], ham: [0, -0.3, 0.95],
};

type Key = [number, Partial<Pose>, Ease?];

function mirror(p: Partial<Pose>): Partial<Pose> {
  const o: Partial<Pose> = { ...p };
  if (p.lf) o.rf = [-p.lf[0], p.lf[1], p.lf[2]];
  if (p.rf) o.lf = [-p.rf[0], p.rf[1], p.rf[2]];
  if (!p.lf) delete o.rf;
  if (!p.rf) delete o.lf;
  if (p.twist !== undefined) o.twist = -p.twist;
  return o;
}

function clip(name: string, duration: number, loop: boolean, keys: Key[], marks?: { t: number; name: string }[], base: Pose = STAND): ClipDef {
  let prev: Pose = base;
  const out: ClipDef['keys'] = [];
  for (const [t, part, ease] of keys) {
    const pose: Pose = { ...prev, ...part };
    out.push({ t, pose, ease: ease ?? 'smooth' });
    prev = pose;
  }
  return { name, duration, loop, keys: out, marks };
}

const S = STAND;

export const Clips: ClipDef[] = [
  // ------------------------------------------------------------------ locomotion
  clip('idle', 4, true, [
    [0, {}],
    [2, { hip: 5.18, lean: 0.4, tilt: 0.06, lh: [0.5, -4.4, 0.8] }],
    [4, {}],
  ]),
  // planted feet slide back at ~1.67 m/s (clip speed is scaled to the velocity)
  clip('walk', 2.4, true, [
    [0, { lf: [1.35, 0, 1.0], rf: [-1.35, 0, -1.0], hip: 5.15, twist: 0.06, lh: [0.5, -4.4, 1.2] }],
    [0.3, { lf: [1.35, 0, 0.5], rf: [-1.35, 1.1, -0.5], hip: 5.35 }, 'linear'],
    [0.9, { lf: [1.35, 0, -0.5], rf: [-1.35, 0.9, 0.7] }, 'linear'],
    [1.2, { lf: [1.35, 0, -1.0], rf: [-1.35, 0, 1.0], hip: 5.15, twist: -0.06, lh: [0.5, -4.4, 0.2] }, 'linear'],
    [1.5, { lf: [1.35, 1.1, -0.5], rf: [-1.35, 0, 0.5], hip: 5.35 }, 'linear'],
    [2.1, { lf: [1.35, 0.9, 0.7], rf: [-1.35, 0, -0.5] }, 'linear'],
    [2.4, { lf: [1.35, 0, 1.0], rf: [-1.35, 0, -1.0], hip: 5.15, twist: 0.06, lh: [0.5, -4.4, 1.2] }, 'linear'],
  ]),

  // ------------------------------------------------------------------ reactions
  // engage / phase change: arms out, the bell rears back and tolls
  clip('roar', 2.4, false, [
    [0, {}],
    [0.8, { hip: 5.6, lean: -0.2, tilt: -0.7, lh: [1.8, -1.4, 1.0], rh: [-1.8, -1.8, 1.0], ham: [-0.3, 0.6, 0.5] }],
    [1.0, { tilt: 0.45, lean: 0.6, hip: 5.2 }, 'in'],
    [1.7, { tilt: 0.3 }],
    [2.4, {}],
  ], [{ t: 1.0, name: 'toll' }]),
  // intro: rises out of the earth, then tolls
  clip('rise', 4.4, false, [
    [0, {}],
    [2.8, { ...KNEEL }, 'out'],
    [3.5, { ...S, hip: 5.6, lean: -0.2, tilt: -0.7, lh: [1.8, -1.4, 1.0], rh: [-1.8, -1.8, 1.0], ham: [-0.3, 0.6, 0.5] }],
    [3.7, { tilt: 0.45, lean: 0.6, hip: 5.2 }, 'in'],
    [4.4, { ...S }],
  ], [{ t: 3.7, name: 'toll' }], { ...STAND, ...BURIED }),
  clip('buried', 1, true, [[0, {}], [1, {}]], undefined, { ...STAND, ...BURIED }),
  // poise break: drops to one knee (base plays it at half speed); held
  clip('kneel', 1.0, false, [
    [0, {}],
    [0.45, { ...KNEEL, hip: 2.4, tilt: 0.7 }, 'in'],
    [1.0, { ...KNEEL }],
  ], [{ t: 0.45, name: 'kneel' }]),
  // riposte: slumps forward, then stands up again
  clip('knockdown', 2.6, false, [
    [0, { ...KNEEL }],
    [0.35, { ...KNEEL, hip: 2.3, lean: 2.0, tilt: 1.0, drop: 1.4 }, 'in'],
    [1.5, {}],
    [2.6, { ...S }],
  ], undefined, { ...STAND, ...KNEEL }),
  clip('flinch', 0.8, false, [
    [0, {}],
    [0.3, { lean: -0.3, tilt: -0.45, twist: 0.2, hip: 5.0 }],
    [0.8, {}],
  ]),

  // ------------------------------------------------------------------ attacks (hit frame noted)
  // stomp (right foot) — hit 1.15
  clip('stompR', 2.2, false, [
    [0, {}],
    [0.9, { rf: [-1.35, 3.0, 1.2], hip: 5.6, lean: 0, twist: -0.15, tilt: -0.25, lh: [1.2, -3.0, 0.8] }],
    [1.0, { rf: [-1.35, 3.15, 1.3] }],
    [1.15, { rf: [-1.35, 0, 1.4], hip: 5.0, lean: 0.6, tilt: 0.3 }, 'in'],
    [2.2, { ...S, rf: [-1.35, 0, 0.6] }],
  ]),
  // stomp (left foot) — hit 1.15
  clip('stompL', 2.2, false, [
    [0, {}],
    [0.9, mirror({ rf: [-1.35, 3.0, 1.2], hip: 5.6, lean: 0, twist: -0.15, tilt: -0.25 })],
    [1.0, { lf: [1.35, 3.15, 1.3] }],
    [1.15, { lf: [1.35, 0, 1.4], hip: 5.0, lean: 0.6, tilt: 0.3 }, 'in'],
    [2.2, { ...S, lf: [1.35, 0, 0.8] }],
  ]),
  // march step (phase 3) — hit 0.55
  clip('marchR', 1.0, false, [
    [0, { lf: [1.35, 0, 0.6], rf: [-1.35, 0, -0.8] }],
    [0.4, { rf: [-1.35, 1.8, 0.5], hip: 5.5, tilt: -0.15, twist: -0.1 }],
    [0.55, { rf: [-1.35, 0, 1.0], hip: 5.0, tilt: 0.2 }, 'in'],
    [1.0, { lf: [1.35, 0, -0.6], rf: [-1.35, 0, 0.6], hip: 5.2 }],
  ]),
  clip('marchL', 1.0, false, [
    [0, { rf: [-1.35, 0, 0.6], lf: [1.35, 0, -0.8] }],
    [0.4, { lf: [1.35, 1.8, 0.5], hip: 5.5, tilt: -0.15, twist: 0.1 }],
    [0.55, { lf: [1.35, 0, 1.0], hip: 5.0, tilt: 0.2 }, 'in'],
    [1.0, { rf: [-1.35, 0, -0.6], lf: [1.35, 0, 0.6], hip: 5.2 }],
  ]),
  // overhead hammer slam — hit 1.6; the hammer rests until 4.4, then lifts
  clip('slam', 5.2, false, [
    [0, {}],
    [1.1, { hip: 5.7, lean: -0.3, tilt: -0.35, twist: -0.1, lf: [1.35, 0, 0.9], rh: [-0.5, 1.9, -0.3], ham: [0, 0.75, -0.65], lh: [1.0, -3.0, 0.4] }],
    [1.35, { rh: [-0.5, 2.0, -0.5], ham: [0, 0.9, -0.45] }],
    [1.6, { ...SLAM_REST }, 'in'],
    [1.8, { hip: 4.0, tilt: 0.2 }],
    [3.1, { hip: 3.9, tilt: 0.3 }],
    [4.4, { hip: 4.0 }],
    [5.2, { ...S }],
  ]),
  // low hammer sweep right → left (jump / slide / roll) — hit 1.3, swing until 1.9
  clip('sweep', 2.9, false, [
    [0, {}],
    [1.2, { twist: -1.0, hip: 4.0, drop: 0.5, lean: 0.5, lf: [1.7, 0, 0.9], rf: [-1.7, 0, -0.3], rh: [-0.8, -5.0, 2.6], ham: [-0.5, -0.3, 0.8], lh: [1.4, -3.4, 0.4] }],
    [1.3, { twist: -0.75 }, 'in'],
    [1.6, { twist: 0.1, rh: [1.0, -5.0, 2.9], ham: [0.2, -0.3, 0.9] }, 'linear'],
    [1.9, { twist: 0.9, rh: [2.8, -5.0, 2.0], ham: [0.8, -0.3, 0.4] }, 'linear'],
    [2.9, { ...S }],
  ]),
  // left backhand at chest height (gold) — hit 1.05, through 1.45
  clip('backhand', 2.4, false, [
    [0, {}],
    [0.95, { twist: 0.6, hip: 4.4, drop: 0.4, lean: 1.0, lh: [2.6, -4.2, -1.2], tilt: -0.2 }],
    [1.05, { twist: 0.35, lh: [2.2, -5.2, 1.6] }, 'in'],
    [1.25, { twist: 0, lh: [0.4, -5.4, 2.6] }, 'linear'],
    [1.45, { twist: -0.45, lh: [-2.4, -5.0, 2.0] }, 'linear'],
    [2.4, { ...S }],
  ]),
  // bell toll (cyan wave) — hit 1.35
  clip('toll', 2.6, false, [
    [0, {}],
    [1.2, { tilt: -0.85, lean: -0.4, hip: 5.6, lh: [1.8, -2.5, 0.4], rh: [-1.4, -3.6, 0.9] }],
    [1.35, { tilt: 0.65, lean: 0.8, hip: 5.0 }, 'in'],
    [2.6, {}],
  ]),
  // arena-wide double toll (phase 3) — hit 1.8, second toll 2.6
  clip('greatToll', 3.8, false, [
    [0, {}],
    [1.6, { tilt: -1.05, lean: -0.6, hip: 6.0, lh: [2.6, -0.5, 0.5], rh: [-2.0, -1.5, 0.8], ham: [-0.6, 0.6, 0.5] }],
    [1.8, { tilt: 0.75, lean: 1.0, hip: 4.7 }, 'in'],
    [2.4, { tilt: -0.6, lean: -0.2, hip: 5.4 }],
    [2.6, { tilt: 0.7, lean: 0.9, hip: 4.8 }, 'in'],
    [3.8, { ...S }],
  ], [{ t: 2.6, name: 'toll2' }]),
  // full-body shudder (throws climbers off) — hit 1.7
  clip('shakeoff', 3.0, false, [
    [0, {}],
    [1.6, { hip: 4.6, lean: 0.2, tilt: 0.15, lh: [1.3, -3.5, 0.4] }],
    [1.7, { hip: 5.7, twist: 0.4, tilt: -0.35 }, 'in'],
    [1.9, { twist: -0.4 }],
    [2.1, { twist: 0.2 }],
    [3.0, {}],
  ]),
  // pounds its chest: rubble rains from its body — hit 0.8 (first pound)
  clip('debris', 2.6, false, [
    [0, {}],
    [0.6, { lh: [0.6, -0.8, 2.0], tilt: -0.2 }],
    [0.8, { lh: [-2.1, -1.8, 1.4], tilt: 0.15, hip: 5.1 }, 'in'],
    [1.2, { lh: [0.6, -0.8, 2.0], tilt: -0.2, hip: 5.3 }],
    [1.4, { lh: [-2.1, -1.8, 1.4], tilt: 0.15, hip: 5.1 }, 'in'],
    [2.6, {}],
  ]),
  // swats along its own body (climbers) — hit 1.1, sweep until 1.7
  clip('swat', 2.5, false, [
    [0, {}],
    [1.0, { lh: [0.4, 1.2, 0.6], twist: 0.35, tilt: -0.3 }],
    [1.1, { lh: [-1.2, -1.2, 1.8], twist: 0.1 }, 'in'],
    [1.4, { lh: [-3.4, -3.0, 0.6], twist: -0.4 }, 'linear'],
    [1.7, { lh: [-2.6, -3.4, -2.2], twist: -0.9 }, 'linear'],
    [2.5, {}],
  ]),
  // desperation leap across the arena — hit 2.0, stuck until 4.4
  clip('leap', 5.0, false, [
    [0, {}],
    [1.0, { hip: 3.6, lean: 0.8, drop: 0.3, lf: [1.7, 0, 0.6], rf: [-1.7, 0, -0.4], lh: [1.0, -3.0, -1.6], rh: [-0.8, -3.0, -1.4], ham: [0, 0.4, -1], tilt: 0.3 }],
    [1.5, { hip: 5.9, lean: 0, drop: 0, lf: [1.35, 1.6, 0.5], rf: [-1.35, 1.4, -0.3], rh: [-0.6, 1.6, 0.3], ham: [0, 0.9, -0.3], lh: [1.6, -1.0, 0.6], tilt: -0.4 }],
    [2.0, { ...SLAM_REST }, 'in'],
    [4.4, { hip: 4.1 }],
    [5.0, { ...S }],
  ]),
];

export const ClipMap = new Map(Clips.map((c) => [c.name, c]));

/** Hit frames (clip seconds) for attacks.ts. */
export const HitFrame = {
  stomp: 1.15, march: 0.55, slam: 1.6, sweep: 1.3, backhand: 1.05, toll: 1.35, greatToll: 1.8, shakeoff: 1.7,
  debris: 0.8, swat: 1.1, leap: 2.0,
} as const;
