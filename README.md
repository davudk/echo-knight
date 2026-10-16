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
| Jump (hold = higher; air jumps with the upgrade) | Space | A / Cross |
| Roll · **Air dash** when airborne · **Slide** when sprinting (upgrade) | Shift | B / Circle |
| Light attack | LMB / J | X / Square |
| Heavy attack (hold = charge) | RMB / K | Y / Triangle, RT / R2 |
| Light + Heavy together: Whirlwind | LMB+RMB / J+K | X+Y |
| Block · Parry · Counter (depends on Defense Style) | F / U / mouse back button | LB / L1 |
| Echo: tap = place / recall, hold = recall latest | E / L / mouse forward button | RB / R1 |
| Lock-on (no target = recenter camera) | R / MMB | R3 |
| Recenter camera | Q | R3 |
| **Loadout** (pauses) | Tab | Back / Select |
| Pause | Esc | Start |
| Toggle help · FPS | H · F3 | — |
| Mute · volume − / + | M · `-` / `=` | — |
| Training: input history + last move · move list | T · F1 | — |

### Loadout

Press **Tab** (gamepad **Back**) to open the Loadout: every ability is an upgrade you can toggle, tier up or pick
between, and changes apply instantly. Presets: **Base**, **Acrobat** (triple jump, wall-runs, slides, echo platforms),
**Assassin** (shadow clones that fight with you, swap), **Brawler** (counters, rewind), **Everything**.
Conflicting picks are greyed out with the reason (e.g. Echo Platform excludes Aerial Echo); "Switch anyway" resolves them.

## Mechanics

- **Combo strings** (full list in-game with **F1**): L L L (two slashes + Riven-style leap slam), L L H launcher
  (then jump after it for an air combo ending in a spike), L H spinning slash, H H H heavy string (the kick
  guard-breaks), hold H to charge 3 tiers, → H lunging stab, ← L backflip slash, roll → L sweep, air dash → L
  piercing dash strike, L+H whirlwind. Inputs are buffered; attacks turn toward your stick (or your lock-on
  target) and only step/lunge while you hold a direction — no stick input = attack in place. Air attacks
  hang you in place but never gain height. Roll/jump cancel after the hit frame.
- **Defense style** (loadout, pick one): *Block & Parry* (hold to block frontal hits; tap just before a hit to
  parry → slow-mo + riposte for double damage) · *Perfect Dodge* (roll right as a hit lands → witch time) ·
  *Counter* (press block when the "!" flashes over an attacking enemy → cinematic reversal). Optional **Stamina**
  rules make rolls, dashes, blocks and heavies cost stamina.
- **Movement kit** (loadout): double/triple jump with flips, 1–2 air dashes, restored by every air jump (eight-way: hold jump to dash up,
  sprint to dash down), slide → long jump, wall-run + wall kick (also chimney-climb between close walls), ledge
  grab / vault / hang / shimmy / climb (on by default).
- **Parkour gym** (east of the arena): slide bar → long-jump gap, wall-run lane, ledge stairs to a tower with a
  chimney; crossing the start line starts a timer, standing on the tower top stops it (best time saved).
- **Roll** (ground): somersault with i-frames; backstep when no direction is held. Roll can be jump-cancelled to carry momentum.
- **Air dash** (Shift / B in the air): fast horizontal dash with afterimages. One charge per airtime, refreshed on landing or recall.
- **Plunge**: attack while airborne (> ~1 m up) to dive down and slam.
- **Echo**: leave a hologram of yourself (6 s, flickers before it fades). Press again to recall to it.
  Recall works mid-air (recall into an aerial echo, then plunge to smash) and refreshes air jumps / dashes.
  Short cooldown afterwards. The echo is configured by the loadout (all live):
  - **Aerial Echo** (off by default): without it, echoes can only be *placed* on the ground — a mid-air press
    fizzles ("grounded only") and costs nothing. Recalling always works.
  - **Echo Stack** (1/2/3): a first-in-last-out stack; recall always returns to the **most recent** echo.
    Input rule: **tap** places while the stack has room and recalls once it is full;
    **hold ≥ 0.3 s** recalls the most recent echo even when the stack isn't full.
    The HUD shows one pip per slot with that echo's remaining time (each echo expires on its own).
  - **Recall mode**: *Teleport* (jump to the echo, it vanishes) · *Swap* (trade places — the echo stays at your old
    spot in your current pose, its timer topped up to 60 %) · *Rewind* (retrace your recorded path back to the echo
    in ~0.35 s, invulnerable, leaving a trail of afterimages; goes around whatever you walked around).
  - **Echo body**: *Phantom* (intangible) · *Platform* (a solid hex slab above the echo's head — jump on it,
    stack platforms into a staircase; excludes Aerial) · *Mimic* (the echo repeats your attacks ~0.1 s later
    from where it stands, turning toward the nearest target, for 60 % damage).
  - **Second Wind** (on): recall restores air jumps and air dashes. **Arrival Shockwave**: recall releases an AoE
    (14 dmg, knockback). **Echo Duration**: 6 / 9 / 12 s.

