// `node scripts/vr-say.mjs "<text>"` — shows a message in a pop-up in the headset.
// The user closes it with the cross; if several are waiting, closing shows the next one.
// Exit code: 0 queued (even if the headset is not connected yet: it is shown when it connects), 2 no bridge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = process.argv.slice(2).join(' ') || fs.readFileSync(0, 'utf8');
if (!text.trim()) {
  console.error('нет текста: node scripts/vr-say.mjs "<сообщение>"');
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const pairCode = fs.readFileSync(path.join(root, '.vr', 'pair-code'), 'utf8').trim();

try {
  const response = await fetch(`http://127.0.0.1:${config.bridge_port}/say`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pair-Code': pairCode },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { pages } = await response.json();
  console.log(pages > 0 ? 'показано в шлеме' : 'страница не подключена: покажется, когда подключится');
} catch (err) {
  console.error(`мост не отвечает (${err.message}): запущен ли npm start?`);
  process.exit(2);
}
