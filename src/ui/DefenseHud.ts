import { Camera, Vector3 } from 'three';
import { HUD } from './HUD';

/**
 * Defense HUD pieces: witch-time tint, parry / counter screen flash, counter prompt projected
 * over the attacking enemy, and a "Riposte" cue while a riposte is armed.
 */
const CSS = `
.ek-witch { position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: radial-gradient(ellipse at center, rgba(60,120,255,0.10) 35%, rgba(30,60,200,0.42) 100%);
  mix-blend-mode: screen; }
.ek-witch::after { content: ''; position: absolute; inset: 0; background: rgba(40,80,190,0.22); mix-blend-mode: multiply; }
.ek-dflash { position: absolute; inset: 0; pointer-events: none; opacity: 0; background: radial-gradient(ellipse at center,
  rgba(255,255,255,0.55) 0%, rgba(200,225,255,0.25) 45%, rgba(0,0,0,0) 80%); }
.ek-counter { position: absolute; transform: translate(-50%, -100%); pointer-events: none; display: none;
  text-align: center; font: 700 34px Georgia, serif; color: #ffe27a; text-shadow: 0 0 10px rgba(255,170,40,0.95), 0 2px 3px #000; }
.ek-counter .key { display: inline-block; margin-top: 2px; padding: 1px 7px; font: 600 12px system-ui, sans-serif;
  color: #1a1206; background: #ffe27a; border-radius: 4px; box-shadow: 0 0 10px rgba(255,190,60,0.8); }
.ek-riposte { position: absolute; left: 50%; top: 62%; transform: translate(-50%, 0); pointer-events: none; opacity: 0;
  font: italic 600 18px Georgia, serif; letter-spacing: 0.2em; color: #f4f0ff; text-shadow: 0 0 10px rgba(150,180,255,0.95); }
`;

export class DefenseHud {
  private readonly witch: HTMLElement;
  private readonly flashEl: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly promptKey: HTMLElement;
  private readonly riposte: HTMLElement;
  private flashV = 0;
  private readonly v = new Vector3();

  constructor(hud: HUD) {
    HUD.addStyles('ek-defense', CSS);
    const mk = (cls: string) => {
      const el = document.createElement('div');
      el.className = cls;
      return hud.mount(el);
    };
    this.witch = mk('ek-witch');
    this.flashEl = mk('ek-dflash');
    this.prompt = mk('ek-counter');
    this.prompt.innerHTML = '<div>!</div><span class="key"></span>';
    this.promptKey = this.prompt.querySelector('.key')!;
    this.riposte = mk('ek-riposte');
    this.riposte.textContent = 'RIPOSTE';
  }

  flash(strength = 1) {
    this.flashV = Math.max(this.flashV, strength);
  }

  update(
    dt: number,
    camera: Camera,
    w: number,
    h: number,
    s: {
      /** 0..1 witch-time tint */
      witch: number;
      /** world position to show the counter prompt at (null = hidden), 0..1 urgency */
      counterAt: Vector3 | null;
      counterUrgency: number;
      keyLabel: string;
      riposte: number;
    },
  ) {
    this.witch.style.opacity = `${s.witch}`;
    this.flashV = Math.max(0, this.flashV - dt * 5);
    this.flashEl.style.opacity = `${this.flashV}`;
    this.riposte.style.opacity = `${s.riposte > 0 ? 0.55 + 0.45 * Math.sin(performance.now() / 70) : 0}`;

    if (s.counterAt) {
      this.v.copy(s.counterAt).project(camera);
      if (this.v.z < 1) {
        this.prompt.style.display = 'block';
        this.prompt.style.left = `${(this.v.x * 0.5 + 0.5) * w}px`;
        this.prompt.style.top = `${(-this.v.y * 0.5 + 0.5) * h}px`;
        const sc = 0.9 + 0.5 * s.counterUrgency;
        this.prompt.style.transform = `translate(-50%, -100%) scale(${sc})`;
        if (this.promptKey.textContent !== s.keyLabel) this.promptKey.textContent = s.keyLabel;
        return;
      }
    }
    this.prompt.style.display = 'none';
  }
}
