// Turns the reference art into rigged, animated game models with the Tripo API.
//
//   node tools/tripo.mjs balance              # credits left
//   node tools/tripo.mjs plan                 # what is still to do, and a cost estimate (no spending)
//   node tools/tripo.mjs knight [id ...]      # model -> rig -> animations, for all four or the ones named
//   node tools/tripo.mjs weapon [id ...]      # sword and staffs as separate models
//   node tools/tripo.mjs manifest             # rebuild public/models/manifest.json from what is on disk
//
// Flags: --front-only   build the model from the front view alone (default: front + back)
//        --redo <step>  step is one of model | rig | anims  (earlier results are kept otherwise)
//        --rig <ver>    rig model version (default v1.0-20240301, which has the large preset library)
//
// Every paid task id is recorded in tools/tripo-state.json, so a run that is interrupted
// (or runs out of credits) picks up where it stopped instead of paying twice.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, sleep } from './keys.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFS = join(ROOT, 'tools', 'refs');
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
const positional = args.filter((a, i) => !a.startsWith('--') && !['--redo', '--rig'].includes(args[i - 1]));
const command = positional[0];
const ids = positional.slice(1);

/** Game animation -> Tripo preset. Presets shared by several animations are generated once. */
const COMMON = { idle: 'idle', move: 'run', hurt: 'hit_to_body_01', down: 'fall', dead: 'defeat_02', swapIn: 'jump_down', cheer: 'victory_celebration' };
const KNIGHTS = {
  sigmund: { anims: { ...COMMON, roll: 'dive', slashR: 'slash', overhead: 'chop' }, weapon: { length: 2.4 } },
  symbeline: { anims: { ...COMMON, twirl: 'flip', jabR: 'slash', jabL: 'box_02', spin: 'dance_03', throw: 'pitch_baseball' } },
  deux: { anims: { ...COMMON, bolt: 'cast_a_spell', channel: 'cast_a_spell' }, weapon: { length: 1.0 } },
  ghalus: { anims: { ...COMMON, roll: 'dive', bolt: 'cast_a_spell', channel: 'cast_a_spell' }, weapon: { length: 1.85 } },
};
/** Where in each attack clip the blow lands (fraction of its length); tune by eye once the clips exist. */
const IMPACT = { slashR: 0.42, overhead: 0.45, jabR: 0.42, jabL: 0.35, spin: 0.4, throw: 0.5, bolt: 0.5, channel: 0.6 };
// Rough costs, in credits, for the plan. The exact charge is whatever each task reports.
const COST = { model: 40, rig: 25, anim: 10, weapon: 30 };

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
  const dir = join(OUT, id);

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
  const presets = [...new Set(Object.values(cfg.anims))];
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
  await step(id, 'weapon', join(OUT, id, 'weapon.glb'), async () =>
    api('POST', '/generation/image-to-model', { input: await upload(ref), model: MODEL, texture: true, pbr: true, texture_quality: 'detailed', face_limit: 8000 }), `${id} weapon`);
}

function writeManifest() {
  const manifestFile = join(OUT, 'manifest.json');
  // Keep hand-tuned weapon placement and impact timings from an existing manifest.
  const old = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
  const manifest = {};
  for (const [id, cfg] of Object.entries(KNIGHTS)) {
    if (!existsSync(join(OUT, id, 'model.glb'))) continue;
    const anims = {};
    for (const [name, preset] of Object.entries(cfg.anims)) if (existsSync(join(OUT, id, `${preset}.glb`))) anims[name] = `${id}/${preset}.glb`;
    if (!anims.idle) continue;
    manifest[id] = { model: `${id}/model.glb`, anims, impact: { ...IMPACT, ...old[id]?.impact }, yaw: old[id]?.yaw ?? 0 };
    if (cfg.weapon && existsSync(join(OUT, id, 'weapon.glb'))) {
      manifest[id].weapon = { model: `${id}/weapon.glb`, length: cfg.weapon.length, position: [0, 0, 0], rotation: [0, 0, 0], ...old[id]?.weapon };
    }
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
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
    const presets = [...new Set(Object.values(cfg.anims))];
    const done = presets.filter((p) => s.anims?.[p]?.done).length;
    line(`animations (${presets.length}: ${presets.join(', ')})`.slice(0, 34), COST.anim * (presets.length - done), done === presets.length);
    if (cfg.weapon) line('weapon', COST.weapon, s.weapon?.done);
  }
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
      for (const id of ids.length ? ids : Object.keys(KNIGHTS)) await knight(id);
      writeManifest();
      break;
    case 'weapon':
      for (const id of ids.length ? ids : Object.keys(KNIGHTS).filter((k) => KNIGHTS[k].weapon)) await weapon(id);
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
