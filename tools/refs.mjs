// Generates clean 3D-modelling references.
//
// Knights: one front and one back view each, from the cast sheets, in an A-pose with empty
// hands, which is what image-to-3D and auto-rigging need. (The cast sheets pose each view
// differently and hold weapons.)
//
// Scenery: the boss's armour pieces and the arena's ruins. Each group starts from one concept
// painting; every piece is then drawn alone against grey, with the concept attached so the
// pieces share one design.
//
//   node tools/refs.mjs                    # everything that is missing
//   node tools/refs.mjs sigmund --force    # redo one Knight
//   node tools/refs.mjs boss_helm --force  # redo one piece (boss_concept / arena_concept redo the painting)
//   node tools/refs.mjs --list
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, sleep } from './keys.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAST = join(ROOT, '..', 'zodiarks_video', 'v1', 'art', 'cast');
const OUT = join(ROOT, 'tools', 'refs');
const MODEL = 'gemini-3-pro-image';
const API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const POSE = `Standing in a strict A-pose for 3D modelling: arms straight, held about 40 degrees out from the body, hands open with fingers together; legs straight, feet shoulder-width apart and flat on the ground; head level, calm neutral expression, mouth closed.
EMPTY HANDS: no weapon, staff, book, tool or prop anywhere in the image, and nothing strapped to the back.
Cloth and hair hang straight down at rest: no wind, no motion.
Exactly the same character design as the attached model sheet: same face, hair, outfit, colours, trim and body proportions, in the same clean anime style.
Flat, even studio lighting: no cast shadow on the ground, no rim light, no bloom, no gradients in the background.
Background: plain flat light grey. One figure only, centred, the whole body inside the frame from the very top of the head (ears, horns) to the soles of the feet, with a small margin. No text, labels or watermark.`;

const KNIGHTS = {
  deux: 'He is a tiny, child-sized character with a slightly large head: keep those short proportions. His long coat hangs closed and straight. Keep the twisted black horns, the black X across his face and the pointed ears.',
  symbeline: 'Tall and slender with long rabbit ears standing straight up. Her long golden hair falls straight down her back, behind the shoulders, not over the arms. Remove the loose red shawl from her arms entirely. Her long red skirt hangs straight to the ankles.',
  ghalus: 'His long white robe hangs straight to the ankles, wide sleeves hanging from the arms. Keep the round glasses, cat ears and short white goatee. His fluffy white tail hangs down behind him.',
  sigmund: 'Very tall and broad-shouldered in full black plate armour. His tattered dark cape hangs straight down behind him, not wrapped around the body. Remove the greatsword completely.',
};

const ALONE = `Only this one object: nothing else in the image, no figure, no stand, no ground. It floats centred with the whole object inside the frame and a clear margin all round.
Plain flat light grey background. Flat, even studio lighting from the front: no cast shadow, no rim light, no bloom, no glow, no fog. No text, labels or watermark.`;

const BOSS_LOOK = `Material and style, identical on every piece: thick plates of faceted blue-black obsidian, knapped like volcanic glass with crisp bevelled edges; thin inlaid lines of bright silver tracing constellations, with small silver star studs where the lines meet; a border of engraved serpent scales; trim of tarnished pale gold. Stylised hard-surface game art, clean readable shapes, slightly matte. The silver inlay is plain metal: nothing glows.`;

const ARENA_LOOK = `Material and style, identical on every piece: ancient weathered blue-grey stone, chipped and cracked, with shallow carved bands of constellation lines and zodiac glyphs worn almost smooth; a little pale lichen. Stylised game art with clean readable shapes. Nothing glows.`;

/**
 * name: [aspect, image it follows (or null for a concept), prompt].
 * A piece follows either its concept painting or, where the painting kept leaking into the
 * drawing (a whole figure instead of one plate, the scene's mist around a column), another
 * piece that came out clean. A piece's proportions matter: it is stretched onto a part of
 * the game's skeleton, so each prompt states the shape it has to fill.
 */
