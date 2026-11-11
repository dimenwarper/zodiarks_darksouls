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
    /** Extra yaw if the model does not face +Z. */
    yaw?: number;
    /**
     * game animation -> the file holding its clip. `cut` picks the slice to play, as fractions
     * of the clip: [start, end], or [start, hit, end] for attacks (`hit` = the blow landing).
     * `turns` spins the whole body that many times during an attack.
     */
    anims: Record<string, { file: string; cut?: number[]; turns?: number }>;
    /**
     * `length` in metres. `grip`: where along it the hand closes, butt (0) to tip (1).
     * `tip`: the way it points while standing idle, in the character's own space
     * (+x left, +y up, +z forward). `flip` swaps which end counts as the tip.
     */
    weapon?: { model: string; length: number; grip: number; tip: number[]; flip?: boolean };
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

/** One game animation: an action plus the slice of its clip that gets played. */
interface Clip {
  action: THREE.AnimationAction;
  start: number;
  hit: number;
  end: number;
  turns: number;
}

class GltfVisual implements CharVisual {
  root = new THREE.Group();
  private turn = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private clips = new Map<string, Clip>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private attack: { clip: Clip; t: number; w: number; a: number; r: number } | null = null;
  private oneshot: { clip: Clip; t: number; duration: number } | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];
  private tintColor = new THREE.Color();
  private tintAmount = 0;
  private castNode: THREE.Object3D;
  private hands: { R: THREE.Object3D | null; L: THREE.Object3D | null } = { R: null, L: null };
  private moveSpeed = 0;

  constructor(
    public height: number,
    scene: THREE.Object3D,
    clips: Map<string, { clip: THREE.AnimationClip; cut?: number[]; turns?: number }>,
    private yaw: number,
  ) {
    // Normalise to the character's height, feet on the ground.
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const s = height / Math.max(0.001, size.y);
    scene.scale.setScalar(s);
    scene.position.set(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s);
    this.turn.rotation.y = yaw;
    this.turn.add(scene);
    this.root.add(this.turn);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.adopt(mesh);
    });
    this.mixer = new THREE.AnimationMixer(scene);
    for (const [name, c] of clips) {
      const cut = c.cut ?? [0, 1];
      const d = c.clip.duration;
      this.clips.set(name, {
        action: this.mixer.clipAction(c.clip),
        start: cut[0] * d,
        hit: (cut.length > 2 ? cut[1] : cut[0]) * d,
        end: cut[cut.length - 1] * d,
        turns: c.turns ?? 0,
      });
    }
    scene.traverse((o) => {
      if (!(o as THREE.Bone).isBone || /(thumb|index|middle|ring|pinky)/i.test(o.name)) return;
      if (!this.hands.R && /(right.*hand|hand.*(right|_r|\.r)|r_?hand)/i.test(o.name)) this.hands.R = o;
      if (!this.hands.L && /(left.*hand|hand.*(left|_l|\.l)|l_?hand)/i.test(o.name)) this.hands.L = o;
    });
    this.castNode = this.hands.R ?? this.root;
    this.play('idle');
    this.mixer.update(0);
  }

  /** Track a mesh's materials so hit flashes and fades reach them. */
  private adopt(mesh: THREE.Mesh) {
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const sm = m as THREE.MeshStandardMaterial;
      sm.userData.baseEmissive = sm.emissive?.clone() ?? new THREE.Color(0);
      sm.userData.baseEmissiveIntensity = sm.emissiveIntensity ?? 1;
      this.mats.push(sm);
    }
  }

  /**
   * Put a weapon in a hand. Rig conventions differ, so rather than trusting the hand bone's
   * axes this reads the idle pose and solves for the grip that makes the weapon point along
   * `tip` (given in the character's own space) while the character stands at rest.
   */
  attachWeapon(weapon: THREE.Object3D, cfg: { length: number; grip: number; tip: number[]; flip?: boolean }, side: 'R' | 'L' = 'R') {
    const hand = this.hands[side];
    if (!hand) return;
    this.root.updateMatrixWorld(true);
    // The weapon's own long axis, and the wide one (a blade's flat, a staff's head).
    const box = new THREE.Box3().setFromObject(weapon);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const dims = [size.x, size.y, size.z];
    const order = [0, 1, 2].sort((p, q) => dims[q] - dims[p]);
    const axis = (i: number) => new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
    const long = axis(order[0]).multiplyScalar(cfg.flip ? -1 : 1);
    const wide = axis(order[1]);
    const rawLength = Math.max(1e-6, dims[order[0]]);

    // Bones carry the model's scale; undo it so the weapon comes out in metres.
    const handScale = Math.max(1e-6, hand.getWorldScale(new THREE.Vector3()).x);
    const handQuat = hand.getWorldQuaternion(new THREE.Quaternion());
    const handPos = hand.getWorldPosition(new THREE.Vector3());
    const forearm = handPos.clone().sub(hand.parent!.getWorldPosition(new THREE.Vector3()));
    if (forearm.lengthSq() < 1e-8) forearm.set(0, -1, 0);
    forearm.normalize();

    // World orientation at rest: long axis onto `tip`, then roll the wide axis into the
    // vertical plane the weapon lies in, so a blade's edge faces down rather than sideways.
    const tip = new THREE.Vector3().fromArray(cfg.tip).normalize();
    const world = new THREE.Quaternion().setFromUnitVectors(long, tip);
    const flat = wide.clone().applyQuaternion(world);
    const want = new THREE.Vector3(0, -1, 0).addScaledVector(tip, tip.y);
    if (want.lengthSq() < 1e-4) want.set(0, 0, 1).addScaledVector(tip, -tip.z);
    want.normalize();
    const roll = Math.atan2(new THREE.Vector3().crossVectors(flat, want).dot(tip), flat.dot(want));
    world.premultiply(new THREE.Quaternion().setFromAxisAngle(tip, roll));

    const grip = new THREE.Group();
    grip.quaternion.copy(handQuat.invert().multiply(world));
    grip.scale.setScalar(cfg.length / rawLength / handScale);
    // The bone sits at the wrist; the palm is a little further along the forearm's line.
    grip.position.copy(hand.worldToLocal(handPos.addScaledVector(forearm, this.height * 0.045)));
    // Slide the weapon so the point `grip` of the way along it sits in the palm.
    weapon.position.sub(centre.addScaledVector(long, (cfg.grip - 0.5) * rawLength));
    grip.add(weapon);
    hand.add(grip);
    weapon.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.adopt(mesh);
    });
  }

  private find(name: string): Clip | null {
    for (const n of [name, ...(ANIM_FALLBACKS[name] ?? [])]) {
      const c = this.clips.get(n);
      if (c) return c;
    }
    return this.clips.get('idle') ?? null;
  }

  private switchTo(clip: Clip | null, fade: number, loop: boolean) {
    this.turn.rotation.y = this.yaw;
    if (!clip) return;
    const action = clip.action;
    const from = this.current;
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.time = clip.start;
    if (from && from !== action) action.crossFadeFrom(from, fade, false);
    action.play();
    this.current = action;
  }

  play(name: string, opts: { duration?: number; fade?: number } = {}) {
    const loop = name === 'idle' || name === 'move';
    if (loop && this.currentName === name && !this.attack && !this.oneshot) return;
    const clip = this.find(name);
    this.attack = null;
    this.oneshot = null;
    this.currentName = name;
    this.switchTo(clip, opts.fade ?? 0.15, loop);
    if (!clip) return;
    clip.action.paused = !loop;
    if (loop) clip.action.timeScale = 1;
    else this.oneshot = { clip, t: 0, duration: opts.duration ?? clip.end - clip.start };
  }

  act(name: string, windup: number, active: number, recovery: number) {
    const clip = this.find(name);
    this.oneshot = null;
    this.currentName = name;
    this.switchTo(clip, 0.08, false);
    if (!clip) return;
    clip.action.paused = true;
    this.attack = { clip, t: 0, w: windup, a: active, r: recovery };
  }

  setMoveSpeed(v: number) {
    this.moveSpeed = v;
  }

  update(dt: number) {
    if (this.attack) {
      // Warp clip time so the blow lands exactly as the active window opens.
      const k = this.attack;
      const c = k.clip;
      k.t += dt;
      c.action.time = k.t < k.w
        ? lerp(c.start, c.hit, k.t / k.w)
        : lerp(c.hit, c.end, 1 - (1 - Math.min(1, (k.t - k.w) / (k.a + k.r))) ** 2);
      if (c.turns) {
        const p = Math.min(1, k.t / (k.w + k.a));
        this.turn.rotation.y = this.yaw + Math.PI * 2 * c.turns * p * p * (3 - 2 * p);
      }
    } else if (this.oneshot) {
      const o = this.oneshot;
      o.t += dt;
      o.clip.action.time = lerp(o.clip.start, o.clip.end, Math.min(1, o.t / o.duration));
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
      // Several game animations can be slices of one file: fetch each file once.
      const files = [...new Set(Object.values(entry.anims).map((a) => a.file))];
      const [gltf, weapon, ...loaded] = await Promise.all([
        loader.loadAsync(`/models/${entry.model}`),
        entry.weapon ? loader.loadAsync(`/models/${entry.weapon.model}`) : null,
        ...files.map((f) => loader.loadAsync(`/models/${f}`)),
      ]);
      const clips = new Map<string, { clip: THREE.AnimationClip; cut?: number[]; turns?: number }>();
      for (const [name, a] of Object.entries(entry.anims)) {
        const source = loaded[files.indexOf(a.file)].animations[0];
        if (!source) continue;
        const clip = source.clone();
        clip.name = name;
        stripRootMotion(clip);
        clips.set(name, { clip, cut: a.cut, turns: a.turns });
      }
      if (clips.has('idle')) {
        const visual = new GltfVisual(height, gltf.scene, clips, entry.yaw ?? 0);
        if (weapon && entry.weapon) visual.attachWeapon(weapon.scene, entry.weapon);
        if (id === 'symbeline') {
          // Her chakrams are simple enough to make here: a gold ring held by the rim in each hand.
          for (const side of ['R', 'L'] as const) {
            const ring = new THREE.Mesh(
              new THREE.TorusGeometry(0.3, 0.028, 10, 40),
              new THREE.MeshStandardMaterial({ color: 0xf2c230, metalness: 0.9, roughness: 0.25, emissive: 0x6a4a08, emissiveIntensity: 0.6 }),
            );
            visual.attachWeapon(ring, { length: 0.66, grip: 0.06, tip: [side === 'R' ? -0.25 : 0.25, -0.25, 0.94] }, side);
          }
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
