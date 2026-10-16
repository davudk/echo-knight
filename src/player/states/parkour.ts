import { Vector3 } from 'three';
import { Tuning } from '../../config/tuning';
import { events } from '../../core/Events';
import { loadout } from '../../core/Loadout';
import { clamp, dampAngle, easeInOutSine, easeOutCubic, lerp } from '../../core/math';
import { Colors } from '../../fx/Fx';
import type { Collider, WallHit } from '../../world/World';
import type { Player } from '../Player';

/**
 * Parkour states: slide (+ long jump), wall-run (+ wall kick), ledge hang / climb / vault.
 *
 * Gated live by the loadout (`move.slide`, `move.wallRun`, `move.ledgeGrab`); with all three off
 * nothing here ever triggers. Everything enters through interrupts, so other features
 * (attacks, echo) keep working from these states via `runInterrupts`.
 */
const P = Tuning.player;
const J = Tuning.jump;
const SL = Tuning.movement.slide;
const LJ = Tuning.movement.longJump;
const WR = Tuning.movement.wallRun;
const LG = Tuning.movement.ledge;

const s = {
  // slide
  slideDir: new Vector3(),
  slideSpeed: 0,
  dustTimer: 0,
  // wall-run
  wall: null as Collider | null,
  wallN: new Vector3(),
  wallT: new Vector3(),
  wallSpeed: 0,
  wallSide: 1,
  releaseTimer: 0,
  /** last wall used (run or kick) and the airtime when we left it */
  lastWall: null as Collider | null,
  lastWallAt: 0,
  // ledge
  ledgeN: new Vector3(),
  ledgeTop: 0,
  ledgeBlockUntil: -1,
  climbFrom: new Vector3(),
  climbTo: new Vector3(),
  climbTime: 0,
  vault: false,
};

const tmp = new Vector3();
const tmp2 = new Vector3();

