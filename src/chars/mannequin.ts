import * as THREE from 'three';
import { TAU, ease, lerp, wrapAngle } from '../core/math';
import type { CharId } from './defs';
import type { CharVisual } from './visual';

/**
 * Procedural stand-in characters: a jointed figure built from primitives, animated by
 * code. They exist so the game is fully playable before (and without) generated models,
 * and each is dressed to read as its Knight at a glance.
 *
 * Joint conventions (character faces +Z, left is +X, limbs hang along -Y at rest):
 *  - arm / thigh  x < 0 swings forward; armL z > 0 and armR z < 0 lift outward
 *  - fore x < 0 bends the elbow; shin x > 0 bends the knee
 *  - spine / chest x > 0 leans forward, y > 0 twists left
 *  - body x pitches the whole figure forward (rolls), y spins it
 */
const JOINTS = [
  'body', 'hips', 'spine', 'chest', 'head',
  'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
] as const;
type Joint = (typeof JOINTS)[number];
const JI = Object.fromEntries(JOINTS.map((j, i) => [j, i])) as Record<Joint, number>;
const HIPS_Y = JOINTS.length * 3;
const LIFT = HIPS_Y + 1;
const N = LIFT + 1;
type Pose = Float32Array;
type KP = Partial<Record<Joint, [number, number, number]>> & { hipsY?: number; lift?: number };

function addKP(p: Pose, kp: KP, w = 1) {
  for (const key in kp) {
    if (key === 'hipsY') p[HIPS_Y] += kp.hipsY! * w;
    else if (key === 'lift') p[LIFT] += kp.lift! * w;
    else {
      const v = kp[key as Joint]!;
      const i = JI[key as Joint] * 3;
      p[i] += v[0] * w;
      p[i + 1] += v[1] * w;
      p[i + 2] += v[2] * w;
    }
  }
}

const STANCE: KP = {
  thighL: [-0.24, 0, 0.07], shinL: [0.4, 0, 0], thighR: [0.14, 0, -0.07], shinR: [0.32, 0, 0],
  spine: [0.06, 0, 0], chest: [0.07, 0, 0],
  armL: [-0.25, 0, 0.2], foreL: [-0.7, 0, 0], armR: [-0.35, 0, -0.16], foreR: [-0.95, 0, 0],
  hipsY: -0.03,
};
const st = (o: KP): KP => ({ ...STANCE, ...o });

/** Piecewise pose track; times are in whatever unit the caller samples with. */
function keyed(keys: [number, KP][]) {
  const dense = keys.map(([t, kp]) => {
    const b = new Float32Array(N);
    addKP(b, kp);
    return { t, b };
  });
  return (p: Pose, k: number) => {
    let i = 0;
    while (i < dense.length - 2 && k > dense[i + 1].t) i++;
    const a = dense[i];
    const b = dense[Math.min(i + 1, dense.length - 1)];
    const u = b.t > a.t ? ease.inOut(Math.min(1, Math.max(0, (k - a.t) / (b.t - a.t)))) : 1;
    for (let n = 0; n < N; n++) p[n] = lerp(a.b[n], b.b[n], u);
  };
}

/** Attack clips are keyed in phases: 0-1 windup, 1-2 active, 2-3 recovery. */
const LEGS_PLANT: KP = { thighL: [-0.5, 0, 0.07], shinL: [0.62, 0, 0], thighR: [0.3, 0, -0.07], shinR: [0.42, 0, 0], hipsY: -0.06 };
const LEGS_DEEP: KP = { thighL: [-0.75, 0, 0.07], shinL: [0.95, 0, 0], thighR: [0.42, 0, -0.07], shinR: [0.6, 0, 0], hipsY: -0.11 };