- **Enemies** (grunts between the arena and the town, and in the town plaza): they patrol, notice you (~12 m),
  chase, circle, then **telegraph** each swing (glowing sword and eyes, ~0.6 s) before striking. At most two
  attack at once. Hit them out of recovery; heavy hits interrupt wind-ups; launchers juggle them; they sometimes
  guard light frontal hits. They die, fade and respawn after ~6 s.
- **Health**: 100 HP (bar top-left, trailing damage segment). Getting hit flinches you with brief invulnerability;
  at 0 HP you die and respawn at the start. Console: `game.enemies.spawnNear(game.player)` drops a grunt in front of you.

The ruined pillars and the stepping stones to the south-west are climbable; try jump → air dash → echo chains.

**Ruined town** (north, ~60 m up the road from the arena, `src/world/Town.ts`): a gatehouse with battlements faces the arena,
curtain walls (some broken into steps), a keep wall with a timber scaffold and a wall walk, a 10 m watchtower whose corbelled
ledges spiral to the top (each 1.6 m apart: a plain jump reaches the next), houses with walkable stepped gable roofs or flat roofs
(one with an outside stair), an open walk-in ruin, market stalls, crates and low walls. A cobbled plaza (r ≈ 10 m) in the middle
is kept clear for fights. Heights go 1.0–1.2 m (vault), 2.2–3 m (ledge grab), 4.2–6.2 m (double jump / wall-run / echo), 7.5–10.4 m.
Every solid piece is a box collider matching its mesh; tall faces are tagged `wall`, tower ledges `ledge`. `TownSpots` exports a
plaza patrol loop for enemies.

## Code map

| Path | What |
|---|---|
| `src/config/bindings.ts` | All key / button bindings (action-based) |
| `src/config/tuning.ts` | Every gameplay number (speeds, combo timings, cooldowns) |
| `src/core/Input.ts` | Keyboard+mouse+gamepad → actions, with input buffering |
| `src/core/Game.ts` | Renderer, post-processing, loop, wiring. `game.step(s)` advances deterministically (debug/tests) |
| `src/player/Player.ts` | Kinematic controller + state machine (move, air, dodge, airdash, attack, plunge) |
| `src/player/CharacterModel.ts` | glTF loading, gear hiding, root-motion stripping, animation crossfades |
| `src/abilities/EchoRecall.ts` | The echo / shadow-recall ability (stack, recall modes, path recording, mimic hits) |
| `src/abilities/EchoInstance.ts` | One echo: hologram, ring, light, platform slab/collider, mimic replay |
| `src/ui/EchoHud.ts` | Echo ability circle + stack pips |
| `src/fx/*` | Hologram shader, ghosts/afterimages, particles, sword trail, shockwaves |
| `src/world/*` | Terrain heightfield, props & colliders, training dummies, sky/lighting, ruined town (`Town.ts`) |
| `src/enemy/*` | Enemy grunt AI / reactions (`Enemy.ts`), spawning + attack tokens (`EnemyManager.ts`), feature wiring |
| `src/player/states/hurt.ts` | Player `hurt` / `dead` states, post-hit grace, respawn |
| `src/ui/HealthBars.ts` | Player HP bar, low-HP vignette, death screen, enemy health bars |
| `src/ui/HUD.ts` | Control prompts (auto-switch by device), ability bar, combo pips, damage numbers |
| `src/audio/*` | Procedural WebAudio sound effects (`sounds.ts` recipes, `audioFeature.ts` event → sound map). Dev: `sfx.debug = true` logs every sound with its event, `await sfxTest()` renders each recipe offline |
| `src/ui/StyleMeter.ts` | Combo hit counter + D→S style rank (loadout `combat.styleMeter`) |
| `src/ui/Training.ts` | Training overlay: input history, last-move readout, move list generated from `config/moveList.ts` |

In the browser console, `game` is exposed for debugging (e.g. `game.player.state`, `game.step(0.5)`).

## Credits

Character: **KayKit Adventurers — Knight** by Kay Lousberg (www.kaylousberg.com), CC0. See `public/models/LICENSE-KayKit.txt`.
Enemies reuse the same Knight model with dark-tinted armour and glowing eyes.
