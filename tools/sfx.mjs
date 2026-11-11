// Generates the game's sound effects (and optionally its boss theme) with ElevenLabs
// into public/audio, and writes the manifest the game loads. Anything not generated
// falls back to the built-in synth, so this can be run piecemeal.
//
//   node tools/sfx.mjs                 # everything that is missing
//   node tools/sfx.mjs boss_roar --force
//   node tools/sfx.mjs --list
//   node tools/sfx.mjs --music         # also (re)generate the boss theme
import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, sleep } from './keys.mjs';
import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio');

// name: [seconds, prompt, prompt influence]
const SOUNDS = {
  swing_1: [0.5, 'Fast sharp sword whoosh, a thin blade cutting through air, dry, close, no reverb', 0.5],
  swing_2: [0.5, 'Quick whip-like blade swish through the air, dry and close', 0.5],
  swing_heavy_1: [0.9, 'Heavy greatsword swing, a huge blade cutting air with a deep weighty whoosh', 0.5],
  swing_heavy_2: [0.9, 'Massive two-handed sword swing, low heavy whoosh of displaced air', 0.5],
  hit_1: [0.6, 'Sword striking stone armour, sharp metallic clang with a rock crack, punchy game impact', 0.5],
  hit_2: [0.6, 'Blade chopping into hard rock, bright clank and chipped stone, punchy', 0.5],
  hit_heavy: [1.1, 'Massive greatsword smashing into stone, deep booming impact with cracking rock', 0.5],
  hit_weak: [1.0, 'Crystal shattering on impact with a bright magical chime, glassy critical hit', 0.5],
  player_hurt: [0.6, 'Armoured body struck by a heavy blunt blow, dull thud and rattling plate, no voice', 0.5],
  player_down: [1.3, 'Armoured warrior collapsing onto a stone floor, heavy fall and clatter, no voice', 0.5],
  roll: [0.6, 'Quick dodge roll across a stone floor, cloth and leather rustle with a scuff', 0.5],
  blink: [0.6, 'Short magical teleport blink, airy pop followed by a soft shimmer', 0.5],
  perfect: [1.0, 'Bright crystalline chime sting as time slows, with a short reversed swell', 0.4],
  swap: [0.6, 'Quick magical whoosh with a soft sparkle, a hero tagging into battle', 0.4],
  cast_fire: [0.7, 'Small fireball launched from a staff, fiery whoosh', 0.5],
  cast_charge: [1.6, 'Magic energy charging up, a rising hum and crackle building to a peak', 0.5],
  explode: [2.2, 'Huge fiery magical explosion, deep boom followed by roaring flames', 0.5],
  cast_holy: [0.7, 'Short bright beam of holy light, a zap with a bell-like shimmer', 0.5],
  holy_burst: [1.9, 'Pillar of holy light erupting from the ground, shimmering choir-like blast with deep bass', 0.4],
  heal: [1.6, 'Gentle healing spell, warm rising chimes and soft sparkles', 0.4],
  chakram: [0.9, 'Spinning metal ring blade thrown, whirring through the air', 0.5],
  boss_step: [1.3, 'Colossal stone giant footstep, earth-shaking deep thud with falling rubble', 0.5],
  boss_slam: [2.2, 'Gigantic stone fist slamming the ground, enormous deep impact, cracking rock and debris', 0.5],
  boss_whoosh: [1.2, 'An enormous object swinging through the air, deep slow heavy whoosh', 0.5],
  boss_windup: [1.5, 'Massive stone golem creaking and grinding as it raises its arm, a deep ominous rising rumble', 0.5],
  boss_roar: [3.2, 'Colossal otherworldly titan roar, deep resonant bellow with metallic cosmic overtones', 0.4],
  boss_beam_charge: [1.6, 'Giant energy weapon charging, a rising whine over a deep rumble', 0.5],
  boss_beam: [2.0, 'Sustained massive energy beam firing, a searing continuous roar', 0.5],
  boss_stagger: [2.6, 'Giant stone colossus collapsing to its knees, crumbling impact with ringing shattered crystal', 0.5],
  boss_death: [5.5, 'Colossal stone giant breaking apart, a long crumbling collapse ending in a burst of cosmic energy', 0.4],
  meteor: [1.3, 'Meteor impact, a fiery streak ending in a heavy explosion on stone', 0.5],
  allout: [1.8, 'Dramatic anime finishing-move stinger, a punchy brass hit over a rising whoosh', 0.4],
  ui_victory: [5.0, 'Solemn triumphant orchestral fanfare with choir, dark fantasy victory, short', 0.4],
  ui_defeat: [4.0, 'Sombre low orchestral sting with a tolling bell, dark fantasy defeat', 0.4],
};

