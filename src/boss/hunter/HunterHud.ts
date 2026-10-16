import { Camera, Vector3 } from 'three';
import { HUD } from '../../ui/HUD';

/**
 * The Hunter's duel HUD (Sekiro-style):
 *  - boss POSTURE bar floating above Kaede's head (grows from the centre, yellow → orange → red,
 *    white-hot when broken) with his remaining LIVES as two pips beside it,
 *  - the player's posture bar at the bottom centre (only visible while it is filling),
 *  - a red 危 ("peril") kanji flash above him at the start of every perilous (red) attack,
 *  - a big 斬 brush flash for deathblows, small call-outs ("Stomp!", "Lightning reversal").
 */
const CSS = `
.hk-float { position: absolute; transform: translate(-50%, -100%); pointer-events: none; display: none; width: 220px; text-align: center; }
.hk-lives { display: flex; gap: 6px; justify-content: center; margin-bottom: 5px; }
.hk-lives i { width: 10px; height: 10px; border-radius: 50%; background: #c8322a; box-shadow: 0 0 6px rgba(255,60,40,0.9), inset 0 0 0 1px rgba(0,0,0,0.5); }
.hk-lives i.lost { background: rgba(40,20,20,0.7); box-shadow: inset 0 0 0 1px rgba(200,120,100,0.5); }
.hk-posture { position: relative; height: 7px; background: rgba(10,8,6,0.72); border: 1px solid rgba(230,200,140,0.5); opacity: 0; transition: opacity 0.25s; }
.hk-posture .f { position: absolute; top: 0; bottom: 0; left: 50%; width: 0; transform: translateX(-50%); }
.hk-posture.broken .f { background: #fff4c8 !important; box-shadow: 0 0 12px rgba(255,230,150,1); }
.hk-posture .mid { position: absolute; left: 50%; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: rgba(255,240,200,0.6); }
.hk-kanji { position: absolute; transform: translate(-50%, -100%); pointer-events: none; opacity: 0;
  font: 700 54px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", "MS Mincho", serif; color: #ff2a1a;
  text-shadow: 0 0 14px rgba(255,40,20,0.95), 0 0 30px rgba(255,0,0,0.6), 0 2px 3px #000; }
.hk-player { position: absolute; left: 50%; bottom: 198px; width: min(30vw, 300px); transform: translateX(-50%); pointer-events: none; opacity: 0; transition: opacity 0.3s; }
.hk-player .hk-posture { opacity: 1; height: 6px; }
.hk-big { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); pointer-events: none; opacity: 0;
  font: 900 150px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", "MS Mincho", serif; color: #d81e12;
  text-shadow: 0 0 30px rgba(255,30,10,0.8), 0 4px 6px #000; }
.hk-call { position: absolute; left: 50%; top: 30%; transform: translateX(-50%); pointer-events: none; opacity: 0; white-space: nowrap;
  font: italic 600 22px Georgia, serif; letter-spacing: 0.18em; color: #e8f6ff; text-shadow: 0 0 12px rgba(120,200,255,0.95), 0 2px 3px #000; }
@media (max-width: 860px) { .hk-player { bottom: 190px; width: 50vw; } .hk-big { font-size: 96px; } .hk-float { width: 150px; } }
`;

export interface HunterHudState {
  /** world point above the boss's head (null = hide the floating widget) */
  head: Vector3 | null;
  posture: number;
  broken: boolean;
  lives: number;
  maxLives: number;
  playerPosture: number;
  playerBroken: boolean;
}

function postureColor(f: number) {
  // yellow → orange → red
  const r = 255;
  const g = Math.round(220 - 170 * Math.min(1, f));
  const b = Math.round(70 - 50 * Math.min(1, f));
  return `rgb(${r},${g},${b})`;
}

export class HunterHud {
  private readonly float: HTMLElement;
  private readonly lives: HTMLElement;
  private readonly bossBar: HTMLElement;
  private readonly bossFill: HTMLElement;
  private readonly player: HTMLElement;
  private readonly playerBar: HTMLElement;
  private readonly playerFill: HTMLElement;
  private readonly kanji: HTMLElement;
  private readonly big: HTMLElement;
  private readonly call: HTMLElement;
  private kanjiT = -1;
  private kanjiPos = new Vector3();
  private bigT = -1;
  private callT = -1;
  private livesShown = -1;
  private bossVis = 0;
  private readonly v = new Vector3();

