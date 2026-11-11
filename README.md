# Knights of the Zodiarks — The Exiled Sign

A soulslike boss-fight demo: four Knights against Ophiuchus, a twenty-metre colossus of floating obsidian
plates. All four are on the field at once — you steer one, the other three fight on their own, and you can
take over any of them at any moment. It opens with the Knights finding the colossus asleep, and they talk
their way through the fight in dialog boxes. Three.js + TypeScript, runs in the browser.

```bash
npm install
npm run dev          # http://127.0.0.1:5183
```

## Playing

| | Keyboard + mouse | Gamepad |
|---|---|---|
| Move / camera | WASD / mouse | left stick / right stick |
| Light attack | left click | RB |
| Heavy attack or spell | right click | RT |
| Dodge | Space | B |
| Sprint | Shift | hold A |
| Take over a Knight | 1–4, E, mouse wheel | d-pad |
| Lock on / next target | Q / Tab | R3 / LB |
| Call for Ghalus's Cure | R | X |
| All-Out Attack (boss staggered) | F | Y |
| Skip a scene | Enter | A |
| Pause | Esc | Start |
| Tuning panel | ` (backquote) | |

- **Deux** (1) — black mage. Ember bolts build Kindle, which quickens Flare. Dodge is a blink.
- **Symbeline** (2) — dancer. Fast chakram flurry; every hit adds Encore tempo until she is hit. Heavy throws both chakrams.
- **Ghalus** (3) — white mage. Steered: Glint (instant ray) and Sanctum (pillar that breaks posture).
  As an ally he Mends whoever is most wounded and casts Cure when you call for it (three charges).
- **Sigmund** (4) — dark knight. Slow greatsword combo that cannot be interrupted, and Abyssal Cleave.

Melee Knights work the ankles and any fist left on the ground; casters can reach the Star Core at any time.
Filling the blue posture bar staggers the boss, exposes the core and opens the All-Out Attack. Dodging at the
last moment slows time. Phase two starts at 55% health.

**Story.** The first start is an arrival: the Knights walk in under the galaxy, wonder at the sleeping
colossus (a short scene, one shot per line), and are then yours to walk up to it. It wakes when you come
close. From there the story follows the fight in small dialog boxes — portrait, name, the line typed out in
English over the Japanese that is spoken — without ever stopping play: what the thing is, why it hates the
number twelve, the friends waiting at home, and, when it is nearly beaten, whoever you are steering calling
out that this one is for the friends who believe in them (everyone's stamina comes back with it). Knights
who have fallen stay silent, and the others notice. "Fight again" skips the arrival and goes straight to
the awakening.

**All-Out Attack.** The seal of Zodiark writes itself on the floor under the boss — rings, rune band,
twelve-pointed star, the twelve signs and the Z at its heart. Every Knight still standing takes a tip of the
star and sends their power up as a stream in their own colour, a second seal opens in the sky where the
streams meet, and a column of light falls through it onto the Star Core. Each Knight's blow lands inside the
column, so the damage grows with the number of Knights on their feet.

**Allies.** The Knights you are not steering hold their own: melee Knights pick a limb, casters keep their
distance, and all of them dodge telegraphed blows (not always in time). They hit for about a quarter of a
steered Knight's damage and take half, so the fight is still yours to win. The boss mostly hunts whoever you
are steering — the red diamond on a portrait shows who it is after. Taking over a Knight leaves the old one
fighting where they stood; your first hit after taking over lands 50% harder. If the Knight you are steering
falls, control passes to the next one standing; the fight is lost when all four are down.

## Layout

```
src/game.ts            loop, hazards, All-Out Attack sequence, flow between title / fight / end
src/boss/colossus.ts   the boss: IK skeleton, attack scripts, phases, hit volumes, tuning numbers
src/chars/defs.ts      Knight stats, move sets and tuning numbers
src/chars/knight.ts    one Knight: body, state machine, moves, taking hits — driven by a Controls object
src/chars/party.ts     the four Knights: player controls, taking over, healing, projectiles, boss aggro
src/chars/ally.ts      the brain that drives a Knight you are not steering
src/chars/mannequin.ts procedural stand-in characters and their animations
src/chars/visual.ts    character-visual interface and the loader for generated models
src/world/             arena, camera, and the loader for generated scenery (props.ts)
src/world/sky.ts       the night sky: baked galaxy, stars, shooting stars
src/story/script.json  every line of story dialogue (Japanese, English, delivery note), scene by scene
src/story/story.ts     plays those scenes one line at a time, around whoever is still standing
src/core/              input, audio (samples + synth fallback), voice lines, effects, maths
src/core/seal.ts       the seal of Zodiark as pen strokes, the zodiac signs and runes, and the ribbons drawn from them
src/ui/hud.ts          HUD, banners, All-Out splash
src/debug/             tuning panel and the autoplay bot used for automated runs
tools/                 asset generation (below)
```

## Assets

| Tool | Makes | Needs |
|---|---|---|
| `node tools/refs.mjs` | reference art in `tools/refs/`: A-pose front/back views of the Knights from the cast sheets, and one drawing per boss armour piece and arena ruin from two concept paintings | `NANO_BANANA_API_KEY` |
| `node tools/tripo.mjs plan` | what is left to generate and a credit estimate; spends nothing | `TRIPO_API_KEY` |
| `node tools/tripo.mjs knight` | model → rig → animations per Knight | Tripo credits |
| `node tools/tripo.mjs weapon` | sword and staffs as separate models | Tripo credits |
| `node tools/tripo.mjs prop` | scenery: the boss's twelve armour pieces and six arena ruins (40 credits each) | Tripo credits |
| `node tools/tripo.mjs publish` | game-sized copies (webp textures) in `public/models/`; free | |
| `node tools/tripo.mjs manifest` | rewrites `public/models/manifest.json` from the table in the tool; free | |
| `node tools/sfx.mjs` | sound effects into `public/audio/` (`--music` for the theme) | `ELEVENLABS_API_KEY` |
| `node tools/voice.mjs` | the Knights' and the boss's spoken lines, in Japanese, into `public/audio/voice/` | `ELEVENLABS_API_KEY`, ffmpeg |

Keys are read from the environment or `~/.bash_profile`. Portraits and the cast sheets come from
`../zodiarks_video/v1/art/cast`.

A Knight listed in `public/models/manifest.json` is drawn with its generated model; anyone missing falls back to
the procedural stand-in, so the game always runs. Missing sounds fall back to a built-in synth the same way.
`tools/tripo-state.json` records every paid task, so an interrupted run resumes without paying twice.

Tripo's originals (4K textures, about 100 MB) stay in `tools/.cache/tripo`, which is not committed; `publish`
shrinks them to the 16 MB the game loads. The generated animation clips are long and generic, so the `KNIGHTS`
table in `tools/tripo.mjs` says which slice of which clip each game animation uses and where its hit frame is;
the loader stretches that slice over the move's windup and recovery. Weapon grips are in the same table.
Symbeline's chakrams are drawn in code.

### The boss and the arena

Ophiuchus keeps its procedural skeleton: every limb is still solved each frame, so attacks land where they
say they will. What changed is what hangs on the bones. Each plate is a generated model stretched onto the
shape it replaces (`SKIN` in `src/boss/colossus.ts` says how each one sits), and a small shader lights the
plates' rims and silver inlay in the boss's glow colour, which is how its wind-ups read. The arena's rim is
built from six models: a column on every line between two signs of the floor's wheel, a hooded star-watcher
over each sign, and a smashed plinth over the thirteenth. A piece missing from `public/models/props.json`
falls back to its plain procedural shape.

The boss also wears light. A tilted belt carrying the twelve signs turns around its chest, three sigils (the
largest holding the sign of Ophiuchus) orbit it, bands of runes circle its forearms and shins, and a ring of
runes counter-turns inside its halo. All of it is drawn in the boss's glow colour, so it goes from blue to
red and quickens in phase two, brightens with every wind-up, and goes out when the boss falls. The "glyphs"
slider in the tuning panel's Boss armour folder sets how bright it is.

### The sky

`src/world/sky.ts` draws the night. The Milky Way — clouds of stars, the dust lanes that split them, pink
and teal gas, a small spiral galaxy off to one side — comes from a noise shader that is far too slow to run
every frame, so it runs once at start-up into a cube map (`Sky.bake`), and the sky dome just looks that up
and adds two layers of pin-point stars. On top sit 4,200 brighter stars that twinkle and, every few seconds,
a shooting star. The eclipse of phase two stains all of it red. `SKY_LOOK` holds the brightness of the
galaxy and stars and how often a star falls; the band is laid out (`uPole`, `uCore`) so the moon stands to
the left of the colossus and the galaxy's core to its right as you walk in.

### Story

`src/story/script.json` is the whole script: a list of lines per scene, each with the speaker, the Japanese
that is spoken, the English that is shown, and a delivery note for the recording. A line can also be
`lead` (said by whoever is being steered, in their own words) or `reply` (answers from the others still
standing). `src/story/story.ts` plays a scene one line at a time and leaves out anyone who has fallen; each
scene plays once a fight, and the purely explanatory ones only once a sitting. The game decides when:

- `arrive`, `approach`, `wake` — the way in (`arrival()` and `awakening()` in `src/game.ts`; `ARRIVAL` holds
  the distances and walking pace, `BOSS_WAKE` in `src/boss/colossus.ts` how long the colossus takes to light
  up and stand). The shots of the opening scene are keyed by line, next to the script that plays them.
- `lore`, `twelve`, `friends`, `rally`, `final` — at 86, 70, 40, 22 and 8% of the boss's health (`BEATS`).
- `eclipse`, `allout`, `fallen-<knight>`, `alone`, `victory` — on the events they are named for.

Dialogue holds the floor against idle chatter, but a line that matters (a Knight going down, the boss's
second wind) cuts in and the rest of that exchange is dropped. To add or change lines, edit the JSON and run
`node tools/voice.mjs story`; a line with no recording still shows, timed for reading.

### The seal

`src/core/seal.ts` is a port of the rune from `../zodiarks_video/v2/scripts/rune.py`, with the same
proportions and the same order of drawing. The seal is kept as pen strokes, each with the moment the pen starts
and finishes it; the strokes become flat ribbons whose every vertex knows when the pen reaches it, and the
shader simply hides what has not been drawn yet. The signs and runes are hand-drawn polylines rather than font
glyphs, so they look the same on every machine and the pen can write them. The boss's ornaments are built from
the same strokes. `ALLOUT_LOOK` at the top of `src/game.ts` holds the sequence's sizes and timings (seal
radius, drawing time, height of the sky seal, width and length of the beam).

### Voices

Every Knight has about twenty short battle lines and the boss seven, spoken in Japanese with an English
caption; the story dialogue adds 43 more. `LINES` in `tools/voice.mjs` holds the battle lines (text, caption,
delivery note), the story lines come from `src/story/script.json`, and `CAST` picks the voice. Change any of
them and run the tool again: only the takes that changed are recorded (about 3,700 characters of ElevenLabs
quota for the full set, 1,700 of that the story). `src/core/voice.ts` decides who gets to talk: one line per
speaker at a time, one caption on screen at a time, and a line that matters cuts in on one that does not.

The free ElevenLabs plan can only use the default voices through the API, so the cast is chosen from those
and shaped afterwards with ffmpeg (pitch for build, an echo for the colossus). ElevenLabs says the default
voices are being retired on 31 December 2026; the recordings on disk keep working, but recording new lines
after that will need other voice ids in `CAST`.

## Testing without hands

`window.__game` in the browser console:

```js
__game.sim(60, { bot: true, skill: 0.9 })   // fast-forward 60 s with the autoplay bot; returns a summary
__game.until(() => cond, 10)                // step until a condition holds, then draw one frame
__game.snapshot()
```

`snapshot()` lists each Knight's state, damage dealt and taken, and what felled them. The tuning panel has an
Allies folder (damage, damage taken, dodge skill, how strongly the boss favours the steered Knight).

The bot is deliberately simple; it exercises every code path, it does not prove the fight feels right.