export function installParkour(p: Player) {
  p.registerState('slide', { enter: enterSlide, update: updateSlide, visual: slideVisual });
  p.registerState('wallrun', { enter: enterWallRun, update: updateWallRun, exit: exitWallRun, visual: wallRunVisual });
  p.registerState('ledgehang', { enter: enterHang, update: updateHang, visual: hangVisual });
  p.registerState('ledgeclimb', { enter: enterClimb, update: updateClimb, visual: climbVisual });

  // Slide replaces the roll when moving fast (priority above the plain dodge interrupt).
  p.registerInterrupt({
    name: 'slide', priority: 95, contexts: ['ground', 'cancel'],
    check: (pl, _ctx, from) => {
      if (!loadout.has('move.slide') || !pl.grounded || from === 'dodge' || from === 'slide') return false;
      if (!slideReady(pl) || !pl.input.consume('dodge', 0.15)) return false;
      pl.go('slide');
      return true;
    },
  });

  // Wall kick: jump next to a tall wall while airborne (chimney climbing). Above normal/air jumps,
  // except when holding into the wall with air jumps left.
  p.registerInterrupt({
    name: 'wallkick', priority: 105, contexts: ['air', 'cancel'],
    check: (pl, _ctx, from) => {
      if (!loadout.has('move.wallRun') || pl.grounded || (from !== 'air' && from !== 'airdash')) return false;
      if (pl.jumpsUsed === 0 && pl.airTime < J.coyoteTime) return false; // coyote ground jump wins
      if (!pl.input.buffered('jump', J.bufferTime)) return false;
      const hit = findRunWall(pl, WR.reach);
      if (!hit || !wallUsable(pl, hit.collider)) return false;
      // Holding into the wall with air jumps left = jump up along it (reach ledges) instead of kicking off.
      const into = -(pl.moveDir.x * hit.normal.x + pl.moveDir.z * hit.normal.z) * pl.moveMag;
      if (into > 0.5 && Math.max(1, pl.jumpsUsed) < pl.maxJumps) return false;
      pl.input.clearBuffer('jump');
      tmp2.copy(pl.velocity).setY(0);
      tmp.copy(hit.normal);
      // keep only the along-wall part of the current velocity
      tmp2.addScaledVector(tmp, -tmp2.dot(tmp));
      wallKick(pl, hit.collider, tmp, tmp2);
      return true;
    },
  });

  // Wall-run: airborne, fast, moving along a tall wall (wins over a ledge grab; head-on approaches go to ledges).
  p.registerInterrupt({
    name: 'wallrun', priority: 75, contexts: ['air', 'cancel'],
    check: (pl, _ctx, from) => {
      if (!loadout.has('move.wallRun') || pl.grounded || (from !== 'air' && from !== 'airdash')) return false;
      if (pl.heightAboveGround() < 0.6 || pl.velocity.y < -9) return false;
      const hs = Math.hypot(pl.velocity.x, pl.velocity.z);
      if (hs < WR.minSpeed || pl.moveMag < 0.3) return false;
      const hit = findRunWall(pl, WR.reach);
      if (!hit || !wallUsable(pl, hit.collider)) return false;
      const n = hit.normal;
      if (-(pl.moveDir.x * n.x + pl.moveDir.z * n.z) < -0.15) return false; // steering away
      const along = Math.abs(-n.z * pl.velocity.x + n.x * pl.velocity.z);
      if (along < WR.minAlong || along < hs * 0.45) return false; // head-on: that's a kick / ledge
      pl.go('wallrun', hit);
      return true;
    },
  });

  // Ledge grab / vault.
  p.registerInterrupt({
    name: 'ledge', priority: 70, contexts: ['air', 'cancel'],
    check: (pl, _ctx, from) => {
      if (!loadout.has('move.ledgeGrab') || pl.grounded) return false;
      if (from !== 'air' && from !== 'airdash' && from !== 'wallrun') return false;
      if (pl.velocity.y > LG.maxVy || pl.moveMag < 0.3 || pl.airTime < s.ledgeBlockUntil) return false;
      const ledge = findLedge(pl, pl.position, pl.moveDir);
      if (!ledge) return false;
      const diff = ledge.top - pl.position.y;
      if (from === 'wallrun') {
        // only catch the top of the wall you run on when it's near and you steer into it
        const toward = -(pl.moveDir.x * ledge.normal.x + pl.moveDir.z * ledge.normal.z);
        if (diff > 2.0 || toward < 0.75) return false;
      }
      if (diff < LG.vaultBelow) pl.go('ledgeclimb', { hit: ledge, vault: true });
      else pl.go('ledgehang', ledge);
      return true;
    },
  });

  // Touching the ground clears per-airtime bookkeeping. Landings emit an event; teleports onto the
  // ground (respawn, echo recall) don't, so also clear while free on the ground (never transitions).
  const resetAirBookkeeping = () => {
    s.lastWall = null;
    s.ledgeBlockUntil = -1;
  };
  events.on('player:land', resetAirBookkeeping);
  p.registerInterrupt({
    name: 'parkour-ground-reset', priority: 1000, contexts: ['ground'],
    check: () => (resetAirBookkeeping(), false),
  });
}

// ------------------------------------------------------------------ helpers
function hspeed(p: Player) {
  return Math.hypot(p.velocity.x, p.velocity.z);
}

function slideReady(p: Player) {
  const hs = hspeed(p);
  const sprinting = p.input.held('sprint') && p.moveMag > 0.5 && hs > P.runSpeed * 0.8;
  return sprinting || hs >= SL.minSpeed;
}

function isTallWall(c: Collider) {
  return c.kind === 'box' && c.top !== Infinity && c.top - c.bottom >= WR.minWallHeight;
}

/** A tall box wall beside the body, covering it from knees to above the head. */
function findRunWall(p: Player, reach: number, dir?: Vector3): WallHit | null {
  const pos = p.position;
  const hit = p.ctx.world.probeWall(pos, P.radius + reach, pos.y + 0.3, pos.y + 1.4, dir, 0.2);
  if (!hit || !isTallWall(hit.collider)) return null;
  if (hit.top < pos.y + 1.5 || hit.collider.bottom > pos.y + 0.3) return null;
  return hit;
}

