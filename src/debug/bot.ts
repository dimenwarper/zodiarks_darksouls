import { rand } from '../core/math';
import type { Game } from '../game';
import { senseDanger } from '../chars/ally';

/**
 * A simple autoplayer that stands in for the player in automated runs (and as an attract
 * mode). It is not meant to be good: it steers the controlled Knight to a target, attacks,
 * dodges announced impacts, heals, switches Knight and triggers the All-Out Attack.
 */
export class Bot {
  private rollCD = 0;
  private swapTimer = 9;
  private think = 0;
  private strafe = 1;
  /** 0 never dodges, 1 always reacts in time. */
  skill = 0.85;

  constructor(private game: Game) {}

  update(dt: number) {
    const g = this.game;
    const { party, boss, input } = g;
    input.worldMove = { x: 0, z: 0 };
    if (g.mode === 'arrive' && !party.cinematic) {
      // The walk in: straight at the colossus until it wakes.
      const dx = boss.pos.x - party.pos.x;
      const dz = boss.pos.z - party.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      input.worldMove = { x: dx / d, z: dz / d };
      return;
    }
    if (g.mode !== 'fight' || !party.cur.alive || party.cinematic) return;
    this.rollCD -= dt;
    this.swapTimer -= dt;
    this.think -= dt;
    const p = party.pos;
    const m = party.cur;
    const toBoss = { x: boss.pos.x - p.x, z: boss.pos.z - p.z };
    const dBoss = Math.hypot(toBoss.x, toBoss.z) || 1;

    if (g.alloutReady && party.state === 'free') g.tryAllOut();
    if (!party.lock) input.press('lock');

    // Dodge: announced ground impacts, shockwave rings, and sweeping limbs.
    const danger = senseDanger(g, m, boss.pos);
    if (danger.leave) input.worldMove = { x: danger.leave.x / dBoss, z: danger.leave.z / dBoss };
    const dodge = danger.roll;
    if (dodge && this.rollCD <= 0 && m.stamina > 0 && (party.state === 'free' || party.state === 'attack')) {
      this.rollCD = 0.7;
      if (rand() < this.skill) {
        const len = Math.hypot(dodge.x, dodge.z) || 1;
        input.worldMove = { x: dodge.x / len, z: dodge.z / len };
        input.press('roll');
        return;
      }
    }

    // Upkeep
    if (m.hp < m.def.hp * 0.45 && party.cureCharges > 0 && party.cureCD <= 0 && m.def.id !== 'ghalus') input.press('heal');
    if (this.swapTimer <= 0 || (m.hp < m.def.hp * 0.3 && party.swapCD <= 0)) {
      this.swapTimer = rand(10, 18);
      const options = party.members.map((x, i) => ({ x, i })).filter((o) => o.x.alive && o.i !== party.active);
      if (options.length) input.press(`swap${options[Math.floor(rand(options.length))].i + 1}` as 'swap1');
    }

    // Position and attack
    if (this.think <= 0) {
      this.think = rand(1.5, 3);
      this.strafe = rand() < 0.5 ? -1 : 1;
    }
    const target = party.lock ?? party.defaultLock();
    if (!target) return;
    const tx = target.pos.x - p.x;
    const tz = target.pos.z - p.z;
    const td = Math.hypot(tx, tz) || 1;
    if (m.def.ranged) {
      const want = 15;
      const radial = dBoss < want - 2 ? -1 : dBoss > want + 4 ? 1 : 0;
      const mx = (toBoss.x / dBoss) * radial + (-toBoss.z / dBoss) * this.strafe * 0.5;
      const mz = (toBoss.z / dBoss) * radial + (toBoss.x / dBoss) * this.strafe * 0.5;
      input.worldMove = { x: mx, z: mz };
      if (party.state === 'free' && m.stamina > 15) input.press(boss.state === 'staggered' || rand() < 0.012 ? 'heavy' : 'light');
    } else {
      const reach = (m.def.light[0].reach ?? 1.5) + (m.def.light[0].radius ?? 1.5) + target.r - 0.6;
      if (td > reach) input.worldMove = { x: tx / td, z: tz / td };
      else if (m.stamina > 12) input.press(boss.state === 'staggered' && rand() < 0.3 ? 'heavy' : 'light');
    }
  }
}
