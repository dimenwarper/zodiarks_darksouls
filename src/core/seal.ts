import * as THREE from 'three';
import { TAU } from './math';

/**
 * The rune of Zodiark, after the one in the Knights' opening film (zodiarks_video, rune.py):
 * two rings with a band of runes between them, a twelve-point star drawn point to point with
 * the twelve signs at its tips, and an angular Z sealed at its heart. It is a drawing made of
 * pen strokes, each with the moment it is written, so it can draw itself.
 *
 * Drawings are in unit coordinates, y down, as on a page seen from above.
 */
export type Pt = [number, number];

export interface Stroke {
  pts: Pt[];
  /** Progress (0..1) at which the pen starts and lifts. */
  t0: number;
  t1: number;
  /** Line width, as a fraction of the drawing's radius. */
  width: number;
  /** 0 = the outer rings, 1 = the star, 2 = the heart: each can turn at its own speed. */
  group: number;
  /** The zodiac sign (0..11) it belongs to, else -1. */
  sign: number;
}

const TOP = -Math.PI / 2;
/** Radii of the seal's parts as fractions of its own. */
export const SEAL = { out: 1, band: 0.925, star: 0.78, sign: 0.852, inner: 0.404, core: 0.33, signR: 0.058 };

/** Its own generator, so drawing a seal never disturbs the game's seeded dice. */
function dice(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(a: T[]): T => a[Math.floor(next() * a.length)] };
}
type Dice = ReturnType<typeof dice>;

/** A full turn starting at `a0`; clockwise as seen on the page. */
function circle(r: number, a0: number, cw = true, n = 240, cx = 0, cy = 0): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (TAU * i * (cw ? 1 : -1)) / (n - 1);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/**
 * The {n/step} star as the segments that show: every chord is drawn up to the inner seal,
 * the pen passes under it and comes out the other side.
 */
function starSegments(r: number, rSeal: number, t0: number, t1: number, n = 12, step = 5) {
  const tips: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = TOP + (TAU * ((i * step) % n)) / n;
    tips.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const chord = Math.hypot(tips[1][0] - tips[0][0], tips[1][1] - tips[0][1]);
  const total = chord * n;
  const at = (len: number) => t0 + ((t1 - t0) * len) / total;
  const segs: { pts: Pt[]; t0: number; t1: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = tips[i];
    const b = tips[i + 1];
    const ux = (b[0] - a[0]) / chord;
    const uy = (b[1] - a[1]) / chord;
    const au = a[0] * ux + a[1] * uy;
    const half = Math.sqrt(Math.max(0, rSeal * rSeal - (r * r - au * au)));
    const s1 = -au - half;
    const s2 = -au + half;
    const base = i * chord;
    segs.push({ pts: [a, [a[0] + ux * s1, a[1] + uy * s1]], t0: at(base), t1: at(base + s1) });
    segs.push({ pts: [[a[0] + ux * s2, a[1] + uy * s2], b], t0: at(base + s2), t1: at(base + chord) });
  }
  return segs;
}

/** A Futhark-like rune, x in [-0.5, 0.5], y in [-1, 1] (y up): a stem with branches, or an X, diamond or arrow. */
export function runeGlyph(d: Dice): Pt[][] {
  if (d.next() < 0.8) {
    const strokes: Pt[][] = [[[0, -1], [0, 1]]];
    const n = d.pick([1, 1, 2, 2, 3]);
    for (let i = 0; i < n; i++) {
      const s = d.pick([-1, 1]);
      const y0 = d.pick([1, 1 / 3, -1 / 3]);
      const kind = d.pick(['diag', 'diag', 'hook', 'flag']);
      if (kind === 'diag') strokes.push([[0, y0], [0.5 * s, Math.max(-1, y0 - 2 / 3)]]);
      else if (kind === 'hook') strokes.push([[0, y0], [0.5 * s, y0 - 1 / 3], [0, Math.max(-1, y0 - 2 / 3)]]);
      else strokes.push([[0, y0], [0.5 * s, Math.min(1, y0 + 1 / 3)], [0.5 * s, Math.max(-1, y0 - 1 / 3)]]);
    }
    return strokes;
  }
  const kind = d.pick(['x', 'diamond', 'arrow']);
  if (kind === 'x') return [[[-0.5, -1], [0.5, 1]], [[0.5, -1], [-0.5, 1]]];
  if (kind === 'diamond') return [[[0, 1], [0.5, 0], [0, -1], [-0.5, 0], [0, 1]]];
  return [[[0, -1], [0, 1]], [[-0.5, 0.4], [0, 1], [0.5, 0.4]]];
}

