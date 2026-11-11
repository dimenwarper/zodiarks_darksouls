import { rand } from './math';

interface PlayOpts {
  volume?: number;
  rate?: number;
  /** Random pitch spread, e.g. 0.08 for +-8 %. */
  vary?: number;
}

type Recipe = (ctx: AudioContext, out: AudioNode, o: Required<PlayOpts>) => void;

/**
 * Sample playback with a synthesised fallback, so the game has sound even before
 * `tools/sfx.mjs` has generated the real effects into public/audio.
 */
export class AudioSys {
  ctx: AudioContext | null = null;
  muted = false;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private voiceBus: GainNode | null = null;
  private voiceFiles: string[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private music: { src: AudioBufferSourceNode; gain: GainNode; name: string } | null = null;
  private drone: { stop: () => void } | null = null;
  private noise: AudioBuffer | null = null;
  private manifest: string[] = [];
  private lastPlayed = new Map<string, number>();

  /** Must be called from a user gesture. */
  async unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.55;
      this.musicBus.connect(this.master);
      this.voiceBus = this.ctx.createGain();
      this.voiceBus.gain.value = 1.15;
      this.voiceBus.connect(this.master);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      void this.loadManifest();
      void this.loadVoices();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
  }

  private async loadManifest() {
    try {
      const res = await fetch('/audio/manifest.json');
      if (!res.ok) return;
      this.manifest = (await res.json()) as string[];
    } catch {
      return;
    }
    await Promise.all(
      this.manifest.map(async (file) => {
        try {
          const buf = await (await fetch(`/audio/${file}`)).arrayBuffer();
          const audio = await this.ctx!.decodeAudioData(buf);
          this.buffers.set(file.replace(/\.[a-z0-9]+$/, ''), audio);
        } catch {
          /* a missing or broken file just falls back to the synth */
        }
      }),
    );
    if (this.pendingMusic) this.playMusic(this.pendingMusic);
  }

  has(name: string) {
    return this.buffers.has(name);
  }

  /** Speech recordings (public/audio/voice). Decoded once the audio context exists. */
  preloadVoices(files: string[]) {
    this.voiceFiles = files;
    if (this.ctx) void this.loadVoices();
  }

  private async loadVoices() {
    const ctx = this.ctx;
    if (!ctx) return;
    await Promise.all(
      this.voiceFiles.map(async (file) => {
        const key = `voice/${file}`;
        if (this.buffers.has(key)) return;
        try {
          const buf = await (await fetch(`/audio/voice/${file}`)).arrayBuffer();
          this.buffers.set(key, await ctx.decodeAudioData(buf));
        } catch {
          /* a missing take is just not spoken */
        }
      }),
    );
  }

  /** Play one speech recording; the handle lets a more urgent line cut it short. */
  playVoice(file: string, volume = 1): { duration: number; stop: () => void } | null {
    const ctx = this.ctx;
    const buf = this.buffers.get(`voice/${file}`);
    if (!ctx || this.muted || !this.voiceBus || !buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.voiceBus);
    src.start();
    return {
      duration: buf.duration,
      stop: () => {
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
        try {
          src.stop(ctx.currentTime + 0.1);
        } catch {
          /* already ended */
        }
      },
    };
  }

