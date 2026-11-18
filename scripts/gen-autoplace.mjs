// `node scripts/gen-autoplace.mjs` (часть `npm start`) — сгенерированное само встаёт в игру.
//
// Картинка: web/public/models/generated/<id>/card.png появился или изменился (агент вызвал
//   mcp__tripo3d__remove_image_background с output_path = эта папка\card.png) → в записи <id> файла
//   web/src/scene/generated-guns.js ставится card: true и v + 1 → сцена подменяется на лету.
// 3D: Tripo закончил генерацию (D:\3d_models\output\mcp\<run>\result.json, state done), а её картинка —
//   web/public/models/generated/<id>/card.png → mesh.glb копируется в папку <id>, в записи glb: true, v + 1.
// Записи нет — создаётся простая (name = id, голограмма-форма rifle). Каждое событие — строка в
// logs/gen-autoplace.log и сообщение в шлем («картинка <имя> в игре» / «3D <имя> в игре»).
// Старое (что было до запуска) не трогает. Повторный запуск безопасен.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN_DIR = path.join(root, 'web', 'public', 'models', 'generated');
const GUNS = path.join(root, 'web', 'src', 'scene', 'generated-guns.js');
const TRIPO_DIR = process.env.TRIPO_OUT ?? 'D:\\3d_models\\output\\mcp';
const LOG = path.join(root, 'logs', 'gen-autoplace.log');
const STATE = path.join(root, '.vr', 'gen-autoplace.json');

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => {
  const line = `${stamp()} ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    // нет папки logs — только в консоль
  }
};
const say = (text) => execFile(process.execPath, [path.join(root, 'scripts', 'vr-say.mjs'), text], () => {});

// --- состояние: что уже обработано (переживает перезапуск) ---
let state = { cards: {}, runs: {} };
try {
  state = { cards: {}, runs: {}, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) };
} catch {
  // первый запуск
}
const save = () => {
  try {
    fs.writeFileSync(STATE, JSON.stringify(state));
  } catch (e) {
    log(`не сохранил состояние: ${e.message}`);
  }
};

// --- правка записи в generated-guns.js ---
// Запись — объект в массиве GENERATED_GUNS, может занимать несколько строк: ищем `id: '<id>'`, от
// ближайшей «{» слева до парной «}» — это её текст.
function entryRange(src, id) {
  const at = src.indexOf(`id: '${id}'`);
  if (at < 0) return null;
  const start = src.lastIndexOf('{', at);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = src.indexOf(c, i + 1); // строки без экранированных кавычек — как в реестре
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return [start, i + 1];
    }
  }
  return null;
}
const setFlag = (text, key, value) => (new RegExp(`\\b${key}: (true|false)`).test(text)
  ? text.replace(new RegExp(`\\b${key}: (true|false)`), `${key}: ${value}`)
  : text.replace(/(id: '[^']*',)/, `$1 ${key}: ${value},`));
function updateEntry(id, flag) {
  const src = fs.readFileSync(GUNS, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const range = entryRange(src, id);
  let out;
  let v;
  let name = id;
  if (!range) {
    v = 1;
    const entry = `  { id: '${id}', name: '${id}', length: 0.9, auto: false, shape: 'rifle', card: ${flag === 'card' || flag === 'glb'}, glb: ${flag === 'glb'}, v: 1 }, // добавлено gen-autoplace`;
    out = src.replace(/(\r?\n)\];(\r?\n)/, `$1${entry}${eol}];$2`);
    if (out === src) throw new Error('не нашёл конец GENERATED_GUNS');
  } else {
    let text = src.slice(range[0], range[1]);
    name = text.match(/name: '([^']*)'/)?.[1] ?? id;
    text = setFlag(text, flag, 'true');
    if (flag === 'glb') text = setFlag(text, 'card', 'true'); // модели нужна и картинка (по ней ставится)
    const m = text.match(/\bv: (\d+)/);
    v = m ? Number(m[1]) + 1 : 2;
    text = m ? text.replace(/\bv: \d+/, `v: ${v}`) : text.replace(/(id: '[^']*',)/, `$1 v: ${v},`);
    out = src.slice(0, range[0]) + text + src.slice(range[1]);
  }
  fs.writeFileSync(GUNS, out);
  return { name, v };
}

