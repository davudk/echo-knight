import {
  ACESFilmicToneMapping,
  Clock,
  PCFSoftShadowMap,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { EchoRecall } from '../abilities/EchoRecall';
import { features, type Feature } from '../features';
import { events } from './Events';
import { installDebug } from './debug';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { Tuning } from '../config/tuning';
import { Fx } from '../fx/Fx';
import { CharacterModel } from '../player/CharacterModel';
import { Player } from '../player/Player';
import { HUD } from '../ui/HUD';
import { Dummy } from '../world/Dummy';
import { buildProps } from '../world/Props';
import { Sky } from '../world/Sky';
import { Regions, Terrain } from '../world/Terrain';
import { World } from '../world/World';
import { Input } from './Input';

const MODEL_URL = `${import.meta.env.BASE_URL}models/Knight.glb`;

/** Owns the renderer and wires every system together. */
export class Game {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly input: Input;
  readonly world: World;
  readonly cam: ThirdPersonCamera;
  readonly fx: Fx;
  readonly hud: HUD;
  readonly sky: Sky;
  player!: Player;
  echo!: EchoRecall;
  readonly dummies: Dummy[] = [];
  readonly features: Feature[] = [];
  composer!: EffectComposer;
  private readonly clock = new Clock();
  private hitstopTimer = 0;
  private slowmoTimer = 0;
  private slowmoScale = 1;
  /** seconds since start (real time, includes pauses) */
  time = 0;
  /** why the game is paused: start/pause overlay, or a menu (loadout panel) */
  pauseReason: 'overlay' | 'menu' | null = 'overlay';
  private frozen = false;
  /** pause when the mouse lock is lost (Esc). Disabled by the dev harness for scripted tests. */
  pauseOnUnlock = true;

  get paused() {
    return this.pauseReason !== null;
  }

  constructor(container: HTMLElement, hudRoot: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.input = new Input(this.renderer.domElement);
    this.hud = new HUD(hudRoot);
    this.sky = new Sky(this.scene);

    const terrain = new Terrain({
      size: 240,
      segments: 160,
      seed: 1337,
      flats: [
        { x: Regions.town.x, z: Regions.town.z, radius: Regions.town.radius, blend: 14 },
        { x: Regions.gym.x, z: Regions.gym.z, radius: Regions.gym.radius, blend: 12 },
      ],
    });
    this.scene.add(terrain.mesh);
    this.world = new World(this.scene, terrain);
    buildProps(this.world);

    this.cam = new ThirdPersonCamera(window.innerWidth / window.innerHeight, this.world);
    this.fx = new Fx(this.scene);
    this.fx.setViewportHeight(window.innerHeight);

    this.spawnDummies();
    this.setupPost();
    this.bindUi();
    window.addEventListener('resize', () => this.resize());
  }

  async init() {
    const model = await CharacterModel.load(MODEL_URL, Tuning.player.height);
    const spawn = new Vector3(0, 0, 6);
    spawn.y = this.world.groundAt(spawn.x, spawn.z);
    this.player = new Player(model, {
      world: this.world,
      fx: this.fx,
      cam: this.cam,
      input: this.input,
      hitstop: (d) => this.hitstop(d),
      slowmo: (scale, d) => this.slowmo(scale, d),
    }, spawn);
    this.fx.initAfterimages(model.model);
    for (const f of features) {
      f.install(this);
      this.features.push(f);
    }
    this.cam.snapTo(this.player.position);
    this.cam.update(this.player.position, 0);

    // Expose for debugging in the console.
    (window as unknown as { game: Game }).game = this;
    if (import.meta.env.DEV) installDebug(this);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  hitstop(duration: number) {
    this.hitstopTimer = Math.max(this.hitstopTimer, duration);
  }

  /** Slow gameplay time to `scale` for `duration` real seconds (parry, perfect dodge). */
  slowmo(scale: number, duration: number) {
    this.slowmoScale = Math.min(this.slowmoScale, scale);
    this.slowmoTimer = Math.max(this.slowmoTimer, duration);
  }

  /** Pause / resume. `menu` pauses without the click-to-play overlay and releases the mouse. */
  setPaused(reason: 'overlay' | 'menu' | null) {
    const was = this.pauseReason;
    this.pauseReason = reason;
    this.hud.setOverlay(reason === 'overlay', true);
    if (reason === 'menu' && document.pointerLockElement) document.exitPointerLock();
    if (reason === null && this.input.lastDevice === 'kbm' && this.pauseOnUnlock) {
      this.input.requestPointerLock();
      // Browsers can refuse a re-lock that wasn't triggered by a click (e.g. closing a menu with Tab).
      setTimeout(() => {
        if (!this.paused && !document.pointerLockElement) this.hud.flash('click to capture the mouse', 2);
      }, 300);
    }
    if (was !== reason) events.emit('ui:pause', { paused: reason !== null });
  }

  private spawnDummies() {
    const spots: [number, number][] = [[0, -5], [-4, -7], [4, -7], [-2.5, -11], [2.5, -11], [8, 2], [-8, 1]];
    for (const [x, z] of spots) {
      const d = new Dummy(x, this.world.terrain.heightAt(x, z), z, {
        onHit: (dm, info) => {
          const p = dm.position.clone();
          p.y += 0.2;
          // Echo hits draw their own cyan sparks (abilities/EchoInstance.ts).
          if (info.source !== 'echo') this.fx.hitSpark(p.clone().addScaledVector(info.dir, -0.3), info.dir.clone().negate().setY(0.3), info.heavy);
          this.hud.damageNumber(p.setY(p.y + 1.1), info.damage, info.heavy);
        },
      });
      this.scene.add(d.root);
      this.dummies.push(d);
      this.world.targets.push(d);
      this.world.colliders.push({ x, z, r: 0.45, bottom: d.root.position.y - 1, top: Infinity });
    }
  }

  private setupPost() {
    const size = this.renderer.getSize(new Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.cam.camera));
    this.composer.addPass(new UnrealBloomPass(new Vector2(size.x, size.y), 0.55, 0.5, 0.88));
    this.composer.addPass(new OutputPass());
  }

  private bindUi() {
    const start = () => this.setPaused(null);
    this.hud.onOverlayClick(start);
    this.renderer.domElement.addEventListener('click', () => {
      if (!this.paused) this.input.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.pauseOnUnlock && !document.pointerLockElement && !this.paused && this.input.lastDevice === 'kbm') {
        this.setPaused('overlay');
      }
    });
    this.hud.setDevice(this.input.lastDevice);
    this.input.onDevice((d) => {
      this.hud.setDevice(d);
      if (d === 'pad' && this.pauseReason === 'overlay') this.setPaused(null);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH') this.hud.toggleHelp();
      if (e.code === 'F3') {
        e.preventDefault();
        this.hud.showFps = !this.hud.showFps;
      }
    });
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
    this.fx.setViewportHeight(h);
  }

  /**
   * Debug / test hook: advance the simulation deterministically at 60 Hz,
   * independent of requestAnimationFrame (works in background tabs).
   */
  step(seconds: number) {
    this.clock.getDelta();
    const n = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < n; i++) this.frame(1 / 60, i === n - 1);
    this.clock.getDelta();
  }

  /** Freeze the real-time loop (debugging); `step()` still works. */
  setFrozen(v: boolean) {
    this.frozen = v;
  }

  /** gameplay dt of the current frame (after hitstop / slow-mo) */
  gameDt = 0;

  private frame(fixedDt?: number, render = true) {
    if (this.frozen && fixedDt === undefined) {
      this.clock.getDelta();
      return;
    }
    const rawDt = fixedDt ?? Math.min(this.clock.getDelta(), 1 / 30);
    this.time += rawDt;
    this.input.update(this.time, rawDt);

    if (this.paused) {
      if (this.pauseReason === 'overlay' && this.input.lastDevice === 'pad' &&
        (this.input.pressed('pause') || this.input.pressed('jump') || this.input.pressed('attack'))) {
        this.setPaused(null);
      }
      for (const f of this.features) f.pausedUpdate?.(rawDt, this);
      if (render) this.composer.render();
      return;
    }
    if (this.input.lastDevice === 'pad' && this.input.pressed('pause')) this.setPaused('overlay');

    // Hitstop nearly freezes gameplay; slow-mo scales it. Camera + particles keep real time.
    let dt = rawDt;
    if (this.slowmoTimer > 0) {
      this.slowmoTimer -= rawDt;
      dt *= this.slowmoScale;
      if (this.slowmoTimer <= 0) this.slowmoScale = 1;
    }
    if (this.hitstopTimer > 0) {
      this.hitstopTimer -= rawDt;
      dt = rawDt * 0.04;
    }
    this.gameDt = dt;

    this.cam.addLook(this.input.look.x, this.input.look.y);
    if (this.input.pressed('recenter')) this.cam.recenter(this.player.facing);

    this.player.update(dt);
    for (const f of this.features) f.update?.(dt, this);
    for (const d of this.dummies) d.update(dt);
    this.fx.update(rawDt);

    this.cam.update(this.player.position, rawDt);
    for (const f of this.features) f.lateUpdate?.(rawDt, this);
    this.sky.update(this.player.position, this.cam.camera.position);

    this.hud.update(rawDt, {
      combo: this.player.comboShown,
      dashCharges: this.player.airDashCharges,
      airborne: this.player.airborne,
      echoState: this.echo.state,
      echoProgress: this.echo.progress,
      echoTimer: this.echo.timer,
    });
    this.hud.updateNumbers(rawDt, this.cam.camera, window.innerWidth, window.innerHeight);

    if (render) this.composer.render();
  }
}
