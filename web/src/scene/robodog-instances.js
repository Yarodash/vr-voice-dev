// Стая робопсов: все псы — экземплярами. Вместо 11+ вызовов отрисовки на пса — по одному на вид
// детали для всех сразу: корпус, глаза, бедро и голень (левые и правые — зеркальные геометрии),
// башенка и ствол пулемёта, пятно тени (итого 9). Каждый кадр матрицы шарниров скелетов псов
// (buildRobodogRig, robodog-model.js) копируются в буферы экземпляров — без выделений памяти.
//
// Окраска у каждого пса своя без отдельных материалов: у вершин атрибут paintSlot (0 — сталь/резина,
// как есть; 1 — «жёлтая» краска; 2 — «чёрная»), у экземпляра — два цвета краски (aPaintA, aPaintB) и
// свечение вспышки от попадания (aEmissive); шейдер подставляет их (onBeforeCompile, ключ программы
// постоянный). Глаза — instanceColor, тень — прозрачность экземпляра (aAlpha).
//
// createDogInstances({ THREE, root, textures, env, shadowTexture, capacity }) →
//   { begin(), add(unit), end(), meshes, count, dispose() }
import { buildRobodog, DOG_PAINTS } from './robodog-model.js';

const PROGRAM_KEY = 'robodog-inst-1';

