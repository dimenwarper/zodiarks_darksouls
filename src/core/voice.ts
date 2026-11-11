import type { AudioSys } from './audio';
import { rand } from './math';

export interface VoiceTake {
  file: string;
  ja: string;
  /** English caption; empty for efforts and grunts, which play without one. */
  en: string;
}
export type VoiceManifest = Record<string, Record<string, VoiceTake[]>>;

export interface SayOpts {
  /** 0 = effort or grunt, 1 = remark, 2 = a line that must be heard (cuts in on anything lower). */
  priority?: 0 | 1 | 2;
  volume?: number;
  /** Probability of speaking at all. */
  chance?: number;
  /** Seconds to wait before speaking. */
  delay?: number;
  /** Seconds before this speaker may say this line again. */
  cooldown?: number;
  /** Checked at the moment of speaking, so a delayed line can be called off. */
  when?: () => boolean;
  /** Speak even while someone else's captioned line is still playing. */
  overlap?: boolean;
}

export const VOICE_TUNING = { volume: 1, captions: true, efforts: 1 };

interface Speaking {
  until: number;
  priority: number;
  stop: () => void;
}

/** Story dialogue outranks remarks, but a line that must be heard (priority 2) still cuts in. */
const STORY_PRIORITY = 1.5;

/**
 * Decides who gets to talk. Each speaker says one thing at a time, only one captioned line
 * is on screen at once, and a more important line cuts in on a lesser one. Recordings come
 * from `tools/voice.mjs`; with none on disk every call is a no-op.
 */
export class Voices {
  onCaption: ((who: string, take: VoiceTake, seconds: number) => void) | null = null;
  private manifest: VoiceManifest = {};
  private speaking = new Map<string, Speaking>();
  private caption: { who: string; until: number; priority: number; story?: boolean } | null = null;
  /** Called when a line that must be heard talks over the story dialogue on screen. */
  onStoryCut: (() => void) | null = null;
  private lastSaid = new Map<string, number>();
  private lastTake = new Map<string, number>();
  private pending: { at: number; who: string; line: string; opts: SayOpts }[] = [];
  private clock = 0;

  constructor(private audio: AudioSys) {}

  async load() {
    try {
      const res = await fetch('/audio/voice/manifest.json');
      if (!res.ok) return;
      this.manifest = (await res.json()) as VoiceManifest;
      this.audio.preloadVoices(Object.values(this.manifest).flatMap((lines) => Object.values(lines).flatMap((takes) => takes.map((t) => t.file))));
    } catch {
      /* no recordings: the game is simply silent of speech */
    }
  }

  has(who: string, line: string) {
    return !!this.manifest[who]?.[line]?.length;
  }

  /** Real seconds, so speech keeps its pace through hit-stop and slow motion. */
  update(dt: number) {
    this.clock += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.at > this.clock) continue;
      this.pending.splice(i, 1);
      this.speak(p.who, p.line, p.opts);
    }
  }

  /** Drop everything queued and cut off whoever is talking (restart, end of fight). */
  hush() {
    this.pending.length = 0;
    for (const s of this.speaking.values()) s.stop();
    this.speaking.clear();
    this.caption = null;
  }

  /**
   * A line of story dialogue. It is shown in a dialog box rather than as a caption, so this
   * only speaks it: over the speaker's own chatter and over whoever holds the caption.
   * Returns the recording's length in seconds, or 0 when there is none.
   */
  story(who: string, line: string, volume = 1): number {
    this.speaking.get(who)?.stop();
    if (this.caption && this.caption.until > this.clock) this.speaking.get(this.caption.who)?.stop();
    const take = this.manifest[who]?.[line]?.[0];
    if (this.audio.muted || !take) return 0;
    const playing = this.audio.playVoice(take.file, volume * VOICE_TUNING.volume);
    if (!playing) return 0;
    this.speaking.set(who, { until: this.clock + playing.duration, priority: STORY_PRIORITY, stop: playing.stop });
    return playing.duration;
  }

  /** A dialog box is up for this long: captioned remarks wait by not being said. */
  holdFloor(who: string, seconds: number) {
    this.caption = { who, until: this.clock + seconds, priority: STORY_PRIORITY, story: true };
  }

  /** The dialog box was taken down early. */
  yieldFloor() {
    if (!this.caption?.story) return;
    this.speaking.get(this.caption.who)?.stop();
    this.caption = null;
  }

  say(who: string, line: string, opts: SayOpts = {}) {
    if (this.audio.muted || !this.audio.ctx || !this.has(who, line)) return;
    if (opts.chance !== undefined && rand() > opts.chance * (opts.priority ? 1 : VOICE_TUNING.efforts)) return;
    if (opts.delay) this.pending.push({ at: this.clock + opts.delay, who, line, opts });
    else this.speak(who, line, opts);
  }

  private speak(who: string, line: string, opts: SayOpts) {
    if (this.audio.muted || (opts.when && !opts.when())) return;
    const takes = this.manifest[who]?.[line];
    if (!takes?.length) return;
    const priority = opts.priority ?? 0;
    const key = `${who}.${line}`;
    const cooldown = opts.cooldown ?? (priority === 0 ? 0.8 : priority === 1 ? 6 : 0);
    if (this.clock - (this.lastSaid.get(key) ?? -99) < cooldown) return;

    const mine = this.speaking.get(who);
    if (mine && mine.until > this.clock) {
      if (priority <= mine.priority) return;
      mine.stop();
    }
    const floor = this.caption && this.caption.until > this.clock ? this.caption : null;
    let i = Math.floor(rand(takes.length));
    if (takes.length > 1 && i === this.lastTake.get(key)) i = (i + 1) % takes.length;
    const take = takes[i];

    // One caption at a time: a remark waits its turn by simply not being said.
    if (take.en && !opts.overlap && floor && (floor.story || floor.who !== who)) {
      if (priority <= floor.priority) return;
      this.speaking.get(floor.who)?.stop();
      if (floor.story) {
        this.caption = null;
        this.onStoryCut?.();
      }
    }

    const playing = this.audio.playVoice(take.file, (opts.volume ?? 1) * VOICE_TUNING.volume);
    if (!playing) return;
    this.lastSaid.set(key, this.clock);
    this.lastTake.set(key, i);
    this.speaking.set(who, { until: this.clock + playing.duration, priority, stop: playing.stop });
    if (take.en) {
      this.caption = { who, until: this.clock + playing.duration, priority };
      if (VOICE_TUNING.captions) this.onCaption?.(who, take, playing.duration + 0.7);
    }
  }
}
