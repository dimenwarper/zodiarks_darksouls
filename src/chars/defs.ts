export type CharId = 'deux' | 'symbeline' | 'ghalus' | 'sigmund';

export interface MoveDef {
  id: string;
  label: string;
  /** Animation name understood by the character visual. */
  anim: string;
  windup: number;
  active: number;
  recovery: number;
  stamina: number;
  damage: number;
  /** Posture damage dealt to the boss. */
  stagger: number;
  kind: 'melee' | 'bolt' | 'ray' | 'aoe' | 'boomerang';
  /** Melee: how far in front of the character the hit volume sits, and its radius. */
  reach?: number;
  radius?: number;
  /** Forward step taken during the windup, in metres. */
  lunge?: number;
  arc?: { radius: number; tilt?: number; mirror?: boolean; sweep?: number; pitch?: number };
  /** Not flinched by hits, and takes reduced damage, once the windup is under way. */
  hyperArmor?: boolean;
  /** Fraction of the recovery after which a roll or the next attack may interrupt. */
  cancelAt?: number;
  /** Ranged: max distance, and blast radius for area spells. */
  range?: number;
  aoeRadius?: number;
  sfx: string;
  shake?: number;
  hitstop?: number;
  color: number;
}

export interface CharDef {
  id: CharId;
  name: string;
  title: string;
  /** CSS colour for HUD accents. */
  css: string;
  color: number;
  hp: number;
  stamina: number;
  speed: number;
  sprint: number;
  height: number;
  /** Ranged characters lock on to the core by default; melee ones to whatever is in reach. */
  ranged: boolean;
  roll: { kind: 'roll' | 'twirl' | 'blink'; duration: number; distance: number; iStart: number; iEnd: number; cost: number };
  light: MoveDef[];
  heavy: MoveDef;
  /** Where the face sits in the portrait image (fractions of width / height), for HUD crops. */
  face: { cx: number; cy: number; h: number; aspect: number };
  passive: string;
  hints: { light: string; heavy: string; roll: string };
}

const SIGMUND: CharDef = {
  id: 'sigmund',
  name: 'Sigmund',
  title: 'Dark Knight',
  css: '#c2283f',
  color: 0xc2283f,
  hp: 170,
  stamina: 110,
  speed: 4.6,
  sprint: 6.6,
  height: 2.15,
  ranged: false,
  roll: { kind: 'roll', duration: 0.62, distance: 4.4, iStart: 0.04, iEnd: 0.36, cost: 24 },
  light: [
    { id: 'sig_l1', label: 'Cleave', anim: 'slashR', windup: 0.42, active: 0.16, recovery: 0.55, stamina: 24, damage: 62, stagger: 13, kind: 'melee', reach: 2.1, radius: 2.3, lunge: 1.3, arc: { radius: 3.6 }, hyperArmor: true, sfx: 'swing_heavy', shake: 0.22, hitstop: 0.07, color: 0xd9304a },
    { id: 'sig_l2', label: 'Backswing', anim: 'slashL', windup: 0.36, active: 0.16, recovery: 0.55, stamina: 24, damage: 68, stagger: 14, kind: 'melee', reach: 2.1, radius: 2.3, lunge: 1.1, arc: { radius: 3.6, mirror: true }, hyperArmor: true, sfx: 'swing_heavy', shake: 0.24, hitstop: 0.07, color: 0xd9304a },
    { id: 'sig_l3', label: 'Headsplitter', anim: 'overhead', windup: 0.52, active: 0.16, recovery: 0.75, stamina: 30, damage: 98, stagger: 24, kind: 'melee', reach: 2.4, radius: 2.2, lunge: 1.4, arc: { radius: 3.9, tilt: -Math.PI / 2 }, hyperArmor: true, sfx: 'swing_heavy', shake: 0.34, hitstop: 0.1, color: 0xd9304a },
  ],
  heavy: { id: 'sig_h', label: 'Abyssal Cleave', anim: 'overhead', windup: 1.0, active: 0.2, recovery: 0.85, stamina: 46, damage: 215, stagger: 46, kind: 'melee', reach: 2.8, radius: 2.9, lunge: 1.8, arc: { radius: 5.0, tilt: -Math.PI / 2 }, hyperArmor: true, sfx: 'swing_heavy', shake: 0.6, hitstop: 0.16, color: 0x8e2cff },
  face: { cx: 0.51, cy: 0.145, h: 0.15, aspect: 821 / 1100 },
  passive: 'Unyielding — attacks are not interrupted and soak 30% of damage.',
  hints: { light: 'Greatsword combo', heavy: 'Abyssal Cleave', roll: 'Roll' },
};