function wallUsable(p: Player, c: Collider) {
  return c !== s.lastWall || p.airTime - s.lastWallAt > WR.wallCooldown;
}

function markWall(p: Player, c: Collider | null) {
  s.lastWall = c;
  s.lastWallAt = p.airTime;
}

/** Is there something solid right above (slide under bars)? */
function ceilingOver(p: Player) {
  const { world } = p.ctx;
  const y = p.position.y;
  for (const c of world.colliders) {
    if (c.bottom <= y + 0.3 || c.bottom > y + P.height) continue;
    if (world.contains2D(c, p.position.x, p.position.z, P.radius * 0.9)) return true;
  }
  return false;
}

/** A grabbable ledge in front of `pos` (toward `dir`), with free standing room on top. */
function findLedge(p: Player, pos: Vector3, dir: Vector3 | undefined): WallHit | null {
  const { world } = p.ctx;
  const hit = world.probeWall(pos, P.radius + LG.probe, pos.y + LG.reach[0], pos.y + LG.reach[1], dir, 0.5);
  if (!hit || hit.top === Infinity) return null;
  const diff = hit.top - pos.y;
  if (diff < LG.reach[0] || diff > LG.reach[1]) return null;
  // Standing spot on top must be this surface, with head room.
  const sx = hit.point.x - hit.normal.x * (P.radius + 0.2);
  const sz = hit.point.z - hit.normal.z * (P.radius + 0.2);
  const g = world.groundAt(sx, sz, hit.top + 0.05, 0.1);
  if (Math.abs(g - hit.top) > 0.06) return null;
  if (world.pointBlocked(sx, hit.top + 1.0, sz, 0.05) || world.pointBlocked(sx, hit.top + 1.6, sz, 0.05)) return null;
  return hit;
}

// ------------------------------------------------------------------ slide
function enterSlide(p: Player, data?: unknown) {
  const d = (data ?? {}) as { speed?: number };
  const hs = hspeed(p);
  if (p.moveMag > 0.1) s.slideDir.copy(p.moveDir);
  else if (hs > 0.5) s.slideDir.set(p.velocity.x / hs, 0, p.velocity.z / hs);
  else s.slideDir.copy(p.forward);
  s.slideDir.setY(0).normalize();
  s.slideSpeed = Math.max(d.speed ?? 0, hs + 2, SL.startSpeed);
  p.facing = Math.atan2(s.slideDir.x, s.slideDir.z);
  s.dustTimer = 0;
  p.model.play('Sit_Floor_Down', { fade: 0.08, loop: false, speed: 2.4, startAt: 0.15, restart: true });
  p.ctx.fx.dustPuff(p.position, 10, 3);
  p.ctx.cam.kickFov(4);
  events.emit('player:slide', { position: p.position.clone(), speed: s.slideSpeed });
}

