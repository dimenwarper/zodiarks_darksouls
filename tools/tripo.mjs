// Turns the reference art into rigged, animated game models with the Tripo API.
//
//   node tools/tripo.mjs balance              # credits left
//   node tools/tripo.mjs plan                 # what is still to do, and a cost estimate (no spending)
//   node tools/tripo.mjs knight [id ...]      # model -> rig -> animations, for all four or the ones named
//   node tools/tripo.mjs weapon [id ...]      # sword and staffs as separate models
//   node tools/tripo.mjs prop [name ...]      # scenery: the boss's armour pieces and the arena's ruins
//   node tools/tripo.mjs publish [id ...]     # shrink what was downloaded into public/models (no spending)
//   node tools/tripo.mjs manifest             # rewrite public/models/manifest.json and props.json from the tables below
//
// Flags: --front-only   build the model from the front view alone (default: front + back)
//        --redo <step>  step is one of model | rig | anims  (earlier results are kept otherwise)
//        --rig <ver>    rig model version (default v1.0-20240301, which has the large preset library)
//        --tex <px>     texture size for published Knights (default 2048; weapons get half)
//
// Tripo's files arrive with 4096px textures, about 10 MB a model. The originals are kept in
// tools/.cache/tripo (not committed); `publish` writes game-sized copies to public/models.
// Every paid task id is recorded in tools/tripo-state.json, so a run that is interrupted
// (or runs out of credits) picks up where it stopped instead of paying twice.
//
// Tuning how a Knight moves or holds a weapon means editing KNIGHTS below and running
// `manifest`: no model is regenerated.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, sleep } from './keys.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFS = join(ROOT, 'tools', 'refs');
const RAW = join(ROOT, 'tools', '.cache', 'tripo');
const OUT = join(ROOT, 'public', 'models');
const STATE_FILE = join(ROOT, 'tools', 'tripo-state.json');
const API = 'https://openapi.tripo3d.ai/v3';
const MODEL = 'v3.1-20260211';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const RIG = flag('--rig') ?? 'v1.0-20240301';
const redo = flag('--redo');
const TEX = Number(flag('--tex') ?? 2048);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--redo', '--rig', '--tex'].includes(args[i - 1]));
const command = positional[0];
const ids = positional.slice(1);

/**
 * Game animation -> [Tripo preset, ...cut]. The presets are long, slow clips, so each entry
 * names the slice the game plays, as fractions of the clip: [start, end], or
 * [start, hit, end] for attacks, where `hit` is the frame the blow lands on.
 * Presets shared by several animations are generated once.
 */
const COMMON = {
  idle: ['idle'],
  move: ['run'],
  hurt: ['hit_to_body_01', 0, 1],
  down: ['fall', 0.15, 0.8],
  dead: ['fall', 0.15, 1],
  swapIn: ['jump_down', 0.6, 1],
  cheer: ['victory_celebration', 0.05, 0.85],
};
const CAST = { bolt: ['cast_a_spell', 0.3, 0.5, 0.8], channel: ['cast_a_spell', 0.12, 0.56, 0.9] };
/**
 * `weapon`: `length` in metres; `grip` is how far along it the hand closes, from the butt (0)
 * to the tip (1); `tip` is the way it points while the Knight stands idle, in their own
 * space (+x left, +y up, +z forward); `flip` swaps which end counts as the tip.
 * `turns`: whole turns the body makes during that attack, on top of the clip.
 */
const KNIGHTS = {
  sigmund: {
    anims: { ...COMMON, roll: ['dive', 0.27, 0.9], slashR: ['slash', 0.16, 0.31, 0.62], overhead: ['slash', 0.12, 0.31, 0.66] },
    weapon: { length: 2.4, grip: 0.16, tip: [-0.1, -0.35, 0.93], flip: true },
  },
  symbeline: {
    anims: { ...COMMON, twirl: ['flip', 0.2, 0.72], jabR: ['slash', 0.19, 0.31, 0.5], jabL: ['box_02', 0, 0.1, 0.45], spin: ['dance_03', 0.25, 0.33, 0.45], throw: ['pitch_baseball', 0.15, 0.47, 0.9] },
    turns: { spin: 1 },
  },
  deux: { anims: { ...COMMON, ...CAST }, weapon: { length: 1.0, grip: 0.45, tip: [0, 0.97, 0.24] } },
  ghalus: { anims: { ...COMMON, ...CAST, roll: ['dive', 0.27, 0.9] }, weapon: { length: 1.85, grip: 0.45, tip: [0, 0.97, 0.24] } },
};
/**
 * Scenery, one static model each from tools/refs/<name>.png (drawn by tools/refs.mjs).
 * `faces` caps the triangle count and `tex` is the published texture size.
 * `turn` is degrees about x, y, z (applied in that order) that stand the model the way the
 * game expects: +y up, +z toward whoever looks at its front. The game then stretches each
 * piece onto its place on the boss's skeleton or around the arena.
 */
