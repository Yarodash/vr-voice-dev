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

const URL = `${import.meta.env.BASE_URL}models/ak47/ak47.glb?v=2`; // v=2: вывернутые треугольники разворачиваются при загрузке (fixWinding);
const WOOD_URL = `${import.meta.env.BASE_URL}textures/wood/rough_wood_diff_1k.jpg`;

// У части треугольников скачанной модели (магазин, спуск) обход вершин вывернут, хотя нормали смотрят
// наружу. Из-за этого белая обводка (оболочка, рисуемая с BackSide) ложилась поверх магазина. Здесь
// каждый треугольник, чья нормаль по обходу противоположна нормалям его вершин, переворачивается.
function fixWinding(geometry) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  if (!pos || !nor) return geometry;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const get = (i) => (index ? index.getX(i) : i);
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  const read = (out, k) => { out[0] = pos.getX(k); out[1] = pos.getY(k); out[2] = pos.getZ(k); };
  let flipped = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const i0 = get(t), i1 = get(t + 1), i2 = get(t + 2);
    read(a, i0); read(b, i1); read(c, i2);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = nor.getX(i0) + nor.getX(i1) + nor.getX(i2);
    const ny = nor.getY(i0) + nor.getY(i1) + nor.getY(i2);
    const nz = nor.getZ(i0) + nor.getZ(i1) + nor.getZ(i2);
    if (fx * nx + fy * ny + fz * nz >= 0) continue;
    flipped += 1;
    if (index) {
      index.setX(t + 1, i2);
      index.setX(t + 2, i1);
    } else {
      for (const attr of Object.values(geometry.attributes)) {
        for (let k = 0; k < attr.itemSize; k += 1) {
          const v1 = attr.getComponent(t + 1, k);
          attr.setComponent(t + 1, k, attr.getComponent(t + 2, k));
          attr.setComponent(t + 2, k, v1);
        }
      }
    }
  }
  if (flipped) {
    if (index) index.needsUpdate = true;
    else for (const attr of Object.values(geometry.attributes)) attr.needsUpdate = true;
    console.log(`[ak] развёрнуто треугольников: ${flipped}`);
  }
  return geometry;
}

const loadTemplate = (THREE) => {
  const shared = (globalThis.__sceneState ??= {});
  if (shared.akModel?.url !== URL) {
    const promise = new GLTFLoader().loadAsync(URL).then((gltf) => {
      const meshes = {};
      gltf.scene.traverse((object) => {
        if (object.isMesh) meshes[object.name] = fixWinding(object.geometry);
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
  const accent = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.55, metalness: 0.6, emissive: 0x000000, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.35, side: THREE.DoubleSide });
  const muzzle = new THREE.Vector3(0, 0.052, -0.586); // уточняется по файлу
  const ejector = new THREE.Vector3(0.0235, 0.078, -0.129);
  const trigger = { pivot: new THREE.Object3D(), maxAngle: 0.35 }; // pivot встаёт в группу, когда файл загружен

  const ready = loadTemplate(THREE).then(({ meshes, info }) => {
    if (Array.isArray(info.muzzle)) muzzle.fromArray(info.muzzle);
    if (Array.isArray(info.ejector)) ejector.fromArray(info.ejector);
    const wood = new THREE.MeshStandardMaterial({ map: shared.akWoodMap, color: 0xc46a34, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6, metalness: 0.62, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.4, side: THREE.DoubleSide });
    // у части граней в скачанной модели перевёрнут обход: без DoubleSide магазин и спуск видны только с одной стороны
    for (const [name, material] of [['wood', wood], ['steel', steel]]) {
      if (meshes[name]) group.add(new THREE.Mesh(meshes[name].clone(), material));
    }
    if (meshes.trigger) {
      // спуск на оси: пивот в верхней точке лезвия
      const geometry = meshes.trigger.clone();
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      trigger.pivot.position.set((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
      geometry.translate(-trigger.pivot.position.x, -trigger.pivot.position.y, -trigger.pivot.position.z);
      trigger.pivot.add(new THREE.Mesh(geometry, accent));
      group.add(trigger.pivot);
    }
    return meshes.outline ? meshes.outline.clone() : null;
  });
  return { group, accent, muzzle, ejector, trigger, ready };
}
