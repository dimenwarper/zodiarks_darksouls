import * as THREE from 'three';
import { distPointSegment, rand, yawOf } from '../core/math';
import type { World } from '../types';
import type { BossPart, Colossus } from '../boss/colossus';
import { ARENA_RADIUS } from '../world/arena';
import { TUNING, type CharId } from './defs';
import type { Controls, Knight } from './knight';
import { FORMATION, type Party } from './party';

interface Dir {
  x: number;
  z: number;
}

/** What a Knight standing where they are ought to do about the boss's attacks, if anything. */
export interface Danger {
  /** Dodge now, this way: the blow is about to land. */
  roll: Dir | null;
  /** Inside an announced impact with time to spare: walk this way to get clear. */
  flee: Dir | null;
  /** Standing in something that keeps burning: step this way. */
  leave: Dir | null;
  /** Something will need dodging within the second: not the moment to start a swing. */
  brace: boolean;
}

const _p = new THREE.Vector3();
const _want = new THREE.Vector3();
const danger: Danger = { roll: null, flee: null, leave: null, brace: false };
const always = () => true;

/**
 * Read the boss's announced impacts and live hazards from one Knight's point of view.
 * `accept` lets a brain decide, once per danger, whether it notices it at all. The result
 * object is shared: use it before calling again.
 */
export function senseDanger(world: World, k: Knight, boss: { x: number; z: number }, accept: (source: object) => boolean = always): Danger {
  const p = k.pos;
  const tbx = boss.x - p.x;
  const tbz = boss.z - p.z;
  danger.roll = danger.flee = danger.leave = null;
  danger.brace = false;
  for (const t of world.threats) {
    const eta = t.at - world.time;
    if (eta < -0.15) continue;
    const dx = p.x - t.pos.x;
    const dz = p.z - t.pos.z;
    const d = Math.hypot(dx, dz);
    // A slam that will throw a shockwave concerns everyone near it, in the circle or not.
    if (t.wave && eta < 0.9 && d < 22) danger.brace = true;
    if (d > t.radius + 1.0 || !accept(t)) continue;
    // Straight out from the centre; from dead centre, sidestep across the boss's line.
    const dir = d < 0.5 ? { x: -tbz, z: tbx } : { x: dx, z: dz };
    if (eta < 0.3) danger.roll = dir;
    else danger.flee = dir;
    if (eta < 1) danger.brace = true;
  }
  for (const h of world.hazards) {
    if (!h.tick && h.seen?.has(k)) continue;
    const dx = h.center.x - p.x;
    const dz = h.center.z - p.z;
    const d = Math.hypot(dx, dz);
    if (h.shape === 'ring') {
      // A shockwave about to arrive: roll through it, toward where it came from.
      const gap = d - h.radius;
      if (gap < -1 || gap > (h.grow ?? 15) * Math.min(1, h.life) || !accept(h)) continue;
      danger.brace = true;
      if (gap < 2.6) danger.roll = { x: dx, z: dz };
    } else if (h.shape === 'capsule') {
      // A sweeping arm: go under it, toward the boss.
      _p.set(p.x, 1, p.z);
      if (distPointSegment(_p, h.center, h.b!) < h.radius + 3.2 && accept(h)) danger.roll = { x: tbx, z: tbz };
    } else if (h.shape === 'circle' && h.label === 'beam') {
      if (d < h.radius + 3.5 && accept(h)) danger.roll = { x: dx, z: dz };
    } else if (h.shape === 'circle' && h.tick) {
      if (d < h.radius + 0.6 && accept(h)) danger.leave = { x: tbx, z: tbz };
    }
  }
  return danger;
}

interface Profile {
  /** Chance of reacting to any one danger. */
  skill: number;
  /** Attacks per burst, and the breather between bursts. */
  burst: [number, number];
  rest: [number, number];
  /** Seconds between heavy attacks. */
  heavy: [number, number];
  /** Casters: how far from the boss to stand, and which side of the leader. */
  standoff?: number;
  bearing?: number;
}

