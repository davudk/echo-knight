# Echo Knight — third-person mobility prototype

A Souls-inspired, browser-based third-person action prototype (Three.js + TypeScript + Vite),
focused on responsive movement and mobility tools. See [PLAN.md](PLAN.md) for the design and architecture.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
```

Click the screen to start (locks the mouse). Press **Esc** to release it / pause. A gamepad works as soon as you press a button.

## Controls

| Action | Keyboard / Mouse | Gamepad (Xbox / PS) |
|---|---|---|
| Move | WASD / arrows | Left stick (analog walk → run) |
| Camera | Mouse | Right stick |
| Sprint | Left Ctrl (hold) | L3 or LT (hold) |
| Jump (hold = higher) | Space | A / Cross |
| Roll · **Air dash** when airborne | Shift | B / Circle |
| Attack — 3-hit combo, plunge when airborne | LMB / J | X / Square, RB / R1 |
| Echo: place · recall | E / RMB | Y / Triangle, LB / L1 |
| Recenter camera | Q / MMB | R3 |
| Toggle help · FPS | H · F3 | — |
| Mute · volume − / + | M · `-` / `=` | — |
| Training: input history + last move · move list | T · F1 | — |

## Mechanics

- **Combo**: slash right→left, slash left→right, then a Riven-style leap that slams down with an AoE shockwave.
  Inputs are buffered; each attack steers toward your stick; roll/jump cancel after the hit frame.
- **Roll** (ground): somersault with i-frames; backstep when no direction is held. Roll can be jump-cancelled to carry momentum.
- **Air dash** (Shift / B in the air): fast horizontal dash with afterimages. One charge per airtime, refreshed on landing or recall.
- **Plunge**: attack while airborne (> ~1 m up) to dive down and slam.
- **Echo**: leave a hologram of yourself (6 s, flickers before it fades). Press again to teleport into it.
  Works mid-air, refreshes your air dash. Short cooldown afterwards.

The ruined pillars and the stepping stones to the south-west are climbable; try jump → air dash → echo chains.

## Code map

| Path | What |
|---|---|
| `src/config/bindings.ts` | All key / button bindings (action-based) |
| `src/config/tuning.ts` | Every gameplay number (speeds, combo timings, cooldowns) |
| `src/core/Input.ts` | Keyboard+mouse+gamepad → actions, with input buffering |
| `src/core/Game.ts` | Renderer, post-processing, loop, wiring. `game.step(s)` advances deterministically (debug/tests) |
| `src/player/Player.ts` | Kinematic controller + state machine (move, air, dodge, airdash, attack, plunge) |
| `src/player/CharacterModel.ts` | glTF loading, gear hiding, root-motion stripping, animation crossfades |
| `src/abilities/EchoRecall.ts` | The echo / shadow-recall ability |
| `src/fx/*` | Hologram shader, ghosts/afterimages, particles, sword trail, shockwaves |
| `src/world/*` | Terrain heightfield, props & colliders, training dummies, sky/lighting |
| `src/ui/HUD.ts` | Control prompts (auto-switch by device), ability bar, combo pips, damage numbers |
| `src/audio/*` | Procedural WebAudio sound effects (`sounds.ts` recipes, `audioFeature.ts` event → sound map). Dev: `sfx.debug = true` logs every sound with its event, `await sfxTest()` renders each recipe offline |
| `src/ui/StyleMeter.ts` | Combo hit counter + D→S style rank (loadout `combat.styleMeter`) |
| `src/ui/Training.ts` | Training overlay: input history, last-move readout, move list generated from `config/moveList.ts` |

In the browser console, `game` is exposed for debugging (e.g. `game.player.state`, `game.step(0.5)`).

## Credits

Character: **KayKit Adventurers — Knight** by Kay Lousberg (www.kaylousberg.com), CC0. See `public/models/LICENSE-KayKit.txt`.
