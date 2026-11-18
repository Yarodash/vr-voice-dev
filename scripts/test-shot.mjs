// `npm run test:shot -- <gunId> [--enemy 3] [--ally 3] [--wait 8] [--shot] [--pitch 20] [--yaw 0] [--keep]`
// — приёмка выстрела пушки одной командой на десктоп-странице (страница в шлеме пропускается).
//
//   gunId   — ключ GUNS ('pistol', 'awp', 'gen_flare_shotgun') или id записи generated-guns.js ('flare_shotgun')
//   --enemy N — после падения поставить вражеского пса в N м от точки падения (ждём: ранен/убит и засчитан игроку)
//   --ally N  — союзного пса в N м (ждём: не ранен)
//   --wait S  — сколько всего ждать падения и эффекта, с (по умолчанию 8)
//   --shot    — снимок экрана в момент эффекта (путь — в поле screenshot)
//   --pitch / --yaw — угол выстрела от камеры, градусы (20 / 0); --keep — не убирать псов после проверки
//
// Печатает ОДИН JSON: fired, landed, strikes, landPoint, enemy/ally, killConfirm/money (прирост),
// pageErrors (ERROR из logs/page-console.log с начала проверки), screenshot, checks, ok.
// Код выхода: 0 — все заявленные проверки прошли и ошибок страницы нет; 1 — нет; 2 — нет страницы/моста.
// Логика на странице: web/src/scene/test-kit.js (__sceneState.testKit.shotTest).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { enemy: 0, ally: 0, wait: 8, shot: false, pitch: 20, yaw: 0, keep: false };
let gunId = null;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--shot') opt.shot = true;
  else if (a === '--keep') opt.keep = true;
  else if (a.startsWith('--')) opt[a.slice(2)] = Number(args[++i]);
  else gunId ??= a;
}
const fail = (code, error) => {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(code);
};
if (!gunId) fail(2, 'нужен id пушки: npm run test:shot -- flare_shotgun --enemy 3 --ally 3 --shot');

const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
let pairCode;
try {
  pairCode = fs.readFileSync(path.join(root, '.vr', 'pair-code'), 'utf8').trim();
} catch {
  fail(2, 'мост ещё ни разу не запускался (нет .vr/pair-code): npm start');
}

const GUARD = "if (/Quest|OculusBrowser/.test(navigator.userAgent)) return 'skip';";
const evaluate = async (code, timeout) => {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.bridge_port}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pair-Code': pairCode },
      body: JSON.stringify({ code, timeout }),
    });
  } catch {
    fail(2, 'мост не отвечает: запущен ли npm start?');
  }
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) fail(2, body.error ?? `HTTP ${response.status}`);
  // ответ десктоп-страницы (страница шлема отвечает 'skip')
  return body.results.find((r) => !(r.ok && r.value === '"skip"')) ?? null;
};

const logPath = path.join(root, 'logs', 'page-console.log');
const logSize = () => {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return 0;
  }
};
const start = logSize();

const params = JSON.stringify({ enemy: opt.enemy, ally: opt.ally, wait: opt.wait, pitchDeg: opt.pitch, yawDeg: opt.yaw, keepDogs: opt.keep });
const code = `${GUARD}
const kit = __sceneState.testKit;
if (!kit) throw new Error('нет __sceneState.testKit (сцена без main.js test-kit или старая версия: npm run scene:check)');
return JSON.stringify(await kit.shotTest(${JSON.stringify(gunId)}, { ...${params}, screenshot: ${opt.shot ? 'screenshot' : 'null'} }));`;
const res = await evaluate(code, Math.ceil(opt.wait + 12));
if (!res) fail(2, 'десктоп-страница не подключена (открыта только страница шлема)');
if (!res.ok) fail(1, res.error);
let out;
try {
  out = JSON.parse(JSON.parse(res.value));
} catch {
  fail(1, `непонятный ответ страницы: ${String(res.value).slice(0, 300)}`);
}

if (out.shotTaken) {
  const r = await evaluate(`${GUARD} return __sceneState.testKit?.takeShot() ?? 'нет testKit';`, 10);
  out.screenshot = r?.file ?? null;
  delete out.shotTaken;
}

// ошибки страницы с начала проверки (лог мост укорачивает — тогда читаем целиком)
let fresh = '';
try {
  const buf = fs.readFileSync(logPath);
  fresh = buf.subarray(buf.length >= start ? start : 0).toString('utf8');
} catch {
  // лога нет — ошибок не видно
}
const lines = fresh.split(/\r?\n/).filter((l) => / \[desktop\] (ERROR|WARN) /.test(l));
out.pageErrors = lines.filter((l) => l.includes(' ERROR ')).map((l) => l.slice(0, 300));
const warns = lines.filter((l) => l.includes(' WARN ')).map((l) => l.slice(0, 300));
if (warns.length) out.pageWarnings = warns;
if (out.checks) out.checks.noPageErrors = out.pageErrors.length === 0;
out.ok = Boolean(out.ok) && out.pageErrors.length === 0;

console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