const ATTACKS: Record<string, ReturnType<typeof keyed>> = {
  slashR: keyed([
    [0, STANCE],
    [0.9, st({ ...LEGS_PLANT, chest: [0.05, -0.8, 0], spine: [0, -0.35, 0], armR: [-1.0, 0, -1.3], foreR: [-0.45, 0, 0], armL: [-1.25, 0, -0.55], foreL: [-1.1, 0, 0] })],
    [1.0, st({ ...LEGS_PLANT, chest: [0.05, -0.85, 0], spine: [0, -0.38, 0], armR: [-1.0, 0, -1.35], foreR: [-0.4, 0, 0], armL: [-1.25, 0, -0.55], foreL: [-1.1, 0, 0] })],
    [2.0, st({ ...LEGS_DEEP, chest: [0.28, 0.85, 0], spine: [0.1, 0.38, 0], armR: [-1.25, 0, 0.8], foreR: [-0.2, 0, 0], armL: [-0.9, 0, 0.5], foreL: [-0.9, 0, 0] })],
    [2.45, st({ ...LEGS_DEEP, chest: [0.26, 0.8, 0], spine: [0.1, 0.34, 0], armR: [-1.15, 0, 0.8], foreR: [-0.3, 0, 0], armL: [-0.9, 0, 0.5], foreL: [-0.9, 0, 0] })],
    [3.0, STANCE],
  ]),
  slashL: keyed([
    [0, STANCE],
    [0.9, st({ ...LEGS_PLANT, chest: [0.1, 0.8, 0], spine: [0, 0.35, 0], armR: [-1.2, 0, 0.85], foreR: [-0.5, 0, 0], armL: [-0.8, 0, 0.5], foreL: [-1.0, 0, 0] })],
    [1.0, st({ ...LEGS_PLANT, chest: [0.1, 0.85, 0], spine: [0, 0.38, 0], armR: [-1.2, 0, 0.9], foreR: [-0.45, 0, 0], armL: [-0.8, 0, 0.5], foreL: [-1.0, 0, 0] })],
    [2.0, st({ ...LEGS_DEEP, chest: [0.25, -0.85, 0], spine: [0.1, -0.38, 0], armR: [-1.05, 0, -1.3], foreR: [-0.2, 0, 0], armL: [-1.2, 0, -0.5], foreL: [-1.0, 0, 0] })],
    [2.45, st({ ...LEGS_DEEP, chest: [0.22, -0.8, 0], spine: [0.1, -0.34, 0], armR: [-1.0, 0, -1.25], foreR: [-0.3, 0, 0], armL: [-1.2, 0, -0.5], foreL: [-1.0, 0, 0] })],
    [3.0, STANCE],
  ]),
  overhead: keyed([
    [0, STANCE],
    [0.9, st({ chest: [-0.32, 0, 0], spine: [-0.16, 0, 0], armR: [-2.95, 0, -0.15], foreR: [-0.5, 0, 0], armL: [-2.95, 0, 0.15], foreL: [-0.6, 0, 0], thighL: [-0.3, 0, 0.07], shinL: [0.5, 0, 0], thighR: [0.22, 0, -0.07], shinR: [0.45, 0, 0], hipsY: -0.02 })],
    [1.0, st({ chest: [-0.36, 0, 0], spine: [-0.18, 0, 0], armR: [-3.0, 0, -0.15], foreR: [-0.45, 0, 0], armL: [-3.0, 0, 0.15], foreL: [-0.55, 0, 0], thighL: [-0.3, 0, 0.07], shinL: [0.5, 0, 0], thighR: [0.22, 0, -0.07], shinR: [0.45, 0, 0], hipsY: -0.02 })],
    [2.0, st({ ...LEGS_DEEP, chest: [0.6, 0, 0], spine: [0.32, 0, 0], armR: [-0.7, 0, 0.1], foreR: [-0.12, 0, 0], armL: [-0.75, 0, -0.1], foreL: [-0.3, 0, 0], hipsY: -0.13 })],
    [2.5, st({ ...LEGS_DEEP, chest: [0.55, 0, 0], spine: [0.3, 0, 0], armR: [-0.7, 0, 0.1], foreR: [-0.15, 0, 0], armL: [-0.75, 0, -0.1], foreL: [-0.3, 0, 0], hipsY: -0.13 })],
    [3.0, STANCE],
  ]),
  jabR: keyed([
    [0, STANCE],
    [0.9, st({ chest: [0, -0.55, 0], armR: [-1.15, 0, -0.95], foreR: [-0.9, 0, 0], armL: [-0.5, 0, 0.6], foreL: [-1.2, 0, 0] })],
    [2.0, st({ ...LEGS_PLANT, chest: [0.16, 0.6, 0], armR: [-1.4, 0, 0.55], foreR: [-0.08, 0, 0], armL: [0.3, 0, 0.5], foreL: [-0.4, 0, 0] })],
    [2.4, st({ ...LEGS_PLANT, chest: [0.14, 0.5, 0], armR: [-1.3, 0, 0.5], foreR: [-0.15, 0, 0], armL: [0.3, 0, 0.5], foreL: [-0.4, 0, 0] })],
    [3.0, STANCE],
  ]),
  jabL: keyed([
    [0, STANCE],
    [0.9, st({ chest: [0, 0.55, 0], armL: [-1.15, 0, 0.95], foreL: [-0.9, 0, 0], armR: [-0.5, 0, -0.6], foreR: [-1.2, 0, 0] })],
    [2.0, st({ ...LEGS_PLANT, chest: [0.16, -0.6, 0], armL: [-1.4, 0, -0.55], foreL: [-0.08, 0, 0], armR: [0.3, 0, -0.5], foreR: [-0.4, 0, 0] })],
    [2.4, st({ ...LEGS_PLANT, chest: [0.14, -0.5, 0], armL: [-1.3, 0, -0.5], foreL: [-0.15, 0, 0], armR: [0.3, 0, -0.5], foreR: [-0.4, 0, 0] })],
    [3.0, STANCE],
  ]),
  spin: keyed([
    [0, STANCE],
    [1.0, st({ body: [0, -0.9, 0], armL: [-0.3, 0, 1.1], foreL: [-0.3, 0, 0], armR: [-0.3, 0, -1.1], foreR: [-0.3, 0, 0], hipsY: -0.07 })],
    [2.0, st({ body: [0, TAU + 0.5, 0], armL: [-0.1, 0, 1.45], foreL: [0, 0, 0], armR: [-0.1, 0, -1.45], foreR: [0, 0, 0], thighR: [0.1, 0, -0.5], hipsY: -0.02 })],
    [2.5, st({ body: [0, TAU + 0.15, 0], armL: [-0.2, 0, 1.0], foreL: [-0.3, 0, 0], armR: [-0.2, 0, -1.0], foreR: [-0.3, 0, 0] })],
    [3.0, { ...STANCE, body: [0, TAU, 0] }],
  ]),
  throw: keyed([
    [0, STANCE],
    [0.9, st({ chest: [-0.12, 0, 0], armR: [-1.3, 0, 0.95], foreR: [-1.2, 0, 0], armL: [-1.3, 0, -0.95], foreL: [-1.2, 0, 0], hipsY: -0.05 })],
    [2.0, st({ ...LEGS_PLANT, chest: [0.32, 0, 0], armR: [-1.5, 0, -0.6], foreR: [0, 0, 0], armL: [-1.5, 0, 0.6], foreL: [0, 0, 0] })],
    [2.5, st({ ...LEGS_PLANT, chest: [0.28, 0, 0], armR: [-1.4, 0, -0.7], foreR: [-0.1, 0, 0], armL: [-1.4, 0, 0.7], foreL: [-0.1, 0, 0] })],
    [3.0, STANCE],
  ]),
  bolt: keyed([
    [0, STANCE],
    [0.9, st({ chest: [-0.05, -0.45, 0], armR: [0.25, 0, -0.45], foreR: [-1.7, 0, 0], armL: [-1.1, 0, 0.1], foreL: [-0.3, 0, 0] })],
    [2.0, st({ ...LEGS_PLANT, chest: [0.2, 0.35, 0], armR: [-1.55, 0, 0.12], foreR: [-0.05, 0, 0], handR: [1.0, 0, 0], armL: [0.3, 0, 0.3], foreL: [-0.6, 0, 0] })],
    [2.4, st({ ...LEGS_PLANT, chest: [0.18, 0.3, 0], armR: [-1.5, 0, 0.12], foreR: [-0.1, 0, 0], handR: [0.9, 0, 0], armL: [0.3, 0, 0.3], foreL: [-0.6, 0, 0] })],
    [3.0, STANCE],
  ]),
  channel: keyed([
    [0, STANCE],
    [0.2, st({ armR: [-1.2, 0, -0.3], foreR: [-0.7, 0, 0], armL: [-1.2, 0, 0.3], foreL: [-0.7, 0, 0] })],
    [0.95, st({ chest: [-0.26, 0, 0], armR: [-2.8, 0, -0.4], foreR: [-0.2, 0, 0], handR: [-0.5, 0, 0], armL: [-2.8, 0, 0.4], foreL: [-0.2, 0, 0], thighL: [-0.1, 0, 0.07], shinL: [0.3, 0, 0], thighR: [0.05, 0, -0.07], shinR: [0.2, 0, 0], hipsY: 0, lift: 0.1 })],
    [1.0, st({ chest: [-0.3, 0, 0], armR: [-2.9, 0, -0.4], foreR: [-0.15, 0, 0], handR: [-0.5, 0, 0], armL: [-2.9, 0, 0.4], foreL: [-0.15, 0, 0], thighL: [-0.1, 0, 0.07], shinL: [0.3, 0, 0], thighR: [0.05, 0, -0.07], shinR: [0.2, 0, 0], hipsY: 0, lift: 0.1 })],
    [2.0, st({ ...LEGS_DEEP, chest: [0.5, 0, 0], armR: [-1.15, 0, -0.1], foreR: [0, 0, 0], handR: [1.0, 0, 0], armL: [-1.15, 0, 0.1], foreL: [0, 0, 0] })],
    [2.5, st({ ...LEGS_DEEP, chest: [0.45, 0, 0], armR: [-1.1, 0, -0.1], foreR: [-0.1, 0, 0], handR: [0.9, 0, 0], armL: [-1.1, 0, 0.1], foreL: [-0.1, 0, 0] })],
    [3.0, STANCE],
  ]),
};