const MUSIC = {
  name: 'music_boss',
  ms: 90000,
  bed: 'Seamless loop of dark fantasy battle music: relentless pounding war drums, low sustained string drone and ominous wordless choir, tense and driving, instrumental',
  prompt:
    'Instrumental dark fantasy boss battle theme for a fight against a colossal star-giant. Pounding war drums, ominous wordless choir, frantic strings ostinato, heavy low brass, celesta and bells for a cold starlit feel. Intense and relentless, around 140 bpm, D minor. No vocals with lyrics. Ends in a way that loops back to the start.',
};

async function post(path, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io${path}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey('ELEVENLABS_API_KEY'), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await sleep(3000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${res.status} ${text.slice(0, 400)}`);
  }
  throw new Error('gave up after retries');
}

/** Generated clips vary a lot in level; bring each one's peak to -1 dB (needs ffmpeg). */
function normalize(file) {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  if (probe.error) return false;
  const m = /max_volume: (-?[\d.]+) dB/.exec(probe.stderr);
  if (!m) return false;
  const gain = -1 - Number(m[1]);
  if (Math.abs(gain) < 0.5) return true;
  const tmp = file.replace(/\.mp3$/, '.norm.mp3');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', `volume=${gain.toFixed(1)}dB`, '-b:a', '128k', tmp]);
  if (r.status !== 0) return false;
  renameSync(tmp, file);
  return true;
}

function writeManifest() {
  const files = readdirSync(OUT).filter((f) => f.endsWith('.mp3')).sort();
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(files, null, 1) + '\n');
  return files.length;
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const names = args.filter((a) => !a.startsWith('--'));
mkdirSync(OUT, { recursive: true });
if (args.includes('--list')) {
  for (const [n, [d]] of Object.entries(SOUNDS)) console.log(`${existsSync(join(OUT, `${n}.mp3`)) ? '✓' : ' '} ${n} (${d}s)`);
  process.exit(0);
}

const todo = Object.entries(SOUNDS).filter(([n]) => (names.length ? names.includes(n) : true) && (force || !existsSync(join(OUT, `${n}.mp3`))));
let failed = 0;
// A few at a time keeps well inside the API's concurrency limits.
const queue = [...todo];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [name, [duration_seconds, text, prompt_influence]] = job;
      try {
        const audio = await post('/v1/sound-generation?output_format=mp3_44100_128', { text, duration_seconds, prompt_influence, model_id: 'eleven_text_to_sound_v2' });
        writeFileSync(join(OUT, `${name}.mp3`), audio);
        normalize(join(OUT, `${name}.mp3`));
        console.log(`✓ ${name} (${(audio.length / 1024).toFixed(0)} kB)`);
      } catch (e) {
        failed++;
        console.error(`✗ ${name}: ${e.message}`);
      }
    }
  }),
);

if (args.includes('--music') && (force || !existsSync(join(OUT, `${MUSIC.name}.mp3`)))) {
  try {
    const audio = await post('/v1/music?output_format=mp3_44100_128', { prompt: MUSIC.prompt, music_length_ms: MUSIC.ms });
    writeFileSync(join(OUT, `${MUSIC.name}.mp3`), audio);
    console.log(`✓ ${MUSIC.name} (${(audio.length / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    console.warn(`  Music API unavailable (${e.message.slice(0, 90)}…); trying a looping bed from the sound-effect model instead`);
    try {
      const audio = await post('/v1/sound-generation?output_format=mp3_44100_128', { text: MUSIC.bed, duration_seconds: 30, prompt_influence: 0.4, loop: true, model_id: 'eleven_text_to_sound_v2' });
      writeFileSync(join(OUT, `${MUSIC.name}.mp3`), audio);
      console.log(`✓ ${MUSIC.name} as a 30 s loop (${(audio.length / 1024).toFixed(0)} kB)`);
    } catch (e2) {
      failed++;
      console.error(`✗ ${MUSIC.name}: ${e2.message}`);
    }
  }
}
if (args.includes('--normalize')) for (const f of readdirSync(OUT)) if (f.endsWith('.mp3') && !f.startsWith('music')) normalize(join(OUT, f));
console.log(`manifest: ${writeManifest()} files${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