  play(name: string, opts: PlayOpts = {}) {
    const ctx = this.ctx;
    if (!ctx || this.muted || !this.sfxBus) return;
    // Avoid stacking the same sound many times within a frame or two.
    const last = this.lastPlayed.get(name) ?? -1;
    if (ctx.currentTime - last < 0.035) return;
    this.lastPlayed.set(name, ctx.currentTime);
    const o = { volume: opts.volume ?? 1, rate: opts.rate ?? 1, vary: opts.vary ?? 0.06 };
    o.rate *= 1 + (rand() * 2 - 1) * o.vary;
    // Variants: name_1, name_2 ... picked at random when present.
    let buf = this.buffers.get(name);
    const variants = [1, 2, 3].map((i) => this.buffers.get(`${name}_${i}`)).filter(Boolean) as AudioBuffer[];
    if (variants.length) buf = variants[Math.floor(rand(variants.length))];
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = o.rate;
      const g = ctx.createGain();
      g.gain.value = o.volume;
      src.connect(g).connect(this.sfxBus);
      src.start();
      return;
    }
    const key = Object.keys(SYNTH).find((k) => name.startsWith(k));
    if (key) SYNTH[key](ctx, this.sfxBus, o);
  }

  private pendingMusic: string | null = null;

  playMusic(name: string) {
    this.pendingMusic = name;
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    if (this.music?.name === name) return;
    const buf = this.buffers.get(name);
    this.stopMusic(1.2, true);
    if (!buf) {
      this.startDrone();
      return;
    }
    this.stopDrone();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.5);
    src.connect(gain).connect(this.musicBus);
    src.start();
    this.music = { src, gain, name };
  }

  stopMusic(fade = 1.5, keepPending = false) {
    if (!keepPending) this.pendingMusic = null;
    this.stopDrone();
    const ctx = this.ctx;
    if (!ctx || !this.music) return;
    const { src, gain } = this.music;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fade);
    src.stop(ctx.currentTime + fade + 0.05);
    this.music = null;
  }

  /** Low ominous pad used when no music file exists. */
  private startDrone() {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || this.drone) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const oscs = [55, 55 * 1.498, 110.6, 164.4].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + i * 0.05;
      const lg = ctx.createGain();
      lg.gain.value = f * 0.006;
      lfo.connect(lg).connect(o.frequency);
      lfo.start();
      o.connect(lp);
      o.start();
      return [o, lfo];
    });
    lp.connect(g).connect(this.musicBus);
    this.drone = {
      stop: () => {
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
        for (const pair of oscs) for (const n of pair) n.stop(ctx.currentTime + 1.6);
      },
    };
  }

  private stopDrone() {
    this.drone?.stop();
    this.drone = null;
  }

  noiseBuffer() {
    return this.noise;
  }
}

let sys: AudioSys | null = null;
export function bindSynth(a: AudioSys) {
  sys = a;
}

