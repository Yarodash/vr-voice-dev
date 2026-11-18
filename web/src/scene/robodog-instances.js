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
import { buildRobodog, DOG_PAINTS, injectDissolve } from './robodog-model.js';

const PROGRAM_KEY = 'robodog-inst-2'; // 2 — растворение трупа (aFade)
// Настоящие тени по солнцу — sun-shadows.js (корпус, ноги, башенка — отбрасыватели). Пока они
// включены, старое пятно под псом остаётся только слабой контактной тенью у ног.
const CONTACT_ALPHA = 0.4; // прозрачность пятна при настоящих тенях (×)
const CONTACT_SIZE = 0.8; // его размер (×)
const BIG_FOOT_SCALE = 2.5; // с какого масштаба пса детальная модель (стопа, корпус)

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
    injectDissolve(shader); // aFade у экземпляра: труп растворяется (robodog-model.js)
  };
  material.customProgramCacheKey = () => PROGRAM_KEY;
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  eyeMaterial.onBeforeCompile = (shader) => injectDissolve(shader, { glow: false });
  eyeMaterial.customProgramCacheKey = () => `${PROGRAM_KEY}-eye`;
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
  const kind = (geometry, mat, cap, name, { painted = false, alpha = false, fade = painted } = {}) => {
    if (painted) {
      addSlots(geometry);
      geometry.setAttribute('aPaintA', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aPaintB', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aEmissive', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    }
    if (fade) geometry.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
    if (alpha) geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.InstancedMesh(geometry, mat, cap);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // псы по всему полю; шейдер собирается сразу
    mesh.count = 0;
    root.add(mesh);
    meshes.push(mesh);
    return { mesh, n: 0, painted, alpha, fade, cap, f: geometry.attributes.aFade?.array, m: mesh.instanceMatrix.array, a: geometry.attributes.aPaintA?.array, b: geometry.attributes.aPaintB?.array, e: geometry.attributes.aEmissive?.array, al: geometry.attributes.aAlpha?.array };
  };
  const cap2 = capacity * 2 + 12; // + отвалившиеся ноги (robodog-leg-debris.js, до 12)
  const body = kind(geo.body, material, capacity, 'dogs-body', { painted: true });
  const eye = kind(geo.eye, eyeMaterial, capacity, 'dogs-eye', { fade: true });
  eye.mesh.setColorAt(0, new THREE.Color());
  eye.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const upper = [kind(geo.upper[0], material, cap2, 'dogs-upper-l', { painted: true }), kind(geo.upper[1], material, cap2, 'dogs-upper-r', { painted: true })];
  const lower = [kind(geo.lower[0], material, cap2, 'dogs-lower-l', { painted: true }), kind(geo.lower[1], material, cap2, 'dogs-lower-r', { painted: true })];
  // LOD стопы: у больших псов (масштаб ≥ BIG_FOOT_SCALE) голень с детальной стопой-«ботинком»
  // (robodog-model.js detailedFoot, ~250 треуг. против 80 у шара) — свой вид, пока таких нет — скрыт
  const lowerBig = [kind(geo.lowerDetail[0], material, cap2, 'dogs-lower-big-l', { painted: true }), kind(geo.lowerDetail[1], material, cap2, 'dogs-lower-big-r', { painted: true })];
  for (const k of lowerBig) k.hideEmpty = true;
  const BIG2 = BIG_FOOT_SCALE * BIG_FOOT_SCALE;
  const isBig = (e) => e[0] * e[0] + e[1] * e[1] + e[2] * e[2] >= BIG2;
  const lowerOf = (side, e) => (isBig(e) ? lowerBig[side] : lower[side]);
  // LOD корпуса: у больших — детальный (фаски, решётки, болты, камеры, люк), см. robodog-model.js
  const bodyBig = kind(geo.bodyDetail, material, capacity, 'dogs-body-big', { painted: true });
  bodyBig.hideEmpty = true;
  // LOD бедра: актуатор с кожухом и болтами, фаски, кабель
  const upperBig = [kind(geo.upperDetail[0], material, cap2, 'dogs-upper-big-l', { painted: true }), kind(geo.upperDetail[1], material, cap2, 'dogs-upper-big-r', { painted: true })];
  for (const k of upperBig) k.hideEmpty = true;
  const upperOf = (side, e) => (isBig(e) ? upperBig[side] : upper[side]);
  const tBase = kind(geo.turretBase, material, capacity, 'dogs-turret-base', { painted: true });
  const tGun = kind(geo.turretGun, material, capacity, 'dogs-turret-gun', { painted: true });
  const shadow = kind(shadowGeometry, shadowMaterial, capacity, 'dogs-shadow', { alpha: true });
  shadow.mesh.renderOrder = 1;
  const kinds = [body, bodyBig, eye, upper[0], upper[1], upperBig[0], upperBig[1], lower[0], lower[1], lowerBig[0], lowerBig[1], tBase, tGun, shadow];
  // силуэты для теней по солнцу: та же геометрия и буфер матриц; растворение трупа — и в тени
  const sunShadows = globalThis.__sceneState?.sunShadows ?? null;
  const silhouetteMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false, depthWrite: false });
  silhouetteMaterial.onBeforeCompile = (shader) => injectDissolve(shader, { glow: false });
  silhouetteMaterial.customProgramCacheKey = () => `${PROGRAM_KEY}-silhouette`;
  // дальний каскад (тексель ~30 см): только корпус — ноги тоньше текселя; ноги — в ближнем; башенка
  // лежит в тени корпуса — без своей (каждый силуэт — вызов отрисовки)
  // детальные виды отбрасывают тень простой геометрией: силуэт тот же, треугольников в картах теней —
  // как раньше (своя позиция простой детали + aFade детального вида, свои буферы не заводятся)
  const proxies = [];
  const proxy = (k, simple) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', simple.attributes.position);
    g.setAttribute('aFade', k.mesh.geometry.attributes.aFade);
    g.boundingSphere = simple.boundingSphere;
    proxies.push(g);
    return g;
  };
  const casterKinds = [
    [body, 'both'], [bodyBig, 'both', geo.body],
    [lower[0], 'near'], [lower[1], 'near'], [lowerBig[0], 'near', geo.lower[0]], [lowerBig[1], 'near', geo.lower[1]],
    [upper[0], 'near'], [upper[1], 'near'], [upperBig[0], 'near', geo.upper[0]], [upperBig[1], 'near', geo.upper[1]],
  ];
  const casters = casterKinds.map(([k]) => k.mesh);
  for (const [k, cascades, simple] of casterKinds) sunShadows?.addCaster(k.mesh, { material: silhouetteMaterial, cascades, geometry: simple ? proxy(k, simple) : undefined });
  let contact = 1; // множитель пятна: 1 — без теней по солнцу

  const noGlow = new THREE.Color(0, 0, 0);
  let pa = null;
  let pb = null;
  let em = null;
  let fd = 0; // растворение пса 0…1 (unit.fade)
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
    if (k.fade) k.f[i] = fd;
    k.n += 1;
  };
  const flush = (k) => {
    const mesh = k.mesh;
    mesh.count = k.n;
    if (k.hideEmpty) mesh.visible = k.n > 0; // пустой вид — без вызова отрисовки
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
    if (k.fade) {
      const attr = mesh.geometry.attributes.aFade;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, k.n);
      attr.needsUpdate = true;
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
      return body.n + bodyBig.n;
    },
    begin() {
      for (const k of kinds) k.n = 0;
      contact = sunShadows?.enabled ? CONTACT_ALPHA : 1;
    },
    // пёс с скелетом (unit.model — buildRobodogRig); матрицы шарниров уже посчитаны (collectJoints)
    add(unit) {
      const model = unit.model;
      if (!model.group.visible) return;
      const paint = paints[model.paint] ?? paints[0];
      pa = paint[0];
      pb = paint[1];
      em = model.material.emissive;
      fd = unit.fade ?? 0;
      put(isBig(model.body.matrixWorld.elements) ? bodyBig : body, model.body.matrixWorld.elements);
      if (eye.n < eye.cap) {
        eye.m.set(model.body.matrixWorld.elements, eye.n * 16);
        eye.f[eye.n] = fd;
        eye.mesh.instanceColor.setXYZ(eye.n, model.eyeMaterial.color.r, model.eyeMaterial.color.g, model.eyeMaterial.color.b);
        eye.n += 1;
      }
      const lost = unit.dog?.lost | 0; // отвалившиеся ноги (большие псы) не рисуются
      for (let i = 0; i < 4; i += 1) {
        if (lost & (1 << i)) continue;
        const leg = model.legs[i];
        put(upperOf(leg.side, leg.upper.matrixWorld.elements), leg.upper.matrixWorld.elements);
        put(lowerOf(leg.side, leg.knee.matrixWorld.elements), leg.knee.matrixWorld.elements);
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
        const o = shadow.n * 16;
        shadow.m.set(sh.matrix.elements, o);
        if (contact < 1) {
          // контактная тень: пятно меньше (оси X и Z матрицы)
          for (const j of [0, 1, 2, 8, 9, 10]) shadow.m[o + j] *= CONTACT_SIZE;
        }
        shadow.al[shadow.n] = unit.shadowMaterial.opacity * contact;
        shadow.n += 1;
      }
    },
    // отвалившаяся нога (robodog-leg-debris.js): бедро и голень стороны side, окраска paint, растворение fade
    addLeg(side, paint, fade, upperElements, lowerElements) {
      const p = paints[paint] ?? paints[0];
      pa = p[0];
      pb = p[1];
      em = noGlow;
      fd = fade;
      put(upperOf(side, upperElements), upperElements);
      put(lowerOf(side, lowerElements), lowerElements);
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
      for (const mesh of casters) sunShadows?.removeCaster(mesh);
      silhouetteMaterial.dispose();
      for (const g of proxies) g.dispose(); // общие буферы освобождаются вместе с хозяевами ниже
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