const PROFILE: Record<CharId, Profile> = {
  // The tank: plants himself at the nearest limb and trades blows. Slow to get out of the way.
  sigmund: { skill: 0.72, burst: [2, 3], rest: [1.3, 2.4], heavy: [9, 15] },
  // The skirmisher: quick flurries, circles between them, hard to pin down.
  symbeline: { skill: 0.9, burst: [3, 4], rest: [0.8, 1.6], heavy: [4, 7] },
  // Artillery off the leader's shoulder: embers until Kindle is full, then Flare.
  deux: { skill: 0.8, burst: [2, 3], rest: [1.2, 2.2], heavy: [7, 11], standoff: 16, bearing: 0.9 },
  // The healer at the back: mends first, casts when nobody needs him.
  ghalus: { skill: 0.82, burst: [1, 2], rest: [1.6, 2.8], heavy: [12, 18], standoff: 18.5, bearing: -0.95 },
};

const between = (r: [number, number]) => rand(r[0], r[1]);

/**
 * Plays a Knight the player is not steering: picks a target, keeps a sensible position,
 * attacks in bursts, and gets out of the way of what the boss announces — most of the time.
 */
export class AllyBrain implements Controls {
  moveX = 0;
  moveZ = 0;
  sprint = false;

  private want = { light: false, heavy: false, roll: false };
  private profile: Profile;
  /** One decision per danger: did this Knight see it coming? */
  private reacts = new WeakMap<object, boolean>();
  private accept = (source: object) => {
    let r = this.reacts.get(source);
    if (r === undefined) {
      r = rand() < this.profile.skill * TUNING.allySkill;
      this.reacts.set(source, r);
    }
    return r;
  };
  private rest = 0;
  private burst = 0;
  private seenMoves = 0;
  private heavyCD = 0;
  private mendCD = 0;
  private rollCD = 0;
  private strafe = 1;
  private strafeT = 0;
  private part: BossPart | null = null;
  private slot = new THREE.Vector3();
  private walking = false;
  private cheered = false;

  constructor(
    private k: Knight,
    private party: Party,
    private world: World,
  ) {
    this.profile = PROFILE[k.def.id];
    this.reset();
  }

  take(action: 'light' | 'heavy' | 'roll') {
    const v = this.want[action];
    this.want[action] = false;
    return v;
  }

  reset() {
    this.rest = rand(0.4, 1.4);
    this.burst = 0;
    this.seenMoves = this.k.moves;
    this.heavyCD = between(this.profile.heavy) * 0.5;
    this.mendCD = 3;
    this.rollCD = 0;
    this.part = null;
    this.walking = false;
    this.cheered = false;
  }

  /** The player just let go of this Knight: take a breath before acting on our own. */
  resume() {
    this.rest = rand(0.5, 1.0);
    this.burst = 0;
    this.seenMoves = this.k.moves;
    this.walking = false;
  }