// Tripo's models come out facing +X; a quarter turn brings the drawing's front to +Z.
const FACING = [0, -90, 0];
const PROPS = {
  boss_helm: { faces: 8000, tex: 1024 },
  boss_chest: { faces: 12000, tex: 1024 },
  boss_pelvis: { faces: 6000, tex: 1024 },
  boss_tasset: { faces: 3000, tex: 512 },
  boss_pauldron: { faces: 8000, tex: 1024 },
  boss_arm: { faces: 5000, tex: 1024 },
  boss_forearm: { faces: 5000, tex: 1024 },
  boss_fist: { faces: 6000, tex: 1024 },
  boss_thigh: { faces: 5000, tex: 1024 },
  boss_shin: { faces: 6000, tex: 1024 },
  boss_foot: { faces: 6000, tex: 1024 },
  boss_wing: { faces: 1500, tex: 512 },
  arena_pillar: { faces: 3000, tex: 1024 },
  arena_stump: { faces: 2500, tex: 1024 },
  arena_drum: { faces: 2000, tex: 512 },
  arena_brazier: { faces: 3000, tex: 512 },
  arena_statue: { faces: 5000, tex: 1024 },
  arena_plinth: { faces: 4000, tex: 1024 },
};
const presetsOf = (cfg) => [...new Set(Object.values(cfg.anims).map((a) => a[0]))];
// Tripo's rigged models come out facing +X; the game's characters face +Z.
const MODEL_YAW = -Math.PI / 2;
// Rough costs, in credits, for the plan. The exact charge is whatever each task reports.
const COST = { model: 40, rig: 25, anim: 10, weapon: 40 };

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
const presetName = (p) => (RIG.startsWith('v1') ? `preset:biped:${p}` : `preset:${p}`);

async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${apiKey('TRIPO_API_KEY')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    if (d.code === 0) return d.data;
    // Rate or concurrency limit: wait as told and try again.
    if (res.status === 429 && attempt < 6) {
      await sleep(1000 * Number(res.headers.get('retry-after') ?? 2 ** attempt));
      continue;
    }
    const err = new Error(`${method} ${path}: [${d.code}] ${d.message}${d.suggestion ? ` — ${d.suggestion}` : ''}`);
    err.code = d.code;
    throw err;
  }
}

