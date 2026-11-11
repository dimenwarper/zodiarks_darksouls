import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { lerp } from '../core/math';
import type { CharId } from './defs';
import { buildMannequin } from './mannequin';

/** What the game needs from a character's on-screen body, whoever draws it. */
export interface CharVisual {
  root: THREE.Group;
  height: number;
  /** Loops ('idle', 'move') and one-shots ('roll', 'hurt', 'down', 'dead', 'swapIn' ...). */
  play(name: string, opts?: { duration?: number; fade?: number }): void;
  /** An attack, stretched so its strike lands exactly when the active window opens. */
  act(name: string, windup: number, active: number, recovery: number): void;
  setMoveSpeed(v: number): void;
  update(dt: number): void;
  /** World position spells and projectiles leave from. */
  castPoint(out: THREE.Vector3): THREE.Vector3;
  setOpacity(a: number): void;
  tint(color: number, strength: number): void;
}

/**
 * public/models/manifest.json, written by tools/tripo.mjs. A character listed here is
 * drawn with its generated model; anyone missing falls back to the procedural figure.
 */
export interface ModelManifest {
  [id: string]: {
    model: string;
    /** game animation name -> file holding that clip */
    anims: Record<string, string>;
    /** Fraction of each attack clip at which the blow lands. */
    impact?: Record<string, number>;
    /** `length` scales the weapon so its longest side measures that many metres. */
    weapon?: { model: string; length?: number; position?: number[]; rotation?: number[] };
    /** Extra yaw if the model does not face +Z. */
    yaw?: number;
  };
}

/** Which generated clip stands in for each game animation, in order of preference. */
export const ANIM_FALLBACKS: Record<string, string[]> = {
  move: ['run', 'walk'],
  roll: ['twirl'],
  twirl: ['roll'],
  blink: ['idle'],
  down: ['hurt'],
  dead: ['down', 'hurt'],
  swapIn: ['idle'],
  cheer: ['idle'],
  slashL: ['slashR'],
  overhead: ['slashR'],
  jabL: ['jabR'],
  spin: ['jabR'],
  throw: ['jabR'],
  bolt: ['channel'],
  channel: ['bolt'],
};

const loader = new GLTFLoader();

class GltfVisual implements CharVisual {
  root = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private attack: { action: THREE.AnimationAction; t: number; w: number; a: number; r: number; impact: number } | null = null;
  private oneshot: { action: THREE.AnimationAction; t: number; duration: number } | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];
  private tintColor = new THREE.Color();
  private tintAmount = 0;
  private castNode: THREE.Object3D;
  private moveSpeed = 0;

  constructor(
    public height: number,
    scene: THREE.Object3D,
    clips: Map<string, THREE.AnimationClip>,
    private impact: Record<string, number>,
    yaw: number,
  ) {
    // Normalise to the character's height, feet on the ground.
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const s = height / Math.max(0.001, size.y);
    scene.scale.setScalar(s);
    scene.position.set(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s);
    const turn = new THREE.Group();
    turn.rotation.y = yaw;
    turn.add(scene);
    this.root.add(turn);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as THREE.MeshStandardMaterial;
        sm.userData.baseEmissive = sm.emissive?.clone() ?? new THREE.Color(0);
        sm.userData.baseEmissiveIntensity = sm.emissiveIntensity ?? 1;
        this.mats.push(sm);
      }
    });
    this.mixer = new THREE.AnimationMixer(scene);
    for (const [name, clip] of clips) this.actions.set(name, this.mixer.clipAction(clip));
    let hand: THREE.Object3D | null = null;
    scene.traverse((o) => {
      if (!hand && (o as THREE.Bone).isBone && /(right.*hand|hand.*(right|_r|\.r)|r_?hand)/i.test(o.name) && !/(thumb|index|middle|ring|pinky)/i.test(o.name)) hand = o;
    });
    this.castNode = hand ?? this.root;
    this.play('idle');
  }

  /** The right-hand bone, for attaching a weapon. */
  get handBone() {
    return this.castNode === this.root ? null : this.castNode;
  }

  private find(name: string) {
    for (const n of [name, ...(ANIM_FALLBACKS[name] ?? [])]) {
      const a = this.actions.get(n);
      if (a) return a;
    }
    return this.actions.get('idle') ?? null;
  }

  private switchTo(action: THREE.AnimationAction | null, fade: number, loop: boolean) {
    if (!action) return;
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    action.setEffectiveWeight(1);
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, fade, false);
    action.play();
    this.current = action;
  }

  play(name: string, opts: { duration?: number; fade?: number } = {}) {
    const loop = name === 'idle' || name === 'move';
    if (loop && this.currentName === name && !this.attack && !this.oneshot) return;
    const action = this.find(name);
    this.attack = null;
    this.oneshot = null;
    this.currentName = name;
    this.switchTo(action, opts.fade ?? 0.15, loop);
    if (action && !loop) {
      action.paused = true;
      this.oneshot = { action, t: 0, duration: opts.duration ?? action.getClip().duration };
    } else if (action) {
      action.paused = false;
      action.timeScale = 1;
    }
  }

  act(name: string, windup: number, active: number, recovery: number) {
    const action = this.find(name);
    this.oneshot = null;
    this.currentName = name;
    this.switchTo(action, 0.08, false);
    if (!action) return;
    action.paused = true;
    this.attack = { action, t: 0, w: windup, a: active, r: recovery, impact: this.impact[name] ?? 0.4 };
  }

  setMoveSpeed(v: number) {
    this.moveSpeed = v;
  }

  update(dt: number) {
    if (this.attack) {
      // Warp clip time so the blow lands as the active window opens.
      const k = this.attack;
      k.t += dt;
      const d = k.action.getClip().duration;
      const hit = k.impact * d;
      const after = Math.min(d, hit + d * 0.12);
      let time: number;
      if (k.t < k.w) time = (k.t / k.w) * hit;
      else if (k.t < k.w + k.a) time = lerp(hit, after, (k.t - k.w) / k.a);
      else time = lerp(after, d, Math.min(1, (k.t - k.w - k.a) / k.r));
      k.action.time = time;
    } else if (this.oneshot) {
      const o = this.oneshot;
      o.t += dt;
      o.action.time = Math.min(1, o.t / o.duration) * o.action.getClip().duration;
    } else if (this.current && this.currentName === 'move') {
      this.current.timeScale = 0.55 + 0.6 * this.moveSpeed;
    }
    this.mixer.update(dt);
    if (this.tintAmount > 0) {
      this.tintAmount = Math.max(0, this.tintAmount - dt * 3.5);
      for (const m of this.mats) {
        if (!m.emissive) continue;
        m.emissive.copy(m.userData.baseEmissive).lerp(this.tintColor, Math.min(1, this.tintAmount) * 0.7);
        m.emissiveIntensity = lerp(m.userData.baseEmissiveIntensity, 1.4, Math.min(1, this.tintAmount));
      }
    }
  }

  castPoint(out: THREE.Vector3) {
    return this.castNode.getWorldPosition(out);
  }

  setOpacity(a: number) {
    for (const m of this.mats) {
      m.transparent = a < 1;
      m.opacity = a;
      m.depthWrite = a >= 1;
    }
  }

  tint(color: number, strength: number) {
    this.tintColor.set(color);
    this.tintAmount = strength;
  }
}

