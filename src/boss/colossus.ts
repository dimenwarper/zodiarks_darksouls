import * as THREE from 'three';
import {
  TAU, clamp, damp, dampFactor, distXZ, ease, lerp, localToWorld, moveAngle, angleDiff, pickWeighted,
  rand, randSign, remap, tween, twoBoneIK, wait, yawForward, yawLeft, yawOf, type Script,
} from '../core/math';
import type { Telegraph } from '../core/fx';
import type { World } from '../types';
import { ARENA_RADIUS } from '../world/arena';
import { Props, type FitOpts } from '../world/props';
import { ribbon, ringStroke, ruleStroke, runeBand, runeLine, signStrokes, starStroke, type RibbonOpts, type Stroke } from '../core/seal';

export const BOSS_NAME = 'Ophiuchus';
export const BOSS_TITLE = 'The Exiled Sign';

/** Skeleton dimensions in metres. The colossus stands about twenty metres tall. */
const D = {
  pelvisY: 9.3,
  hipX: 2.3,
  hipDrop: 0.5,
  thigh: 4.6,
  shin: 4.5,
  ankle: 1.1,
  footX: 3.0,
  chestY: 3.5,
  shoulderX: 4.7,
  shoulderY: 3.1,
  upper: 5.1,
  fore: 5.3,
  headY: 5.4,
};
const CORE_LOCAL = new THREE.Vector3(0, 1.4, 3.1);

/**
 * Where each generated piece sits. Limb plates are modelled standing the way they hang
 * (shoulder or hip end up), while a bone's own +y runs away from the body, so they are
 * turned over to lie along it.
 */
const ALONG_BONE: [number, number, number] = [0, 0, 180];
const SKIN: Record<string, Skin> = {
  pelvis: {},
  vertebra: {},
  tasset: {},
  chest: {},
  pauldron: {},
  wing: {},
  helm: {},
  arm: { turn: ALONG_BONE },
  forearm: { turn: ALONG_BONE },
  fist: { turn: [-90, 0, 0] },
  thigh: { turn: ALONG_BONE },
  shin: { turn: ALONG_BONE },
  foot: {},
};
const HAND_REST = new THREE.Vector3(6.0, -6.2, 1.6);

export const BOSS_TUNING = {
  hp: 10500,
  posture: 300,
  postureDecay: 5,
  postureDecayDelay: 4,
  postureGrowth: 1.2,
  staggerWindow: 7.5,
  phase2At: 0.55,
  walkSpeed: 3.2,
  turnRate: 0.7,
  /** Global multiplier on idle gaps between attacks; lower is more aggressive. */
  tempo: 1,
  damage: 0.85,
};

export interface BossPart {
  id: string;
  label: string;
  pos: THREE.Vector3;
  r: number;
  mult: number;
  /** Posture damage multiplier. */
  stag: number;
  weak: boolean;
  armor: boolean;
  lockable: boolean;
}

/** How a generated armour piece sits in the place of the procedural shape it replaces. */
interface Skin extends FitOpts {
  /** Size to fill, when it should differ from the procedural shape's own box. */
  box?: [number, number, number];
  /** Offset from that shape's centre. */
  offset?: [number, number, number];
}

/**
 * Starlight on the generated plates, shared by all of them: the rim of every plate and its
 * silver inlay take the boss's glow colour, which is how its wind-ups read from a distance.
 */