const SYMBELINE: CharDef = {
  id: 'symbeline',
  name: 'Symbeline',
  title: 'Dancer',
  css: '#f2c230',
  color: 0xf2c230,
  hp: 95,
  stamina: 100,
  speed: 5.6,
  sprint: 7.8,
  height: 1.78,
  ranged: false,
  roll: { kind: 'twirl', duration: 0.46, distance: 4.6, iStart: 0.02, iEnd: 0.36, cost: 15 },
  light: [
    { id: 'sym_l1', label: 'Step', anim: 'jabR', windup: 0.12, active: 0.1, recovery: 0.24, stamina: 9, damage: 20, stagger: 4, kind: 'melee', reach: 1.5, radius: 1.7, lunge: 0.9, arc: { radius: 2.4, sweep: 2.4 }, cancelAt: 0.2, sfx: 'swing', hitstop: 0.025, color: 0xffd34a },
    { id: 'sym_l2', label: 'Turn', anim: 'jabL', windup: 0.1, active: 0.1, recovery: 0.24, stamina: 9, damage: 20, stagger: 4, kind: 'melee', reach: 1.5, radius: 1.7, lunge: 0.8, arc: { radius: 2.4, sweep: 2.4, mirror: true }, cancelAt: 0.2, sfx: 'swing', hitstop: 0.025, color: 0xffd34a },
    { id: 'sym_l3', label: 'Flourish', anim: 'jabR', windup: 0.1, active: 0.1, recovery: 0.26, stamina: 10, damage: 24, stagger: 5, kind: 'melee', reach: 1.6, radius: 1.8, lunge: 0.8, arc: { radius: 2.6, sweep: 2.6, pitch: 0.5 }, cancelAt: 0.2, sfx: 'swing', hitstop: 0.03, color: 0xffd34a },
    { id: 'sym_l4', label: 'Pirouette', anim: 'spin', windup: 0.16, active: 0.22, recovery: 0.42, stamina: 14, damage: 40, stagger: 10, kind: 'melee', reach: 0.6, radius: 2.9, lunge: 1.2, arc: { radius: 3.1, sweep: 6.1 }, sfx: 'swing', shake: 0.14, hitstop: 0.06, color: 0xff8a3a },
  ],
  heavy: { id: 'sym_h', label: 'Chakram Waltz', anim: 'throw', windup: 0.3, active: 0.12, recovery: 0.42, stamina: 28, damage: 30, stagger: 6, kind: 'boomerang', range: 17, sfx: 'chakram', color: 0xffd34a },
  face: { cx: 0.43, cy: 0.165, h: 0.17, aspect: 635 / 1100 },
  passive: 'Encore — every hit adds tempo (+4% damage, 10 max). Getting hit ends the dance.',
  hints: { light: 'Chakram flurry', heavy: 'Chakram Waltz (thrown)', roll: 'Twirl' },
};