/** Keep generated clips in place: the game moves the character, not the animation. */
function stripRootMotion(clip: THREE.AnimationClip) {
  const track = clip.tracks.find((t) => t.name.endsWith('.position'));
  if (!track) return;
  const v = track.values;
  for (let i = 3; i < v.length; i += 3) {
    v[i] = v[0];
    v[i + 2] = v[2];
  }
}

export async function loadManifest(): Promise<ModelManifest> {
  try {
    const res = await fetch('/models/manifest.json', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return {};
    return (await res.json()) as ModelManifest;
  } catch {
    return {};
  }
}

export async function createVisual(id: CharId, height: number, manifest: ModelManifest): Promise<CharVisual> {
  const entry = manifest[id];
  if (entry) {
    try {
      const gltf = await loader.loadAsync(`/models/${entry.model}`);
      const clips = new Map<string, THREE.AnimationClip>();
      await Promise.all(
        Object.entries(entry.anims).map(async ([name, file]) => {
          const g = file === entry.model ? gltf : await loader.loadAsync(`/models/${file}`);
          const clip = g.animations[0];
          if (!clip) return;
          const c = clip.clone();
          c.name = name;
          stripRootMotion(c);
          clips.set(name, c);
        }),
      );
      if (clips.has('idle')) {
        const visual = new GltfVisual(height, gltf.scene, clips, entry.impact ?? {}, entry.yaw ?? 0);
        if (entry.weapon && visual.handBone) {
          const w = (await loader.loadAsync(`/models/${entry.weapon.model}`)).scene;
          const wp = entry.weapon;
          // Bones carry the model's own scale; undo it so weapon sizes are in metres.
          const ws = new THREE.Vector3();
          visual.handBone.getWorldScale(ws);
          const size = new THREE.Box3().setFromObject(w).getSize(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z, 1e-6);
          w.scale.setScalar((wp.length ?? longest) / longest / Math.max(1e-6, ws.x));
          if (wp.position) w.position.fromArray(wp.position).divideScalar(Math.max(1e-6, ws.x));
          if (wp.rotation) w.rotation.fromArray(wp.rotation as [number, number, number]);
          w.traverse((o) => (o.castShadow = true));
          visual.handBone.add(w);
        }
        return visual;
      }
      console.warn(`[models] ${id}: no idle clip in manifest, using the stand-in`);
    } catch (err) {
      console.warn(`[models] ${id}: failed to load generated model, using the stand-in`, err);
    }
  }
  return buildMannequin(id);
}
