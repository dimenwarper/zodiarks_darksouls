import type * as THREE from 'three';
import type { Fx } from './core/fx';
import type { AudioSys } from './core/audio';
import type { Voices } from './core/voice';
import type { Arena } from './world/arena';
import type { Props } from './world/props';

/** A damaging volume the boss puts into the world. */
export interface Hazard {
  shape: 'sphere' | 'circle' | 'ring' | 'capsule';
  /** Live reference: the owner may move it every step. */
  center: THREE.Vector3;
  /** Second end of a capsule. */
  b?: THREE.Vector3;
  radius: number;
  /** Ring thickness. */
  width?: number;
  /** Rings: how fast the radius grows, in metres per second. */
  grow?: number;
  damage: number;
  /** Knocks the target down instead of a flinch. */
  heavy?: boolean;
  knock?: number;
  /** Knockback pushes away from this point (defaults to the centre). */
  from?: THREE.Vector3;
  life: number;
  /** Lingering areas re-arm after this many seconds instead of resolving once. */
  tick?: number;
  /**
   * Per Knight, the game time until which this hazard cannot touch them again (Infinity once
   * it has hit or been dodged), so one roll clears one attack for whoever rolled.
   */
  seen?: Map<object, number>;
  update?(dt: number): void;
  label: string;
}

/** An announced impact: what allies (and the autoplay bot) read to decide when to dodge. */
export interface Threat {
  pos: THREE.Vector3;
  radius: number;
  at: number;
  /** The impact will also throw out a shockwave. */
  wave?: boolean;
}

export type BossEvent = 'awake' | 'staggered' | 'recovered' | 'phase2' | 'dying' | 'dead';
export type HitKind = 'normal' | 'weak' | 'armor' | 'ally' | 'heal' | 'player';

/** The slice of the game the boss and the party are allowed to touch. */
export interface World {
  time: number;
  scene: THREE.Scene;
  fx: Fx;
  audio: AudioSys;
  voice: Voices;
  arena: Arena;
  /** Generated scenery models; empty when none have been made. */
  props: Props;
  hazards: Hazard[];
  threats: Threat[];
  /** Whichever Knight the boss is hunting at the moment (not always the one being played). */
  player: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean };
  /** Let the boss pick who to go after next. */
  retarget(): void;
  addHazard(h: Hazard): Hazard;
  /** Resolve an instantaneous hit, right now, against every Knight it touches. */
  strike(h: Omit<Hazard, 'life'>): void;
  hitstop(seconds: number): void;
  slowmo(seconds: number, scale: number): void;
  damageNumber(pos: THREE.Vector3, amount: number, kind: HitKind): void;
  onBossEvent(e: BossEvent): void;
}
