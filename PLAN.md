# Prototype Plan — Third-Person Mobility Action Game

Souls-inspired, browser-based, built to be extended (evolutionary prototype).

## Stack
- **Vite + TypeScript + Three.js** (WebGL, ES modules, hot reload)
- **Character:** KayKit *Adventurers* Knight (Kay Lousberg, **CC0**) — rigged glTF with 76 animations
  (1H slices/chop, dodges in 4 directions, jump start/idle/land, run/walk/strafe, hit reactions).
- No physics engine yet: analytic heightfield + circle colliders. Swap in Rapier later if needed.

## Architecture (`src/`)
| Module | Responsibility |
|---|---|
| `core/Game.ts` | Bootstrap, renderer, post-processing, main loop, system wiring |
| `core/Input.ts` | Device-agnostic **action map**: keyboard+mouse and gamepad → `move`, `look`, buttons with pressed/held/released + input buffering. Tracks last-used device for HUD prompts |
| `config/bindings.ts` | All key / gamepad bindings in one place |
| `config/tuning.ts` | All gameplay numbers (speeds, timings, windows) in one place |
| `world/Terrain.ts` | Seeded fBm heightfield, flat spawn plateau, vertex-coloured low-poly mesh, exact `heightAt(x,z)` / `normalAt` queries |
| `world/Props.ts` | Rocks, trees, ruined pillars (with circle colliders), training dummies |
| `world/Sky.ts` | Gradient sky dome, sun, fog |
| `camera/ThirdPersonCamera.ts` | Orbit camera (mouse / right stick), damped follow, terrain collision, shake |
| `player/Player.ts` | Kinematic controller + **state machine**: Locomotion · Airborne · Dodge · AirDash · Attack · Recall |
| `player/CharacterModel.ts` | Loads glTF, hides unused gear, strips root motion, animation crossfade helper |
| `abilities/EchoRecall.ts` | The shadow/hologram mechanic |
| `fx/*` | Hologram material, ghost afterimages (pooled), sword trail ribbon, particles (pooled), shockwave ring, hitstop |
| `ui/HUD.ts` | Control prompts (auto-switch keyboard / gamepad), echo timer, combo pips, air-dash pip |

## Mechanics
- **Movement:** camera-relative, acceleration/deceleration curves, fast turn-in-place, walk/run/sprint blend by stick magnitude.
- **Jump:** coyote time, jump buffering, variable height (release early = short hop), heavier fall gravity.
- **Dodge / Roll (ground):** directional roll in input direction (backstep with no input), i-frame window, cancellable tail.
- **Air Dash:** dodge while airborne → horizontal dash in input direction, gravity suspended briefly, afterimage trail. One per airtime, refreshed on landing / echo recall.
- **3-hit combo (Riven Q-style):**
  1. Right-side diagonal slash with a forward lunge
  2. Left-side horizontal slash with a forward lunge
  3. Leap + overhead smash → **AoE shockwave** on landing (knockback, camera shake, dust ring)
  - Buffered input, combo resets after a short idle window, attacks steer toward input direction, dodge-cancel after the hit frame.
  - Air attack → plunging smash.
- **Echo (shadow recall):** press once to leave a holographic echo of the character (pose frozen, ~6 s, flickers before expiring). Press again to teleport to it — the echo vanishes and the player takes its place (keeps mid-air position, refreshes air dash). Cooldown after use/expiry.

## Controls
| Action | Keyboard / Mouse | Gamepad (Xbox / PS) |
|---|---|---|
| Move | WASD | Left stick |
| Camera | Mouse (click to lock pointer) | Right stick |
| Sprint | Left Ctrl (hold) | L3 / LT (hold) |
| Jump | Space | A / Cross |
| Dodge · Air dash | Shift | B / Circle |
| Attack | Left mouse / J | X / Square, RB / R1 |
| Echo place / recall | E | Y / Triangle, LB / L1 |
| Recenter camera | — | R3 |

## Feel / FX
Sword trail ribbon, hitstop on hit, camera shake on smash, dust puffs (roll, land, sprint), shockwave ring,
hologram fresnel shader with scanlines, teleport streak, bloom post-processing, soft shadows, training dummies
that wobble/flash with floating damage numbers.

## Later (not in this prototype)
Enemies & AI, lock-on, stamina, health/damage on player, physics engine, level streaming, audio, settings menu / rebinding UI.
