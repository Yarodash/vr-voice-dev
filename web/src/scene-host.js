// Runs the hot-swappable scene module and keeps a broken one from taking the page down.
//
// Scene contract:  export function setup(ctx) -> { update(dt), dispose() }   (both optional)
// The scene adds its objects to ctx.root; the host empties ctx.root after every dispose, so a
// scene that forgets to clean up still leaves nothing behind.
//
// A swap is "prepare, then commit", so that a scene update does not freeze the headset:
//   1. swap(): the old scene's dispose() runs, its objects move out of ctx.root into a frozen copy
//      that stays on screen, and the new setup() fills ctx.root, which stays hidden. Every
//      geometry/material/texture dispose() called meanwhile is only queued: the GPU programs and
//      uploaded textures of the old scene stay alive, so the new scene reuses them (three shares a
//      program between materials with the same shader) instead of compiling and uploading again.
//      Then the new scene is precompiled. Usually nothing is new (no shader and no texture to
//      upload): it is committed right away and the frozen copy is never drawn. Otherwise:
//   2. the next frames: the new scene's shaders that really are new get compiled and linked (with
//      KHR_parallel_shader_compile in the background; the Quest browser has no such extension, so
//      there each program's link wait is taken one or two per frame), then its textures are
//      uploaded, a few per frame.
//   3. commit, inside one frame: the frozen copy goes, ctx.root is shown, the new update() starts.
//      A couple of frames later the queued disposes run for whatever the live scene no longer uses.

const PREPARE_TIMEOUT_MS = 3000; // commit anyway if preparing takes longer than this
const FRAME_BUDGET_MS = 6; // shader links and texture uploads per frame while preparing (at least one)
const FLUSH_AFTER_FRAMES = 2; // queued disposes run this many frames after the commit
const noop = () => {};

