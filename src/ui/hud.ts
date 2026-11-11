import { PARTY, TUNING, type CharDef } from '../chars/defs';
import type { Party } from '../chars/party';
import type { Colossus } from '../boss/colossus';
import { BOSS_NAME, BOSS_TITLE, BOSS_TUNING } from '../boss/colossus';
import type { HitKind } from '../types';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

/** CSS background that zooms a full-body portrait onto the face. */
function faceCrop(def: CharDef, boxW: number, boxH: number, zoom = 0.9) {
  const f = def.face;
  const bgH = (boxH * zoom) / f.h;
  const bgW = bgH * f.aspect;
  return {
    backgroundImage: `url(/portraits/${def.id}.png)`,
    backgroundSize: `${bgW}px ${bgH}px`,
    backgroundPosition: `${boxW / 2 - f.cx * bgW}px ${boxH / 2 - f.cy * bgH}px`,
  };
}

const KBM = {
  move: 'WASD', look: 'Mouse', roll: 'Space', sprint: 'Shift', light: 'Left click', heavy: 'Right click',
  lock: 'Q', lockNext: 'Tab', swap: '1 – 4', heal: 'R', allout: 'F', pause: 'Esc',
};
const PAD = {
  move: 'Left stick', look: 'Right stick', roll: 'B', sprint: 'Hold A', light: 'RB', heavy: 'RT',
  lock: 'R3', lockNext: 'LB', swap: 'D-pad', heal: 'X', allout: 'Y', pause: 'Start',
};

export class Hud {
  private fight = el('div', 'fight');
  private bossBox = el('div', 'boss');
  private bossHp!: HTMLElement;
  private bossGhost!: HTMLElement;
  private bossPosture!: HTMLElement;
  private postureBar!: HTMLElement;
  private cards: { root: HTMLElement; hp: HTMLElement; cool: HTMLElement; face: HTMLElement }[] = [];
  private activePanel = el('div', 'active-panel');
  private activeName = el('div', 'active-name');
  private hpFill = el('i', 'fill');
  private hpGhost = el('i', 'ghost');
  private hpHeal = el('i', 'heal');
  private hpBar = el('div', 'bar hpbar');
  private stFill = el('i', 'fill');
  private stBar = el('div', 'bar stbar');
  private pips = el('div', 'pips');
  private moves = el('div', 'moves');
  private cure = el('div', 'cure');
  private cups: HTMLElement[] = [];
  private cureLabel = el('div', 'label');
  private help = el('div', 'help');
  private reticle = el('div', 'reticle');
  private reticleLabel = el('div', 'reticle-label');
  private toasts = el('div', 'toasts');
  private prompt = el('div', 'prompt');
  private numbers = el('div', 'numbers');
  private hurt = el('div', 'hurt');
  private lowhp = el('div', 'lowhp');
  private title = el('div', 'screen title');
  private banner = el('div', 'screen banner');
  private end = el('div', 'screen end');
  private pause = el('div', 'screen pause');
  private allout = el('div', 'allout');
  private flashEl = el('div', 'flashfx');
  private loading = el('div', 'loading', 'SUMMONING…');
  private badge = el('div', 'badge');
  private hurtAmount = 0;
  private shownActive = -1;
  private device: 'kbm' | 'pad' = 'kbm';
  private helpTimer = 0;
  private numCount = 0;

