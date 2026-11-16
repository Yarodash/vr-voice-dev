// `npm run vr:eval -- "<javascript>"` — runs JavaScript on the page in the headset (on every
// connected page) and prints what it returned, like a line typed into the browser console.
//
//   npm run vr:eval -- "root.children.length"
//   npm run vr:eval -- "sceneInstance"                         // whatever the scene's setup() returned
//   npm run vr:eval -- --file scratch.js                       // longer code; use `return` for the result
//   npm run vr:eval -- --timeout 30 "await new Promise(r => setTimeout(r, 20000))"
//
//   npm run vr:eval -- "await screenshot({ eyes: 'left', width: 1600 })"   // prints the saved file's path
//
// Variables in scope: THREE, scene, root, camera, renderer, session, ctx, sceneHost,
// sceneInstance, panel, mic, controls, screenshot. `await` is allowed.
// Exit code: 0 a page answered with a value, 1 the code failed, 2 no page / no bridge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let timeout;
let file;
const rest = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--timeout') timeout = Number(args[++i]);
  else rest.push(args[i]);
}
const code = file ? fs.readFileSync(file, 'utf8') : rest.length ? rest.join(' ') : fs.readFileSync(0, 'utf8');
if (!code.trim()) {
  console.error('нет кода: npm run vr:eval -- "<javascript>"  или  --file <путь>');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
let pairCode;
try {
  pairCode = fs.readFileSync(path.join(root, '.vr', 'pair-code'), 'utf8').trim();
} catch {
  console.error('мост ещё ни разу не запускался (нет .vr/pair-code): npm start');
  process.exit(2);
}

let response;
try {
  response = await fetch(`http://127.0.0.1:${config.bridge_port}/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pair-Code': pairCode },
    body: JSON.stringify({ code, ...(timeout ? { timeout } : {}) }),
  });
} catch {
  console.error('мост не отвечает: запущен ли npm start?');
  process.exit(2);
}
const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
if (!response.ok) {
  console.error(body.error ?? `HTTP ${response.status}`);
  process.exit(2);
}

let anyOk = false;
for (const result of body.results) {
  anyOk ||= result.ok;
  const text = result.ok ? result.value : `ОШИБКА: ${result.error}`;
  console.log(body.results.length > 1 ? `[${result.page}] ${text}` : text);
  if (result.file) console.log(`файл: ${result.file}`);
}
process.exit(anyOk ? 0 : 1);
