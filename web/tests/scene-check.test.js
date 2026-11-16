import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkScene } from '../../scripts/scene-check.mjs';

let dir, sceneDir, statusPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-check-'));
  sceneDir = path.join(dir, 'scene');
  statusPath = path.join(dir, 'logs', 'scene-status.json');
  fs.mkdirSync(path.join(sceneDir, 'parts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }'); // as in the real project
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function touch(file, date) {
  fs.writeFileSync(file, '// scene');
  fs.utimesSync(file, date, date);
}
const status = (ok, error, at) => fs.writeFileSync(statusPath, JSON.stringify({ ok, error, at: at.toISOString() }));
const run = () => checkScene({ statusPath, sceneDir, timeoutMs: 300, pollMs: 20, settleMs: 120 });

describe('checkScene', () => {
  it('returns 0 when the page applied the newest scene file', async () => {
    touch(path.join(sceneDir, 'main.js'), new Date('2026-01-01T10:00:00Z'));
    status(true, null, new Date('2026-01-01T10:00:01Z'));

    expect(await run()).toEqual({ code: 0, message: 'OK' });
  });

  it('returns 1 with the error text when the page rejected the scene', async () => {
    touch(path.join(sceneDir, 'main.js'), new Date('2026-01-01T10:00:00Z'));
    status(false, 'gun is not defined', new Date('2026-01-01T10:00:01Z'));

    expect(await run()).toEqual({ code: 1, message: 'gun is not defined' });
  });

  it('returns 2 when the status is older than a nested scene file', async () => {
    touch(path.join(sceneDir, 'main.js'), new Date('2026-01-01T10:00:00Z'));
    touch(path.join(sceneDir, 'parts', 'gun.js'), new Date('2026-01-01T10:00:05Z'));
    status(true, null, new Date('2026-01-01T10:00:01Z'));

    const result = await run();

    expect(result.code).toBe(2);
    expect(result.message).toContain('страница не подключена');
  });

  it('returns 2 when there is no status file at all', async () => {
    touch(path.join(sceneDir, 'main.js'), new Date('2026-01-01T10:00:00Z'));

    expect((await run()).code).toBe(2);
  });

  it('reports a failure that follows an early OK (setup fine, first frame throws)', async () => {
    touch(path.join(sceneDir, 'main.js'), new Date('2026-01-01T10:00:00Z'));
    status(true, null, new Date('2026-01-01T10:00:01Z'));
    setTimeout(() => status(false, 'TypeError: cube.nope is undefined', new Date('2026-01-01T10:00:02Z')), 40);

    expect(await run()).toEqual({ code: 1, message: 'TypeError: cube.nope is undefined' });
  });

  it('adds the file and line of a syntax error the page could only describe vaguely', async () => {
    const file = path.join(sceneDir, 'parts', 'gun.js');
    fs.writeFileSync(file, 'export const gun = 1;\nconst broken = ;\n');
    fs.utimesSync(file, new Date('2026-01-01T10:00:00Z'), new Date('2026-01-01T10:00:00Z'));
    status(false, 'сцена не загрузилась', new Date('2026-01-01T10:00:01Z'));

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.message).toContain('сцена не загрузилась');
    expect(result.message).toContain('gun.js:2');
    expect(result.message).toContain('SyntaxError');
  });

  it('picks up a status that arrives while waiting', async () => {
    touch(path.join(sceneDir, 'main.js'), new Date('2026-01-01T10:00:00Z'));
    setTimeout(() => status(true, null, new Date('2026-01-01T10:00:01Z')), 80);

    expect((await run()).code).toBe(0);
  });
});