  constructor(private root: HTMLElement) {
    root.append(el('div', 'vignette'), this.lowhp, this.hurt, this.fight, this.numbers, this.allout, this.banner, this.title, this.end, this.pause, this.flashEl, this.loading, this.badge);

    // Boss
    this.bossBox.innerHTML = `<div class="boss-name">${BOSS_NAME}<em>${BOSS_TITLE}</em></div>
      <div class="bar boss-hp"><i class="ghost"></i><i class="fill"></i><b class="mark" style="left:${BOSS_TUNING.phase2At * 100}%"></b></div>
      <div class="bar boss-posture"><i class="fill"></i></div>`;
    this.bossHp = this.bossBox.querySelector('.boss-hp .fill')!;
    this.bossGhost = this.bossBox.querySelector('.boss-hp .ghost')!;
    this.postureBar = this.bossBox.querySelector('.boss-posture')!;
    this.bossPosture = this.bossBox.querySelector('.boss-posture .fill')!;

    // Party cards
    const party = el('div', 'party');
    PARTY.forEach((def, i) => {
      const card = el('div', 'card');
      card.style.setProperty('--c', def.css);
      const face = el('div', 'face');
      const hp = el('i');
      const hpWrap = el('div', 'hp');
      hpWrap.append(hp);
      const cool = el('div', 'cool');
      card.append(face, cool, hpWrap, el('span', 'key', String(i + 1)));
      party.append(card);
      this.cards.push({ root: card, hp, cool, face });
    });

    // Active Knight
    this.hpBar.append(this.hpGhost, this.hpHeal, this.hpFill);
    this.stBar.append(this.stFill);
    this.activePanel.append(this.activeName, this.hpBar, this.stBar, this.pips, this.moves);

    // Cure charges
    const cups = el('div', 'cups');
    for (let i = 0; i < TUNING.cureCharges; i++) {
      const c = el('div', 'cup');
      cups.append(c);
      this.cups.push(c);
    }
    this.cure.append(cups, this.cureLabel);

    this.fight.append(this.bossBox, party, this.activePanel, this.cure, this.help, this.reticle, this.reticleLabel, this.toasts, this.prompt);
    this.banner.innerHTML = `<h2></h2><div class="line"></div><h1></h1><div class="line"></div>`;
    this.pause.innerHTML = `<h1>PAUSED</h1><p class="resume"></p><div class="controls"></div>`;
    this.buildTitle();
    this.setDevice('kbm', true);
  }

  private controlsHtml(k: typeof KBM) {
    const rows: [string, string][] = [
      [k.move, 'Move'], [k.look, 'Camera'], [k.light, 'Light attack'], [k.heavy, 'Heavy attack / spell'],
      [k.roll, 'Dodge'], [k.sprint, 'Sprint'], [k.swap, 'Swap Knight'], [k.lock, 'Lock on'],
      [k.lockNext, 'Next target'], [k.heal, "Ghalus's Cure"], [k.allout, 'All-Out Attack'], [k.pause, 'Pause'],
    ];
    return rows.map(([a, b]) => `<b>${a}</b><span>${b}</span>`).join('');
  }

  private buildTitle() {
    this.title.innerHTML = `
      <h1>Knights of the <b>Zodiarks</b></h1>
      <h2>${BOSS_TITLE}</h2>
      <div class="start"></div>
      <div class="roster">${PARTY.map((d, i) => `<div style="--c:${d.css}"><b>${i + 1} · ${d.name.split(' ')[0]}</b><i>${d.title}</i>${d.passive}</div>`).join('')}</div>
      <div class="controls"></div>`;
  }

  setDevice(device: 'kbm' | 'pad', force = false) {
    if (device === this.device && !force) return;
    this.device = device;
    const k = device === 'pad' ? PAD : KBM;
    this.root.querySelectorAll('.controls').forEach((c) => (c.innerHTML = this.controlsHtml(k)));
    this.title.querySelector('.start')!.textContent = device === 'pad' ? 'PRESS A TO BEGIN' : 'CLICK TO BEGIN';
    this.pause.querySelector('.resume')!.textContent = device === 'pad' ? 'PRESS START TO RESUME' : 'CLICK TO RESUME';
    this.help.innerHTML = `<b>${k.swap}</b> swap · <b>${k.lock}</b> lock · <b>${k.lockNext}</b> next target<br><b>${k.roll}</b> dodge · <b>${k.sprint}</b> sprint · <b>${k.pause}</b> pause`;
    this.cards.forEach((c, i) => {
      c.root.querySelector('.key')!.textContent = device === 'pad' ? ['▲', '▶', '▼', '◀'][i] : String(i + 1);
    });
    this.shownActive = -1;
  }

  layout() {
    // Face crops depend on the rendered card size.
    this.cards.forEach((c, i) => {
      const w = c.root.classList.contains('active') ? 104 : 74;
      Object.assign(c.face.style, faceCrop(PARTY[i], w, w));
    });
  }

  setLoading(on: boolean) {
    this.loading.style.display = on ? '' : 'none';
  }

  setBadge(text: string) {
    this.badge.textContent = text;
  }

  showTitle(on: boolean) {
    this.title.classList.toggle('on', on);
  }

