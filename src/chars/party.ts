import * as THREE from 'three';
import {
  clamp, dampAngle, distPointSegment, moveAngle, yawForward, yawLeft, yawOf, rand,
} from '../core/math';
import type { Input } from '../core/input';
import type { Hazard, World } from '../types';
import type { BossPart, Colossus } from '../boss/colossus';
import { ARENA_RADIUS } from '../world/arena';
import { PARTY, START_INDEX, TUNING, type CharDef, type MoveDef } from './defs';
import type { CharVisual } from './visual';

export interface Member {
  def: CharDef;
  hp: number;
  stamina: number;
  alive: boolean;
  visual: CharVisual;
  staminaDelay: number;
  /** Symbeline's tempo stacks. */
  encore: number;
  /** Deux's Flare quickening stacks. */
  kindle: number;
  healPending: number;
}

type State = 'free' | 'attack' | 'roll' | 'hurt' | 'down' | 'dead' | 'swapIn';

interface Projectile {
  kind: 'ember' | 'chakram';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: BossPart | null;
  goal: THREE.Vector3;
  life: number;
  move: MoveDef;
  owner: Member;
  bonus: number;
  mesh: THREE.Object3D;
  returning: boolean;
  hitOut: boolean;
  hitBack: boolean;
  curve: number;
}

export interface PartyEvents {
  toast(text: string, kind?: 'good' | 'bad' | 'info'): void;
  hurt(amount: number, heavy: boolean): void;
  defeat(): void;
  swapped(index: number): void;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** The player's side: four Knights, one on the field at a time, and everything they throw. */
export class Party {
  members: Member[] = [];
  active = START_INDEX;
  pos = new THREE.Vector3(0, 0, 26);
  vel = new THREE.Vector3();
  yaw = Math.PI;
  state: State = 'free';
  stateT = 0;
  /** Generic invulnerability timer (swap-in, getting up). */
  iframes = 0;
  swapCD = 0;
  cureCharges = TUNING.cureCharges;
  cureCD = 0;
  sinceHit = 99;
  lock: BossPart | null = null;
  /** Cinematics take the controls away and make the party untouchable. */
  cinematic = false;
  sprinting = false;
  swapBuff = 0;
  stats = { damage: 0, hitsTaken: 0, dodges: 0, perfects: 0, swaps: 0, cures: 0, taken: {} as Record<string, number> };

  private move: MoveDef | null = null;
  private moveWindup = 0;
  private comboIndex = -1;
  private fired = false;
  private hitDone = false;
  private queued: 'light' | 'heavy' | 'roll' | null = null;
  private bonus = 1;
  private rollDir = new THREE.Vector3();
  private perfect = false;
  private aoeTarget = new THREE.Vector3();
  private aimPart: BossPart | null = null;
  private projectiles: Projectile[] = [];
  private ghost: { member: Member; t: number } | null = null;
  private blockers: { x: number; z: number; r: number }[] = [];
  private lastBossState = '';
  private fxGroup = new THREE.Group();
  private deadTimer = 0;

  constructor(
    private world: World,
    private input: Input,
    private getBoss: () => Colossus,
    private events: PartyEvents,
    visuals: CharVisual[],
  ) {
    world.scene.add(this.fxGroup);
    PARTY.forEach((def, i) => {
      const visual = visuals[i];
      visual.root.visible = false;
      world.scene.add(visual.root);
      this.members.push({ def, hp: def.hp, stamina: def.stamina, alive: true, visual, staminaDelay: 0, encore: 0, kindle: 0, healPending: 0 });
    });
    this.reset();
  }

  get cur() {
    return this.members[this.active];
  }

  get anyAlive() {
    return this.members.some((m) => m.alive);
  }

  reset() {
    for (const p of this.projectiles) this.fxGroup.remove(p.mesh);
    this.projectiles.length = 0;
    this.members.forEach((m, i) => {
      m.hp = m.def.hp;
      m.stamina = m.def.stamina;
      m.alive = true;
      m.encore = m.kindle = m.healPending = 0;
      m.staminaDelay = 0;
      m.visual.root.visible = i === START_INDEX;
      m.visual.setOpacity(1);
      m.visual.play('idle', { fade: 0 });
    });
    this.active = START_INDEX;
    this.pos.set(0, 0, 26);
    this.vel.set(0, 0, 0);
    this.yaw = Math.PI;
    this.state = 'free';
    this.stateT = 0;
    this.iframes = 0;
    this.swapCD = 0;
    this.cureCharges = TUNING.cureCharges;
    this.cureCD = 0;
    this.sinceHit = 99;
    this.lock = null;
    this.move = null;
    this.ghost = null;
    this.swapBuff = 0;
    this.cinematic = false;
    this.stats = { damage: 0, hitsTaken: 0, dodges: 0, perfects: 0, swaps: 0, cures: 0, taken: {} };
    this.syncVisual(0);
  }

  // ---------------------------------------------------------------- lock-on

  private lockCandidates() {
    const boss = this.getBoss();
    if (boss.state === 'dead' || boss.state === 'dying' || boss.state === 'dormant') return [];
    return boss.parts.filter((p) => p.lockable);
  }