const TUCK: KP = {
  chest: [0.7, 0, 0], spine: [0.5, 0, 0], head: [0.5, 0, 0],
  thighL: [-1.7, 0, 0.05], shinL: [2.1, 0, 0], thighR: [-1.6, 0, -0.05], shinR: [2.0, 0, 0],
  armL: [-1.0, 0, 0.3], foreL: [-1.8, 0, 0], armR: [-1.0, 0, -0.3], foreR: [-1.8, 0, 0],
};

/** One-shot clips, sampled with k in 0..1. */
const ONESHOT: Record<string, (p: Pose, k: number, legRatio: number) => void> = {
  roll: (p, k, legRatio) => {
    const tuck = Math.sin(Math.PI * Math.min(1, k * 1.15));
    addKP(p, STANCE, 1 - tuck);
    addKP(p, TUCK, tuck);
    p[JI.body * 3] = k < 0.98 ? ease.inOut(Math.min(1, k * 1.12)) * TAU : 0;
    p[HIPS_Y] += -legRatio * 0.62 * tuck;
  },
  twirl: (p, k) => {
    addKP(p, STANCE);
    const s = Math.sin(Math.PI * k);
    p[JI.body * 3 + 1] = k < 0.98 ? ease.inOut(k) * TAU : 0;
    addKP(p, { armL: [0, 0, 1.1], armR: [0, 0, -1.1], foreL: [0.5, 0, 0], foreR: [0.6, 0, 0], thighR: [-0.5, 0, 0], shinR: [0.9, 0, 0], hipsY: -0.02, lift: 0.04 }, s);
  },
  blink: (p) => addKP(p, st({ chest: [0.3, 0, 0], armL: [0.5, 0, 0.3], armR: [0.5, 0, -0.3] })),
  hurt: keyed([
    [0, st({ chest: [-0.55, 0.2, 0], head: [-0.4, 0, 0], armL: [0.3, 0, 0.9], armR: [0.4, 0, -0.8], hipsY: -0.06 })],
    [0.35, st({ chest: [-0.4, 0.1, 0], head: [-0.2, 0, 0], armL: [0.1, 0, 0.6], armR: [0.2, 0, -0.5], hipsY: -0.07 })],
    [1, STANCE],
  ]) as (p: Pose, k: number) => void,
  swapIn: keyed([
    [0, { ...TUCK, lift: 0.5, hipsY: -0.1 }],
    [0.45, st({ ...LEGS_DEEP, chest: [0.5, 0, 0], armL: [0.4, 0, 0.7], armR: [0.4, 0, -0.7], hipsY: -0.16 })],
    [1, STANCE],
  ]) as (p: Pose, k: number) => void,
  cheer: keyed([
    [0, STANCE],
    [0.4, st({ armR: [-2.9, 0, -0.3], foreR: [-0.2, 0, 0], chest: [-0.15, 0, 0] })],
    [1, st({ armR: [-2.8, 0, -0.3], foreR: [-0.3, 0, 0], chest: [-0.12, 0, 0] })],
  ]) as (p: Pose, k: number) => void,
};

