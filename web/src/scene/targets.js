// Мишени на деревянных стойках, рядами вдаль. Живёт в сцене: правки подхватываются на лету.
//
// Ряды на 5, 10, 17, 26 и 38 м перед игроком, по 3–4 мишени, со сдвигом влево-вправо, чтобы дальние
// не прятались за ближними. Стойка: столб в поперечной доске-основании, передняя лапа, два раскоса и
// брусок-упор сверху, на котором стоит круглая стальная мишень.
//
// Попадание сбивает мишень физикой: импульс вдоль пули в точке попадания (не в центр — закрутило),
// гравитация, удар о землю с отскоком и трением, мишень кувыркается и ложится. Лежащая мишень тоже
// принимает пули: подпрыгивает на пару сантиметров и чуть поворачивается, но не улетает. Мишени
// снова встают, когда их расставляют заново (или после перезагрузки страницы).
//
// Дёшево для Quest (120 Гц, каждый объект рисуется дважды — по глазу): все стойки — один
// InstancedMesh, все мишени — ещё один (один диск, кольца нарисованы в текстуре: plate-texture.js).
//
// Тени. Карт теней в сцене нет, поэтому у ближних рядов (до SHADOW_NEAR м) — плоские проекции: каждая
// стойка и мишень сплющивается на землю вдоль луча солнца (то же солнце, что у теней травы в
// world.js), силуэты рисуются сверху в текстуру (непрозрачно — пересечения не темнее), а квадрат на
// земле умножает землю на эту текстуру. Текстура перерисовывается, только когда что-то движется. У
// дальних рядов — мягкое продолговатое пятно вдоль тени (один InstancedMesh).
//
// Дерево — фотоскан «Rough Wood» с Poly Haven (автор Rob Tuytel, лицензия CC0,
// https://polyhaven.com/a/rough_wood), 1K: web/public/textures/wood/.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIDE_UV, plateTextures } from './plate-texture.js';

const ROWS = [
  // расстояние (м) и направления на мишени от игрока (радианы вбок): все направления разные, с
  // зазорами, поэтому ближние мишени не загораживают дальние
  [5, [-0.36, 0, 0.36]],
  [10, [-0.52, -0.18, 0.18, 0.52]],
  // дальние ряды убраны по просьбе пользователя (были 17, 26 и 38 м):
  // [17, [-0.27, -0.09, 0.09, 0.27]], [26, [-0.45, -0.135, 0.135, 0.45]], [38, [-0.62, -0.225, 0.225]],
];
export const TARGET_LAYOUT = JSON.stringify(ROWS); // поменялась расстановка — мишени встают заново
export const TARGET_COUNT = ROWS.reduce((sum, [, angles]) => sum + angles.length, 0);
const SHADOW_NEAR = 20; // ближе — настоящие проекции, дальше — пятно

const R = 0.3; // радиус мишени, м
const BACK_Z = -0.015; // толщина мишени: диски от BACK_Z до FRONT_Z в её системе
const FRONT_Z = 0.031;
const POST_TOP = 1.05; // верх столба
const CLEAT_H = 0.04; // брусок-упор на столбе
const PLATE_Y = POST_TOP + CLEAT_H + R;
const MAX_HOLES = 120; // пробоин на мишени (старые уходят); было 40
const HOLE_R = 0.019; // радиус пробоины, м (было 0.0075 — пользователю мало видно) (умножается на размер следа 0.8…1.3) // центр мишени над землёй (~1.39 м)

const MASS = 3; // кг
const GRAVITY = 9.81;
const KICK = 2.6; // м/с вдоль пули: сбивает со стойки
const POP = 0.5; // м/с вверх: мишень соскакивает с упора
const SPIN = 0.6; // доля вращения от удара не в центр (полная — слишком бешено крутит)
const NUDGE = 0.12; // лежащая мишень: доля обычного удара
const HOP = 0.6; // лежащая мишень: м/с вверх, не больше (подпрыгивает на ~2 см)
const RESTITUTION = 0.35;
const FRICTION = 0.55;
const SUBSTEP = 1 / 240;

const SUN_AZIMUTH = -8; // как в world.js
const SHADOW_ELEVATION = 22; // как в world.js (солнце для теней травы)
const SHADOW_DARK = 0.3; // линейная яркость тени (на экране ≈ 0.58, как тени травы)
const SHADOW_RES = 1024;

const WOOD_M = 0.5; // текстура дерева покрывает 0.5 × 0.5 м
const WOOD_URL = `${import.meta.env.BASE_URL}textures/wood/rough_wood_`;

