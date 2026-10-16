import './style.css';
import { Game } from './core/Game';

const game = new Game(document.getElementById('app')!, document.getElementById('hud')!);
const loading = document.getElementById('loading')!;

game
  .init()
  .then(() => loading.classList.add('done'))
  .catch((err) => {
    console.error(err);
    loading.textContent = `Failed to load: ${err?.message ?? err}`;
  });
