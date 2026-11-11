import * as THREE from 'three';
import { clamp, dampAngle, distPointSegment, moveAngle, yawForward, yawOf, rand } from '../core/math';
import type { Hazard, World } from '../types';
import type { SayOpts } from '../core/voice';
import type { BossPart } from '../boss/colossus';
import { ARENA_RADIUS } from '../world/arena';
import { TUNING, type CharDef, type MoveDef } from './defs';
import type { CharVisual } from './visual';
import type { Party } from './party';

export type KnightState = 'free' | 'attack' | 'roll' | 'cast' | 'hurt' | 'down' | 'dead';

/** Whoever is steering a Knight this step: the player's hands, or an ally's own brain. */
export interface Controls {
  /** World-space move direction, length 0..1. */
  moveX: number;
  moveZ: number;
  sprint: boolean;
  /** True once per press. `buffer` is how stale a press may be (only meaningful for a human). */
  take(action: 'light' | 'heavy' | 'roll', buffer?: number): boolean;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * One Knight on the field: a body, its resources and its combat state machine. The same
 * code runs whether the player or an ally brain is supplying the controls.
 */
export class Knight {
  hp: number;
  stamina: number;
  alive = true;
  staminaDelay = 0;
  /** Symbeline's tempo stacks. */
  encore = 0;
  /** Deux's Flare quickening stacks. */
  kindle = 0;
  healPending = 0;

  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = Math.PI;
  state: KnightState = 'free';
  stateT = 0;
  /** Generic invulnerability timer (getting up). */
  iframes = 0;
  sprinting = false;
  /** Under 1 they walk rather than run, and do not sprint (the wary way in). */
  pace = 1;
  sinceHit = 99;
  /** What attacks go for: the player's lock-on, or the part an ally's brain has picked. */
  aim: BossPart | null = null;
  /** Time left in which the first attack after the player takes control hits harder. */
  tagT = 0;
  /** Attacks started so far; lets an ally brain pace its bursts. */
  moves = 0;
  /** Fight totals, for the summary and for tuning. */
  dealt = 0;
  taken = 0;
  /** What brought this Knight down, for the debug summary. */
  fellTo = '';

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
  private casting: { windup: number; end: number; fire: (() => void) | null } | null = null;
  private marker: THREE.Mesh;

  constructor(
    readonly def: CharDef,
    readonly visual: CharVisual,
    private party: Party,
    private world: World,
  ) {
    this.hp = def.hp;
    this.stamina = def.stamina;
    world.scene.add(visual.root);
    // A ring in the Knight's colour marks allies on the ground.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.6, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(def.color).multiplyScalar(1.5), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.marker.position.y = 0.04;
    world.scene.add(this.marker);
  }

  get isLeader() {
    return this.party.cur === this;
  }

  /** Sounds made by allies sit under the player's own. */
  private get vol() {
    return this.isLeader ? 1 : 0.4;
  }

  /** Speak one of this Knight's lines. Allies talk under whoever is being steered. */
  say(line: string, opts: SayOpts = {}) {
    this.world.voice.say(this.def.id, line, {
      ...opts,
      volume: (opts.volume ?? 1) * (this.isLeader ? 1 : 0.6),
      when: () => this.alive || line === 'fallen',
    });
  }

  get firstName() {
    return this.def.name.split(' ')[0];
  }

  reset(x: number, z: number, yaw: number) {
    this.hp = this.def.hp;
    this.stamina = this.def.stamina;
    this.alive = true;
    this.pace = 1;
    this.encore = this.kindle = this.healPending = 0;
    this.staminaDelay = 0;
    this.iframes = 0;
    this.sinceHit = 99;
    this.tagT = 0;
    this.moves = 0;
    this.dealt = this.taken = 0;
    this.fellTo = '';
    this.aim = null;
    this.visual.setOpacity(1);
    this.place(x, z, yaw);
  }

  /** Put the Knight somewhere, standing and idle (cinematics, restarts, revives). */
  place(x: number, z: number, yaw: number) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.state = this.alive ? 'free' : 'dead';
    this.stateT = 0;
    this.move = null;
    this.queued = null;
    this.casting = null;
    this.visual.root.visible = true;
    if (this.alive) this.visual.play('idle', { fade: 0 });
    this.sync(0);
  }

