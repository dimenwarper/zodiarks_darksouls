import * as THREE from 'three';

export const TAU = Math.PI * 2;
export type V3 = THREE.Vector3;

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const saturate = (x: number) => clamp(x, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const remap = (x: number, a: number, b: number, c: number, d: number) =>
  lerp(c, d, saturate((x - a) / (b - a)));
/** Frame-rate independent exponential approach. */
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));
export const dampFactor = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);

export function angleDiff(a: number, b: number) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export const wrapAngle = (a: number) => angleDiff(0, a);
export const dampAngle = (a: number, b: number, lambda: number, dt: number) =>
  a + angleDiff(a, b) * dampFactor(lambda, dt);
export const moveAngle = (a: number, b: number, maxStep: number) =>
  a + clamp(angleDiff(a, b), -maxStep, maxStep);

export const ease = {
  linear: (t: number) => t,
  inOut: (t: number) => t * t * (3 - 2 * t),
  in: (t: number) => t * t,
  out: (t: number) => 1 - (1 - t) * (1 - t),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  outBack: (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
};

// Deterministic RNG so automated runs are reproducible.
let seed = 1234567;
export function setSeed(s: number) {
  seed = s >>> 0 || 1;
}
export function rand(a = 1, b?: number) {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  const r = seed / 4294967296;
  return b === undefined ? r * a : a + r * (b - a);
}
export const randSign = () => (rand() < 0.5 ? -1 : 1);
export function pickWeighted<T>(items: { w: number; v: T }[]): T | null {
  let total = 0;
  for (const i of items) total += i.w;
  if (total <= 0) return null;
  let r = rand(total);
  for (const i of items) {
    r -= i.w;
    if (r <= 0) return i.v;
  }
  return items[items.length - 1].v;
}

/** Facing convention: yaw 0 looks down +Z; forward = (sin yaw, 0, cos yaw). */
export const yawForward = (yaw: number, out = new THREE.Vector3()) =>
  out.set(Math.sin(yaw), 0, Math.cos(yaw));
/** Character-left is +X at yaw 0. */
export const yawLeft = (yaw: number, out = new THREE.Vector3()) =>
  out.set(Math.cos(yaw), 0, -Math.sin(yaw));
export const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);
/** Rotate a local (x, y, z) offset by yaw and add to origin. */
export function localToWorld(origin: V3, yaw: number, x: number, y: number, z: number, out = new THREE.Vector3()) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return out.set(origin.x + x * c + z * s, origin.y + y, origin.z - x * s + z * c);
}
export const distXZ = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.z - b.z);

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
/**
 * Analytic two-bone IK. Returns the stretch factor applied to both bones (1 when the
 * target is in reach); the caller decides whether stretching is acceptable.
 */
export function twoBoneIK(
  root: V3,
  target: V3,
  l1: number,
  l2: number,
  pole: V3,
  outMid: V3,
  maxStretch = 1,
  outEnd?: V3,
): number {
  _d.subVectors(target, root);
  let d = _d.length();
  if (d < 1e-4) {
    _d.set(0, -1, 0);
    d = 1e-4;
  }
  _d.divideScalar(d);
  let stretch = 1;
  const reach = l1 + l2;
  if (d > reach * 0.999) {
    stretch = Math.min(maxStretch, d / (reach * 0.999));
    l1 *= stretch;
    l2 *= stretch;
    d = Math.min(d, (l1 + l2) * 0.999);
  }
  d = Math.max(d, Math.abs(l1 - l2) + 1e-3);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-6) _p.set(_d.y, -_d.x, 0);
  _p.normalize();
  outMid.copy(root).addScaledVector(_d, a).addScaledVector(_p, h);
  outEnd?.copy(root).addScaledVector(_d, d);
  return stretch;
}

/** Closest distance from point p to segment ab. */
export function distPointSegment(p: V3, a: V3, b: V3) {
  _d.subVectors(b, a);
  const len2 = _d.lengthSq();
  const t = len2 > 0 ? saturate(_p.subVectors(p, a).dot(_d) / len2) : 0;
  return _p.copy(a).addScaledVector(_d, t).distanceTo(p);
}

/** Generator-based scripting helpers: `yield` hands control back for one sim step and receives dt. */
export type Script = Generator<void, void, number>;
export function* wait(seconds: number): Script {
  let t = 0;
  while (t < seconds) t += yield;
}
export function* tween(seconds: number, fn: (k: number, dt: number) => void): Script {
  let t = 0;
  while (t < seconds) {
    const dt: number = yield;
    t += dt;
    fn(Math.min(1, t / seconds), dt);
  }
}
