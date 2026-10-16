# Boss framework (`src/boss/`)

Everything a boss needs — attack data + runner, hitbox shapes, AI director, poise / stagger /
riposte, phases, arena kit (fog gate, checkpoint, hazards), HUD, flasks and difficulty — so a new
boss is mostly **data + a few hooks**. The working reference is **The Gate Sentinel**
(`sentinel/`): copy that folder to start.

| File | What |
|---|---|
| `types.ts` | Attack data format (`AttackDef`, `AttackStep`, `HitboxDef`, `MoveSeg`, `TelegraphKind`) |
| `Boss.ts` | `Boss` base class + `BossDef` (HP, phases, poise, riposte, speeds, anims, attacks, director) |
| `AttackRunner.ts` | Plays an `AttackDef`: windup → active → recovery per step, retimed clips, movement, decals, hitboxes, grabs |
| `Hitboxes.ts` | Geometry tests + `BossEffects` (pooled shockwave rings and projectiles) |
| `Decals.ts` | Pooled ground telegraph decals (circle / ring / sector / rect) + `TelegraphColors` |
| `Director.ts` | AI: weighted per-phase attack lists, range / angle / player conditions, cooldowns, combos, idle movement, punish |
| `Arena.ts` | `BossArena`, `FogGate`, `HazardZone`, `registerBossArena` (Travel menu registry) |
| `grab.ts` | Player `grabbed` state, `probeDefenses`, throw / escape |
| `difficulty.ts` | `Difficulty` helpers (loadout `challenge.difficulty`) |
| `models.ts` | `loadBossModel(file, height, keepGear)` — cached KayKit characters, cloned per boss |
| `bossFeature.ts` | `BossManager` (`game.bosses`), boss HUD, travel menu, dev hooks |
| `sentinel/` | The example boss (`attacks.ts` = the moveset, `Sentinel.ts` = def + class + spawn) |
| `../ui/BossBar.ts` | Bottom boss bar(s) + "GREAT ENEMY FELLED" banner |
| `../player/states/heal.ts` | Flasks (`heal` state, `flasks.refill()`) |

---

## Build a boss in 7 steps

1. **Folder**: `src/boss/<name>/` with `attacks.ts` and `<Name>.ts` (copy `sentinel/`).
2. **Model**: `await loadBossModel('Barbarian', height, ['2H_Axe', 'Barbarian_Hat'])` — `keep` lists the gear
   nodes to show (`CharacterGear` in `models.ts` lists every node). Height: the player is 1.85 m; 1.6× ≈ 2.96.
   All KayKit characters share the rig and all 76 clips (list them with `model.has(name)`; see the
   clip table at the end).
3. **Attacks** (`attacks.ts`): an array of `AttackDef` — see the reference below. Start from the Sentinel's.
4. **Def** (`BossDef`): id, name, title, maxHealth, radius, height, `phases`, `poise`, `riposte`, `speeds`,
   `anims`, `attacks`, `director`, `weapon` (glowing node), `tint`, `eyeColor`.
5. **Class**: `class Warden extends Boss` — override hooks only for special mechanics:
   `onPhaseEnter(phase)`, `onEngage()`, `onReset()`, `onDefeated()`, `onUpdate(dt)`,
   `onAttackStep(attack, step, 'active' | 'recovery')`, `decide(ctx)` (director override),
   `onCustomState(dt)` (+ `setCustom(duration)` / `toIdle()`), `idleMove(...)` (flying / teleporting).
6. **Arena + feature**: one `Feature` file (one line in `features/index.ts`):
   ```ts
   export const wardenFeature: Feature = {
     name: 'boss-warden',
     install(game) {
       const arena = new BossArena(game, { id: 'warden', name: "Warden's Keep", region: Regions.warden });
       void loadBossModel('Knight', 2.9, ['2H_Sword']).then((model) => {
         const boss = new Warden(game, model);
         const r = Regions.warden;
         boss.placeAt(r.x, r.z, Math.atan2(arena.entry.x - r.x, arena.entry.z - r.z)); // face the gate
         game.bosses.add(boss);
         arena.addBoss(boss);
       });
     },
   };
   ```
   `BossArena` registers itself in the Travel menu (pause → Travel). Use `gateDir` to move the gate
   (default: on the edge facing the world centre).
7. **Test** with `dbg` (recipes below). Keep the fairness rules.

---

## Attack data reference (`types.ts`)

