import { Vector3 } from 'three';
import { CombatTuning, Tuning } from '../config/tuning';
import type { Game } from '../core/Game';
import { angleDelta, clamp, dampAngle, lerp } from '../core/math';
import type { Player } from '../player/Player';
import { HUD } from '../ui/HUD';
import type { Hittable } from '../world/World';

/**
 * Lock-on (Souls style): `lockOn` toggles a lock to the nearest lockable target; the camera keeps
 * it framed, the player faces it while attacking and strafes around it (state `lockmove`).
 * Flick the mouse / right stick to switch left or right. Breaks when the target dies or gets
 * further than `breakRange`. Pressing lockOn with nothing in range recenters the camera.
 */
const L = CombatTuning.lockOn;
const P = Tuning.player;

const dir = new Vector3();
const point = new Vector3();
const screen = new Vector3();
let switchCooldown = 0;
let reticle: HTMLElement | null = null;

export const lockOn = {
  target: null as Hittable | null,
  /** horizontal unit vector from `from` toward the target (reused — copy if you keep it) */
  dirTo(from: Vector3): Vector3 {
    const t = this.target;
    if (!t) return dir.set(0, 0, 0);
    dir.set(t.position.x - from.x, 0, t.position.z - from.z);
    const d = dir.length();
    return d > 1e-4 ? dir.divideScalar(d) : dir.set(0, 0, 1);
  },
};

function valid(t: Hittable | null, from: Vector3, range: number): t is Hittable {
  if (!t || t.alive === false || !t.lockable) return false;
  return Math.hypot(t.position.x - from.x, t.position.z - from.z) <= range;
}

export function installLockOn(game: Game) {
  const p = game.player;
  p.registerState('lockmove', { update: updateLockMove });
  // Low priority: everything else on the ground (attacks, rolls, slides...) wins first.
  p.registerInterrupt({
    name: 'lockmove', priority: 1, contexts: ['ground'],
    check: (pl, _ctx, from) => {
      if (from !== 'move' || !lockOn.target || !pl.grounded) return false;
      if (pl.input.held('sprint') && pl.moveMag > 0.5) return false;
      pl.go('lockmove');
      return true;
    },
  });

  HUD.addStyles('lock-reticle-css', `
    .lock-reticle { position: absolute; left: 0; top: 0; width: 26px; height: 26px; pointer-events: none;
      transform: translate(-50%, -50%); display: none; z-index: 5; }
    .lock-reticle::before { content: ''; position: absolute; inset: 5px; border: 2px solid rgba(255, 236, 200, 0.95);
      transform: rotate(45deg); box-shadow: 0 0 8px rgba(255, 190, 110, 0.8); }
    .lock-reticle::after { content: ''; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px;
      background: #fff2dc; transform: rotate(45deg); }
    .lock-reticle.pop::before { animation: lock-pop 0.22s ease-out; }
    @keyframes lock-pop { from { inset: -6px; opacity: 0.3; } to { inset: 5px; opacity: 1; } }
  `);
  reticle = game.hud.mount(Object.assign(document.createElement('div'), { className: 'lock-reticle' }));
}

function setTarget(game: Game, t: Hittable | null) {
  lockOn.target = t;
  if (reticle && t) {
    reticle.classList.remove('pop');
    void reticle.offsetWidth; // restart the animation
    reticle.classList.add('pop');
  }
  if (!t) game.cam.lockPoint = null;
}