const DOWN = (legRatio: number): KP => ({
  body: [-Math.PI / 2, 0, 0], hipsY: -(legRatio - 0.07),
  armL: [0.2, 0, 1.2], armR: [0.3, 0, -1.0], foreL: [-0.3, 0, 0], foreR: [-0.5, 0, 0],
  thighL: [-0.3, 0, 0.2], shinL: [0.5, 0, 0], thighR: [0.05, 0, -0.2], shinR: [0.2, 0, 0], head: [-0.2, 0.3, 0],
});
ONESHOT.down = (p, k, legRatio) => {
  // Thrown onto the back, then scrambling up in the last third.
  const fall = ease.out(Math.min(1, k / 0.22));
  const rise = ease.inOut(Math.max(0, (k - 0.66) / 0.34));
  const w = fall * (1 - rise);
  addKP(p, STANCE, 1 - w);
  addKP(p, DOWN(legRatio), w);
};
ONESHOT.dead = (p, k, legRatio) => {
  const w = ease.out(Math.min(1, k / 0.6));
  addKP(p, STANCE, 1 - w);
  addKP(p, DOWN(legRatio), w);
};

export interface BodySpec {
  height: number;
  /** Leg length as a fraction of height. */
  legRatio: number;
  shoulder: number;
  hip: number;
  limb: number;
  torso: number;
}

interface Playing {
  kind: 'idle' | 'move' | 'oneshot' | 'attack';
  name: string;
  t: number;
  duration: number;
  windup: number;
  active: number;
  recovery: number;
}

export class Mannequin implements CharVisual {
  root = new THREE.Group();
  height: number;
  nodes = {} as Record<Joint, THREE.Group>;
  private lift = new THREE.Group();
  private hipY: number;
  private cur = new Float32Array(N);
  private from = new Float32Array(N);
  private tmp = new Float32Array(N);
  private playing: Playing = { kind: 'idle', name: 'idle', t: 0, duration: 1, windup: 0, active: 0, recovery: 0 };
  private fade = 1;
  private fadeDur = 0.12;
  private clock = 0;
  private stride = 0;
  private moveSpeed = 0;
  private mats: THREE.MeshStandardMaterial[] = [];
  private tintColor = new THREE.Color();
  private tintAmount = 0;
  /** Where spells leave from (staff head, sword tip). */
  castNode = new THREE.Object3D();

  constructor(public spec: BodySpec) {
    const H = (this.height = spec.height);
    const legLen = H * spec.legRatio;
    this.hipY = legLen;
    this.root.add(this.lift);
    const mk = (name: Joint, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      parent.add(g);
      this.nodes[name] = g;
      return g;
    };
    const torso = H * (1 - spec.legRatio);
    const spineLen = torso * 0.21;
    const chestLen = torso * 0.33;
    const body = mk('body', this.lift, 0, legLen, 0);
    const hips = mk('hips', body);
    const spine = mk('spine', body, 0, H * 0.01, 0);
    const chest = mk('chest', spine, 0, spineLen, 0);
    mk('head', chest, 0, chestLen + torso * 0.05, 0);
    const upper = H * 0.165;
    const fore = H * 0.15;
    for (const [s, side] of [['L', 1], ['R', -1]] as const) {
      const arm = mk(`arm${s}`, chest, side * spec.shoulder, chestLen * 0.86, 0);
      const fa = mk(`fore${s}`, arm, 0, -upper, 0);
      mk(`hand${s}`, fa, 0, -fore, 0);
      const thigh = mk(`thigh${s}`, hips, side * spec.hip, 0, 0);
      const shin = mk(`shin${s}`, thigh, 0, -legLen * 0.52, 0);
      mk(`foot${s}`, shin, 0, -legLen * 0.48 + H * 0.035, 0);
    }
    this.nodes.handR.add(this.castNode);
  }

  /** Dimensions the dress-up code needs. */
  get dims() {
    const H = this.height;
    const legLen = H * this.spec.legRatio;
    const torso = H - legLen;
    return {
      H, legLen, torso,
      thigh: legLen * 0.52, shin: legLen * 0.48 - H * 0.035,
      spine: torso * 0.21, chest: torso * 0.33,
      upper: H * 0.165, fore: H * 0.15,
      headR: torso * 0.2,
    };
  }