function describe(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function texturesOf(material, into) {
  for (const value of Object.values(material)) {
    if (value?.isTexture) into.add(value);
  }
  for (const uniform of Object.values(material.uniforms ?? {})) {
    const value = uniform?.value;
    if (value?.isTexture) into.add(value);
    else if (Array.isArray(value)) for (const item of value) if (item?.isTexture) into.add(item);
  }
  return into;
}

// Everything the scene graph still draws with: this must not be freed.
function inUse(scene) {
  const used = new Set();
  for (const value of [scene.background, scene.environment]) if (value?.isTexture) used.add(value);
  scene.traverse((node) => {
    if (node.geometry) used.add(node.geometry);
    if (node.isInstancedMesh) used.add(node);
    for (const material of [].concat(node.material ?? [])) {
      used.add(material);
      texturesOf(material, used);
    }
  });
  return used;
}

function isInside(node, ancestor) {
  for (let at = node; at; at = at.parent) if (at === ancestor) return true;
  return false;
}

export class SceneHost {
  constructor(ctx, report) {
    this.ctx = ctx;
    this.report = report;
    this.module = null;
    this.instance = null;
    this.broken = false;
    this.pending = null; // the swap being prepared (the old objects frozen on screen, the new hidden)
    this.disposals = new Set(); // dispose() calls held back during swaps, run by #flush
    this.flushIn = 0;
    this.lastSwap = null; // timings of the last swap: `npm run vr:eval -- "sceneHost.lastSwap"`
  }

  mount(module) {
    return this.swap(module);
  }

  swap(nextModule) {
    if (this.pending) this.#commit(); // a newer version arrived while preparing: drop the frozen copy
    const t0 = performance.now();
    const previousModule = this.module;
    const { THREE, root, renderer, scene, camera } = this.ctx;
    const previous = new THREE.Group();
    previous.name = 'scene-host-previous';
    let error = null;
    let disposeMs = 0;
    const release = this.#holdDisposals();
    try {
      try {
        this.instance?.dispose?.();
      } catch (err) {
        console.warn('scene dispose() failed', err);
      }
      disposeMs = performance.now() - t0;
      this.instance = null;
      // the old objects stay on screen, frozen, until the new scene can be drawn without a stall;
      // they must not run the old scene's per-draw code meanwhile
      previous.position.copy(root.position);
      previous.quaternion.copy(root.quaternion);
      previous.scale.copy(root.scale);
      for (const child of [...root.children]) previous.add(child);
      const muted = new Map();
      previous.traverse((node) => {
        const own = (key) => (Object.hasOwn(node, key) ? node[key] : undefined);
        const callbacks = [own('onBeforeRender'), own('onAfterRender')];
        if (!callbacks[0] && !callbacks[1]) return;
        muted.set(node, callbacks);
        if (callbacks[0]) node.onBeforeRender = noop;
        if (callbacks[1]) node.onAfterRender = noop;
      });
      root.parent?.add(previous);
      try {
        this.#start(nextModule);
      } catch (err) {
        error = err;
        this.#retire(root.children);
        this.module = null;
        this.instance = null;
        if (previousModule) {
          try {
            this.#start(previousModule);
          } catch {
            this.#retire(root.children);
            this.module = null;
            this.instance = null;
          }
        }
      }
      // an object the new scene took over from the old one (cached in __sceneState) works again
      for (const [node, [before, after]] of muted) {
        if (isInside(node, previous)) continue;
        if (before && node.onBeforeRender === noop) node.onBeforeRender = before;
        if (after && node.onAfterRender === noop) node.onAfterRender = after;
      }
    } finally {
      release();
    }
    const setupMs = performance.now() - t0 - disposeMs;
    const pending = {
      previous, startedAt: performance.now(), compiled: false, programs: [], uploads: [], hidden: [],
      linked: 0, uploaded: 0, frames: 0, disposeMs, setupMs, compileMs: 0,
    };
    this.pending = pending;
    const c0 = performance.now();
    // what is going to be drawn: the visible scene without the frozen copy
    const drawn = [];
    const visit = (node) => {
      if (node === previous || !node.visible) return;
      drawn.push(node);
      for (const child of node.children) visit(child);
    };
    visit(scene);
    // Lights must already be what they will be after the commit: the new root's lights count, the
    // frozen copy's do not (otherwise every lit material would get a shader variant just for the
    // frozen frames). So the new root stays "visible" with only its drawable objects hidden.
    previous.traverse((node) => {
      if (node.isLight) node.visible = false;
    });
    const known = new Set(renderer.info.programs);
    let compiling;
    try {
      // not compileAsync(scene): that would also build shaders for every hidden object
      compiling = renderer.compileAsync({ traverse: (fn) => drawn.forEach(fn), traverseVisible() {} }, camera, scene);
    } catch (err) {
      compiling = Promise.reject(err);
    }
    pending.compileMs = performance.now() - c0;
    pending.programs = renderer.info.programs.filter((program) => !known.has(program));
    // textures it is going to draw with that are not on the GPU yet (a hidden effect's big empty
    // canvas is left for when it is shown, as before)
    const textures = new Set();
    for (const node of drawn) for (const material of [].concat(node.material ?? [])) texturesOf(material, textures);
    pending.uploads = [...textures].filter((texture) => {
      if (texture.isRenderTargetTexture || !(texture.version > 0)) return false;
      const image = texture.image;
      if (!image || image.complete === false) return false;
      return renderer.properties.get(texture).__version !== texture.version;
    });
    compiling
      .catch((err) => console.warn('scene precompile failed', err))
      .finally(() => {
        pending.compiled = true;
      });
    if (!pending.programs.length && !pending.uploads.length) {
      this.#commit(); // nothing to wait for (the usual case): the next frame draws the new scene
    } else {
      root.traverse((node) => {
        if (node.visible && (node.isMesh || node.isPoints || node.isLine || node.isSprite)) {
          node.visible = false;
          pending.hidden.push(node);
        }
      });
    }
    this.report(error ? { ok: false, error: describe(error) } : { ok: true, error: null });
    return !error;
  }

  // Wraps the frame's draw call. Some scene mistakes (a bad material, a broken geometry) only
  // blow up while drawing; hiding the scene keeps the terminal panel and the rest visible.
  render(draw) {
    try {
      draw();
    } catch (err) {
      if (!this.ctx.root.visible) {
        console.error(err); // already reported, or not caused by the scene
      } else {
        this.ctx.root.visible = false;
        this.report({ ok: false, error: `ошибка отрисовки: ${describe(err)}` });
      }
    }
    if (this.flushIn > 0 && !this.pending && --this.flushIn === 0) this.#flush();
  }

  update(dt) {
    if (this.pending && !this.#prepare()) return; // the old scene is still on screen, frozen
    if (!this.instance || this.broken) return;
    try {
      this.instance.update?.(dt);
    } catch (err) {
      // Report once and stop calling it: a per-frame exception would flood the log 72 times a second.
      this.broken = true;
      this.report({ ok: false, error: describe(err) });
    }
  }

  // One frame of preparing the new scene; true once it has been committed.
  #prepare() {
    const pending = this.pending;
    pending.frames += 1;
    const late = performance.now() - pending.startedAt > PREPARE_TIMEOUT_MS;
    if (!pending.compiled && !late) return false;
    const { renderer } = this.ctx;
    const start = performance.now();
    const spent = () => performance.now() - start > FRAME_BUDGET_MS;
    let worked = false;
    // a program's first use waits for its link (and reads its uniforms): one at a time, not all
    // in the frame that first draws the new scene
    while (pending.programs.length && !late) {
      if (worked && spent()) return false;
      const program = pending.programs.shift();
      const s0 = performance.now();
      try {
        if (program.program) {
          program.getUniforms();
          program.getAttributes();
        }
      } catch (err) {
        console.warn('scene shader link failed', err);
      }
      pending.linked += 1;
      worked = true;
      const took = performance.now() - s0;
      if (took > 3) (pending.slow ??= []).push(['link', program.name || program.cacheKey.slice(0, 24), +took.toFixed(1)]);
    }
    while (pending.uploads.length && !late) {
      if (worked && spent()) return false;
      const s0 = performance.now();
      const texture = pending.uploads.shift();
      try {
        renderer.initTexture(texture);
      } catch (err) {
        console.warn('scene texture upload failed', err);
      }
      pending.uploaded += 1;
      worked = true;
      const took = performance.now() - s0;
      if (took > 3) (pending.slow ??= []).push(['tex', texture.name || texture.constructor.name, texture.image?.width, texture.image?.height, +took.toFixed(1)]);
    }
    this.#commit();
    return true;
  }

  #commit() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.previous.removeFromParent();
    this.#retire(pending.previous.children);
    for (const node of pending.hidden) node.visible = true;
    this.ctx.root.visible = true;
    this.flushIn = FLUSH_AFTER_FRAMES;
    this.lastSwap = {
      disposeMs: +pending.disposeMs.toFixed(1),
      setupMs: +pending.setupMs.toFixed(1),
      compileMs: +pending.compileMs.toFixed(1),
      prepareMs: +(performance.now() - pending.startedAt).toFixed(1),
      prepareFrames: pending.frames,
      newPrograms: pending.linked,
      uploads: pending.uploaded,
      compileTimeout: performance.now() - pending.startedAt > PREPARE_TIMEOUT_MS,
      slow: pending.slow,
    };
    const s = this.lastSwap;
    console.log(`[swap] dispose=${s.disposeMs}ms setup=${s.setupMs}ms compile=${s.compileMs}ms prepare=${s.prepareMs}ms/${s.prepareFrames}fr newProgs=${s.newPrograms} uploads=${s.uploads}${s.compileTimeout ? ' TIMEOUT' : ''}`);
  }

  // Frees what was disposed during the swaps and what the old scenes left behind, except what the
  // live scene still draws with (things cached in __sceneState and reused, for example).
  #flush() {
    const t0 = performance.now();
    const used = inUse(this.ctx.scene);
    let freed = 0;
    for (const item of this.disposals) {
      if (used.has(item)) continue;
      try {
        item.dispose();
        freed += 1;
      } catch (err) {
        console.warn('scene free failed', err);
      }
    }
    this.disposals.clear();
    if (this.lastSwap) {
      this.lastSwap.freed = freed;
      this.lastSwap.flushMs = +(performance.now() - t0).toFixed(1);
    }
  }

  // Takes objects out of the scene; their geometries, materials and textures are freed by #flush.
  #retire(objects) {
    for (const object of [...objects]) {
      object.removeFromParent();
      object.traverse((node) => {
        if (node.geometry) this.disposals.add(node.geometry);
        for (const material of [].concat(node.material ?? [])) {
          for (const value of Object.values(material)) if (value?.isTexture) this.disposals.add(value);
          this.disposals.add(material);
        }
      });
    }
  }

  // Until the returned function is called, dispose() of geometries, materials, textures and
  // instanced meshes only queues the object for #flush.
  #holdDisposals() {
    const { THREE } = this.ctx;
    const queue = this.disposals;
    const protos = [THREE.BufferGeometry.prototype, THREE.Material.prototype, THREE.Texture.prototype, THREE.InstancedMesh.prototype];
    const saved = protos.map((proto) => [proto, Object.getOwnPropertyDescriptor(proto, 'dispose')]);
    for (const proto of protos) {
      Object.defineProperty(proto, 'dispose', {
        configurable: true,
        writable: true,
        value() {
          queue.add(this);
        },
      });
    }
    return () => {
      for (const [proto, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, 'dispose', descriptor);
        else delete proto.dispose;
      }
    };
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
}