// ---------------------------------------------------------------- the signs

/** An arc from `d0` to `d1` degrees, y up. */
const A = (cx: number, cy: number, r: number, d0: number, d1: number, n = 12): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((d0 + ((d1 - d0) * i) / n) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
const mirror = (s: Pt[]): Pt[] => s.map(([x, y]) => [-x, y]);
const turned = (s: Pt[]): Pt[] => s.map(([x, y]) => [-x, -y]);
const shift = (s: Pt[], dy: number): Pt[] => s.map(([x, y]) => [x, y + dy]);

const M_STEM: Pt[] = [[-0.85, 0.5], [-0.7, 0.62], [-0.7, -0.55]];
const M_ARCH: Pt[] = [...A(-0.475, 0.38, 0.225, 180, 0, 8), [-0.25, -0.55]];
const WAVE: Pt[] = [[-0.8, 0.12], [-0.53, 0.44], [-0.27, 0.12], [0, 0.44], [0.27, 0.12], [0.53, 0.44], [0.8, 0.12]];
const CRAB: Pt[][] = [A(-0.45, 0.3, 0.22, 90, 450, 16), A(0.05, -0.25, 0.92, 123, 35, 14)];
const FISH = A(-1.2, 0, 0.8, -55, 55, 12);

/**
 * The twelve signs in order from Aries, then the thirteenth, Ophiuchus: each a few pen
 * strokes in a box from -1 to 1, y up.
 */
export const ZODIAC: Pt[][][] = [
  // Aries: two horns from one stem
  [[[0, -0.9], ...A(-0.42, 0.35, 0.42, 0, 205, 14)], A(0.42, 0.35, 0.42, 180, -25, 14)],
  // Taurus: a head under a crescent of horns
  [A(0, -0.35, 0.5, 90, 450, 24), A(0, 0.85, 0.7, 205, 335, 14)],
  // Gemini: two pillars between two bows
  [A(0, 1.6, 1.0, 228, 312, 10), A(0, -1.6, 1.0, 132, 48, 10), [[-0.3, 0.646], [-0.3, -0.646]], [[0.3, 0.646], [0.3, -0.646]]],
  // Cancer: two claws, one the other turned about
  [...CRAB, ...CRAB.map(turned)],
  // Leo: a mane sweeping into a tail
  [A(-0.45, -0.25, 0.22, 90, 450, 16), [...A(0, 0.2, 0.5, 207, -20, 18), [0.3, -0.55], ...A(0.52, -0.55, 0.22, 180, 320, 8)]],
  // Virgo: an M whose last leg loops back on itself
  [M_STEM, M_ARCH, [...A(-0.025, 0.38, 0.225, 180, 0, 8), [0.2, -0.5], [0.42, -0.85]], [...A(0.38, -0.02, 0.3, 127, -140, 12), [-0.02, -0.8]]],
  // Libra: the sun setting on the horizon
  [[[-0.8, -0.6], [0.8, -0.6]], [[-0.8, -0.2], ...A(0, 0.15, 0.45, 231, -51, 16), [0.8, -0.2]]],
  // Scorpio: an M whose last leg ends in a sting
  [M_STEM, M_ARCH, [...A(-0.025, 0.38, 0.225, 180, 0, 8), [0.2, -0.45], ...A(0.42, -0.45, 0.22, 180, 290, 6), [0.85, -0.3]], [[0.55, -0.3], [0.85, -0.3], [0.85, -0.6]]],
  // Sagittarius: the arrow
  [[[-0.75, -0.75], [0.75, 0.75]], [[0.2, 0.75], [0.75, 0.75], [0.75, 0.2]], [[-0.6, 0], [0, -0.6]]],
  // Capricorn: a horn and a knotted tail
  [[[-0.85, 0.6], [-0.6, 0.6], [-0.3, -0.4], ...A(0.1, 0.35, 0.25, 180, 0, 8), [0.35, -0.4]], A(0.57, -0.4, 0.22, 180, 540, 16), [[0.35, -0.4], [0.25, -0.75], [-0.05, -0.88]]],
  // Aquarius: two waves
  [WAVE, shift(WAVE, -0.56)],
  // Pisces: two fish bound together
  [FISH, mirror(FISH), [[-0.4, 0], [0.4, 0]]],
  // Ophiuchus: the bearer and the serpent across him
  [
    [[-0.5, 0.8], ...A(0, -0.25, 0.5, 180, 360, 12), [0.5, 0.8]],
    Array.from({ length: 19 }, (_, i) => [-0.9 + i * 0.1, 0.3 + 0.16 * Math.sin((i / 18) * TAU)] as Pt),
  ],
];

/** Sign `k` as strokes of a drawing, centred on (cx, cy), `size` from its middle to its edge, its top toward `up` (radians, y down). */
export function signStrokes(k: number, cx: number, cy: number, size: number, up: number, o: { t0?: number; width?: number; group?: number; sign?: number } = {}): Stroke[] {
  const ux = Math.cos(up);
  const uy = Math.sin(up);
  return ZODIAC[k].map((st, m) => {
    const t0 = (o.t0 ?? 0) + 0.012 * m;
    return {
      // The sign's own right is a quarter turn clockwise from its top.
      pts: st.map(([x, y]) => [cx + (-uy * x + ux * y) * size, cy + (ux * x + uy * y) * size] as Pt),
      t0,
      t1: t0 + 0.025,
      width: o.width ?? 0.0035,
      group: o.group ?? 0,
      sign: o.sign ?? -1,
    };
  });
}

/** A band of runes written around a circle of radius `r`, each `h` tall; for rings that are not the seal's. */
export function runeBand(r: number, h: number, count: number, seed: number, width: number): Stroke[] {
  const d = dice(seed);
  const out: Stroke[] = [];
  for (let j = 0; j < count; j++) {
    const a = (TAU * (j + 0.5)) / count;
    const ur: Pt = [Math.cos(a), Math.sin(a)];
    const ut: Pt = [-Math.sin(a), Math.cos(a)];
    for (const st of runeGlyph(d)) {
      out.push({
        pts: st.map(([x, y]) => [(r + (y * h) / 2) * ur[0] + x * h * 0.6 * ut[0], (r + (y * h) / 2) * ur[1] + x * h * 0.6 * ut[1]] as Pt),
        t0: 0, t1: 1, width, group: 0, sign: -1,
      });
    }
  }
  return out;
}

/** A line of runes written along x from 0 to `length`, each `h` tall, centred on y = 0. */
export function runeLine(length: number, h: number, count: number, seed: number, width: number): Stroke[] {
  const d = dice(seed);
  const out: Stroke[] = [];
  for (let j = 0; j < count; j++) {
    const cx = (length * (j + 0.5)) / count;
    for (const st of runeGlyph(d)) {
      out.push({ pts: st.map(([x, y]) => [cx + x * h * 0.6, (-y * h) / 2] as Pt), t0: 0, t1: 1, width, group: 0, sign: -1 });
    }
  }
  return out;
}

/** A straight rule along x from 0 to `length` at height `y`, in enough pieces to be bent round a band. */
export function ruleStroke(length: number, y: number, width: number, n = 96): Stroke {
  return { pts: Array.from({ length: n + 1 }, (_, i) => [(length * i) / n, y] as Pt), t0: 0, t1: 1, width, group: 0, sign: -1 };
}

/** The {n/step} star in one closed stroke. */
export function starStroke(r: number, n: number, step: number, width: number): Stroke {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = TOP + (TAU * ((i * step) % n)) / n;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return { pts, t0: 0, t1: 1, width, group: 0, sign: -1 };
}

export function ringStroke(r: number, width: number, n = 96, cx = 0, cy = 0): Stroke {
  return { pts: circle(r, 0, true, n, cx, cy), t0: 0, t1: 1, width, group: 0, sign: -1 };
}

function buildSeal(): Stroke[] {
  const d = dice(1337);
  const S: Stroke[] = [];
  // Widths are the film's: pixels on a circle a thousand across, drawn a little heavier.
  const add = (pts: Pt[], t0: number, t1: number, w: number, group: number, sign = -1) => S.push({ pts, t0, t1, width: (w / 1000) * 1.6, group, sign });
  // The two outer rings sweep round in opposite directions,
  add(circle(SEAL.out, TOP, true), 0.0, 0.3, 5.0, 0);
  add(circle(SEAL.band, Math.PI / 2, false), 0.03, 0.33, 3.5, 0);
  // with the band of runes inscribed right behind the outer ring's pen.
  const n = 44;
  const rb = (SEAL.out + SEAL.band) / 2;
  for (let j = 0; j < n; j++) {
    const a = TOP + (TAU * (j + 0.5)) / n;
    const ta = 0.02 + (0.3 * (j + 0.5)) / n;
    runeGlyph(d).forEach((st, m) => {
      const pts = st.map(([x, y]) => [(rb + y * 0.026) * Math.cos(a) - x * 0.03 * Math.sin(a), (rb + y * 0.026) * Math.sin(a) + x * 0.03 * Math.cos(a)] as Pt);
      add(pts, ta + 0.012 * m, ta + 0.012 * m + 0.03, 2.4, 0);
    });
  }
  // The star's circle, then the twelve-point star, point to point.
  add(circle(SEAL.star, TOP, true), 0.2, 0.44, 4.0, 1);
  for (const s of starSegments(SEAL.star, SEAL.inner, 0.36, 0.66)) add(s.pts, s.t0, s.t1, 4.0, 1);
  // A little circle at each tip, and the sign written into it as it closes.
  for (let k = 0; k < 12; k++) {
    const a = TOP + (TAU * k) / 12;
    const cx = SEAL.sign * Math.cos(a);
    const cy = SEAL.sign * Math.sin(a);
    add(circle(SEAL.signR, a, true, 48, cx, cy), 0.5 + 0.016 * k, 0.55 + 0.016 * k, 2.8, 1, k);
    S.push(...signStrokes(k, cx, cy, SEAL.signR * 0.6, a, { t0: 0.55 + 0.016 * k, group: 1, sign: k }));
  }
  // The inner circle through the star's crossings.
  add(circle(SEAL.inner, Math.PI / 2, false), 0.52, 0.72, 3.5, 1);
  // The heart: a ring, the Z of Zodiark in one stroke, and its crossbar.
  add(circle(SEAL.core, TOP, false, 120), 0.66, 0.78, 3.5, 2);
  add([[-0.2, -0.12], [-0.2, -0.21], [0.2, -0.21], [-0.2, 0.21], [0.2, 0.21], [0.2, 0.12]], 0.78, 0.94, 11.0, 2);
  add([[-0.12, 0], [0.12, 0]], 0.92, 0.98, 9.0, 2);
  return S;
}

// ---------------------------------------------------------------- strokes into geometry

export interface RibbonOpts {
  /** Where a point of the drawing sits in space; by default flat on the ground, y down the page = +z. */
  place?: (x: number, y: number, out: THREE.Vector3) => void;
  /** Multiplier on every stroke's width. */
  widen?: number;
}

/**
 * Strokes as flat ribbons. Besides position each vertex carries `aT` (when the pen reaches
 * it), `aSide` (-1..1 across the line), `aGroup` and `aSign`.
 */
export function ribbon(strokes: Stroke[], opts: RibbonOpts = {}): THREE.BufferGeometry {
  const pos: number[] = [];
  const time: number[] = [];
  const side: number[] = [];
  const group: number[] = [];
  const sign: number[] = [];
  const index: number[] = [];
  const place = opts.place ?? ((x: number, y: number, out: THREE.Vector3) => out.set(x, 0, y));
  const v = new THREE.Vector3();
  for (const s of strokes) {
    const hw = (s.width * (opts.widen ?? 1)) / 2;
    const pts = s.pts.map((p) => [p[0], p[1]] as Pt);
    const n = pts.length;
    if (n < 2) continue;
    const closed = n > 2 && Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) < 1e-6;
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1] || 1;
    if (!closed) {
      // Square caps, so strokes that meet at a point close the corner between them.
      const cap = (end: Pt, toward: Pt) => {
        const dx = end[0] - toward[0];
        const dy = end[1] - toward[1];
        const len = Math.hypot(dx, dy) || 1;
        end[0] += (dx / len) * hw;
        end[1] += (dy / len) * hw;
      };
      cap(pts[0], pts[1]);
      cap(pts[n - 1], pts[n - 2]);
    }
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? pts[i - 1] : closed ? pts[n - 2] : null;
      const next = i < n - 1 ? pts[i + 1] : closed ? pts[1] : null;
      let ax = prev ? pts[i][0] - prev[0] : 0;
      let ay = prev ? pts[i][1] - prev[1] : 0;
      let bx = next ? next[0] - pts[i][0] : 0;
      let by = next ? next[1] - pts[i][1] : 0;
      const al = Math.hypot(ax, ay);
      const bl = Math.hypot(bx, by);
      if (al > 1e-9) { ax /= al; ay /= al; } else { ax = bx / (bl || 1); ay = by / (bl || 1); }
      if (bl > 1e-9) { bx /= bl; by /= bl; } else { bx = ax; by = ay; }
      let tx = ax + bx;
      let ty = ay + by;
      const tl = Math.hypot(tx, ty);
      if (tl > 1e-6) { tx /= tl; ty /= tl; } else { tx = ax; ty = ay; }
      const nx = -ty;
      const ny = tx;
      // Mitre the corner, but not to a needle.
      const m = Math.min(2.5, 1 / Math.max(0.2, nx * -ay + ny * ax));
      const t = s.t0 + ((s.t1 - s.t0) * cum[i]) / total;
      for (const sd of [1, -1]) {
        place(pts[i][0] + nx * hw * m * sd, pts[i][1] + ny * hw * m * sd, v);
        pos.push(v.x, v.y, v.z);
        time.push(t);
        side.push(sd);
        group.push(s.group);
        sign.push(s.sign);
      }
      if (i) index.push(base + 2 * i - 2, base + 2 * i - 1, base + 2 * i, base + 2 * i - 1, base + 2 * i + 1, base + 2 * i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(time, 1));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  geo.setAttribute('aGroup', new THREE.Float32BufferAttribute(group, 1));
  geo.setAttribute('aSign', new THREE.Float32BufferAttribute(sign, 1));
  geo.setIndex(index);
  return geo;
}

