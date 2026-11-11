// Records the Knights' and the boss's battle lines and story dialogue, in Japanese, with ElevenLabs
// text-to-speech, into public/audio/voice, and writes the manifest the game loads
// (which line, which file, the Japanese text and its English subtitle).
//
//   node tools/voice.mjs                 # every line that is missing or whose text/voice changed
//   node tools/voice.mjs sigmund         # one speaker
//   node tools/voice.mjs deux.heavy      # one line (all its takes)
//   node tools/voice.mjs story           # only the story dialogue (src/story/script.json)
//   node tools/voice.mjs --force         # record again even if nothing changed
//   node tools/voice.mjs --list          # what exists, and the character count still to spend
//
// The free ElevenLabs plan can only use the default voices through the API, so each speaker
// is cast from those and then shaped with ffmpeg: pitch for build (a tiny imp, a giant),
// an echo for the colossus. Recast by changing `voice` in CAST and running the tool again.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { apiKey, sleep } from './keys.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio', 'voice');
const MANIFEST = join(OUT, 'manifest.json');
const MODEL = 'eleven_v4';

/**
 * voice: an ElevenLabs default voice id. pitch: semitones applied afterwards.
 * stability: lower is more animated. fx: extra ffmpeg filters.
 */
const CAST = {
  deux: { voice: 'N2lVS1w4EtoT3dr4eOWO', as: 'Callum', pitch: 3, stability: 0.3 },
  symbeline: { voice: 'cgSgspJ2msm6clMCkdW9', as: 'Jessica', pitch: 0.5, stability: 0.3 },
  ghalus: { voice: 'JBFqnCBsd6RMkjVDRZzb', as: 'George', pitch: 0, stability: 0.45 },
  sigmund: { voice: 'pNInz6obpgDQGcFmaJgB', as: 'Adam', pitch: -2, stability: 0.4 },
  boss: {
    voice: 'nPczCjzI2devNBz1zQrb', as: 'Brian', pitch: -6, stability: 0.5,
    fx: 'aecho=0.8:0.75:70|140|260:0.4|0.28|0.16,lowpass=f=5200,bass=g=5:f=110',
  },
};

// Delivery notes the model reads (they are not spoken).
const SHOUT = '[shouting]';
const EFFORT = '[short sharp battle cry]';
const PAIN = '[cries out in pain]';
const WEAK = '[weakly, out of breath]';

/**
 * speaker: { line: [[japanese, english subtitle, delivery?], ...takes] }
 * Lines with an empty subtitle are efforts and grunts: the game plays them without a caption.
 */