async function upload(file) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(file)], { type: 'image/png' }), file.split('/').pop());
  const res = await fetch(`${API}/files`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey('TRIPO_API_KEY')}` }, body: fd });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`upload ${file}: [${d.code}] ${d.message}`);
  return d.data.file_token;
}

async function waitFor(taskId, label) {
  let delay = 2000;
  let last = -1;
  for (;;) {
    const t = await api('GET', `/tasks/${taskId}`);
    if (t.status === 'success') return t;
    if (['failed', 'cancelled', 'banned', 'expired'].includes(t.status)) {
      throw new Error(`${label}: task ${taskId} ${t.status}: ${t.error_message ?? t.error_msg ?? ''}`);
    }
    if (t.progress !== last) {
      last = t.progress;
      console.log(`  ${label}: ${t.status} ${t.progress ?? 0}%`);
    }
    await sleep(delay);
    delay = Math.min(10000, delay * 1.4);
  }
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${dest}: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Write a game-sized copy of a downloaded model: same mesh and rig, smaller textures. */
async function shrink(src, dest, size) {
  const [{ NodeIO }, { ALL_EXTENSIONS }, { textureCompress }, { default: sharp }] = await Promise.all([
    import('@gltf-transform/core'), import('@gltf-transform/extensions'), import('@gltf-transform/functions'), import('sharp'),
  ]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(src);
  doc.setLogger({ debug() {}, info() {}, warn() {}, error: console.error });
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 88 }));
  mkdirSync(dirname(dest), { recursive: true });
  await io.write(dest, doc);
}

/** Copy one Knight's downloads into public/models, shrinking the textured ones. */
async function publish(id) {
  const cfg = KNIGHTS[id];
  const mb = (f) => `${(statSync(f).size / 1e6).toFixed(1)} MB`;
  for (const [name, size] of [['model', TEX], ['weapon', TEX / 2]]) {
    const src = join(RAW, id, `${name}.glb`);
    if (!existsSync(src)) continue;
    const dest = join(OUT, id, `${name}.glb`);
    await shrink(src, dest, size);
    console.log(`  ${id}/${name}.glb  ${mb(src)} -> ${mb(dest)}`);
  }
  for (const preset of presetsOf(cfg)) {
    const src = join(RAW, id, `${preset}.glb`);
    if (!existsSync(src)) continue;
    mkdirSync(join(OUT, id), { recursive: true });
    copyFileSync(src, join(OUT, id, `${preset}.glb`));
  }
}

const modelUrl = (task) => task.output?.model_url ?? task.output?.pbr_model ?? task.output?.model;

/** Run one paid step unless its result is already on disk; remember the task so reruns resume. */
async function step(id, key, file, create, label) {
  const s = (state[id] ??= {});
  if (existsSync(file) && s[key]?.done) return s[key].task;
  if (!s[key]?.task) {
    const { task_id } = await create();
    s[key] = { task: task_id };
    save();
  }
  const task = await waitFor(s[key].task, label);
  const url = modelUrl(task);
  if (!url) throw new Error(`${label}: no model url in ${JSON.stringify(task.output)}`);
  await download(url, file);
  s[key].done = true;
  s[key].credits = task.credits_consumed;
  save();
  console.log(`✓ ${label}${task.credits_consumed ? ` (${task.credits_consumed} credits)` : ''}`);
  return s[key].task;
}

async function knight(id) {
  const cfg = KNIGHTS[id];
  if (!cfg) throw new Error(`unknown knight "${id}" (have: ${Object.keys(KNIGHTS).join(', ')})`);
  const s = (state[id] ??= {});
  if (redo === 'model') delete s.model, delete s.rig, delete s.anims;
  if (redo === 'rig') delete s.rig, delete s.anims;
  if (redo === 'anims') delete s.anims;
  const dir = join(RAW, id);

  const modelTask = await step(id, 'model', join(dir, 'base.glb'), async () => {
    const front = await upload(join(REFS, `${id}_front.png`));
    const common = { model: MODEL, texture: true, pbr: true, texture_quality: 'detailed', face_limit: 60000 };
    const backFile = join(REFS, `${id}_back.png`);
    if (has('--front-only') || !existsSync(backFile)) return api('POST', '/generation/image-to-model', { input: front, ...common });
    const back = await upload(backFile);
    return api('POST', '/generation/multiview-to-model', { inputs: [{ front }, { back }], ...common });
  }, `${id} model`);

  if (!s.rigCheck) {
    const { task_id } = await api('POST', '/animations/rig-check', { input: modelTask });
    const check = await waitFor(task_id, `${id} rig check`);
    s.rigCheck = check.output ?? {};
    save();
  }
  if (s.rigCheck.riggable === false) throw new Error(`${id}: Tripo reports the model is not riggable (${JSON.stringify(s.rigCheck)}); try --redo model, or --front-only`);

  const rigTask = await step(id, 'rig', join(dir, 'model.glb'), () =>
    api('POST', '/animations/rig', { input: modelTask, model: RIG, rig_type: 'biped', spec: 'tripo', out_format: 'glb' }), `${id} rig`);

  s.anims ??= {};
  const presets = presetsOf(cfg);
  // A few at a time: animation tasks share an account-wide concurrency pool.
  const queue = [...presets];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let preset = queue.shift(); preset; preset = queue.shift()) {
      const p = preset;
      const file = join(dir, `${p}.glb`);
      if (existsSync(file) && s.anims[p]?.done) continue;
      if (!s.anims[p]?.task) {
        const { task_id } = await api('POST', '/animations/retarget', { input: rigTask, animation: presetName(p), out_format: 'glb', animate_in_place: true, export_with_geometry: false });
        s.anims[p] = { task: task_id };
        save();
      }
      const task = await waitFor(s.anims[p].task, `${id} ${p}`);
      await download(modelUrl(task), file);
      s.anims[p].done = true;
      s.anims[p].credits = task.credits_consumed;
      save();
      console.log(`✓ ${id} ${p}`);
    }
  }));
}

async function weapon(id) {
  const ref = join(REFS, `weapon_${id}.png`);
  if (!existsSync(ref)) throw new Error(`no weapon reference for "${id}" (${ref})`);
  if (redo === 'model') delete (state[id] ??= {}).weapon;
  await step(id, 'weapon', join(RAW, id, 'weapon.glb'), async () =>
    api('POST', '/generation/image-to-model', { input: await upload(ref), model: MODEL, texture: true, pbr: true, texture_quality: 'detailed', face_limit: 8000 }), `${id} weapon`);
}

async function prop(name) {
  const cfg = PROPS[name];
  if (!cfg) throw new Error(`unknown prop "${name}" (have: ${Object.keys(PROPS).join(', ')})`);
  const ref = join(REFS, `${name}.png`);
  if (!existsSync(ref)) throw new Error(`no reference drawing for "${name}": run node tools/refs.mjs ${name}`);
  if (redo === 'model') delete (state.props ??= {})[name];
  await step('props', name, join(RAW, 'props', `${name}.glb`), async () =>
    api('POST', '/generation/image-to-model', { input: await upload(ref), model: MODEL, texture: true, pbr: true, texture_quality: 'detailed', face_limit: cfg.faces }), name);
}

async function publishProp(name) {
  const src = join(RAW, 'props', `${name}.glb`);
  if (!existsSync(src)) return;
  const dest = join(OUT, 'props', `${name}.glb`);
  await shrink(src, dest, PROPS[name].tex);
  console.log(`  props/${name}.glb  ${(statSync(src).size / 1e6).toFixed(1)} MB -> ${(statSync(dest).size / 1e6).toFixed(1)} MB`);
}

function writePropManifest() {
  const manifest = {};
  for (const [name, cfg] of Object.entries(PROPS)) {
    if (!existsSync(join(OUT, 'props', `${name}.glb`))) continue;
    manifest[name] = { file: `props/${name}.glb`, turn: cfg.turn ?? FACING };
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'props.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`props: ${Object.keys(manifest).length} of ${Object.keys(PROPS).length}`);
}

function writeManifest() {
  writePropManifest();
  const manifest = {};
  for (const [id, cfg] of Object.entries(KNIGHTS)) {
    if (!existsSync(join(OUT, id, 'model.glb'))) continue;
    const anims = {};
    for (const [name, [preset, ...cut]] of Object.entries(cfg.anims)) {
      if (!existsSync(join(OUT, id, `${preset}.glb`))) continue;
      anims[name] = { file: `${id}/${preset}.glb` };
      if (cut.length) anims[name].cut = cut;
      if (cfg.turns?.[name]) anims[name].turns = cfg.turns[name];
    }
    if (!anims.idle) continue;
    manifest[id] = { model: `${id}/model.glb`, yaw: MODEL_YAW, anims };
    if (cfg.weapon && existsSync(join(OUT, id, 'weapon.glb'))) manifest[id].weapon = { model: `${id}/weapon.glb`, ...cfg.weapon };
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest: ${Object.keys(manifest).join(', ') || 'no finished knights yet'}`);
}