const SCENERY = {
  boss_concept: ['3:4', null, `Concept art for a video-game boss: OPHIUCHUS, the exiled thirteenth sign of the zodiac. A colossal humanoid guardian twenty metres tall, built from separate floating armour plates that do not touch one another, with empty dark space between them: there is no body inside the armour.
A blind great-helm with no face, only a narrow horizontal visor slit, and a long pointed chin guard. A broad chest carapace, wide at the shoulders and narrow at the waist, open in the middle around an empty round socket, with three curved rib prongs either side of the socket and a thick collar ring. Huge layered shoulder pauldrons, each with one upswept spike. Thick tapered plates for the upper arms, forearms, thighs and shins; enormous clenched gauntlet fists; heavy plated boots. A hexagonal waist girdle with a long hanging plate on each hip. Long blade-like shards hover behind the shoulders like wings.
${BOSS_LOOK}
Full body, straight front view, standing upright with arms slightly away from the sides. Plain flat light grey background, flat even studio lighting, no cast shadow, no text.`],
  boss_helm: ['1:1', 'boss_chest', `A HELMET alone, for a giant suit of armour: a tall closed great-helm with a smooth faceted dome, flat cheek plates, and a narrow T-shaped opening in the face (a dark slot: no eyes, no face). A low ridge runs over the crown, and the bottom edge ends level at the jaw in a short pointed chin. It is a helmet, not a shoulder piece: one rounded shell, no overlapping skirt plates, no spikes. Hollow, with no neck or body below it. About one and a quarter times as tall as it is wide. Straight front view, seen level.`],
  boss_chest: ['1:1', 'boss_concept', `The colossus's CHEST CARAPACE alone: one broad breastplate shaped like an inverted trapezoid, wide across the top and narrowing to the waist, with a large empty round socket through the middle of the front, three curved rib prongs either side of the socket pointing inward, and a thick collar ring on top. No shoulder pieces, no arms, no head. About twice as wide as it is tall. Straight front view, seen level.`],
  boss_pelvis: ['1:1', 'boss_tasset', `A WAIST GIRDLE alone: a squat six-sided ring of overlapping plates, slightly wider at the top than the bottom, like a faceted armoured belt, hollow and open through the middle from top to bottom. No legs, no feet, no hanging plates: nothing above or below the ring. About twice as wide as it is tall. Front view from slightly above.`],
  boss_tasset: ['3:4', 'boss_concept', `One HIP PLATE alone: a single long flat hanging plate like a narrow kite shield, widest at the top and tapering to a blunt point at the bottom, slightly curved, twice as tall as it is wide and thin. Straight front view, hanging upright.`],
  boss_pauldron: ['1:1', 'boss_concept', `One SHOULDER PAULDRON alone: a massive rounded dome of three overlapping faceted plates with a single large spike sweeping up and outward from its top right. Hollow underneath. A little wider than it is tall. Front view from slightly above.`],
  boss_arm: ['3:4', 'boss_concept', `One UPPER-ARM PLATE alone: a thick six-sided sleeve of layered plates standing upright like a short tapered column, wider at the top than the bottom, open at both ends, about twice as tall as it is wide. Straight front view, seen level.`],
  boss_forearm: ['3:4', 'boss_arm', `One FOREARM GUARD alone: a heavy six-sided vambrace standing upright like a tapered column, narrow at the top (the elbow) and flaring wider toward the bottom (the wrist), with a raised fin along its outer edge, open at both ends, about twice as tall as it is wide. Straight front view, seen level.`],
  boss_fist: ['1:1', 'boss_concept', `One enormous GAUNTLET FIST alone: a tightly clenched armoured fist of faceted plates, blocky and heavy, cut off cleanly at the wrist with no arm, knuckles toward the viewer and slightly down. Roughly as wide as it is tall and deep. Three-quarter front view.`],
  boss_thigh: ['3:4', 'boss_arm', `One THIGH PLATE alone: a thick six-sided cuisse of layered plates standing upright like a tapered column, broad at the top (the hip) and narrower at the bottom (the knee), open at both ends, about twice as tall as it is wide. Straight front view, seen level.`],
  boss_shin: ['3:4', 'boss_arm', `One SHIN GUARD alone: a heavy greave standing upright: a full round six-sided sleeve, as deep as it is wide (a thick tube, not a flat plate), with a pointed knee cap plate rising from the front of its top edge, tapering a little toward the ankle and flaring slightly at the bottom, open at both ends. About two and a half times as tall as it is wide. Three-quarter front view from slightly above, so that its roundness and the opening at the top both show.`],
  boss_foot: ['1:1', 'boss_concept', `One ARMOURED BOOT alone: a huge plated sabaton, only the foot (cut off cleanly at the ankle, no leg), long and low with overlapping plates over the instep, a blunt wedge toe and a flat sole. Nearly twice as long as it is wide, and low. Three-quarter view from the front left and slightly above, toe pointing toward the lower left.`],
  boss_wing: ['3:4', 'boss_concept', `One WING SHARD alone: a single long thin blade of knapped obsidian shaped like a narrow feather or spearhead, pointed at both ends, flat and thin, with a silver spine line down its length, standing upright. About five times as tall as it is wide. Straight front view.`],

  arena_concept: ['4:3', null, `Concept art for a video-game arena: the Wheel of the Zodiac, a ruined open-air observatory on a mountaintop under a huge full moon. A wide circular stone floor inlaid with constellation lines, ringed by tall fluted stone columns, some standing and some snapped off, with fallen column drums at their feet. Between the columns stand tall statues of hooded, robed star-watchers, each cradling a faceted orb; one plinth stands empty and broken. Low stone-and-bronze fire bowls on short pedestals.
${ARENA_LOOK}
Wide establishing view from inside the circle, clear even lighting so every shape reads, no characters, no text.`],
  arena_pillar: ['9:16', 'arena_statue', `One intact COLUMN alone: a tall fluted stone column standing on a square plinth, with a square capital block on top and one carved band of zodiac glyphs around the shaft a third of the way up. The whole column is visible from the bottom of the plinth to the top of the capital. About five times as tall as it is wide. Straight front view, seen level.`],
  arena_stump: ['3:4', 'arena_pillar', `One BROKEN COLUMN alone: the same fluted stone column snapped off low, standing on its square plinth, with a jagged, uneven broken top. One solid piece: no loose or floating fragments. About two and a half times as tall as it is wide. Straight front view, seen level.`],
  arena_drum: ['1:1', 'arena_pillar', `One fallen COLUMN DRUM alone: a single short cylindrical section broken out of the same fluted stone column, lying on its side, with chipped, broken ends. Just the cylinder: no plinth, no base, no capital, no loose fragments. About one and a half times as long as it is thick. Three-quarter view.`],
  arena_brazier: ['1:1', 'arena_pillar', `One FIRE BOWL alone: a wide shallow stone bowl banded with dark bronze, standing directly on three short stout stone legs, empty (no fire, no coals, no smoke). No plinth or base under the legs. About as tall as it is wide. Front view from slightly above so the inside of the bowl shows.`],
  arena_statue: ['3:4', 'arena_concept', `One STATUE alone: a tall weathered stone statue of a hooded, robed star-watcher standing on a low round plinth, hands together at the chest cradling a faceted stone orb, face lost in the shadow of the hood, long robe falling straight with faint carved constellation lines. All one piece of stone. About three times as tall as it is wide. Straight front view, seen level.`],
  arena_plinth: ['1:1', 'arena_statue', `One EMPTY PLINTH alone: the same low round stone plinth, but its statue has been smashed away: only a jagged stump of the robe's hem, ankle-high, is left standing on it, with a few broken blocks of stone lying on the plinth. Wider than it is tall. Front view from slightly above.`],
};
const lookOf = (name) => (name.startsWith('boss') ? BOSS_LOOK : ARENA_LOOK);