const LINES = {
  deux: {
    start: [['さあ、商売の時間だ!', 'Time to do business!', '[mischievously]']],
    light: [['それっ!', '', EFFORT], ['ほいっ!', '', EFFORT], ['燃えな!', '', SHOUT]],
    heavy: [['フレア!', 'Flare!', SHOUT], ['まとめて灰になりな!', 'To ash, the lot of you!', SHOUT]],
    hurt: [['いてっ!', '', PAIN], ['うわっ!', '', PAIN]],
    down: [['ちょ、ちょっと待った…!', 'W-wait, time out…!', PAIN]],
    dodge: [['ヒヒッ、残念でした!', 'Hee hee, too bad!', '[laughing, mischievously]']],
    takeover: [['ボクの出番だね!', 'My turn!', '[excited]'], ['任せときな!', 'Leave it to me!', '[excited]']],
    healed: [['ツケにしといて!', 'Put it on my tab!', '[mischievously]']],
    fallen: [['店…閉めなきゃ…', 'Gotta… close up shop…', WEAK]],
    allyFallen: [['おい、寝るには早いぞ!', 'Hey, too early for a nap!', SHOUT]],
    stagger: [['今だ、たたみかけろ!', 'Now! Pile on!', SHOUT]],
    allout: [['特大サービスだ!', 'Extra large, on the house!', SHOUT]],
    phase2: [['聞いてないぞ、こんなの!', 'Nobody told me about this!', '[alarmed]']],
    low: [['割に合わないなぁ…', 'This is not worth the pay…', WEAK]],
    victory: [['まいどあり〜!', 'Pleasure doing business!', '[laughing, mischievously]']],
  },
  symbeline: {
    start: [['さあ、踊りましょ!', 'Come on, let\'s dance!', '[excited]']],
    light: [['はっ!', '', EFFORT], ['それっ!', '', EFFORT], ['ほらほら!', '', '[playfully, shouting]']],
    heavy: [['舞え、チャクラム!', 'Dance, chakrams!', SHOUT], ['受け取って!', 'Catch!', SHOUT]],
    hurt: [['きゃっ!', '', PAIN], ['痛っ!', '', PAIN]],
    down: [['ちょっと…乱暴ね…!', 'Hey… so rough…!', PAIN]],
    dodge: [['あはっ、遅い遅い!', 'Aha, too slow!', '[laughing]']],
    takeover: [['あたしの番ね!', 'My turn!', '[excited]'], ['見ててよね!', 'Watch me!', '[excited]']],
    healed: [['ありがと、助かったわ!', 'Thanks, I needed that!', '[warmly]']],
    fallen: [['パーティは…おしまい…?', 'Is the party… over…?', WEAK]],
    allyFallen: [['うそ、しっかりして!', 'No! Hang in there!', '[alarmed, shouting]']],
    stagger: [['チャンスよ、みんな!', 'Here\'s our chance, everyone!', SHOUT]],
    allout: [['フィナーレよ!', 'Time for the finale!', SHOUT]],
    phase2: [['あら、まだ踊れるの?', 'Oh? You can still dance?', '[amused]']],
    low: [['まだ…踊れるわ…!', 'I can… still dance…!', WEAK]],
    victory: [['最高の夜だったわ!', 'What a night!', '[laughing, delighted]']],
  },
  ghalus: {
    start: [['やれやれ…手早く済ませましょう。', 'Good grief… let us be quick about this.', '[sighs]']],
    light: [['光よ!', '', SHOUT], ['そこです!', '', SHOUT], ['はっ!', '', EFFORT]],
    heavy: [['聖域よ!', 'Sanctum!', SHOUT], ['裁きの光を!', 'Light of judgement!', SHOUT]],
    hurt: [['くっ…!', '', PAIN], ['ぬうっ…!', '', PAIN]],
    down: [['年には…勝てませんね…', 'I am not as young as I was…', PAIN]],
    dodge: [['おっと、危ない。', 'Whoa. That was close.', '[calm, amused]']],
    takeover: [['私が出ましょう。', 'I shall step in.', '[calm, firm]'], ['お任せを。', 'Leave it to me.', '[calm, firm]']],
    mend: [['癒しを。', 'Be healed.', '[calm, warmly]'], ['じっとしていなさい。', 'Hold still.', '[calm, firm]']],
    cure: [['みなさん、立て直しますよ!', 'Everyone, we regroup!', SHOUT]],
    fallen: [['お茶の…時間が…', 'My tea… time…', WEAK]],
    allyFallen: [['いけません…!', 'No…!', '[alarmed]']],
    stagger: [['今です、総攻撃を!', 'Now! All-out attack!', SHOUT]],
    allout: [['星よ、導きたまえ!', 'Stars, guide us!', SHOUT]],
    phase2: [['ここからが本番のようですね。', 'So the real fight begins here.', '[calm, grave]']],
    low: [['少々…無理をしましたか…', 'Perhaps I overdid it…', WEAK]],
    victory: [['さて、お茶にしましょうか。', 'Now then. Shall we have tea?', '[calm, warmly]']],
  },
  sigmund: {
    start: [['……行くぞ。', '…Let\'s go.', '[low, gruff]']],
    light: [['ふんっ!', '', EFFORT], ['はあっ!', '', EFFORT], ['ぬんっ!', '', EFFORT]],
    heavy: [['砕けろ!', 'Shatter!', SHOUT], ['闇に沈め!', 'Sink into the dark!', SHOUT]],
    hurt: [['ぐっ…!', '', PAIN], ['ちっ…!', '', '[annoyed grunt]']],
    down: [['ぐあっ…!', '', PAIN]],
    dodge: [['…見切った。', '…Read it.', '[low, gruff]']],
    takeover: [['任せろ。', 'Leave it to me.', '[low, gruff]'], ['俺がやる。', 'I\'ll do it.', '[low, gruff]']],
    healed: [['…助かる。', '…Thanks.', '[low, gruff]']],
    fallen: [['すまん…', 'Sorry…', WEAK]],
    allyFallen: [['…許さん。', '…Unforgivable.', '[low, angry]']],
    stagger: [['今だ、叩き込め!', 'Now! Hit it hard!', SHOUT]],
    allout: [['終わりだ!', 'This ends!', SHOUT]],
    phase2: [['…面白い。', '…Interesting.', '[low, gruff]']],
    low: [['まだ…倒れん…!', 'Not… falling yet…!', WEAK]],
    victory: [['…昼飯にするか。', '…Time for lunch.', '[low, gruff]']],
  },
  boss: {
    intro: [['我が名を…呼ぶのは…誰だ…', 'Who… calls… my name…', '[very slow, deep, ominous]']],
    phase2: [['十三番目の星は…己が名を忘れぬ!', 'The thirteenth star does not forget its name!', '[deep, furious, shouting]']],
    taunt: [['塵に還れ。', 'Return to dust.', '[very slow, deep, cold]']],
    starfall: [['星よ、降れ。', 'Stars, fall.', '[slow, deep, commanding]']],
    beam: [['消えよ!', 'Begone!', '[deep, shouting]']],
    stagger: [['ぬうっ…!', '', '[deep groan of pain]']],
    death: [['星々よ…我を…忘れるな…', 'O stars… do not… forget me…', '[very slow, deep, fading, dying]']],
  },
};

