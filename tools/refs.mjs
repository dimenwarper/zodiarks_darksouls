// Generates clean 3D-modelling references from the cast sheets: one front and one back
// view per Knight, in an A-pose with empty hands, which is what image-to-3D and
// auto-rigging need. (The cast sheets pose each view differently and hold weapons.)
//
//   node tools/refs.mjs                 # everything that is missing
//   node tools/refs.mjs sigmund --force # redo one Knight
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

async function generate(prompt, refs, out) {
  const parts = [{ text: prompt }, ...refs.map((p) => ({ inline_data: { mime_type: 'image/png', data: readFileSync(p).toString('base64') } }))];
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4', imageSize: '2K' } },
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

await Promise.all(
  (ids.length ? ids : Object.keys(KNIGHTS)).map(async (id) => {
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
