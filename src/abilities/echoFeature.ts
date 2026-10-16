import { events } from '../core/Events';
import type { Feature } from '../features';
import { EchoHud } from '../ui/EchoHud';
import { EchoRecall } from './EchoRecall';

let hud: EchoHud | null = null;

/** Wires the echo ability (and its HUD widget) into the game. */
export const echoFeature: Feature = {
  name: 'echo',
  install(game) {
    game.echo = new EchoRecall(game.player, game.world, game.fx, game.cam, game.input, (d) => game.hitstop(d));
    hud = new EchoHud(game.hud, game.input);
    events.on('echo:expired', () => {
      if (!game.echo.stack.length) game.hud.flash('echo faded', 0.9);
    });
    events.on('echo:fizzle', ({ reason }) => {
      game.hud.flash(reason, 0.8);
      hud?.shake();
    });
  },
  update(dt, game) {
    game.echo.update(dt);
  },
  lateUpdate(dt, game) {
    hud?.update(dt, game.echo);
  },
};
