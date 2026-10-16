import { Vector3 } from 'three';
import type { Game } from './Game';

/**
 * Dev-only test harness, exposed as `window.dbg`. Lets you (or an agent driving a browser)
 * script inputs and inspect frames deterministically, even in a throttled background tab.
 *
 *   dbg.freeze()                 stop the real-time loop (use step() from now on)
 *   dbg.start()                  dismiss the overlay, unpause
 *   dbg.down('KeyW') / up / tap  simulate keys (tap = down, 1 frame, up)
 *   dbg.mouse(0, true/false)     simulate mouse buttons
 *   dbg.step(0.5)                advance 0.5 s at 60 Hz (renders last frame)
 *   dbg.tp(x, z, facing?)        teleport the player (y = ground)
 *   dbg.cam(yaw, pitch)          set the camera
 *   await dbg.sheet('label', [0.1, 0.2, ...], setupFn)  contact sheet of frames (shown on top of page)
 *   dbg.clearSheets()
 *   dbg.state()                  compact player/echo state string
 */
export function installDebug(game: Game) {
  const keys = (code: string, down: boolean) =>
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  const canvas = game.renderer.domElement;

  const dbg = {
    game,
    freeze(v = true) {
      game.setFrozen(v);
    },
    start() {
      game.pauseOnUnlock = false; // scripted tests run without a mouse lock
      game.setPaused(null);
      game.pauseReason = null;
    },
    down: (code: string) => keys(code, true),
    up: (code: string) => keys(code, false),
    tap(code: string) {
      keys(code, true);
      game.step(1 / 60);
      keys(code, false);
    },
    mouse(button: number, down: boolean) {
      if (down) canvas.dispatchEvent(new MouseEvent('mousedown', { button }));
      else window.dispatchEvent(new MouseEvent('mouseup', { button }));
    },
    step: (s: number) => game.step(s),
    tp(x: number, z: number, facing = Math.PI, y?: number) {
      const gy = y ?? game.world.groundAt(x, z);
      game.player.teleport(new Vector3(x, gy, z), facing);
    },
    cam(yaw: number, pitch = 0.3) {
      game.cam.yaw = yaw;
      game.cam.pitch = pitch;
    },
    state() {
      const p = game.player;
      return `${p.state} t=${p.stateTime.toFixed(2)} pos=${p.position.toArray().map((v) => v.toFixed(2))} vel=${p.velocity
        .toArray()
        .map((v) => v.toFixed(1))} grounded=${p.grounded} anim=${p.model.currentName} hp=${p.health}`;
    },
    async sheet(label: string, times: number[], setup: () => void, crop = { x: 0.32, y: 0.28, w: 0.36, h: 0.5 }) {
      (game.renderer as any).preserveDrawingBuffer = true;
      const W = 260;
      const H = 240;
      const c = document.createElement('canvas');
      c.width = W * times.length;
      c.height = H;
      const ctx = c.getContext('2d')!;
      setup();
      let prev = 0;
      for (let i = 0; i < times.length; i++) {
        game.step(Math.max(1 / 60, times[i] - prev));
        prev = times[i];
        ctx.drawImage(canvas, canvas.width * crop.x, canvas.height * crop.y, canvas.width * crop.w, canvas.height * crop.h, i * W, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.font = '13px monospace';
        ctx.fillText(`${label} ${times[i].toFixed(2)} ${game.player.state}`, i * W + 4, 15);
      }
      let box = document.getElementById('dbg-sheets');
      if (!box) {
        box = document.createElement('div');
        box.id = 'dbg-sheets';
        box.style.cssText = 'position:fixed;left:0;top:0;width:100%;z-index:999;background:#000';
        document.body.appendChild(box);
      }
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;display:block';
      img.src = c.toDataURL();
      box.appendChild(img);
      return 'ok';
    },
    clearSheets() {
      document.getElementById('dbg-sheets')?.remove();
    },
  };
  (window as unknown as { dbg: typeof dbg }).dbg = dbg;
}