function env(ctx: AudioContext, out: AudioNode, vol: number, attack: number, decay: number) {
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

function tone(ctx: AudioContext, out: AudioNode, f0: number, f1: number, dur: number, vol: number, type: OscillatorType = 'sine') {
  const o = ctx.createOscillator();
  o.type = type;
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  o.connect(env(ctx, out, vol, 0.005, dur));
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(ctx: AudioContext, out: AudioNode, f0: number, f1: number, dur: number, vol: number, q = 1, type: BiquadFilterType = 'bandpass', attack = 0.005) {
  const buf = sys?.noiseBuffer();
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  const t = ctx.currentTime;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  src.connect(f).connect(env(ctx, out, vol, attack, dur));
  src.start(t, Math.random());
  src.stop(t + dur + attack + 0.05);
}

/** Fallback recipes, matched by name prefix. */
const SYNTH: Record<string, Recipe> = {
  swing_heavy: (c, o, p) => noise(c, o, 300 * p.rate, 1400 * p.rate, 0.32, 0.5 * p.volume, 1.2, 'bandpass', 0.06),
  swing: (c, o, p) => noise(c, o, 900 * p.rate, 3200 * p.rate, 0.16, 0.35 * p.volume, 1.5, 'bandpass', 0.03),
  hit_weak: (c, o, p) => {
    noise(c, o, 5000, 1500, 0.18, 0.5 * p.volume, 0.8);
    tone(c, o, 1320 * p.rate, 660 * p.rate, 0.35, 0.3 * p.volume, 'triangle');
    tone(c, o, 1980 * p.rate, 990 * p.rate, 0.3, 0.18 * p.volume);
  },
  hit_heavy: (c, o, p) => {
    noise(c, o, 1800, 200, 0.3, 0.8 * p.volume, 0.7, 'lowpass');
    tone(c, o, 120 * p.rate, 40, 0.35, 0.8 * p.volume);
  },
  hit: (c, o, p) => {
    noise(c, o, 2600 * p.rate, 500, 0.12, 0.6 * p.volume, 0.8);
    tone(c, o, 190 * p.rate, 70, 0.14, 0.45 * p.volume, 'triangle');
  },
  player_hurt: (c, o, p) => {
    noise(c, o, 900, 200, 0.25, 0.7 * p.volume, 0.7, 'lowpass');
    tone(c, o, 160, 60, 0.25, 0.6 * p.volume, 'sawtooth');
  },
  player_down: (c, o, p) => tone(c, o, 220, 40, 0.9, 0.6 * p.volume, 'sawtooth'),
  roll: (c, o, p) => noise(c, o, 500, 1500, 0.22, 0.25 * p.volume, 0.9, 'bandpass', 0.05),
  blink: (c, o, p) => {
    tone(c, o, 300, 1800, 0.18, 0.2 * p.volume);
    noise(c, o, 3000, 8000, 0.2, 0.15 * p.volume, 2);
  },
  perfect: (c, o, p) => {
    tone(c, o, 1760, 1760, 0.5, 0.22 * p.volume);
    tone(c, o, 2637, 2637, 0.6, 0.16 * p.volume);
  },
  swap: (c, o, p) => {
    noise(c, o, 600, 4000, 0.2, 0.3 * p.volume, 1.5, 'bandpass', 0.04);
    tone(c, o, 520, 1040, 0.16, 0.18 * p.volume, 'triangle');
  },
  cast_fire: (c, o, p) => {
    noise(c, o, 1200, 300, 0.3, 0.45 * p.volume, 0.6, 'lowpass');
    tone(c, o, 500 * p.rate, 140, 0.25, 0.2 * p.volume, 'sawtooth');
  },
  cast_charge: (c, o, p) => {
    tone(c, o, 90, 420, 1.3, 0.22 * p.volume, 'sawtooth');
    noise(c, o, 300, 2400, 1.3, 0.2 * p.volume, 2, 'bandpass', 0.3);
  },
  explode: (c, o, p) => {
    noise(c, o, 3000, 60, 1.1, 1.0 * p.volume, 0.5, 'lowpass');
    tone(c, o, 90, 28, 0.9, 0.9 * p.volume);
  },
  cast_holy: (c, o, p) => {
    tone(c, o, 880 * p.rate, 1320 * p.rate, 0.3, 0.2 * p.volume);
    tone(c, o, 1318 * p.rate, 1975 * p.rate, 0.3, 0.12 * p.volume);
  },
  holy_burst: (c, o, p) => {
    for (const f of [523, 659, 784, 1046]) tone(c, o, f, f * 1.01, 1.0, 0.14 * p.volume);
    noise(c, o, 6000, 1200, 0.7, 0.3 * p.volume, 0.6, 'highpass');
  },
  heal: (c, o, p) => {
    [660, 880, 1100, 1320].forEach((f, i) => setTimeout(() => tone(c, o, f, f, 0.5, 0.16 * p.volume), i * 70));
  },
  chakram: (c, o, p) => {
    noise(c, o, 2500, 5000, 0.4, 0.25 * p.volume, 6, 'bandpass', 0.05);
    tone(c, o, 1400, 2200, 0.35, 0.08 * p.volume, 'triangle');
  },
  boss_step: (c, o, p) => {
    tone(c, o, 70, 24, 0.6, 1.0 * p.volume);
    noise(c, o, 400, 60, 0.5, 0.6 * p.volume, 0.5, 'lowpass');
  },
  boss_slam: (c, o, p) => {
    tone(c, o, 95, 20, 1.1, 1.2 * p.volume);
    noise(c, o, 2500, 50, 1.0, 1.0 * p.volume, 0.5, 'lowpass');
  },
  boss_whoosh: (c, o, p) => noise(c, o, 120, 700, 0.8, 0.8 * p.volume, 0.8, 'bandpass', 0.3),
  boss_windup: (c, o, p) => {
    noise(c, o, 90, 300, 1.0, 0.5 * p.volume, 1.2, 'bandpass', 0.5);
    tone(c, o, 50, 90, 1.0, 0.35 * p.volume, 'sawtooth');
  },
  boss_roar: (c, o, p) => {
    tone(c, o, 110, 48, 2.2, 0.7 * p.volume, 'sawtooth');
    tone(c, o, 163, 60, 2.0, 0.5 * p.volume, 'sawtooth');
    noise(c, o, 700, 150, 2.2, 0.8 * p.volume, 1.5, 'bandpass', 0.2);
  },
  boss_beam_charge: (c, o, p) => {
    tone(c, o, 110, 1400, 1.5, 0.3 * p.volume, 'sawtooth');
    noise(c, o, 500, 6000, 1.5, 0.25 * p.volume, 3, 'bandpass', 0.6);
  },
  boss_beam: (c, o, p) => {
    tone(c, o, 220, 180, 1.6, 0.5 * p.volume, 'sawtooth');
    noise(c, o, 4000, 2500, 1.6, 0.6 * p.volume, 0.7, 'bandpass', 0.05);
  },
  boss_stagger: (c, o, p) => {
    tone(c, o, 1200, 80, 1.2, 0.4 * p.volume, 'triangle');
    noise(c, o, 6000, 200, 1.4, 0.8 * p.volume, 0.6, 'lowpass');
    tone(c, o, 70, 24, 1.4, 1.0 * p.volume);
  },
  boss_death: (c, o, p) => {
    tone(c, o, 300, 20, 4, 0.8 * p.volume, 'sawtooth');
    noise(c, o, 5000, 40, 4, 1.0 * p.volume, 0.5, 'lowpass');
  },
  meteor: (c, o, p) => {
    noise(c, o, 2000, 80, 0.7, 0.8 * p.volume, 0.6, 'lowpass');
    tone(c, o, 140, 30, 0.6, 0.7 * p.volume);
  },
  allout: (c, o, p) => {
    for (const f of [220, 277, 330, 440]) tone(c, o, f, f * 2, 0.8, 0.2 * p.volume, 'sawtooth');
    noise(c, o, 800, 8000, 0.7, 0.4 * p.volume, 1, 'bandpass', 0.3);
  },
  seal_draw: (c, o, p) => {
    tone(c, o, 392, 784, 1.5, 0.14 * p.volume, 'triangle');
    tone(c, o, 1175, 2350, 1.5, 0.05 * p.volume);
    noise(c, o, 2500, 9000, 1.5, 0.16 * p.volume, 4, 'bandpass', 0.4);
  },
  sky_charge: (c, o, p) => {
    tone(c, o, 140, 1900, 0.95, 0.26 * p.volume, 'sawtooth');
    tone(c, o, 210, 2850, 0.95, 0.12 * p.volume, 'triangle');
    noise(c, o, 600, 8000, 0.95, 0.3 * p.volume, 3, 'bandpass', 0.5);
  },
  sky_beam: (c, o, p) => {
    tone(c, o, 62, 30, 2.0, 1.1 * p.volume);
    tone(c, o, 233, 110, 1.8, 0.4 * p.volume, 'sawtooth');
    for (const f of [523, 784, 1046]) tone(c, o, f, f * 0.5, 1.7, 0.12 * p.volume, 'triangle');
    noise(c, o, 7000, 300, 2.0, 1.0 * p.volume, 0.6, 'lowpass');
    noise(c, o, 2600, 4200, 1.6, 0.5 * p.volume, 0.7, 'bandpass', 0.04);
  },
  ui_victory: (c, o, p) => {
    [392, 523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(c, o, f, f, 1.6, 0.18 * p.volume, 'triangle'), i * 160));
  },
  ui_defeat: (c, o, p) => {
    [220, 185, 147, 110].forEach((f, i) => setTimeout(() => tone(c, o, f, f * 0.98, 2, 0.22 * p.volume, 'sawtooth'), i * 300));
  },
  ui: (c, o, p) => tone(c, o, 880, 880, 0.08, 0.15 * p.volume),
};