function updateSlide(p: Player, dt: number) {
  const t = p.stateTime;
  p.bodyHeight = SL.bodyHeight;

  if (!p.grounded && p.airTime > J.coyoteTime) {
    p.go('air');
    return;
  }
  // Long jump: keep the slide's speed and add a boost.
  if (p.input.consume('jump', J.bufferTime) && !ceilingOver(p)) {
    longJump(p);
    return;
  }
  if (t >= SL.cancelAt && p.runInterrupts('cancel')) return;

  // Steer a little toward the stick.
  if (p.moveMag > 0.2) {
    const want = Math.atan2(p.moveDir.x, p.moveDir.z);
    const cur = Math.atan2(s.slideDir.x, s.slideDir.z);
    const a = dampAngle(cur, want, SL.steer, dt);
    s.slideDir.set(Math.sin(a), 0, Math.cos(a));
    p.facing = a;
  }

  // Friction, plus gravity along a downhill slope.
  const n = p.ctx.world.terrain.normalAt(p.position.x, p.position.z);
  const onTerrain = Math.abs(p.position.y - p.ctx.world.terrain.heightAt(p.position.x, p.position.z)) < 0.05;
  const slope = onTerrain ? n.x * s.slideDir.x + n.z * s.slideDir.z : 0;
  s.slideSpeed *= Math.exp(-SL.friction * dt);
  s.slideSpeed += SL.slopeAccel * slope * dt;
  const under = ceilingOver(p);
  if (under) s.slideSpeed = Math.max(s.slideSpeed, SL.ceilingSpeed);
  s.slideSpeed = Math.max(0, s.slideSpeed);
  p.velocity.x = s.slideDir.x * s.slideSpeed;
  p.velocity.z = s.slideDir.z * s.slideSpeed;

  // Dust trail.
  s.dustTimer -= dt;
  if (s.dustTimer <= 0) {
    s.dustTimer = 0.035;
    p.ctx.fx.dustPuff(p.position.clone().addScaledVector(s.slideDir, 0.5), 3, 1.4, [0.2, 0.42]);
  }

  const downhill = slope > 0.05 && s.slideSpeed > SL.keepSpeed && t < SL.maxDuration;
  if ((t >= SL.duration && !downhill && !under) || (s.slideSpeed < 2.5 && !under)) {
    p.go('move');
    p.model.play('Running_A', { fade: 0.2 });
  }
}

function longJump(p: Player) {
  const speed = Math.max(s.slideSpeed, LJ.speed);
  p.velocity.set(s.slideDir.x * speed, LJ.velocity, s.slideDir.z * speed);
  p.grounded = false;
  p.jumpsUsed = 1;
  p.variableJump = true;
  p.facing = Math.atan2(s.slideDir.x, s.slideDir.z);
  p.ctx.fx.dustPuff(p.position, 12, 3);
  p.ctx.fx.afterimage(0.3);
  p.ctx.cam.kickFov(6);
  events.emit('player:jump', { position: p.position.clone(), airJump: 0 });
  events.emit('player:longjump', { position: p.position.clone(), speed });
  p.go('air', { jumped: true, pose: 'long' });
}

function slideVisual(p: Player, o: { pitch: number; lift: number; squash: number; roll: number }) {
  const u = clamp(p.stateTime / 0.12, 0, 1);
  o.pitch = -0.55 * easeOutCubic(u);
  o.lift = -0.42 * easeOutCubic(u);
  o.squash = 1;
}

// ------------------------------------------------------------------ wall-run
function enterWallRun(p: Player, data?: unknown) {
  const hit = data as WallHit;
  s.wall = hit.collider;
  s.wallN.copy(hit.normal);
  s.wallT.set(-s.wallN.z, 0, s.wallN.x);
  const along = s.wallT.x * p.velocity.x + s.wallT.z * p.velocity.z;
  if (along < 0) s.wallT.negate();
  s.wallSpeed = Math.max(Math.abs(along), WR.speed);
  p.facing = Math.atan2(s.wallT.x, s.wallT.z);
  // wall on the character's right?  right = (-cos f, 0, sin f)
  const rx = -Math.cos(p.facing);
  const rz = Math.sin(p.facing);
  s.wallSide = -(s.wallN.x * rx + s.wallN.z * rz) > 0 ? 1 : -1;
  p.velocity.y = Math.max(p.velocity.y * 0.4, 0) + WR.startVy;
  s.releaseTimer = 0;
  s.dustTimer = 0;
  p.variableJump = false;
  p.model.play('Running_A', { fade: 0.1, speed: 1.35 });
  p.ctx.fx.dustPuff(contactPoint(p), 6, 1.8);
  events.emit('player:wallrun', { position: p.position.clone(), normal: s.wallN.clone(), side: s.wallSide > 0 ? 'right' : 'left' });
}

function contactPoint(p: Player) {
  return p.position.clone().addScaledVector(s.wallN, -P.radius).setY(p.position.y + 0.2);
}

function endWallRun(p: Player, reason: 'time' | 'release' | 'edge' | 'other', push = 1.8) {
  p.velocity.x += s.wallN.x * push;
  p.velocity.z += s.wallN.z * push;
  events.emit('player:wallrun-end', { position: p.position.clone(), reason });
  p.go('air');
}