  showFight(on: boolean) {
    this.root.classList.toggle('in-fight', on);
    if (on) this.helpTimer = 25;
    this.help.classList.remove('faded');
  }

  showPause(on: boolean) {
    this.pause.classList.toggle('on', on);
  }

  showBanner(title: string, subtitle: string, hot = false) {
    this.banner.querySelector('h1')!.textContent = title;
    this.banner.querySelector('h2')!.textContent = subtitle;
    this.banner.classList.remove('on');
    this.banner.classList.toggle('hot', hot);
    void this.banner.offsetWidth; // restart the animation
    this.banner.classList.add('on');
  }

  showEnd(kind: 'victory' | 'defeat' | null, detail = '') {
    this.end.className = 'screen end';
    if (!kind) return;
    const again = this.device === 'pad' ? 'PRESS A TO FIGHT AGAIN' : 'CLICK OR PRESS ENTER TO FIGHT AGAIN';
    this.end.innerHTML = `<h1>${kind === 'victory' ? 'The Exiled Sign Falls' : 'The Knights Have Fallen'}</h1><p>${detail}</p><div class="again">${again}</div>`;
    void this.end.offsetWidth;
    this.end.classList.add('on', kind);
  }

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const t = el('div', `toast ${kind}`);
    t.textContent = text;
    this.toasts.prepend(t);
    while (this.toasts.children.length > 3) this.toasts.lastChild!.remove();
    setTimeout(() => t.remove(), 1500);
  }

  setPrompt(html: string | null) {
    this.prompt.style.display = html ? 'block' : 'none';
    if (html) this.prompt.innerHTML = html;
  }

  alloutPrompt(on: boolean) {
    const key = this.device === 'pad' ? 'Y' : 'F';
    this.setPrompt(on ? `<kbd>${key}</kbd>ALL-OUT ATTACK` : null);
  }

  hurtFlash(amount: number) {
    this.hurtAmount = Math.min(1, this.hurtAmount + 0.35 + amount);
  }

  flash(strength = 0.8, ms = 350) {
    this.flashEl.animate([{ opacity: strength }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
  }

  damageNumber(x: number, y: number, amount: number, kind: HitKind) {
    if (this.numCount > 40) return;
    const n = el('div', `num ${kind}${amount >= 250 ? ' big' : ''}`);
    n.textContent = (kind === 'heal' ? '+' : '') + Math.round(amount);
    n.style.left = `${x + (Math.random() - 0.5) * 50}px`;
    n.style.top = `${y + (Math.random() - 0.5) * 30}px`;
    this.numbers.append(n);
    this.numCount++;
    setTimeout(() => {
      n.remove();
      this.numCount--;
    }, 900);
  }

  setReticle(x: number, y: number, visible: boolean, label = '', weak = false) {
    this.reticle.style.display = this.reticleLabel.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    this.reticle.style.left = this.reticleLabel.style.left = `${x}px`;
    this.reticle.style.top = this.reticleLabel.style.top = `${y}px`;
    this.reticle.classList.toggle('weak', weak);
    if (this.reticleLabel.textContent !== label) this.reticleLabel.textContent = label;
  }

  /** The splash that opens the party finisher. */
  allOutSplash() {
    this.allout.innerHTML = `<div class="slab"></div><div class="text">ALL-OUT ATTACK!!</div>`;
    this.allout.classList.remove('on');
    void this.allout.offsetWidth;
    this.allout.classList.add('on');
  }

  /** A slash of the Knight's face across the screen as their strike begins. */
  cutIn(def: CharDef, low: boolean) {
    const c = el('div', `cutin${low ? ' low' : ''}`);
    c.style.setProperty('--c', def.css);
    const img = el('div', 'img');
    const w = window.innerWidth * 1.2;
    const h = window.innerHeight * 0.21;
    Object.assign(img.style, faceCrop(def, w, h, 2.1));
    const name = el('div', 'nm');
    name.textContent = def.name.split(' ')[0].toUpperCase() + '!';
    c.append(img, name);
    this.allout.append(c);
    setTimeout(() => c.remove(), 820);
  }

  endAllOut() {
    this.allout.classList.remove('on');
    this.allout.innerHTML = '';
  }

  update(dt: number, party: Party, boss: Colossus) {
    // Boss
    const hp = boss.hp / boss.maxHp;
    this.bossHp.style.transform = this.bossGhost.style.transform = `scaleX(${hp})`;
    const posture = boss.state === 'staggered' ? 1 : boss.posture / boss.postureMax;
    this.bossPosture.style.transform = `scaleX(${posture})`;
    this.postureBar.classList.toggle('broken', boss.state === 'staggered');
    this.bossBox.classList.toggle('hot', boss.phase === 2);
    this.bossBox.style.opacity = boss.state === 'dormant' ? '0' : '1';

    // Party
    const m = party.cur;
    if (this.shownActive !== party.active) {
      this.shownActive = party.active;
      this.cards.forEach((c, i) => c.root.classList.toggle('active', i === party.active));
      this.layout();
      const d = m.def;
      const k = this.device === 'pad' ? PAD : KBM;
      this.activePanel.style.setProperty('--c', d.css);
      this.activeName.innerHTML = `${d.name}<em>${d.title}</em>`;
      this.activePanel.style.setProperty('--w', `${Math.round(170 + d.hp * 0.95)}px`);
      this.moves.innerHTML = `<b>${k.light}</b> ${d.hints.light}<br><b>${k.heavy}</b> ${d.hints.heavy}`;
      this.hpGhost.style.transition = 'none';
      this.hpGhost.style.transform = `scaleX(${m.hp / d.hp})`;
      void this.hpGhost.offsetWidth;
      this.hpGhost.style.transition = '';
    }
    party.members.forEach((mm, i) => {
      const c = this.cards[i];
      c.hp.style.transform = `scaleX(${Math.max(0, mm.hp / mm.def.hp)})`;
      c.root.classList.toggle('dead', !mm.alive);
      c.cool.style.transform = `skewX(-8deg) scaleY(${i === party.active || !mm.alive ? 0 : party.swapCD / TUNING.swapCooldown})`;
    });
    const frac = Math.max(0, m.hp / m.def.hp);
    this.hpFill.style.transform = this.hpGhost.style.transform = `scaleX(${frac})`;
    this.hpHeal.style.transform = `scaleX(${Math.min(1, frac + m.healPending / m.def.hp)})`;
    this.stFill.style.transform = `scaleX(${Math.max(0, m.stamina / m.def.stamina)})`;
    this.stBar.classList.toggle('empty', m.stamina <= 0);
    this.lowhp.classList.toggle('on', m.alive && frac < 0.3);

    // Passive stacks
    let pips = '';
    if (m.def.id === 'symbeline') {
      for (let i = 0; i < TUNING.encoreMax; i++) pips += `<span class="${i < m.encore ? 'on' : ''}"></span>`;
      pips += '<label>ENCORE</label>';
    } else if (m.def.id === 'deux') {
      for (let i = 0; i < TUNING.kindleMax; i++) pips += `<span class="${i < m.kindle ? 'on' : ''}"></span>`;
      pips += '<label>KINDLE</label>';
    } else if (party.swapBuff > 0) pips = '<label style="color:#fff3c4">PERFECT SWAP +25%</label>';
    if (this.pips.innerHTML !== pips) this.pips.innerHTML = pips;

    // Cure
    const ghalus = party.members.find((x) => x.def.id === 'ghalus')!;
    const usable = ghalus.alive && ghalus !== m;
    this.cups.forEach((c, i) => c.classList.toggle('used', i >= party.cureCharges));
    this.cure.classList.toggle('off', !usable || party.cureCD > 0);
    const key = this.device === 'pad' ? PAD.heal : KBM.heal;
    const label = !ghalus.alive
      ? 'GHALUS HAS FALLEN'
      : ghalus === m
        ? 'NO CURE WHILE GHALUS FIGHTS'
        : party.cureCD > 0
          ? `CURE READY IN ${party.cureCD.toFixed(0)}`
          : `<b>${key}</b> GHALUS · CURE`;
    if (this.cureLabel.innerHTML !== label) this.cureLabel.innerHTML = label;

    // Transients
    this.hurtAmount = Math.max(0, this.hurtAmount - dt * 1.8);
    this.hurt.style.opacity = String(this.hurtAmount);
    if (this.helpTimer > 0) {
      this.helpTimer -= dt;
      if (this.helpTimer <= 0) this.help.classList.add('faded');
    }
  }
}
