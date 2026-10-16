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

---

# Phase 2 — Configurable kit (loadout), environment, enemies, combat & mobility expansion

Goal: a demo of "same character, different kits". Every ability is an *upgrade* in a data-driven
**Loadout** (toggles, tiers, exclusive choices, presets), switchable live from a pause-menu panel.

## Foundation (built first, by the lead)
| Piece | File(s) | Purpose |
|---|---|---|
| Event bus | `core/Events.ts` | Typed `emit/on` so audio, HUD, echo-mimic, style meter react without touching gameplay code |
| Loadout | `config/upgrades.ts`, `core/Loadout.ts` | Upgrade definitions (id, kind, requires/excludes), validation, presets, localStorage persistence |
| Input | `config/bindings.ts` | New actions: `heavy`, `block`, `lockOn`, `loadout` |
| Collision | `world/World.ts` | Yaw-rotated **box colliders** (walls, ledges, roofs), dynamic colliders, wall/ledge probes, camera occlusion |
| Terrain | `world/Terrain.ts` | Flattened zones for the town and the parkour gym |
| Player split | `player/Player.ts`, `player/states/*.ts` | State registry (`enter/update/exit` modules), interrupt hooks per feature, `receiveHit()` with a pluggable defense handler, health |
| HUD widgets | `ui/HUD.ts` | `hud.mount(widget)` so each feature ships its own HUD piece + CSS |
| Features | `features/index.ts` | Each feature exposes `install(game)`; one line per feature |

## Map regions
- Arena (spawn), radius ~16: training dummies, pillar ring.
- **Town / keep** — north, centre (0, -62), radius ~30: buildings, walls, ledges, rooftops. Enemies patrol here.
- **Parkour gym** — east, centre (62, 0), radius ~24: wall-run walls, ledges, gaps, timed course.
- Stepping stones (SW) and the arch (S) stay.

## Upgrade tree (ids are the contract)
**Echo** — `echo.aerial` (toggle) · `echo.count` (1/2/3, stack FILO) · `echo.recall` (teleport | swap | rewind) ·
`echo.body` (phantom | platform | mimic) · `echo.refresh` · `echo.shockwave` · `echo.duration` (6/9/12 s)
**Movement** — `move.jumps` (1/2/3) · `move.airDashes` (1/2) · `move.dashDir` (horizontal | eight-way) ·
`move.slide` · `move.wallRun` · `move.ledgeGrab`
**Defense** — `defense.style` (block-parry | perfect-dodge | counter) · `defense.stamina`
**Combat** — `combat.chargeHeavy` · `combat.launcher` · `combat.directional` · `combat.dodgeAttacks` · `combat.spin` · `combat.styleMeter`
**Presets** — Base · Acrobat · Assassin · Brawler · Everything

## Workstreams (parallel agents, each in its own git worktree, distinct files)
| # | Stream | Owns |
|---|---|---|
| 1 | Environment: town/keep with buildings, walls, ledges, rooftops (KayKit CC0 or procedural) | `world/Town.ts`, assets |
| 2 | Enemies: AI (patrol/chase/telegraph/attack), health, stagger, launch/juggle, death/respawn; player health, hurt & death | `enemy/*`, `player/states/hurt.ts`, `ui/HealthBars.ts` |
| 3 | Movement kit: multi-jump, dash charges + 8-way, slide, wall-run, ledge grab/climb, parkour gym | `player/states/locomotion.ts`, `player/states/parkour.ts`, `world/Gym.ts` |
| 4 | Offense: heavy attack, combo-string tree (L/H), charge heavy, launcher + air juggle, directional & dodge attacks, spin, kick, lock-on | `player/states/combat.ts`, `player/moves.ts`, camera lock-on |
| 5 | Echo upgrades: aerial, stack, swap/rewind, platform/mimic, refresh, shockwave, duration | `abilities/*` |
| 6 | Loadout panel + pause menu + presets | `ui/LoadoutPanel.ts` |
| 7 | Feedback: procedural audio (WebAudio), style meter + combo counter, training overlay (move list, input history) | `audio/*`, `ui/StyleMeter.ts`, `ui/Training.ts` |
| 8 (wave 2) | Defense: block, parry (slow-mo riposte), perfect dodge (witch time), counter, stamina | `player/states/defense.ts` |

## Not in this phase
Grapple, blink, thrown echo, time-trial ghost replays, touch controls, rebinding/settings sliders, physics engine.