// Высота земли — та же формула, что в world.js: в 6 м от центра ровно, дальше пологие холмы.
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const groundAt = (x, z) =>
  smooth(6, 70, Math.hypot(x, z)) *
  (1.2 * Math.sin(x * 0.019) * Math.cos(z * 0.016) + 0.6 * Math.sin(x * 0.052 + z * 0.041) + 0.3 * Math.sin(z * 0.1 - x * 0.07));

// Где встают мишени: ряды вдаль от head по forward. Возвращает [{ x, z, yaw }] (лицом к head).
export function targetSpots(head, forward) {
  const right = { x: -forward.z, z: forward.x };
  const spots = [];
  for (const [distance, angles] of ROWS) {
    for (const angle of angles) {
      const side = distance * Math.tan(angle);
      const x = head.x + forward.x * distance + right.x * side;
      const z = head.z + forward.z * distance + right.z * side;
      spots.push({ x, z, yaw: Math.atan2(head.x - x, head.z - z), near: distance <= SHADOW_NEAR });
    }
  }
  return spots;
}

export function createTargets({ THREE, group, shared, camera }) {
  const count = TARGET_COUNT;
  const disposables = [];
  const keep = (thing) => (disposables.push(thing), thing);

  // ---- дерево: текстуры загружаются один раз на страницу и переживают подмену сцены
  const wood = (shared.woodTextures ??= (() => {
    const loader = new THREE.TextureLoader();
    const load = (name, srgb) => {
      const texture = loader.load(`${WOOD_URL}${name}_1k.jpg`);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8; // уточняется по возможностям GPU, когда появится renderer
      return texture;
    };
    return { map: load('diff', true), normalMap: load('nor_gl', false), roughnessMap: load('rough', false) };
  })());
  const woodMaterial = keep(new THREE.MeshStandardMaterial({
    ...wood,
    color: 0xe8d2b4, // фотоскан серый, выветренный — чуть теплее
    normalScale: new THREE.Vector2(1.2, 1.2),
    metalness: 0,
  }));

  // Брус с UV в метрах: волокна идут вдоль оси `along`, у каждого бруса свой кусок текстуры.
  const AXES = { x: 0, y: 1, z: 2 };
  const woodBox = (w, h, d, along, x, y, z, turnZ = 0) => {
    const geometry = new THREE.BoxGeometry(w, h, d);
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    const grain = AXES[along];
    const du = Math.random();
    const dv = Math.random();
    const p = [0, 0, 0];
    for (let i = 0; i < position.count; i += 1) {
      p[0] = position.getX(i);
      p[1] = position.getY(i);
      p[2] = position.getZ(i);
      const n = [Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i))];
      const facing = n[0] > 0.5 ? 0 : n[1] > 0.5 ? 1 : 2;
      const face = [0, 1, 2].filter((a) => a !== facing);
      const vAxis = face.includes(grain) ? grain : face[1];
      const uAxis = face.find((a) => a !== vAxis);
      uv.setXY(i, p[uAxis] / WOOD_M + du, p[vAxis] / WOOD_M + dv);
    }
    geometry.rotateZ(turnZ);
    geometry.translate(x, y, z);
    return geometry;
  };
  const run = 0.265; // раскосы от основания к столбу
  const rise = 0.4;
  const braceLength = Math.hypot(run, rise);
  const lean = Math.atan2(run, rise);
  const standParts = [
    woodBox(0.07, POST_TOP, 0.07, 'y', 0, POST_TOP / 2, 0), // столб
    woodBox(0.22, CLEAT_H, 0.09, 'x', 0, POST_TOP + CLEAT_H / 2, 0.008), // упор под мишень
    woodBox(0.8, 0.05, 0.12, 'x', 0, 0.025, 0), // доска-основание поперёк
    woodBox(0.1, 0.05, 0.42, 'z', 0, 0.025, 0.27), // передняя лапа к игроку
    woodBox(0.04, braceLength, 0.04, 'y', 0.0355 + run / 2, 0.05 + rise / 2, 0, lean),
    woodBox(0.04, braceLength, 0.04, 'y', -0.0355 - run / 2, 0.05 + rise / 2, 0, -lean),
  ];
  const standGeometry = keep(mergeGeometries(standParts));
  standParts.forEach((part) => part.dispose());
  const standMesh = new THREE.InstancedMesh(standGeometry, woodMaterial, count); // лицом (+Z) к игроку
  standMesh.name = 'target-stands';
  group.add(standMesh);

  // ---- мишени: стальной диск лицом к +Z; кольца, потёртости и ржавчина — в текстуре (plate-texture.js)
  const plateGeometry = keep(new THREE.CylinderGeometry(R, R, FRONT_Z - BACK_Z, 48).rotateX(Math.PI / 2)); // ось вдоль Z
  plateGeometry.translate(0, 0, (FRONT_Z + BACK_Z) / 2);
  {
    // UV: грани — круг, вписанный в текстуру (верх текстуры — верх мишени), обод — серая сталь в углу
    const position = plateGeometry.attributes.position;
    const normal = plateGeometry.attributes.normal;
    const uv = plateGeometry.attributes.uv;
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(normal.getZ(i)) > 0.5) uv.setXY(i, position.getX(i) / (2 * R) + 0.5, position.getY(i) / (2 * R) + 0.5);
      else uv.setXY(i, SIDE_UV, SIDE_UV);
    }
  }
  const plateMaterial = keep(new THREE.MeshStandardMaterial({
    ...plateTextures(THREE, shared),
    metalness: 1, // по карте: краска — нет, сколы — металл
    roughness: 1, // по карте
    normalScale: new THREE.Vector2(0.7, 0.7),
  }));

  // ---- пробоины: настоящие сквозные дырки (сквозь них видно небо и траву). Список дырок каждой
  // мишени — строка маленькой текстуры (x, y в системе мишени, радиус, зерно: знак — с какой стороны
  // вошла пуля); шейдер мишени выбрасывает пиксели внутри рваного круга, вокруг — ободок: со стороны
  // входа тёмный след пули, содранная до металла краска и копоть, с выхода — светлый задранный
  // металл. Текстура обновляется только когда появляется дырка.
  const holeData = new Float32Array(MAX_HOLES * count * 4);
  const holeTexture = keep(new THREE.DataTexture(holeData, MAX_HOLES, count, THREE.RGBAFormat, THREE.FloatType));
  holeTexture.minFilter = holeTexture.magFilter = THREE.NearestFilter;
  holeTexture.generateMipmaps = false;
  holeTexture.needsUpdate = true;
  plateMaterial.customProgramCacheKey = () => `target-holes-2-${MAX_HOLES}`; // номер поднимать при правке шейдера
  plateMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.targetHoles = { value: holeTexture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        flat varying float vHoleRow;
        varying vec3 vPlatePos;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vPlatePos = position;
        #ifdef USE_INSTANCING
          vHoleRow = float(gl_InstanceID);
        #else
          vHoleRow = 0.0;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform highp sampler2D targetHoles;
        flat varying float vHoleRow;
        varying vec3 vPlatePos;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        float holeMetal = 0.0; // содранная краска / задранный металл
        float holeSoot = 0.0;  // копоть
        float holeWipe = 0.0;  // тёмный след пули по краю входа
        {
          int row = int(vHoleRow + 0.5);
          bool front = vPlatePos.z > ${((FRONT_Z + BACK_Z) / 2).toFixed(4)};
          for (int i = 0; i < ${MAX_HOLES}; i++) {
            vec4 h = texelFetch(targetHoles, ivec2(i, row), 0);
            if (h.z <= 0.0) break;
            vec2 d = vPlatePos.xy - h.xy;
            float dist = length(d);
            if (dist > h.z * 3.0) continue;
            float a = atan(d.y, d.x);
            float seed = abs(h.w);
            float jag = 1.0 + 0.1 * sin(a * 7.0 + seed) + 0.06 * sin(a * 13.0 + seed * 2.3) + 0.04 * sin(a * 29.0 + seed * 5.1);
            float rj = h.z * jag;
            if (dist < rj) discard;
            float t = (dist - rj) / h.z;
            bool entry = (h.w > 0.0) == front;
            if (entry) {
              holeWipe = max(holeWipe, 1.0 - smoothstep(0.05, 0.25, t));
              holeMetal = max(holeMetal, 1.0 - smoothstep(0.3, 0.7 + 0.2 * sin(a * 5.0 + seed), t));
              holeSoot = max(holeSoot, 1.0 - smoothstep(0.3, 1.8, t));
            } else {
              holeMetal = max(holeMetal, 1.0 - smoothstep(0.25, 0.75 * jag, t));
              holeSoot = max(holeSoot, (1.0 - smoothstep(0.5, 1.2, t)) * 0.5);
            }
          }
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        diffuseColor.rgb *= 1.0 - 0.7 * holeSoot;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.195, 0.19), holeMetal);
        diffuseColor.rgb *= 1.0 - 0.85 * holeWipe;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.4, holeMetal);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.6, holeMetal);`,
      );
  };
  // Дырки мишени index: список сохранённых следов [x, y, z, поворот, размер] (shooting.js).
  const setHoles = (index, list) => {
    if (index < 0 || index >= count) return;
    const rowStart = index * MAX_HOLES * 4;
    holeData.fill(0, rowStart, rowStart + MAX_HOLES * 4);
    const from = Math.max(0, (list?.length ?? 0) - MAX_HOLES);
    for (let k = from; k < (list?.length ?? 0); k += 1) {
      const [x, y, z, turn, size] = list[k];
      const o = rowStart + (k - from) * 4;
      holeData[o] = x;
      holeData[o + 1] = y;
      holeData[o + 2] = HOLE_R * size;
      holeData[o + 3] = (1 + turn) * (z > (FRONT_Z + BACK_Z) / 2 ? 1 : -1); // знак: вошла спереди
    }
    holeTexture.needsUpdate = true;
  };

  const plateMesh = new THREE.InstancedMesh(plateGeometry, plateMaterial, count);
  plateMesh.name = 'target-plates';
  plateMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(plateMesh);

  // ---- прицел: белый контур у мишени, в которую сейчас смотрит ствол (её задаёт aim из shooting.js).
  // Появляется за OUTLINE_IN, уходит за OUTLINE_OUT, когда ствол ушёл; после попадания гаснет за
  // OUTLINE_S и на это время не загорается (мишень падает). Контур — та же мишень чуть крупнее,
  // вывернутая (видны задние грани только по краю). Все контуры — один InstancedMesh: яркость задаёт
  // цвет экземпляра при сложении цветов (чёрный — не виден), толщина растёт с расстоянием, чтобы и на
  // 38 м было ~2 пикселя.
  const OUTLINE_S = 0.4;
  const OUTLINE_IN = 0.06;
  const OUTLINE_OUT = 0.1;
  const OUTLINE_RAD = 0.0022; // угловая толщина контура (~2 пикселя в шлеме)
  const outlineMaterial = keep(new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  }));
  const outlineMesh = new THREE.InstancedMesh(plateGeometry, outlineMaterial, count);
  outlineMesh.name = 'target-outlines';
  outlineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  outlineMesh.frustumCulled = false;
  outlineMesh.visible = false;
  const black = new THREE.Color(0, 0, 0);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < count; i += 1) {
    outlineMesh.setColorAt(i, black); // цвет экземпляров есть сразу: шейдер не пересобирается при первом попадании
    outlineMesh.setMatrixAt(i, zero);
  }
  group.add(outlineMesh);
  const outlineLevel = new Float32Array(count); // яркость контура 0…1
  const hitLeft = new Float32Array(count); // после попадания: сколько секунд ещё гаснет
  const hitFrom = new Float32Array(count); // яркость в момент попадания
  let aimed = -1; // в какую мишень смотрит ствол (-1 — ни в какую)

  // Мишень для остального кода — пустой объект на месте диска: к нему крепятся следы от пуль, его
  // матрица задаёт экземпляр в plateMesh.
  const stands = [];
  const plates = [];
  for (let i = 0; i < count; i += 1) {
    const stand = new THREE.Object3D();
    group.add(stand);
    stands.push(stand);
    const plate = new THREE.Object3D();
    group.add(plate);
    plates.push(plate);
  }

  // ---- физика: состояние живёт в shared, чтобы полёт продолжился после подмены сцены
  const newBody = () => ({
    fallen: false,
    awake: false,
    p: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    v: new THREE.Vector3(),
    w: new THREE.Vector3(),
    still: 0,
    age: 0,
  });
  let bodies = shared.targetBodies;
  if (!Array.isArray(bodies) || bodies.length !== count) bodies = shared.targetBodies = plates.map(newBody);

  // Обод диска (обе грани) — точки касания с землёй.
  const RIM = [];
  for (let k = 0; k < 16; k += 1) {
    const angle = (k / 16) * Math.PI * 2;
    RIM.push(new THREE.Vector3(Math.cos(angle) * R, Math.sin(angle) * R, BACK_Z));
    RIM.push(new THREE.Vector3(Math.cos(angle) * R, Math.sin(angle) * R, FRONT_Z));
  }
  const thick = FRONT_Z - BACK_Z;
  const INV_I = new THREE.Vector3(
    1 / (MASS * ((R * R) / 4 + (thick * thick) / 12)),
    1 / (MASS * ((R * R) / 4 + (thick * thick) / 12)),
    1 / ((MASS * R * R) / 2),
  ); // обратный тензор инерции диска в его осях (ось Z — нормаль)
  const qInv = new THREE.Quaternion();
  const applyInvI = (body, vector, out) => {
    qInv.copy(body.q).invert();
    return out.copy(vector).applyQuaternion(qInv).multiply(INV_I).applyQuaternion(body.q);
  };
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const applyImpulse = (body, r, impulse, spin = 1) => {
    body.v.addScaledVector(impulse, 1 / MASS);
    body.w.addScaledVector(applyInvI(body, tmpA.crossVectors(r, impulse), tmpB), spin);
  };
  // эффективная масса в точке r вдоль направления n
  const tmpC = new THREE.Vector3();
  const tmpD = new THREE.Vector3();
  const pointMass = (body, r, n) => {
    applyInvI(body, tmpC.crossVectors(r, n), tmpD);
    return 1 / MASS + tmpC.crossVectors(tmpD, r).dot(n);
  };

  const UP = new THREE.Vector3(0, 1, 0);
  const spin = new THREE.Quaternion();
  const point = new THREE.Vector3();
  const r = new THREE.Vector3();
  const u = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const impulse = new THREE.Vector3();

  const step = (body, h) => {
    body.age += h;
    body.v.y -= GRAVITY * h;
    body.p.addScaledVector(body.v, h);
    spin.set(body.w.x, body.w.y, body.w.z, 0).multiply(body.q);
    body.q.x += 0.5 * h * spin.x;
    body.q.y += 0.5 * h * spin.y;
    body.q.z += 0.5 * h * spin.z;
    body.q.w += 0.5 * h * spin.w;
    body.q.normalize();
    const ground = groundAt(body.p.x, body.p.z); // наклон земли под мишенью не учитывается

    // выталкиваем из земли на самую глубокую точку
    let deepest = 0;
    for (const local of RIM) {
      point.copy(local).applyQuaternion(body.q).add(body.p);
      deepest = Math.max(deepest, ground - point.y);
    }
    if (deepest > 0) body.p.y += deepest;

    let touching = false;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (const local of RIM) {
        r.copy(local).applyQuaternion(body.q);
        if (body.p.y + r.y > ground + 0.002) continue;
        touching = true;
        u.crossVectors(body.w, r).add(body.v);
        const vn = u.y;
        if (vn >= 0) continue;
        const bounce = iteration === 0 && vn < -0.8 ? RESTITUTION : 0;
        const jn = (-(1 + bounce) * vn) / pointMass(body, r, UP);
        applyImpulse(body, r, impulse.set(0, jn, 0));
        // трение: гасим скольжение точки, не больше FRICTION · jn
        u.crossVectors(body.w, r).add(body.v);
        u.y = 0;
        const slide = u.length();
        if (slide > 1e-5) {
          dir.copy(u).divideScalar(-slide);
          const jt = Math.min(slide / pointMass(body, r, dir), FRICTION * jn);
          applyImpulse(body, r, impulse.copy(dir).multiplyScalar(jt));
        }
      }
    }
    if (touching) {
      // трава: гасит качение и скольжение, мишень не укатывается колесом по полю
      body.w.multiplyScalar(1 - 6 * h);
      body.v.x *= 1 - 3 * h;
      body.v.z *= 1 - 3 * h;
      const resting = body.v.length() < 0.06 && body.w.length() < 0.3;
      body.still = resting ? body.still + h : 0;
    }
    if (body.still > 0.4 || body.age > 12) {
      body.awake = false;
      body.v.set(0, 0, 0);
      body.w.set(0, 0, 0);
    }
  };

  // ---- тени ближних рядов: проекции в текстуру
  const sun = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - SHADOW_ELEVATION),
    THREE.MathUtils.degToRad(90 + SUN_AZIMUTH),
  );
  const slopeX = sun.x / sun.y;
  const slopeZ = sun.z / sun.y;
  const flatten = (ground, out) =>
    out.set(1, -slopeX, 0, slopeX * ground, 0, 0, 0, ground, 0, -slopeZ, 1, slopeZ * ground, 0, 0, 0, 1);

  const shadowScene = new THREE.Scene();
  shadowScene.background = new THREE.Color(1, 1, 1);
  const silhouetteMaterial = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(SHADOW_DARK), side: THREE.DoubleSide }));
  const casters = []; // [объект, его тень, номер мишени]; только ближние ряды
  const shadowTarget = keep(new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES, { depthBuffer: false }));
  const shadowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
  shadowCamera.up.set(0, 0, -1); // верх текстуры — к −Z, как у квадрата на земле
  const multiply = (map) =>
    keep(new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      premultipliedAlpha: true,
      blending: THREE.MultiplyBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
  const flatPlane = keep(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  // квадрат-приёмник повторяет рельеф (за 6 м от центра земля волнистая)
  const receiverGeometry = keep(new THREE.PlaneGeometry(1, 1, 48, 48).rotateX(-Math.PI / 2));
  const receiverBase = receiverGeometry.attributes.position.array.slice();
  const shadowQuad = new THREE.Mesh(receiverGeometry, multiply(shadowTarget.texture));
  shadowQuad.frustumCulled = false;
  shadowQuad.renderOrder = -1; // раньше прочих прозрачных (следы, эффекты)
  shadowQuad.visible = false;
  group.add(shadowQuad);

  // ---- тени дальних рядов: мягкое продолговатое пятно вдоль тени
  const blobCanvas = document.createElement('canvas');
  blobCanvas.width = blobCanvas.height = 64;
  const bg = blobCanvas.getContext('2d');
  const blobGradient = bg.createRadialGradient(32, 32, 0, 32, 32, 32);
  const dark = Math.round(255 * 0.45); // линейная яркость в середине (на экране ≈ 0.7)
  blobGradient.addColorStop(0, `rgb(${dark},${dark},${dark})`);
  blobGradient.addColorStop(0.55, `rgb(${Math.round((dark + 255) / 2)},${Math.round((dark + 255) / 2)},${Math.round((dark + 255) / 2)})`);
  blobGradient.addColorStop(1, 'rgb(255,255,255)');
  bg.fillStyle = blobGradient;
  bg.fillRect(0, 0, 64, 64);
  const blobTexture = keep(new THREE.CanvasTexture(blobCanvas)); // без перевода цвета: значения как есть
  const farCount = count; // с запасом: сколько дальних — решает расстановка
  const blobMesh = new THREE.InstancedMesh(flatPlane, multiply(blobTexture), farCount);
  blobMesh.count = 0;
  blobMesh.renderOrder = -1;
  blobMesh.frustumCulled = false;
  group.add(blobMesh);

  // renderer в сцену стрельбы не передаётся: берём его из первого кадра, в котором рисуется квадрат
  let renderer = null;
  shadowQuad.onBeforeRender = (r) => {
    if (renderer) return;
    renderer = r;
    const max = r.capabilities.getMaxAnisotropy();
    for (const texture of Object.values(wood)) {
      if (texture.anisotropy === max) continue;
      texture.anisotropy = max;
      if (texture.image) texture.needsUpdate = true;
    }
  };

  let shadowsDirty = true;
  let platesDirty = true;
  const shadowMatrix = new THREE.Matrix4();
  const standGround = [];
  const near = [];

  // Область проекций: ближние стойки с их тенями и запас на отлетевшие мишени.
  const fitShadowArea = () => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let groundSum = 0;
    let n = 0;
    stands.forEach((stand, index) => {
      if (!near[index]) return;
      const { x, z } = stand.position;
      const tipX = x - slopeX * (PLATE_Y + R);
      const tipZ = z - slopeZ * (PLATE_Y + R);
      minX = Math.min(minX, x, tipX);
      maxX = Math.max(maxX, x, tipX);
      minZ = Math.min(minZ, z, tipZ);
      maxZ = Math.max(maxZ, z, tipZ);
      groundSum += stand.position.y;
      n += 1;
    });
    shadowQuad.visible = n > 0;
    if (!n) return;
    const pad = 2;
    const size = Math.max(maxX - minX, maxZ - minZ) + pad * 2;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const ground = groundSum / n;
    shadowCamera.left = shadowCamera.bottom = -size / 2;
    shadowCamera.right = shadowCamera.top = size / 2;
    shadowCamera.updateProjectionMatrix();
    shadowCamera.position.set(cx, ground + 30, cz);
    shadowCamera.lookAt(cx, ground, cz);
    shadowCamera.updateMatrixWorld(true);
    const position = receiverGeometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const x = cx + receiverBase[i * 3] * size;
      const z = cz + receiverBase[i * 3 + 2] * size;
      position.setXYZ(i, x, groundAt(x, z) + 0.004, z);
    }
    position.needsUpdate = true;
    receiverGeometry.computeBoundingSphere();
    shadowsDirty = true;
  };

  const casterMatrix = new THREE.Matrix4();
  const drawShadows = () => {
    for (const [object, proxy, index] of casters) {
      flatten(standGround[index] ?? 0, shadowMatrix);
      casterMatrix.multiplyMatrices(group.matrixWorld, object.matrix);
      proxy.matrix.multiplyMatrices(shadowMatrix, casterMatrix);
    }
    const xrEnabled = renderer.xr.enabled;
    const previous = renderer.getRenderTarget();
    renderer.xr.enabled = false; // в текстуру, а не в шлем
    renderer.setRenderTarget(shadowTarget);
    renderer.render(shadowScene, shadowCamera);
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xrEnabled;
    shadowsDirty = false;
  };

  const mountPlate = (index) => {
    const plate = plates[index];
    const body = bodies[index];
    if (body.fallen) {
      plate.position.copy(body.p);
      plate.quaternion.copy(body.q);
    } else {
      plate.position.set(0, PLATE_Y, 0).applyMatrix4(stands[index].matrix); // стойка и мишень — в одной группе
      plate.quaternion.copy(stands[index].quaternion);
    }
    plate.updateMatrix();
    plate.updateMatrixWorld(true);
    plateMesh.setMatrixAt(index, plate.matrix);
    platesDirty = true;
  };

  const blobSpot = new THREE.Vector3();
  const blobNormal = new THREE.Vector3();
  const blobTurn = new THREE.Quaternion();
  const blobTilt = new THREE.Quaternion();
  const blobScale = new THREE.Vector3(0.7, 1, 0);
  const blobMatrix = new THREE.Matrix4();
  const shadowLength = PLATE_Y + R; // высота верха мишени
  const shadowAlong = Math.hypot(slopeX, slopeZ) * shadowLength; // длина тени по земле
  const shadowYaw = Math.atan2(-slopeX, -slopeZ); // куда ложится тень

  const head = new THREE.Vector3();
  const outlineColor = new THREE.Color();
  const outlineMatrix = new THREE.Matrix4();
  const grow = new THREE.Matrix4();
  const outlineShown = new Uint8Array(count);
  const updateOutlines = (dt) => {
    let any = false;
    let changed = false;
    camera?.getWorldPosition(head);
    for (let i = 0; i < count; i += 1) {
      let left;
      if (hitLeft[i] > 0) {
        hitLeft[i] = Math.max(0, hitLeft[i] - dt);
        const t = hitLeft[i] / OUTLINE_S;
        left = outlineLevel[i] = hitFrom[i] * t * t * (3 - 2 * t); // плавно гаснет
      } else if (i === aimed) {
        left = outlineLevel[i] = Math.min(1, outlineLevel[i] + dt / OUTLINE_IN);
      } else {
        left = outlineLevel[i] = Math.max(0, outlineLevel[i] - dt / OUTLINE_OUT);
      }
      if (left <= 0 && !outlineShown[i]) continue;
      changed = true;
      outlineShown[i] = left > 0 ? 1 : 0;
      if (left > 0) {
        const plate = plates[i];
        const distance = camera ? head.distanceTo(plate.getWorldPosition(point)) : 5;
        const thickness = Math.max(0.006, distance * OUTLINE_RAD);
        const k = 1 + thickness / R;
        grow.makeScale(k, k, 1 + (2 * thickness) / (FRONT_Z - BACK_Z));
        grow.multiply(outlineMatrix.makeTranslation(0, 0, -(FRONT_Z + BACK_Z) / 2)); // раздуваем от центра диска
        grow.premultiply(outlineMatrix.makeTranslation(0, 0, (FRONT_Z + BACK_Z) / 2));
        outlineMesh.setMatrixAt(i, outlineMatrix.multiplyMatrices(plate.matrix, grow));
        outlineMesh.setColorAt(i, outlineColor.setScalar(left));
        any = true;
      } else {
        outlineMesh.setMatrixAt(i, zero);
        outlineMesh.setColorAt(i, black);
      }
    }
    if (changed) {
      outlineMesh.instanceMatrix.needsUpdate = true;
      outlineMesh.instanceColor.needsUpdate = true;
    }
    outlineMesh.visible = any;
  };

  const inverse = new THREE.Matrix4();
  return {
    plates,
    setHoles,
    plateMesh,
    standMesh,
    // spots: [{ x, z, yaw, near }] — где стоят стойки (yaw: куда смотрит лицо мишени, near: тень —
    // проекция, иначе пятно). resetFallen: поднять сбитые.
    place(spots, { resetFallen = false } = {}) {
      for (const [, proxy] of casters) shadowScene.remove(proxy);
      casters.length = 0;
      blobMesh.count = 0;
      stands.forEach((stand, index) => {
        const { x, z, yaw } = spots[index];
        near[index] = spots[index].near ?? true;
        const y = groundAt(x, z);
        standGround[index] = y;
        stand.position.set(x, y, z);
        stand.rotation.set(0, yaw, 0);
        stand.updateMatrix();
        stand.updateMatrixWorld(true);
        standMesh.setMatrixAt(index, stand.matrix);
        if (resetFallen) Object.assign(bodies[index], newBody());
        mountPlate(index);
        if (near[index]) {
          for (const [object, geometry] of [[stand, standGeometry], [plates[index], plateGeometry]]) {
            const proxy = new THREE.Mesh(geometry, silhouetteMaterial);
            proxy.matrixAutoUpdate = false;
            proxy.frustumCulled = false;
            shadowScene.add(proxy);
            casters.push([object, proxy, index]);
          }
        } else {
          // пятно: от стойки вдоль тени, по наклону земли
          blobSpot.set(x + Math.sin(shadowYaw) * shadowAlong * 0.55, 0, z + Math.cos(shadowYaw) * shadowAlong * 0.55);
          const e = 0.3;
          blobNormal.set(
            groundAt(blobSpot.x - e, blobSpot.z) - groundAt(blobSpot.x + e, blobSpot.z),
            2 * e,
            groundAt(blobSpot.x, blobSpot.z - e) - groundAt(blobSpot.x, blobSpot.z + e),
          ).normalize();
          blobSpot.y = groundAt(blobSpot.x, blobSpot.z) + 0.05;
          blobTurn.setFromAxisAngle(UP, shadowYaw);
          blobTilt.setFromUnitVectors(UP, blobNormal).multiply(blobTurn);
          blobScale.z = shadowAlong * 1.25;
          blobMatrix.compose(blobSpot, blobTilt, blobScale);
          blobMesh.setMatrixAt(blobMesh.count, blobMatrix);
          blobMesh.count += 1;
        }
      });
      standMesh.instanceMatrix.needsUpdate = true;
      standMesh.computeBoundingSphere();
      blobMesh.instanceMatrix.needsUpdate = true;
      fitShadowArea();
    },
    // Попадание: worldPoint — куда попала пуля, direction — направление пули (мировые). Стоящую мишень
    // сбивает со стойки, лежащую чуть подбрасывает.
    knock(plate, worldPoint, direction) {
      const index = plates.indexOf(plate);
      if (index < 0) return false;
      const body = bodies[index];
      inverse.copy(group.matrixWorld).invert();
      const local = group.worldToLocal(worldPoint.clone());
      const along = direction.clone().transformDirection(inverse);
      const lying = body.fallen;
      hitLeft[index] = OUTLINE_S; // контур прицела гаснет
      hitFrom[index] = outlineLevel[index];
      if (shared.targetPhysics === false) return true; // физика выкл: мишень не сбивается и не подпрыгивает
      if (!lying) {
        Object.assign(body, newBody(), { fallen: true });
        body.p.copy(plate.position);
        body.q.copy(plate.quaternion);
      }
      body.awake = true;
      body.still = 0;
      body.age = 0;
      const strength = lying ? NUDGE : 1;
      impulse.copy(along).multiplyScalar(MASS * KICK * strength);
      impulse.y = lying ? Math.abs(impulse.y) + MASS * 0.25 : impulse.y + MASS * POP; // лежащая подпрыгивает, а не вдавливается
      r.subVectors(local, body.p);
      applyImpulse(body, r, impulse, SPIN);
      if (lying) body.v.y = Math.min(body.v.y, HOP);
      shadowsDirty = true;
      return true;
    },
    // Сцены (compositions.js): стоит мишень или лежит и где — [{ fallen, p, q }] по номерам мишеней.
    getBodies() {
      return bodies.map((body) => ({ fallen: body.fallen, p: body.p.toArray(), q: body.q.toArray() }));
    },
    setBodies(saved) {
      bodies.forEach((body, index) => {
        Object.assign(body, newBody());
        const pose = saved?.[index];
        if (pose?.fallen && pose.p && pose.q) {
          body.fallen = true;
          body.p.fromArray(pose.p);
          body.q.fromArray(pose.q);
        }
        mountPlate(index);
      });
      aimed = -1;
      shadowsDirty = true;
    },
    // Куда смотрит ствол: мишень (объект из plates) или null.
    setAim(plate) {
      aimed = plate && shared.aimOutline !== false ? plates.indexOf(plate) : -1;
    },
    update(dt) {
      const h = Math.min(dt, 0.05);
      bodies.forEach((body, index) => {
        if (!body.awake) return;
        const steps = Math.max(1, Math.ceil(h / SUBSTEP));
        for (let s = 0; s < steps && body.awake; s += 1) step(body, h / steps);
        mountPlate(index);
        if (near[index]) shadowsDirty = true;
      });
      if (platesDirty) {
        plateMesh.instanceMatrix.needsUpdate = true;
        plateMesh.computeBoundingSphere(); // по ней лучи и отсечение
        platesDirty = false;
      }
      updateOutlines(h); // после физики: контур идёт вместе с мишенью
      if (shadowsDirty && renderer && shadowQuad.visible) drawShadows();
    },
    dispose() {
      // текстуры дерева общие (shared.woodTextures) — их не освобождаем
      for (const thing of disposables) thing.dispose();
      for (const mesh of [standMesh, plateMesh, blobMesh, outlineMesh]) mesh.dispose();
    },
  };
}
