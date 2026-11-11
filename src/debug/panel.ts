import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import type { Game } from '../game';
import { BOSS_LOOK, BOSS_TUNING } from '../boss/colossus';
import { PARTY, TUNING } from '../chars/defs';
import { Bot } from './bot';
import { VOICE_TUNING } from '../core/voice';

/** Tuning panel (toggle with the backquote key) plus the hooks automated tests drive. */
export function installDebug(game: Game) {
  const bot = new Bot(game);
  let botOn = false;
  const hitboxes = new THREE.Group();
  hitboxes.visible = false;
  game.scene.add(hitboxes);
  const wire = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.35, depthTest: false });
  const weakWire = new THREE.MeshBasicMaterial({ color: 0xffd040, wireframe: true, transparent: true, opacity: 0.5, depthTest: false });
  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const boxes: THREE.Mesh[] = [];

  game.onStep = (dt) => {
    if (botOn) bot.update(dt);
    else if (game.input.worldMove) game.input.worldMove = null;
    if (hitboxes.visible) {
      const parts = game.boss.parts;
      while (boxes.length < parts.length) {
        const m = new THREE.Mesh(sphere, wire);
        boxes.push(m);
        hitboxes.add(m);
      }
      parts.forEach((p, i) => {
        boxes[i].position.copy(p.pos);
        boxes[i].scale.setScalar(p.r);
        boxes[i].material = p.weak ? weakWire : wire;
      });
    }
  };

  const state = {
    bot: false,
    hitboxes: false,
    force: 'none',
    phase2: () => {
      game.boss.hp = Math.min(game.boss.hp, game.boss.maxHp * BOSS_TUNING.phase2At + 1);
      game.boss.takeDamage(game.boss.part('ankleL'), 5, 0, game.boss.part('ankleL').pos);
    },
    stagger: () => game.boss.takeDamage(game.boss.part('ankleL'), 1, 9999, game.boss.part('ankleL').pos),
    kill: () => {
      game.boss.hp = 1;
      game.boss.takeDamage(game.boss.part('core'), 50, 0, game.boss.corePos);
    },
    healAll: () => {
      for (const m of game.party.members) m.revive();
    },
    restart: () => game.start(),
  };

  const gui = new GUI({ title: 'Tuning (`)', width: 300 });
  gui.hide();
  gui.add(game, 'speed', 0.1, 2, 0.05).name('game speed');
  gui.add(game, 'god').name('god mode');
  gui.add(state, 'bot').name('autoplay bot').onChange((v: boolean) => (botOn = v));
  gui.add(state, 'hitboxes').name('show boss hitboxes').onChange((v: boolean) => (hitboxes.visible = v));
  const b = gui.addFolder('Boss');
  b.add(BOSS_TUNING, 'tempo', 0.5, 1.6, 0.05).name('attack gaps ×');
  b.add(BOSS_TUNING, 'damage', 0.2, 2, 0.05).name('damage ×');
  b.add(BOSS_TUNING, 'walkSpeed', 1, 7, 0.1);
  b.add(BOSS_TUNING, 'turnRate', 0.2, 2, 0.05);
  b.add(BOSS_TUNING, 'staggerWindow', 3, 12, 0.5);
  b.add(state, 'force', ['none', 'slam', 'slamCombo', 'sweep', 'stomp', 'doubleSlam', 'beam', 'starfall', 'pivot']).name('next attack').onChange((v: string) => (game.boss.forceAttack = v === 'none' ? null : v));
  b.add(state, 'stagger').name('break posture now');
  b.add(state, 'phase2').name('jump to phase 2');
  b.add(state, 'kill').name('kill boss');
  const p = gui.addFolder('Knights');
  p.add(TUNING, 'staminaRegen', 10, 60, 1);
  p.add(TUNING, 'swapCooldown', 0.2, 4, 0.1);
  p.add(TUNING, 'tagBonus', 1, 2.5, 0.05).name('tag-in first hit ×');
  p.add(TUNING, 'perfectWindow', 0.05, 0.4, 0.01).name('perfect dodge window');
  p.add(TUNING, 'perfectDodgeSlow', 0.1, 1, 0.05);
  for (const d of PARTY) p.add(d.roll, 'iEnd', 0.1, 0.6, 0.01).name(`${d.name.split(' ')[0]} dodge i-frames`);
  p.add(state, 'healAll').name('revive + heal all');
  const a = gui.addFolder('Allies');
  a.add(TUNING, 'allyDamage', 0, 1, 0.05).name('damage dealt ×');
  a.add(TUNING, 'allyDamageTaken', 0, 1, 0.05).name('damage taken ×');
  a.add(TUNING, 'allySkill', 0, 1.4, 0.05).name('dodge skill ×');
  a.add(TUNING, 'aggroLeader', 0.5, 12, 0.5).name('boss favours you ×');
  a.add(TUNING, 'mendCooldown', 2, 20, 0.5).name('Ghalus Mend every (s)');
  a.add(TUNING, 'mendAmount', 0, 0.6, 0.01).name('Mend heals (of max)');
  const vo = gui.addFolder('Voices');
  vo.add(VOICE_TUNING, 'volume', 0, 1.5, 0.05);
  vo.add(VOICE_TUNING, 'efforts', 0, 2, 0.1).name('grunts and shouts ×');
  vo.add(VOICE_TUNING, 'captions');
  const bl = gui.addFolder('Boss armour');
  bl.add(BOSS_LOOK.uRim, 'value', 0, 3, 0.05).name('rim glow');
  bl.add(BOSS_LOOK.uInlay, 'value', 0, 3, 0.05).name('inlay glow');
  bl.add(BOSS_LOOK.uLift, 'value', 0, 1, 0.01).name('self-lit');
  bl.add(BOSS_LOOK.uGlyph, 'value', 0, 4, 0.05).name('glyphs');
  const v = gui.addFolder('Look');
  v.add(game.bloom, 'strength', 0, 1.5, 0.01).name('bloom');
  v.add(game.renderer, 'toneMappingExposure', 0.5, 2, 0.01).name('exposure');
  v.add(game.rig, 'distance', 4, 12, 0.1).name('camera distance');
  v.add(game.rig, 'fov', 40, 80, 1).name('field of view');
  gui.add(state, 'restart');

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote') return;
    if (gui._hidden) {
      gui.show();
      document.exitPointerLock?.();
    } else gui.hide();
  });

  /** Fast-forward the simulation without rendering; returns a summary for assertions. */
  const sim = (seconds: number, opts: { bot?: boolean; skill?: number } = {}) => {
    const prevBot = botOn;
    botOn = opts.bot ?? true;
    if (opts.skill !== undefined) bot.skill = opts.skill;
    game.fast = true;
    game.audio.muted = true;
    const dt = 1 / 60;
    const steps = Math.round(seconds / dt);
    let error: string | null = null;
    let ran = 0;
    try {
      for (let i = 0; i < steps; i++) {
        game.input.time += dt;
        game.step(dt);
        ran++;
        if (game.mode === 'victory' && game.boss.state === 'dead') break;
        if (game.mode === 'defeat') break;
      }
    } catch (e) {
      error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    }
    game.fast = false;
    game.audio.muted = false;
    botOn = prevBot;
    game.renderOnce();
    return { ran: +(ran * dt).toFixed(1), error, ...snapshot() };
  };

  const snapshot = () => ({
    mode: game.mode,
    time: +game.time.toFixed(1),
    boss: {
      hp: Math.round(game.boss.hp),
      max: game.boss.maxHp,
      phase: game.boss.phase,
      state: game.boss.state,
      posture: Math.round(game.boss.posture),
      last: game.boss.lastAttack,
      pos: [+game.boss.pos.x.toFixed(1), +game.boss.pos.z.toFixed(1)],
    },
    party: game.party.members.map((m) => `${m.def.id}:${Math.round(m.hp)}${m.alive ? '' : '†'}`),
    knights: game.party.members.map((m) => ({ id: m.def.id, state: m.state, pos: [+m.pos.x.toFixed(1), +m.pos.z.toFixed(1)], dealt: Math.round(m.dealt), taken: Math.round(m.taken), fellTo: m.fellTo })),
    hunted: game.party.bossTarget.def.id,
    active: game.party.cur.def.id,
    state: game.party.state,
    pos: [+game.party.pos.x.toFixed(1), +game.party.pos.z.toFixed(1)],
    cures: game.party.cureCharges,
    stats: { ...game.party.stats, damage: Math.round(game.party.stats.damage), allyDamage: Math.round(game.party.stats.allyDamage) },
    hazards: game.hazards.length,
  });

  /** Step until `cond` holds (or the time limit passes); for landing on a specific moment. */
  const until = (cond: () => boolean, maxSeconds = 20, useBot = false) => {
    const prevBot = botOn;
    botOn = useBot;
    game.fast = true;
    game.audio.muted = true;
    const dt = 1 / 60;
    let t = 0;
    while (t < maxSeconds && !cond()) {
      game.input.time += dt;
      game.step(dt);
      t += dt;
    }
    game.fast = false;
    game.audio.muted = false;
    botOn = prevBot;
    game.renderOnce();
    return +t.toFixed(2);
  };

  return { game, bot, gui, sim, until, snapshot, state, look: BOSS_LOOK, setBot: (v: boolean) => (botOn = v) };
}