function updateWallRun(p: Player, dt: number) {
  const t = p.stateTime;
  if (p.grounded) {
    events.emit('player:wallrun-end', { position: p.position.clone(), reason: 'land' });
    p.go('move');
    return;
  }
  if (p.input.consume('jump', J.bufferTime)) {
    tmp.copy(s.wallT).multiplyScalar(s.wallSpeed);
    events.emit('player:wallrun-end', { position: p.position.clone(), reason: 'jump' });
    wallKick(p, s.wall, s.wallN, tmp);
    return;
  }
  if (p.runInterrupts('air')) return;

  // Re-probe: follow the wall (adjacent segments are fine), stop at its end.
  const hit = p.ctx.world.probeWall(p.position, P.radius + 0.6, p.position.y + 0.3, p.position.y + 1.4);
  if (!hit || !isTallWall(hit.collider) || hit.normal.dot(s.wallN) < 0.9 || hit.top < p.position.y + 1.0) {
    endWallRun(p, 'edge', 0.5);
    return;
  }
  s.wall = hit.collider;
  s.wallN.copy(hit.normal);
  // keep the tangent pointing the same way
  const tx = -s.wallN.z;
  const tz = s.wallN.x;
  const sign = tx * s.wallT.x + tz * s.wallT.z >= 0 ? 1 : -1;
  s.wallT.set(tx * sign, 0, tz * sign);
  p.facing = dampAngle(p.facing, Math.atan2(s.wallT.x, s.wallT.z), 20, dt);

  // Hug the wall at body distance.
  const d = (p.position.x - hit.point.x) * s.wallN.x + (p.position.z - hit.point.z) * s.wallN.z;
  const fix = P.radius + 0.03 - d;
  p.position.x += s.wallN.x * fix;
  p.position.z += s.wallN.z * fix;

  const u = clamp(t / WR.maxTime, 0, 1);
  p.gravityScale = lerp(WR.gravity[0], WR.gravity[1], u * u);
  p.fullJumpArc = true;
  s.wallSpeed = Math.max(WR.speed * 0.85, s.wallSpeed - 1.5 * dt);
  p.velocity.x = s.wallT.x * s.wallSpeed;
  p.velocity.z = s.wallT.z * s.wallSpeed;
  if (p.velocity.y < -4) p.velocity.y = -4;

  s.dustTimer -= dt;
  if (s.dustTimer <= 0) {
    s.dustTimer = 0.11;
    p.ctx.fx.dustPuff(contactPoint(p), 2, 1.0, [0.16, 0.3]);
    events.emit('player:footstep', { position: p.position.clone(), sprint: true });
  }

  // Let go: input released or pushed away from the wall, or out of time.
  const away = p.moveDir.x * s.wallN.x + p.moveDir.z * s.wallN.z;
  if (p.moveMag < 0.2 || away > 0.6) s.releaseTimer += dt;
  else s.releaseTimer = 0;
  if (s.releaseTimer > WR.releaseGrace) return endWallRun(p, 'release');
  if (t >= WR.maxTime) return endWallRun(p, 'time');
}

function exitWallRun(p: Player) {
  markWall(p, s.wall);
}

function wallRunVisual(p: Player, o: { roll: number; pitch: number }) {
  const u = clamp(p.stateTime / 0.12, 0, 1);
  // feet toward the wall, head away from it
  o.roll = -s.wallSide * 0.5 * easeOutCubic(u);
  o.pitch = 0.12;
}