// Story dialogue lives with the game (src/story/script.json), which also shows it on screen.
// Each line is recorded for its speaker as `story-<scene>-<index>`; lines that borrow an
// existing recording (`bark`) need nothing new.
const STORY = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'story', 'script.json'), 'utf8'));
for (const [scene, entries] of Object.entries(STORY)) {
  entries.forEach((e, i) => {
    const id = `story-${scene}-${i}`;
    if (e.bark) return;
    const each = e.who ? { [e.who]: e } : (e.lead ?? e.reply);
    for (const [who, t] of Object.entries(each)) LINES[who][id] = [[t.ja, t.en, t.tone]];
  });
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const wanted = args.filter((a) => !a.startsWith('--'));
const want = (who, line) => !wanted.length || wanted.includes(who) || wanted.includes(`${who}.${line}`) || (wanted.includes('story') && line.startsWith('story-'));
const fileOf = (who, line, i) => `${who}_${line}_${i + 1}.mp3`;
const old = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
const stamp = (who, [ja, , tag]) => `${MODEL}|${CAST[who].voice}|${CAST[who].pitch}|${CAST[who].stability}|${CAST[who].fx ?? ''}|${tag ?? ''}|${ja}`;

const jobs = [];
for (const [who, lines] of Object.entries(LINES)) {
  for (const [line, takes] of Object.entries(lines)) {
    takes.forEach((take, i) => {
      const file = fileOf(who, line, i);
      const was = old[who]?.[line]?.[i];
      const fresh = existsSync(join(OUT, file)) && was?.stamp === stamp(who, take);
      jobs.push({ who, line, i, take, file, todo: want(who, line) && (force || !fresh) });
    });
  }
}

if (args.includes('--list')) {
  for (const j of jobs) console.log(`${j.todo ? ' ' : '✓'} ${`${j.who}.${j.line}`.padEnd(22)} ${j.take[0]}  ${j.take[1] ? `— ${j.take[1]}` : ''}`);
  const chars = jobs.filter((j) => j.todo).reduce((n, j) => n + j.take[0].length + (j.take[2]?.length ?? 0) + 1, 0);
  console.log(`\n${jobs.length} takes, ${jobs.filter((j) => j.todo).length} to record (about ${chars} characters of quota)`);
  process.exit(0);
}

async function speak(who, [ja, , tag], seed) {
  const c = CAST[who];
  const body = {
    text: tag ? `${tag} ${ja}` : ja,
    model_id: MODEL,
    language_code: 'ja',
    seed,
    voice_settings: { stability: c.stability, similarity_boost: 0.8 },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${c.voice}?output_format=mp3_44100_128`, {
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
    throw new Error(`${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error('gave up after retries');
}

const ff = (a) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { encoding: 'utf8' });
function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout) || 0;
}

