// Оружие в мире: его может быть сколько угодно, у каждого вид (kind): 'pistol' — пистолет
// (pistol-model.js), 'ak' — автомат Калашникова (ak-model.js). У каждого своя белая обводка
// «можно взять». Положения и вид переживают подмену сцены на лету (globalThis) и перезагрузку
// страницы (localStorage; в старых сохранениях вида нет — это пистолет). Живёт в сцене.
import { buildPistol } from './pistol-model.js';
import { buildAk } from './ak-model.js';
import { buildAwp, cycleBolt } from './awp-model.js';
import { buildAk2 } from './ak2-model.js';
import { cachedBuild } from './model-cache.js';
import { genEntry } from './generated-guns.js';
import { buildGenerated } from './generated-gun.js';

const STORE_KEY = 'scene.pistols';
const OLD_STORE_KEY = 'scene.pistol'; // прежний формат: один пистолет
const OUTLINE_M = 0.0025; // толщина белой обводки, метры (у калаша обводка готовая, в файле модели)
const KINDS = ['pistol', 'ak', 'awp', 'ak2']; // 'awp' — снайперка с прицелом (awp-model.js, линза — scope-lens.js); 'ak2' — «Калаш 2.0»: калаш с прицелом (ak2-model.js)

// makeLens(scope) → стёкла прицела АВП (createScopeLens из scope-lens.js): item.lens; каждый кадр
// updateLenses (изображение — только когда в окуляр смотрят), при удалении и подмене — dispose.
export function createPistols({ THREE, root, makeLens = null }) {
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
      if (o.isMesh && o !== outline && o.material !== outlineMaterial) o.renderOrder = 2; // (обводки прицела — свои, renderOrder 1)
    });
  };

  // Обводка всего оружия по контуру: те же детали чуть крупнее (одна геометрия, см.
  // pistol-model.js), нарисованные только изнутри (BackSide); внутри силуэта их закрывает само оружие.
  // Калаш грузится из файла: его детали и обводка появляются, когда файл готов (обычно сразу).
  const add = (pose = null, kind = 'pistol') => {
    const gen = genEntry(kind); // 'gen:<id>' — сгенерированная пушка (generated-guns.js)
    if (!KINDS.includes(kind) && !gen) kind = 'pistol';
    let model;
    let outline;
    if (gen) {
      // картинка, потом модель — внутри своей группы (generated-gun.js); обводка — её же Mesh
      model = buildGenerated(THREE, gen, { outlineMaterial, outlineM: OUTLINE_M, makeLens }); // прицел и стёкла ставит сам
      outline = model.outline;
    } else if (kind === 'ak' || kind === 'ak2') {
      const { ready, ...ak } = kind === 'ak2' ? buildAk2(THREE, { outlineM: OUTLINE_M }) : buildAk(THREE);
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
    if (model.scope && !gen) {
      {
        // прицел (АВП, «Калаш 2.0»): стёкла и своя обводка — в узле прицела (он двигается и наклоняется)
        const { scope } = model;
        const lens = makeLens?.(scope) ?? null;
        if (lens) {
          lens.eyepiece.position.set(0, scope.y, scope.eyepieceZ);
          lens.objective.position.set(0, scope.y, scope.objectiveZ);
          lens.objective.scale.setScalar(scope.objectiveR);
          lens.eyepiece.renderOrder = lens.objective.renderOrder = 2;
          scope.node.add(lens.eyepiece, lens.objective);
        }
        model.lens = lens;
        if (scope.outlineGeometry) {
          model.scopeOutline = new THREE.Mesh(scope.outlineGeometry, outlineMaterial);
          model.scopeOutline.visible = false;
          model.scopeOutline.renderOrder = 1;
          scope.node.add(model.scopeOutline);
        }
        if (model.fixedOutlineGeometry && model.fixedNode) { // неподвижная часть крепления
          model.fixedOutline = new THREE.Mesh(model.fixedOutlineGeometry, outlineMaterial);
          model.fixedOutline.visible = false;
          model.fixedOutline.renderOrder = 1;
          model.fixedNode.add(model.fixedOutline);
        }
      }
    }
    // сгенерированная пушка — сама item (не копия): прицел, стёкла и спуск появляются в ней позже
    const item = gen ? Object.assign(model, { kind, outline }) : { kind, ...model, outline };
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
    if (item.gen) item.accent.dispose(); // у сгенерированных пушек — пустышка вне группы
    item.lens?.dispose(); // текстура прицела
    const geometries = new Set();
    const materials = new Set();
    item.group.traverse((object) => {
      // userData.shared — общие у всех экземпляров (кэш сгенерированных пушек): не освобождать
      if (object.geometry && !object.geometry.userData.shared) geometries.add(object.geometry);
      if (object.material && object.material !== outlineMaterial && !object.material.userData?.shared) materials.add(object.material);
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
    // при подмене сцены: группы освобождает оболочка, а текстуры прицелов — здесь
    disposeLenses() {
      for (const item of items) item.lens?.dispose();
    },
    // Прицелы АВП, каждый кадр в конце update сцены: сдвиг по планке scopeZ (общий), обводка как у
    // винтовки, изображение — у любого АВП (в руке или висящего), но только когда в окуляр смотрят.
    // scopeTilt — число (у всех) или { [kind]: число } (у каждого вида свой наклон)
    updateLenses(scopeZ, scopeTilt = 0) {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (!item.scope) continue;
        const { scope } = item;
        scope.node.position.z = Math.min(scope.maxZ, Math.max(scope.minZ, scopeZ ?? scope.defaultZ));
        scope.node.rotation.x = typeof scopeTilt === 'number' ? scopeTilt : (scopeTilt?.[item.kind] ?? 0); // наклон стиком (рад, + — передний конец выше)
        if (item.scopeOutline) item.scopeOutline.visible = item.outline.visible;
        if (item.fixedOutline) item.fixedOutline.visible = item.outline.visible;
        item.lens?.update(true, item.group);
      }
    },
    kick(item) {
      item.shotAt = performance.now(); // оружие в руке — по реальному времени (игрок не замедляется, world-clock.js)
      item.ejected = false;
    },
    updateTriggers(heldItem, value, dt, onEject) {
      const now = performance.now();
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
      // не чаще раза в 500 мс (подмена сцены — force): снимок не собирается каждый кадр (мусор для GC)
      if (!force && shared.lastPistolStore && performance.now() - shared.lastPistolStore < 500) return;
      if (typeof heldMatrix === 'function') heldMatrix = heldMatrix();
      const state = {
        list: items.map((item) => ({ kind: item.kind, position: item.group.position.toArray(), quaternion: item.group.quaternion.toArray() })),
        held: heldItem ? items.indexOf(heldItem) : -1,
        heldMatrix,
      };
      shared.pistols = state;
      shared.lastPistolStore = performance.now();
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ list: state.list, held: -1 }));
      } catch {
        // без хранилища пистолеты просто не запомнятся между перезагрузками
      }
    },
  };
}
