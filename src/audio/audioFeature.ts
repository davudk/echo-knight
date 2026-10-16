import type { Vector3 } from 'three';
import { events } from '../core/Events';
import type { Game } from '../core/Game';
import type { Feature } from '../features';
import { Sfx, renderSound, type PlayOpts } from './Sfx';
import { Sounds, type SoundName } from './sounds';

export const sfx = new Sfx();

type Play = (name: SoundName, opts?: PlayOpts) => void;
type Payload = any;

/**
 * Event → sound mapping. Adding a sound for a new event is one line here. Events that do not
 * exist yet (other workstreams) are harmless: they simply never fire.
 */
const SoundMap: Record<string, (p: Payload, play: Play) => void> = {
  'player:attack': (p, play) => play(p.heavy ? 'swingHeavy' : 'swingLight', { pos: p.position, delay: p.heavy ? 0.12 : 0.06 }),
  'player:hit': (p, play) => {
    const heavy = !!p.info?.heavy;
    const pos: Vector3 | undefined = p.target?.position;
    play(heavy ? 'hitHeavy' : 'hit', { pos });
    if (p.info?.source === 'echo') play('hitEcho', { pos });
  },
  'player:slam': (p, play) => play('slam', { pos: p.position }),
  'player:footstep': (p, play) => play('footstep', { pos: p.position, variant: p.sprint ? 'sprint' : '' }),
  'player:jump': (p, play) => (p.airJump > 0 ? play('airJump', { pos: p.position, variant: String(p.airJump) }) : play('jump', { pos: p.position })),
  'player:land': (p, play) => play('land', { pos: p.position, intensity: Math.min(1.2, Math.abs(p.impact ?? 0) / 18) }),
  'player:dodge': (p, play) => play('roll', { pos: p.position }),
  'player:airdash': (p, play) => play('airDash', { pos: p.position }),
  'player:damaged': (p, play) => play('damaged', { pos: p.position }),
  'player:blocked': (p, play) => play('block', { pos: p.position }),
  'player:parry': (p, play) => play('parry', { pos: p.position }),
  'player:perfect-dodge': (p, play) => play('perfectDodge', { pos: p.position }),
  'player:counter': (p, play) => play('parry', { pos: p.position }),
  'player:guard-break': (p, play) => play('block', { pos: p.position, intensity: 1.2 }),
  'player:riposte': (p, play) => play('hitHeavy', { pos: p.position }),
  'player:died': (p, play) => play('died', { pos: p.position }),
  'player:respawn': (p, play) => play('respawn', { pos: p.position }),
  'echo:placed': (p, play) => play('echoPlace', { pos: p.position, variant: String(p.index ?? 0) }),
  'echo:recalled': (p, play) => play('echoRecall', { pos: p.to, variant: p.mode }),
  'echo:expired': (p, play) => play('echoExpire', { pos: p.position }),
  'enemy:hit': (p, play) => play('enemyHit', { pos: p.position, variant: p.heavy ? 'heavy' : '' }),
  'enemy:died': (p, play) => play('enemyDied', { pos: p.position }),
  'enemy:attack': (p, play) => play('enemyAttack', { pos: p.position }),
  'loadout:changed': (_p, play) => play('uiClick', { ui: true }),
  'ui:pause': (p, play) => play('uiPause', { ui: true, variant: p.paused ? 'open' : 'resume' }),
  // Events other workstreams are adding (names guessed; extra entries cost nothing).
  'player:slide': (p, play) => play('slide', { pos: p.position }),
  'player:wallrun': (p, play) => play('grab', { pos: p.position }),
  'player:wall-run': (p, play) => play('grab', { pos: p.position }),
  'player:walljump': (p, play) => play('jump', { pos: p.position }),
  'player:wall-jump': (p, play) => play('jump', { pos: p.position }),
  'player:ledge': (p, play) => play('grab', { pos: p.position }),
  'player:ledge-grab': (p, play) => play('grab', { pos: p.position }),
  'player:climb': (p, play) => play('roll', { pos: p.position }),
  'player:ledge-climb': (p, play) => play('roll', { pos: p.position }),
  'echo:shockwave': (p, play) => play('echoShockwave', { pos: p.position }),
};

/** Style-meter rank-ups etc. can trigger sounds directly. */
export function playSfx(name: SoundName, opts?: PlayOpts) {
  sfx.play(name, opts);
}

let gameDt = 1 / 60;

export const audioFeature: Feature = {
  name: 'audio',
  install(game: Game) {
    sfx.camera = game.cam.camera;
    const on = events.on as (type: string, fn: (p: Payload) => void) => () => void;
    for (const [type, fn] of Object.entries(SoundMap)) {
      on.call(events, type, (p) => {
        try {
          fn(p, (name, opts) => sfx.play(name, { ...opts, from: type }));
        } catch (err) {
          console.warn('[sfx]', type, err);
        }
      });
    }
    events.on('ui:pause', ({ paused }) => sfx.setPaused(paused));
    sfx.setPaused(game.paused);

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyM') {
        const m = sfx.toggleMute();
        game.hud.flash(m ? 'sound off' : `sound on · ${Math.round(sfx.volume * 100)}%`, 1.1);
      } else if (e.code === 'Minus' || e.code === 'Equal' || e.code === 'NumpadSubtract' || e.code === 'NumpadAdd') {
        const up = e.code === 'Equal' || e.code === 'NumpadAdd';
        sfx.setVolume(Math.round((sfx.volume + (up ? 0.1 : -0.1)) * 10) / 10);
        game.hud.flash(`volume ${Math.round(sfx.volume * 100)}%`, 1.1);
        sfx.play('uiClick', { ui: true, from: 'volume' });
      }
    });

    if (import.meta.env.DEV) {
      Object.assign(window as object, {
        sfx,
        sfxTest: async () => {
          const out = [];
          for (const name of Object.keys(Sounds) as SoundName[]) out.push(await renderSound(name));
          for (const m of ['swap', 'rewind']) out.push(await renderSound('echoRecall', m));
          return out;
        },
      });
    }
  },
  update(dt) {
    gameDt = dt;
  },
  lateUpdate(rawDt) {
    // Slow-mo lowers pitch; hitstop (ratio ~0.04) is too short to bend sounds, so ignore it.
    const r = rawDt > 0 ? gameDt / rawDt : 1;
    const target = r < 0.1 || r > 0.9 ? 1 : 0.72 + 0.28 * r;
    sfx.timePitch += (target - sfx.timePitch) * Math.min(1, rawDt * 12);
  },
};
