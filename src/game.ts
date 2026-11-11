import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Input } from './core/input';
import { AudioSys, bindSynth } from './core/audio';
import { Voices } from './core/voice';
import { Fx, type Orb, type Stream } from './core/fx';
import { SEAL, Seal } from './core/seal';
import { clamp, damp, distPointSegment, ease, yawForward, yawLeft, yawOf, setSeed, type Script } from './core/math';
import { ARENA_RADIUS, Arena } from './world/arena';
import { Props } from './world/props';
import { CameraRig } from './world/camera';
import { BOSS_NAME, BOSS_TITLE, BOSS_WAKE, Colossus } from './boss/colossus';
import { Party, START_Z } from './chars/party';
import type { Knight } from './chars/knight';
import { PARTY, type MoveDef } from './chars/defs';
import { createVisual, loadManifest, type CharVisual } from './chars/visual';
import { Hud } from './ui/hud';
import { Story, type PlayOpts, type Spoken } from './story/story';
import type { BossEvent, Hazard, HitKind, Threat, World } from './types';

/** `arrive`: the walk in, the colossus still asleep. `intro`: it wakes. */
type Mode = 'loading' | 'title' | 'arrive' | 'intro' | 'fight' | 'allout' | 'victory' | 'defeat';

/** Damage each Knight adds to the All-Out Attack, before the staggered core's multiplier. */
export const ALLOUT_BASE = 90;
const ALLOUT_ORDER = ['symbeline', 'ghalus', 'deux', 'sigmund'];
/** The finisher's staging: the seal's radius and how long it takes to write, where the power gathers, the column. */
export const ALLOUT_LOOK = { radius: 18, draw: 1.4, height: 30, skyRadius: 9, beamRadius: 3.6, beam: 1.1, glow: 1.5 };

/**
 * The way in: where the Knights enter (z), how far they stroll during the scene and how fast,
 * how fast they may go once the player has them (a share of their running speed), and how
 * close to the colossus they get before it stirs.
 */