/** Push off a wall: away + up, keeps some along-wall speed, refreshes one air jump. */
function wallKick(p: Player, wall: Collider | null, n: Vector3, alongVel: Vector3) {
  markWall(p, wall);
  const vx = n.x * WR.kickOut + alongVel.x * WR.kickAlong;
  const vz = n.z * WR.kickOut + alongVel.z * WR.kickAlong;
  p.velocity.set(vx, WR.kickUp, vz);
  p.facing = Math.atan2(vx, vz);
  p.grounded = false;
  p.variableJump = true;
  p.jumpsUsed = Math.max(1, p.jumpsUsed - 1);
  const at = p.position.clone().addScaledVector(n, -P.radius).setY(p.position.y + 0.6);
  p.ctx.fx.dustPuff(at, 8, 2.4);
  p.ctx.fx.waves.spawn(at, 0.9, Colors.dash, 0.25, 0.2);
  p.ctx.fx.afterimage(0.25);
  events.emit('player:walljump', { position: p.position.clone(), dir: new Vector3(vx, WR.kickUp, vz).normalize() });
  p.go('air', { jumped: true, pose: 'flip', fullArc: true });
}

// ------------------------------------------------------------------ ledge hang
function hangPosition(p: Player, hit: WallHit) {
  p.position.x = hit.point.x + hit.normal.x * (P.radius + 0.03);
  p.position.z = hit.point.z + hit.normal.z * (P.radius + 0.03);
  p.position.y = hit.top - LG.hangDrop;
}

function enterHang(p: Player, data?: unknown) {
  const hit = data as WallHit;
  s.ledgeN.copy(hit.normal);
  s.ledgeTop = hit.top;
  hangPosition(p, hit);
  p.velocity.set(0, 0, 0);
  p.facing = Math.atan2(-s.ledgeN.x, -s.ledgeN.z);
  p.variableJump = false;
  p.jumpsUsed = Math.max(1, Math.min(p.jumpsUsed, 1));
  p.airDashCharges = p.maxAirDashes;
  p.model.play('Cheer', { fade: 0.08, speed: 0, startAt: 0.7, restart: true }); // arms up, frozen
  p.ctx.fx.dustPuff(tmp.copy(p.position).setY(hit.top).addScaledVector(s.ledgeN, -0.2), 5, 1.2, [0.15, 0.3]);
  p.ctx.cam.shake(0.05);
  events.emit('player:ledge', { position: p.position.clone(), action: 'grab' });
}

function updateHang(p: Player, dt: number) {
  p.gravityScale = 0;
  p.velocity.set(0, 0, 0);
  const t = p.stateTime;
  const n = s.ledgeN;
  const toward = -(p.moveDir.x * n.x + p.moveDir.z * n.z) * p.moveMag;
  const lateral = (p.moveDir.x * -n.z + p.moveDir.z * n.x) * p.moveMag;

  if (p.input.consume('jump', J.bufferTime)) {
    if (toward < -0.5) return ledgeJumpOff(p);
    return startClimb(p);
  }
  if (p.input.consume('dodge', 0.12) || (toward < -0.6 && t > 0.15)) return ledgeDrop(p);
  if (toward > 0.6 && t > 0.22) return startClimb(p);

  // Shimmy along the edge while the next spot is still a valid ledge.
  if (Math.abs(lateral) > 0.35 && t > 0.1) {
    const step = Math.sign(lateral) * LG.shimmySpeed * dt;
    tmp2.copy(p.position);
    tmp2.x += -n.z * step;
    tmp2.z += n.x * step;
    tmp2.y = s.ledgeTop - LG.hangDrop;
    tmp.copy(n).negate();
    const hit = findLedge(p, tmp2, tmp);
    // small per-frame turn = curved edge (pillars); a sharp turn = box corner: stop there
    if (hit && Math.abs(hit.top - s.ledgeTop) < 0.15 && hit.normal.dot(n) > 0.98) {
      s.ledgeN.copy(hit.normal);
      s.ledgeTop = hit.top;
      p.position.copy(tmp2);
      hangPosition(p, hit);
      p.facing = Math.atan2(-s.ledgeN.x, -s.ledgeN.z);
    }
  }
}

function hangVisual(p: Player, o: { pitch: number; lift: number; roll: number }) {
  const u = clamp(p.stateTime / 0.15, 0, 1);
  o.pitch = 0.28 * easeOutCubic(u); // lean the chest over the edge
  o.lift = 0;
}