```ts
const cleave: AttackDef = {
  id: 'cleave', telegraph: 'parryable',          // gold / red / cyan (see colour rules)
  steps: [{                                       // one entry per swing; strings have several
    windup: 0.85, active: 0.14, recovery: 1.1,    // seconds (Normal)
    anim: { clip: '2H_Melee_Attack_Chop', startAt: 0.15, hitFrame: 0.78, speed: 1, pacing: 'linear' },
    move: [{ kind: 'lunge', during: 'windup', from: 0.55, to: 1, distance: 2.6, stopAt: 1.0 }],
    track: { windup: 3.5, active: 0, recovery: 0.8 },   // turn-rate limits (rad/s)
    hitboxes: [{ shape: 'cone', range: 3.7, arc: 70 }],
    damage: 22, knockback: 7, heavy: true,
    // optional: telegraph, parryable, unblockable, parryPoise, onParry, shake, flash, extraAnims
  }],
};
```

**Timing.** Each step runs `windup → active → recovery`. `windup` is multiplied by
`Difficulty.telegraph()` (Story 1.3 / Normal 1 / Souls 0.85); the **last step's** `recovery` (the punish
window) by `Difficulty.recovery()`. Mid-string recoveries are short gaps and are not scaled.

**Animation.** `anim.hitFrame` is the clip time of the impact; the runner drives the clip so that frame
lands exactly on the active start (`startAt → hitFrame` during the windup), then plays at `speed`.
`pacing: 'hold'` plays 80 % of the wind-up fast, **freezes in the raised pose**, then snaps through —
this is how a *delayed* hit is expressed (see `triple`, step 3). `extraAnims` play other clips at a
fraction of a phase.

