import * as THREE from 'three';
import { pickWeighted, yawForward, yawLeft } from '../core/math';
import type { Input } from '../core/input';
import type { World } from '../types';
import type { BossPart, Colossus } from '../boss/colossus';
import { PARTY, START_INDEX, TUNING, type MoveDef } from './defs';
import type { CharVisual } from './visual';
import { Knight, type Controls } from './knight';
import { AllyBrain } from './ally';

interface Projectile {
  kind: 'ember' | 'chakram';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: BossPart | null;
  goal: THREE.Vector3;
  life: number;
  move: MoveDef;
  owner: Knight;
  bonus: number;
  mesh: THREE.Object3D;
  returning: boolean;
  hitOut: boolean;
  hitBack: boolean;
}

export interface PartyEvents {
  toast(text: string, kind?: 'good' | 'bad' | 'info'): void;
  hurt(amount: number, heavy: boolean): void;
  defeat(): void;
  swapped(index: number): void;
  /** A Knight went down. True when the game answers it itself (story dialogue). */
  fallen(k: Knight): boolean;
}

/** The player's hands on whichever Knight they are steering. */
class PlayerControls implements Controls {
  moveX = 0;
  moveZ = 0;
  sprint = false;
  constructor(private input: Input) {}
  take(action: 'light' | 'heavy' | 'roll', buffer?: number) {
    return this.input.consume(action, buffer);
  }
}

/**
 * Where everyone stands when the fight opens: the leader in front, the rest fanned out behind
 * (and nobody straight behind the leader, where the camera sits).
 */
export const FORMATION: [number, number][] = [[0, 0], [-3.2, 1.4], [3.2, 1.4], [-5.6, 3.4]];
export const START_Z = 26;