  update(dt: number) {
    const k = this.k;
    const P = this.profile;
    const boss = this.party.getBoss();
    this.moveX = this.moveZ = 0;
    this.sprint = false;
    this.want.light = this.want.heavy = this.want.roll = false;
    this.rest -= dt;
    this.heavyCD -= dt;
    this.mendCD -= dt;
    this.rollCD -= dt;
    this.strafeT -= dt;
    if (k.moves !== this.seenMoves) {
      this.seenMoves = k.moves;
      if (this.burst > 0 && --this.burst === 0) this.rest = between(P.rest);
    }
    k.aim = null;
    if (!k.alive || k.state === 'hurt' || k.state === 'down') return;

    const bs = boss.state;
    const bx = boss.pos.x - k.pos.x;
    const bz = boss.pos.z - k.pos.z;
    const dBoss = Math.hypot(bx, bz) || 1;

    if (bs === 'dormant' || bs === 'intro' || bs === 'dying' || bs === 'dead') {
      // Nothing to fight. Before it wakes, keep in step behind whoever leads the way in.
      if (bs === 'dormant' && k.state === 'free' && this.follow(bx / dBoss, bz / dBoss)) return;
      // Otherwise stand with the others and watch.
      if (k.state === 'free') k.face(boss.pos, dt);
      if (bs === 'dead' && !this.cheered && k.state === 'free') {
        this.cheered = true;
        k.startCast(0.2, 1.9, null, 'cheer');
      }
      this.separate(1);
      return;
    }

    // Danger first.
    const d = senseDanger(this.world, k, boss.pos, this.accept);
    if (d.roll && this.rollCD <= 0 && k.stamina > 0 && (k.state === 'free' || k.state === 'attack' || k.state === 'cast')) {
      this.rollCD = 0.45;
      this.steer(d.roll.x, d.roll.z);
      this.want.roll = true;
      return;
    }
    const away = d.flee ?? d.leave;
    if (away && k.state === 'free') {
      this.steer(away.x, away.z);
      this.sprint = true;
      return;
    }
    // Something is about to need dodging: finish the swing in hand, start nothing new.
    const brace = d.brace || !!away;

    if (bs === 'transition') {
      // The eclipse: it cannot be hurt, so give it room.
      k.aim = boss.parts.find((p) => p.id === 'core') ?? null;
      if (dBoss < 13) this.steer(-bx, -bz);
      this.separate(1);
      return;
    }

    const staggered = bs === 'staggered';
    // Ghalus looks after the wounded before anything else.
    if (k.def.id === 'ghalus' && this.mendCD <= 0 && k.state === 'free' && !brace) {
      const hurt = this.party.mostWounded(TUNING.mendBelow);
      // The full wait starts once the heal lands; a broken channel can be tried again soon.
      if (hurt && this.party.mend(hurt, () => (this.mendCD = TUNING.mendCooldown))) {
        this.mendCD = 1.5;
        return;
      }
    }

    const part = this.pickPart(boss, staggered);
    this.part = part;
    k.aim = part;
    if (!part) return;
    const tx = part.pos.x - k.pos.x;
    const tz = part.pos.z - k.pos.z;
    const td = Math.hypot(tx, tz) || 1;
    const ready = k.state === 'free' && !brace;
    if (brace) {
      this.burst = 0;
      this.rest = Math.max(this.rest, 0.25);
    }
    // Never swing with so little stamina that there would be no dodge left afterwards.
    const reserve = k.def.roll.cost + k.def.light[0].stamina + 6;

    if (P.standoff && !staggered) this.caster(boss, P, dBoss, bx, bz, ready, reserve);
    else if (P.standoff) {
      // The core is exposed: stop repositioning and pour it on.
      if (dBoss < 9) this.steer(-bx, -bz);
      this.volley(P, true, ready, reserve);
    } else {
      const first = k.def.light[0];
      const reach = (first.reach ?? 1.5) + (first.radius ?? 1.5) + part.r - 0.6;
      if (td > reach) {
        this.steer(tx, tz);
        this.sprint = td > reach + 7;
        // Symbeline opens with a thrown chakram on the way in.
        if (k.def.id === 'symbeline' && ready && this.heavyCD <= 0 && td < 15 && td > reach + 2.5 && k.stamina > 40) {
          this.want.heavy = true;
          this.heavyCD = between(P.heavy);
        }
      } else {
        if (this.rest <= 0 && this.burst <= 0) this.burst = Math.round(between(P.burst));
        if (this.burst > 0 && k.stamina > reserve) {
          // Sigmund saves the big swing for an opening.
          if (k.def.id === 'sigmund' && ready && k.stamina > 50 && (staggered || this.heavyCD <= 0)) {
            this.want.heavy = true;
            this.heavyCD = staggered ? 2.5 : between(P.heavy);
          } else this.want.light = true;
        } else if (k.def.id === 'symbeline' && ready) {
          // Between flurries she keeps moving around her mark.
          if (this.strafeT <= 0) {
            this.strafeT = rand(1.2, 2.6);
            this.strafe = rand() < 0.5 ? -1 : 1;
          }
          this.steer(-tz * this.strafe, tx * this.strafe, 0.55);
        }
      }
    }
    this.separate(ready ? 1 : 0);
  }

  /**
   * Walk to this Knight's place in the party's formation, behind the leader as they head for
   * the colossus (`fx`, `fz`: the way to it). Returns false once in place.
   */
  private follow(fx: number, fz: number): boolean {
    const k = this.k;
    const lead = this.party.cur;
    if (!lead.alive) return false;
    const rank = this.party.members.filter((m) => m !== lead).indexOf(k) + 1;
    const [side, back] = FORMATION[rank] ?? FORMATION[1];
    // Formation offsets are (to the leader's left, behind the leader) for a party walking in.
    const sx = lead.pos.x - fx * back - fz * side - k.pos.x;
    const sz = lead.pos.z - fz * back + fx * side - k.pos.z;
    const d = Math.hypot(sx, sz);
    if (d < (this.walking ? 0.5 : 1.6)) {
      this.walking = false;
      return false;
    }
    this.walking = true;
    // Match the leader's pace rather than jogging up and stopping.
    this.steer(sx, sz, Math.min(1, 0.35 + d * 0.3));
    this.sprint = d > 5 && lead.sprinting;
    this.separate(0.6);
    return true;
  }