**Movement** (`move`, fractions `from/to` of the phase given in `during`):
`lunge` (forward, stops `stopAt` m from the player), `retreat`, `strafe` (+ = boss's left),
`leap` (ballistic arc to the player's position captured at the leap start, clamped to `maxDistance`,
landing `stopAt` short — put it at the end of the windup to slam on the first active frame).

**Flags** (defaults come from the colour): `parryable` (= gold), `unblockable` (= red), `onParry`
(`'recoil'` default: flinch + cancel the string, `'stagger'`: full stagger + riposte, `'none'`: poise only —
Sekiro deflect), `parryPoise`, `heavy` (default true), `shake` (camera shake on active).

**Strings with delays** = several steps; vary each step's `windup` (and `pacing: 'hold'`). Variable
combo lengths = director follow-ups (below).

## Hitbox shapes

All shapes test the player as a vertical capsule (radius 0.45) at its feet. `yMin/yMax` (relative to the
boss's feet) limit which player heights are hit — e.g. a low sweep with `yMax: 0.7` can be jumped.
`delay` (s after the active start) staggers boxes; `duration` (default: the step's active time);
`damage` / `knockback` / `telegraph` override the step's; `decal` toggles the ground telegraph.

| Shape | Key fields | Notes |
|---|---|---|
| `cone` | `range, arc, offset?` | evaluated every active frame (one hit) |
| `sweep` | `range, from, to, width?, inner?` | blade arc rotating `from→to` degrees (0 = facing, + = left) over the active window; hits only what it passes |
| `line` | `length, width, offset?, yawFrom?, yawTo?, trackRate?, tick?` | capsule / laser; rotates `yawFrom→yawTo` or tracks the player; `tick` = repeated hits |
| `circle` | `radius, at: 'self' \| 'forward' \| 'player' \| 'leap', distance?, around?, lockAt?` | instant AoE at the box's start time; the decal fills from the centre lock to impact. `lockAt` = fraction of the windup when the point is chosen (0 = windup start — fair) |
| `ring` | `speed, maxRadius, thickness?, startRadius?, at?` | expanding shockwave (pooled, outlives the step). **Hits only a grounded player** (≤ 0.35 m above ground) as the edge passes — jump over it; roll i-frames also work |
| `grab` | `range, arc, hold, holdClip?, throwClip?, holdOffset?, holdHeight?, throwKnockback?` | unblockable, not parryable; only i-frames (a dodge before it lands), the perfect-dodge window or post-hit grace avoid it. Caught → player `grabbed` state → thrown after `hold` for the step's damage |
| `projectile` | `speed, count?, spread?, interval?, homing?, lifetime?, radius?, reflectable?, height?, offset?, aim?, reflectDamage?, reflectPoise?` | pooled. `reflectable` shots are parryable even when cyan: a parry sends them back (damage + poise to the boss) |

Ground decals (`Decals.ts`): circle, ring, sector (cone / sweep / grab / rotating line) and rect (line)
— they **fill up during the windup** and flash on impact. Defaults: on for `circle`, `ring`, `line`; off
for `cone` / `sweep` (opt in with `decal: true`).

## Telegraph colour rules (fairness rule #1)

| Colour | `telegraph` | Block | Parry | Counter style | Typical |
|---|---|---|---|---|---|
| **Gold** | `parryable` | yes (chip) | yes → recoil / poise | yes | melee swings |
| **Red** | `unblockable` | no | no | no | grabs, slams, shockwaves |
| **Cyan** | `magic` | yes (chip) | **no — a parry attempt just blocks** | no | spells, AoE, beams; `reflectable` projectiles *can* be parried back |

At every windup start the boss flashes (eyes / chest burst), its weapon and eyes glow in the colour,
and `boss:attack` fires (the audio maps it to a per-colour cue). Keep **every** attack telegraphed.

## Director options (`Director.ts`)

```ts
director: { phases: [ {                    // index = boss phase (missing → last)
  aggression: 0.45,                        // 0 patient … 1 relentless (idle gap inside idleTime)
  idleTime: [0.5, 1.8],                    // gap between attacks (s)
  preferredRange: [2.8, 6],                // where it strafes while idle
  attacks: [
    { attack: 'cleave', weight: 3, range: [0, 4.2],
      followUps: [{ attack: 'sweep', chance: 0.3, range: [0, 4.5] }] },
    { attack: 'sweep', weight: 4, range: [0, 4.4], angle: 'behind' },   // anti-flank
    { attack: 'grab', weight: 1.2, range: [0, 3.2], cooldown: 7, player: 'grounded' },
    { attack: 'bolt', weight: 1.6, range: [6, 22], cooldown: 3.5 },
    // angle: 'front' (default) | 'side' | 'behind' | 'any'; player: 'any' | 'grounded' | 'airborne' | 'above'
    // when: (ctx) => boolean; followUpOnly: true (never an opener)
  ],
  punish: { heal: ['bolt', 'quake'], whiff: [], reaction: 0.3 },   // ids must also be in `attacks`
} ] }
```

- **No identical attack three times in a row** (openers and follow-ups).
- **Follow-ups** roll when the last step's recovery starts and chain after `def.chainDelay` (0.12 s) — the
  follow-up still has its own full windup.
- **Idle**: approach (run when far) / strafe around `preferredRange` / back off / wait.
- **Punish**: `player.state === 'heal'` (flask) or `player.attacking` in range → a punish attack after
  `reaction` seconds.
- **Override** in the boss: `decide(ctx)` returns `{ attack: id }`, `{ idle: 'strafe', duration, dir }` or `null`.
  `ctx`: `dist, angle, side, airborne, above, healing, attacking, phase, history`.

## Poise, stagger, riposte, phases

- `poise.max`; damage adds `dmg × damageMul` (×1.5 heavy, +12 guard-break, ×0.5 echo); regen after
  `regenDelay`. Parry adds `parryPoise` (per step override), counter `counterPoise`, reflected shots
  `reflectPoise`. Full → `stagger(staggerTime, cause, true)`: damage × `vulnerableMul`, and **any player
  light/heavy attack from the front (`riposte.range`, `arcDeg`)** triggers the finisher: `riposte.damage`,
  hitstop + slow-mo, knockdown for `riposte.knockdown` s.
- `phases: [{ threshold: 1 }, { threshold: 0.5, transition: { duration, clip, speed, shake } }]` — crossing a
  threshold cancels the attack, plays the transition (invulnerable, camera shake, HUD phase tick, music
  cue) and calls `onPhaseEnter(i)`.
- Any custom stagger: `boss.stagger(seconds, 'custom', riposte)`; poise: `boss.addPoise(n, 'custom')`.

## Player defenses vs bosses

`boss.hitPlayer(spec)` → `player.receiveHit` with `unblockable`, `parryable` (new optional field on
`IncomingHit`; `false` = a parry attempt only blocks) and `attacker: boss`. Results: `parried` → poise +
reaction; `blocked` → chip; perfect dodge / i-frames → `dodged`. The **counter** style sees bosses through
`counterThreatSources` (defense.ts): `boss.attacking` is true only while a **gold** step winds up,
`boss.attackTimeRemaining` = seconds to its active frame.

## Arena kit (`Arena.ts`)

- `new BossArena(game, { id, name, region, gateDir?, gateWidth?, travel? })`, `arena.addBoss(boss)`.
- **Fog gate** on the arena edge; walking in (anywhere inside `radius − 0.8`) starts the fight: the gate
  gets a collider, a fog wall rings the arena and keeps the player inside, the **checkpoint** moves to
  `arena.entry` (outside the gate). Standing at the gate refills flasks (toast prompt).
- **Player death** → on respawn every boss `reset()`s, hazards switch off, the gate opens, flasks refill.
- **Victory** (all bosses dead) → the fog lifts, the old spawn point is restored, `arena:music victory`.
- **Hazards**: `arena.addHazard(new HazardZone(game, { x, z, radius, damage, interval, airborneToo?, contains? }))`;
  `setActive(bool)`, change `radius`, or give `contains(x, y, z)` (e.g. a rising water level).
- **Music / ambience**: `arena:music` (`fight` / `phase` / `victory` / `stop`), `arena:seal`, `arena:checkpoint`
  events — map them in `audio/audioFeature.ts`.
- **Bounds**: bosses are clamped inside `region.radius − radius` (`boss.clampToArena(v)`).

## Events (`core/Events.ts`)

`boss:engage {id,name,position}` · `boss:phase {id,phase}` · `boss:stagger {id,duration,cause,riposte}` ·
`boss:attack {id,attackId,step,telegraph,windup}` · `boss:hit {id,damage,heavy,critical}` ·
`boss:riposte {id,damage}` · `boss:grab {id,phase:'catch'|'throw'|'escape'}` · `boss:reflect {id}` ·
`boss:defeated {id,name}` · `boss:reset {id}` · `arena:seal` · `arena:music` · `arena:checkpoint` ·
`player:heal-start` · `player:heal` · `player:heal-empty` · `player:grabbed`.

## Difficulty (`difficulty.ts`)

`Difficulty.damage() / telegraph() / recovery() / flasks() / bossHealth()` and `Difficulty.scaleDamage(n)`.
Story ×0.5 dmg, ×1.3 windows, 5 flasks, ×0.7 HP · Normal ×1, 3 flasks · Souls ×1.35 dmg, ×0.85 windows,
2 flasks, ×1.15 HP. Bosses apply all of it automatically; grunts apply the damage factor.

## Testing recipes (`window.dbg`, dev server)

```js
dbg.freeze(); dbg.start(); dbg.tp(30, 30, 0);                // open ground away from every boss arena
const B = await game.bosses.spawnTest({ distance: 17 });     // Sentinel + test arena in front of you
dbg.down('KeyW'); dbg.step(1.8); dbg.up('KeyW');             // walk through the fog → fight starts
B.director.delay(99);                                        // freeze the AI between scripted attacks
B.startAttack('quake'); dbg.step(0.5);                       // force an attack
B.runner.timeToActive                                        // seconds to the active frame (time parries / rolls)
B.addPoise(100, 'custom');                                   // stagger → dbg.tap('KeyJ') = riposte
B.health = B.maxHealth * 0.5 + 5;                            // then hit it → phase transition
dbg.loadout.set('challenge.difficulty', 'souls'); B.reset();
dbg.events.on('boss:attack', (e) => console.log(e.attackId, e.telegraph));
await dbg.sheet('quake', [0.3, 0.7, 1.0, 1.3, 1.45, 1.65], () => B.startAttack('quake'), { x: 0, y: 0.15, w: 1, h: 0.8 });
```

Shift+B (dev) spawns / respawns the Sentinel test fight in front of you. `game.bosses.arenas[i].rematch()`
revives a cleared arena.

## KayKit clips useful for bosses

Melee: `2H_Melee_Attack_Chop` (1.63 s, impact ≈ 0.78) · `2H_Melee_Attack_Slice` (1.1, ≈ 0.42) ·
`2H_Melee_Attack_Stab` (1.6, ≈ 0.72) · `2H_Melee_Attack_Spin` (2.4) · `2H_Melee_Attack_Spinning` (0.67, loop) ·
`1H_Melee_Attack_*` · `Dualwield_Melee_Attack_*` · `Unarmed_Melee_Attack_Kick / Punch_A / Punch_B`.
Magic / ranged: `Spellcast_Shoot` (0.93, ≈ 0.45) · `Spellcast_Raise` (2.1, ≈ 1.0) · `Spellcast_Long` · `Spellcasting` (loop) ·
`Throw` · `1H/2H_Ranged_*`. Reactions: `Hit_A`, `Hit_B`, `Block*`, `Death_A/B`, `Lie_Down/Idle/StandUp`,
`Cheer` (roar), `Jump_*`, `Dodge_*`, `Sit_Floor_*` (kneel).

## Performance notes

Decals, rings and projectiles are pooled; the runner reuses its box records; geometry tests are
allocation-free. In the scripted test, 42 s of a phase-2 Sentinel fight simulated in ~0.4 s (the whole game,
rendering only the last frame of each step).
