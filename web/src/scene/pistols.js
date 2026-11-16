// Оружие в мире: его может быть сколько угодно, у каждого вид (kind): 'pistol' — пистолет
// (pistol-model.js), 'ak' — автомат Калашникова (ak-model.js). У каждого своя белая обводка
// «можно взять». Положения и вид переживают подмену сцены на лету (globalThis) и перезагрузку
// страницы (localStorage; в старых сохранениях вида нет — это пистолет). Живёт в сцене.
import { buildPistol } from './pistol-model.js';
import { buildAk } from './ak-model.js';
import { buildAwp, cycleBolt } from './awp-model.js';
import { cachedBuild } from './model-cache.js';

const STORE_KEY = 'scene.pistols';
const OLD_STORE_KEY = 'scene.pistol'; // прежний формат: один пистолет
const OUTLINE_M = 0.0025; // толщина белой обводки, метры (у калаша обводка готовая, в файле модели)
const KINDS = ['pistol', 'ak', 'awp']; // 'awp' — снайперка с продольным затвором (awp-model.js), пока без прицела

export function createPistols({ THREE, root }) {
  const shared = (globalThis.__sceneState ??= {});
  const items = []; // { kind, group, accent, outline, muzzle, ejector }
  // Обводка рисуется ПОСЛЕ мира (renderOrder 1) и не пишет глубину, а само оружие — после неё
  // (renderOrder 2): оружие целиком закрывает оболочку, белой остаётся только кайма по силуэту. Так
  // обводка не зависит от того, куда смотрят нормали и обход граней (у скачанного калаша магазин и
  // цевьё вывернуты — раньше оболочка белила их целиком).
  const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, depthWrite: false });
  const liftModel = (group, outline) => {
    outline.renderOrder = 1;
    group.traverse((o) => {
      if (o.isMesh && o !== outline) o.renderOrder = 2;
    });
  };

  // Обводка всего оружия по контуру: те же детали чуть крупнее (одна геометрия, см.
  // pistol-model.js), нарисованные только изнутри (BackSide); внутри силуэта их закрывает само оружие.
  // Калаш грузится из файла: его детали и обводка появляются, когда файл готов (обычно сразу).
  const add = (pose = null, kind = 'pistol') => {
    if (!KINDS.includes(kind)) kind = 'pistol';
    let model;
    let outline;
    if (kind === 'ak') {
      const { ready, ...ak } = buildAk(THREE);
      model = ak;
      outline = new THREE.Mesh(new THREE.BufferGeometry(), outlineMaterial);
      outline.visible = false;
      ready.then((geometry) => {
        if (!geometry) return;
        outline.geometry.dispose();
        outline.geometry = geometry;
        model.group.add(outline);
        liftModel(model.group, outline);
      });
    } else {
      // готовая модель из кэша (model-cache.js): построение пистолета на шлеме ~0,1 с — при каждой подмене сцены
      const { outlineGeometry, ...pistol } = cachedBuild(kind === 'awp' ? buildAwp : buildPistol, THREE, { outlineM: OUTLINE_M });
      model = pistol;
      outline = new THREE.Mesh(outlineGeometry, outlineMaterial);
      outline.visible = false;
      model.group.add(outline);
      liftModel(model.group, outline);
    }
    const item = { kind, ...model, outline };
    if (pose?.position && pose?.quaternion) {
      item.group.position.fromArray(pose.position);
      item.group.quaternion.fromArray(pose.quaternion);
    }
    root.add(item.group);
    items.push(item);
    return item;
  };

  const remove = (item) => {
    const index = items.indexOf(item);
    if (index < 0) return;
    items.splice(index, 1);
    root.remove(item.group);
    const geometries = new Set();
    const materials = new Set();
    item.group.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material && object.material !== outlineMaterial) materials.add(object.material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  };

  const readSaved = () => {
    if (shared.pistols) return shared.pistols;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved?.list) return saved;
      // перенос единственного пистолета из прежней версии сцены
      const old = JSON.parse(localStorage.getItem(OLD_STORE_KEY));
      if (old?.spawned && old.position && old.quaternion) return { list: [{ position: old.position, quaternion: old.quaternion }], held: -1 };
    } catch {
      // нет сохранённого
    }
    return null;
  };

  return {
    items,
    add,
    remove,
    // Спуск оружия идёт за курком: у того, что в руке, — value (0..1) × maxAngle, у остальных — назад в 0.
    // Без аллокаций; вызывается каждый кадр.
    // Выстрел: затвор откатывается (25 мс), возвращается (75 мс); onEject(item) — когда он в крайней точке.
    kick(item) {
      item.shotAt = shared.sceneNowMs ?? performance.now(); // сценовые часы (замедление времени)
      item.ejected = false;
    },
    updateTriggers(heldItem, value, dt, onEject) {
      const now = shared.sceneNowMs ?? performance.now();
      const k = 1 - Math.exp(-30 * Math.min(dt, 0.1));
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.shotAt && item.bolt) {
          // продольный затвор (AWP): вверх, назад (гильза), вперёд, вниз — ≈ 1 с (awp-model.js)
          if (cycleBolt(item, now - item.shotAt, onEject)) item.shotAt = 0;
        } else if (item.shotAt) {
          const age = now - item.shotAt;
          let s = 0;
          if (age < 25) s = 1 - (1 - age / 25) ** 2;
          else if (age < 100) s = (1 - (age - 25) / 75) ** 2;
          if (age >= 25 && !item.ejected) {
            item.ejected = true;
            onEject?.(item);
          }
          if (item.slide) item.slide.pivot.position.z = s * item.slide.travel;
          if (age >= 100) item.shotAt = 0;
        }
        if (!item.trigger) continue;
        const target = item === heldItem ? -value * item.trigger.maxAngle : 0; // −X: нижний конец лезвия к рукоятке (+Z)
        const rot = item.trigger.pivot.rotation;
        rot.x += (target - rot.x) * k;
      }
    },
    // Достать сохранённые пистолеты. Возвращает { held: индекс в items или −1, heldMatrix } .
    restore() {
      const saved = readSaved();
      if (!saved) return { held: -1, heldMatrix: null };
      for (const pose of saved.list) add(pose, pose.kind);
      const fromSwap = Boolean(shared.pistols); // «в руке» переживает только подмену сцены, не перезагрузку
      return { held: fromSwap ? (saved.held ?? -1) : -1, heldMatrix: fromSwap ? saved.heldMatrix ?? null : null };
    },
    // heldItem — тот, что в руке (или null); heldMatrix — его положение относительно руки
    save(heldItem, heldMatrix, force = false) {
      const state = {
        list: items.map((item) => ({ kind: item.kind, position: item.group.position.toArray(), quaternion: item.group.quaternion.toArray() })),
        held: heldItem ? items.indexOf(heldItem) : -1,
        heldMatrix,
      };
      shared.pistols = state;
      if (!force && shared.lastPistolStore && performance.now() - shared.lastPistolStore < 500) return;
      shared.lastPistolStore = performance.now();
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ list: state.list, held: -1 }));
      } catch {
        // без хранилища пистолеты просто не запомнятся между перезагрузками
      }
    },
  };
}
