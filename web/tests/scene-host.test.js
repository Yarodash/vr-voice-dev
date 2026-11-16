import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SceneHost } from '../src/scene-host.js';

function setupHost() {
  const reports = [];
  const ctx = { THREE, root: new THREE.Group() };
  return { host: new SceneHost(ctx, (r) => reports.push(r)), ctx, reports };
}

function cubeScene(log, name) {
  return {
    setup(ctx) {
      log.push(`setup:${name}`);
      const mesh = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(), new ctx.THREE.MeshBasicMaterial());
      mesh.name = name;
      ctx.root.add(mesh);
      return {
        update: () => log.push(`update:${name}`),
        dispose: () => log.push(`dispose:${name}`),
      };
    },
  };
}

describe('SceneHost', () => {
  it('mounts a scene and reports success', () => {
    const { host, ctx, reports } = setupHost();

    host.mount(cubeScene([], 'a'));

    expect(ctx.root.children.map((c) => c.name)).toEqual(['a']);
    expect(reports).toEqual([{ ok: true, error: null }]);
  });

  it('swap disposes old before setting up new', () => {
    const { host, ctx } = setupHost();
    const log = [];
    host.mount(cubeScene(log, 'a'));

    host.swap(cubeScene(log, 'b'));

    expect(log).toEqual(['setup:a', 'dispose:a', 'setup:b']);
    expect(ctx.root.children.map((c) => c.name)).toEqual(['b']);
  });

  it('failing setup rolls back to previous module and reports error', () => {
    const { host, ctx, reports } = setupHost();
    const log = [];
    host.mount(cubeScene(log, 'a'));

    host.swap({
      setup(c) {
        c.root.add(new c.THREE.Group());
        throw new Error('gun is not defined');
      },
    });

    expect(ctx.root.children.map((c) => c.name)).toEqual(['a']);
    expect(reports.at(-1).ok).toBe(false);
    expect(reports.at(-1).error).toContain('gun is not defined');
    host.update(0.016);
    expect(log.at(-1)).toBe('update:a');
  });

  it('a module without setup() is an error, not a crash', () => {
    const { host, ctx, reports } = setupHost();
    host.mount(cubeScene([], 'a'));

    host.swap({});

    expect(reports.at(-1).ok).toBe(false);
    expect(reports.at(-1).error).toContain('setup');
    expect(ctx.root.children.map((c) => c.name)).toEqual(['a']);
  });

  it('update error is reported once and stops updates until next swap', () => {
    const { host, reports } = setupHost();
    let calls = 0;
    host.mount({
      setup: () => ({
        update() {
          calls += 1;
          throw new Error('boom');
        },
      }),
    });

    host.update(0.016);
    host.update(0.016);
    host.update(0.016);

    expect(calls).toBe(1);
    expect(reports.filter((r) => !r.ok)).toHaveLength(1);
    expect(reports.at(-1).error).toContain('boom');

    const log = [];
    host.swap(cubeScene(log, 'b'));
    host.update(0.016);
    expect(log.at(-1)).toBe('update:b');
  });

  it('dispose error does not block swap', () => {
    const { host, ctx } = setupHost();
    host.mount({
      setup: () => ({
        dispose() {
          throw new Error('cannot dispose');
        },
      }),
    });

    host.swap(cubeScene([], 'b'));

    expect(ctx.root.children.map((c) => c.name)).toEqual(['b']);
  });

  it('root is emptied and GPU resources are freed after dispose', () => {
    const { host, ctx } = setupHost();
    let geometryDisposed = false;
    let materialDisposed = false;
    host.mount({
      setup(c) {
        const mesh = new c.THREE.Mesh(new c.THREE.BoxGeometry(), new c.THREE.MeshBasicMaterial());
        mesh.geometry.addEventListener('dispose', () => (geometryDisposed = true));
        mesh.material.addEventListener('dispose', () => (materialDisposed = true));
        c.root.add(mesh);
        // sloppy scene: no dispose() at all
      },
    });

    host.swap({ setup: () => ({}) });

    expect(ctx.root.children).toHaveLength(0);
    expect(geometryDisposed && materialDisposed).toBe(true);
  });

  it('a render error hides the scene, is reported once, and the next swap shows it again', () => {
    // e.g. a material or geometry that three.js only chokes on while drawing
    const { host, ctx, reports } = setupHost();
    host.mount(cubeScene([], 'a'));
    let draws = 0;

    host.render(() => {
      draws += 1;
      throw new Error('bad geometry');
    });
    host.render(() => {
      draws += 1;
    });

    expect(draws).toBe(2);
    expect(ctx.root.visible).toBe(false);
    expect(reports.filter((r) => !r.ok)).toHaveLength(1);
    expect(reports.at(-1).error).toContain('bad geometry');

    host.swap(cubeScene([], 'b'));
    expect(ctx.root.visible).toBe(true);
  });

  it('a render error with the scene already hidden is not blamed on the scene again', () => {
    const { host, reports } = setupHost();
    host.mount(cubeScene([], 'a'));
    host.render(() => {
      throw new Error('first');
    });

    host.render(() => {
      throw new Error('second');
    });

    expect(reports.filter((r) => !r.ok)).toHaveLength(1);
  });

  it('an async setup is rejected instead of silently never updating', () => {
    const { host, ctx, reports } = setupHost();
    host.mount(cubeScene([], 'a'));

    host.swap({
      async setup() {
        return { update() {} };
      },
    });

    expect(reports.at(-1).ok).toBe(false);
    expect(reports.at(-1).error).toContain('async');
    expect(ctx.root.children.map((c) => c.name)).toEqual(['a']);
  });

  it('a scene that never worked leaves an empty root', () => {
    const { host, ctx, reports } = setupHost();

    host.mount({
      setup(c) {
        c.root.add(new c.THREE.Group());
        throw new Error('bad first scene');
      },
    });

    expect(ctx.root.children).toHaveLength(0);
    expect(reports.at(-1).ok).toBe(false);
    host.update(0.016); // must not throw
  });
});
