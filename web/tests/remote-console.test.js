import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createRemoteConsole, describeValue, runSnippet } from '../src/remote-console.js';

describe('describeValue', () => {
  it('prints primitives the way a console does', () => {
    expect(describeValue(42)).toBe('42');
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(null)).toBe('null');
    expect(describeValue(true)).toBe('true');
    expect(describeValue('text')).toBe('"text"');
  });

  it('prints nested plain data', () => {
    expect(describeValue({ a: 1, b: [1, 'x', { c: null }] })).toBe('{a: 1, b: [1, "x", {c: null}]}');
  });

  it('survives cycles', () => {
    const loop = { name: 'loop' };
    loop.self = loop;

    expect(describeValue(loop)).toBe('{name: "loop", self: [Circular]}');
  });

  it('stops at the depth limit', () => {
    expect(describeValue({ a: { b: { c: { d: 1 } } } }, { depth: 2 })).toBe('{a: {b: [Object]}}');
  });

  it('summarises three.js objects instead of dumping them', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.name = 'cube';
    mesh.position.set(0, 1, -0.9);

    expect(describeValue(mesh)).toBe('Mesh "cube" {position: (0, 1, -0.9), children: 0, visible: true}');
    expect(describeValue(new THREE.Vector3(1, 2.123456, 3))).toBe('Vector3(1, 2.1235, 3)');
    expect(describeValue(new THREE.Color(0xff0000))).toBe('Color(#ff0000)');
    expect(describeValue(mesh.geometry)).toBe('[BoxGeometry]');
  });

  it('names functions and errors', () => {
    expect(describeValue(function setup() {})).toBe('[Function setup]');
    expect(describeValue(new TypeError('nope'))).toBe('TypeError: nope');
  });

  it('shortens long arrays', () => {
    const out = describeValue(Array.from({ length: 60 }, (_, i) => i));

    expect(out.startsWith('[0, 1, 2,')).toBe(true);
    expect(out.endsWith('49, … +10]')).toBe(true);
  });

  it('truncates long output', () => {
    const out = describeValue('x'.repeat(100), { maxLength: 20 });

    expect(out).toBe(`${'"' + 'x'.repeat(19)}… (обрезано)`);
  });
});

describe('runSnippet', () => {
  it('returns the value of an expression', async () => {
    expect(await runSnippet('a + 1', { a: 2 })).toBe(3);
  });

  it('runs statements with an explicit return', async () => {
    expect(await runSnippet('const b = a * 2; return b;', { a: 2 })).toBe(4);
  });

  it('awaits promises', async () => {
    expect(await runSnippet('await Promise.resolve(a)', { a: 5 })).toBe(5);
  });

  it('rejects with the thrown error', async () => {
    await expect(runSnippet('nope.x', {})).rejects.toThrow('nope is not defined');
  });

  it('rejects on a syntax error', async () => {
    await expect(runSnippet('const = ;', {})).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('createRemoteConsole', () => {
  function setup(options = {}) {
    const sent = [];
    const state = { connected: true, now: 1000 };
    const remote = createRemoteConsole({
      send: (message) => sent.push(message),
      isConnected: () => state.connected,
      scope: () => ({ answer: 42 }),
      now: () => state.now,
      ...options,
    });
    return { sent, state, remote };
  }

  function fakeConsole(calls = []) {
    const target = {};
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) target[level] = (...args) => calls.push([level, ...args]);
    return target;
  }

  it('answers an eval request with the printed value', async () => {
    const { sent, remote } = setup();

    await remote.run({ t: 'eval', id: 'e1', code: 'answer + 1' });

    expect(sent).toEqual([{ t: 'eval-result', id: 'e1', ok: true, value: '43' }]);
  });

  it('passes a file result through instead of printing megabytes of base64', async () => {
    const { sent, remote } = setup({
      scope: () => ({ screenshot: async () => ({ file: { ext: 'jpg', base64: 'QUJD' }, note: 'левый глаз, 1024x1073' }) }),
    });

    await remote.run({ t: 'eval', id: 'e3', code: 'await screenshot()' });

    expect(sent).toEqual([
      { t: 'eval-result', id: 'e3', ok: true, value: 'левый глаз, 1024x1073', file: { ext: 'jpg', base64: 'QUJD' } },
    ]);
  });

  it('answers with the error text when the code throws', async () => {
    const { sent, remote } = setup();

    await remote.run({ t: 'eval', id: 'e2', code: 'nope.x' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'eval-result', id: 'e2', ok: false });
    expect(sent[0].error).toContain('ReferenceError: nope is not defined');
  });

  it('forwards console output and still calls the original', () => {
    const { sent, remote } = setup();
    const calls = [];
    const target = fakeConsole(calls);

    remote.hookConsole(target);
    target.log('cube', { x: 1 });
    target.error(new Error('boom'));

    expect(calls).toEqual([
      ['log', 'cube', { x: 1 }],
      ['error', new Error('boom')],
    ]);
    expect(sent).toEqual([
      { t: 'console', level: 'log', text: 'cube {x: 1}' },
      { t: 'console', level: 'error', text: 'Error: boom' },
    ]);
  });

  it('keeps output produced while disconnected and sends it on flush', () => {
    const { sent, state, remote } = setup();
    const target = fakeConsole();
    remote.hookConsole(target);
    state.connected = false;

    target.warn('early');
    expect(sent).toEqual([]);

    state.connected = true;
    remote.flush();
    expect(sent).toEqual([{ t: 'console', level: 'warn', text: 'early' }]);
  });

  it('drops a flood instead of choking the connection, and says how much it dropped', () => {
    // e.g. a console.log left inside update(), 72 times a second
    const { sent, state, remote } = setup({ limitPerSecond: 3 });
    const target = fakeConsole();
    remote.hookConsole(target);

    for (let i = 0; i < 10; i += 1) target.log(`frame ${i}`);
    state.now += 1000;
    target.log('later');

    expect(sent.map((m) => m.text)).toEqual([
      'frame 0',
      'frame 1',
      'frame 2',
      '… пропущено сообщений консоли: 7',
      'later',
    ]);
  });
});