export function updateLockOn(game: Game, dt: number) {
  const p = game.player;
  const input = game.input;
  switchCooldown = Math.max(0, switchCooldown - dt);

  if (input.pressed('lockOn')) {
    if (lockOn.target) {
      setTarget(game, null);
    } else {
      const fwd = game.cam.forward(new Vector3());
      const t = game.world.nearestLockable(p.position, fwd, L.range);
      if (t) setTarget(game, t);
      else game.cam.recenter(p.facing);
    }
  }

  if (lockOn.target && !valid(lockOn.target, p.position, L.breakRange)) {
    // Target died / out of range: hop to the next one nearby if there is one, else release.
    const next = game.world.nearestLockable(p.position, game.cam.forward(new Vector3()), L.range * 0.6);
    setTarget(game, next && next !== lockOn.target ? next : null);
  }

  if (lockOn.target) {
    const flick = game.cam.takeFlick(L.flickThreshold);
    if (flick !== 0 && switchCooldown <= 0) {
      const n = pickSide(game, flick > 0 ? 1 : -1);
      if (n) {
        setTarget(game, n);
        switchCooldown = L.switchCooldown;
      }
    }
  }

  if (lockOn.target) game.cam.lockPoint = point.copy(lockOn.target.position);
  else game.cam.lockPoint = null;
}

/** Nearest target (by angle) on the given screen side of the current one. side +1 = right. */
function pickSide(game: Game, side: number): Hittable | null {
  const p = game.player.position;
  const cur = lockOn.target!;
  const curAng = Math.atan2(cur.position.x - p.x, cur.position.z - p.z);
  let best: Hittable | null = null;
  let bestScore = Infinity;
  for (const t of game.world.targets) {
    if (t === cur || !valid(t, p, L.range)) continue;
    const a = Math.atan2(t.position.x - p.x, t.position.z - p.z);
    const delta = angleDelta(curAng, a); // + = to the left (yaw grows leftwards)
    if (delta * side >= 0) continue;
    const score = Math.abs(delta) + Math.hypot(t.position.x - p.x, t.position.z - p.z) * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

export function lateUpdateLockOn(game: Game) {
  if (!reticle) return;
  const t = lockOn.target;
  if (!t) {
    reticle.style.display = 'none';
    return;
  }
  const v = screen.copy(t.position).project(game.cam.camera);
  if (v.z > 1) {
    reticle.style.display = 'none';
    return;
  }
  reticle.style.display = 'block';
  reticle.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
  reticle.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
}

// ------------------------------------------------------------------ strafing locomotion
function updateLockMove(p: Player, dt: number) {
  if (!p.grounded) return p.go('air');
  if (!lockOn.target || (p.input.held('sprint') && p.moveMag > 0.5)) return p.go('move');
  if (p.runInterrupts('ground')) return;

  const f = lockOn.dirTo(p.position);
  const targetYaw = Math.atan2(f.x, f.z);
  p.facing = dampAngle(p.facing, targetYaw, 14, dt);

  // Stick in target space: forward toward the target, right = screen right.
  const fwd = p.moveDir.x * f.x + p.moveDir.z * f.z;
  const right = p.moveDir.x * -f.z + p.moveDir.z * f.x;
  const back = fwd < -0.5;
  const maxSpeed = back ? L.walkBackSpeed : Math.abs(right) > Math.abs(fwd) ? L.strafeSpeed : P.runSpeed * 0.85;
  const speed = lerp(0, maxSpeed, clamp(p.moveMag, 0, 1));
  p.accelerateHorizontal(p.moveDir, speed, p.moveMag > 0.01 ? P.accel : P.decel, dt);

  const hs = Math.hypot(p.velocity.x, p.velocity.z);
  if (hs < 0.35 || p.moveMag < 0.05) {
    p.model.play('Idle', { fade: 0.2 });
  } else if (back) {
    p.model.play('Walking_Backwards', { fade: 0.2, speed: clamp(hs / L.walkBackSpeed, 0.6, 1.4) });
  } else if (Math.abs(right) > Math.abs(fwd)) {
    // moving to the character's right = screen right (camera behind)
    p.model.play(right > 0 ? 'Running_Strafe_Right' : 'Running_Strafe_Left', { fade: 0.2, speed: clamp(hs / L.strafeSpeed, 0.6, 1.3) });
  } else if (hs < P.walkSpeed + 0.9) {
    p.model.play('Walking_A', { fade: 0.2, speed: clamp(hs / P.walkSpeed, 0.6, 1.5) });
  } else {
    p.model.play('Running_A', { fade: 0.18, speed: clamp(hs / P.runSpeed, 0.75, 1.45) });
  }
}
