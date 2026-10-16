import type { Feature } from '../features';
import { EchoRecall } from './EchoRecall';

/** Wires the echo ability into the game. */
export const echoFeature: Feature = {
  name: 'echo',
  install(game) {
    game.echo = new EchoRecall(game.player, game.world, game.fx, game.cam, game.input, (e) => {
      if (e === 'expired') game.hud.flash('echo faded', 0.9);
    });
  },
  update(dt, game) {
    game.echo.update(dt);
  },
};