// ---------------------------------------------------------------- the seal itself

const SEAL_VS = /* glsl */ `
  attribute float aT; attribute float aSide; attribute float aGroup; attribute float aSign;
  uniform vec3 uSpin; uniform vec3 uTint[12];
  varying float vT; varying float vSide; varying float vR; varying vec3 vTint;
  void main() {
    float ang = aGroup < 0.5 ? uSpin.x : (aGroup < 1.5 ? uSpin.y : uSpin.z);
    float c = cos(ang), s = sin(ang);
    vec3 p = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);
    vT = aT; vSide = aSide; vR = length(position.xz);
    vTint = aSign < -0.5 ? vec3(0.0) : uTint[int(aSign + 0.5)];
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const SEAL_FS = /* glsl */ `
  uniform float uProgress; uniform float uLevel; uniform float uFlare; uniform float uOpacity;
  uniform float uWave; uniform float uWaveGain; uniform vec3 uCore; uniform vec3 uGlow;
  varying float vT; varying float vSide; varying float vR; varying vec3 vTint;
  void main() {
    if (vT > uProgress) discard;
    float edge = smoothstep(1.0, 0.25, abs(vSide));
    // The stretch just written still burns: the pen's glowing tip and the tail behind it.
    float pen = uProgress < 1.0 ? exp(-(uProgress - vT) * 70.0) : 0.0;
    float wave = exp(-pow((vR - uWave) * 9.0, 2.0)) * uWaveGain;
    vec3 col = mix(uGlow, uCore, edge * 0.75) * (uLevel + uFlare) + uCore * (pen * 3.5 + wave) + vTint;
    gl_FragColor = vec4(col * edge, uOpacity);
  }`;
const SHADE_VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SHADE_FS = /* glsl */ `
  uniform float uShade; varying vec2 vUv;
  void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, uShade * smoothstep(1.0, 0.7, length(vUv - 0.5) * 2.0)); }`;

let sealStrokes: Stroke[] | null = null;
let sealGeo: THREE.BufferGeometry | null = null;
let shadeGeo: THREE.BufferGeometry | null = null;

function pointAlong(pts: Pt[], f: number, out: Pt) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let want = Math.min(1, Math.max(0, f)) * total;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (want <= len || i === pts.length - 1) {
      const u = len > 0 ? Math.min(1, want / len) : 0;
      out[0] = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u;
      out[1] = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u;
      return;
    }
    want -= len;
  }
}

/**
 * One seal in the world, lying flat: `obj` is placed and turned by whoever made it. Set
 * `progress` to draw it; `level`, `flare` and the waves make it burn; `release` lets it fade.
 */
export class Seal {
  readonly obj = new THREE.Group();
  /** How much of it has been drawn, 0..1. */
  progress = 0;
  /** Standing brightness of its lines (above 1 blooms). */
  level = 1.5;
  /** Extra brightness that dies away by itself. */
  flare = 0;
  /** How dark the ground under it goes. */
  shade = 0.55;
  /** Turning speed in radians a second of the rings, the star and the heart. */
  spinRate: [number, number, number] = [0, 0, 0];
  private spin = new THREE.Vector3();
  private mat: THREE.ShaderMaterial;
  private shadeMat: THREE.ShaderMaterial;
  private tints: THREE.Color[] = [];
  private tintGoal: THREE.Color[] = [];
  private waves: { r: number; v: number; to: number; gain: number }[] = [];
  private fade: { t: number; over: number } | null = null;
  private time = 0;
  private shadeMesh: THREE.Mesh;

  constructor(readonly radius: number, core: THREE.ColorRepresentation = 0xfff7d9, glow: THREE.ColorRepresentation = 0xffa640) {
    sealStrokes ??= buildSeal();
    sealGeo ??= ribbon(sealStrokes, { widen: 1.25 });
    shadeGeo ??= new THREE.CircleGeometry(1.08, 56);
    for (let i = 0; i < 12; i++) {
      this.tints.push(new THREE.Color(0, 0, 0));
      this.tintGoal.push(new THREE.Color(0, 0, 0));
    }
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uProgress: { value: 0 }, uLevel: { value: 1 }, uFlare: { value: 0 }, uOpacity: { value: 1 },
        uWave: { value: -9 }, uWaveGain: { value: 0 }, uSpin: { value: this.spin },
        uCore: { value: new THREE.Color(core) }, uGlow: { value: new THREE.Color(glow) }, uTint: { value: this.tints },
      },
      vertexShader: SEAL_VS,
      fragmentShader: SEAL_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.shadeMat = new THREE.ShaderMaterial({
      uniforms: { uShade: { value: 0 } },
      vertexShader: SHADE_VS,
      fragmentShader: SHADE_FS,
      transparent: true,
      depthWrite: false,
    });
    // The children share the group's scale, so offsets are in fractions of the radius.
    const shadeMesh = (this.shadeMesh = new THREE.Mesh(shadeGeo, this.shadeMat));
    shadeMesh.rotation.x = -Math.PI / 2;
    shadeMesh.position.y = -0.03 / radius;
    shadeMesh.renderOrder = 6;
    const lines = new THREE.Mesh(sealGeo, this.mat);
    lines.renderOrder = 7;
    lines.frustumCulled = false;
    this.obj.add(shadeMesh, lines);
    this.obj.scale.setScalar(radius);
  }

  private toWorld(x: number, y: number, group: number, out: THREE.Vector3) {
    const ang = this.spin.getComponent(group);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return this.obj.localToWorld(out.set(x * c - y * s, 0, x * s + y * c));
  }

  /** The star's tip `k` (0 = the top of the page, then clockwise), in the world. */
  tipPos(k: number, out: THREE.Vector3, r = SEAL.star) {
    this.obj.updateMatrixWorld();
    const a = TOP + (TAU * k) / 12;
    return this.toWorld(r * Math.cos(a), r * Math.sin(a), 1, out);
  }

  /** Where the pens are writing at this moment, in the world; returns how many. */
  pens(out: THREE.Vector3[]): number {
    if (this.progress <= 0 || this.progress >= 1) return 0;
    this.obj.updateMatrixWorld();
    const p: Pt = [0, 0];
    let n = 0;
    for (const s of sealStrokes!) {
      if (this.progress < s.t0 || this.progress >= s.t1) continue;
      pointAlong(s.pts, (this.progress - s.t0) / (s.t1 - s.t0), p);
      this.toWorld(p[0], p[1], s.group, (out[n] ??= new THREE.Vector3()));
      n++;
    }
    return n;
  }

  /** Burn sign `k` and its circle in a colour of its own. */
  lightSign(k: number, color: THREE.ColorRepresentation, strength = 3) {
    this.tintGoal[((k % 12) + 12) % 12].set(color).multiplyScalar(strength);
  }

  /** A band of light running across the seal from one radius to another (in fractions of its own). */
  wave(from: number, to: number, seconds: number, gain = 2) {
    this.waves.push({ r: from, v: (to - from) / seconds, to, gain });
  }

  /** Fade out and go. */
  release(seconds = 1) {
    this.fade ??= { t: 0, over: seconds };
  }

  /** Returns false once it has faded away. */
  update(dt: number): boolean {
    this.time += dt;
    this.flare = Math.max(0, this.flare - dt * this.flare * 4.5 - dt * 0.2);
    this.spin.x += this.spinRate[0] * dt;
    this.spin.y += this.spinRate[1] * dt;
    this.spin.z += this.spinRate[2] * dt;
    let opacity = 1;
    if (this.fade) {
      this.fade.t += dt;
      opacity = Math.max(0, 1 - this.fade.t / this.fade.over);
    }
    const u = this.mat.uniforms;
    u.uProgress.value = this.progress;
    u.uLevel.value = this.level * (1 + 0.08 * Math.sin(this.time * 5));
    u.uFlare.value = this.flare;
    u.uOpacity.value = opacity;
    for (let i = 0; i < 12; i++) this.tints[i].lerp(this.tintGoal[i], Math.min(1, dt * 9));
    // One wave at a time is enough to read; the newest wins.
    const w = this.waves[this.waves.length - 1];
    if (w) {
      w.r += w.v * dt;
      u.uWave.value = w.r;
      u.uWaveGain.value = w.gain;
      if ((w.v > 0 && w.r >= w.to) || (w.v < 0 && w.r <= w.to)) this.waves.length = 0;
    } else u.uWaveGain.value = 0;
    this.shadeMesh.visible = this.shade > 0;
    this.shadeMat.uniforms.uShade.value = this.shade * Math.min(1, this.progress * 3) * opacity;
    return opacity > 0;
  }

  dispose() {
    this.mat.dispose();
    this.shadeMat.dispose();
  }
}
