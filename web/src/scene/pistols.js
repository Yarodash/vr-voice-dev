// Оружие в мире: его может быть сколько угодно, у каждого вид (kind): 'pistol' — пистолет
// (pistol-model.js), 'ak' — автомат Калашникова (ak-model.js). У каждого своя белая обводка
// «можно взять». Положения и вид переживают подмену сцены на лету (globalThis) и перезагрузку
// страницы (localStorage; в старых сохранениях вида нет — это пистолет). Живёт в сцене.
import { buildPistol } from './pistol-model.js';
import { buildAk } from './ak-model.js';

const STORE_KEY = 'scene.pistols';
const OLD_STORE_KEY = 'scene.pistol'; // прежний формат: один пистолет
const OUTLINE_M = 0.0025; // толщина белой обводки, метры (у калаша обводка готовая, в файле модели)
const KINDS = ['pistol', 'ak'];

export function createPistols({ THREE, root }) {
  const shared = (globalThis.__sceneState ??= {});
  const items = []; // { kind, group, accent, outline, muzzle, ejector }
  const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });

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
      });
    } else {
      const { outlineGeometry, ...pistol } = buildPistol(THREE, { outlineM: OUTLINE_M });
      model = pistol;
      outline = new THREE.Mesh(outlineGeometry, outlineMaterial);
      outline.visible = false;
      model.group.add(outline);
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
