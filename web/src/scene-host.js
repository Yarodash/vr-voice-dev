// Runs the hot-swappable scene module and keeps a broken one from taking the page down.
//
// Scene contract:  export function setup(ctx) -> { update(dt), dispose() }   (both optional)
// The scene adds its objects to ctx.root; the host empties ctx.root after every dispose, so a
// scene that forgets to clean up still leaves nothing behind.

function describe(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function freeObject(object) {
  object.traverse?.((node) => {
    node.geometry?.dispose?.();
    for (const material of [].concat(node.material ?? [])) {
      for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose();
      }
      material.dispose?.();
    }
  });
}

export class SceneHost {
  constructor(ctx, report) {
    this.ctx = ctx;
    this.report = report;
    this.module = null;
    this.instance = null;
    this.broken = false;
  }

  mount(module) {
    return this.swap(module);
  }

  swap(nextModule) {
    const previous = this.module;
    this.#teardown();
    try {
      this.#start(nextModule);
      this.report({ ok: true, error: null });
      return true;
    } catch (err) {
      this.#clearRoot();
      this.module = null;
      this.instance = null;
      if (previous) {
        try {
          this.#start(previous);
        } catch {
          this.#clearRoot();
          this.module = null;
          this.instance = null;
        }
      }
      this.report({ ok: false, error: describe(err) });
      return false;
    }
  }

  // Wraps the frame's draw call. Some scene mistakes (a bad material, a broken geometry) only
  // blow up while drawing; hiding the scene keeps the terminal panel and the rest visible.
  render(draw) {
    try {
      draw();
    } catch (err) {
      if (!this.ctx.root.visible) {
        console.error(err); // already reported, or not caused by the scene
        return;
      }
      this.ctx.root.visible = false;
      this.report({ ok: false, error: `ошибка отрисовки: ${describe(err)}` });
    }
  }

  update(dt) {
    if (!this.instance || this.broken) return;
    try {
      this.instance.update?.(dt);
    } catch (err) {
      // Report once and stop calling it: a per-frame exception would flood the log 72 times a second.
      this.broken = true;
      this.report({ ok: false, error: describe(err) });
    }
  }

  #start(module) {
    if (typeof module?.setup !== 'function') {
      throw new Error('scene module must export function setup(ctx)');
    }
    const instance = module.setup(this.ctx) ?? {};
    if (typeof instance.then === 'function') {
      throw new Error('setup() must not be async: return { update, dispose } directly');
    }
    this.instance = instance;
    this.module = module;
    this.broken = false;
    this.ctx.root.visible = true;
  }

  #teardown() {
    try {
      this.instance?.dispose?.();
    } catch (err) {
      console.warn('scene dispose() failed', err);
    }
    this.instance = null;
    this.#clearRoot();
  }

  #clearRoot() {
    const root = this.ctx.root;
    for (const child of [...root.children]) {
      root.remove(child);
      freeObject(child);
    }
  }
}