  revive() {
    this.alive = true;
    this.hp = this.def.hp;
    this.place(this.pos.x, this.pos.z, this.yaw);
  }

  /** Turn toward a point; for standing around between fights. */
  /** A scene has taken them mid-stride: come to rest instead of running on the spot. */
  stand() {
    if (!this.alive || this.state !== 'free') return;
    this.vel.set(0, 0, 0);
    this.visual.play('idle');
  }

  face(p: THREE.Vector3, dt: number) {
    this.yaw = dampAngle(this.yaw, yawOf(p.x - this.pos.x, p.z - this.pos.z), 8, dt);
  }

  // ---------------------------------------------------------------- actions

  /** What an attack should go for: the chosen target, else something sensible nearby. */
  private pickAim(move: MoveDef): BossPart | null {
    if (this.aim) return this.aim;
    const boss = this.party.getBoss();
    if (boss.state === 'dead' || boss.state === 'dying' || boss.state === 'dormant') return null;
    const c = boss.parts.filter((p) => p.lockable);
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

  private startMove(move: MoveDef, comboIndex: number): boolean {
    if (this.stamina <= 0) return false;
    this.stamina = Math.max(-25, this.stamina - move.stamina);
    this.staminaDelay = TUNING.staminaDelay;
    this.move = move;
    this.comboIndex = comboIndex;
    // Freshly tagged in: the first blow lands harder.
    this.bonus = this.tagT > 0 ? TUNING.tagBonus : 1;
    this.tagT = 0;
    this.state = 'attack';
    this.stateT = 0;
    this.fired = false;
    this.hitDone = false;
    this.queued = null;
    this.moves++;
    this.moveWindup = move.windup;
    if (move.id === 'deux_h') this.moveWindup = Math.max(0.5, move.windup - this.kindle * TUNING.kindleCast);
    this.aimPart = this.pickAim(move);
    if (this.aimPart) this.yaw = moveAngle(this.yaw, yawOf(this.aimPart.pos.x - this.pos.x, this.aimPart.pos.z - this.pos.z), move.kind === 'melee' ? 1.2 : 4);
    this.visual.act(move.anim, this.moveWindup, move.active, move.recovery);
    if (move === this.def.heavy) this.say('heavy', { priority: 1, chance: this.isLeader ? 0.75 : 0.3, cooldown: 7 });
    else this.say('light', { chance: this.isLeader ? 0.4 : 0.12 });
    if (move.kind === 'aoe') {
      this.world.audio.play(move.sfx, { volume: 0.8 * this.vol, rate: move.windup / this.moveWindup });
      this.updateAoeTarget();
    }
    return true;
  }

  private updateAoeTarget() {
    if (this.aimPart) this.aoeTarget.copy(this.aimPart.pos);
    else yawForward(this.yaw, this.aoeTarget).multiplyScalar(11).add(this.pos).setY(1.5);
  }

  private startRoll(ix: number, iz: number, mag: number) {
    const r = this.def.roll;
    this.stamina = Math.max(-25, this.stamina - r.cost);
    this.staminaDelay = TUNING.staminaDelay;
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
    this.visual.play(r.kind, { duration: r.duration, fade: 0.05 });
    this.world.audio.play(r.kind === 'blink' ? 'blink' : 'roll', { volume: 0.6 * this.vol });
    if (r.kind === 'blink') this.blinkFx();
  }

  private blinkFx() {
    _a.copy(this.pos).setY(this.def.height * 0.5);
    this.world.fx.burst(_a, 24, { color: 0xa66bff, color2: 0xff5a8a, intensity: 2.5, speed: [1, 6], size: [0.15, 0.4], life: [0.25, 0.6] });
    this.world.fx.flash(_a, 0xa66bff, 3, 0.2, 1.5);
  }

  /**
   * Stand and channel (Ghalus's healing, a victory cheer). `fire` runs when the windup ends,
   * unless a hit interrupts it first. Returns false if the Knight is busy.
   */
  startCast(windup: number, recovery: number, fire: (() => void) | null, anim = 'channel'): boolean {
    if (!this.alive || (this.state !== 'free' && this.state !== 'cast')) return false;
    this.state = 'cast';
    this.stateT = 0;
    this.move = null;
    this.queued = null;
    this.casting = { windup, end: windup + 0.15 + recovery, fire };
    if (anim === 'channel') this.visual.act(anim, windup, 0.15, recovery);
    else this.visual.play(anim, { duration: windup + 0.15 + recovery, fade: 0.1 });
    return true;
  }

  // ---------------------------------------------------------------- taking hits

  /** Called by the game when a boss hazard overlaps this Knight. */
  takeHit(h: Omit<Hazard, 'life'>): 'hit' | 'dodged' | 'ignored' {
    if (!this.alive) return 'ignored';
    const lead = this.isLeader;
    const stats = this.party.stats;
    const r = this.def.roll;
    const rolling = this.state === 'roll' && this.stateT >= r.iStart && this.stateT <= r.iEnd;
    if (rolling || this.iframes > 0 || this.state === 'down') {
      if (lead && this.state !== 'down') {
        stats.dodges++;
        // "Perfect" means dodging at the last moment: the blow lands just after the roll starts.
        if (!this.perfect && rolling && this.stateT <= r.iStart + TUNING.perfectWindow) {
          this.perfect = true;
          this.onPerfect();
        }
      }
      // An ally who slips a blow also rides out whatever it throws off, like the shockwave
      // behind a slam. The player has to earn that second dodge.
      if (!lead && rolling) this.iframes = Math.max(this.iframes, 0.4);
      return 'dodged';
    }
    const { fx, audio } = this.world;
    const armored = this.state === 'attack' && !!this.move?.hyperArmor && this.stateT > 0.12;
    // Allies shrug off part of every blow; the boss's full weight is for whoever the player steers.
    const dmg = h.damage * (armored ? TUNING.hyperArmorSoak : 1) * (lead ? 1 : TUNING.allyDamageTaken);
    this.hp -= dmg;
    this.taken += dmg;
    this.encore = 0;
    this.sinceHit = 0;
    if (lead) {
      stats.hitsTaken++;
      stats.taken[h.label] = Math.round((stats.taken[h.label] ?? 0) + dmg);
    } else {
      stats.allyHits++;
      stats.allyTaken[h.label] = Math.round((stats.allyTaken[h.label] ?? 0) + dmg);
    }
    const from = h.from ?? h.center;
    _a.set(this.pos.x - from.x, 0, this.pos.z - from.z);
    if (_a.lengthSq() < 0.01) yawForward(this.yaw, _a).negate();
    _a.normalize();
    _b.copy(this.pos).setY(this.def.height * 0.6);
    fx.burst(_b, lead ? 18 : 10, { color: 0xff3030, intensity: 2, speed: [2, 8], size: [0.12, 0.3], life: [0.25, 0.6], gravity: 8 });
    this.world.damageNumber(_b.setY(this.def.height + 0.3), dmg, 'player');
    this.visual.tint(0xff2020, 1);
    this.visual.root.visible = true;
    if (lead) {
      fx.shake(h.heavy ? 0.55 : 0.3);
      this.party.events.hurt(dmg / this.def.hp, !!h.heavy);
    }
    if (this.hp <= 0) {
      this.fellTo = `${h.label} @${Math.round(this.world.time)}s ${lead ? 'steered' : 'ally'}`;
      this.die();
      return 'hit';
    }
    audio.play('player_hurt', { volume: (h.tick ? 0.5 : 0.9) * this.vol });
    const knock = h.knock ?? 5;
    if (lead && this.hp < this.def.hp * 0.3) this.say('low', { priority: 1, delay: 1.4, cooldown: 45 });
    if (h.tick) {
      // Burning ground hurts but does not stagger, or nobody could ever walk out of it.
    } else if (armored) {
      this.vel.addScaledVector(_a, knock * 0.25);
      this.say('hurt', { chance: 0.4 });
    } else if (h.heavy) {
      this.say('down', { priority: 1, chance: lead ? 1 : 0.45, cooldown: lead ? 8 : 25 });
      this.state = 'down';
      this.stateT = 0;
      this.move = null;
      this.casting = null;
      this.vel.copy(_a).multiplyScalar(knock);
      this.visual.play('down', { duration: TUNING.downTime, fade: 0.06 });
    } else {
      this.state = 'hurt';
      this.stateT = 0;
      this.move = null;
      this.casting = null;
      this.vel.copy(_a).multiplyScalar(knock * 0.6);
      this.visual.play('hurt', { duration: TUNING.hurtTime, fade: 0.04 });
      this.say('hurt', { chance: 0.85 });
    }
    return 'hit';
  }

  private onPerfect() {
    this.party.stats.perfects++;
    this.world.slowmo(0.4, TUNING.perfectDodgeSlow);
    this.world.audio.play('perfect', { volume: 0.7 });
    this.stamina = Math.min(this.def.stamina, this.stamina + TUNING.perfectDodgeStamina);
    if (this.def.id === 'symbeline') this.encore = Math.min(TUNING.encoreMax, this.encore + 2);
    this.world.fx.ring(this.pos, { r0: 0.5, r1: 4.5, life: 0.4, color: 0xffffff, intensity: 2.5 });
    this.party.events.toast('PERFECT DODGE', 'good');
    this.say('dodge', { priority: 1, delay: 0.15, cooldown: 9 });
  }

  private die() {
    this.hp = 0;
    this.alive = false;
    this.encore = this.kindle = 0;
    this.healPending = 0;
    this.state = 'dead';
    this.stateT = 0;
    this.move = null;
    this.casting = null;
    this.vel.multiplyScalar(0.3);
    this.visual.play('dead', { duration: 1.1, fade: 0.06 });
    this.world.audio.play('player_down', { volume: this.isLeader ? 1 : 0.7 });
    this.say('fallen', { priority: 2, volume: this.isLeader ? 1 : 1.5 });
    this.party.onFallen(this);
  }

  // ---------------------------------------------------------------- dealing damage

  private damageScale(move: MoveDef) {
    let s = this.bonus;
    if (this.def.id === 'symbeline') s *= 1 + this.encore * TUNING.encorePer;
    if (move.id === 'deux_h') s *= 1 + this.kindle * TUNING.kindleDamage;
    if (!this.isLeader) s *= TUNING.allyDamage;
    return s;
  }

  private meleeHit(move: MoveDef) {
    const boss = this.party.getBoss();
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
    this.party.hitPart(best, move, this, hit, this.damageScale(move));
  }

  private fire(move: MoveDef) {
    const { fx, audio } = this.world;
    const party = this.party;
    const cast = this.visual.castPoint(new THREE.Vector3());
    const scale = this.damageScale(move);
    const vol = this.vol;
    switch (move.kind) {
      case 'melee': {
        audio.play(move.sfx, { volume: 0.7 * vol });
        if (move.arc) {
          _a.copy(this.pos).setY(this.def.height * 0.58);
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
        audio.play(move.sfx, { volume: 0.6 * vol });
        party.launch(this, 'ember', move, cast, this.aimPart, scale);
        break;
      }
      case 'boomerang': {
        audio.play(move.sfx, { volume: 0.7 * vol });
        party.launch(this, 'chakram', move, cast, this.aimPart, scale, 1);
        party.launch(this, 'chakram', move, cast, this.aimPart, scale, -1);
        break;
      }
      case 'ray': {
        audio.play(move.sfx, { volume: 0.7 * vol });
        const part = this.aimPart;
        const end = part ? part.pos.clone() : yawForward(this.yaw, new THREE.Vector3()).multiplyScalar(30).add(cast);
        if (part) {
          // Stop the ray on the part's surface.
          _a.subVectors(cast, end).normalize();
          end.addScaledVector(_a, part.r * 0.9);
          party.hitPart(part, move, this, end, scale);
        }
        fx.line(cast, end, move.color, 0.16, 0.22, 4);
        fx.flash(cast, move.color, 2, 0.15, 2);
        break;
      }
      case 'aoe': {
        this.detonate(move, scale);
        break;
      }
    }
  }

  private detonate(move: MoveDef, scale: number) {
    const boss = this.party.getBoss();
    const { fx, audio } = this.world;
    const lead = this.isLeader;
    const c = this.aoeTarget;
    const R = move.aoeRadius!;
    if (move.id === 'deux_h') {
      fx.blast(c, R * 1.25, 0xff5a1a, 0.55, 3);
      fx.flash(c, 0xffb060, R * 5, 0.45, 3);
      fx.burst(c, 140, { color: 0xff4a10, color2: 0xffd070, intensity: 3.2, speed: [5, 30], size: [0.2, 0.7], life: [0.4, 1.3], gravity: 5 });
      fx.puff(c, 20, { color: 0x30201c, color2: 0x151010, speed: [2, 9], size: [2, 4.5], life: [0.8, 1.8], radius: R * 0.5 });
      audio.play('explode', { volume: lead ? 1 : 0.55 });
      this.kindle = 0;
      const hit = boss.partsInSphere(c, R)[0];
      if (hit) this.party.hitPart(hit, move, this, hit.pos.clone().lerp(c, 0.5), scale);
      else if (lead) fx.shake(0.4);
    } else {
      // Sanctum: a pillar of light, hitting whatever stands in the column.
      const ground = _a.set(c.x, 0, c.z);
      fx.pillar(ground, R, 46, 0xfff2b0, 0.9, 2.6);
      fx.ring(ground, { r0: R * 0.3, r1: R * 1.4, life: 0.6, color: 0xfff2b0, intensity: 2.5 });
      fx.burst(_b.set(c.x, 1, c.z), 90, { color: 0xfff2b0, color2: 0xffffff, intensity: 3, speed: [3, 20], dir: UP, spread: 0.4, radius: R * 0.8, size: [0.15, 0.5], life: [0.5, 1.4] });
      audio.play('holy_burst', { volume: lead ? 1 : 0.55 });
      const hit = boss.parts
        .filter((p) => Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < R + p.r)
        .sort((p, q) => Number(q.weak) - Number(p.weak) || q.mult - p.mult)[0];
      if (hit) this.party.hitPart(hit, move, this, hit.pos.clone(), scale);
      else if (lead) fx.shake(0.3);
    }
  }

  // ---------------------------------------------------------------- update

  /** Advance one step. `c` is null while a cinematic has everyone standing by. */
  update(dt: number, c: Controls | null) {
    const def = this.def;
    const v = this.visual;
    const { fx } = this.world;
    this.stateT += dt;
    this.iframes = Math.max(0, this.iframes - dt);
    this.tagT = Math.max(0, this.tagT - dt);
    this.sinceHit += dt;
    this.sprinting = false;
    const ix = c?.moveX ?? 0;
    const iz = c?.moveZ ?? 0;
    const mag = Math.min(1, Math.hypot(ix, iz));

    switch (this.state) {
      case 'free': {
        if (!c) {
          // Standing by: a cinematic poses the body directly.
          this.vel.multiplyScalar(Math.max(0, 1 - 12 * dt));
          break;
        }
        if (c.take('roll') && this.stamina > 0) {
          this.startRoll(ix, iz, mag);
          break;
        }
        if (c.take('light') && this.startMove(def.light[0], 0)) break;
        if (c.take('heavy') && this.startMove(def.heavy, -1)) break;
        const sprint = c.sprint && mag > 0.2 && this.stamina > 0 && this.pace >= 1;
        this.sprinting = sprint;
        const speed = (sprint ? def.sprint : def.speed) * mag * this.pace;
        if (sprint) {
          this.stamina -= TUNING.sprintDrain * dt;
          this.staminaDelay = 0.3;
        }
        const k = 1 - Math.exp(-14 * dt);
        this.vel.x += ((ix / Math.max(0.001, mag)) * speed - this.vel.x) * k;
        this.vel.z += ((iz / Math.max(0.001, mag)) * speed - this.vel.z) * k;
        if (this.aim && !sprint) {
          this.yaw = dampAngle(this.yaw, yawOf(this.aim.pos.x - this.pos.x, this.aim.pos.z - this.pos.z), 14, dt);
        } else if (mag > 0.1) this.yaw = dampAngle(this.yaw, yawOf(ix, iz), 13, dt);
        if (mag > 0.1) {
          v.play('move');
          v.setMoveSpeed(speed / def.speed);
        } else v.play('idle');
        break;
      }

      case 'attack': {
        const move = this.move!;
        const w = this.moveWindup;
        const t = this.stateT;
        const end = w + move.active + move.recovery;
        if (c) {
          if (c.take('light', 0.45)) this.queued = 'light';
          if (c.take('heavy', 0.45)) this.queued = 'heavy';
          if (c.take('roll', 0.35)) this.queued = 'roll';
        }
        // Keep turning toward the target until the blow commits.
        if (t < w && this.aimPart) {
          this.yaw = moveAngle(this.yaw, yawOf(this.aimPart.pos.x - this.pos.x, this.aimPart.pos.z - this.pos.z), (move.kind === 'melee' ? 5 : 9) * dt);
        }
        // Step into melee swings.
        const fwd = yawForward(this.yaw, _a);
        const lungeStart = w * 0.5;
        const lungeEnd = w + move.active;
        if (move.lunge && t > lungeStart && t < lungeEnd) {
          const s = move.lunge / (lungeEnd - lungeStart);
          this.vel.set(fwd.x * s, 0, fwd.z * s);
        } else this.vel.multiplyScalar(Math.max(0, 1 - 16 * dt));

        if (move.kind === 'aoe' && t < w) {
          if (t < w - 0.25) this.updateAoeTarget();
          // Gathering light at the staff and a growing mark on the target.
          const cast = v.castPoint(_b);
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
            if (this.stamina > 0) {
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
        const s = (r.distance / r.duration) * (1.6 - 1.2 * Math.min(1, k));
        this.vel.set(this.rollDir.x * s, 0, this.rollDir.z * s);
        if (r.kind === 'blink') v.root.visible = !(k > 0.1 && k < 0.82);
        if (c) {
          if (c.take('light', 0.3)) this.queued = 'light';
          if (c.take('heavy', 0.3)) this.queued = 'heavy';
        }
        if (k >= 1) {
          v.root.visible = true;
          if (r.kind === 'blink') this.blinkFx();
          this.state = 'free';
          const q = this.queued;
          this.queued = null;
          if (q === 'light') this.startMove(def.light[0], 0);
          else if (q === 'heavy') this.startMove(def.heavy, -1);
        }
        break;
      }

      case 'cast': {
        // A channel can be abandoned for a dodge; whatever it was for is lost.
        if (c?.take('roll') && this.stamina > 0) {
          this.casting = null;
          this.startRoll(ix, iz, mag);
          break;
        }
        this.vel.multiplyScalar(Math.max(0, 1 - 12 * dt));
        const k = this.casting;
        if (k?.fire && this.stateT >= k.windup) {
          const f = k.fire;
          k.fire = null;
          f();
        }
        if (!k || this.stateT >= k.end) {
          this.state = 'free';
          this.casting = null;
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
        break;
      }
    }

    // Resources
    if (this.alive) {
      this.staminaDelay -= dt;
      if (this.staminaDelay <= 0 && this.state !== 'attack' && this.state !== 'roll') {
        this.stamina = Math.min(def.stamina, this.stamina + TUNING.staminaRegen * dt);
      }
      if (this.healPending > 0) {
        const h = Math.min(this.healPending, def.hp * 0.5 * dt);
        this.healPending -= h;
        this.hp = Math.min(def.hp, this.hp + h);
      }
    }

    // Integrate and collide
    this.pos.addScaledVector(this.vel, dt);
    const r = Math.hypot(this.pos.x, this.pos.z);
    const maxR = ARENA_RADIUS - 1.2;
    if (r > maxR) this.pos.multiplyScalar(maxR / r);
    for (const b of this.party.blockers) {
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
    this.sync(dt);
  }

  private sync(dt: number) {
    const v = this.visual;
    v.root.position.copy(this.pos);
    v.root.rotation.y = this.yaw;
    if (dt > 0) v.update(dt);
    this.marker.visible = this.alive && !this.isLeader && !this.party.cinematic;
    this.marker.position.x = this.pos.x;
    this.marker.position.z = this.pos.z;
  }
}
