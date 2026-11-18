// `npm run new:projectile -- <имя> [<id пушки>] [--speed 40] [--gravity 9.81] [--fuse 3] [--no-blast]`
// П0 новой пушки за секунды, до любого агента: копирует шаблон снаряда тремя файлами
//   web/src/scene/projectiles/<имя>.js        (логика: П1 выстрел, П2 эффект)
//   web/src/scene/projectiles/<имя>.sounds.js (П3 звуки)
//   web/src/scene/projectiles/<имя>.fx.js     (П4 вид)
// регистрирует его в projectiles/index.js и (если дан id пушки) ставит в запись generated-guns.js
// projectile, speed, gravity, projectileOpts.fuseS — голый выстрел шаблона сразу в игре.
// Потом три агента правят каждый свой файл параллельно (recipes.md «Новый снаряд»).
// --no-blast — в конце без артиллерийского разрыва (эффект пушки — не взрыв).
// Печатает, что сделал, и итог `npm run scene:check`. Код выхода 0 — сцена приняла.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'web', 'src', 'scene', 'projectiles');
const gunsFile = path.join(root, 'web', 'src', 'scene', 'generated-guns.js');
const args = process.argv.slice(2);
const opt = { speed: 40, gravity: 9.81, fuse: 3, blast: true };
const pos = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--no-blast') opt.blast = false;
  else if (a.startsWith('--')) opt[a.slice(2)] = Number(args[++i]);
  else pos.push(a);
}
const [name, gunId] = pos;
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) die('нужно имя снаряда: латиница, например  npm run new:projectile -- flare flare_shotgun');
if (['mana', 'rocket', 'plasma', 'rail', 'blackhole', 'template'].includes(name)) die(`имя «${name}» занято встроенным`);
const Name = name.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const t0 = Date.now();

const files = [
  ['_template.sounds.js', `${name}.sounds.js`, (s) => s],
  ['_template.fx.js', `${name}.fx.js`, (s) => s],
  ['_template.js', `${name}.js`, (s) => {
    let o = s
      .replace("const NAME = 'template';", `const NAME = '${name}';`)
      .replace('export function createTemplate(ctx)', `export function create${Name}(ctx)`)
      .replace("'./_template.sounds.js'", `'./${name}.sounds.js'`)
      .replace("'./_template.fx.js'", `'./${name}.fx.js'`)
      .replace(/^\/\/ ШАБЛОН[\s\S]*?\n(?=\/\/\n)/m, `// Снаряд «${name}» (из _template.js, npm run new:projectile). Логика: П1 выстрел, П2 эффект.\n`);
    if (!opt.blast) o = o.replace('const BLAST = true;', 'const BLAST = false;');
    return o;
  }],
];
// звуки и вид — раньше логики: импорт должен находить файлы в момент, когда Vite увидит <имя>.js
for (const [from, to, edit] of files) {
  const dst = path.join(dir, to);
  if (fs.existsSync(dst)) {
    console.log(`есть: ${to} — не трогаю`);
    continue;
  }
  fs.writeFileSync(dst, edit(fs.readFileSync(path.join(dir, from), 'utf8')));
  console.log(`создан: projectiles/${to}`);
}

const indexFile = path.join(dir, 'index.js');
let index = fs.readFileSync(indexFile, 'utf8');
if (!index.includes(`'./${name}.js'`)) {
  const eol = index.includes('\r\n') ? '\r\n' : '\n';
  const imp = `import { create${Name} } from './${name}.js';${eol}`;
  const lastImport = [...index.matchAll(/^import [^\r\n]*\r?\n/gm)].at(-1);
  index = lastImport ? index.slice(0, lastImport.index + lastImport[0].length) + imp + index.slice(lastImport.index + lastImport[0].length) : imp + index;
  const before = index;
  index = index.replace(/export const PROJECTILES = \{\r?\n/, (m) => `${m}  ${name}: create${Name},${eol}`);
  if (index === before) die('в projectiles/index.js не нашёл «export const PROJECTILES = {»');
  fs.writeFileSync(indexFile, index);
  console.log(`зарегистрирован в projectiles/index.js: ${name}`);
}

if (gunId) {
  const src = fs.readFileSync(gunsFile, 'utf8');
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.includes(`id: '${gunId}'`));
  if (i < 0) die(`в generated-guns.js нет записи id: '${gunId}'`);
  const cr = lines[i].endsWith('\r') ? '\r' : '';
  let l = lines[i].replace(/\r$/, '');
  if (/projectile: '[^']*'/.test(l)) l = l.replace(/projectile: '[^']*'/, `projectile: '${name}'`);
  else {
    const add = `, projectile: '${name}', speed: ${opt.speed}, gravity: ${opt.gravity}${/projectileOpts/.test(l) ? '' : `, projectileOpts: { fuseS: ${opt.fuse} }`}`;
    l = l.replace(/\s*\}(,?)\s*$/, (_, comma) => `${add} }${comma}`);
  }
  lines[i] = l + cr;
  fs.writeFileSync(gunsFile, lines.join('\n'));
  console.log(`запись ${gunId}: ${l.trim()}`);
}

let check = 'не проверено';
let code = 0;
try {
  check = execSync('node scripts/scene-check.mjs', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch (e) {
  code = e.status ?? 1;
  check = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
}
console.log(`scene:check → ${check}`);
console.log(`П0 за ${((Date.now() - t0) / 1000).toFixed(1)} с: голый выстрел шаблона в игре${gunId ? ` у ${gunId}` : ''}. Дальше: логика ${name}.js, звуки ${name}.sounds.js, вид ${name}.fx.js — параллельно.`);
process.exit(code);