async function generate(prompt, refs, out, aspectRatio = '3:4') {
  const parts = [{ text: prompt }, ...refs.map((p) => ({ inline_data: { mime_type: 'image/png', data: readFileSync(p).toString('base64') } }))];
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize: '2K' } },
  };
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey('NANO_BANANA_API_KEY') }, body: JSON.stringify(body) });
      const d = await res.json();
      if (d.error) throw new Error(`${d.error.code} ${String(d.error.message).slice(0, 300)}`);
      for (const p of d.candidates?.[0]?.content?.parts ?? []) {
        const blob = p.inlineData ?? p.inline_data;
        if (blob) {
          writeFileSync(out, Buffer.from(blob.data, 'base64'));
          return out;
        }
      }
      throw new Error(`no image in response: ${JSON.stringify(d).slice(0, 300)}`);
    } catch (e) {
      last = e;
      console.warn(`  retry ${attempt + 1}: ${e.message}`);
      await sleep(Math.min(60000, 5000 * 2 ** attempt));
    }
  }
  throw last;
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter((a) => !a.startsWith('--'));
mkdirSync(OUT, { recursive: true });
const unknown = ids.filter((id) => !KNIGHTS[id] && !SCENERY[id]);
if (unknown.length) {
  console.error(`unknown: ${unknown.join(', ')}\nhave: ${[...Object.keys(KNIGHTS), ...Object.keys(SCENERY)].join(', ')}`);
  process.exit(1);
}
if (args.includes('--list')) {
  for (const id of Object.keys(KNIGHTS)) console.log(`${existsSync(join(OUT, `${id}_front.png`)) && existsSync(join(OUT, `${id}_back.png`)) ? '✓' : ' '} ${id}`);
  for (const name of Object.keys(SCENERY)) console.log(`${existsSync(join(OUT, `${name}.png`)) ? '✓' : ' '} ${name}`);
  process.exit(0);
}