  constructor(hud: HUD) {
    HUD.addStyles('hk-hunter', CSS);
    const mk = (cls: string, html = '') => {
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML = html;
      return hud.mount(el);
    };
    this.float = mk('hk-float', '<div class="hk-lives"></div><div class="hk-posture"><div class="f"></div><div class="mid"></div></div>');
    this.lives = this.float.querySelector('.hk-lives')!;
    this.bossBar = this.float.querySelector('.hk-posture')!;
    this.bossFill = this.float.querySelector('.f')!;
    this.player = mk('hk-player', '<div class="hk-posture"><div class="f"></div><div class="mid"></div></div>');
    this.playerBar = this.player.querySelector('.hk-posture')!;
    this.playerFill = this.player.querySelector('.f')!;
    this.kanji = mk('hk-kanji');
    this.big = mk('hk-big');
    this.call = mk('hk-call');
  }

  /** Red peril kanji above the boss (start of a red attack). */
  peril(at: Vector3, text = '危') {
    this.kanji.textContent = text;
    this.kanjiPos.copy(at);
    this.kanjiT = 0;
  }

  /** Big centre-screen brush character (deathblow). */
  deathblow(text = '斬') {
    this.big.textContent = text;
    this.bigT = 0;
  }

  callout(text: string) {
    this.call.textContent = text;
    this.callT = 0;
  }

  hide() {
    this.float.style.display = 'none';
    this.player.style.opacity = '0';
    this.kanjiT = -1;
    this.kanji.style.opacity = '0';
  }

  update(dt: number, camera: Camera, w: number, h: number, s: HunterHudState) {
    // ---- floating boss widget
    if (s.head) {
      const p = this.v.copy(s.head).project(camera);
      const on = p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2;
      this.float.style.display = on ? 'block' : 'none';
      if (on) {
        this.float.style.left = `${((p.x + 1) / 2) * w}px`;
        this.float.style.top = `${((1 - p.y) / 2) * h}px`;
      }
      if (this.livesShown !== s.lives) {
        this.livesShown = s.lives;
        this.lives.innerHTML = Array.from({ length: s.maxLives }, (_, i) => `<i class="${i < s.lives ? '' : 'lost'}"></i>`).join('');
      }
      const f = Math.min(1, Math.max(0, s.posture));
      this.bossVis += ((f > 0.01 || s.broken ? 1 : 0) - this.bossVis) * Math.min(1, dt * 8);
      this.bossBar.style.opacity = `${this.bossVis}`;
      this.bossFill.style.width = `${f * 100}%`;
      this.bossFill.style.background = postureColor(f);
      this.bossBar.classList.toggle('broken', s.broken);
    } else {
      this.float.style.display = 'none';
    }

    // ---- player posture
    const pf = Math.min(1, Math.max(0, s.playerPosture));
    this.player.style.opacity = s.head && (pf > 0.01 || s.playerBroken) ? '1' : '0';
    this.playerFill.style.width = `${pf * 100}%`;
    this.playerFill.style.background = postureColor(pf);
    this.playerBar.classList.toggle('broken', s.playerBroken);

    // ---- kanji
    if (this.kanjiT >= 0) {
      this.kanjiT += dt;
      const t = this.kanjiT;
      const a = t < 0.06 ? t / 0.06 : Math.max(0, 1 - (t - 0.35) / 0.3);
      const p = this.v.copy(this.kanjiPos).project(camera);
      this.kanji.style.left = `${((p.x + 1) / 2) * w}px`;
      this.kanji.style.top = `${((1 - p.y) / 2) * h}px`;
      this.kanji.style.opacity = p.z < 1 ? `${a}` : '0';
      this.kanji.style.transform = `translate(-50%, -100%) scale(${1.35 - Math.min(1, t / 0.12) * 0.35})`;
      if (t > 0.7) this.kanjiT = -1;
    }
    if (this.bigT >= 0) {
      this.bigT += dt;
      const t = this.bigT;
      const a = t < 0.08 ? t / 0.08 : Math.max(0, 1 - (t - 0.9) / 0.5);
      this.big.style.opacity = `${a}`;
      this.big.style.transform = `translate(-50%, -50%) scale(${1.25 - Math.min(1, t / 0.15) * 0.25 + t * 0.03})`;
      if (t > 1.4) this.bigT = -1;
    }
    if (this.callT >= 0) {
      this.callT += dt;
      const t = this.callT;
      this.call.style.opacity = `${t < 0.1 ? t / 0.1 : Math.max(0, 1 - (t - 1.1) / 0.4)}`;
      if (t > 1.5) this.callT = -1;
    }
  }
}