const DEUX: CharDef = {
  id: 'deux',
  name: 'Deux du Chulette',
  title: 'Black Mage',
  css: '#a66bff',
  color: 0xa66bff,
  hp: 75,
  stamina: 100,
  speed: 4.9,
  sprint: 6.9,
  height: 1.02,
  ranged: true,
  roll: { kind: 'blink', duration: 0.34, distance: 5.2, iStart: 0.0, iEnd: 0.3, cost: 20 },
  light: [
    { id: 'deux_l', label: 'Ember', anim: 'bolt', windup: 0.2, active: 0.08, recovery: 0.3, stamina: 11, damage: 34, stagger: 5, kind: 'bolt', range: 60, cancelAt: 0.3, sfx: 'cast_fire', color: 0xff6a1a },
  ],
  heavy: { id: 'deux_h', label: 'Flare', anim: 'channel', windup: 1.55, active: 0.15, recovery: 0.7, stamina: 48, damage: 240, stagger: 32, kind: 'aoe', range: 60, aoeRadius: 4.6, sfx: 'cast_charge', shake: 0.7, hitstop: 0.14, color: 0xff3d1a },
  face: { cx: 0.53, cy: 0.23, h: 0.4, aspect: 793 / 1100 },
  passive: 'Kindle — each Ember that lands quickens the next Flare (3 max).',
  hints: { light: 'Ember bolt', heavy: 'Flare (long cast)', roll: 'Blink' },
};

const GHALUS: CharDef = {
  id: 'ghalus',
  name: 'Ghalus',
  title: 'White Mage',
  css: '#8ff0d2',
  color: 0x8ff0d2,
  hp: 90,
  stamina: 100,
  speed: 4.7,
  sprint: 6.6,
  height: 1.74,
  ranged: true,
  roll: { kind: 'roll', duration: 0.6, distance: 4.2, iStart: 0.04, iEnd: 0.34, cost: 22 },
  light: [
    { id: 'gha_l', label: 'Glint', anim: 'bolt', windup: 0.3, active: 0.08, recovery: 0.36, stamina: 13, damage: 30, stagger: 10, kind: 'ray', range: 60, cancelAt: 0.3, sfx: 'cast_holy', hitstop: 0.02, color: 0xfff2b0 },
  ],
  heavy: { id: 'gha_h', label: 'Sanctum', anim: 'channel', windup: 1.1, active: 0.15, recovery: 0.65, stamina: 42, damage: 125, stagger: 42, kind: 'aoe', range: 60, aoeRadius: 3.8, sfx: 'cast_charge', shake: 0.45, hitstop: 0.1, color: 0xfff2b0 },
  face: { cx: 0.45, cy: 0.115, h: 0.18, aspect: 738 / 1100 },
  passive: 'Benison — fighting as an ally he mends the wounded, and casts Cure when called.',
  hints: { light: 'Glint (instant ray)', heavy: 'Sanctum (pillar, breaks posture)', roll: 'Roll' },
};

/** Party order = number keys / d-pad order. */
export const PARTY: CharDef[] = [DEUX, SYMBELINE, GHALUS, SIGMUND];
export const START_INDEX = 3;

export const TUNING = {
  staminaRegen: 30,
  staminaDelay: 0.75,
  swapCooldown: 0.6,
  /** Seconds after taking control of a Knight in which their first attack hits harder. */
  tagWindow: 2.5,
  tagBonus: 1.5,
  sprintDrain: 11,
  hyperArmorSoak: 0.7,
  hurtTime: 0.5,
  downTime: 1.25,
  // Allies: the Knights fighting on their own while the player steers someone else
  allyDamage: 0.28,
  allyDamageTaken: 0.5,
  /** Scales how reliably allies react to danger (1 = each Knight's own skill). */
  allySkill: 1,
  /** How much more the boss favours the Knight the player controls when choosing a target. */
  aggroLeader: 6,
  // Ghalus, as an ally
  mendCooldown: 7,
  mendAmount: 0.22,
  mendBelow: 0.7,
  cureCharges: 3,
  cureCooldown: 6,
  cureAmount: 0.5,
  cureOthers: 0.15,
  // Buff stacks
  encoreMax: 10,
  encorePer: 0.04,
  kindleMax: 3,
  kindleCast: 0.3,
  kindleDamage: 0.12,
  /** Seconds after a dodge starts in which avoiding a hit counts as perfect. */
  perfectWindow: 0.16,
  perfectDodgeSlow: 0.3,
  perfectDodgeStamina: 18,
};