  mat(color: number, opts: THREE.MeshStandardMaterialParameters = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.05, ...opts });
    m.userData.baseEmissive = (m.emissive ?? new THREE.Color(0)).clone();
    m.userData.baseEmissiveIntensity = m.emissiveIntensity;
    this.mats.push(m);
    return m;
  }

  add(joint: Joint, geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.nodes[joint].add(mesh);
    return mesh;
  }

  /** A limb segment hanging from its joint. */
  limb(joint: Joint, len: number, r0: number, r1: number, material: THREE.Material) {
    return this.add(joint, new THREE.CylinderGeometry(r0, r1, len, 8), material, 0, -len / 2, 0);
  }

  play(name: string, opts: { duration?: number; fade?: number } = {}) {
    const kind = name === 'idle' ? 'idle' : name === 'move' ? 'move' : 'oneshot';
    if (this.playing.kind === kind && this.playing.name === name && kind !== 'oneshot') return;
    this.begin({ kind, name, t: 0, duration: opts.duration ?? 1, windup: 0, active: 0, recovery: 0 }, opts.fade ?? 0.12);
  }

  act(name: string, windup: number, active: number, recovery: number) {
    this.begin({ kind: 'attack', name, t: 0, duration: windup + active + recovery, windup, active, recovery }, 0.07);
  }

  private begin(p: Playing, fade: number) {
    this.from.set(this.cur);
    // Spins end a full turn away from where the next clip starts; unwind them.
    this.from[JI.body * 3] = wrapAngle(this.from[JI.body * 3]);
    this.from[JI.body * 3 + 1] = wrapAngle(this.from[JI.body * 3 + 1]);
    this.playing = p;
    this.fade = 0;
    this.fadeDur = Math.max(0.001, fade);
  }

  setMoveSpeed(v: number) {
    this.moveSpeed = v;
  }

  update(dt: number) {
    const p = this.playing;
    p.t += dt;
    this.clock += dt;
    const out = this.tmp.fill(0);
    const legRatio = this.spec.legRatio;
    if (p.kind === 'attack') {
      const t = p.t;
      const phase = t < p.windup ? t / p.windup : t < p.windup + p.active ? 1 + (t - p.windup) / p.active : 2 + Math.min(1, (t - p.windup - p.active) / p.recovery);
      (ATTACKS[p.name] ?? ATTACKS.slashR)(out, phase);
    } else if (p.kind === 'oneshot') {
      (ONESHOT[p.name] ?? ONESHOT.hurt)(out, Math.min(1, p.t / p.duration), legRatio);
    } else if (p.kind === 'move') {
      const s = Math.min(1.4, this.moveSpeed);
      this.stride += dt * (5.5 + 5.5 * s);
      const ph = this.stride;
      const amp = 0.35 + 0.6 * s;
      const sw = Math.sin(ph);
      const cw = Math.cos(ph);
      addKP(out, {
        thighL: [-sw * amp - 0.12, 0, 0.05], shinL: [Math.max(0, cw) * 1.25 * amp + 0.18, 0, 0],
        thighR: [sw * amp - 0.12, 0, -0.05], shinR: [Math.max(0, -cw) * 1.25 * amp + 0.18, 0, 0],
        armL: [sw * 0.75 * amp, 0, 0.14], foreL: [-0.85, 0, 0],
        armR: [-sw * 0.45 * amp - 0.3, 0, -0.14], foreR: [-0.95, 0, 0],
        spine: [0.1 + 0.12 * s, sw * 0.1, 0], chest: [0.08 + 0.1 * s, -sw * 0.22, 0], hips: [0, sw * 0.16, 0],
        hipsY: -0.03 + Math.abs(cw) * 0.022,
      });
    } else {
      addKP(out, STANCE);
      const b = Math.sin(this.clock * 2.1);
      out[JI.chest * 3] += b * 0.03;
      out[JI.armL * 3] += b * 0.03;
      out[JI.armR * 3] += b * 0.02;
      out[HIPS_Y] += b * 0.004;
    }
    this.fade = Math.min(this.fadeDur, this.fade + dt);
    const w = ease.inOut(this.fade / this.fadeDur);
    for (let i = 0; i < N; i++) this.cur[i] = lerp(this.from[i], out[i], w);
    for (const j of JOINTS) {
      const i = JI[j] * 3;
      this.nodes[j].rotation.set(this.cur[i], this.cur[i + 1], this.cur[i + 2]);
    }
    this.nodes.body.position.y = this.hipY + this.cur[HIPS_Y] * this.height;
    this.lift.position.y = this.cur[LIFT] * this.height;

    if (this.tintAmount > 0) {
      this.tintAmount = Math.max(0, this.tintAmount - dt * 3.5);
      for (const m of this.mats) {
        m.emissive.copy(m.userData.baseEmissive).lerp(this.tintColor, Math.min(1, this.tintAmount));
        m.emissiveIntensity = lerp(m.userData.baseEmissiveIntensity, 1.6, Math.min(1, this.tintAmount));
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

const geo = {
  sphere: (r: number, w = 14, h = 10) => new THREE.SphereGeometry(r, w, h),
  box: (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z),
  cyl: (r0: number, r1: number, h: number, seg = 10, open = false) => new THREE.CylinderGeometry(r0, r1, h, seg, 1, open),
  cone: (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg),
  torus: (r: number, t: number, arc = TAU) => new THREE.TorusGeometry(r, t, 8, 24, arc),
};

/** Shared body: torso, head, limbs. Returns the materials so each Knight can add their details. */
function baseBody(m: Mannequin, c: { skin: number; top: number; legs: number; arms: number; hands: number; boots: number; hair: number }) {
  const d = m.dims;
  const s = m.spec;
  const skin = m.mat(c.skin);
  const top = m.mat(c.top);
  const legs = m.mat(c.legs);
  const arms = m.mat(c.arms);
  const hands = m.mat(c.hands);
  const boots = m.mat(c.boots);
  const hair = m.mat(c.hair, { roughness: 0.5 });
  // Torso
  m.add('hips', geo.cyl(s.torso * 0.92, s.torso * 0.8, d.H * 0.1, 10), legs, 0, -d.H * 0.02, 0);
  m.add('spine', geo.cyl(s.torso * 0.86, s.torso * 0.9, d.spine * 1.1, 10), top, 0, d.spine * 0.5, 0);
  const chest = m.add('chest', geo.cyl(s.shoulder * 0.98, s.torso * 0.88, d.chest, 10), top, 0, d.chest * 0.5, 0);
  chest.scale.z = 0.72;
  m.add('chest', geo.cyl(d.headR * 0.36, d.headR * 0.42, d.torso * 0.08, 8), skin, 0, d.chest + d.torso * 0.02, 0);
  // Head and face
  m.add('head', geo.sphere(d.headR), skin, 0, d.headR * 0.85, 0);
  const eye = m.mat(0x16131c, { roughness: 0.3 });
  for (const sx of [1, -1]) m.add('head', geo.sphere(d.headR * 0.11, 8, 6), eye, sx * d.headR * 0.36, d.headR * 0.88, d.headR * 0.9);
  // Limbs
  for (const sd of ['L', 'R'] as const) {
    m.limb(`arm${sd}`, d.upper, s.limb * 1.05, s.limb * 0.9, arms);
    m.add(`arm${sd}`, geo.sphere(s.limb * 1.2, 10, 8), arms);
    m.limb(`fore${sd}`, d.fore, s.limb * 0.88, s.limb * 0.72, arms);
    m.add(`hand${sd}`, geo.sphere(s.limb * 0.95, 8, 6), hands);
    m.limb(`thigh${sd}`, d.thigh, s.limb * 1.5, s.limb * 1.15, legs);
    m.limb(`shin${sd}`, d.shin, s.limb * 1.12, s.limb * 0.85, boots);
    m.add(`foot${sd}`, geo.box(s.limb * 2.0, d.H * 0.04, s.limb * 3.6), boots, 0, -d.H * 0.012, s.limb * 0.9);
  }
  return { skin, top, legs, arms, hands, boots, hair, d };
}

function buildSigmund(): Mannequin {
  const m = new Mannequin({ height: 2.15, legRatio: 0.47, shoulder: 0.44, hip: 0.19, limb: 0.105, torso: 0.3 });
  const armor = 0x24212f;
  const { d, hair } = baseBody(m, { skin: 0x8d93a3, top: armor, legs: 0x1b1922, arms: armor, hands: 0x15131a, boots: armor, hair: 0xb0122b });
  const plate = m.mat(0x2d2a3b, { roughness: 0.35, metalness: 0.75 });
  const trim = m.mat(0x7a1830, { roughness: 0.5, metalness: 0.4, emissive: 0x3a0612, emissiveIntensity: 0.6 });
  // Breastplate, pauldrons with spikes, tassets
  const bp = m.add('chest', geo.box(0.86, d.chest * 1.05, 0.5), plate, 0, d.chest * 0.52, 0.02);
  bp.rotation.y = Math.PI / 4 * 0;
  m.add('chest', geo.box(0.5, 0.06, 0.53), trim, 0, d.chest * 0.55, 0.02);
  for (const sx of [1, -1]) {
    const p = m.add('chest', geo.sphere(0.27, 8, 6), plate, sx * 0.5, d.chest * 0.95, 0);
    p.scale.set(1.15, 0.8, 1.1);
    const spike = m.add('chest', geo.cone(0.09, 0.34, 5), plate, sx * 0.66, d.chest * 1.06, 0);
    spike.rotation.z = -sx * 0.9;
    m.add('hips', geo.box(0.24, 0.42, 0.1), plate, sx * 0.2, -0.26, 0.2).rotation.x = -0.12;
    m.add(`fore${sx > 0 ? 'L' : 'R'}`, geo.cyl(0.135, 0.11, d.fore * 0.75, 6), plate, 0, -d.fore * 0.5, 0);
    m.add(`shin${sx > 0 ? 'L' : 'R'}`, geo.cyl(0.15, 0.12, d.shin * 0.8, 6), plate, 0, -d.shin * 0.45, 0.01);
  }
  m.add('hips', geo.cyl(0.35, 0.37, 0.12, 10), trim, 0, 0.02, 0);
  // Hair swept back, beard
  const h = m.add('head', geo.sphere(d.headR * 1.04, 10, 8), hair, 0, d.headR * 1.02, -d.headR * 0.14);
  h.scale.set(0.98, 0.86, 1.08);
  m.add('head', geo.cone(d.headR * 0.42, d.headR * 0.7, 5), hair, 0, d.headR * 1.55, -d.headR * 0.5).rotation.x = -1.0;
  m.add('head', geo.box(d.headR * 0.7, d.headR * 0.3, d.headR * 0.3), hair, 0, d.headR * 0.2, d.headR * 0.72);
  // Tattered cape
  const cape = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 1.5, 4, 1),
    m.mat(0x3a1220, { side: THREE.DoubleSide, roughness: 0.9 }),
  );
  cape.position.set(0, d.chest * 0.9 - 0.75, -0.3);
  cape.rotation.x = 0.16;
  cape.castShadow = true;
  m.nodes.chest.add(cape);
  // Greatsword: continues the line of the forearm so swings read at a distance
  const sword = new THREE.Group();
  const steel = m.mat(0x30303f, { roughness: 0.3, metalness: 0.85 });
  const rune = m.mat(0x000000, { emissive: 0xff2244, emissiveIntensity: 2.2 });
  const blade = new THREE.Mesh(geo.box(0.34, 1.95, 0.07), steel);
  blade.position.y = 1.2;
  const tip = new THREE.Mesh(geo.cone(0.24, 0.34, 4), steel);
  tip.position.y = 2.33;
  tip.scale.z = 0.22;
  tip.rotation.y = Math.PI / 4;
  const guard = new THREE.Mesh(geo.box(0.62, 0.09, 0.12), steel);
  guard.position.y = 0.2;
  const grip = new THREE.Mesh(geo.cyl(0.04, 0.04, 0.5, 6), m.mat(0x3b2420));
  grip.position.y = -0.05;
  const runes = new THREE.Mesh(geo.box(0.05, 1.3, 0.085), rune);
  runes.position.y = 1.05;
  sword.add(blade, tip, guard, grip, runes);
  sword.traverse((o) => (o.castShadow = true));
  sword.rotation.x = Math.PI + 0.12;
  m.nodes.handR.add(sword);
  m.castNode.position.set(0, -1.9, 0);
  return m;
}

function buildSymbeline(): Mannequin {
  const m = new Mannequin({ height: 1.78, legRatio: 0.5, shoulder: 0.2, hip: 0.1, limb: 0.055, torso: 0.15 });
  const skinC = 0xc98b5e;
  const { d, hair } = baseBody(m, { skin: skinC, top: skinC, legs: skinC, arms: skinC, hands: skinC, boots: skinC, hair: 0xf2c230 });
  const red = m.mat(0xc0141f, { side: THREE.DoubleSide, roughness: 0.6 });
  const gold = m.mat(0xe7b93a, { roughness: 0.3, metalness: 0.8, emissive: 0x6a4a00, emissiveIntensity: 0.5 });
  // Crop top, split skirt, sash
  const topMesh = m.add('chest', geo.cyl(0.2, 0.16, d.chest * 0.62, 10), red, 0, d.chest * 0.62, 0);
  topMesh.scale.z = 0.76;
  m.add('hips', new THREE.CylinderGeometry(0.17, 0.5, d.legLen * 0.82, 14, 1, true, 0.75, TAU - 0.9), red, 0, -d.legLen * 0.4, 0);
  m.add('hips', geo.torus(0.175, 0.03), gold, 0, 0.0, 0).rotation.x = Math.PI / 2;
  m.add('chest', geo.torus(0.085, 0.016), gold, 0, d.chest + 0.03, 0).rotation.x = Math.PI / 2;
  for (const sd of ['L', 'R'] as const) {
    m.add(`arm${sd}`, geo.cyl(0.066, 0.066, 0.07, 8), gold, 0, -d.upper * 0.35, 0);
    m.add(`fore${sd}`, geo.cyl(0.056, 0.05, 0.08, 8), gold, 0, -d.fore * 0.85, 0);
    m.add(`shin${sd}`, geo.cyl(0.062, 0.056, 0.06, 8), gold, 0, -d.shin * 0.85, 0);
    // Scarf streamers trailing from the upper arms
    const st2 = m.add(`arm${sd}`, geo.box(0.14, 0.75, 0.02), red, 0, -d.upper * 0.45 - 0.33, -0.08);
    st2.rotation.x = 0.25;
  }
  // Long golden hair and tall ears
  const cap = m.add('head', geo.sphere(d.headR * 1.06, 12, 8), hair, 0, d.headR * 0.98, -d.headR * 0.12);
  cap.scale.set(1, 0.95, 1.05);
  const mane = m.add('head', new THREE.CapsuleGeometry(d.headR * 0.95, 0.72, 4, 10), hair, 0, -0.12, -d.headR * 0.62);
  mane.scale.set(1.15, 1, 0.5);
  for (const sx of [1, -1]) {
    const ear = m.add('head', geo.cone(0.05, 0.4, 6), hair, sx * d.headR * 0.42, d.headR * 1.9 + 0.12, -d.headR * 0.1);
    ear.rotation.z = -sx * 0.14;
  }
  // Chakrams
  for (const sd of ['L', 'R'] as const) {
    const ring = m.add(`hand${sd}`, geo.torus(0.27, 0.024), gold, 0, -0.25, 0.02);
    ring.rotation.y = Math.PI / 2;
    ring.userData.chakram = true;
  }
  m.castNode.position.set(0, -0.3, 0);
  return m;
}

function buildDeux(): Mannequin {
  const m = new Mannequin({ height: 1.02, legRatio: 0.34, shoulder: 0.15, hip: 0.07, limb: 0.045, torso: 0.13 });
  const coat = 0x18181e;
  const { d, hair } = baseBody(m, { skin: 0xb5764a, top: coat, legs: coat, arms: coat, hands: 0x101014, boots: 0x101014, hair: 0xf3f3f6 });
  const red = m.mat(0xa11d2a, { roughness: 0.6 });
  const white = m.mat(0xeeeeee);
  const gold = m.mat(0xc9a24a, { roughness: 0.35, metalness: 0.7 });
  const horn = m.mat(0x121016, { roughness: 0.35 });
  // Long coat, white front panel, red sash and mantle
  m.add('hips', geo.cyl(0.14, 0.25, d.legLen * 0.86, 10, true), m.mat(coat, { side: THREE.DoubleSide }), 0, -d.legLen * 0.4, 0);
  m.add('chest', geo.box(0.1, d.chest * 0.9, 0.02), white, 0, d.chest * 0.5, d.chest * 0.36);
  m.add('hips', geo.torus(0.145, 0.03), red, 0, 0.02, 0).rotation.x = Math.PI / 2;
  m.add('hips', geo.box(0.07, 0.24, 0.02), red, 0.07, -0.12, 0.15);
  const mantle = m.add('chest', geo.cyl(0.1, 0.23, d.chest * 0.5, 8), red, 0, d.chest * 0.82, 0);
  mantle.scale.z = 0.8;
  m.add('chest', geo.torus(0.105, 0.018), gold, 0, d.chest * 1.06, 0).rotation.x = Math.PI / 2;
  // Spiky white hair
  const cap = m.add('head', geo.sphere(d.headR * 1.07, 12, 8), hair, 0, d.headR * 1.0, -d.headR * 0.1);
  cap.scale.set(1.02, 0.92, 1.04);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    const sp = m.add('head', geo.cone(d.headR * 0.3, d.headR * 0.7, 5), hair, Math.sin(a) * d.headR * 0.75, d.headR * 1.5, Math.cos(a) * d.headR * 0.7 - d.headR * 0.1);
    sp.rotation.set(Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9);
  }
  // Twisted horns
  for (const sx of [1, -1]) {
    const h = m.add('head', geo.torus(d.headR * 0.5, d.headR * 0.16, Math.PI * 1.15), horn, sx * d.headR * 1.02, d.headR * 1.55, -d.headR * 0.05);
    h.rotation.set(0, sx > 0 ? 0 : Math.PI, 0.5);
    // Pointed ears
    const ear = m.add('head', geo.cone(d.headR * 0.16, d.headR * 0.6, 5), m.mat(0xb5764a), sx * d.headR * 1.1, d.headR * 0.85, 0);
    ear.rotation.z = -sx * 1.75;
  }
  // The X across his face, and violet eyes
  const ink = m.mat(0x0c0a0f);
  for (const r of [0.75, -0.75]) {
    const bar = m.add('head', geo.box(d.headR * 1.25, d.headR * 0.13, 0.012), ink, 0, d.headR * 0.82, d.headR * 0.99);
    bar.rotation.z = r;
  }
  const iris = m.mat(0x000000, { emissive: 0xa35cff, emissiveIntensity: 2.4 });
  for (const sx of [1, -1]) m.add('head', geo.sphere(d.headR * 0.09, 8, 6), iris, sx * d.headR * 0.38, d.headR * 0.9, d.headR * 0.95);
  // Black staff with a red orb
  const staff = new THREE.Group();
  const shaft = new THREE.Mesh(geo.cyl(0.022, 0.03, 0.95, 6), horn);
  shaft.position.y = 0.2;
  const curl = new THREE.Mesh(geo.torus(0.1, 0.024, Math.PI * 1.5), horn);
  curl.position.set(0.1, 0.68, 0);
  const orb = new THREE.Mesh(geo.sphere(0.06, 12, 8), m.mat(0x200000, { emissive: 0xff2030, emissiveIntensity: 3 }));
  orb.position.set(0.1, 0.68, 0);
  staff.add(shaft, curl, orb);
  staff.traverse((o) => (o.castShadow = true));
  staff.rotation.x = 1.3;
  m.nodes.handR.add(staff);
  m.castNode.position.copy(orb.position).applyEuler(staff.rotation);
  return m;
}