  defaultLock(): BossPart | null {
    const boss = this.getBoss();
    const c = this.lockCandidates();
    if (!c.length) return null;
    const core = c.find((p) => p.id === 'core') ?? null;
    if (boss.state === 'staggered' || this.cur.def.ranged) return core;
    // Melee: whatever can actually be reached from the ground.
    let best: BossPart | null = null;
    let bestD = Infinity;
    for (const p of c) {
      if (p.pos.y > 4.6) continue;
      const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ?? core;
  }

  toggleLock() {
    this.lock = this.lock ? null : this.defaultLock();
  }

  cycleLock() {
    const c = this.lockCandidates();
    if (!c.length) return;
    const i = this.lock ? c.indexOf(this.lock) : -1;
    this.lock = c[(i + 1) % c.length];
  }

  private validateLock() {
    const boss = this.getBoss();
    if (boss.state !== this.lastBossState) {
      // Staggering exposes the core; recovering hides it again. Retarget for the player.
      if (this.lock && (boss.state === 'staggered' || this.lastBossState === 'staggered')) this.lock = this.defaultLock();
      this.lastBossState = boss.state;
    }
    if (this.lock && (!this.lock.lockable || !this.lockCandidates().length)) this.lock = this.defaultLock();
  }

  /** What an attack should aim at: the lock target, else a sensible default. */
  private pickAim(move: MoveDef): BossPart | null {
    if (this.lock) return this.lock;
    const c = this.lockCandidates();
    if (!c.length) return null;
    if (move.kind !== 'melee') return c.find((p) => p.id === 'core') ?? c[0];
    // Soft melee assist: something reachable, close, and roughly in front.
    const fwd = yawForward(this.yaw, _a);
    let best: BossPart | null = null;
    let bestD = 7;
    for (const p of c) {
      if (p.pos.y > 4.6) continue;
      const dx = p.pos.x - this.pos.x;
      const dz = p.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < bestD && (dx * fwd.x + dz * fwd.z) / Math.max(0.01, d) > 0.2) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- actions

  private startMove(move: MoveDef, comboIndex: number, bonus = 1): boolean {
    const m = this.cur;
    if (m.stamina <= 0) return false;
    m.stamina = Math.max(-25, m.stamina - move.stamina);
    m.staminaDelay = TUNING.staminaDelay;
    this.move = move;
    this.comboIndex = comboIndex;
    this.bonus = bonus;
    this.state = 'attack';
    this.stateT = 0;
    this.fired = false;
    this.hitDone = false;
    this.queued = null;
    this.moveWindup = move.windup;
    if (move.id === 'deux_h') this.moveWindup = Math.max(0.5, move.windup - m.kindle * TUNING.kindleCast);
    this.aimPart = this.pickAim(move);
    if (this.aimPart) this.yaw = moveAngle(this.yaw, yawOf(this.aimPart.pos.x - this.pos.x, this.aimPart.pos.z - this.pos.z), move.kind === 'melee' ? 1.2 : 4);
    m.visual.act(move.anim, this.moveWindup, move.active, move.recovery);
    if (move.kind === 'aoe') {
      this.world.audio.play(move.sfx, { volume: 0.8, rate: move.windup / this.moveWindup });
      this.updateAoeTarget();
    }
    return true;
  }

  private updateAoeTarget() {
    if (this.aimPart) this.aoeTarget.copy(this.aimPart.pos);
    else yawForward(this.yaw, this.aoeTarget).multiplyScalar(11).add(this.pos).setY(1.5);
  }

  private startRoll(ix: number, iz: number, mag: number) {
    const m = this.cur;
    const r = m.def.roll;
    m.stamina = Math.max(-25, m.stamina - r.cost);
    m.staminaDelay = TUNING.staminaDelay;
    if (mag > 0.15) {
      this.rollDir.set(ix, 0, iz).normalize();
      this.yaw = yawOf(this.rollDir.x, this.rollDir.z);
    } else {
      // No direction held: hop backwards without turning.
      yawForward(this.yaw, this.rollDir).negate();
    }
    this.state = 'roll';
    this.stateT = 0;
    this.perfect = false;
    this.move = null;
    this.queued = null;
    m.visual.play(r.kind, { duration: r.duration, fade: 0.05 });
    this.world.audio.play(r.kind === 'blink' ? 'blink' : 'roll', { volume: 0.6 });
    if (r.kind === 'blink') this.blinkFx();
  }

  private blinkFx() {
    _a.copy(this.pos).setY(this.cur.def.height * 0.5);
    this.world.fx.burst(_a, 24, { color: 0xa66bff, color2: 0xff5a8a, intensity: 2.5, speed: [1, 6], size: [0.15, 0.4], life: [0.25, 0.6] });
    this.world.fx.flash(_a, 0xa66bff, 3, 0.2, 1.5);
  }

  trySwap(index: number, free = false): boolean {
    const next = this.members[index];
    if (!next || index === this.active || !next.alive) return false;
    if (!free && this.swapCD > 0) return false;
    const old = this.cur;
    old.visual.root.visible = false;
    if (this.ghost?.member === next) this.ghost = null;
    next.visual.setOpacity(1);
    this.active = index;
    next.visual.root.visible = true;
    this.state = 'swapIn';
    this.stateT = 0;
    this.iframes = TUNING.swapIFrames;
    this.perfect = false;
    this.move = null;
    this.queued = null;
    this.swapCD = free ? 0.4 : TUNING.swapCooldown;
    this.stats.swaps++;
    next.visual.play('swapIn', { duration: 0.38, fade: 0 });
    const { fx, audio } = this.world;
    _a.copy(this.pos).setY(1);
    fx.burst(_a, 30, { color: old.def.color, intensity: 2, speed: [2, 7], size: [0.15, 0.4], life: [0.3, 0.7] });
    fx.flash(_a, next.def.color, 5, 0.3, 1.6);
    fx.ring(this.pos, { r0: 0.4, r1: 3, life: 0.35, color: next.def.color, intensity: 2 });
    audio.play('swap', { volume: 0.7 });
    if (this.lock) this.lock = this.defaultLock();
    this.syncVisual(0);
    this.events.swapped(index);
    return true;
  }

  private nextAlive(dir: 1 | -1): number {
    for (let k = 1; k <= this.members.length; k++) {
      const i = (this.active + dir * k + this.members.length * 4) % this.members.length;
      if (this.members[i].alive) return i;
    }
    return this.active;
  }

  private swapInputs(): boolean {
    const input = this.input;
    for (let i = 0; i < 4; i++) {
      if (input.consume(`swap${i + 1}` as 'swap1')) {
        if (this.trySwap(i)) return true;
        if (i !== this.active && this.members[i]?.alive === false) this.events.toast(`${this.members[i].def.name.split(' ')[0]} has fallen`, 'bad');
      }
    }
    if (input.consume('swapNext')) return this.trySwap(this.nextAlive(1));
    if (input.consume('swapPrev')) return this.trySwap(this.nextAlive(-1));
    return false;
  }

  /** Ghalus's Cure: only while he rests off-field. */
  cure(): boolean {
    const g = this.members.find((m) => m.def.id === 'ghalus')!;
    const who = this.cur;
    if (!g.alive) this.events.toast('Ghalus has fallen — no healing', 'bad');
    else if (g === who) this.events.toast('Ghalus cannot Cure while fighting', 'info');
    else if (this.cureCharges <= 0) this.events.toast('No Cure left', 'bad');
    else if (this.cureCD > 0) this.events.toast('Cure is not ready', 'info');
    else {
      this.cureCharges--;
      this.cureCD = TUNING.cureCooldown;
      this.stats.cures++;
      who.healPending += who.def.hp * TUNING.cureAmount;
      for (const m of this.members) if (m.alive && m !== who) m.hp = Math.min(m.def.hp, m.hp + m.def.hp * TUNING.cureBench);
      const { fx, audio } = this.world;
      audio.play('heal', { volume: 0.9 });
      fx.pillar(this.pos, 1.6, 9, 0x8ff0d2, 1.0, 1.4);
      fx.ring(this.pos, { r0: 0.5, r1: 4, life: 0.7, color: 0x8ff0d2, intensity: 2 });
      _a.copy(this.pos).setY(0.4);
      fx.burst(_a, 40, { color: 0x8ff0d2, color2: 0xfff2b0, intensity: 2.2, speed: [1, 5], dir: UP, spread: 0.35, radius: 1.2, size: [0.12, 0.3], life: [0.6, 1.3] });
      this.world.damageNumber(_a.setY(who.def.height + 0.4), who.def.hp * TUNING.cureAmount, 'heal');
      // His apparition steps in beside the active Knight to cast.
      const left = yawLeft(this.yaw, _b);
      const back = yawForward(this.yaw, _c);
      g.visual.root.position.copy(this.pos).addScaledVector(left, 1.3).addScaledVector(back, -0.7);
      g.visual.root.rotation.y = this.yaw;
      g.visual.root.visible = true;
      g.visual.setOpacity(0.55);
      g.visual.act('channel', 0.45, 0.15, 0.6);
      this.ghost = { member: g, t: 1.2 };
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- taking hits

  /** Called by the game when a boss hazard overlaps the active Knight. */
  takeHit(h: Omit<Hazard, 'life'>): 'hit' | 'dodged' | 'ignored' {
    if (this.cinematic || this.state === 'dead') return 'ignored';
    const m = this.cur;
    const r = m.def.roll;
    const rolling = this.state === 'roll' && this.stateT >= r.iStart && this.stateT <= r.iEnd;
    if (rolling || this.iframes > 0 || this.state === 'down') {
      if (this.state !== 'down') this.stats.dodges++;
      // "Perfect" means dodging at the last moment: the blow lands just after the roll starts.
      const lastMoment = rolling ? this.stateT <= r.iStart + TUNING.perfectWindow : this.state === 'swapIn' && this.stateT <= TUNING.perfectWindow;
      if (!this.perfect && lastMoment) {
        this.perfect = true;
        this.onPerfect(rolling ? 'dodge' : 'swap');
      }
      return 'dodged';
    }
    const { fx, audio } = this.world;
    const armored = this.state === 'attack' && !!this.move?.hyperArmor && this.stateT > 0.12;
    const dmg = h.damage * (armored ? TUNING.hyperArmorSoak : 1);
    m.hp -= dmg;
    m.encore = 0;
    this.sinceHit = 0;
    this.stats.hitsTaken++;
    this.stats.taken[h.label] = Math.round((this.stats.taken[h.label] ?? 0) + dmg);
    const from = h.from ?? h.center;
    _a.set(this.pos.x - from.x, 0, this.pos.z - from.z);
    if (_a.lengthSq() < 0.01) yawForward(this.yaw, _a).negate();
    _a.normalize();
    _b.copy(this.pos).setY(m.def.height * 0.6);
    fx.burst(_b, 18, { color: 0xff3030, intensity: 2, speed: [2, 8], size: [0.12, 0.3], life: [0.25, 0.6], gravity: 8 });
    this.world.damageNumber(_b.setY(m.def.height + 0.3), dmg, 'player');
    m.visual.tint(0xff2020, 1);
    fx.shake(h.heavy ? 0.55 : 0.3);
    this.events.hurt(dmg / m.def.hp, !!h.heavy);
    if (m.hp <= 0) {
      this.die();
      return 'hit';
    }
    audio.play('player_hurt', { volume: 0.9 });
    const knock = h.knock ?? 5;
    if (armored) {
      this.vel.addScaledVector(_a, knock * 0.25);
    } else if (h.heavy) {
      this.state = 'down';
      this.stateT = 0;
      this.move = null;
      this.vel.copy(_a).multiplyScalar(knock);
      m.visual.play('down', { duration: TUNING.downTime, fade: 0.06 });
    } else {
      this.state = 'hurt';
      this.stateT = 0;
      this.move = null;
      this.vel.copy(_a).multiplyScalar(knock * 0.6);
      m.visual.play('hurt', { duration: TUNING.hurtTime, fade: 0.04 });
    }
    return 'hit';
  }

  private onPerfect(kind: 'dodge' | 'swap') {
    const m = this.cur;
    this.stats.perfects++;
    this.world.slowmo(0.4, TUNING.perfectDodgeSlow);
    this.world.audio.play('perfect', { volume: 0.7 });
    m.stamina = Math.min(m.def.stamina, m.stamina + TUNING.perfectDodgeStamina);
    if (m.def.id === 'symbeline') m.encore = Math.min(TUNING.encoreMax, m.encore + 2);
    _a.copy(this.pos).setY(1);
    this.world.fx.ring(this.pos, { r0: 0.5, r1: 4.5, life: 0.4, color: 0xffffff, intensity: 2.5 });
    if (kind === 'swap') {
      this.swapBuff = 6;
      this.events.toast('PERFECT SWAP', 'good');
    } else this.events.toast('PERFECT DODGE', 'good');
  }

  private die() {
    const m = this.cur;
    m.hp = 0;
    m.alive = false;
    m.encore = m.kindle = 0;
    this.state = 'dead';
    this.stateT = 0;
    this.move = null;
    this.vel.multiplyScalar(0.3);
    this.deadTimer = 1.5;
    m.visual.play('dead', { duration: 1.1, fade: 0.06 });
    this.world.audio.play('player_down', { volume: 1 });
    this.events.toast(`${m.def.name.split(' ')[0]} has fallen`, 'bad');
    if (!this.anyAlive) this.events.defeat();
  }

  // ---------------------------------------------------------------- dealing damage

  private damageScale(m: Member, move: MoveDef) {
    let s = this.bonus;
    if (m.def.id === 'symbeline') s *= 1 + m.encore * TUNING.encorePer;
    if (move.id === 'deux_h') s *= 1 + m.kindle * TUNING.kindleDamage;
    if (this.swapBuff > 0) s *= 1.25;
    return s;
  }

  /** Apply one hit of `move` to a boss part, with all the feedback that goes with it. */
  hitPart(part: BossPart, move: MoveDef, owner: Member, hitPos: THREE.Vector3, scale = 1): number {
    const boss = this.getBoss();
    const { fx, audio } = this.world;
    const dealt = boss.takeDamage(part, move.damage * scale, move.stagger * scale, hitPos);
    if (dealt <= 0) return 0;
    this.stats.damage += dealt;
    const big = move.damage >= 90;
    if (part.weak) {
      fx.burst(hitPos, big ? 60 : 24, { color: 0xffffff, color2: 0xbfe0ff, intensity: 3.5, speed: [4, 20], size: [0.14, 0.45], life: [0.3, 0.9], gravity: 6 });
      fx.flash(hitPos, 0xffffff, big ? 9 : 4, 0.2, 2.5);
      audio.play('hit_weak', { volume: big ? 1 : 0.7 });
    } else if (part.armor) {
      fx.burst(hitPos, 8, { color: 0x9aa4c8, intensity: 1.2, speed: [3, 10], size: [0.08, 0.2], life: [0.2, 0.5], gravity: 14 });
      audio.play('hit', { volume: 0.45, rate: 1.5 });
    } else {
      fx.burst(hitPos, big ? 40 : 16, { color: move.color, color2: 0xffffff, intensity: 2.5, speed: [4, 16], size: [0.12, 0.35], life: [0.25, 0.7], gravity: 12 });
      fx.flash(hitPos, move.color, big ? 6 : 3, 0.18, 1.8);
      audio.play(big ? 'hit_heavy' : 'hit', { volume: big ? 1 : 0.75 });
    }
    if (move.hitstop) this.world.hitstop(move.hitstop * (part.weak ? 1.4 : 1));
    if (move.shake) fx.shake(move.shake);
    if (owner.def.id === 'symbeline') owner.encore = Math.min(TUNING.encoreMax, owner.encore + 1);
    if (move.id === 'deux_l') owner.kindle = Math.min(TUNING.kindleMax, owner.kindle + 1);
    return dealt;
  }

  private meleeHit(move: MoveDef) {
    const boss = this.getBoss();
    const fwd = yawForward(this.yaw, _a);
    const cx = this.pos.x + fwd.x * move.reach!;
    const cz = this.pos.z + fwd.z * move.reach!;
    _b.set(cx, 0.4, cz);
    _c.set(cx, 3.3, cz);
    let best: BossPart | null = null;
    for (const p of boss.parts) {
      if (distPointSegment(p.pos, _b, _c) > move.radius! + p.r) continue;
      if (!best || Number(p.weak) > Number(best.weak) || (p.weak === best.weak && p.mult > best.mult)) best = p;
    }
    if (!best) return;
    this.hitDone = true;
    // Contact point: on the part's surface, toward the attacker.
    const hit = new THREE.Vector3(this.pos.x, clamp(best.pos.y, 0.8, 2.6), this.pos.z).sub(best.pos);
    const d = hit.length();
    hit.multiplyScalar(Math.min(1, best.r / Math.max(0.01, d))).add(best.pos);
    this.hitPart(best, move, this.cur, hit, this.damageScale(this.cur, move));
  }

  private fire(move: MoveDef) {
    const m = this.cur;
    const { fx, audio } = this.world;
    const cast = m.visual.castPoint(new THREE.Vector3());
    const scale = this.damageScale(m, move);
    switch (move.kind) {
      case 'melee': {
        audio.play(move.sfx, { volume: 0.7 });
        if (move.arc) {
          _a.copy(this.pos).setY(m.def.height * 0.58);
          fx.slashArc({ pos: _a, yaw: this.yaw, radius: move.arc.radius, color: move.color, duration: move.active + 0.05, tilt: move.arc.tilt, mirror: move.arc.mirror, sweep: move.arc.sweep, pitch: move.arc.pitch, intensity: move.damage > 150 ? 2.6 : 1.7 });
        }
        if (move.id === 'sig_h') {
          // The heavy cleave cracks the ground in front of him.
          const f = yawForward(this.yaw, _a).multiplyScalar(move.reach!).add(this.pos);
          fx.ring(f, { r0: 0.5, r1: 4.5, life: 0.45, color: 0x8e2cff, intensity: 2.5 });
          fx.puff(f.setY(0.3), 10, { speed: [2, 6] });
          fx.burst(f, 30, { color: 0x8e2cff, color2: 0xff2a55, intensity: 2.5, speed: [3, 14], dir: UP, spread: 0.7, size: [0.15, 0.4], life: [0.3, 0.8], gravity: 12 });
        }
        break;
      }
      case 'bolt': {
        audio.play(move.sfx, { volume: 0.6 });
        this.spawnProjectile('ember', move, cast, scale);
        break;
      }
      case 'boomerang': {
        audio.play(move.sfx, { volume: 0.7 });
        this.spawnProjectile('chakram', move, cast, scale, 1);
        this.spawnProjectile('chakram', move, cast, scale, -1);
        break;
      }
      case 'ray': {
        audio.play(move.sfx, { volume: 0.7 });
        const part = this.aimPart;
        const end = part ? part.pos.clone() : yawForward(this.yaw, new THREE.Vector3()).multiplyScalar(30).add(cast);
        if (part) {
          // Stop the ray on the part's surface.
          _a.subVectors(cast, end).normalize();
          end.addScaledVector(_a, part.r * 0.9);
          this.hitPart(part, move, m, end, scale);
        }
        fx.line(cast, end, move.color, 0.16, 0.22, 4);
        fx.flash(cast, move.color, 2, 0.15, 2);
        break;
      }
      case 'aoe': {
        this.detonate(move, m, scale);
        break;
      }
    }
  }

  private detonate(move: MoveDef, m: Member, scale: number) {
    const boss = this.getBoss();
    const { fx, audio } = this.world;
    const c = this.aoeTarget;
    const R = move.aoeRadius!;
    if (move.id === 'deux_h') {
      fx.blast(c, R * 1.25, 0xff5a1a, 0.55, 3);
      fx.flash(c, 0xffb060, R * 5, 0.45, 3);
      fx.burst(c, 140, { color: 0xff4a10, color2: 0xffd070, intensity: 3.2, speed: [5, 30], size: [0.2, 0.7], life: [0.4, 1.3], gravity: 5 });
      fx.puff(c, 20, { color: 0x30201c, color2: 0x151010, speed: [2, 9], size: [2, 4.5], life: [0.8, 1.8], radius: R * 0.5 });
      audio.play('explode', { volume: 1 });
      m.kindle = 0;
      const hit = boss.partsInSphere(c, R)[0];
      if (hit) this.hitPart(hit, move, m, hit.pos.clone().lerp(c, 0.5), scale);
      else fx.shake(0.4);
    } else {
      // Sanctum: a pillar of light, hitting whatever stands in the column.
      const ground = _a.set(c.x, 0, c.z);
      fx.pillar(ground, R, 46, 0xfff2b0, 0.9, 2.6);
      fx.ring(ground, { r0: R * 0.3, r1: R * 1.4, life: 0.6, color: 0xfff2b0, intensity: 2.5 });
      fx.burst(_b.set(c.x, 1, c.z), 90, { color: 0xfff2b0, color2: 0xffffff, intensity: 3, speed: [3, 20], dir: UP, spread: 0.4, radius: R * 0.8, size: [0.15, 0.5], life: [0.5, 1.4] });
      audio.play('holy_burst', { volume: 1 });
      const hit = boss.parts
        .filter((p) => Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < R + p.r)
        .sort((p, q) => Number(q.weak) - Number(p.weak) || q.mult - p.mult)[0];
      if (hit) this.hitPart(hit, move, m, hit.pos.clone(), scale);
      else fx.shake(0.3);
    }
  }

  private spawnProjectile(kind: Projectile['kind'], move: MoveDef, from: THREE.Vector3, bonus: number, curve = 0) {
    let mesh: THREE.Object3D;
    if (kind === 'ember') {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.world.fx.glowTex, color: new THREE.Color(move.color).multiplyScalar(4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      sprite.scale.setScalar(1.9);
      mesh = sprite;
    } else {
      mesh = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 8, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.3, 0.6) }));
    }
    const target = this.aimPart;
    const goal = target ? target.pos.clone() : yawForward(this.yaw, new THREE.Vector3()).multiplyScalar(move.range ?? 14).add(from);
    if (!target && kind === 'chakram') goal.copy(yawForward(this.yaw, _a)).multiplyScalar(13).add(from);
    const speed = kind === 'ember' ? 38 : 30;
    const vel = goal.clone().sub(from).normalize();
    if (curve) vel.addScaledVector(yawLeft(this.yaw, _a), curve * 0.5).normalize();
    vel.multiplyScalar(speed);
    mesh.position.copy(from);
    this.fxGroup.add(mesh);
    this.projectiles.push({ kind, pos: from.clone(), vel, target, goal, life: kind === 'ember' ? 2.2 : 3.2, move, owner: this.cur, bonus, mesh, returning: false, hitOut: false, hitBack: false, curve });
  }

  private updateProjectiles(dt: number) {
    const boss = this.getBoss();
    const { fx } = this.world;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      let done = p.life <= 0;
      if (p.kind === 'ember') {
        if (p.target) {
          // Steer toward the (moving) target.
          _a.subVectors(p.target.pos, p.pos).normalize().multiplyScalar(p.vel.length());
          p.vel.lerp(_a, 1 - Math.exp(-9 * dt));
        }
        p.pos.addScaledVector(p.vel, dt);
        fx.burst(p.pos, 2, { color: p.move.color, color2: 0xffd070, intensity: 2.5, speed: [0, 1.5], size: [0.15, 0.4], life: [0.15, 0.35] });
        const hit = boss.partsInSphere(p.pos, 0.55)[0];
        if (hit) {
          this.hitPart(hit, p.move, p.owner, p.pos.clone(), p.bonus);
          done = true;
        }
        if (p.pos.y < 0) done = true;
      } else {
        const speed = p.returning ? 36 : 30;
        if (!p.returning) {
          if (p.target) p.goal.copy(p.target.pos);
          _a.subVectors(p.goal, p.pos);
          const d = _a.length();
          _a.normalize().multiplyScalar(speed);
          p.vel.lerp(_a, 1 - Math.exp(-6 * dt));
          if (d < 1.4 || p.life < 2.55) p.returning = true;
        } else {
          _a.copy(this.pos).setY(1.2).sub(p.pos);
          const d = _a.length();
          _a.normalize().multiplyScalar(speed);
          p.vel.lerp(_a, 1 - Math.exp(-7 * dt));
          if (d < 1.3) done = true;
        }
        p.pos.addScaledVector(p.vel, dt);
        p.mesh.rotation.x = Math.PI / 2;
        p.mesh.rotation.z += dt * 30;
        fx.burst(p.pos, 1, { color: 0xffd34a, intensity: 2, speed: [0, 1], size: [0.12, 0.3], life: [0.12, 0.3] });
        const can = p.returning ? !p.hitBack : !p.hitOut;
        if (can) {
          const hit = boss.partsInSphere(p.pos, 0.8)[0];
          if (hit) {
            this.hitPart(hit, p.move, p.owner, p.pos.clone(), p.bonus);
            if (p.returning) p.hitBack = true;
            else {
              p.hitOut = true;
              p.returning = true;
            }
          }
        }
      }
      p.mesh.position.copy(p.pos);
      if (done) {
        this.fxGroup.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- update

  update(dt: number, camYaw: number) {
    const input = this.input;
    const m = this.cur;
    const def = m.def;
    const { fx } = this.world;
    this.stateT += dt;
    this.iframes = Math.max(0, this.iframes - dt);
    this.swapCD = Math.max(0, this.swapCD - dt);
    this.cureCD = Math.max(0, this.cureCD - dt);
    this.swapBuff = Math.max(0, this.swapBuff - dt);
    this.sinceHit += dt;
    this.sprinting = false;

    // Movement intent in world space
    let ix = 0;
    let iz = 0;
    if (!this.cinematic) {
      if (input.worldMove) {
        ix = input.worldMove.x;
        iz = input.worldMove.z;
      } else {
        const s = Math.sin(camYaw);
        const c = Math.cos(camYaw);
        ix = s * input.move.y - c * input.move.x;
        iz = c * input.move.y + s * input.move.x;
      }
    }
    const mag = Math.min(1, Math.hypot(ix, iz));

    if (!this.cinematic) {
      if (input.consume('lock')) this.toggleLock();
      if (input.consume('lockNext')) this.cycleLock();
    }
    this.validateLock();

    switch (this.state) {
      case 'free': {
        if (this.cinematic) {
          this.vel.multiplyScalar(Math.max(0, 1 - 12 * dt));
          m.visual.play('idle');
          break;
        }
        if (this.swapInputs()) break;
        if (input.consume('heal')) this.cure();
        if (input.consume('roll') && m.stamina > 0) {
          this.startRoll(ix, iz, mag);
          break;
        }
        if (input.consume('light') && this.startMove(def.light[0], 0)) break;
        if (input.consume('heavy') && this.startMove(def.heavy, -1)) break;
        const sprint = input.sprint && mag > 0.2 && m.stamina > 0;
        this.sprinting = sprint;
        const speed = (sprint ? def.sprint : def.speed) * mag;
        if (sprint) {
          m.stamina -= TUNING.sprintDrain * dt;
          m.staminaDelay = 0.3;
        }
        const k = 1 - Math.exp(-14 * dt);
        this.vel.x += (ix / Math.max(0.001, mag) * speed - this.vel.x) * k;
        this.vel.z += (iz / Math.max(0.001, mag) * speed - this.vel.z) * k;
        if (this.lock && !sprint) {
          this.yaw = dampAngle(this.yaw, yawOf(this.lock.pos.x - this.pos.x, this.lock.pos.z - this.pos.z), 14, dt);
        } else if (mag > 0.1) this.yaw = dampAngle(this.yaw, yawOf(ix, iz), 13, dt);
        if (mag > 0.1) {
          m.visual.play('move');
          m.visual.setMoveSpeed(speed / def.speed);
        } else m.visual.play('idle');
        break;
      }

      case 'attack': {
        const move = this.move!;
        const w = this.moveWindup;
        const t = this.stateT;
        const end = w + move.active + move.recovery;
        if (input.consume('light', 0.45)) this.queued = 'light';
        if (input.consume('heavy', 0.45)) this.queued = 'heavy';
        if (input.consume('roll', 0.35)) this.queued = 'roll';
        if (this.swapInputs()) break;
        if (input.consume('heal')) this.cure();
        // Keep turning toward the target until the blow commits.
        if (t < w && this.aimPart) {
          this.yaw = moveAngle(this.yaw, yawOf(this.aimPart.pos.x - this.pos.x, this.aimPart.pos.z - this.pos.z), (move.kind === 'melee' ? 5 : 9) * dt);
        }
        // Step into melee swings.
        const fwd = yawForward(this.yaw, _a);
        const lungeStart = w * 0.5;
        const lungeEnd = w + move.active;
        if (move.lunge && t > lungeStart && t < lungeEnd) {
          const v = move.lunge / (lungeEnd - lungeStart);
          this.vel.set(fwd.x * v, 0, fwd.z * v);
        } else this.vel.multiplyScalar(Math.max(0, 1 - 16 * dt));

        if (move.kind === 'aoe' && t < w) {
          if (t < w - 0.25) this.updateAoeTarget();
          // Gathering light at the staff and a growing mark on the target.
          const cast = m.visual.castPoint(_b);
          fx.burst(cast, 2, { color: move.color, intensity: 3, speed: [-5, -2], radius: 1.6, size: [0.12, 0.3], life: [0.25, 0.4] });
          const k = t / w;
          if (rand() < 0.5) fx.burst(this.aoeTarget, 1, { color: move.color, intensity: 2 + k * 3, speed: [-(4 + k * 6), -2], radius: move.aoeRadius! * (1 - k * 0.5), size: [0.2, 0.5], life: [0.25, 0.45] });
        }
        if (move.id === 'sig_h' && t < w) {
          _b.copy(this.pos).setY(1.2);
          fx.burst(_b, 2, { color: 0x8e2cff, color2: 0xff2a55, intensity: 2.2, speed: [-6, -3], radius: 2.4, size: [0.12, 0.3], life: [0.3, 0.5] });
        }
        if (!this.fired && t >= w) {
          this.fired = true;
          this.fire(move);
        }
        if (move.kind === 'melee' && t >= w && t < w + move.active + 0.03 && !this.hitDone) this.meleeHit(move);

        const cancelAt = w + move.active + move.recovery * (move.cancelAt ?? 0.45);
        if (t >= cancelAt && this.queued) {
          const q = this.queued;
          this.queued = null;
          if (q === 'roll') {
            if (m.stamina > 0) {
              this.startRoll(ix, iz, mag);
              break;
            }
          } else if (q === 'light') {
            const next = this.comboIndex >= 0 ? (this.comboIndex + 1) % def.light.length : 0;
            if (this.startMove(def.light[next], next)) break;
          } else if (this.startMove(def.heavy, -1)) break;
        }
        if (t >= end) {
          this.state = 'free';
          this.move = null;
        }
        break;
      }

      case 'roll': {
        const r = def.roll;
        const k = this.stateT / r.duration;
        const v = (r.distance / r.duration) * (1.6 - 1.2 * Math.min(1, k));
        this.vel.set(this.rollDir.x * v, 0, this.rollDir.z * v);
        if (r.kind === 'blink') m.visual.root.visible = !(k > 0.1 && k < 0.82);
        if (input.consume('light', 0.3)) this.queued = 'light';
        if (input.consume('heavy', 0.3)) this.queued = 'heavy';
        if (k >= 1) {
          m.visual.root.visible = true;
          if (r.kind === 'blink') this.blinkFx();
          this.state = 'free';
          const q = this.queued;
          this.queued = null;
          if (q === 'light') this.startMove(def.light[0], 0);
          else if (q === 'heavy') this.startMove(def.heavy, -1);
        }
        break;
      }

      case 'swapIn': {
        this.vel.multiplyScalar(Math.max(0, 1 - 10 * dt));
        if (input.consume('light', 0.4)) this.queued = 'light';
        if (input.consume('heavy', 0.4)) this.queued = 'heavy';
        if (this.stateT >= 0.3) {
          this.state = 'free';
          const q = this.queued;
          this.queued = null;
          // Arriving with an attack already called hits harder.
          if (q === 'light') this.startMove(def.light[0], 0, TUNING.swapAttackBonus);
          else if (q === 'heavy') this.startMove(def.heavy, -1, TUNING.swapAttackBonus);
        }
        break;
      }

      case 'hurt': {
        this.vel.multiplyScalar(Math.max(0, 1 - 6 * dt));
        if (this.stateT >= TUNING.hurtTime) this.state = 'free';
        break;
      }

      case 'down': {
        this.vel.multiplyScalar(Math.max(0, 1 - 4 * dt));
        if (this.stateT >= TUNING.downTime) {
          this.state = 'free';
          this.iframes = 0.35;
        }
        break;
      }

      case 'dead': {
        this.vel.multiplyScalar(Math.max(0, 1 - 5 * dt));
        this.deadTimer -= dt;
        if (this.deadTimer <= 0 && this.anyAlive) {
          m.visual.root.visible = false;
          this.trySwap(this.nextAlive(1), true);
        }
        break;
      }
    }

    // Resources
    for (const mm of this.members) {
      if (!mm.alive) continue;
      const isActive = mm === this.cur;
      mm.staminaDelay -= dt;
      if (!isActive) mm.stamina = Math.min(mm.def.stamina, mm.stamina + TUNING.offFieldStaminaRegen * dt);
      else if (mm.staminaDelay <= 0 && this.state !== 'attack' && this.state !== 'roll') {
        mm.stamina = Math.min(mm.def.stamina, mm.stamina + TUNING.staminaRegen * dt);
      }
      if (mm.healPending > 0) {
        const h = Math.min(mm.healPending, mm.def.hp * 0.5 * dt);
        mm.healPending -= h;
        mm.hp = Math.min(mm.def.hp, mm.hp + h);
      }
    }
    const ghalus = this.members.find((x) => x.def.id === 'ghalus')!;
    if (ghalus.alive && ghalus !== this.cur) {
      for (const mm of this.members) {
        if (!mm.alive) continue;
        if (mm === this.cur) {
          if (this.sinceHit > TUNING.regenDelay) mm.hp = Math.min(mm.def.hp, mm.hp + TUNING.regenActive * dt);
        } else mm.hp = Math.min(mm.def.hp, mm.hp + TUNING.regenBench * dt);
      }
    }

    // Integrate and collide
    this.pos.addScaledVector(this.vel, dt);
    const r = Math.hypot(this.pos.x, this.pos.z);
    const maxR = ARENA_RADIUS - 1.2;
    if (r > maxR) this.pos.multiplyScalar(maxR / r);
    for (const b of this.getBoss().blockers(this.blockers)) {
      const dx = this.pos.x - b.x;
      const dz = this.pos.z - b.z;
      const d = Math.hypot(dx, dz);
      const min = b.r + 0.45;
      if (d < min) {
        const push = d > 0.001 ? (min - d) / d : 0;
        this.pos.x += dx * push || 0.01;
        this.pos.z += dz * push;
      }
    }
    this.pos.y = 0;

    this.updateProjectiles(dt);
    this.syncVisual(dt);

    if (this.ghost) {
      this.ghost.t -= dt;
      const g = this.ghost.member;
      g.visual.update(dt);
      g.visual.setOpacity(clamp(this.ghost.t * 1.5, 0, 0.55));
      if (this.ghost.t <= 0) {
        g.visual.root.visible = false;
        g.visual.setOpacity(1);
        this.ghost = null;
      }
    }
  }

  private syncVisual(dt: number) {
    const v = this.cur.visual;
    v.root.position.copy(this.pos);
    v.root.rotation.y = this.yaw;
    if (dt > 0) v.update(dt);
  }

  /** Turn toward a point (used while a cinematic has the controls). */
  face(p: THREE.Vector3, dt: number) {
    this.yaw = dampAngle(this.yaw, yawOf(p.x - this.pos.x, p.z - this.pos.z), 8, dt);
  }
}
