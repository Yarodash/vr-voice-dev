// `npm run scene:tx -- begin <имя> [файлы…]` / `commit <имя>` / `status` — правка сцены одной транзакцией.
// С перечисленными файлами (пути от корня проекта, напр. web/src/scene/robodog-horde.js) держатся только они;
// без списка — вся сцена (тогда ждут и другие агенты — избегай).
// Пока хоть одна транзакция открыта (файл .vr/scene-hold/<имя>, свежее 3 минут), Vite НЕ отдаёт странице
// изменения web/src/scene/ — копит их (плагин scene-transactions в vite.config.js). commit закрывает свою;
// когда открытых не осталось, все накопленные файлы уходят странице разом — сцена подменяется один раз,
// без промежуточных сломанных состояний. Забытая транзакция истекает сама через 3 минуты.
// Правило для агентов: правка в 2+ местах / файлах, которые порознь ломают сцену, — между begin и commit;
// после commit — `npm run scene:check`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.vr', 'scene-hold');
const [cmd, rawName = 'agent', ...holdFiles] = process.argv.slice(2);
const name = rawName.replace(/[^\w.-]/g, '_');
const file = path.join(dir, name);
const list = () => {
  try {
    const now = Date.now();
    return fs.readdirSync(dir).map((f) => `${f} (${Math.round((now - fs.statSync(path.join(dir, f)).mtimeMs) / 1000)} с)`);
  } catch {
    return [];
  }
};

if (cmd === 'begin') {
  fs.mkdirSync(dir, { recursive: true });
  // список файлов → держатся только они (другие агенты не ждут); без списка — вся сцена
  const abs = holdFiles.map((p) => path.resolve(root, p));
  fs.writeFileSync(file, `${Date.now()}\n${abs.join('\n')}\n`);
  console.log(`транзакция «${name}» открыта: ${abs.length ? `держу ${abs.length} файл(ов)` : 'держу ВСЮ сцену (лучше перечисли свои файлы)'} до commit (истечёт сама через 3 мин; повторный begin продлевает)`);
} else if (cmd === 'commit') {
  fs.rmSync(file, { force: true });
  const left = list();
  console.log(left.length ? `«${name}» закрыта; ещё открыты: ${left.join(', ')} — сцена подменится, когда закроют все` : `«${name}» закрыта: изменения ушли странице одним разом — проверь npm run scene:check`);
} else if (cmd === 'status') {
  const open = list();
  console.log(open.length ? `открыты: ${open.join(', ')}` : 'открытых транзакций нет');
} else {
  console.error('npm run scene:tx -- begin <имя> | commit <имя> | status');
  process.exit(2);
}
