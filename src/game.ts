import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Input } from './core/input';
import { AudioSys, bindSynth } from './core/audio';
import { Fx } from './core/fx';
import { distPointSegment, wait, yawForward, yawLeft, yawOf, setSeed, type Script } from './core/math';
import { Arena } from './world/arena';
import { CameraRig } from './world/camera';
import { BOSS_NAME, BOSS_TITLE, Colossus } from './boss/colossus';
import { Party, type Member } from './chars/party';
import { PARTY, type MoveDef } from './chars/defs';
import { createVisual, loadManifest, type CharVisual } from './chars/visual';
import { Hud } from './ui/hud';
import type { BossEvent, Hazard, HitKind, Threat, World } from './types';

type Mode = 'loading' | 'title' | 'intro' | 'fight' | 'allout' | 'victory' | 'defeat';

/** Damage each Knight adds to the All-Out Attack, before the staggered core's multiplier. */
export const ALLOUT_BASE = 90;
const ALLOUT_ORDER = ['symbeline', 'ghalus', 'deux', 'sigmund'];

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Game implements World {
  time = 0;
  scene = new THREE.Scene();
  fx: Fx;
  audio = new AudioSys();
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
    this.player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), alive: true };

    window.addEventListener('resize', () => this.resize());
    let hadLock = false;
    document.addEventListener('pointerlockchange', () => {
      // Losing the mouse mid-fight (Esc) pauses.
      const locked = document.pointerLockElement === canvas;
      if (!locked && hadLock && this.autoPause && (this.mode === 'fight' || this.mode === 'intro') && this.input.lastDevice === 'kbm' && !this.fast) {
        this.setPaused(true);
      }
      hadLock = locked;
    });
    this.resize();
  }

  async load() {
    const manifest = await loadManifest();
    const visuals: CharVisual[] = await Promise.all(PARTY.map((d) => createVisual(d.id, d.height, manifest)));
    this.usingGeneratedModels = PARTY.filter((d) => manifest[d.id] && !('nodes' in visuals[PARTY.indexOf(d)])).map((d) => d.id);
    this.party = new Party(this, this.input, () => this.boss, {
      toast: (t, k) => this.hud.toast(t, k),
      hurt: (amount) => this.hud.hurtFlash(amount),
      defeat: () => this.onDefeat(),
      swapped: () => {},
    }, visuals);
    this.player.pos = this.party.pos;
    this.player.vel = this.party.vel;
    this.boss = new Colossus(this);
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
    this.hud.layout();
  }

  // ---------------------------------------------------------------- World

  addHazard(h: Hazard) {
    this.hazards.push(h);
    return h;
  }

  private overlaps(h: Omit<Hazard, 'life'>): boolean {
    const p = this.party.pos;
    const pr = 0.42;
    const dx = p.x - h.center.x;
    const dz = p.z - h.center.z;
    switch (h.shape) {
      case 'circle':
        return Math.hypot(dx, dz) < h.radius + pr;
      case 'ring':
        return Math.abs(Math.hypot(dx, dz) - h.radius) < (h.width ?? 1) / 2 + pr;
      case 'sphere': {
        const top = this.party.cur.def.height;
        _a.set(p.x, 0.3, p.z);
        _b.set(p.x, top, p.z);
        return distPointSegment(h.center, _a, _b) < h.radius + pr;
      }
      case 'capsule': {
        _a.set(p.x, Math.min(1.0, this.party.cur.def.height * 0.6), p.z);
        return distPointSegment(_a, h.center, h.b!) < h.radius + pr;
      }
    }
  }

  strike(h: Omit<Hazard, 'life'>) {
    if (this.god || !this.overlaps(h)) return;
    this.party.takeHit(h);
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
        if (this.mode === 'intro') {
          this.mode = 'fight';
          this.rig.override = null;
          this.hud.showFight(true);
        }
        break;
      case 'staggered':
        this.stats.staggers++;
        this.alloutReady = true;
        this.hud.toast('POSTURE BROKEN', 'good');
        this.hud.alloutPrompt(true);
        this.hitstop(0.18);
        break;
      case 'recovered':
        this.alloutReady = false;
        this.hud.alloutPrompt(false);
        break;
      case 'phase2':
        this.hud.showBanner('Eclipse', 'the thirteenth sign remembers its name', true);
        this.hud.flash(0.5, 900);
        break;
      case 'dying': {
        this.alloutReady = false;
        this.hud.alloutPrompt(false);
        this.hazards.length = 0;
        this.party.lock = null;
        if (this.mode === 'defeat') break;
        this.mode = 'victory';
        this.audio.stopMusic(2);
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

  /** Begin (or restart) the encounter. */
  start() {
    void this.audio.unlock();
    this.input.requestPointerLock();
    this.input.clear();
    this.hud.showTitle(false);
    this.hud.showEnd(null);
    this.hud.endAllOut();
    this.hud.alloutPrompt(false);
    this.hazards.length = 0;
    this.threats.length = 0;
    this.fx.clear();
    this.cine = null;
    this.alloutReady = false;
    this.hitstopT = this.slowT = 0;
    this.fightTime = 0;
    this.stats = { staggers: 0, allouts: 0 };
    this.arena.reset();
    this.arena.setEclipse(0);
    this.boss.dispose();
    setSeed((Date.now() & 0xffff) | 1);
    this.boss = new Colossus(this);
    this.party.reset();
    this.player.alive = true;
    this.mode = 'intro';
    this.rig.yaw = Math.PI;
    this.rig.pitch = 0.1;
    this.rig.override = { pos: new THREE.Vector3(5, 1.6, 36), look: new THREE.Vector3(0, 8, 0), fov: 50 };
    this.rig.snapNext();
    this.boss.awaken();
    this.hud.showBanner(BOSS_NAME, BOSS_TITLE);
    this.audio.playMusic('music_boss');
    this.setPaused(false);
  }

  private onDefeat() {
    if (this.mode === 'victory') return;
    this.mode = 'defeat';
    this.player.alive = false;
    this.alloutReady = false;
    this.hud.alloutPrompt(false);
    this.audio.stopMusic(2);
    this.audio.play('ui_defeat', { volume: 0.9 });
    this.hud.showEnd('defeat', this.summary());
    this.endTimer = 2.2;
  }

  setPaused(p: boolean) {
    if (this.mode === 'title' || this.mode === 'loading') p = false;
    this.paused = p;
    this.hud.showPause(p);
    if (!p && (this.mode === 'fight' || this.mode === 'intro')) this.input.requestPointerLock();
  }

  // ---------------------------------------------------------------- All-Out Attack

  tryAllOut(): boolean {
    if (this.mode !== 'fight' || !this.alloutReady || this.boss.state !== 'staggered' || this.party.state === 'dead') return false;
    this.cine = this.allOut();
    return true;
  }

  private *allOut(): Script {
    const { boss, party, hud, fx, audio } = this;
    this.mode = 'allout';
    this.alloutReady = false;
    this.stats.allouts++;
    hud.alloutPrompt(false);
    party.cinematic = true;
    party.lock = null;
    boss.staggerHold = true;
    this.hazards.length = 0;
    this.input.clear();

    const order = ALLOUT_ORDER.map((id) => party.members.find((m) => m.def.id === id)!).filter((m) => m.alive);
    const core = boss.corePos;
    const f = yawForward(boss.yaw, new THREE.Vector3());
    const l = yawLeft(boss.yaw, new THREE.Vector3());
    const ground = new THREE.Vector3(core.x, 0, core.z);
    const posts = new Map<Member, THREE.Vector3>();
    order.forEach((m, i) => {
      const spread = (i - (order.length - 1) / 2) * 3.4;
      posts.set(m, ground.clone().addScaledVector(f, 6.2 + Math.abs(spread) * 0.25).addScaledVector(l, spread));
    });
    const face = (p: THREE.Vector3) => yawOf(core.x - p.x, core.z - p.z);
    // Everyone takes the field.
    for (const m of order) {
      const p = posts.get(m)!;
      m.visual.root.visible = true;
      m.visual.setOpacity(1);
      m.visual.root.position.copy(p);
      m.visual.root.rotation.y = face(p);
      m.visual.play('swapIn', { duration: 0.4, fade: 0 });
    }
    const lead = party.cur.alive ? party.cur : order[0];
    party.pos.copy(posts.get(lead)!);
    party.vel.set(0, 0, 0);
    party.yaw = face(party.pos);

    hud.allOutSplash();
    hud.flash(0.7, 400);
    audio.play('allout', { volume: 1 });
    this.rig.override = { pos: ground.clone().addScaledVector(f, 19).addScaledVector(l, 8).setY(4.6), look: core.clone().setY(3.4), fov: 46 };
    this.rig.snapNext();
    yield* wait(1.15);

    for (let i = 0; i < order.length; i++) {
      if (boss.state !== 'staggered') break;
      const m = order[i];
      const p = posts.get(m)!;
      const sideSign = i % 2 === 0 ? 1 : -1;
      hud.cutIn(m.def, i % 2 === 1);
      this.rig.override = {
        pos: p.clone().addScaledVector(f, 4.6).addScaledVector(l, sideSign * 3.2).setY(1.6 + m.def.height * 0.35),
        look: p.clone().lerp(core, 0.55).setY(2.4),
        fov: 50,
      };
      const move: MoveDef = { ...(m.def.id === 'symbeline' ? m.def.light[3] : m.def.heavy), damage: ALLOUT_BASE, stagger: 0, hitstop: 0.1, shake: 0.55 };
      m.visual.act(move.anim, 0.34, 0.14, 0.5);
      audio.play(move.kind === 'melee' ? 'swing_heavy' : 'cast_charge', { volume: 0.7, rate: 1.8 });
      yield* wait(0.36);
      if (boss.state !== 'staggered') break;
      const hitPos = core.clone().lerp(p.clone().setY(core.y), 0.25);
      switch (m.def.id) {
        case 'symbeline':
          for (let k = 0; k < 3; k++) {
            fx.slashArc({ pos: hitPos, yaw: face(p) + Math.PI, radius: 4 + k, color: 0xffd34a, duration: 0.16, tilt: -0.6 + k * 0.6, mirror: k % 2 === 1, intensity: 2.6 });
          }
          audio.play('chakram', { volume: 0.9 });
          break;
        case 'ghalus':
          fx.pillar(ground, 4.2, 50, 0xfff2b0, 0.9, 3);
          fx.ring(ground, { r0: 1, r1: 8, life: 0.6, color: 0xfff2b0, intensity: 3 });
          audio.play('holy_burst', { volume: 1 });
          break;
        case 'deux':
          fx.blast(core, 7.5, 0xff5a1a, 0.6, 3.2);
          fx.burst(core, 160, { color: 0xff4a10, color2: 0xffd070, intensity: 3.4, speed: [6, 34], size: [0.2, 0.7], life: [0.4, 1.3], gravity: 5 });
          audio.play('explode', { volume: 1 });
          break;
        case 'sigmund':
          fx.slashArc({ pos: hitPos, yaw: face(p) + Math.PI, radius: 9, color: 0x8e2cff, duration: 0.2, tilt: -Math.PI / 2, intensity: 3.4 });
          fx.slashArc({ pos: hitPos, yaw: face(p) + Math.PI, radius: 8, color: 0xff2a55, duration: 0.2, tilt: -Math.PI / 2 + 0.5, intensity: 2.6 });
          fx.ring(ground, { r0: 1, r1: 10, life: 0.5, color: 0x8e2cff, intensity: 3 });
          break;
      }
      party.hitPart(boss.part('core'), move, m, hitPos, 1);
      hud.flash(0.35, 220);
      yield* wait(0.52);
    }

    // Everyone lands together.
    if (boss.state === 'staggered') {
      this.rig.override = { pos: ground.clone().addScaledVector(f, 17).addScaledVector(l, -7).setY(3.6), look: core.clone().setY(3.6), fov: 44 };
      fx.flash(core, 0xffffff, 40, 0.5, 3);
      fx.shake(1);
      hud.flash(0.8, 500);
      audio.play('boss_slam', { volume: 1 });
      yield* wait(0.75);
    }

    for (const m of order) if (m !== party.cur) m.visual.root.visible = false;
    hud.endAllOut();
    party.cinematic = false;
    this.rig.override = null;
    this.rig.yaw = party.yaw;
    this.rig.pitch = 0.05;
    this.rig.snapNext();
    boss.staggerHold = false;
    boss.staggerWindow = Math.min(boss.staggerWindow, 1.8);
    this.input.clear();
    if (this.mode === 'allout') this.mode = 'fight';
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
    }
    this.render(real);
  }

  private handleGlobalInput() {
    const input = this.input;
    const confirm = input.consume('confirm', 0.3);
    if (this.mode === 'title') {
      if (confirm) this.start();
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
    this.boss.update(dt);
    this.party.update(dt, this.rig.yaw);
    if (this.mode === 'allout') {
      // The benched Knights are on screen during the finisher and need animating too.
      for (const m of this.party.members) if (m !== this.party.cur && m.visual.root.visible) m.visual.update(dt);
    }

    // Boss hazards against the active Knight
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      h.update?.(dt);
      if (h.cooldown) h.cooldown -= dt;
      if (h.life <= 0) {
        this.hazards.splice(i, 1);
        continue;
      }
      if (h.resolved || (h.cooldown ?? 0) > 0 || this.god) continue;
      if (this.overlaps(h)) {
        const res = this.party.takeHit(h);
        if (res !== 'ignored') {
          if (h.tick) h.cooldown = h.tick;
          else h.resolved = true;
        }
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
    } else if (this.mode === 'intro' && rig.override) {
      // Tilt up with the colossus as it rises.
      rig.override.look.y = Math.min(13, rig.override.look.y + real * 1.6);
    }
    const lock = this.mode === 'fight' ? party.lock : null;
    const solid = boss.state === 'dead' || boss.state === 'dying' ? [] : boss.parts;
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