export const ARRIVAL = { gate: 34.5, stroll: 5, pace: 1.6, walk: 0.64, wake: 19, close: 11, patience: 5 };
/** Story scenes by how much of the colossus's health is left. `now`: it will not wait its turn. */
const BEATS: { at: number; scene: string; now?: boolean }[] = [
  { at: 0.86, scene: 'lore' },
  { at: 0.7, scene: 'twelve' },
  { at: 0.4, scene: 'friends' },
  { at: 0.22, scene: 'rally', now: true },
  { at: 0.08, scene: 'final' },
];

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Game implements World {
  time = 0;
  scene = new THREE.Scene();
  fx: Fx;
  audio = new AudioSys();
  voice = new Voices(this.audio);
  props = new Props();
  arena: Arena;
  hazards: Hazard[] = [];
  threats: Threat[] = [];
  player: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean };

  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  rig: CameraRig;
  input: Input;
  hud: Hud;
  story: Story;
  party!: Party;
  boss!: Colossus;
  mode: Mode = 'loading';
  paused = false;
  alloutReady = false;
  /** Debug options. */
  god = false;
  /** Pause when the mouse is released. Automated runs switch this off. */
  autoPause = true;
  speed = 1;
  /** True while the simulation is being fast-forwarded without rendering. */
  fast = false;
  usingGeneratedModels: string[] = [];
  onStep: ((dt: number) => void) | null = null;

  private hitstopT = 0;
  private slowT = 0;
  private slowScale = 1;
  private cine: Script | null = null;
  private playerLight = new THREE.PointLight(0xfff0e0, 9, 11, 1.6);
  private last = 0;
  private titleAngle = 0.5;
  private endTimer = 0;
  private fightTime = 0;
  private stats = { staggers: 0, allouts: 0 };
  /** Lets a scene follow the dialogue: called as each story line comes up. */
  private onLine: ((line: Spoken) => void) | null = null;
  /** Set by the confirm button while a scene has the camera. */
  private skipScene = false;
  /** What the camera must not end up behind, gathered each frame. */
  private sight: { pos: THREE.Vector3; r: number }[] = [];

  constructor(private canvas: HTMLCanvasElement, hudRoot: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.fx = new Fx(this.scene);
    this.arena = new Arena(this.scene);
    this.arena.sky.bake(this.renderer);
    this.scene.add(this.playerLight);
    bindSynth(this.audio);

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.62, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.input = new Input(canvas);
    this.input.wantLock = () => this.mode !== 'loading' && this.autoPause;
    this.hud = new Hud(hudRoot);
    this.story = new Story({
      alive: (id) => this.party.members.some((m) => m.def.id === id && m.alive),
      lead: () => this.party.cur.def.id,
      say: (line) => {
        const voiced = this.voice.story(line.who, line.voice);
        // Long enough to hear it out, and to read it when there is nothing to hear.
        const seconds = voiced ? Math.max(voiced + 0.6, 1.4 + line.en.length * 0.035) : 1.8 + line.en.length * 0.06;
        this.voice.holdFloor(line.who, seconds);
        this.hud.caption('', '', '', 0);
        this.hud.dialog(line, seconds);
        this.onLine?.(line);
        return seconds;
      },
      hide: () => {
        this.hud.dialog(null);
        this.voice.yieldFloor();
      },
    });
    this.voice.onStoryCut = () => this.story.cut();
    this.player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), alive: true };

    window.addEventListener('resize', () => this.resize());
    let hadLock = false;
    document.addEventListener('pointerlockchange', () => {
      // Losing the mouse mid-fight (Esc) pauses.
      const locked = document.pointerLockElement === canvas;
      if (!locked && hadLock && this.autoPause && (this.mode === 'fight' || this.mode === 'intro' || this.mode === 'arrive') && this.input.lastDevice === 'kbm' && !this.fast) {
        this.setPaused(true);
      }
      hadLock = locked;
    });
    this.resize();
  }

  async load() {
    const [manifest] = await Promise.all([loadManifest(), this.props.load()]);
    this.arena.dress(this.props);
    const visuals: CharVisual[] = await Promise.all(PARTY.map((d) => createVisual(d.id, d.height, manifest)));
    this.usingGeneratedModels = PARTY.filter((d) => manifest[d.id] && !('nodes' in visuals[PARTY.indexOf(d)])).map((d) => d.id);
    this.party = new Party(this, this.input, () => this.boss, {
      toast: (t, k) => this.hud.toast(t, k),
      hurt: (amount) => this.hud.hurtFlash(amount),
      defeat: () => this.onDefeat(),
      swapped: () => this.rig.glide(0.45),
      fallen: (k) => this.onFallen(k),
    }, visuals);
    this.boss = new Colossus(this);
    this.trackTarget();
    this.voice.onCaption = (who, take, seconds) => this.hud.caption(who, take.ja, take.en, seconds);
    void this.voice.load();
    this.hud.setLoading(false);
    this.hud.setBadge(this.usingGeneratedModels.length === PARTY.length ? '' : 'STAND-IN CHARACTER MODELS');
    this.toTitle();
    requestAnimationFrame((t) => this.frame(t));
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.rig.resize(w / h);
    this.fx.setView(this.renderer.domElement.height, this.rig.fov);
    this.arena.sky.setView(this.renderer.domElement.height);
    this.hud.layout();
  }

  // ---------------------------------------------------------------- World

  addHazard(h: Hazard) {
    this.hazards.push(h);
    return h;
  }

  retarget() {
    this.party.pickBossTarget();
    this.trackTarget();
  }

  /** Keep the boss's idea of its quarry on whichever Knight it is hunting. */
  private trackTarget() {
    const party = this.party;
    if (!party.bossTarget.alive && party.anyAlive) party.pickBossTarget();
    this.player.pos.copy(party.bossTarget.pos);
    this.player.vel.copy(party.bossTarget.vel);
  }

  private overlaps(h: Omit<Hazard, 'life'>, k: Knight): boolean {
    const p = k.pos;
    const pr = 0.42;
    const dx = p.x - h.center.x;
    const dz = p.z - h.center.z;
    switch (h.shape) {
      case 'circle':
        return Math.hypot(dx, dz) < h.radius + pr;
      case 'ring':
        return Math.abs(Math.hypot(dx, dz) - h.radius) < (h.width ?? 1) / 2 + pr;
      case 'sphere': {
        const top = k.def.height;
        _a.set(p.x, 0.3, p.z);
        _b.set(p.x, top, p.z);
        return distPointSegment(h.center, _a, _b) < h.radius + pr;
      }
      case 'capsule': {
        _a.set(p.x, Math.min(1.0, k.def.height * 0.6), p.z);
        return distPointSegment(_a, h.center, h.b!) < h.radius + pr;
      }
    }
  }

  strike(h: Omit<Hazard, 'life'>) {
    if (this.god || this.party.cinematic) return;
    for (const k of this.party.members) if (k.alive && this.overlaps(h, k)) k.takeHit(h);
  }

  hitstop(seconds: number) {
    this.hitstopT = Math.max(this.hitstopT, seconds);
  }

  slowmo(seconds: number, scale: number) {
    this.slowT = seconds;
    this.slowScale = scale;
  }

  damageNumber(pos: THREE.Vector3, amount: number, kind: HitKind) {
    if (this.fast) return;
    _v.copy(pos).project(this.rig.camera);
    if (_v.z > 1) return;
    this.hud.damageNumber((_v.x * 0.5 + 0.5) * window.innerWidth, (-_v.y * 0.5 + 0.5) * window.innerHeight, amount, kind);
  }

  onBossEvent(e: BossEvent) {
    switch (e) {
      case 'awake':
        if (this.mode === 'intro' || this.mode === 'arrive') {
          // However it came about (played out, or skipped), the fight is on.
          this.mode = 'fight';
          this.cine = null;
          this.onLine = null;
          this.party.cinematic = false;
          this.party.march = null;
          for (const m of this.party.members) m.pace = 1;
          // If the scene was skipped before the colossus had its say, it has it now.
          this.tell('wake', { now: true });
          this.rig.override = null;
          this.rig.yaw = yawOf(this.boss.pos.x - this.party.pos.x, this.boss.pos.z - this.party.pos.z);
          this.rig.pitch = 0.1;
          this.rig.glide(0.6);
          this.hud.cinema(false);
          this.hud.objective(null);
          this.hud.showFight(true);
          this.audio.playMusic('music_boss');
          this.party.cur.say('start', { priority: 1, delay: 2.2 });
        }
        break;
      case 'staggered':
        this.stats.staggers++;
        this.alloutReady = true;
        this.hud.toast('POSTURE BROKEN', 'good');
        this.hud.alloutPrompt(true);
        this.hitstop(0.18);
        this.voice.say('boss', 'stagger');
        this.party.cur.say('stagger', { priority: 1, delay: 0.6, cooldown: 0 });
        break;
      case 'recovered':
        this.alloutReady = false;
        this.hud.alloutPrompt(false);
        break;
      case 'phase2':
        this.hud.showBanner('Eclipse', 'the thirteenth sign remembers its name', true);
        this.hud.flash(0.5, 900);
        this.voice.say('boss', 'phase2', { priority: 2, delay: 0.8 });
        if (!this.tell('eclipse', { delay: 7 })) {
          const standing = this.party.members.filter((m) => m.alive);
          standing[Math.floor(Math.random() * standing.length)]?.say('phase2', { priority: 1, delay: 6.5, cooldown: 0 });
        }
        break;
      case 'dying': {
        this.alloutReady = false;
        this.hud.alloutPrompt(false);
        this.hazards.length = 0;
        this.party.lock = null;
        if (this.mode === 'defeat') break;
        this.mode = 'victory';
        this.audio.stopMusic(2);
        this.story.abort();
        this.voice.hush();
        this.voice.say('boss', 'death', { priority: 2, delay: 0.5 });
        // Kill-cam: watch it come apart from beside the Knight.
        const away = _a.copy(this.party.pos).sub(this.boss.pos).setY(0).normalize();
        this.rig.override = {
          pos: this.party.pos.clone().addScaledVector(away, 7).add(new THREE.Vector3(2.5, 3.2, 0)),
          look: this.boss.corePos.clone().setY(9),
          fov: 52,
        };
        break;
      }
      case 'dead':
        if (this.mode !== 'victory') break;
        this.rig.override = null;
        this.hud.flash(0.9, 1400);
        this.audio.play('ui_victory', { volume: 0.9 });
        if (!this.tell('victory', { delay: 1.6, now: true })) this.party.cur.say('victory', { priority: 2, delay: 1.8 });
        this.hud.showEnd('victory', this.summary());
        this.endTimer = 1.5;
        break;
    }
  }

  private summary() {
    const s = this.party.stats;
    const t = Math.round(this.fightTime);
    const fallen = this.party.members.filter((m) => !m.alive).length;
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} · ${Math.round(s.damage)} damage · ${s.perfects} perfect dodges · ${this.stats.allouts} all-out attacks · ${fallen} fallen`;
  }

  // ---------------------------------------------------------------- flow

  private toTitle() {
    this.mode = 'title';
    this.hud.showTitle(true);
    this.hud.showFight(false);
  }

  /**
   * Begin (or restart) the encounter. With `story` the Knights arrive first, find the colossus
   * asleep and walk up to it; without (a retry) they are already close and it wakes at once.
   */
  start(story = false) {
    void this.audio.unlock();
    this.input.requestPointerLock();
    this.input.clear();
    this.hud.showTitle(false);
    this.hud.showEnd(null);
    this.voice.hush();
    this.story.reset();
    this.story.hold = false;
    this.onLine = null;
    this.skipScene = false;
    this.hud.caption('', '', '', 0);
    this.hud.endAllOut();
    this.hud.alloutPrompt(false);
    this.hud.showFight(false);
    this.hud.objective(null);
    this.hazards.length = 0;
    this.threats.length = 0;
    this.fx.clear();
    this.alloutReady = false;
    this.hitstopT = this.slowT = 0;
    this.fightTime = 0;
    this.stats = { staggers: 0, allouts: 0 };
    this.arena.reset();
    this.arena.setEclipse(0);
    this.boss.dispose();
    setSeed((Date.now() & 0xffff) | 1);
    this.boss = new Colossus(this);
    this.party.reset(story ? ARRIVAL.gate : START_Z);
    this.player.alive = true;
    this.audio.stopMusic(1);
    this.rig.yaw = Math.PI;
    this.rig.pitch = 0.1;
    this.cine = story ? this.arrival() : this.awakening();
    // Run the scene's first step now, so the very first frame is already framed by it.
    this.cine.next(0);
    this.setPaused(false);
  }

  /** Ask for a story scene. Fast-forwarded runs have nobody to tell it to. */
  private tell(scene: string, opts: PlayOpts = {}): boolean {
    if (this.fast) return false;
    return this.story.play(scene, opts);
  }

  private onFallen(k: Knight): boolean {
    if (this.mode !== 'fight' && this.mode !== 'allout') return false;
    const standing = this.party.members.filter((m) => m.alive).length;
    // The last one standing speaks for themselves; otherwise whoever was closest to them answers.
    if (standing === 1) return this.tell('alone', { delay: 2.4, when: () => this.mode === 'fight' });
    if (standing === 0) return false;
    return this.tell(`fallen-${k.def.id}`, { delay: 1.7, when: () => this.mode === 'fight' });
  }

  /** The story follows the colossus's health down. */
  private storyBeats() {
    if (this.mode !== 'fight' || this.fast) return;
    const boss = this.boss;
    if (boss.state !== 'fight' && boss.state !== 'staggered') return;
    const hp = boss.hp / boss.maxHp;
    for (const b of BEATS) {
      if (hp > b.at || !this.tell(b.scene, { now: b.now, delay: b.now ? 0 : 0.4, when: () => this.mode === 'fight' })) continue;
      if (b.scene === 'rally') this.rally();
    }
  }

  /** The moment the Knights remember who they are fighting for: every one of them flares up. */
  private rally() {
    this.hud.toast('FOR OUR FRIENDS', 'good');
    this.audio.play('holy_burst', { volume: 0.7, rate: 1.2 });
    for (const m of this.party.members) {
      if (!m.alive) continue;
      m.stamina = m.def.stamina;
      this.fx.ring(m.pos, { r0: 0.4, r1: 5, life: 0.7, color: m.def.color, intensity: 3 });
      _a.copy(m.pos).setY(0.4);
      this.fx.burst(_a, 40, { color: m.def.color, color2: 0xffffff, intensity: 3, dir: UP, spread: 0.4, radius: 0.8, speed: [3, 13], size: [0.12, 0.34], life: [0.5, 1.2], gravity: 3 });
      m.visual.tint(m.def.color, 0.5);
    }
  }

  // ---------------------------------------------------------------- arrival and awakening

  /**
   * The way in. First a scene: the sky, the sleeping colossus, the Knights walking in under
   * it and wondering what they have found (each line of theirs gets its own shot). Then the
   * player has them, and walks them up to it. Come close enough and it wakes.
   */
  private *arrival(): Script {
    const { party, boss, hud, rig, story } = this;
    this.mode = 'arrive';
    party.cinematic = true;
    party.march = { x: 0, z: -1, pace: ARRIVAL.pace };
    hud.cinema(true);
    this.audio.play('sky_charge', { volume: 0.35, rate: 0.45 });

    // Shots, each a slow move from one framing to another over its line.
    type Shot = { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; fov: number; seconds: number };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const lead = party.cur;
    const knight = (id: string) => party.members.find((m) => m.def.id === id)!;
    const halt = ARRIVAL.gate - ARRIVAL.stroll;
    const eye = V(4.6, 1.2, ARRIVAL.gate + 4.6);
    /** A Knight's face from a little in front and to one side, easing closer. */
    const closeOn = (m: Knight, side: number, fov: number, seconds: number): Shot => {
      const to = _a.copy(boss.pos).sub(m.pos).setY(0).normalize().clone();
      const right = V(-to.z, 0, to.x);
      // Aimed at the chest, so the face sits in the upper half, clear of the dialog box.
      const aim = m.pos.clone().setY(m.def.height * 0.62);
      const at = (d: number) => m.pos.clone().addScaledVector(to, d).addScaledVector(right, side * d * 0.42).setY(m.def.height * 0.66);
      return { from: [at(3.6), aim], to: [at(3), aim], fov, seconds };
    };
    const shots: Record<string, () => Shot> = {
      // Out of the galaxy and down onto what sleeps under it, the Knights walking in below.
      open: () => ({ from: [eye, eye.clone().add(V(22, 46, -60))], to: [eye.clone().add(V(-0.8, 0.5, -1.2)), V(0, 8, 0)], fov: 56, seconds: 7 }),
      // The thirteenth plinth, broken, and the colossus beyond it.
      'story-arrive-1': () => ({ from: [V(-14.5, 4.8, -52), V(-8.5, 1.2, -34)], to: [V(-12.2, 5.3, -51), V(-8, 1.6, -30)], fov: 44, seconds: 8.5 }),
      // From up by its shoulder: how small they are.
      'story-arrive-2': () => ({ from: [V(10.5, 13.5, 6), V(0, 1, halt + 1)], to: [V(8.5, 12.5, 8), V(0, 1, halt + 1)], fov: 46, seconds: 7 }),
      // Symbeline, sure of her friends; and Sigmund, who has seen it breathe.
      'story-arrive-3': () => closeOn(knight('symbeline'), 1, 38, 7),
      'story-arrive-4': () => closeOn(knight('sigmund'), -1, 36, 4),
    };
    let shot = shots.open();
    let shotT = 0;
    const frame = (dt: number, cut = false) => {
      shotT += dt;
      const k = ease.inOut(Math.min(1, shotT / shot.seconds));
      rig.override = { pos: shot.from[0].clone().lerp(shot.to[0], k), look: shot.from[1].clone().lerp(shot.to[1], k), fov: shot.fov };
      if (cut) rig.snapNext();
    };
    this.onLine = (line) => {
      const next = shots[line.voice];
      if (!next) return;
      shot = next();
      shotT = 0;
      frame(0, true);
    };
    frame(0, true);
    // Nobody speaks until they have walked in and stopped.
    const opens = ARRIVAL.stroll / ARRIVAL.pace + 0.4;
    this.tell('arrive', { delay: opens });

    let t = 0;
    while (!this.skipScene && (t < opens + 0.5 || story.busy)) {
      const dt: number = yield;
      t += dt;
      frame(dt);
      // They come to a stop a little way in, and look.
      if (party.march && lead.pos.z <= halt) {
        party.march = null;
        for (const m of party.members) m.stand();
      }
      if (!party.march) for (const m of party.members) m.face(boss.pos, dt);
    }
    this.onLine = null;
    if (this.skipScene) story.cut();
    this.skipScene = false;

    // Hand over: the camera drops in behind whoever leads, and the rest is the player's walk.
    party.march = null;
    party.cinematic = false;
    hud.cinema(false);
    rig.override = null;
    rig.yaw = yawOf(boss.pos.x - party.pos.x, boss.pos.z - party.pos.z);
    rig.pitch = 0.12;
    rig.snapNext();
    hud.objective('APPROACH THE COLOSSUS');
    // Nobody runs up to a thing like that.
    for (const m of party.members) m.pace = ARRIVAL.walk;
    this.tell('approach', { delay: 0.4, when: () => this.mode === 'arrive' });

    // It stirs once they are close: at once if they come right up to it, otherwise when
    // they have finished what they were saying (it does not wait long).
    let waited = 0;
    for (;;) {
      const dt: number = yield;
      const d = Math.hypot(party.pos.x - boss.pos.x, party.pos.z - boss.pos.z);
      if (d > ARRIVAL.wake) continue;
      waited += dt;
      if (!story.busy || d < ARRIVAL.close || waited > ARRIVAL.patience) break;
    }
    yield* this.awakening();
  }

  /**
   * The colossus wakes: the star in its chest catches, seen from close; then it stands, seen
   * from behind the Knights. It hands the fight over itself (the 'awake' boss event).
   */
  private *awakening(): Script {
    const { party, boss, hud, rig } = this;
    this.mode = 'intro';
    party.cinematic = true;
    party.march = null;
    party.lock = null;
    this.input.clear();
    this.skipScene = false;
    hud.objective(null);
    hud.cinema(true);
    for (const m of party.members) {
      m.pace = 1;
      m.stand();
    }
    boss.awaken();
    // It speaks as it stands. Whatever they were saying on the way in, they get to finish
    // while its light catches (it will not wait for them much longer than that).
    let told = false;
    const speak = (since: number) => {
      const due = BOSS_WAKE.ignite + 0.5;
      if (told || since < due || (this.story.busy && since < due + 1.2)) return;
      told = true;
      this.tell('wake', { now: true });
    };

    // 1. Its heart, dark, from just below: a spark, another, and it holds.
    const toParty = party.pos.clone().sub(boss.pos).setY(0).normalize();
    const side = new THREE.Vector3(toParty.z, 0, -toParty.x);
    const core = boss.corePos.clone();
    let t = 0;
    for (let first = true; t < BOSS_WAKE.ignite; first = false) {
      const k = ease.out(Math.min(1, t / BOSS_WAKE.ignite));
      rig.override = {
        pos: core.clone().addScaledVector(toParty, 11.5 - 2.5 * k).addScaledVector(side, 3.2).setY(1.6 + 0.5 * k),
        look: core.clone().addScaledVector(UP, 0.6),
        fov: 42,
      };
      if (first) rig.snapNext();
      const dt: number = yield;
      t += dt;
      speak(t);
      for (const m of party.members) m.face(boss.pos, dt);
    }

    // 2. It stands, and they see how big it is.
    hud.showBanner(BOSS_NAME, BOSS_TITLE);
    hud.flash(0.5, 500);
    this.audio.playMusic('music_boss');
    const behind = party.pos.clone().addScaledVector(toParty, 8).addScaledVector(side, -3).setY(1.7);
    const far = Math.hypot(behind.x, behind.z);
    if (far > ARENA_RADIUS - 2) behind.multiply(_b.set((ARENA_RADIUS - 2) / far, 1, (ARENA_RADIUS - 2) / far));
    let rise = 0;
    for (let first = true; ; first = false) {
      // The Knights small at the bottom of the frame, then up, and up, as it gets to its feet.
      rig.override = { pos: behind, look: new THREE.Vector3(boss.pos.x, Math.min(12.5, 3.5 + rise * 3.6), boss.pos.z), fov: 50 };
      if (first) rig.snapNext();
      const dt: number = yield;
      rise += dt;
      speak(t + rise);
      for (const m of party.members) m.face(boss.pos, dt);
    }
  }

  private onDefeat() {
    if (this.mode === 'victory') return;
    this.mode = 'defeat';
    this.player.alive = false;
    this.alloutReady = false;
    this.hud.alloutPrompt(false);
    this.audio.stopMusic(2);
    this.story.abort();
    this.audio.play('ui_defeat', { volume: 0.9 });
    this.voice.say('boss', 'taunt', { priority: 2, delay: 2.6, cooldown: 0 });
    this.hud.showEnd('defeat', this.summary());
    this.endTimer = 2.2;
  }

  setPaused(p: boolean) {
    if (this.mode === 'title' || this.mode === 'loading') p = false;
    this.paused = p;
    this.hud.showPause(p);
    if (!p && (this.mode === 'fight' || this.mode === 'intro' || this.mode === 'arrive')) this.input.requestPointerLock();
  }

  // ---------------------------------------------------------------- All-Out Attack

  tryAllOut(): boolean {
    if (this.mode !== 'fight' || !this.alloutReady || this.boss.state !== 'staggered' || !this.party.cur.alive) return false;
    this.cine = this.allOut();
    return true;
  }

  /**
   * The Knights' finisher on a staggered colossus. The seal of Zodiark writes itself on the
   * floor around it; each Knight in turn, standing on a point of its star, gives their power
   * to the sky; and what they gathered comes back down as one column of light.
   */
  private *allOut(): Script {
    const { boss, party, hud, fx, audio, rig } = this;
    this.mode = 'allout';
    this.alloutReady = false;
    this.stats.allouts++;
    hud.alloutPrompt(false);
    party.cinematic = true;
    party.lock = null;
    boss.staggerHold = true;
    this.hazards.length = 0;
    this.input.clear();
    // Nobody chats through the finisher.
    if (this.story.busy) this.story.cut();
    this.story.hold = true;

    const order = ALLOUT_ORDER.map((id) => party.members.find((m) => m.def.id === id)!).filter((m) => m.alive);
    const core = boss.corePos;
    const f = yawForward(boss.yaw, new THREE.Vector3());
    const l = yawLeft(boss.yaw, new THREE.Vector3());
    const ground = new THREE.Vector3(core.x, 0, core.z);
    const at = (fwd: number, left: number, y: number, from: THREE.Vector3) => from.clone().addScaledVector(f, fwd).addScaledVector(l, left).setY(y);

    // The seal lies under the core, kept whole on the floor when the colossus fell near its edge.
    const room = ARENA_RADIUS + 5 - ground.length();
    const R = clamp(room, 12, ALLOUT_LOOK.radius);
    const centre = ground.clone();
    if (room < R) centre.setLength(ARENA_RADIUS + 5 - R);
    const seal = new Seal(R);
    seal.level = ALLOUT_LOOK.glow;
    seal.obj.position.set(centre.x, 0.07, centre.z);
    // The top of its page lies behind the colossus, so from in front its Z stands upright.
    seal.obj.rotation.y = boss.yaw;
    seal.spinRate[0] = 0.08;
    fx.add({ obj: seal.obj, update: (dt) => seal.update(dt), dispose: () => seal.dispose() });

    // Everyone still standing takes a point of the star: before the colossus, at its sides, behind it.
    // Whoever is being played stands before it.
    const free = [[6], [4, 8], [6, 2, 10], [6, 3, 9, 0]][order.length - 1];
    const lead = order.includes(party.cur) ? party.cur : order[0];
    const tipOf = new Map<Knight, number>([[lead, free.shift()!]]);
    for (const m of order) if (m !== lead) tipOf.set(m, free.shift()!);
    const posts = new Map<Knight, THREE.Vector3>();
    order.forEach((m) => {
      const p = seal.tipPos(tipOf.get(m)!, new THREE.Vector3()).setY(0);
      posts.set(m, p);
      m.place(p.x, p.z, yawOf(ground.x - p.x, ground.z - p.z));
      m.visual.play('swapIn', { duration: 0.4, fade: 0 });
    });

    // What happens every frame, whatever the script is waiting for.
    const pens: THREE.Vector3[] = [];
    const joined: { m: Knight; stream: Stream }[] = [];
    const sky = new THREE.Vector3(ground.x, ALLOUT_LOOK.height, ground.z);
    let orb: Orb | null = null;
    let orbSize = 0;
    const tick = (dt: number) => {
      const n = seal.pens(pens);
      for (let i = 0; i < n; i++) {
        fx.burst(pens[i], 1, { color: 0xffc070, color2: 0xffffff, intensity: 3.2, speed: [0.5, 5], size: [0.1, 0.3], life: [0.25, 0.7], gravity: -2 });
      }
      for (const j of joined) {
        // Power streams off whoever has given theirs.
        j.m.visual.castPoint(j.stream.from);
        _a.copy(j.m.pos).setY(0.1);
        fx.burst(_a, 2, { color: j.m.def.color, color2: 0xffffff, intensity: 2.6, dir: UP, spread: 0.25, radius: 1.3, speed: [2, 9], size: [0.1, 0.3], life: [0.4, 0.9], gravity: -4 });
      }
      if (orb) orb.size = damp(orb.size, orbSize, 7, dt);
    };
    const hold = function* (seconds: number, fn?: (k: number, dt: number) => void): Script {
      let t = 0;
      while (t < seconds) {
        const dt: number = yield;
        t += dt;
        tick(dt);
        fn?.(Math.min(1, t / seconds), dt);
      }
    };
    // Shots: a dying colossus takes the camera for itself, and then these leave it alone.
    const shot = (pos: THREE.Vector3, look: THREE.Vector3, fov: number, cut = true) => {
      if (this.mode !== 'allout') return;
      // Never from among the ruins of the rim.
      const far = Math.hypot(pos.x, pos.z);
      if (far > ARENA_RADIUS - 2) pos.multiply(_b.set((ARENA_RADIUS - 2) / far, 1, (ARENA_RADIUS - 2) / far));
      rig.override = { pos, look, fov };
      if (cut) rig.snapNext();
    };

    // 1. The seal writes itself, seen from above.
    hud.allOutSplash();
    hud.flash(0.7, 400);
    audio.play('allout', { volume: 1 });
    const crane = (k: number) => {
      const a = 0.5 - 0.35 * k;
      const d = R * (0.75 + 0.35 * k);
      return centre.clone().addScaledVector(f, Math.cos(a) * d).addScaledVector(l, Math.sin(a) * d).setY(R * (2.3 - 0.6 * k));
    };
    shot(crane(0), centre.clone().setY(1.5), 50);
    yield* hold(0.35);
    audio.play('seal_draw', { volume: 1 });
    yield* hold(ALLOUT_LOOK.draw, (k) => {
      seal.progress = k;
      shot(crane(ease.inOut(k)), centre.clone().setY(1.5), 50, false);
    });
    seal.progress = 1;
    seal.flare = 2.6;
    seal.wave(0, 1.15, 0.45, 2.5);
    fx.ring(centre, { r0: R * 0.35, r1: R * 1.5, life: 0.6, color: 0xffc070, intensity: 3 });
    fx.shake(0.3);
    hud.flash(0.3, 250);
    audio.play('holy_burst', { volume: 0.8 });
    yield* hold(0.22);

    // 2. One by one the Knights give their power to the sky.
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      const p = posts.get(m)!;
      const out = p.clone().sub(centre).setY(0).normalize();
      const sideways = new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(i % 2 === 0 ? 1 : -1);
      hud.cutIn(m.def, i % 2 === 1);
      m.say('allout', { priority: 2, volume: m.isLeader ? 1 : 1.6, overlap: true });
      // From inside the seal, low, looking up at them as their power leaves for the sky behind the camera.
      shot(
        p.clone().addScaledVector(out, -(2.4 + m.def.height * 0.8)).addScaledVector(sideways, 2.3 + m.def.height * 0.6).setY(0.3 + m.def.height * 0.22),
        p.clone().setY(m.def.height * 1.08),
        50,
      );
      const caster = m.def.heavy.anim === 'channel';
      if (caster) m.visual.act('channel', 0.26, 0.2, 14);
      else m.visual.play('cheer', { duration: 0.6, fade: 0.06 });
      audio.play(caster ? 'cast_charge' : 'swing_heavy', { volume: 0.6 });
      yield* hold(0.2);

      const stream = fx.stream(m.visual.castPoint(new THREE.Vector3()), sky, m.def.color, 0.11, 1.7);
      joined.push({ m, stream });
      orb ??= fx.orb(sky, 0xffd9a0);
      orbSize = 0.7 + 0.45 * joined.length;
      seal.lightSign(tipOf.get(m)!, m.def.color, 3.5);
      seal.wave(SEAL.star, 0, 0.45, 1.8);
      seal.flare = Math.max(seal.flare, 0.8);
      seal.spinRate[0] += 0.12;
      fx.ring(p, { r0: 0.3, r1: 3.4, life: 0.45, color: m.def.color, intensity: 3 });
      fx.burst(p.clone().setY(1), 50, { color: m.def.color, color2: 0xffffff, intensity: 3, dir: UP, spread: 0.5, speed: [4, 16], size: [0.14, 0.4], life: [0.4, 1.0], gravity: 4 });
      m.visual.tint(m.def.color, 0.55);
      audio.play('cast_holy', { volume: 0.9, rate: 0.75 + i * 0.16 });
      hud.flash(0.22, 180);
      yield* hold(0.3);
    }

    // 3. It gathers above the colossus, under a second seal that flashes into being.
    const skySeal = new Seal(ALLOUT_LOOK.skyRadius);
    skySeal.obj.position.set(sky.x, sky.y + 4, sky.z);
    skySeal.obj.rotation.y = boss.yaw;
    // Seen from underneath it would be mirror writing: turn the page over.
    skySeal.obj.scale.z *= -1;
    skySeal.shade = 0;
    skySeal.level = 2.2;
    skySeal.spinRate = [1.1, -0.8, 0];
    fx.add({ obj: skySeal.obj, update: (dt) => skySeal.update(dt), dispose: () => skySeal.dispose() });
    const low = (k: number) => at(30 + 6 * k, 12 + 3 * k, 1.8 + 1.4 * k, ground);
    const lookUp = new THREE.Vector3(ground.x, ALLOUT_LOOK.height * 0.52, ground.z);
    shot(low(0), lookUp, 60);
    audio.play('sky_charge', { volume: 1 });
    yield* hold(0.8, (k, dt) => {
      skySeal.progress = Math.min(1, k / 0.4);
      orbSize = 0.7 + 0.45 * joined.length + 2.6 * ease.in(k);
      seal.level = 1.5 + 1.6 * k;
      seal.spinRate[0] += dt * 1.4;
      fx.shake(0.04);
      // Motes are drawn up out of the seal toward what is gathering.
      _a.copy(centre).setY(0.2);
      fx.burst(_a, 3, { color: 0xffc070, color2: 0xffffff, intensity: 2.6, dir: UP, spread: 0.12, radius: R * 0.8, speed: [10, 26], size: [0.12, 0.3], life: [0.5, 1.0], gravity: -6 });
      shot(low(0.25 * k), lookUp, 60, false);
    });
    skySeal.flare = 3;

    // 4. And it comes down.
    for (const j of joined) j.stream.stop(0.14);
    joined.length = 0;
    orb?.stop(0.12);
    orb = null;
    const tints = order.map((m) => m.def.color);
    const beam = { fall: 0.16, hold: ALLOUT_LOOK.beam, fade: 0.45 };
    fx.skyBeam(ground, ALLOUT_LOOK.beamRadius, 160, 0xffdf9a, { ...beam, tints });
    audio.play('sky_beam', { volume: 1 });
    yield* hold(beam.fall);

    hud.flash(0.75, 450);
    fx.shake(1);
    fx.flash(core, 0xffffff, 30, 0.45, 2.2);
    fx.blast(ground.clone().setY(2), 9, 0xffc878, 0.7, 1.2);
    fx.shockwave(ground, 2, R * 2.1, 0.85, 0xffc060, 2.6);
    fx.ring(ground, { r0: 2, r1: R * 1.7, life: 0.7, color: 0xfff0c8, intensity: 3.5 });
    fx.burst(ground.clone().setY(0.6), 320, { color: 0xffc060, color2: 0xffffff, intensity: 3.6, dir: UP, spread: 0.85, speed: [8, 44], size: [0.2, 0.7], life: [0.5, 1.6], gravity: 9 });
    audio.play('explode', { volume: 1 });
    audio.play('boss_slam', { volume: 1 });
    seal.flare = 4;
    seal.level = 3;
    seal.wave(0, 1.2, 0.5, 4);
    skySeal.flare = 3;

    // Everyone's share lands inside the column, one after another.
    let burning = 0;
    const burn = (k: number, dt: number) => {
      burning += dt;
      fx.shake(0.07);
      _a.copy(ground).setY(0.3);
      fx.burst(_a, 5, { color: 0xffd080, color2: 0xffffff, intensity: 3.2, dir: UP, spread: 0.2, radius: ALLOUT_LOOK.beamRadius, speed: [10, 40], size: [0.15, 0.45], life: [0.4, 1.0], gravity: -8 });
      shot(low(0.25 + 0.75 * ease.out(Math.min(1, burning / beam.hold))), lookUp, 60, false);
      void k;
    };
    const each = Math.min(0.2, (beam.hold * 0.6) / order.length);
    for (let i = 0; i < order.length && boss.state === 'staggered'; i++) {
      const m = order[i];
      const move: MoveDef = { ...(m.def.id === 'symbeline' ? m.def.light[3] : m.def.heavy), damage: ALLOUT_BASE, stagger: 0, hitstop: 0.05, shake: 0.5 };
      party.hitPart(boss.part('core'), move, m, core.clone(), 1);
      fx.ring(ground, { r0: 1.5, r1: R * 1.2, life: 0.4, color: m.def.color, intensity: 3 });
      seal.wave(0, 1.2, 0.35, 3);
      yield* hold(each, burn);
    }
    yield* hold(Math.max(0, beam.hold - burning), burn);

    // 5. The light thins, the seals let go, and the fight is on again.
    seal.release(1.6);
    skySeal.release(0.7);
    yield* hold(beam.fade * 0.8);

    for (const m of order) m.place(m.pos.x, m.pos.z, m.yaw);
    hud.endAllOut();
    party.cinematic = false;
    boss.staggerHold = false;
    boss.staggerWindow = Math.min(boss.staggerWindow, 1.8);
    this.input.clear();
    this.story.hold = false;
    if (this.mode === 'allout') {
      rig.override = null;
      rig.yaw = party.yaw;
      rig.pitch = 0.05;
      rig.snapNext();
      this.mode = 'fight';
      this.tell('allout', { delay: 1.2, when: () => this.mode === 'fight' });
    }
  }

  // ---------------------------------------------------------------- loop

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const real = Math.min(0.05, (now - this.last) / 1000 || 0.016);
    this.last = now;
    if (this.fast) return;
    this.input.poll();
    this.input.time += real;
    this.hud.setDevice(this.input.lastDevice);
    this.handleGlobalInput();

    if (!this.paused) {
      let scale = this.speed;
      if (this.hitstopT > 0) {
        this.hitstopT -= real;
        scale *= 0.04;
      } else if (this.slowT > 0) {
        this.slowT -= real;
        scale *= this.slowScale;
      }
      this.step(real * scale);
      this.voice.update(real);
      this.story.update(real);
    }
    this.render(real);
  }

  private handleGlobalInput() {
    const input = this.input;
    const confirm = input.consume('confirm', 0.3);
    if (this.mode === 'title') {
      if (confirm) this.start(true);
      return;
    }
    if (this.mode === 'victory' || this.mode === 'defeat') {
      if (confirm && this.endTimer <= 0) this.start();
      return;
    }
    // Esc also releases the mouse, which pauses by itself; so on keyboard it only ever pauses.
    if (input.consume('pause')) this.setPaused(input.lastDevice === 'pad' ? !this.paused : true);
    else if (this.paused && confirm) this.setPaused(false);
    if (this.paused) return;
    if (confirm && !input.pointerLocked) input.requestPointerLock();
    // Scenes that hold the camera can be skipped; the walk in between is the player's own.
    if (this.mode === 'arrive' && confirm && this.party.cinematic) this.skipScene = true;
    if (this.mode === 'intro' && confirm) this.boss.skipIntro();
    if (this.mode === 'fight' && this.alloutReady && input.consume('allout')) this.tryAllOut();
  }

  /** Advance the simulation. Also driven directly by the test harness. */
  step(dt: number) {
    this.time += dt;
    this.onStep?.(dt);
    if (this.mode === 'title' || this.mode === 'loading') {
      this.fx.update(dt);
      this.arena.update(dt, this.boss.pos);
      return;
    }
    if (this.mode === 'fight') this.fightTime += dt;
    this.endTimer -= dt;

    if (this.cine) {
      const r = this.cine.next(dt);
      if (r.done) this.cine = null;
    }
    this.trackTarget();
    this.boss.update(dt);
    this.party.update(dt, this.rig.yaw);
    this.storyBeats();

    // Boss hazards against every Knight on the field
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      h.update?.(dt);
      if (h.life <= 0) {
        this.hazards.splice(i, 1);
        continue;
      }
      if (this.god || this.party.cinematic) continue;
      for (const k of this.party.members) {
        if (!k.alive || (h.seen?.get(k) ?? 0) > this.time || !this.overlaps(h, k)) continue;
        if (k.takeHit(h) !== 'ignored') (h.seen ??= new Map()).set(k, h.tick ? this.time + h.tick : Infinity);
      }
    }
    for (let i = this.threats.length - 1; i >= 0; i--) if (this.threats[i].at < this.time - 0.6) this.threats.splice(i, 1);

    this.fx.update(dt);
    _v.copy(this.party.pos).lerp(this.boss.pos, 0.5);
    this.arena.update(dt, _v);
  }

  /** Draw one frame immediately with the camera settled (screenshots in automated runs). */
  renderOnce() {
    this.rig.snapNext();
    this.render(0.016);
    this.rig.snapNext();
    this.render(0.016);
  }

  private render(real: number) {
    const { party, boss, rig } = this;
    this.fx.updateShake(real);
    if (this.mode === 'title') {
      this.titleAngle += real * 0.06;
      rig.override = {
        pos: new THREE.Vector3(Math.sin(this.titleAngle) * 33, 5.5, Math.cos(this.titleAngle) * 33),
        look: new THREE.Vector3(0, 6.5, 0),
        fov: 48,
      };
    }
    const lock = this.mode === 'fight' ? party.lock : null;
    const solid = this.sight;
    solid.length = 0;
    if (boss.state !== 'dead' && boss.state !== 'dying') for (const p of boss.parts) solid.push(p);
    for (const s of this.arena.solids) solid.push(s);
    rig.update(real, party.pos, party.cur.def.height, this.paused ? { x: 0, y: 0 } : this.input.look, lock ? lock.pos : null, this.fx, party.sprinting, solid);
    this.fx.setView(this.renderer.domElement.height, rig.camera.fov);

    // Rim light that keeps the Knight readable against the dark floor.
    yawForward(rig.yaw, _a);
    this.playerLight.position.copy(party.pos).addScaledVector(_a, -1.6).add(UP).setY(party.cur.def.height + 1.3);

    if (lock) {
      _v.copy(lock.pos).project(rig.camera);
      this.hud.setReticle((_v.x * 0.5 + 0.5) * window.innerWidth, (-_v.y * 0.5 + 0.5) * window.innerHeight, _v.z < 1, lock.label.toUpperCase(), lock.weak);
    } else this.hud.setReticle(0, 0, false);
    this.hud.update(real, party, boss);
    this.composer.render();
  }
}