// A grunt is one sound: the model likes to follow a shout with a second one, so an effort
// ends at its first real pause.
const ONE_BURST = 'silenceremove=stop_periods=1:stop_duration=0.18:stop_threshold=-38dB';

/** Trim the silence either side, shift the pitch, add the speaker's effects, level the result. */
function finish(raw, dest, who, effort) {
  const c = CAST[who];
  const trim = `silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse${effort ? `,${ONE_BURST}` : ''}`;
  const k = 2 ** (c.pitch / 12);
  // Resampling changes pitch and speed together; atempo gives most of the speed back, so a
  // deeper voice also ends up a little slower and a higher one a little quicker.
  const pitch = c.pitch ? `,asetrate=${Math.round(44100 * k)},aresample=44100,atempo=${(1 / k ** 0.75).toFixed(4)}` : '';
  const fx = c.fx ? `,${c.fx}` : '';
  const tmp = dest.replace(/\.mp3$/, '.tmp.wav');
  let r = ff(['-i', raw, '-af', `${trim}${pitch}${fx}`, tmp]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.slice(0, 300)}`);
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', tmp, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(probe.stderr)?.[1] ?? 0);
  r = ff(['-i', tmp, '-af', `volume=${(-1.5 - peak).toFixed(1)}dB,afade=t=in:d=0.01`, '-ac', '1', '-b:a', '96k', dest]);
  rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.slice(0, 300)}`);
}

mkdirSync(OUT, { recursive: true });
if (spawnSync('ffmpeg', ['-version']).error) {
  console.error('ffmpeg is needed to trim and shape the recordings (brew install ffmpeg)');
  process.exit(1);
}

const stamps = {};
let failed = 0;
let spent = 0;
const queue = jobs.filter((j) => j.todo);
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      const dest = join(OUT, j.file);
      const raw = dest.replace(/\.mp3$/, '.raw.mp3');
      // The model sometimes rambles on a two-syllable shout; a take far longer than the
      // text warrants is recorded again with another seed.
      const longest = 1.3 + 0.3 * j.take[0].length + (j.who === 'boss' ? 2.5 : 0);
      try {
        let secs = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          const audio = await speak(j.who, j.take, 1000 + j.i * 17 + attempt * 101);
          spent += j.take[0].length + (j.take[2]?.length ?? 0) + 1;
          writeFileSync(raw, audio);
          finish(raw, dest, j.who, !j.take[1]);
          secs = duration(dest);
          if (secs >= 0.15 && secs <= longest) break;
          console.warn(`  ${j.who}.${j.line} take ${j.i + 1}: ${secs.toFixed(2)} s is outside 0.15–${longest.toFixed(1)} s, recording again`);
        }
        rmSync(raw, { force: true });
        stamps[j.file] = stamp(j.who, j.take);
        console.log(`✓ ${j.file.padEnd(28)} ${secs.toFixed(2)} s  ${j.take[0]}`);
      } catch (e) {
        failed++;
        rmSync(raw, { force: true });
        console.error(`✗ ${j.file}: ${e.message}`);
      }
    }
  }),
);

// Manifest: everything on disk that the table still describes.
const manifest = {};
for (const j of jobs) {
  if (!existsSync(join(OUT, j.file))) continue;
  const entry = { file: j.file, ja: j.take[0], en: j.take[1], stamp: stamps[j.file] ?? old[j.who]?.[j.line]?.[j.i]?.stamp ?? '' };
  ((manifest[j.who] ??= {})[j.line] ??= [])[j.i] = entry;
}
for (const lines of Object.values(manifest)) for (const k of Object.keys(lines)) lines[k] = lines[k].filter(Boolean);
writeFileSync(MANIFEST + '.tmp', JSON.stringify(manifest, null, 1) + '\n');
renameSync(MANIFEST + '.tmp', MANIFEST);
const total = Object.values(manifest).reduce((n, l) => n + Object.values(l).reduce((m, t) => m + t.length, 0), 0);
console.log(`manifest: ${total} takes${spent ? `, about ${spent} characters used` : ''}${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