  private steer(x: number, z: number, amount = 1) {
    const len = Math.hypot(x, z) || 1;
    this.moveX = (x / len) * amount;
    this.moveZ = (z / len) * amount;
  }

  /** Keep a little room between Knights so nobody stands inside anybody. */
  private separate(amount: number) {
    if (amount <= 0) return;
    const k = this.k;
    let px = 0;
    let pz = 0;
    for (const o of this.party.members) {
      if (o === k || !o.alive) continue;
      const dx = k.pos.x - o.pos.x;
      const dz = k.pos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      if (d >= 2.2) continue;
      if (d < 0.01) px += 1;
      else {
        const w = (2.2 - d) / 2.2;
        px += (dx / d) * w;
        pz += (dz / d) * w;
      }
    }
    this.moveX += px * 1.3 * amount;
    this.moveZ += pz * 1.3 * amount;
    const len = Math.hypot(this.moveX, this.moveZ);
    if (len > 1) {
      this.moveX /= len;
      this.moveZ /= len;
    }
  }

  private pickPart(boss: Colossus, staggered: boolean): BossPart | null {
    const parts = boss.parts.filter((p) => p.lockable);
    if (!parts.length) return null;
    const core = parts.find((p) => p.id === 'core') ?? parts[0];
    if (staggered || this.profile.standoff) return core;
    // Melee: the nearest limb in reach from the ground, preferring one nobody else is on.
    const k = this.k;
    let best: BossPart | null = null;
    let bestScore = Infinity;
    for (const p of parts) {
      if (p.pos.y > 4.6) continue;
      let score = Math.hypot(p.pos.x - k.pos.x, p.pos.z - k.pos.z);
      if (p === this.part) score -= 3;
      for (const o of this.party.members) {
        if (o !== k && o.alive && !o.def.ranged && Math.hypot(p.pos.x - o.pos.x, p.pos.z - o.pos.z) < p.r + 3.5) score += 5;
      }
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best ?? core;
  }

  /** Casters hold a spot off the leader's shoulder at range, and cast from there. */
  private caster(boss: Colossus, P: Profile, dBoss: number, bx: number, bz: number, ready: boolean, reserve: number) {
    const k = this.k;
    const lead = this.party.cur;
    const bearing = yawOf(lead.pos.x - boss.pos.x, lead.pos.z - boss.pos.z) + (P.bearing ?? 0);
    const want = _want.set(boss.pos.x + Math.sin(bearing) * P.standoff!, 0, boss.pos.z + Math.cos(bearing) * P.standoff!);
    const r = Math.hypot(want.x, want.z);
    const maxR = ARENA_RADIUS - 3.5;
    if (r > maxR) want.multiplyScalar(maxR / r);
    // Only pick a new spot once the ideal one has drifted well away from the last.
    if (!this.walking && want.distanceTo(this.slot) > 6) this.slot.copy(want);
    const sx = this.slot.x - k.pos.x;
    const sz = this.slot.z - k.pos.z;
    const sd = Math.hypot(sx, sz);
    if (sd > (this.walking ? 1.2 : 3)) {
      this.walking = true;
      this.slot.copy(want);
      this.steer(sx, sz);
      this.sprint = sd > 9;
    } else this.walking = false;
    if (dBoss < P.standoff! - 6) {
      // Too close for comfort, wherever the spot is.
      this.steer(-bx, -bz);
      this.sprint = dBoss < P.standoff! - 9;
    }
    this.volley(P, false, ready && (!this.walking || sd < 8) && !this.sprint, reserve);
  }

  private volley(P: Profile, staggered: boolean, ready: boolean, reserve: number) {
    const k = this.k;
    if (this.rest <= 0 && this.burst <= 0) this.burst = Math.round(between(P.burst));
    if (this.burst <= 0 || k.stamina <= reserve) return;
    const charged = k.def.id === 'deux' ? k.kindle >= TUNING.kindleMax : this.heavyCD <= 0;
    if (ready && k.stamina > 50 && (staggered ? this.heavyCD <= 0 || charged : charged && this.heavyCD <= 0)) {
      this.want.heavy = true;
      this.heavyCD = staggered ? 2.5 : between(P.heavy);
    } else if (ready || k.state === 'attack') this.want.light = true;
  }
}
