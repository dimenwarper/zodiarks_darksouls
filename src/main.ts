import { Game } from './game';
import { installDebug } from './debug/panel';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
const game = new Game(canvas, hud);
const debug = installDebug(game);
(window as unknown as { __game: typeof debug }).__game = debug;
// Browsers only start audio from a user gesture.
const unlock = () => void game.audio.unlock();
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });
game.load().catch((err) => {
  console.error(err);
  hud.insertAdjacentHTML('beforeend', `<div class="loading">Failed to start: ${String(err)}</div>`);
});