function buildGhalus(): Mannequin {
  const m = new Mannequin({ height: 1.74, legRatio: 0.48, shoulder: 0.22, hip: 0.1, limb: 0.06, torso: 0.17 });
  const robe = 0xf0eee8;
  const { d, hair } = baseBody(m, { skin: 0xe6b89a, top: robe, legs: 0x8d8a84, arms: robe, hands: 0xe6b89a, boots: 0x5a3b28, hair: 0xf6f6f8 });
  const white = m.mat(robe, { side: THREE.DoubleSide });
  const red = m.mat(0xb3261e, { roughness: 0.6 });
  const wood = m.mat(0x6b4a2e, { roughness: 0.85 });
  // Long robe with a red hem, capelet and hood
  m.add('hips', geo.cyl(0.19, 0.44, d.legLen * 0.93, 14, true), white, 0, -d.legLen * 0.46, 0);
  m.add('hips', geo.torus(0.44, 0.03), red, 0, -d.legLen * 0.92, 0).rotation.x = Math.PI / 2;
  m.add('hips', geo.box(0.05, d.legLen * 0.9, 0.02), red, 0, -d.legLen * 0.46, 0.31).rotation.x = -0.27;
  const cape = m.add('chest', geo.cyl(0.13, 0.4, d.chest * 0.8, 12), white, 0, d.chest * 0.72, 0);
  cape.scale.z = 0.82;
  m.add('chest', geo.torus(0.39, 0.022), red, 0, d.chest * 0.34, 0).scale.set(1, 0.82, 1);
  m.nodes.chest.children[m.nodes.chest.children.length - 1].rotation.x = Math.PI / 2;
  const hood = m.add('chest', geo.sphere(0.17, 10, 8), white, 0, d.chest * 1.0, -0.13);
  hood.scale.set(1.1, 0.8, 0.9);
  // Wide sleeves
  for (const sd of ['L', 'R'] as const) {
    m.add(`fore${sd}`, geo.cyl(0.07, 0.15, d.fore * 0.95, 8, true), white, 0, -d.fore * 0.5, 0);
    m.add(`fore${sd}`, geo.torus(0.15, 0.016), red, 0, -d.fore * 0.96, 0).rotation.x = Math.PI / 2;
  }
  // Hair, cat ears, glasses, goatee
  const cap = m.add('head', geo.sphere(d.headR * 1.07, 12, 8), hair, 0, d.headR * 1.0, -d.headR * 0.12);
  cap.scale.set(1.02, 0.92, 1.05);
  for (const sx of [1, -1]) {
    const ear = m.add('head', geo.cone(d.headR * 0.36, d.headR * 0.7, 4), hair, sx * d.headR * 0.62, d.headR * 1.95, -d.headR * 0.05);
    ear.rotation.z = -sx * 0.35;
    const lens = m.add('head', geo.torus(d.headR * 0.23, 0.008), m.mat(0x6a5a3a, { metalness: 0.8, roughness: 0.3 }), sx * d.headR * 0.36, d.headR * 0.88, d.headR * 0.98);
    lens.rotation.y = sx * 0.2;
  }
  m.add('head', geo.cone(d.headR * 0.16, d.headR * 0.3, 5), hair, 0, d.headR * 0.02, d.headR * 0.62).rotation.x = Math.PI;
  // Tail: a chain of segments curling up behind
  let parent: THREE.Object3D = m.nodes.hips;
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, i === 0 ? -0.05 : -0.17, i === 0 ? -0.16 : 0);
    seg.rotation.x = i === 0 ? 1.0 : 0.42;
    parent.add(seg);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.05 + i * 0.008, 0.14, 3, 8), hair);
    mesh.position.y = -0.09;
    mesh.castShadow = true;
    seg.add(mesh);
    parent = seg;
  }
  // Wooden staff with a spiral head
  const staff = new THREE.Group();
  const shaft = new THREE.Mesh(geo.cyl(0.028, 0.034, 1.75, 6), wood);
  shaft.position.y = 0.3;
  const knob = new THREE.Mesh(geo.torus(0.11, 0.035, Math.PI * 1.7), wood);
  knob.position.y = 1.25;
  const light = new THREE.Mesh(geo.sphere(0.05, 10, 8), m.mat(0x333322, { emissive: 0xfff0a8, emissiveIntensity: 2.6 }));
  light.position.y = 1.25;
  staff.add(shaft, knob, light);
  staff.traverse((o) => (o.castShadow = true));
  staff.rotation.x = 1.3;
  m.nodes.handR.add(staff);
  m.castNode.position.copy(light.position).applyEuler(staff.rotation);
  return m;
}

export function buildMannequin(id: CharId): Mannequin {
  switch (id) {
    case 'sigmund':
      return buildSigmund();
    case 'symbeline':
      return buildSymbeline();
    case 'deux':
      return buildDeux();
    case 'ghalus':
      return buildGhalus();
  }
}
