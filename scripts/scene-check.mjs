// `npm run scene:check` — did the page in the headset accept the latest scene code?
//   exit 0  OK
//   exit 1  the page rejected it (the error text is printed)
//   exit 2  no answer from the page (not connected, or still loading)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// What the page reports when the browser could not even load the module. Keep in sync with main.js.
const NOT_LOADED = 'сцена не загрузилась';

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function readStatus(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch {
    return null; // missing, or caught mid-write
  }
}

// The browser only says "Unexpected token"; Node's syntax check adds the file and the line.
function syntaxProblem(sceneDir) {
  for (const file of listFiles(sceneDir).filter((name) => /\.m?js$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) return result.stderr.split('\n').slice(0, 6).join('\n').trim();
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkScene({ statusPath, sceneDir, timeoutMs = 10000, pollMs = 200, settleMs = 500 }) {
  const failure = (status) => {
    let message = String(status.error);
    if (message.startsWith(NOT_LOADED)) {
      const detail = syntaxProblem(sceneDir);
      if (detail) message += `\n${detail}`;
    }
    return { code: 1, message };
  };

  const changedAt = Math.max(0, ...listFiles(sceneDir).map((file) => fs.statSync(file).mtimeMs));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = readStatus(statusPath);
    if (status && Date.parse(status.at) >= changedAt) {
      if (!status.ok) return failure(status);
      // A scene can pass setup() and then throw on its first frame; give that report time to arrive.
      await sleep(settleMs);
      const later = readStatus(statusPath);
      return later && !later.ok ? failure(later) : { code: 0, message: 'OK' };
    }
    if (Date.now() >= deadline) {
      return { code: 2, message: 'страница не подключена или ещё не применила изменения' };
    }
    await sleep(pollMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await checkScene({
    statusPath: path.join(root, 'logs', 'scene-status.json'),
    sceneDir: path.join(root, 'web', 'src', 'scene'),
  });
  console.log(result.message);
  process.exit(result.code);
}