async function scenery(name) {
  const [aspect, concept, prompt] = SCENERY[name];
  const out = join(OUT, `${name}.png`);
  if (!force && existsSync(out)) return;
  console.log(`${name}: drawing`);
  const follows = concept?.endsWith('_concept')
    ? 'It is a piece of the design in the attached concept painting: match its shapes and decoration.'
    : 'The attached image shows another piece of the same set. Match its material, decoration and rendering style exactly, but draw the object described here, not the one attached.';
  if (!concept) await generate(prompt, [], out, aspect);
  else await generate(`${prompt}\n${follows}\n${lookOf(name)}\n${ALONE}`, [join(OUT, `${concept}.png`)], out, aspect);
  console.log(`${name}: done`);
}

// Concepts first (pieces are drawn from them), then the pieces a few at a time.
const wanted = (ids.length ? ids : Object.keys(SCENERY)).filter((id) => SCENERY[id]);
const needed = new Set(wanted.map((n) => SCENERY[n][1]).filter((c) => c && !existsSync(join(OUT, `${c}.png`))));
await Promise.all([...new Set([...wanted.filter((n) => !SCENERY[n][1]), ...needed])].map(scenery));
const pieces = wanted.filter((n) => SCENERY[n][1]);
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let name = pieces.shift(); name; name = pieces.shift()) await scenery(name);
}));

await Promise.all(
  (ids.length ? ids.filter((id) => KNIGHTS[id]) : Object.keys(KNIGHTS)).map(async (id) => {
    const sheet = join(CAST, `sheet_${id}.png`);
    const front = join(OUT, `${id}_front.png`);
    const back = join(OUT, `${id}_back.png`);
    if (force || !existsSync(front)) {
      console.log(`${id}: front`);
      await generate(`A single full-body FRONT view of the character in the attached model sheet, drawn as a reference for building a 3D model.\n${POSE}\n${KNIGHTS[id]}`, [sheet], front);
    }
    if (force || !existsSync(back)) {
      console.log(`${id}: back`);
      await generate(`A single full-body BACK view (seen from directly behind) of the character in the first attached image, in exactly the same pose, scale and framing as that image, drawn as the matching back reference for building a 3D model. The second attached image is the character's model sheet, for the design of the back.\n${POSE}\n${KNIGHTS[id]}`, [front, sheet], back);
    }
    console.log(`${id}: done`);
  }),
);
