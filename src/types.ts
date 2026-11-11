import type * as THREE from 'three';
import type { Fx } from './core/fx';
import type { AudioSys } from './core/audio';
import type { Arena } from './world/arena';

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
  damage: number;
  /** Knocks the target down instead of a flinch. */
  heavy?: boolean;
  knock?: number;
  /** Knockback pushes away from this point (defaults to the centre). */
  from?: THREE.Vector3;
  life: number;
  /** Lingering areas re-arm after this many seconds instead of resolving once. */
  tick?: number;
  cooldown?: number;
  /** Set once the hazard has hit or been dodged, so one roll clears one attack. */
  resolved?: boolean;
  update?(dt: number): void;
  label: string;
}

/** An announced impact, used by the autoplay bot to decide when to dodge. */
export interface Threat {
  pos: THREE.Vector3;
  radius: number;
  at: number;
}

export type BossEvent = 'awake' | 'staggered' | 'recovered' | 'phase2' | 'dying' | 'dead';
export type HitKind = 'normal' | 'weak' | 'armor' | 'heal' | 'player';

/** The slice of the game the boss and the party are allowed to touch. */
export interface World {
  time: number;
  scene: THREE.Scene;
  fx: Fx;
  audio: AudioSys;
  arena: Arena;
  hazards: Hazard[];
  threats: Threat[];
  player: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean };
  addHazard(h: Hazard): Hazard;
  /** Resolve an instantaneous hit against the player right now. */
  strike(h: Omit<Hazard, 'life'>): void;
  hitstop(seconds: number): void;
  slowmo(seconds: number, scale: number): void;
  damageNumber(pos: THREE.Vector3, amount: number, kind: HitKind): void;
  onBossEvent(e: BossEvent): void;
}