function plan() {
  let total = 0;
  const line = (what, credits, done) => {
    if (!done) total += credits;
    console.log(`  ${done ? '✓' : ' '} ${what.padEnd(34)} ${done ? '' : `~${credits}`}`);
  };
  for (const [id, cfg] of Object.entries(KNIGHTS)) {
    console.log(id);
    const s = state[id] ?? {};
    line('model (front + back views)', COST.model, s.model?.done);
    line('rig', COST.rig, s.rig?.done);
    const presets = presetsOf(cfg);
    const done = presets.filter((p) => s.anims?.[p]?.done).length;
    line(`animations (${presets.length}: ${presets.join(', ')})`.slice(0, 34), COST.anim * (presets.length - done), done === presets.length);
    if (cfg.weapon) line('weapon', COST.weapon, s.weapon?.done);
  }
  console.log('scenery');
  for (const name of Object.keys(PROPS)) line(name, COST.weapon, state.props?.[name]?.done);
  console.log(`\nStill to spend: about ${total} credits (~$${(total / 100).toFixed(2)}).`);
}

try {
  switch (command) {
    case 'balance': {
      const b = await api('GET', '/account/balance');
      console.log(`balance: ${b.balance} credits (${b.frozen} frozen)`);
      break;
    }
    case 'plan':
      plan();
      break;
    case 'knight':
      for (const id of ids.length ? ids : Object.keys(KNIGHTS)) {
        await knight(id);
        await publish(id);
      }
      writeManifest();
      break;
    case 'weapon':
      for (const id of ids.length ? ids : Object.keys(KNIGHTS).filter((k) => KNIGHTS[k].weapon)) {
        await weapon(id);
        await publish(id);
      }
      writeManifest();
      break;
    case 'prop': {
      // A few at a time: generation tasks share an account-wide concurrency pool.
      const queue = ids.length ? [...ids] : Object.keys(PROPS);
      const errors = [];
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let name = queue.shift(); name; name = queue.shift()) {
          try {
            await prop(name);
            await publishProp(name);
          } catch (e) {
            if (e.code === 2010) throw e;
            errors.push(e.message);
            console.error(`✗ ${e.message}`);
          }
        }
      }));
      writeManifest();
      if (errors.length) throw new Error(`${errors.length} prop(s) failed`);
      break;
    }
    case 'publish':
      for (const id of ids.length ? ids : [...Object.keys(KNIGHTS), ...Object.keys(PROPS)]) await (PROPS[id] ? publishProp(id) : publish(id));
      writeManifest();
      break;
    case 'manifest':
      writeManifest();
      break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (e.code === 2010) console.error('  The Tripo API wallet is out of credits: top it up at https://platform.tripo3d.ai and run the same command again; finished steps are kept.');
  process.exit(1);
}