// --- ожидание, пока файл допишется ---
const stableSize = async (file, ms = 300) => {
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {
      return false;
    }
    if (size > 0 && size === last) return true;
    last = size;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
};

// --- картинки ---
const cardKey = (file) => {
  try {
    const s = fs.statSync(file);
    return `${s.size}|${s.mtimeMs}`;
  } catch {
    return null;
  }
};
const busy = new Set();
async function onCard(id) {
  const file = path.join(GEN_DIR, id, 'card.png');
  if (busy.has(file)) return;
  busy.add(file);
  try {
    await new Promise((r) => setTimeout(r, 400)); // события fs.watch идут пачкой
    if (!(await stableSize(file))) return;
    const key = cardKey(file);
    if (!key || state.cards[id] === key) return;
    state.cards[id] = key;
    save();
    const { name, v } = updateEntry(id, 'card');
    log(`картинка ${id} → card: true, v: ${v}`);
    say(`Картинка «${name}» в игре.`);
  } catch (e) {
    log(`картинка ${id}: ошибка ${e.message}`);
  } finally {
    busy.delete(file);
  }
}

// --- 3D ---
const genIdOf = (image) => {
  const rel = path.relative(GEN_DIR, path.resolve(image ?? ''));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.length >= 2 ? parts[0] : null;
};
async function onRun(runDir) {
  const run = path.basename(runDir);
  if (state.runs[run] || busy.has(run)) return;
  busy.add(run);
  try {
    let r;
    try {
      r = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
    } catch {
      return; // ещё пишется / нет
    }
    if (r.state !== 'done') {
      if (r.state === 'failed' || r.state === 'error') state.runs[run] = 'failed';
      return;
    }
    const id = genIdOf(r.image);
    state.runs[run] = id ?? 'not-a-gun';
    save();
    if (!id) return;
    const mesh = r.result?.mesh ?? path.join(runDir, 'mesh.glb');
    if (r.result?.status !== 'ok' || !fs.existsSync(mesh)) {
      log(`3D ${id}: генерация без модели (${r.result?.status ?? '?'})`);
      return;
    }
    fs.copyFileSync(mesh, path.join(GEN_DIR, id, 'mesh.glb'));
    const { name, v } = updateEntry(id, 'glb');
    log(`3D ${id} (${r.quality}, ${r.result?.faces ?? '?'} треугольников, ${r.result?.total_s ?? '?'} с) → glb: true, v: ${v}`);
    say(`3D «${name}» в игре.`);
  } catch (e) {
    log(`3D ${run}: ошибка ${e.message}`);
  } finally {
    busy.delete(run);
  }
}

// --- старт: всё, что уже есть, считаем обработанным ---
fs.mkdirSync(GEN_DIR, { recursive: true });
for (const id of fs.readdirSync(GEN_DIR)) {
  const key = cardKey(path.join(GEN_DIR, id, 'card.png'));
  if (key && !state.cards[id]) state.cards[id] = key;
}
const tripoOk = fs.existsSync(TRIPO_DIR);
if (tripoOk) for (const run of fs.readdirSync(TRIPO_DIR)) state.runs[run] ??= 'old';
save();

fs.watch(GEN_DIR, { recursive: true }, (_, file) => {
  if (!file) return;
  const parts = String(file).split(/[\\/]/);
  if (parts.length === 2 && parts[1] === 'card.png') onCard(parts[0]);
});
if (tripoOk) {
  fs.watch(TRIPO_DIR, { recursive: true }, (_, file) => {
    if (!file) return;
    const parts = String(file).split(/[\\/]/);
    if (parts.length === 2 && parts[1] === 'result.json') onRun(path.join(TRIPO_DIR, parts[0]));
  });
}
log(`слежу: ${path.relative(root, GEN_DIR)}\\<id>\\card.png${tripoOk ? ` и ${TRIPO_DIR}\\<run>\\result.json` : ' (папки Tripo нет — 3D не подхватываю)'}`);
