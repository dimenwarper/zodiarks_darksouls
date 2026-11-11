# Knights of the Zodiarks — The Exiled Sign

A soulslike boss-fight demo: a switchable party of four Knights against Ophiuchus, a twenty-metre colossus
of floating obsidian plates. Three.js + TypeScript, runs in the browser.

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
| Swap Knight | 1–4, E, mouse wheel | d-pad |
| Lock on / next target | Q / Tab | R3 / LB |
| Ghalus's Cure | R | X |
| All-Out Attack (boss staggered) | F | Y |
| Pause | Esc | Start |
| Tuning panel | ` (backquote) | |

- **Deux** (1) — black mage. Ember bolts build Kindle, which quickens Flare. Dodge is a blink.
- **Symbeline** (2) — dancer. Fast chakram flurry; every hit adds Encore tempo until she is hit. Heavy throws both chakrams.
- **Ghalus** (3) — white mage. On the field: Glint (instant ray) and Sanctum (pillar that breaks posture).
  Off the field he slowly mends the party and can cast Cure (three charges).
- **Sigmund** (4) — dark knight. Slow greatsword combo that cannot be interrupted, and Abyssal Cleave.

Melee Knights work the ankles and any fist left on the ground; casters can reach the Star Core at any time.
Filling the blue posture bar staggers the boss, exposes the core and opens the All-Out Attack. Swapping gives a
moment of invulnerability; dodging or swapping at the last moment slows time. Phase two starts at 55% health.

## Layout

```
src/game.ts            loop, hazards, All-Out Attack sequence, flow between title / fight / end
src/boss/colossus.ts   the boss: IK skeleton, attack scripts, phases, hit volumes, tuning numbers
src/chars/defs.ts      Knight stats, move sets and tuning numbers
src/chars/party.ts     player controller: states, swapping, healing, projectiles, hit detection
src/chars/mannequin.ts procedural stand-in characters and their animations
src/chars/visual.ts    character-visual interface and the loader for generated models
src/world/             arena and camera
src/core/              input, audio (samples + synth fallback), effects, maths
src/ui/hud.ts          HUD, banners, All-Out splash
src/debug/             tuning panel and the autoplay bot used for automated runs
tools/                 asset generation (below)
```

## Assets

| Tool | Makes | Needs |
|---|---|---|
| `node tools/refs.mjs` | A-pose front/back references in `tools/refs/` from the cast sheets | `NANO_BANANA_API_KEY` |
| `node tools/tripo.mjs plan` | what is left to generate and a credit estimate; spends nothing | `TRIPO_API_KEY` |
| `node tools/tripo.mjs knight` | model → rig → animations per Knight, into `public/models/` | Tripo credits |
| `node tools/tripo.mjs weapon` | sword and staffs as separate models | Tripo credits |
| `node tools/sfx.mjs` | sound effects into `public/audio/` (`--music` for the theme) | `ELEVENLABS_API_KEY` |

Keys are read from the environment or `~/.bash_profile`. Portraits and the cast sheets come from
`../zodiarks_video/v1/art/cast`.

A Knight listed in `public/models/manifest.json` is drawn with its generated model; anyone missing falls back to
the procedural stand-in, so the game always runs. Missing sounds fall back to a built-in synth the same way.
`tools/tripo-state.json` records every paid task, so an interrupted run resumes without paying twice.

## Testing without hands

`window.__game` in the browser console:

```js
__game.sim(60, { bot: true, skill: 0.9 })   // fast-forward 60 s with the autoplay bot; returns a summary
__game.until(() => cond, 10)                // step until a condition holds, then draw one frame
__game.snapshot()
```

The bot is deliberately simple; it exercises every code path, it does not prove the fight feels right.
