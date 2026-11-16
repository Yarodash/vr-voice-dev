// Модель автомата Калашникова (АК-47). Живёт в сцене: правки подхватываются на лету.
//
// Модель скачана: "High-poly AK-47", автор Lamoot, лицензия CC0
// (https://opengameart.org/content/high-poly-ak-47). Сконвертирована скриптом
// scripts/build-ak47-model.mjs в web/public/models/ak47/ak47.glb (см. LICENSE.txt рядом): уже в
// системе оружия сцены — метры, ствол в −Z, верх +Y, середина пистолетной рукоятки в
// (0, −0.04, 0.045), как у пистолета. В файле три меша по материалам (wood, steel, trigger) и
// готовая обводка (outline); точки дула и окна выброса — в userData сцены.
//
// Файл грузится один раз на страницу (globalThis.__sceneState), каждый автомат — копия геометрии
// со своими материалами (спуск светится у того, что в руке или рядом).
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const URL = `${import.meta.env.BASE_URL}models/ak47/ak47.glb?v=1`;
const WOOD_URL = `${import.meta.env.BASE_URL}textures/wood/rough_wood_diff_1k.jpg`;

const loadTemplate = (THREE) => {
  const shared = (globalThis.__sceneState ??= {});
  if (shared.akModel?.url !== URL) {
    const promise = new GLTFLoader().loadAsync(URL).then((gltf) => {
      const meshes = {};
      gltf.scene.traverse((object) => {
        if (object.isMesh) meshes[object.name] = object.geometry;
      });
      return { meshes, info: gltf.scene.userData ?? {} };
    });
    promise.catch((error) => console.error('[ak] модель не загрузилась', error));
    shared.akModel = { url: URL, promise };
  }
  if (!shared.akWoodMap) {
    const map = shared.woodTextures?.map ?? new THREE.TextureLoader().load(WOOD_URL);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
    shared.akWoodMap = map;
  }
  return shared.akModel.promise;
};

// Сразу возвращает пустую группу и всё, что нужно для стрельбы; детали появляются в группе, когда
// файл загружен (после первой загрузки — почти сразу). ready: Promise<outlineGeometry | null>.
export function buildAk(THREE) {
  const group = new THREE.Group();
  const shared = globalThis.__sceneState;
  const accent = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.45, metalness: 0.1, emissive: 0x000000, side: THREE.DoubleSide });
  const muzzle = new THREE.Vector3(0, 0.052, -0.586); // уточняется по файлу
  const ejector = new THREE.Vector3(0.0235, 0.078, -0.129);

  const ready = loadTemplate(THREE).then(({ meshes, info }) => {
    if (Array.isArray(info.muzzle)) muzzle.fromArray(info.muzzle);
    if (Array.isArray(info.ejector)) ejector.fromArray(info.ejector);
    const wood = new THREE.MeshStandardMaterial({ map: shared.akWoodMap, color: 0xc46a34, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
    const steel = new THREE.MeshStandardMaterial({ color: 0x4d525a, roughness: 0.42, metalness: 0.5, side: THREE.DoubleSide });
    // у части граней в скачанной модели перевёрнут обход: без DoubleSide магазин и спуск видны только с одной стороны
    for (const [name, material] of [['wood', wood], ['steel', steel], ['trigger', accent]]) {
      if (meshes[name]) group.add(new THREE.Mesh(meshes[name].clone(), material));
    }
    return meshes.outline ? meshes.outline.clone() : null;
  });
  return { group, accent, muzzle, ejector, ready };
}