export function createDogInstances({ THREE, root, textures = null, env = null, shadowTexture = null, capacity = 64 }) {
  // геометрии — один раз из обычной модели (её материалы не нужны)
  const template = buildRobodog(THREE, { textures, env });
  template.material.dispose();
  template.eyeMaterial.dispose();
  const geo = template.geometries;
  // слоты краски по цвету вершин: «жёлтые» → 1, «чёрные» → 2 (как setPaint у обычной модели)
  const yellow = new THREE.Color(DOG_PAINTS[0][0]);
  const black = new THREE.Color(DOG_PAINTS[0][1]);
  const near = (a, i, c) => Math.abs(a[i] - c.r) + Math.abs(a[i + 1] - c.g) + Math.abs(a[i + 2] - c.b) < 1e-4;
  const addSlots = (g) => {
    const a = g.attributes.color.array;
    const slots = new Float32Array(a.length / 3);
    for (let i = 0; i < slots.length; i += 1) slots[i] = near(a, i * 3, yellow) ? 1 : near(a, i * 3, black) ? 2 : 0;
    g.setAttribute('paintSlot', new THREE.BufferAttribute(slots, 1));
  };
  // цвета окрасок (линейные)
  const paints = DOG_PAINTS.map(([p, s]) => [new THREE.Color(p), new THREE.Color(s)]);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: textures?.map ?? null,
    roughnessMap: textures?.orm ?? null,
    metalnessMap: textures?.orm ?? null,
    roughness: textures ? 1 : 0.45,
    metalness: textures ? 1 : 0.65,
    envMap: env,
    envMapIntensity: 0.5,
    flatShading: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float paintSlot;\nattribute vec3 aPaintA;\nattribute vec3 aPaintB;\nattribute vec3 aEmissive;\nvarying vec3 vDogEmissive;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n\tvColor.rgb = paintSlot > 1.5 ? aPaintB : ( paintSlot > 0.5 ? aPaintA : vColor.rgb );\n\tvDogEmissive = aEmissive;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDogEmissive;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vDogEmissive;');
  };
  material.customProgramCacheKey = () => PROGRAM_KEY;
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  shadowMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vDogAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvDogAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDogAlpha;')
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n\tdiffuseColor.a *= vDogAlpha;');
  };
  shadowMaterial.customProgramCacheKey = () => `${PROGRAM_KEY}-shadow`;
  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  shadowGeometry.rotateX(-Math.PI / 2);

  const meshes = [];
  // вид детали: InstancedMesh на cap экземпляров; painted — с краской и вспышкой
  const kind = (geometry, mat, cap, name, { painted = false, alpha = false } = {}) => {
    if (painted) {
      addSlots(geometry);
      geometry.setAttribute('aPaintA', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aPaintB', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aEmissive', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    }
    if (alpha) geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.InstancedMesh(geometry, mat, cap);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // псы по всему полю; шейдер собирается сразу
    mesh.count = 0;
    root.add(mesh);
    meshes.push(mesh);
    return { mesh, n: 0, painted, alpha, cap, m: mesh.instanceMatrix.array, a: geometry.attributes.aPaintA?.array, b: geometry.attributes.aPaintB?.array, e: geometry.attributes.aEmissive?.array, al: geometry.attributes.aAlpha?.array };
  };
  const cap2 = capacity * 2;
  const body = kind(geo.body, material, capacity, 'dogs-body', { painted: true });
  const eye = kind(geo.eye, eyeMaterial, capacity, 'dogs-eye');
  eye.mesh.setColorAt(0, new THREE.Color());
  eye.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const upper = [kind(geo.upper[0], material, cap2, 'dogs-upper-l', { painted: true }), kind(geo.upper[1], material, cap2, 'dogs-upper-r', { painted: true })];
  const lower = [kind(geo.lower[0], material, cap2, 'dogs-lower-l', { painted: true }), kind(geo.lower[1], material, cap2, 'dogs-lower-r', { painted: true })];
  const tBase = kind(geo.turretBase, material, capacity, 'dogs-turret-base', { painted: true });
  const tGun = kind(geo.turretGun, material, capacity, 'dogs-turret-gun', { painted: true });
  const shadow = kind(shadowGeometry, shadowMaterial, capacity, 'dogs-shadow', { alpha: true });
  shadow.mesh.renderOrder = 1;
  const kinds = [body, eye, upper[0], upper[1], lower[0], lower[1], tBase, tGun, shadow];

  let pa = null;
  let pb = null;
  let em = null;
  // экземпляр детали: матрица (16 чисел из elements), краска и вспышка
  const put = (k, elements) => {
    if (k.n >= k.cap) return;
    const i = k.n;
    k.m.set(elements, i * 16);
    if (k.painted) {
      const j = i * 3;
      k.a[j] = pa.r;
      k.a[j + 1] = pa.g;
      k.a[j + 2] = pa.b;
      k.b[j] = pb.r;
      k.b[j + 1] = pb.g;
      k.b[j + 2] = pb.b;
      k.e[j] = em.r;
      k.e[j + 1] = em.g;
      k.e[j + 2] = em.b;
    }
    k.n += 1;
  };
  const flush = (k) => {
    const mesh = k.mesh;
    mesh.count = k.n;
    if (!k.n) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, k.n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (k.painted) {
      for (const name of ['aPaintA', 'aPaintB', 'aEmissive']) {
        const attr = mesh.geometry.attributes[name];
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, k.n * 3);
        attr.needsUpdate = true;
      }
    }
    if (k.alpha) {
      const attr = mesh.geometry.attributes.aAlpha;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, k.n);
      attr.needsUpdate = true;
    }
  };
  return {
    meshes,
    get count() {
      return body.n;
    },
    begin() {
      for (const k of kinds) k.n = 0;
    },
    // пёс с скелетом (unit.model — buildRobodogRig); матрицы шарниров уже посчитаны (collectJoints)
    add(unit) {
      const model = unit.model;
      if (!model.group.visible) return;
      const paint = paints[model.paint] ?? paints[0];
      pa = paint[0];
      pb = paint[1];
      em = model.material.emissive;
      put(body, model.body.matrixWorld.elements);
      if (eye.n < eye.cap) {
        eye.m.set(model.body.matrixWorld.elements, eye.n * 16);
        eye.mesh.instanceColor.setXYZ(eye.n, model.eyeMaterial.color.r, model.eyeMaterial.color.g, model.eyeMaterial.color.b);
        eye.n += 1;
      }
      for (let i = 0; i < 4; i += 1) {
        const leg = model.legs[i];
        put(upper[leg.side], leg.upper.matrixWorld.elements);
        put(lower[leg.side], leg.knee.matrixWorld.elements);
      }
      const t = model.turret;
      if (t.yaw.visible) {
        t.yaw.updateMatrixWorld(true); // башня повёрнута после collectJoints (наводка)
        put(tBase, t.yaw.matrixWorld.elements);
        put(tGun, t.pitch.matrixWorld.elements);
      }
      const sh = unit.shadow;
      if (sh.visible && shadow.n < shadow.cap) {
        sh.updateMatrix();
        shadow.m.set(sh.matrix.elements, shadow.n * 16);
        shadow.al[shadow.n] = unit.shadowMaterial.opacity;
        shadow.n += 1;
      }
    },
    end() {
      for (const k of kinds) flush(k);
      if (eye.n) {
        eye.mesh.instanceColor.clearUpdateRanges();
        eye.mesh.instanceColor.addUpdateRange(0, eye.n * 3);
        eye.mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.dispose();
      }
      template.dispose(); // геометрии модели-образца
      shadowGeometry.dispose();
      material.dispose();
      eyeMaterial.dispose();
      shadowMaterial.dispose();
    },
  };
}