function ledgeDrop(p: Player) {
  s.ledgeBlockUntil = p.airTime + LG.dropCooldown;
  p.velocity.set(s.ledgeN.x * 1.5, -1, s.ledgeN.z * 1.5);
  events.emit('player:ledge', { position: p.position.clone(), action: 'drop' });
  p.go('air');
}

function ledgeJumpOff(p: Player) {
  s.ledgeBlockUntil = p.airTime + LG.dropCooldown;
  const n = s.ledgeN;
  p.velocity.set(n.x * LG.kickOut, LG.kickUp, n.z * LG.kickOut);
  p.facing = Math.atan2(n.x, n.z);
  p.variableJump = true;
  p.ctx.fx.dustPuff(p.position.clone().addScaledVector(n, -P.radius).setY(p.position.y + 0.8), 8, 2.2);
  p.ctx.fx.afterimage(0.25);
  events.emit('player:ledge', { position: p.position.clone(), action: 'jump' });
  events.emit('player:walljump', { position: p.position.clone(), dir: p.velocity.clone().normalize() });
  p.go('air', { jumped: true, pose: 'flip', fullArc: true });
}

function startClimb(p: Player) {
  p.go('ledgeclimb', { vault: false });
}

// ------------------------------------------------------------------ climb / vault
function enterClimb(p: Player, data?: unknown) {
  const d = (data ?? {}) as { hit?: WallHit; vault?: boolean };
  s.vault = !!d.vault;
  if (d.hit) {
    s.ledgeN.copy(d.hit.normal);
    s.ledgeTop = d.hit.top;
    // start flush against the wall
    p.position.x = d.hit.point.x + d.hit.normal.x * (P.radius + 0.03);
    p.position.z = d.hit.point.z + d.hit.normal.z * (P.radius + 0.03);
  }
  s.climbFrom.copy(p.position);
  // same spot findLedge validated: a body radius + a bit past the edge
  s.climbTo.copy(p.position).addScaledVector(s.ledgeN, -(P.radius * 2 + 0.23));
  s.climbTo.y = s.ledgeTop;
  s.climbTime = s.vault ? LG.vaultTime : LG.climbTime;
  // carry a little momentum out of a vault
  p.facing = Math.atan2(-s.ledgeN.x, -s.ledgeN.z);
  p.velocity.set(0, 0, 0);
  p.model.play(s.vault ? 'Jump_Land' : 'Jump_Start', { fade: 0.06, loop: false, speed: s.vault ? 2.2 : 1.6, restart: true });
  events.emit('player:ledge', { position: p.position.clone(), action: s.vault ? 'vault' : 'climb' });
}

function updateClimb(p: Player) {
  p.gravityScale = 0;
  p.velocity.set(0, 0, 0);
  const u = clamp(p.stateTime / s.climbTime, 0, 1);
  const split = s.vault ? 0.45 : 0.6;
  const a = s.climbFrom;
  const b = s.climbTo;
  if (u < split) {
    const k = easeInOutSine(u / split);
    p.position.set(a.x, lerp(a.y, b.y + 0.06, k), a.z);
  } else {
    const k = easeOutCubic((u - split) / (1 - split));
    p.position.set(lerp(a.x, b.x, k), b.y + 0.06 * (1 - k), lerp(a.z, b.z, k));
  }
  if (u >= 1) {
    p.position.copy(b);
    // vaults keep a bit of forward speed into the run
    if (s.vault && p.moveMag > 0.3) {
      p.velocity.x = -s.ledgeN.x * P.runSpeed * 0.7;
      p.velocity.z = -s.ledgeN.z * P.runSpeed * 0.7;
    }
    p.ctx.fx.dustPuff(b, 5, 1.4);
    p.go('move');
  }
}

function climbVisual(p: Player, o: { pitch: number; lift: number; squash: number }) {
  const u = clamp(p.stateTime / s.climbTime, 0, 1);
  const k = Math.sin(u * Math.PI);
  o.pitch = 0.55 * k;
  o.squash = 1 - 0.18 * k;
}
