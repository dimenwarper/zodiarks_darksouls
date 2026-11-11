import SCRIPT from './script.json';
import { PARTY, type CharId } from '../chars/defs';

export type Speaker = CharId | 'boss';

interface Text {
  ja: string;
  en: string;
  /** Delivery note for the recording; never shown. */
  tone?: string;
}
/** One speaker's line. `bark` borrows a recording the battle chatter already has. */
interface Fixed extends Text {
  who: Speaker;
  bark?: string;
}
/** Said by whoever is being played, each Knight in their own words. */
interface Lead {
  lead: Record<CharId, Text>;
}
/** Answers from up to `count` of the others still standing. */
interface Reply {
  reply: Record<CharId, Text>;
  count: number;
}
type Entry = Fixed | Lead | Reply;

/** A line as it reaches the screen. */
export interface Spoken {
  who: Speaker;
  ja: string;
  en: string;
  /** Which recording goes with it. */
  voice: string;
}

export interface StoryHost {
  alive(who: CharId): boolean;
  /** The Knight being played. */
  lead(): CharId;
  /** Put the line on screen and speak it; returns how long it should stay up, in seconds. */
  say(line: Spoken): number;
  /** Take whatever is on screen away at once. */
  hide(): void;
}

export interface PlayOpts {
  /** Seconds to wait before the first line. */
  delay?: number;
  /** Go ahead of anything waiting, and talk over whatever is being said when its moment comes. */
  now?: boolean;
  /** Checked when the scene's turn comes, so a queued scene can be called off. */
  when?: () => boolean;
}

const SCENES = SCRIPT as unknown as Record<string, Entry[]>;
/** Pure exposition: once heard, not repeated on later attempts in the same sitting. */
const ONCE_A_SITTING = new Set(['lore', 'twelve', 'friends']);
const ORDER = PARTY.map((d) => d.id);

/**
 * The story told in dialog boxes while the fight goes on. The game says which scene a
 * moment calls for; this decides who is still able to say their lines, and feeds them out
 * one at a time. Nothing here stops play.
 */
export class Story {
  /** While set, the line on screen finishes but no new one starts (cinematics). */
  hold = false;
  private queue: { scene: string; at: number; when?: () => boolean; now?: boolean }[] = [];
  private scene: string | null = null;
  private index = 0;
  private lines: Spoken[] = [];
  private lastLead: CharId | null = null;
  private showing = 0;
  private gap = 0;
  private clock = 0;
  private played = new Set<string>();
  private heard = new Set<string>();

  constructor(private host: StoryHost) {}

  /** True while a scene is under way or a line is on screen. */
  get busy() {
    return this.scene !== null || this.showing > 0;
  }

  /** A new fight: every scene may play again, except what has already been explained. */
  reset() {
    this.abort();
    this.played.clear();
  }

  /** Drop everything, on screen and waiting. */
  abort() {
    this.queue.length = 0;
    this.endScene();
    this.showing = this.gap = 0;
    this.host.hide();
  }

  /** The line on screen was talked over: let the rest of that exchange go. */
  cut() {
    this.endScene();
    this.showing = 0;
    this.gap = 0.4;
    this.host.hide();
  }

  private endScene() {
    this.scene = null;
    this.lines.length = 0;
    this.index = 0;
  }

  has(scene: string) {
    return !!SCENES[scene];
  }

  /** Would anyone be able to say anything of this scene right now? */
  canPlay(scene: string) {
    if (!SCENES[scene] || this.played.has(scene) || (ONCE_A_SITTING.has(scene) && this.heard.has(scene))) return false;
    return SCENES[scene].some((e, i) => this.resolve(scene, e, i, false).length > 0);
  }

  /** Ask for a scene. Each plays at most once a fight. Returns whether it was taken up. */
  play(scene: string, opts: PlayOpts = {}): boolean {
    if (!this.canPlay(scene)) return false;
    this.played.add(scene);
    if (opts.now) this.queue.length = 0;
    this.queue.push({ scene, at: this.clock + (opts.delay ?? 0), when: opts.when, now: opts.now });
    return true;
  }

  private resolve(scene: string, e: Entry, i: number, commit: boolean): Spoken[] {
    const voice = `story-${scene}-${i}`;
    const host = this.host;
    if ('lead' in e) {
      const lead = host.lead();
      const who = host.alive(lead) ? lead : ORDER.find((id) => host.alive(id));
      if (!who || !e.lead[who]) return [];
      if (commit) this.lastLead = who;
      return [{ who, voice, ja: e.lead[who].ja, en: e.lead[who].en }];
    }
    if ('reply' in e) {
      return ORDER.filter((id) => id !== this.lastLead && host.alive(id) && e.reply[id])
        .slice(0, e.count)
        .map((who) => ({ who, voice, ja: e.reply[who].ja, en: e.reply[who].en }));
    }
    if (e.who !== 'boss' && !host.alive(e.who)) return [];
    return [{ who: e.who, voice: e.bark ?? voice, ja: e.ja, en: e.en }];
  }

  /** Real seconds: talk keeps its pace through hit-stop and slow motion. */
  update(dt: number) {
    this.clock += dt;
    if (this.busy && !this.hold && this.queue.some((q) => q.now && q.at <= this.clock && (!q.when || q.when()))) this.cut();
    if (this.showing > 0) {
      this.showing -= dt;
      if (this.showing > 0) return;
      this.gap = 0.3;
    }
    if (this.gap > 0) {
      this.gap -= dt;
      return;
    }
    if (this.hold) return;

    // Next line of the scene in hand; failing that, the next scene whose moment has come.
    while (!this.lines.length) {
      if (this.scene) {
        const entries = SCENES[this.scene];
        if (this.index >= entries.length) {
          this.endScene();
          continue;
        }
        this.lines.push(...this.resolve(this.scene, entries[this.index], this.index, true));
        this.index++;
        continue;
      }
      const due = this.queue.findIndex((q) => q.at <= this.clock);
      if (due < 0) return;
      const q = this.queue.splice(due, 1)[0];
      if (q.when && !q.when()) {
        // Called off, not told: it may be asked for again.
        this.played.delete(q.scene);
        continue;
      }
      this.scene = q.scene;
      this.index = 0;
      this.lastLead = null;
      this.heard.add(q.scene);
    }
    this.showing = this.host.say(this.lines.shift()!);
  }
}