const ARMOR_GLOW = { uGlow: { value: new THREE.Color() }, uFlash: { value: 0 }, uLift: { value: 0.1 }, uRim: { value: 0.35 }, uInlay: { value: 0.5 }, uGlyph: { value: 1.25 } };
const armorSkins = new Map<THREE.Material, THREE.Material>();
function armorSkin(src: THREE.MeshStandardMaterial): THREE.Material {
  let m = armorSkins.get(src);
  if (!m) {
    const skin = src.clone();
    // No environment map here, so a fully metallic plate would be a black mirror of nothing.
    skin.metalness = 0.45;
    skin.roughness = 0.75;
    // Obsidian: the plates stay dark beside the core's glare, and their inlay does the shining.
    skin.color.setScalar(0.5);
    skin.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, ARMOR_GLOW);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uGlow;\nuniform float uFlash;\nuniform float uLift;\nuniform float uRim;\nuniform float uInlay;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float rim = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 3.2);
            float inlay = smoothstep(0.1, 0.26, dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1)));
            totalEmissiveRadiance += uGlow * (rim * uRim + inlay * uInlay) + diffuseColor.rgb * uLift + vec3(1.0, 0.92, 0.85) * uFlash;
          }`);
    };
    m = skin;
    armorSkins.set(src, m);
  }
  return m;
}
export const BOSS_LOOK = ARMOR_GLOW;

interface Foot {
  pos: THREE.Vector3;
  yaw: number;
  stepping: boolean;
  /** A script is driving this foot (stomps). */
  locked: boolean;
  t: number;
  dur: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromYaw: number;
  toYaw: number;
  mesh: THREE.Object3D;
  side: 1 | -1;
}

type State = 'dormant' | 'intro' | 'fight' | 'staggered' | 'transition' | 'dying' | 'dead';

/** Waking: how long the star in its chest takes to catch, and how long it takes to stand. */
export const BOSS_WAKE = { ignite: 2.2, rise: 2.5 };

interface Limb {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  end: THREE.Object3D;
  tetherA: THREE.Mesh;
  tetherB: THREE.Mesh;
  orbs: THREE.Mesh[];
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

const COOL = new THREE.Color(0.32, 0.62, 1.7);
const HOT = new THREE.Color(2.1, 0.34, 0.2);

/**
 * A colossus of floating obsidian plates held together by starlight. Because the plates
 * are rigid and unattached it needs no skinned mesh: every limb is solved with IK each
 * frame and the plates are simply placed along the bones, so fists land exactly where
 * the attack says they will.
 */
export class Colossus {
  group = new THREE.Group();
  pos = new THREE.Vector3(0, 0, 0);
  yaw = 0;
  hp = BOSS_TUNING.hp;
  maxHp = BOSS_TUNING.hp;
  posture = 0;
  postureMax = BOSS_TUNING.posture;
  phase: 1 | 2 = 1;
  state: State = 'dormant';
  invulnerable = false;
  /** Seconds left of the staggered window; the game can hold it open during the All-Out Attack. */
  staggerWindow = 0;
  staggerHold = false;
  /** Frozen for cinematics: the pose is kept, nothing advances. */
  freeze = false;
  parts: BossPart[] = [];
  lastAttack = '';
  /** For the debug panel: force the next attack by name. */
  forceAttack: string | null = null;

  private script: Script | null = null;
  private pendingPhase2 = false;
  private postureTimer = 0;
  private time = 0;
  private delayed: { t: number; fn: () => void }[] = [];
  private teles: Telegraph[] = [];
  private ownHazards: { life: number }[] = [];

  private ctl = {
    lean: 1.15, twist: 0, crouch: 5.3, shift: -1,
    hand: [new THREE.Vector3(), new THREE.Vector3()],
    handFree: [true, true],
    stiff: [4, 4],
    bodyStiff: 3.5,
    glow: 0,
    wings: 0,
    headLook: true,
  };
  private cur = {
    lean: 1.15, twist: 0, crouch: 5.3, shift: -1,
    hand: [new THREE.Vector3(), new THREE.Vector3()],
    glow: 0,
    wings: 0,
  };
  private stepCooldown = 0;
  private flash = 0;
  private moveVel = new THREE.Vector3();

  // Skeleton
  private pelvisNode = new THREE.Group();
  private chestNode = new THREE.Group();
  private headNode = new THREE.Group();
  private feet: Foot[] = [];
  private shoulder = [new THREE.Vector3(), new THREE.Vector3()];
  elbow = [new THREE.Vector3(), new THREE.Vector3()];
  /** Actual fist positions after IK. */
  handPos = [new THREE.Vector3(), new THREE.Vector3()];
  private hip = [new THREE.Vector3(), new THREE.Vector3()];
  private knee = [new THREE.Vector3(), new THREE.Vector3()];
  private ankle = [new THREE.Vector3(), new THREE.Vector3()];
  private armNormal = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)];
  private legNormal = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)];
  corePos = new THREE.Vector3();
  headPos = new THREE.Vector3();

  // Visuals
  private armorMat = new THREE.MeshStandardMaterial({ color: 0x0d0f1c, roughness: 0.36, metalness: 0.85, flatShading: true });
  private lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private redMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.3, 0.2) });
  /** Everything written in light about it: the belt of signs, the sigils, the rune bands. */
  private glyphMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  private glyphs: THREE.Object3D[] = [];
  private belt = new THREE.Group();
  private beltSpin = new THREE.Group();
  private sigils: { obj: THREE.Object3D; phase: number; rate: number; height: number; reach: number }[] = [];
  private bands: THREE.Object3D[] = [];
  private haloRunes!: THREE.Object3D;
  private pieces: THREE.Object3D[] = [];
  private segs: Limb[] = [];
  private core!: THREE.Mesh;
  private coreGlow!: THREE.Sprite;
  private coreLight!: THREE.PointLight;
  private halo!: THREE.Group;
  private wings: THREE.Object3D[] = [];
  private serpent!: THREE.InstancedMesh;
  private beamMesh!: THREE.Mesh;
  private beamOn = false;
  private beamTo = new THREE.Vector3();
  private debris: { mesh: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; size: number }[] | null = null;
  private glowColor = new THREE.Color();
  private hue = 0;

  constructor(private world: World) {
    world.scene.add(this.group);
    this.build();
    this.definePart('ankleL', 'Left Ankle', 2.2, 1.0, 1.35, false, false, true);
    this.definePart('ankleR', 'Right Ankle', 2.2, 1.0, 1.35, false, false, true);
    this.definePart('core', 'Star Core', 1.8, 2.0, 1.2, true, false, true);
    this.definePart('head', 'Crown', 2.3, 1.5, 1.6, true, false, true);
    this.definePart('handL', 'Left Fist', 2.1, 1.2, 1.0, false, false, true);
    this.definePart('handR', 'Right Fist', 2.1, 1.2, 1.0, false, false, true);
    this.definePart('chest', 'Carapace', 4.0, 0.55, 0.5, false, true, false);
    this.definePart('pelvis', 'Carapace', 3.0, 0.6, 0.5, false, true, false);
    this.definePart('kneeL', 'Greave', 1.7, 0.7, 0.8, false, true, false);
    this.definePart('kneeR', 'Greave', 1.7, 0.7, 0.8, false, true, false);
    // Start kneeling and dark at the centre of the wheel.
    for (const f of this.feet) {
      localToWorld(this.pos, this.yaw, f.side * D.footX, 0, 0, f.pos);
      f.yaw = this.yaw;
    }
    this.setKneelTargets();
    this.cur.hand[0].copy(this.ctl.hand[0]);
    this.cur.hand[1].copy(this.ctl.hand[1]);
    this.solve(0);
    this.cur.hand[0].copy(this.ctl.hand[0]);
    this.cur.hand[1].copy(this.ctl.hand[1]);
    this.solve(0);
    this.applyGlow(0);
  }

  // ---------------------------------------------------------------- construction

  private definePart(id: string, label: string, r: number, mult: number, stag: number, weak: boolean, armor: boolean, lockable: boolean) {
    this.parts.push({ id, label, pos: new THREE.Vector3(), r, mult, stag, weak, armor, lockable });
  }

  part(id: string) {
    return this.parts.find((p) => p.id === id)!;
  }

  /**
   * One plate of the body. With a generated model on disk the plate wears it, sized to the
   * procedural shape it replaces; otherwise it is that shape, faceted, with glowing edges.
   */
  private piece(geo: THREE.BufferGeometry, parent: THREE.Object3D, x = 0, y = 0, z = 0, model?: string, skin: Skin = {}): THREE.Object3D {
    let obj: THREE.Object3D | null = model ? this.skinned(geo, model, skin) : null;
    if (obj) geo.dispose();
    else {
      const mesh = new THREE.Mesh(geo, this.armorMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 22), this.lineMat));
      obj = mesh;
    }
    obj.position.set(x, y, z);
    parent.add(obj);
    this.pieces.push(obj);
    return obj;
  }

  private skinned(geo: THREE.BufferGeometry, model: string, skin: Skin): THREE.Object3D | null {
    geo.computeBoundingBox();
    const size = geo.boundingBox!.getSize(new THREE.Vector3());
    const centre = geo.boundingBox!.getCenter(new THREE.Vector3());
    if (skin.box) size.fromArray(skin.box);
    if (skin.offset) centre.add(_a.fromArray(skin.offset));
    const node = this.world.props.fit(model, size.x, size.y, size.z, skin);
    if (!node) return null;
    Props.materials(node, armorSkin);
    node.position.copy(centre);
    const holder = new THREE.Group();
    holder.add(node);
    return holder;
  }

  private orb(parent: THREE.Object3D, r: number, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), this.glowMat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  private build() {
    const g = this.group;
    g.add(this.pelvisNode);
    this.pelvisNode.add(this.chestNode);
    this.chestNode.position.y = D.chestY;
    this.chestNode.add(this.headNode);
    this.headNode.position.set(0, D.headY, 0.3);

    // Pelvis and floating vertebrae
    const props = this.world.props;
    this.piece(new THREE.CylinderGeometry(2.7, 1.9, 2.6, 6), this.pelvisNode, 0, -0.2, 0, 'boss_pelvis', SKIN.pelvis);
    for (const sx of [1, -1]) {
      const tasset = this.piece(new THREE.BoxGeometry(1.5, 3.0, 0.5), this.pelvisNode, sx * 2.5, -1.6, 0.9, 'boss_tasset', { ...SKIN.tasset, mirror: sx < 0 });
      tasset.rotation.set(-0.15, 0, sx * 0.22);
    }
    this.piece(new THREE.CylinderGeometry(1.5, 1.7, 0.9, 6), this.pelvisNode, 0, 1.7, 0, 'boss_pelvis', SKIN.vertebra).rotation.y = 0.5;
    this.piece(new THREE.CylinderGeometry(1.7, 1.5, 0.9, 6), this.pelvisNode, 0, 2.8, 0, 'boss_pelvis', SKIN.vertebra);
    this.orb(this.pelvisNode, 0.7, 0, 2.25, 0);

    // Chest: a faceted carapace open at the front, where the core floats between rib prongs
    const chest = this.piece(new THREE.CylinderGeometry(4.3, 2.6, 4.4, 6), this.chestNode, 0, 2.2, -0.5, 'boss_chest', SKIN.chest);
    chest.scale.z = 0.72;
    for (const sx of [1, -1]) {
      const pauldron = this.piece(new THREE.DodecahedronGeometry(2.4, 0), this.chestNode, sx * 5.0, 3.7, 0, 'boss_pauldron', { ...SKIN.pauldron, mirror: sx < 0 });
      pauldron.scale.set(1.2, 0.85, 1.25);
      // The generated pauldron carries its own spike, and the generated carapace its own ribs and collar.
      if (!props.has('boss_pauldron')) {
        const spike = this.piece(new THREE.ConeGeometry(0.8, 3.4, 4), this.chestNode, sx * 6.6, 5.2, 0);
        spike.rotation.z = -sx * 0.75;
      }
      for (let i = 0; i < 3 && !props.has('boss_chest'); i++) {
        const rib = this.piece(new THREE.ConeGeometry(0.34, 2.6, 4), this.chestNode, sx * (2.5 - i * 0.2), 0.3 + i * 1.15, 2.2);
        rib.rotation.set(1.2, 0, sx * (1.0 - i * 0.1));
      }
    }
    if (!props.has('boss_chest')) this.piece(new THREE.TorusGeometry(2.0, 0.42, 5, 8), this.chestNode, 0, 4.5, 0).rotation.x = Math.PI / 2;

    // Core
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 0), this.coreMat);
    this.core.position.copy(CORE_LOCAL);
    this.chestNode.add(this.core);
    const cage = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1.9, 0)), this.lineMat);
    this.core.add(cage);
    this.coreGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.world.fx.glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.coreGlow.scale.setScalar(11);
    this.core.add(this.coreGlow);
    this.coreLight = new THREE.PointLight(0x6fa0ff, 0, 60, 1.6);
    this.core.add(this.coreLight);

    // Wings: shards hovering behind the shoulders that fan out in phase two
    for (let i = 0; i < 6; i++) {
      const sx = i < 3 ? 1 : -1;
      const k = i % 3;
      const shard = this.piece(new THREE.OctahedronGeometry(1, 0), this.chestNode, sx * (2.6 + k * 1.3), 3.4 + k * 0.4, -3.0, 'boss_wing', SKIN.wing);
      shard.scale.set(0.7, 3.6 + k * 1.3, 0.3);
      shard.userData = { sx, k };
      this.wings.push(shard);
    }

    // Head: a blind helm before a broken halo of thirteen studs
    const helm = this.piece(new THREE.IcosahedronGeometry(1.75, 0), this.headNode, 0, 0, 0, 'boss_helm', SKIN.helm);
    helm.scale.set(0.95, 1.18, 1.0);
    if (!props.has('boss_helm')) {
      this.piece(new THREE.ConeGeometry(0.9, 2.2, 4), this.headNode, 0, -1.4, 0.5).rotation.x = Math.PI;
      const visor = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.2, 0.3), this.glowMat);
      visor.position.set(0, 0.2, 1.5);
      this.headNode.add(visor);
    }
    this.halo = new THREE.Group();
    this.halo.position.set(0, 0.6, -1.5);
    this.headNode.add(this.halo);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.09, 6, 64, TAU * 0.93), this.glowMat);
    ring.rotation.z = Math.PI / 2 + TAU * 0.035;
    this.halo.add(ring);
    for (let i = 0; i < 13; i++) {
      const a = (i / 13) * TAU + Math.PI / 2;
      const last = i === 0;
      const stud = new THREE.Mesh(new THREE.OctahedronGeometry(last ? 0.5 : 0.28, 0), last ? this.redMat : this.glowMat);
      stud.position.set(Math.cos(a) * 3.1, Math.sin(a) * 3.1, 0);
      this.halo.add(stud);
    }

    // The serpent: a chain of stars coiled about the torso
    this.serpent = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.3, 0), this.glowMat, 46);
    this.serpent.frustumCulled = false;
    this.chestNode.add(this.serpent);

    // Limbs live in world space and are placed along the solved bones every frame.
    const seg = (len: number, r0: number, r1: number, model: string, skin: Skin) => this.piece(new THREE.CylinderGeometry(r1, r0, len, 6), g, 0, 0, 0, model, skin);
    const tether = () => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 1, 5), this.glowMat);
      g.add(m);
      return m;
    };
    for (let i = 0; i < 2; i++) {
      // Arms
      const mirror = i === 1;
      const fist = this.piece(new THREE.DodecahedronGeometry(1.8, 0), g, 0, 0, 0, 'boss_fist', { ...SKIN.fist, mirror });
      this.segs.push({
        upper: seg(D.upper - 1.2, 1.35, 1.0, 'boss_arm', { ...SKIN.arm, mirror }),
        lower: seg(D.fore - 1.0, 1.05, 1.5, 'boss_forearm', { ...SKIN.forearm, mirror }),
        end: fist,
        tetherA: tether(),
        tetherB: tether(),
        orbs: [this.orb(g, 0.75), this.orb(g, 0.65)],
      });
    }
    for (let i = 0; i < 2; i++) {
      // Legs
      const mirror = i === 1;
      const foot = this.piece(new THREE.BoxGeometry(2.7, 1.5, 4.8).translate(0, 0, 0.9), g, 0, 0, 0, 'boss_foot', { ...SKIN.foot, mirror });
      this.segs.push({
        upper: seg(D.thigh - 1.2, 1.35, 1.05, 'boss_thigh', { ...SKIN.thigh, mirror }),
        lower: seg(D.shin - 1.0, 1.2, 0.85, 'boss_shin', { ...SKIN.shin, mirror }),
        end: foot,
        tetherA: tether(),
        tetherB: tether(),
        orbs: [this.orb(g, 0.8), this.orb(g, 0.7)],
      });
      this.feet.push({
        pos: new THREE.Vector3(), yaw: 0, stepping: false, locked: false, t: 0, dur: 1,
        from: new THREE.Vector3(), to: new THREE.Vector3(), fromYaw: 0, toYaw: 0, mesh: foot, side: i === 0 ? 1 : -1,
      });
    }

    this.buildGlyphs();

    // Beam
    this.beamMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.7, 0.35), opacity: 0.8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.beamMesh.visible = false;
    this.beamMesh.renderOrder = 12;
    g.add(this.beamMesh);
  }

  /**
   * The ornaments of an exiled sign: the twelve it was cast out from turn about it on a
   * belt, its own seal circles it in three places, and runes ring its wrists, shins and halo.
   */
  private buildGlyphs() {
    const g = this.group;
    const written = (strokes: Stroke[], place: RibbonOpts['place']) => {
      const mesh = new THREE.Mesh(ribbon(strokes, { place }), this.glyphMat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      this.glyphs.push(mesh);
      return mesh;
    };
    // A strip written along x, wrapped round a band of radius r that opens upward by `flare`.
    const wrap = (r: number, flare = 0) => (x: number, y: number, out: THREE.Vector3) => {
      const rr = r - y * flare;
      out.set(Math.sin(x / r) * rr, -y, Math.cos(x / r) * rr);
    };
    const upright = (x: number, y: number, out: THREE.Vector3) => out.set(x, -y, 0);

    // The belt: twelve signs in their rings, a rune between each and the next.
    const R = 9.4;
    const L = TAU * R;
    const belt: Stroke[] = [ruleStroke(L, -1.4, 0.07, 144), ruleStroke(L, 1.4, 0.07, 144), ...runeLine(L, 0.95, 12, 13, 0.06)];
    for (let k = 0; k < 12; k++) {
      const x = (L * k) / 12;
      belt.push(ringStroke(1.0, 0.07, 40, x, 0), ...signStrokes(k, x, 0, 0.62, -Math.PI / 2, { width: 0.075 }));
    }
    this.beltSpin.add(written(belt, wrap(R, 0.4)));
    this.belt.add(this.beltSpin);
    g.add(this.belt);

    // Its own seal, three times over: the thirteen-point star about the thirteenth sign.
    const seal: Stroke[] = [
      ringStroke(1.9, 0.07, 64), ringStroke(1.62, 0.05, 64), starStroke(1.62, 13, 5, 0.05), ringStroke(0.8, 0.05, 40),
      ...signStrokes(12, 0, 0, 0.5, -Math.PI / 2, { width: 0.07 }),
    ];
    const sealGeo = ribbon(seal, { place: upright });
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(sealGeo, this.glyphMat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      this.glyphs.push(mesh);
      g.add(mesh);
      this.sigils.push({ obj: mesh, phase: (i / 3) * TAU + 0.6, rate: [0.21, -0.16, 0.27][i], height: [-6.5, 0.5, 6.5][i], reach: [12.5, 13.5, 11][i] });
    }

    // Bands of runes turning about its wrists and shins.
    this.segs.forEach((s, i) => {
      const arm = i < 2;
      const r = arm ? 2.2 : 1.95;
      const band = written([ruleStroke(TAU * r, -0.52, 0.055, 48), ruleStroke(TAU * r, 0.52, 0.055, 48), ...runeLine(TAU * r, 0.64, arm ? 13 : 11, 31 + i, 0.055)], wrap(r));
      band.position.y = arm ? 1.0 : 0.3;
      s.lower.add(band);
      this.bands.push(band);
    });

    // And a ring of them outside the halo, turning against it.
    this.haloRunes = written([...runeBand(3.85, 0.62, 22, 77, 0.05), ringStroke(4.3, 0.05, 72)], upright);
    this.haloRunes.position.copy(this.halo.position);
    this.headNode.add(this.haloRunes);
  }

  dispose() {
    this.cancelAttacks();
    this.world.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      // Generated plates share their geometry with the next colossus.
      if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
    });
  }

  // ---------------------------------------------------------------- helpers

  private get tempo() {
    return (this.phase === 2 ? 0.85 : 1) * BOSS_TUNING.tempo;
  }

  private local(x: number, y: number, z: number, out: THREE.Vector3) {
    return localToWorld(this.pos, this.yaw, x, y, z, out);
  }

  private setHand(i: number, x: number, y: number, z: number, stiff?: number) {
    this.ctl.handFree[i] = false;
    this.local(x, y, z, this.ctl.hand[i]);
    if (stiff !== undefined) this.ctl.stiff[i] = stiff;
  }

  private resetCtl() {
    const c = this.ctl;
    c.lean = 0.06;
    c.twist = 0;
    c.crouch = 0;
    c.shift = 0;
    c.handFree[0] = c.handFree[1] = true;
    c.stiff[0] = c.stiff[1] = 4;
    c.bodyStiff = 3.5;
    c.glow = 1;
    c.wings = this.phase === 2 ? 1 : 0;
    c.headLook = true;
    for (const f of this.feet) f.locked = false;
    this.beamOn = false;
  }

  private setKneelTargets() {
    const c = this.ctl;
    c.lean = 1.15;
    c.crouch = 5.3;
    c.shift = -1.2;
    c.twist = 0;
    this.setHand(0, 5.6, 1.7, 8.2, 5);
    this.setHand(1, -5.6, 1.7, 8.2, 5);
  }

  private faceToward(p: THREE.Vector3, rate: number, dt: number) {
    this.yaw = moveAngle(this.yaw, yawOf(p.x - this.pos.x, p.z - this.pos.z), rate * dt);
  }

  private walkToward(p: THREE.Vector3, speed: number, dt: number) {
    _a.set(p.x - this.pos.x, 0, p.z - this.pos.z);
    const d = _a.length();
    if (d < 0.01) return;
    _a.divideScalar(d);
    // Only stride forward once roughly facing the target.
    const facing = Math.max(0, _a.dot(yawForward(this.yaw, _b)));
    this.moveVel.copy(_a).multiplyScalar(speed * facing);
    this.pos.addScaledVector(this.moveVel, dt);
    const r = Math.hypot(this.pos.x, this.pos.z);
    const max = ARENA_RADIUS - 12;
    if (r > max) this.pos.multiplyScalar(max / r);
  }

  /** Player position expressed as distance / signed angle (left positive) from the boss's facing. */
  private polar(p: THREE.Vector3) {
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    return { d: Math.hypot(dx, dz), a: angleDiff(this.yaw, yawOf(dx, dz)) };
  }

  /** A ground point near `p` that a fist can actually reach. */
  private reachPoint(p: THREE.Vector3, min: number, max: number, out: THREE.Vector3, maxAngle = 1.35) {
    const { d, a } = this.polar(p);
    const dd = clamp(d, min, max);
    const aa = clamp(a, -maxAngle, maxAngle) + this.yaw;
    return out.set(this.pos.x + Math.sin(aa) * dd, 0, this.pos.z + Math.cos(aa) * dd);
  }

  /** `wave`: in the eclipse this impact also throws out a shockwave (see shockRing). */
  private telegraph(at: THREE.Vector3, radius: number, duration: number, color?: number, wave = false) {
    const t = this.world.fx.telegraph(at, radius, duration, color ?? (this.phase === 2 ? 0xff5a1e : 0xff3b2e));
    this.teles.push(t);
    this.world.threats.push({ pos: at, radius, at: this.world.time + duration, wave: wave && this.phase === 2 });
    return t;
  }

  private after(seconds: number, fn: () => void) {
    this.delayed.push({ t: seconds, fn });
  }

  private cancelAttacks() {
    for (const t of this.teles) t.cancel();
    this.teles.length = 0;
    for (const h of this.ownHazards) h.life = 0;
    this.ownHazards.length = 0;
    this.delayed.length = 0;
    this.world.threats.length = 0;
    this.beamOn = false;
  }

  private dmg(n: number) {
    return n * BOSS_TUNING.damage;
  }

  /** Ground impact: instant area hit plus dust, sparks, ring and shake. */
  private impact(at: THREE.Vector3, radius: number, damage: number, opts: { shake?: number; sfx?: string; quiet?: boolean } = {}) {
    const { fx, audio } = this.world;
    this.world.strike({ shape: 'circle', center: at, radius, damage: this.dmg(damage), heavy: true, knock: 9, label: 'impact' });
    _a.set(at.x, 0.3, at.z);
    fx.puff(_a, 26, { radius: radius * 0.7, speed: [2, 9], size: [1.6, 3.6], life: [0.8, 1.8], dir: UP, spread: 0.9 });
    fx.burst(_a, 46, { color: this.phase === 2 ? 0xff7a3a : 0x8fb8ff, intensity: 2.5, speed: [6, 22], size: [0.1, 0.26], life: [0.35, 0.9], gravity: 18, dir: UP, spread: 0.8 });
    fx.ring(_a, { r0: radius * 0.4, r1: radius * 1.7, life: 0.6, color: this.phase === 2 ? 0xff6030 : 0x9fc0ff, intensity: 2 });
    fx.flash(_a.setY(1.2), this.phase === 2 ? 0xff5a2a : 0x9fc0ff, radius * 2.6, 0.3, 1.6);
    fx.shake(opts.shake ?? 0.7, at);
    if (!opts.quiet) audio.play(opts.sfx ?? 'boss_slam', { volume: 1 });
  }

  /** Expanding ring that must be rolled through. */
  private shockRing(at: THREE.Vector3, damage: number, r0 = 3, r1 = 26, speed = 15, knock = 8) {
    const center = at.clone();
    const life = (r1 - r0) / speed;
    this.world.fx.shockwave(center, r0, r1, life, this.phase === 2 ? 0xff5a2a : 0x8fb8ff);
    const h = this.world.addHazard({
      shape: 'ring', center, radius: r0, width: 1.5, grow: speed, damage: this.dmg(damage), knock, life, label: 'shockwave',
      update(dt) {
        this.radius += speed * dt;
      },
    });
    this.ownHazards.push(h);
  }

  // ---------------------------------------------------------------- attacks

  private *slam(side: 1 | -1, quick = false): Script {
    const w = this.world;
    const i = side > 0 ? 0 : 1;
    const speed = this.tempo * (quick ? 0.62 : 1);
    const R = 4.4;
    const target = this.reachPoint(w.player.pos, 5.5, 15.5, new THREE.Vector3());
    const windup = 1.2 * speed;
    const strike = 0.2;
    const tele = this.telegraph(target, R, windup + strike, undefined, true);
    w.audio.play('boss_windup', { volume: 0.8 });
    yield* tween(windup, (k, dt) => {
      if (k < 0.72) {
        this.reachPoint(w.player.pos, 5.5, 15.5, target);
        tele.setPos(target);
        this.faceToward(w.player.pos, 0.5, dt);
      }
      this.setHand(i, side * 7.5, 24 + Math.sin(k * 40) * 0.2 * k, -2.5, 4.5);
      this.ctl.lean = -0.2;
      this.ctl.twist = -side * 0.3;
      this.ctl.crouch = 0.4;
    });
    const from = this.cur.hand[i].clone();
    const to = target.clone().setY(1.5);
    const dist = distXZ(this.pos, target);
    this.ctl.bodyStiff = 14;
    w.audio.play('boss_whoosh', { volume: 0.9 });
    yield* tween(strike, (k) => {
      this.cur.hand[i].lerpVectors(from, to, ease.in(k));
      this.ctl.hand[i].copy(to);
      this.ctl.lean = remap(dist, 5, 15, 0.55, 1.05);
      this.ctl.crouch = remap(dist, 5, 15, 1.6, 3.4);
      this.ctl.twist = side * 0.25;
    });
    this.cur.hand[i].copy(to);
    this.impact(target, R, 56, { shake: 0.75 });
    if (this.phase === 2) this.shockRing(target, 22);
    this.ctl.bodyStiff = 3.5;
    yield* wait((this.phase === 2 ? 0.8 : 1.25) * (quick ? 0.45 : 1));
  }

  private *sweep(side: 1 | -1): Script {
    const w = this.world;
    const i = side > 0 ? 0 : 1;
    const speed = this.tempo;
    const rho = clamp(distXZ(this.pos, w.player.pos), 7.5, 13.5);
    let a0 = side * 1.75;
    let a1 = -side * 1.75;
    w.audio.play('boss_windup', { volume: 0.7, rate: 1.2 });
    yield* tween(1.05 * speed, (k, dt) => {
      if (k < 0.6) this.faceToward(w.player.pos, 0.45, dt);
      this.setHand(i, Math.sin(a0) * rho, 3.4, Math.cos(a0) * rho, 4);
      this.ctl.lean = 0.78;
      this.ctl.crouch = 3.3;
      this.ctl.twist = side * 0.75;
    });
    const passes = this.phase === 2 && rand() < 0.65 ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const dur = 0.72 * speed;
      const hz = w.addHazard({
        shape: 'capsule', center: this.elbow[i], b: this.handPos[i], radius: 2.1, damage: this.dmg(46), heavy: true,
        knock: 12, life: dur, from: this.pos, label: 'sweep',
      });
      this.ownHazards.push(hz);
      w.threats.push({ pos: this.handPos[i], radius: 3.2, at: w.time });
      w.audio.play('boss_whoosh', { volume: 1 });
      this.ctl.bodyStiff = 10;
      const tw0 = this.ctl.twist;
      const tw1 = -Math.sign(a0) * 0.85;
      const s0 = a0;
      const s1 = a1;
      yield* tween(dur, (k) => {
        const a = lerp(s0, s1, ease.inOut(k));
        this.local(Math.sin(a) * rho, 1.7, Math.cos(a) * rho, this.cur.hand[i]);
        this.ctl.hand[i].copy(this.cur.hand[i]);
        this.ctl.twist = lerp(tw0, tw1, k);
        _a.copy(this.cur.hand[i]).setY(0.3);
        w.fx.puff(_a, 1, { speed: [1, 4], size: [1.2, 2.4], life: [0.4, 0.9] });
        if (this.phase === 2) w.fx.burst(_a, 2, { color: 0xff6a30, intensity: 2, speed: [2, 8], size: [0.15, 0.35], life: [0.3, 0.7], gravity: 10 });
      });
      hz.life = 0;
      w.fx.shake(0.25, this.cur.hand[i]);
      this.ctl.bodyStiff = 3.5;
      if (pass < passes - 1) {
        yield* wait(0.4);
        [a0, a1] = [a1, a0];
      }
    }
    yield* wait(this.phase === 2 ? 0.7 : 1.0);
  }

  private *stomp(side: 1 | -1): Script {
    const w = this.world;
    const foot = this.feet[side > 0 ? 0 : 1];
    const other = this.feet[side > 0 ? 1 : 0];
    // Wait for a stable stance.
    let guard = 0;
    while ((foot.stepping || other.stepping) && guard < 1.5) guard += yield;
    const R = 5.0;
    const hipGround = this.local(side * D.hipX, 0, 0, new THREE.Vector3());
    const target = new THREE.Vector3();
    const aim = () => {
      target.copy(w.player.pos).setY(0).sub(hipGround);
      const d = target.length();
      if (d > 6) target.multiplyScalar(6 / d);
      target.add(hipGround);
    };
    aim();
    const windup = 0.95 * this.tempo;
    const tele = this.telegraph(target, R, windup + 0.14, undefined, true);
    foot.locked = true;
    foot.stepping = false;
    const from = foot.pos.clone();
    w.audio.play('boss_windup', { volume: 0.6, rate: 1.4 });
    yield* tween(windup, (k) => {
      if (k < 0.6) {
        aim();
        tele.setPos(target);
      }
      const e = ease.out(Math.min(1, k / 0.7));
      foot.pos.lerpVectors(from, target, e * 0.85);
      foot.pos.y = 5.2 * e;
      this.ctl.crouch = 0.5;
      this.ctl.lean = 0.22;
    });
    const top = foot.pos.clone();
    yield* tween(0.14, (k) => foot.pos.lerpVectors(top, target, ease.in(k)));
    foot.pos.copy(target);
    foot.yaw = this.yaw;
    this.impact(target, R, 60, { shake: 0.9, sfx: 'boss_step' });
    if (this.phase === 2) this.shockRing(target, 22);
    yield* wait(0.9 * this.tempo);
    foot.locked = false;
  }

  private *doubleSlam(): Script {
    const w = this.world;
    const R = 6.4;
    const target = this.reachPoint(w.player.pos, 7, 14, new THREE.Vector3(), 0.9);
    const windup = 1.55 * this.tempo;
    const strike = 0.22;
    const tele = this.telegraph(target, R, windup + strike, undefined, true);
    w.audio.play('boss_windup', { volume: 1, rate: 0.8 });
    yield* tween(windup, (k, dt) => {
      if (k < 0.7) {
        this.reachPoint(w.player.pos, 7, 14, target, 0.9);
        tele.setPos(target);
        this.faceToward(w.player.pos, 0.5, dt);
      }
      this.setHand(0, 2.6, 25.5, -1.5, 4);
      this.setHand(1, -2.6, 25.5, -1.5, 4);
      this.ctl.lean = -0.3;
      this.ctl.crouch = 0.2;
    });
    const dist = distXZ(this.pos, target);
    const left = yawLeft(this.yaw, new THREE.Vector3());
    const from = [this.cur.hand[0].clone(), this.cur.hand[1].clone()];
    const to = [target.clone().addScaledVector(left, 1.9).setY(1.5), target.clone().addScaledVector(left, -1.9).setY(1.5)];
    this.ctl.bodyStiff = 14;
    w.audio.play('boss_whoosh', { volume: 1, rate: 0.8 });
    yield* tween(strike, (k) => {
      for (let i = 0; i < 2; i++) {
        this.cur.hand[i].lerpVectors(from[i], to[i], ease.in(k));
        this.ctl.hand[i].copy(to[i]);
      }
      this.ctl.lean = remap(dist, 6, 14, 0.7, 1.1);
      this.ctl.crouch = remap(dist, 6, 14, 2.0, 3.6);
    });
    this.impact(target, R, 78, { shake: 1 });
    // The ground splits: eruptions march away from the boss through the impact point.
    const dir = target.clone().sub(this.pos).setY(0).normalize();
    for (let n = 1; n <= 7; n++) {
      const p = target.clone().addScaledVector(dir, 3.2 + n * 4.0);
      if (Math.hypot(p.x, p.z) > ARENA_RADIUS + 2) break;
      const delay = 0.18 + n * 0.14;
      this.telegraph(p, 2.7, delay);
      this.after(delay, () => this.impact(p, 2.7, 40, { shake: 0.3, quiet: n % 2 === 0, sfx: 'meteor' }));
    }
    if (this.phase === 2) this.shockRing(target, 22);
    this.ctl.bodyStiff = 3.5;
    yield* wait(this.phase === 2 ? 1.5 : 2.1);
  }

  private *beam(): Script {
    const w = this.world;
    const charge = 1.5 * this.tempo;
    w.audio.play('boss_beam_charge', { volume: 1 });
    w.voice.say('boss', 'beam', { priority: 1, chance: 0.7, cooldown: 14, delay: 0.5 });
    const aimPos = w.player.pos.clone().setY(0);
    const tele = this.telegraph(aimPos, 2.2, charge, 0xffb040);
    yield* tween(charge, (k, dt) => {
      this.faceToward(w.player.pos, 0.9, dt);
      this.setHand(0, 9.5, 12, 3, 3);
      this.setHand(1, -9.5, 12, 3, 3);
      this.ctl.lean = -0.22;
      this.ctl.glow = 1 + k * 1.6;
      aimPos.copy(w.player.pos).setY(0);
      tele.setPos(aimPos);
      w.fx.burst(this.corePos, 2, { color: 0xffb060, intensity: 3, speed: [-9, -4], radius: 5, size: [0.2, 0.4], life: [0.3, 0.5] });
    });
    // The beam rakes across the player's range in an arc around the boss.
    const dx = w.player.pos.x - this.pos.x;
    const dz = w.player.pos.z - this.pos.z;
    const pr = clamp(Math.hypot(dx, dz), 7, ARENA_RADIUS - 2);
    const pa = yawOf(dx, dz);
    const dir = randSign();
    const half = 0.95;
    const dur = 1.7;
    const g = this.beamTo;
    const place = (a: number) => g.set(this.pos.x + Math.sin(a) * pr, 0, this.pos.z + Math.cos(a) * pr);
    place(pa - dir * half);
    const hz = w.addHazard({ shape: 'circle', center: g, radius: 2.0, damage: this.dmg(36), heavy: true, knock: 8, life: dur, label: 'beam' });
    this.ownHazards.push(hz);
    w.threats.push({ pos: g, radius: 3.0, at: w.time });
    this.beamOn = true;
    w.audio.play('boss_beam', { volume: 1 });
    this.ctl.lean = 0.25;
    let scorch = 0;
    yield* tween(dur, (k, dt) => {
      place(pa + dir * half * (k * 2 - 1));
      w.fx.shake(0.05);
      _a.copy(g).setY(0.2);
      w.fx.burst(_a, 3, { color: 0xff8a40, color2: 0xffe0a0, intensity: 2, speed: [3, 14], size: [0.12, 0.3], life: [0.3, 0.7], gravity: 14, dir: UP, spread: 0.8 });
      scorch -= dt;
      if (scorch <= 0) {
        scorch = 0.09;
        // The floor keeps burning where the beam passed.
        const c = g.clone();
        w.fx.ring(c, { r0: 1.5, r1: 1.9, life: 2.3, color: 0xff5a20, intensity: 1.2 });
        w.fx.burst(c.clone().setY(0.2), 4, { color: 0xff5a20, intensity: 2, speed: [0.5, 3], size: [0.3, 0.7], life: [1.2, 2.2], dir: UP, spread: 0.5, radius: 1.3 });
        this.ownHazards.push(w.addHazard({ shape: 'circle', center: c, radius: 1.5, damage: this.dmg(10), life: 2.3, tick: 0.5, label: 'scorch' }));
      }
    });
    hz.life = 0;
    this.beamOn = false;
    this.ctl.glow = 1;
    yield* wait(1.1);
  }

  private *starfall(): Script {
    const w = this.world;
    w.audio.play('boss_roar', { volume: 0.7, rate: 1.3 });
    w.voice.say('boss', 'starfall', { priority: 1, chance: 0.8, cooldown: 14, delay: 0.4 });
    yield* tween(1.1 * this.tempo, () => {
      this.setHand(0, 8.5, 26, 0.5, 3.5);
      this.setHand(1, -8.5, 26, 0.5, 3.5);
      this.ctl.lean = -0.22;
      this.ctl.glow = 1.8;
    });
    const count = 9;
    for (let n = 0; n < count; n++) {
      this.after(n * 0.22, () => {
        const p = w.player.pos.clone().setY(0);
        if (n % 3 === 0) p.addScaledVector(w.player.vel, 0.6);
        else {
          const a = rand(TAU);
          const r = rand(4, 14);
          p.x += Math.sin(a) * r;
          p.z += Math.cos(a) * r;
        }
        const fall = 1.25;
        this.telegraph(p, 3.0, fall, 0xffa040);
        w.fx.meteor(p, fall, 0xffb060);
        this.after(fall, () => this.impact(p, 3.0, 38, { shake: 0.3, sfx: 'meteor' }));
      });
    }
    this.ctl.glow = 1;
    yield* wait(1.3);
  }

  /** A slow pivot to bring a flanking player back in front. */
  private *pivot(): Script {
    yield* tween(1.3, (_k, dt) => this.faceToward(this.world.player.pos, 2.0, dt));
  }

  private roarWave() {
    const w = this.world;
    w.audio.play('boss_roar', { volume: 1 });
    w.fx.shake(0.8);
    this.shockRing(this.pos, 14, 4, 36, 22, 15);
  }

  // ---------------------------------------------------------------- state scripts

  awaken() {
    if (this.state !== 'dormant') return;
    this.state = 'intro';
    this.script = this.introScript();
  }

  /** Skip the rising animation. */
  skipIntro() {
    if (this.state !== 'intro' && this.state !== 'dormant') return;
    this.resetCtl();
    this.cur.glow = 1;
    this.state = 'fight';
    this.script = this.brain();
    this.world.onBossEvent('awake');
  }

  private *introScript(): Script {
    const w = this.world;
    this.setKneelTargets();
    this.ctl.headLook = false;
    // The star in its chest catches: a stutter of light that steadies as it takes.
    w.audio.play('boss_windup', { volume: 0.9, rate: 0.55 });
    yield* tween(BOSS_WAKE.ignite, (k) => {
      // Dark, a flash, dark again: the flashes come closer together until one of them holds.
      const lit = k > 0.86 || Math.sin(this.time * 37) * Math.sin(this.time * 8.3) > 0.6 - 0.95 * k;
      // Straight onto the lights, past the easing that would smooth the flicker away.
      this.ctl.glow = this.cur.glow = lit ? 0.85 + 0.35 * k : 0.015 + 0.05 * k;
      w.fx.shake(0.02 + 0.05 * k);
      if (rand() < 0.25 + 0.6 * k) {
        w.fx.burst(this.corePos, 1, { color: 0x9fd0ff, color2: 0xffffff, intensity: 3, speed: [2, 10], size: [0.1, 0.3], life: [0.3, 0.9], gravity: 4 });
      }
    });
    // It has its light. Now it remembers that it has a body.
    this.flash = 1.4;
    w.fx.flash(this.corePos, 0xbfe0ff, 30, 0.6, 2.6);
    _a.set(this.pos.x, 0.15, this.pos.z);
    w.fx.shockwave(_a, 3, 44, 1.4, 0x8fb8ff);
    w.fx.ring(_a, { r0: 2, r1: 26, life: 0.9, color: 0x9fc0ff, intensity: 2.4 });
    w.fx.puff(_a, 40, { radius: 9, speed: [2, 8], size: [2, 4.5], life: [1, 2.2], dir: UP, spread: 0.9 });
    w.fx.shake(0.8);
    w.audio.play('boss_roar', { volume: 1, rate: 0.9 });
    this.resetCtl();
    this.ctl.bodyStiff = 1.6;
    this.ctl.stiff[0] = this.ctl.stiff[1] = 1.6;
    this.ctl.lean = -0.25;
    yield* tween(BOSS_WAKE.rise, (_k, dt) => {
      w.fx.shake(0.06);
      this.faceToward(w.player.pos, 0.9, dt);
    });
    this.ctl.lean = 0.06;
    this.resetCtl();
    this.state = 'fight';
    w.onBossEvent('awake');
    yield* wait(0.6);
  }

  private *staggerScript(): Script {
    const w = this.world;
    this.cancelAttacks();
    this.state = 'staggered';
    this.staggerWindow = BOSS_TUNING.staggerWindow;
    this.resetCtl();
    this.setKneelTargets();
    this.ctl.bodyStiff = 5.5;
    this.ctl.glow = 0.3;
    this.ctl.headLook = false;
    w.audio.play('boss_stagger', { volume: 1 });
    w.fx.shake(0.9);
    w.fx.burst(this.corePos, 80, { color: 0x9fd0ff, intensity: 3, speed: [8, 30], size: [0.2, 0.6], life: [0.5, 1.4], gravity: 10 });
    w.onBossEvent('staggered');
    while (this.staggerWindow > 0) {
      const dt: number = yield;
      if (!this.staggerHold) this.staggerWindow -= dt;
      this.ctl.glow = 0.3 + 0.2 * Math.sin(this.time * 14);
    }
    this.staggerWindow = 0;
    this.state = 'fight';
    this.posture = 0;
    this.postureMax *= BOSS_TUNING.postureGrowth;
    w.onBossEvent('recovered');
    this.resetCtl();
    this.ctl.lean = -0.3;
    this.ctl.bodyStiff = 2.6;
    yield* wait(0.85);
    this.roarWave();
    yield* wait(0.9);
    this.resetCtl();
  }

  private *phaseTwoScript(): Script {
    const w = this.world;
    this.cancelAttacks();
    this.invulnerable = true;
    this.state = 'transition';
    this.resetCtl();
    w.audio.play('boss_roar', { volume: 1, rate: 0.75 });
    w.arena.setEclipse(1);
    w.onBossEvent('phase2');
    yield* tween(3.0, (k) => {
      this.setHand(0, 11.5, 17, 1.5, 2.5);
      this.setHand(1, -11.5, 17, 1.5, 2.5);
      this.ctl.lean = -0.38;
      this.ctl.crouch = -0.4;
      this.ctl.wings = 1;
      this.ctl.glow = 1 + k * 1.5;
      this.hue = k;
      w.fx.shake(0.1);
      _a.set(this.pos.x + rand(-16, 16), 0.2, this.pos.z + rand(-16, 16));
      w.fx.burst(_a, 3, { color: 0xff4a2a, intensity: 3, speed: [4, 12], dir: UP, spread: 0.2, size: [0.2, 0.5], life: [0.8, 1.6] });
    });
    this.phase = 2;
    this.hue = 1;
    this.posture = 0;
    this.roarWave();
    this.invulnerable = false;
    this.state = 'fight';
    this.resetCtl();
    yield* wait(1.0);
  }

  private *deathScript(): Script {
    const w = this.world;
    this.cancelAttacks();
    this.state = 'dying';
    this.invulnerable = true;
    this.resetCtl();
    this.ctl.headLook = false;
    w.onBossEvent('dying');
    w.audio.play('boss_death', { volume: 1 });
    yield* tween(2.2, (k) => {
      this.ctl.lean = -0.3 + 0.9 * k;
      this.ctl.crouch = 2.5 * k;
      this.ctl.glow = 1 + 2.5 * k + Math.sin(this.time * 30) * 0.6;
      w.fx.shake(0.12);
      w.fx.burst(this.corePos, 4, { color: 0xffffff, intensity: 4, speed: [6, 24], size: [0.2, 0.5], life: [0.4, 1.0] });
    });
    this.shatter();
    w.fx.blast(this.corePos, 26, 0xcfe0ff, 1.3, 4);
    w.fx.flash(this.corePos, 0xffffff, 70, 0.6, 3);
    w.fx.burst(this.corePos, 400, { color: 0xbfd8ff, color2: 0xffffff, intensity: 4, speed: [8, 46], size: [0.25, 0.8], life: [0.8, 2.6], gravity: 6 });
    w.fx.shake(1);
    w.audio.play('explode', { volume: 1, rate: 0.7 });
    yield* wait(3.2);
    this.state = 'dead';
    w.onBossEvent('dead');
    while (true) yield;
  }

  private shatter() {
    this.debris = [];
    this.coreLight.intensity = 0;
    this.core.visible = false;
    this.serpent.visible = false;
    this.halo.visible = false;
    for (const o of this.glyphs) o.visible = false;
    for (const s of this.segs) {
      s.tetherA.visible = s.tetherB.visible = false;
      for (const o of s.orbs) o.visible = false;
    }
    this.group.updateMatrixWorld(true);
    for (const mesh of this.pieces) {
      this.group.attach(mesh);
      const vel = mesh.position.clone().sub(this.corePos).normalize().multiplyScalar(rand(5, 20));
      vel.y += rand(4, 12);
      this.debris.push({ mesh, vel, spin: new THREE.Vector3(rand(-3, 3), rand(-3, 3), rand(-3, 3)), size: 0.9 });
    }
  }

  private *brain(): Script {
    while (true) {
      // Between attacks it may turn on a different Knight.
      this.world.retarget();
      yield* this.idle((this.phase === 2 ? rand(0.45, 0.95) : rand(0.95, 1.6)) * BOSS_TUNING.tempo);
      if (this.pendingPhase2) {
        this.pendingPhase2 = false;
        yield* this.phaseTwoScript();
        continue;
      }
      if (!this.world.player.alive) continue;
      const atk = this.choose();
      if (!atk) continue;
      this.lastAttack = atk.name;
      yield* atk.run();
      this.resetCtl();
      yield* wait(0.3);
    }
  }

  private *idle(time: number): Script {
    let t = 0;
    let under = 0;
    while (t < time) {
      const dt: number = yield;
      t += dt;
      const p = this.world.player.pos;
      const d = distXZ(this.pos, p);
      this.faceToward(p, BOSS_TUNING.turnRate * (this.phase === 2 ? 1.4 : 1), dt);
      this.moveVel.set(0, 0, 0);
      if (d > 13.5) {
        this.walkToward(p, BOSS_TUNING.walkSpeed * (this.phase === 2 ? 1.3 : 1), dt);
        // Keep closing rather than attacking empty air.
        if (d > 19 && this.phase === 1) t = Math.min(t, time - 0.2);
      }
      if (d < 6.5) {
        under += dt;
        if (under > 0.45 && t > 0.3) return;
      }
    }
  }

  private attackByName(name: string, side: 1 | -1): (() => Script) | null {
    switch (name) {
      case 'slam': return () => this.slam(side);
      case 'slamCombo': return () => this.slamCombo(side);
      case 'sweep': return () => this.sweep(side);
      case 'stomp': return () => this.stomp(side);
      case 'doubleSlam': return () => this.doubleSlam();
      case 'beam': return () => this.beam();
      case 'starfall': return () => this.starfall();
      case 'pivot': return () => this.pivot();
    }
    return null;
  }

  private *slamCombo(side: 1 | -1): Script {
    yield* this.slam(side);
    this.ctl.handFree[side > 0 ? 0 : 1] = true;
    yield* this.slam(-side as 1 | -1, true);
  }

  private choose(): { name: string; run: () => Script } | null {
    const { d, a } = this.polar(this.world.player.pos);
    const side: 1 | -1 = a >= 0 ? 1 : -1;
    if (this.forceAttack) {
      const run = this.attackByName(this.forceAttack, side);
      const name = this.forceAttack;
      this.forceAttack = null;
      if (run) return { name, run };
    }
    const abs = Math.abs(a);
    const p2 = this.phase === 2;
    const opts: { w: number; v: string }[] = [];
    if (d < 7.5) opts.push({ w: 3.2, v: 'stomp' });
    if (d >= 4.5 && d < 17 && abs < 1.25) opts.push({ w: 3, v: p2 ? 'slamCombo' : 'slam' });
    if (d >= 5 && d < 15.5 && abs < 2.0) opts.push({ w: 2.4, v: 'sweep' });
    if (d >= 6 && d < 24 && abs < 0.8) opts.push({ w: 1.7, v: 'doubleSlam' });
    if (p2 && d > 8) opts.push({ w: 2.0, v: 'beam' });
    if (p2) opts.push({ w: 1.8, v: 'starfall' });
    if (abs > 1.9 && d >= 7.5) opts.push({ w: 4, v: 'pivot' });
    for (const o of opts) if (o.v === this.lastAttack) o.w *= 0.3;
    const name = pickWeighted(opts);
    if (!name) return null;
    // Stomp with whichever foot is nearer the player.
    const run = this.attackByName(name, side);
    return run ? { name, run } : null;
  }

  // ---------------------------------------------------------------- damage

  /**
   * Returns the damage actually dealt (after part and stagger multipliers). `minor` marks a
   * hit from an ally, whose number is drawn smaller than the player's own.
   */
  takeDamage(part: BossPart, damage: number, stagger: number, hitPos: THREE.Vector3, minor = false): number {
    if (this.invulnerable || this.state === 'dormant' || this.state === 'intro' || this.state === 'dying' || this.state === 'dead') return 0;
    const staggered = this.state === 'staggered';
    const mult = part.mult * (staggered ? (part.weak ? 1.5 : 1.25) : 1);
    const dealt = Math.min(this.hp, damage * mult);
    this.hp -= dealt;
    this.flash = 1;
    const w = this.world;
    w.damageNumber(hitPos, dealt, minor ? 'ally' : part.weak ? 'weak' : part.armor ? 'armor' : 'normal');
    if (this.hp <= 0) {
      this.script = this.deathScript();
      return dealt;
    }
    if (this.state === 'fight') {
      this.posture += stagger * part.stag;
      this.postureTimer = BOSS_TUNING.postureDecayDelay;
      if (this.posture >= this.postureMax) {
        this.posture = this.postureMax;
        this.script = this.staggerScript();
      }
    }
    if (this.phase === 1 && this.hp <= this.maxHp * BOSS_TUNING.phase2At) this.pendingPhase2 = true;
    return dealt;
  }

  /** Parts overlapping a sphere, best target first (weak points, then by multiplier). */
  partsInSphere(center: THREE.Vector3, radius: number): BossPart[] {
    return this.parts
      .filter((p) => p.pos.distanceTo(center) < radius + p.r)
      .sort((p, q) => Number(q.weak) - Number(p.weak) || q.mult - p.mult);
  }

  /** Circles the player cannot walk through. */
  blockers(out: { x: number; z: number; r: number }[]) {
    out.length = 0;
    if (this.state === 'dead' || this.state === 'dying') return out;
    for (const f of this.feet) if (f.pos.y < 2) out.push({ x: f.pos.x, z: f.pos.z, r: 2.1 });
    for (let i = 0; i < 2; i++) {
      const h = this.handPos[i];
      if (h.y < 2.6) out.push({ x: h.x, z: h.z, r: 1.9 });
    }
    const py = this.pelvisNode.position.y;
    if (py < 5.5) out.push({ x: this.pelvisNode.position.x, z: this.pelvisNode.position.z, r: 3.0 });
    return out;
  }

  // ---------------------------------------------------------------- update

  update(dt: number) {
    if (this.debris) {
      this.updateDebris(dt);
      this.script?.next(dt);
      return;
    }
    if (this.freeze) {
      this.applyGlow(dt);
      return;
    }
    this.time += dt;

    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i];
      d.t -= dt;
      if (d.t <= 0) {
        this.delayed.splice(i, 1);
        d.fn();
      }
    }
    if (this.script) {
      const r = this.script.next(dt);
      if (r.done) this.script = this.state === 'fight' ? this.brain() : null;
    }
    if (this.debris) return;
    if (this.state === 'fight' && !this.script) this.script = this.brain();

    if (this.state === 'fight') {
      this.postureTimer -= dt;
      if (this.postureTimer <= 0) this.posture = Math.max(0, this.posture - BOSS_TUNING.postureDecay * dt);
    }
    this.ownHazards = this.ownHazards.filter((h) => h.life > 0);

    // Ease the body toward what the current action asks for.
    const c = this.ctl;
    const u = this.cur;
    const kb = dampFactor(c.bodyStiff, dt);
    u.lean += (c.lean - u.lean) * kb;
    u.twist += (c.twist - u.twist) * kb;
    u.crouch += (c.crouch - u.crouch) * kb;
    u.shift += (c.shift - u.shift) * kb;
    u.glow = damp(u.glow, c.glow, 4, dt);
    u.wings = damp(u.wings, c.wings, 1.5, dt);
    for (let i = 0; i < 2; i++) {
      if (c.handFree[i]) {
        const side = i === 0 ? 1 : -1;
        _a.set(HAND_REST.x * side, HAND_REST.y + Math.sin(this.time * 0.9 + i * 2) * 0.25, HAND_REST.z);
        this.chestNode.localToWorld(c.hand[i].copy(_a));
      }
      u.hand[i].lerp(c.hand[i], dampFactor(c.stiff[i], dt));
    }
    this.updateFeet(dt);
    this.solve(dt);
    this.applyGlow(dt);
  }

  private updateFeet(dt: number) {
    this.stepCooldown -= dt;
    const moving = this.moveVel.lengthSq() > 0.01;
    let worst: Foot | null = null;
    let worstErr = 0;
    for (const f of this.feet) {
      if (f.locked) continue;
      if (f.stepping) {
        f.t += dt / f.dur;
        const k = Math.min(1, f.t);
        f.pos.lerpVectors(f.from, f.to, ease.inOut(k));
        f.pos.y = Math.sin(Math.PI * k) * 2.2;
        f.yaw = f.fromYaw + angleDiff(f.fromYaw, f.toYaw) * ease.inOut(k);
        if (k >= 1) {
          f.stepping = false;
          f.pos.y = 0;
          this.stepCooldown = 0.14;
          this.footfall(f);
        }
        continue;
      }
      this.local(f.side * D.footX, 0, 0, _a);
      const err = Math.hypot(f.pos.x - _a.x, f.pos.z - _a.z) + Math.abs(angleDiff(f.yaw, this.yaw)) * 3;
      if (err > worstErr) {
        worstErr = err;
        worst = f;
      }
    }
    const anyStepping = this.feet.some((f) => f.stepping || (f.locked && f.pos.y > 0.2));
    const threshold = moving ? 2.4 : 1.6;
    if (worst && !anyStepping && this.stepCooldown <= 0 && worstErr > threshold && this.state !== 'staggered' && this.state !== 'dormant') {
      worst.stepping = true;
      worst.t = 0;
      worst.dur = (this.phase === 2 ? 0.62 : 0.78) * (moving ? 1 : 1.1);
      worst.from.copy(worst.pos);
      // Overshoot along the direction of travel so the stride lands ahead of the body.
      this.local(worst.side * D.footX, 0, 0, worst.to).addScaledVector(this.moveVel, worst.dur * 1.25);
      worst.to.y = 0;
      worst.fromYaw = worst.yaw;
      worst.toYaw = this.yaw;
    }
  }

  private footfall(f: Foot) {
    const { fx, audio } = this.world;
    _a.copy(f.pos).setY(0.2);
    fx.puff(_a, 10, { radius: 2, speed: [1, 5], size: [1.2, 2.6], life: [0.6, 1.3] });
    fx.shake(0.22, f.pos);
    audio.play('boss_step', { volume: 0.7 });
  }

  /** Place every node, bone and plate from the current control values. */
  private solve(_dt: number) {
    const u = this.cur;
    const fwd = yawForward(this.yaw, _x.clone());
    const left = yawLeft(this.yaw, _y.clone());
    const fl = this.feet[0];
    const fr = this.feet[1];

    // Pelvis rides between the feet and leans its weight onto the planted one.
    const midX = (fl.pos.x + fr.pos.x) / 2;
    const midZ = (fl.pos.z + fr.pos.z) / 2;
    const liftBias = clamp((fr.pos.y - fl.pos.y) / 5, -1, 1);
    const px = lerp(this.pos.x, midX, 0.5) + fwd.x * u.shift + left.x * liftBias * 1.1;
    const pz = lerp(this.pos.z, midZ, 0.5) + fwd.z * u.shift + left.z * liftBias * 1.1;
    const bob = Math.sin(this.time * 0.9) * 0.12 - Math.max(fl.pos.y, fr.pos.y) * 0.05;
    this.pelvisNode.position.set(px, D.pelvisY - u.crouch + bob, pz);
    this.pelvisNode.rotation.set(u.lean * 0.5, this.yaw + u.twist * 0.35, liftBias * 0.07, 'YXZ');
    this.chestNode.rotation.set(u.lean * 0.5, u.twist * 0.65, 0, 'YXZ');

    // Head tracks the player.
    if (this.ctl.headLook && this.state !== 'dormant') {
      _a.copy(this.world.player.pos).setY(1.2);
      this.chestNode.worldToLocal(_a).sub(this.headNode.position);
      const yawL = clamp(Math.atan2(_a.x, _a.z), -1.0, 1.0);
      const pitchL = clamp(-Math.atan2(_a.y, Math.hypot(_a.x, _a.z)), -0.5, 0.9);
      this.headNode.rotation.set(damp(this.headNode.rotation.x, pitchL, 3, _dt || 0.016), damp(this.headNode.rotation.y, yawL, 3, _dt || 0.016), 0, 'YXZ');
    } else {
      this.headNode.rotation.set(damp(this.headNode.rotation.x, 0.5, 3, _dt || 0.016), damp(this.headNode.rotation.y, 0, 3, _dt || 0.016), 0, 'YXZ');
    }
    this.pelvisNode.updateMatrixWorld(true);

    // Arms
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      this.chestNode.localToWorld(this.shoulder[i].set(side * D.shoulderX, D.shoulderY, 0));
      _c.copy(left).multiplyScalar(side * 0.8).addScaledVector(fwd, -0.6).addScaledVector(UP, -0.35);
      twoBoneIK(this.shoulder[i], u.hand[i], D.upper, D.fore, _c, this.elbow[i], 1.75, this.handPos[i]);
      this.placeLimb(this.segs[i], this.shoulder[i], this.elbow[i], this.handPos[i], _c, this.armNormal[i]);
    }
    // Legs
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const f = this.feet[i];
      this.pelvisNode.localToWorld(this.hip[i].set(side * D.hipX, -D.hipDrop, 0));
      const ff = yawForward(f.yaw, _a);
      this.ankle[i].set(f.pos.x - ff.x * 0.4, f.pos.y + D.ankle, f.pos.z - ff.z * 0.4);
      _c.copy(fwd).addScaledVector(left, side * 0.25);
      twoBoneIK(this.hip[i], this.ankle[i], D.thigh, D.shin, _c, this.knee[i], 1.6);
      const s = this.segs[2 + i];
      this.placeLimb(s, this.hip[i], this.knee[i], this.ankle[i], _c, this.legNormal[i], true);
      s.end.position.set(f.pos.x, f.pos.y + 0.75, f.pos.z);
      s.end.rotation.set(Math.min(0.6, f.pos.y * 0.12), f.yaw, 0, 'YXZ');
    }

    // Derived points and hit volumes
    this.chestNode.localToWorld(this.corePos.copy(CORE_LOCAL));
    this.headNode.getWorldPosition(this.headPos);
    const P = (id: string) => this.part(id).pos;
    P('ankleL').copy(this.feet[0].pos).y += 1.7;
    P('ankleR').copy(this.feet[1].pos).y += 1.7;
    P('core').copy(this.corePos);
    P('head').copy(this.headPos);
    P('handL').copy(this.handPos[0]);
    P('handR').copy(this.handPos[1]);
    this.chestNode.localToWorld(P('chest').set(0, 2.2, -0.6));
    this.pelvisNode.getWorldPosition(P('pelvis'));
    P('kneeL').copy(this.knee[0]);
    P('kneeR').copy(this.knee[1]);
    this.part('core').r = this.state === 'staggered' ? 2.4 : 1.8;
    this.part('handL').lockable = this.handPos[0].y < 5;
    this.part('handR').lockable = this.handPos[1].y < 5;
    this.part('head').lockable = this.state !== 'staggered';

    this.updateDecor(_dt);
  }

  private placeBone(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, normal: THREE.Vector3, stretchY = false) {
    _y.subVectors(b, a);
    const len = _y.length();
    _y.divideScalar(Math.max(1e-5, len));
    _x.copy(normal).addScaledVector(_y, -normal.dot(_y));
    if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
    _x.normalize();
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z);
    mesh.quaternion.setFromRotationMatrix(_m);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    if (stretchY) mesh.scale.set(1, len, 1);
  }

  private placeLimb(
    s: Limb, root: THREE.Vector3, mid: THREE.Vector3, end: THREE.Vector3,
    pole: THREE.Vector3, normal: THREE.Vector3, isLeg = false,
  ) {
    // The bend plane's normal keeps the plates from rolling about their own axis.
    _n.subVectors(end, root).cross(pole);
    if (_n.lengthSq() > 1e-4) {
      _n.normalize();
      if (_n.dot(normal) < 0 && normal.lengthSq() > 0.5) _n.negate();
      normal.lerp(_n, 0.5).normalize();
    }
    this.placeBone(s.upper, root, mid, normal);
    this.placeBone(s.lower, mid, end, normal);
    this.placeBone(s.tetherA, root, mid, normal, true);
    this.placeBone(s.tetherB, mid, end, normal, true);
    s.orbs[0].position.copy(root);
    s.orbs[1].position.copy(mid);
    if (!isLeg) {
      s.end.position.copy(end);
      s.end.quaternion.copy(s.lower.quaternion);
    }
  }

  private updateDecor(dt: number) {
    const t = this.time;
    this.halo.rotation.z += dt * 0.25;
    this.core.rotation.y += dt * 1.4;
    this.core.rotation.x += dt * 0.6;
    for (const w of this.wings) {
      const { sx, k } = w.userData as { sx: number; k: number };
      const spread = this.cur.wings;
      const bobY = Math.sin(t * 1.1 + k * 1.7 + sx) * 0.35;
      w.position.set(sx * (2.4 + k * 1.2 + spread * (2.2 + k * 1.6)), 3.6 + k * 0.5 + spread * (1.5 + k * 1.5) + bobY, -3.0 - spread * 0.8);
      w.rotation.z = -sx * (0.18 + k * 0.16 + spread * (0.55 + k * 0.28));
    }
    // Serpent: a chain of stars sliding along a coil around the torso.
    const n = this.serpent.count;
    const drift = (t * 0.07) % 1;
    for (let i = 0; i < n; i++) {
      const s = (i / n + drift) % 1;
      const ang = s * TAU * 2.6 + 0.6;
      const r = 4.6 - s * 1.2 + Math.sin(s * 40 + t * 2) * 0.12;
      const y = -4.5 + s * 9.5;
      const scale = (0.55 + 0.9 * Math.sin(s * Math.PI)) * (0.85 + 0.25 * Math.sin(i * 12.9 + t * 3));
      _m.makeScale(scale, scale * 1.6, scale);
      _m.setPosition(Math.sin(ang) * r, y, Math.cos(ang) * r * 0.78 - 0.4);
      this.serpent.setMatrixAt(i, _m);
    }
    this.serpent.instanceMatrix.needsUpdate = true;

    // Glyphs. The belt and the sigils hang in the air about the chest rather than on it:
    // they follow where it goes but do not lurch with every blow.
    const quick = 1 + this.cur.wings * 1.3;
    this.chestNode.localToWorld(_a.set(0, 0.6, 0));
    this.belt.position.lerp(_a, dt > 0 ? 1 - Math.exp(-2.5 * dt) : 1);
    this.belt.rotation.set(0.22 + this.cur.wings * 0.1, this.belt.rotation.y - dt * 0.05, 0, 'YXZ');
    this.beltSpin.rotation.y += dt * 0.15 * quick;
    this.sigils.forEach((s, i) => {
      s.phase += dt * s.rate * quick;
      const c = this.belt.position;
      s.obj.position.set(c.x + Math.sin(s.phase) * s.reach, c.y + s.height + Math.sin(t * 0.7 + i * 2.1) * 0.6, c.z + Math.cos(s.phase) * s.reach);
      s.obj.rotation.set(-0.22, s.phase, s.obj.rotation.z + dt * 0.4 * (i % 2 ? -1 : 1), 'YXZ');
    });
    this.bands.forEach((b, i) => (b.rotation.y += dt * (i % 2 ? -0.8 : 0.8) * quick));
    this.haloRunes.rotation.z -= dt * 0.2;

    if (this.beamOn) {
      this.beamMesh.visible = true;
      const flick = 0.75 + 0.25 * Math.sin(t * 60);
      this.placeBone(this.beamMesh, this.corePos, this.beamTo, UP, true);
      this.beamMesh.scale.x = this.beamMesh.scale.z = 0.5 * flick;
    } else this.beamMesh.visible = false;
  }

  private applyGlow(dt: number) {
    this.flash = Math.max(0, this.flash - dt * 6);
    const g = this.cur.glow;
    this.glowColor.copy(COOL).lerp(HOT, this.hue);
    const pulse = 0.85 + 0.15 * Math.sin(this.time * 2.2);
    this.lineMat.color.copy(this.glowColor).multiplyScalar(g * pulse * 0.9).addScalar(this.flash * 1.5);
    this.lineMat.opacity = clamp(0.25 + g, 0, 1);
    this.glowMat.color.copy(this.glowColor).multiplyScalar(g * 1.7 * pulse).addScalar(this.flash);
    const corePulse = 1 + 0.25 * Math.sin(this.time * 5);
    this.coreMat.color.copy(this.glowColor).lerp(new THREE.Color(1, 1, 1), 0.45).multiplyScalar(g * 2.6 * corePulse + this.flash * 2);
    (this.coreGlow.material as THREE.SpriteMaterial).color.copy(this.glowColor).multiplyScalar(g * 0.9);
    this.coreLight.color.copy(this.glowColor);
    this.coreLight.intensity = g * 260 * corePulse;
    this.redMat.color.setRGB(3 * g + 0.2, 0.3 * g, 0.2 * g);
    this.core.scale.setScalar((this.state === 'staggered' ? 1.35 : 1) * (0.92 + 0.08 * corePulse));
    this.armorMat.emissive.copy(this.glowColor).multiplyScalar(0.012 * g + this.flash * 0.05);
    ARMOR_GLOW.uGlow.value.copy(this.glowColor).multiplyScalar(g * pulse * 0.55);
    ARMOR_GLOW.uFlash.value = this.flash * 0.3;
    this.glyphMat.color.copy(this.glowColor).multiplyScalar(g * pulse * ARMOR_GLOW.uGlyph.value).addScalar(this.flash * 0.5);
  }

  private updateDebris(dt: number) {
    this.time += dt;
    this.flash = 0;
    this.cur.glow = damp(this.cur.glow, 0, 0.9, dt);
    this.applyGlow(dt);
    for (const d of this.debris!) {
      d.vel.y -= 26 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.mesh.position.y < d.size) {
        d.mesh.position.y = d.size;
        if (Math.abs(d.vel.y) > 5) this.world.fx.puff(d.mesh.position, 3, { speed: [1, 4] });
        d.vel.y *= -0.28;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.5);
      }
    }
  }
}
