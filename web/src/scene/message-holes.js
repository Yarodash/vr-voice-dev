// Пулевые отверстия в окнах сообщений. Окно — меш оболочки (камера -> HUD -> меши с renderOrder 1000).
// Оболочку не трогаем: в материал окна подмешивается шейдерный код, который по списку дыр
// выбрасывает пиксели (сквозь дыру виден мир) и рисует обугленный рваный край с трещинами.
// Дыры принадлежат СООБЩЕНИЮ, а не слоту пула: каждый кадр каждому окну отдаётся список дыр того
// сообщения, которое оно сейчас показывает. Ключ сообщения — его id и текст (оболочка кладёт
// показанное сообщение в mesh.userData.message); пиксели окна для этого не читаются (это дорого:
// getImageData всей картинки 1600×640 на Quest — 6–9 мс на окно).
//
// Дыры лежат в маленькой текстуре (окну — своя): строка 0 — x, y, радиус, seed; строка 1 — время
// выстрела (секунды от START). Возраст считает шейдер по uNow, поэтому текстура перезаливается только
// когда у окна меняется список дыр (выстрел, другое сообщение), а не каждый кадр.
import { MESSAGE } from '../ui-layout.js';

const MAX = 150; // дыр на сообщение

export function createMessageHoles({ THREE, camera }) {
  const state = (globalThis.__sceneState ??= {});
  const store = (state.messageHoles ??= {}); // key -> [{ x, y, r, seed, t0 }]
  const SAVE_KEY = 'scene.messageHoles3';
  if (state.messageHolesVersion !== 3) {
    // ключи прежних версий (хеш пикселей окна) больше не совпадут: выбрасываем
    for (const k of Object.keys(store)) delete store[k];
    state.messageHolesVersion = 3;
  }
  if (!Object.keys(store).length) {
    try {
      Object.assign(store, JSON.parse(localStorage.getItem(SAVE_KEY)) ?? {});
    } catch {
      // нет сохранённых дыр
    }
  }
  state.messageHolesRev ??= 0; // растёт с каждой новой дырой: окно видит, что его список изменился
  // запись в localStorage — не на каждый выстрел (очередь калаша), а раз в секунду
  let saveTimer = null;
  const save = () => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const keys = Object.keys(store).slice(-12); // помним только последние сообщения
        localStorage.setItem(SAVE_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, store[k]]))));
      } catch {
        // без хранилища дыры не переживут перезагрузку
      }
    }, 1000);
  };

  const START = Date.now(); // от него считается время в текстуре (float32 точен только для малых чисел)
  const raycaster = new THREE.Raycaster();
  const patched = new Map(); // mesh -> rec
  const point = new THREE.Vector3();
  const dir = new THREE.Vector3();

  // окна сообщений (меши оболочки с картинкой на холсте); список пересобирается редко
  let panelList = [];
  let panelsAt = -1e9;
  function panels() {
    const now = performance.now();
    if (now - panelsAt < 1000) return panelList;
    panelsAt = now;
    const list = [];
    camera.traverse((o) => {
      if (o.isMesh && o.geometry?.type === 'PlaneGeometry' && o.material?.map?.isCanvasTexture && o.geometry.parameters.width > 0.3) list.push(o);
    });
    panelList = list;
    return list;
  }

  function isVisible(o) {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  function patch(mesh) {
    let rec = patched.get(mesh);
    if (rec) return rec;
    const material = mesh.material;
    // Униформы и текстура живут на материале, а не в этой версии сцены: после подмены сцены three.js
    // берёт уже скомпилированную программу из своего кэша (тот же customProgramCacheKey) и
    // onBeforeCompile не зовёт — программа продолжает читать униформы, отданные ей при компиляции.
    // Новые объекты униформ она бы не увидела: дыры «застыли» бы до перезагрузки страницы.
    let shared = material.userData.holesShared;
    if (!shared || shared.max !== MAX) {
      shared?.texture.dispose();
      const data = new Float32Array(MAX * 2 * 4);
      const texture = new THREE.DataTexture(data, MAX, 2, THREE.RGBAFormat, THREE.FloatType);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      const uniforms = { uHoleTex: { value: texture }, uHoleN: { value: 0 }, uNow: { value: 0 }, uSY: { value: 1 } };
      shared = material.userData.holesShared = { max: MAX, data, texture, uniforms };
    }
    const { data, texture, uniforms } = shared;
    const base = material.userData.holesBase ??= { compile: material.onBeforeCompile, key: material.customProgramCacheKey }; // оригинал, чтобы заплатки не копились
    rec = { material, uniforms, texture, data, prevCompile: base.compile, prevKey: base.key, key: null, version: -1, listKey: null, rev: -1 };
    material.onBeforeCompile = (shader, renderer) => {
      rec.prevCompile?.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vHP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHP = position.xy;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vHP;
uniform highp sampler2D uHoleTex;
uniform int uHoleN;
uniform float uSY;
uniform float uNow;`)
        .replace(
          '#include <opaque_fragment>',
          `
for (int i = 0; i < ${MAX}; i++) {
  if (i >= uHoleN) break;
  vec4 h = texelFetch(uHoleTex, ivec2(i, 0), 0);
  vec2 d = vec2(vHP.x - h.x, (vHP.y - h.y) * uSY);
  float L = length(d);
  if (L > h.z * 3.6) continue;                    // дальше трещин этой дыры: остальное не считаем
  float age = uNow - texelFetch(uHoleTex, ivec2(i, 1), 0).x;
  float a = atan(d.y, d.x);
  float s = h.w * 6.28318;
  float p = clamp(age / 0.37, 0.0, 1.0);         // 0 — только что выстрелено, 1 — прогорело
  float pg = clamp(age / 0.05, 0.0, 1.0);        // дыра раскрывается быстро, а жар гаснет дольше (по p)
  float grow = mix(0.22, 1.0, 1.0 - pow(1.0 - pg, 3.0));
  float heat = pow(1.0 - p, 1.3);                 // жар: от 1 до 0
  float edge = 1.0 + 0.22 * sin(a * 5.0 + s) + 0.14 * sin(a * 11.0 + s * 2.7) + 0.08 * sin(a * 23.0 + s * 5.1);
  edge += heat * 0.12 * sin(a * 9.0 + age * 23.0 + s * 3.0) * sin(age * 17.0 + a * 4.0); // рваный край мерцает, пока горит
  float r = h.z * grow * edge;
  if (L < r) discard;
  float t = (L - r) / (h.z * (0.9 + 0.5 * heat));
  if (t < 1.0) {
    float k = 1.0 - t;
    outgoingLight = mix(outgoingLight, vec3(0.05, 0.03, 0.02), pow(k, 0.6) * 0.95 * (1.0 - 0.35 * heat));
    vec3 hot = mix(vec3(0.55, 0.05, 0.0), vec3(1.0, 0.55, 0.12), heat);
    outgoingLight += hot * pow(k, mix(14.0, 3.5, heat)) * (0.8 + 1.2 * heat) * heat;
  }
  float reach = h.z * 2.0;
  if (L < r + reach) {
    float ang = fract((a + s) / 1.256637) - 0.5;
    float line = 1.0 - smoothstep(0.0, 0.025 + 0.02 * (L - r) / reach, abs(ang) * (L / h.z));
    outgoingLight *= 1.0 - line * 0.7 * (1.0 - (L - r) / reach);
  }
}
#include <opaque_fragment>`,
        );
    };
    material.customProgramCacheKey = () => `message-holes-shared-${MAX}-r4`; // r2: при правке шейдера поднимай номер, иначе three.js оставит старую программу; // новый ключ: старые программы держат чужие униформы
    material.userData.holesOwner = rec;
    // обновление дыр не зависит от update() сцены: если он по какой-то причине не вызван, окно всё равно получит свои дыры
    const before = (mesh.userData.holesBeforeRender ??= { fn: mesh.onBeforeRender });
    mesh.onBeforeRender = function (...args) {
      before.fn.apply(this, args);
      apply(mesh, rec);
    };
    material.needsUpdate = true;
    patched.set(mesh, rec);
    return rec;
  }

  const hashText = (text) => {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36);
  };

  // Запасной ключ (оболочка без mesh.userData.message): хеш уменьшенной копии окна 64×26
  const tiny = document.createElement('canvas');
  tiny.width = 64;
  tiny.height = 26;
  const tinyG = tiny.getContext('2d', { willReadFrequently: true });
  function pixelKey(canvas) {
    tinyG.clearRect(0, 0, tiny.width, tiny.height);
    tinyG.drawImage(canvas, 0, 0, tiny.width, tiny.height);
    const data = tinyG.getImageData(0, 0, tiny.width, tiny.height).data;
    // зелёное окно «Набираю…» (превью ещё не отправленной фразы): дыр у него нет
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= 240) {
        if (data[i] >= 38 && data[i] <= 60 && data[i + 1] >= 78 && data[i + 1] <= 100 && data[i + 2] <= 50) return null;
        break;
      }
    }
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)), 16777619);
    }
    return `p${hash >>> 0}`;
  }

  // ключ сообщения, которое окно сейчас показывает (null — у этого окна дыр нет)
  function keyOf(mesh, rec) {
    const map = mesh.material.map;
    if (!map) return null;
    if (map.version === rec.version) return rec.key;
    rec.version = map.version;
    const message = mesh.userData.message;
    if (message !== undefined) {
      rec.key = message && message.from !== 'draft' ? `${message.id}:${hashText(message.text ?? '')}` : null;
      return rec.key;
    }
    try {
      rec.key = map.image ? pixelKey(map.image) : null;
    } catch {
      rec.key = null;
    }
    return rec.key;
  }

  function hitUnsafe(origin, direction) {
    camera.updateMatrixWorld(true);
    dir.copy(direction).normalize();
    raycaster.set(origin, dir);
    raycaster.far = 50;
    const meshes = panels().filter(isVisible);
    const hits = raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      const mesh = h.object;
      const canvas = mesh.material.map?.image;
      // прозрачное место окна (вне плашки) пуля пролетает. Считается по раскладке окна, а не чтением
      // пикселя: любой getImageData переводит холст окна в «программный» режим, и после этого каждая
      // его перерисовка заливается в текстуру ~10 мс вместо ~0.2 мс
      if (canvas && h.uv) {
        const part = (mesh.material.map?.repeat.y ?? 1);
        const px = h.uv.x * canvas.width;
        const py = (1 - (h.uv.y * part + 1 - part)) * canvas.height;
        const scaleX = canvas.width / MESSAGE.width;
        const scaleY = canvas.height / MESSAGE.height;
        const box = MESSAGE.box;
        const inBox = px >= box.x * scaleX && px <= (box.x + box.w) * scaleX && py >= box.y * scaleY && py <= part * canvas.height;
        if (!inBox) continue;
      }
      const rec = patch(mesh);
      const key = keyOf(mesh, rec);
      if (!key) continue;
      mesh.worldToLocal(point.copy(h.point));
      const list = (store[key] ??= []);
      const width = mesh.geometry.parameters.width;
      list.push({ x: point.x, y: point.y, r: width * 0.022 * (0.8 + Math.random() * 0.4), seed: Math.random(), t0: Date.now() });
      if (list.length > MAX) list.shift();
      state.messageHolesRev += 1;
      save();
      return true;
    }
    return false;
  }

  // выстрел никогда не должен падать из-за дыр: любая ошибка здесь — просто «не попал»
  function hit(origin, direction) {
    try {
      return hitUnsafe(origin, direction);
    } catch (error) {
      console.warn('message-holes hit failed', error);
      return false;
    }
  }

  // отдать окну дыры его сообщения (вызывается и из update, и прямо перед отрисовкой окна)
  function apply(mesh, rec) {
    const key = mesh.visible ? keyOf(mesh, rec) : null;
    rec.uniforms.uSY.value = mesh.scale.y;
    rec.uniforms.uNow.value = (Date.now() - START) / 1000;
    if (key === rec.listKey && rec.rev === state.messageHolesRev) return; // список не менялся
    rec.listKey = key;
    rec.rev = state.messageHolesRev;
    const list = (key ? store[key] : null) ?? [];
    const n = Math.min(list.length, MAX);
    const { data } = rec;
    for (let i = 0; i < n; i += 1) {
      const h = list[i];
      data.set([h.x, h.y, h.r, h.seed], i * 4);
      data[(MAX + i) * 4] = h.t0 ? (h.t0 - START) / 1000 : -1e4; // старая дыра без времени — давно прогорела
    }
    rec.uniforms.uHoleN.value = n;
    if (n || rec.hadHoles) rec.texture.needsUpdate = true;
    rec.hadHoles = n > 0;
  }

  function update() {
    for (const mesh of panels()) {
      const rec = patched.get(mesh) ?? patch(mesh);
      apply(mesh, rec);
    }
  }

  function dispose() {
    for (const rec of patched.values()) {
      // текстуру дыр не освобождаем: она общая с программой окна и пригодится следующей версии сцены
      if (rec.material.userData.holesOwner !== rec) continue; // материал уже забрала новая версия сцены
      delete rec.material.userData.holesOwner;
      for (const [mesh, r] of patched) {
        if (r === rec && mesh.userData.holesBeforeRender) {
          mesh.onBeforeRender = mesh.userData.holesBeforeRender.fn;
          delete mesh.userData.holesBeforeRender;
        }
      }
      delete rec.material.userData.holesBase;
      rec.material.onBeforeCompile = rec.prevCompile ?? (() => {});
      rec.material.customProgramCacheKey = rec.prevKey ?? (() => '');
      rec.material.needsUpdate = true;
    }
    patched.clear();
  }

  return { hit, update, dispose };
}