/** Everyone walking the same way at the same pace, for scenes that move the party themselves. */
class March implements Controls {
  moveX = 0;
  moveZ = 0;
  sprint = false;
  take() {
    return false;
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The player's side: four Knights on the field at once. The player steers one and can take
 * over any other at will; the rest fight on their own. Also owns everything they throw.
 */
export class Party {
  members: Knight[] = [];
  active = START_INDEX;
  swapCD = 0;
  cureCharges = TUNING.cureCharges;
  cureCD = 0;
  /** The player's lock-on. Allies choose their own targets. */
  lock: BossPart | null = null;
  /** Cinematics take the controls away and make the party untouchable. */
  cinematic = false;
  /** During a cinematic: walk everyone this way (world x, z) at this many metres a second. */
  march: { x: number; z: number; pace: number } | null = null;
  private marching = new March();
  /** The Knight the boss is hunting right now. */
  bossTarget!: Knight;
  /** Circles nobody can walk through this step: the boss's feet and grounded fists. */
  blockers: { x: number; z: number; r: number }[] = [];
  stats = Party.freshStats();

  private brains: AllyBrain[] = [];
  private controls: PlayerControls;

  private static freshStats() {
    return {
      /** Everything the party dealt, and the part of it that came from allies. */
      damage: 0, allyDamage: 0,
      hitsTaken: 0, allyHits: 0, dodges: 0, perfects: 0, swaps: 0, cures: 0, mends: 0,
      /** Damage taken per boss attack: by the Knight being steered, and by allies. */
      taken: {} as Record<string, number>,
      allyTaken: {} as Record<string, number>,
    };
  }
  private projectiles: Projectile[] = [];
  private lastBossState = '';
  private fxGroup = new THREE.Group();
  private deadTimer = 0;

  constructor(
    readonly world: World,
    private input: Input,
    readonly getBoss: () => Colossus,
    readonly events: PartyEvents,
    visuals: CharVisual[],
  ) {
    world.scene.add(this.fxGroup);
    this.controls = new PlayerControls(input);
    PARTY.forEach((def, i) => {
      const k = new Knight(def, visuals[i], this, world);
      this.members.push(k);
      this.brains.push(new AllyBrain(k, this, world));
    });
    this.reset();
  }

  /** The Knight the player is steering. */
  get cur() {
    return this.members[this.active];
  }

  get pos() {
    return this.cur.pos;
  }

  get yaw() {
    return this.cur.yaw;
  }

  get state() {
    return this.cur.state;
  }

  get sprinting() {
    return this.cur.sprinting;
  }

  get anyAlive() {
    return this.members.some((m) => m.alive);
  }

  private get ghalus() {
    return this.members.find((m) => m.def.id === 'ghalus')!;
  }

  /** `z`: how far from the middle of the arena the leader stands, on the side the colossus faces. */
  reset(z = START_Z) {
    for (const p of this.projectiles) this.fxGroup.remove(p.mesh);
    this.projectiles.length = 0;
    this.active = START_INDEX;
    this.march = null;
    let slot = 1;
    this.members.forEach((k, i) => {
      const [x, dz] = FORMATION[i === this.active ? 0 : slot++];
      k.reset(x, z + dz, Math.PI);
      this.brains[i].reset();
    });
    this.bossTarget = this.cur;
    this.swapCD = 0;
    this.cureCharges = TUNING.cureCharges;
    this.cureCD = 0;
    this.lock = null;
    this.cinematic = false;
    this.deadTimer = 0;
    this.stats = Party.freshStats();
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

  // ---------------------------------------------------------------- who the player steers

  /** Hand the controls to another Knight. The one let go carries on under their own brain. */
  trySwap(index: number, free = false): boolean {
    const next = this.members[index];
    if (!next || index === this.active || !next.alive) return false;
    if (!free && this.swapCD > 0) return false;
    const from = this.active;
    this.active = index;
    this.swapCD = free ? 0.3 : TUNING.swapCooldown;
    this.stats.swaps++;
    next.tagT = TUNING.tagWindow;
    this.brains[from].resume();
    const { fx, audio } = this.world;
    _a.copy(next.pos).setY(next.def.height * 0.6);
    fx.flash(_a, next.def.color, 4, 0.3, 1.6);
    fx.ring(next.pos, { r0: 0.4, r1: 2.6, life: 0.35, color: next.def.color, intensity: 2 });
    audio.play('swap', { volume: 0.7 });
    if (this.lock) this.lock = this.defaultLock();
    this.events.swapped(index);
    if (!free) next.say('takeover', { priority: 1, cooldown: 2.5 });
    return true;
  }

  private nextAlive(dir: 1 | -1): number {
    for (let k = 1; k <= this.members.length; k++) {
      const i = (this.active + dir * k + this.members.length * 4) % this.members.length;
      if (this.members[i].alive) return i;
    }
    return this.active;
  }

  private swapInputs() {
    const input = this.input;
    for (let i = 0; i < 4; i++) {
      if (!input.consume(`swap${i + 1}` as 'swap1')) continue;
      if (this.trySwap(i)) return;
      if (i !== this.active && this.members[i]?.alive === false) this.events.toast(`${this.members[i].firstName} has fallen`, 'bad');
    }
    if (input.consume('swapNext')) this.trySwap(this.nextAlive(1));
    if (input.consume('swapPrev')) this.trySwap(this.nextAlive(-1));
  }

  /** Called by a Knight as they go down. */
  onFallen(k: Knight) {
    this.events.toast(`${k.firstName} has fallen`, 'bad');
    if (k === this.cur) this.deadTimer = 1.5;
    const standing = this.members.filter((m) => m.alive);
    const answered = this.events.fallen(k);
    if (standing.length) {
      // Someone still on their feet answers; now and then the colossus has the last word.
      if (!answered) standing[Math.floor(Math.random() * standing.length)].say('allyFallen', { priority: 1, delay: 2.3, cooldown: 0 });
      this.world.voice.say('boss', 'taunt', { priority: 1, delay: answered ? 8 : 5, chance: 0.5, cooldown: 25 });
    }
    if (!this.anyAlive) this.events.defeat();
  }

  /** The boss chooses its next quarry: mostly whoever the player steers, sometimes an ally. */
  pickBossTarget(): Knight {
    const boss = this.getBoss().pos;
    const opts = this.members
      .filter((m) => m.alive)
      .map((m) => {
        if (m === this.cur) return { v: m, w: TUNING.aggroLeader };
        // Allies draw its eye less: least of all from far away, or twice running.
        const far = Math.hypot(m.pos.x - boss.x, m.pos.z - boss.z) > 14;
        return { v: m, w: (far ? 0.5 : 1) * (m === this.bossTarget ? 0.4 : 1) };
      });
    this.bossTarget = pickWeighted(opts) ?? this.cur;
    return this.bossTarget;
  }

  // ---------------------------------------------------------------- Ghalus's healing

  /** The living Knight in the worst shape, if anyone is below `below` of their health. */
  mostWounded(below: number): Knight | null {
    let worst: Knight | null = null;
    let worstFrac = below;
    for (const m of this.members) {
      if (!m.alive) continue;
      const frac = (m.hp + m.healPending) / m.def.hp;
      if (frac < worstFrac) {
        worstFrac = frac;
        worst = m;
      }
    }
    return worst;
  }

  private healFx(from: Knight, to: Knight, strong: boolean) {
    const { fx } = this.world;
    const cast = from.visual.castPoint(_a);
    _b.copy(to.pos).setY(to.def.height * 0.6);
    if (from !== to) fx.line(cast, _b, 0x8ff0d2, strong ? 0.2 : 0.12, 0.45, 3);
    fx.flash(cast, 0x8ff0d2, 2.5, 0.25, 2);
    fx.ring(to.pos, { r0: 0.4, r1: strong ? 4 : 2.2, life: 0.6, color: 0x8ff0d2, intensity: 2 });
    _b.setY(0.4);
    fx.burst(_b, strong ? 40 : 16, { color: 0x8ff0d2, color2: 0xfff2b0, intensity: 2.2, speed: [1, 5], dir: UP, spread: 0.35, radius: strong ? 1.2 : 0.7, size: [0.12, 0.3], life: [0.6, 1.3] });
  }

  /** Cure, on the player's call: a large heal for the Knight they steer, a little for the rest. */
  cure(): boolean {
    const g = this.ghalus;
    const who = this.cur;
    if (!who.alive) return false;
    if (!g.alive) this.events.toast('Ghalus has fallen — no healing', 'bad');
    else if (g === who) this.events.toast('Ghalus only heals when he fights as an ally', 'info');
    else if (this.cureCharges <= 0) this.events.toast('No Cure left', 'bad');
    else if (this.cureCD > 0) this.events.toast('Cure is not ready', 'info');
    else {
      this.cureCharges--;
      this.cureCD = TUNING.cureCooldown;
      this.stats.cures++;
      who.healPending += who.def.hp * TUNING.cureAmount;
      for (const m of this.members) if (m.alive && m !== who) m.healPending += m.def.hp * TUNING.cureOthers;
      const { fx, audio } = this.world;
      audio.play('heal', { volume: 0.9 });
      // He turns to the Knight he is healing and channels; the light arrives at once.
      g.startCast(0.3, 0.6, null);
      g.say('cure', { priority: 1, cooldown: 0 });
      who.say('healed', { priority: 1, delay: 2.4, cooldown: 0 });
      this.healFx(g, who, true);
      fx.pillar(who.pos, 1.6, 9, 0x8ff0d2, 1.0, 1.4);
      for (const m of this.members) if (m.alive && m !== who && m !== g) this.healFx(g, m, false);
      this.world.damageNumber(_a.copy(who.pos).setY(who.def.height + 0.4), who.def.hp * TUNING.cureAmount, 'heal');
      return true;
    }
    return false;
  }

  /** Mend, on Ghalus's own initiative as an ally: a smaller heal after a short channel. */
  mend(target: Knight, done: () => void): boolean {
    const g = this.ghalus;
    if (g === this.cur) return false;
    const casting = g.startCast(0.55, 0.45, () => {
      done();
      if (!target.alive) return;
      const amount = target.def.hp * TUNING.mendAmount;
      target.healPending += amount;
      this.stats.mends++;
      this.healFx(g, target, false);
      this.world.audio.play('heal', { volume: 0.45, rate: 1.25 });
      this.world.damageNumber(_a.copy(target.pos).setY(target.def.height + 0.4), amount, 'heal');
    });
    if (casting) g.say('mend', { priority: 1, chance: 0.55, cooldown: 14, volume: 1.4 });
    return casting;
  }

  // ---------------------------------------------------------------- dealing damage

  /** Apply one hit of `move` to a boss part, with all the feedback that goes with it. */
  hitPart(part: BossPart, move: MoveDef, owner: Knight, hitPos: THREE.Vector3, scale = 1): number {
    const boss = this.getBoss();
    const { fx, audio } = this.world;
    // Allies' hits are drawn and heard, but only the player's own freeze the frame and shake the camera.
    const lead = owner === this.cur || this.cinematic;
    const dealt = boss.takeDamage(part, move.damage * scale, move.stagger * scale, hitPos, !lead);
    if (dealt <= 0) return 0;
    this.stats.damage += dealt;
    if (!lead) this.stats.allyDamage += dealt;
    owner.dealt += dealt;
    const big = move.damage >= 90;
    const vol = lead ? 1 : 0.4;
    if (part.weak) {
      fx.burst(hitPos, big ? 60 : 24, { color: 0xffffff, color2: 0xbfe0ff, intensity: 3.5, speed: [4, 20], size: [0.14, 0.45], life: [0.3, 0.9], gravity: 6 });
      fx.flash(hitPos, 0xffffff, big ? 9 : 4, 0.2, 2.5);
      audio.play('hit_weak', { volume: (big ? 1 : 0.7) * vol });
    } else if (part.armor) {
      fx.burst(hitPos, 8, { color: 0x9aa4c8, intensity: 1.2, speed: [3, 10], size: [0.08, 0.2], life: [0.2, 0.5], gravity: 14 });
      audio.play('hit', { volume: 0.45 * vol, rate: 1.5 });
    } else {
      fx.burst(hitPos, big ? 40 : 16, { color: move.color, color2: 0xffffff, intensity: 2.5, speed: [4, 16], size: [0.12, 0.35], life: [0.25, 0.7], gravity: 12 });
      fx.flash(hitPos, move.color, big ? 6 : 3, 0.18, 1.8);
      audio.play(big ? 'hit_heavy' : 'hit', { volume: (big ? 1 : 0.75) * vol });
    }
    if (lead) {
      if (move.hitstop) this.world.hitstop(move.hitstop * (part.weak ? 1.4 : 1));
      if (move.shake) fx.shake(move.shake);
    }
    if (owner.def.id === 'symbeline') owner.encore = Math.min(TUNING.encoreMax, owner.encore + 1);
    if (move.id === 'deux_l') owner.kindle = Math.min(TUNING.kindleMax, owner.kindle + 1);
    return dealt;
  }

  /** Send a bolt or a chakram on its way. */
  launch(owner: Knight, kind: Projectile['kind'], move: MoveDef, from: THREE.Vector3, target: BossPart | null, bonus: number, curve = 0) {
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
    const goal = target ? target.pos.clone() : yawForward(owner.yaw, new THREE.Vector3()).multiplyScalar(move.range ?? 14).add(from);
    if (!target && kind === 'chakram') goal.copy(yawForward(owner.yaw, _a)).multiplyScalar(13).add(from);
    const speed = kind === 'ember' ? 38 : 30;
    const vel = goal.clone().sub(from).normalize();
    if (curve) vel.addScaledVector(yawLeft(owner.yaw, _a), curve * 0.5).normalize();
    vel.multiplyScalar(speed);
    mesh.position.copy(from);
    this.fxGroup.add(mesh);
    this.projectiles.push({ kind, pos: from.clone(), vel, target, goal, life: kind === 'ember' ? 2.2 : 3.2, move, owner, bonus, mesh, returning: false, hitOut: false, hitBack: false });
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
          // Back to the hand that threw it.
          _a.copy(p.owner.pos).setY(1.2).sub(p.pos);
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
    this.swapCD = Math.max(0, this.swapCD - dt);
    this.cureCD = Math.max(0, this.cureCD - dt);
    this.getBoss().blockers(this.blockers);

    // The player's hands: movement relative to the camera, plus the party-wide commands.
    const c = this.controls;
    c.moveX = c.moveZ = 0;
    c.sprint = false;
    if (!this.cinematic) {
      if (input.worldMove) {
        c.moveX = input.worldMove.x;
        c.moveZ = input.worldMove.z;
      } else {
        const s = Math.sin(camYaw);
        const k = Math.cos(camYaw);
        c.moveX = s * input.move.y - k * input.move.x;
        c.moveZ = k * input.move.y + s * input.move.x;
      }
      c.sprint = input.sprint;
      if (input.consume('lock')) this.toggleLock();
      if (input.consume('lockNext')) this.cycleLock();
      this.swapInputs();
      if (input.consume('heal')) this.cure();
    }
    this.validateLock();

    // The Knight being steered has fallen: after a beat, the controls pass to the next one standing.
    if (!this.cur.alive && this.anyAlive) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) this.trySwap(this.nextAlive(1), true);
    }

    this.members.forEach((k, i) => {
      // A cinematic has everyone standing by, unless it is walking them somewhere.
      let scripted: Controls | null = null;
      if (this.cinematic && this.march && k.alive) {
        const amount = Math.min(1, this.march.pace / k.def.speed);
        scripted = this.marching;
        this.marching.moveX = this.march.x * amount;
        this.marching.moveZ = this.march.z * amount;
      }
      if (k === this.cur) {
        k.aim = this.lock;
        k.update(dt, this.cinematic ? scripted : c);
      } else {
        const brain = this.brains[i];
        if (!this.cinematic) brain.update(dt);
        k.update(dt, this.cinematic ? scripted : brain);
      }
    });
    this.updateProjectiles(dt);
  }
}
