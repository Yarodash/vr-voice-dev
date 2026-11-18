// Робопёс: low-poly модель в духе Boston Dynamics Spot (~0,9 м длиной, ~0,6 м в холке сзади).
// Жёлтый корпус с чёрной рамой, спереди сенсорная голова с голубой светящейся полосой «глаз»,
// четыре ноги: тазовый узел → бедро → колено → голень со стопой. Скиннинга нет: каждая часть —
// свой шарнир (Object3D), неподвижные детали слиты в один меш на шарнир. Итого 10 вызовов отрисовки.
//
// Металл: один материал на всё тело (MeshStandardMaterial). Цвет краски — в вершинах, а атлас
// текстур (makeDogTextures) делит деталь на три вида по uv: окрашенный металл (атласная краска,
// заметный блик, по краям граней панельные швы, болты и потёртости до голого металла), голая тёмная
// сталь (шарниры, рейки, голени — шлифовка) и резина (стопы). Карта окружения — общая с оружием
// (weapon-env.js), envMapIntensity 0.5. Глаза — свой светящийся материал.
//
// Система: вперёд −Z, вправо +X, вверх +Y. buildRobodog(THREE, { textures, env }) → { group, body,
// eye, material, eyeMaterial, legs: [{ hip, upper, knee }] ×4 (ЛП, ПП, ЛЗ, ПЗ), setPose(pose),
// dispose() }; pose — как из createGait (robodog-gait.js).
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HIPS, L1, L2, FOOT_R } from './robodog-gait.js';

const YELLOW = 0xf2b807;
const BLACK = 0x1b1c1f;
const STEEL = 0x6a7078; // голый металл (цвет умножается на текстуру стали)
const RUBBER = 0x141416;
// Окраски (стая: у каждого пса своя): [кожух вместо жёлтого, рама/голова вместо чёрной]. Меняются
// цвета вершин (setPaint) — тот же материал и шейдер, атлас не перерисовывается.
export const DOG_PAINTS = [
  [YELLOW, BLACK], // предупреждающая жёлто-чёрная (как была)
  [0x5d6332, 0xa88f60], // армейская: олива и песок
  [0xe4e7ea, 0x5f666e], // арктическая: белая и серая
  [0xb81d1a, 0x161618], // красно-чёрная
  [0x1d4bb0, 0xe9ecef], // полицейская: синяя и белая
  [0xc0601c, 0x4a2b1a], // ржавая: оранжевая и бурая
  [0x2c9a4c, 0xe6ebe7], // 6 — союзники (стая): зелёная и белая, только у них
  // 7–11 — тоже только союзники (по просьбе: «у нас тоже разные»), все в зелёной гамме — свои узнаются
  [0x1f8f86, 0xe6ebe7], // 7 бирюзовая и белая
  [0x3e5a2a, 0xc9b98a], // 8 лесная: тёмно-зелёная и песок
  [0x7cc242, 0x1b1d1f], // 9 лаймовая и чёрная
  [0x0f6b4a, 0xd8b04a], // 10 изумрудная и золотая
  [0x9fd9b8, 0x3a4048], // 11 мятная и графит
];
// где в атласе вид металла: [u0, v0, du, dv]
const REGION = { paint: [0, 0, 0.5, 1], steel: [0.5, 0.5, 0.5, 0.5], rubber: [0.5, 0, 0.5, 0.5] };

// мягкое тёмное пятно для тени под псом (одна текстура на всех псов)
export function makeShadowTexture(THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  // плавный спад без «полки» и края (раньше читалось как диск, на котором стоит пёс)
  for (let i = 0; i <= 8; i += 1) {
    const r = i / 8;
    grad.addColorStop(r, `rgba(0,0,0,${(0.5 * Math.exp(-3.2 * r * r) * (1 - r * r)).toFixed(3)})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

// Атлас 256×128: слева (u 0..0.5) окрашенная панель — на каждую грань детали целиком; справа сверху
// сталь, справа снизу резина. color — что умножается на цвет вершин; orm — шероховатость (G) и
// металличность (B), как ждёт three.js. Одни текстуры на всех псов (dispose — у хозяина).
export function makeDogTextures(THREE) {
  const W = 256;
  const H = 128;
  const color = document.createElement('canvas');
  const orm = document.createElement('canvas');
  color.width = orm.width = W;
  color.height = orm.height = H;
  const c = color.getContext('2d');
  const o = orm.getContext('2d');
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ormRGB = (rough, metal) => `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

  // ---- окрашенная панель (0..128 по x)
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, 128, 128);
  o.fillStyle = ormRGB(0.42, 0.62); // атласная краска по металлу
  o.fillRect(0, 0, 128, 128);
  // лёгкая неровность краски
  for (let i = 0; i < 260; i += 1) {
    const x = rnd(0, 128);
    const y = rnd(0, 128);
    const k = rnd(232, 255) | 0;
    c.fillStyle = `rgb(${k},${k},${k})`;
    c.fillRect(x, y, rnd(2, 6), rnd(2, 6));
  }
  // потёртости по краям: краска стёрта до металла — темнее по цвету, блестит
  for (let i = 0; i < 140; i += 1) {
    const side = Math.floor(Math.random() * 4);
    const t = rnd(0, 128);
    const d = rnd(0, 7) ** 1.4;
    const x = side === 0 ? d : side === 1 ? 127 - d : t;
    const y = side === 2 ? d : side === 3 ? 127 - d : t;
    const w = rnd(1, 5);
    const h = rnd(1, 3);
    const k = rnd(120, 175) | 0;
    c.fillStyle = `rgb(${k},${k},${k})`;
    c.fillRect(x, y, w, h);
    o.fillStyle = ormRGB(0.28, 0.95);
    o.fillRect(x, y, w, h);
  }
  // панельный шов у края грани
  c.strokeStyle = 'rgba(40,40,40,0.85)';
  c.lineWidth = 2;
  c.strokeRect(7, 7, 114, 114);
  o.strokeStyle = ormRGB(0.75, 0.3);
  o.lineWidth = 2;
  o.strokeRect(7, 7, 114, 114);
  // болты по углам: тёмная шляпка с бликом, голый металл
  for (const [x, y] of [[14, 14], [114, 14], [14, 114], [114, 114], [64, 14], [64, 114]]) {
    c.fillStyle = '#5a5a5a';
    c.beginPath();
    c.arc(x, y, 3.2, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#d8d8d8';
    c.beginPath();
    c.arc(x - 0.8, y - 0.8, 1.1, 0, Math.PI * 2);
    c.fill();
    o.fillStyle = ormRGB(0.3, 0.95);
    o.beginPath();
    o.arc(x, y, 3.2, 0, Math.PI * 2);
    o.fill();
  }

  // ---- сталь (128..256 по x, 0..64 по y на холсте = v 0.5..1): шлифовка вдоль детали
  c.fillStyle = '#b8bcc2';
  c.fillRect(128, 0, 128, 64);
  o.fillStyle = ormRGB(0.36, 0.85);
  o.fillRect(128, 0, 128, 64);
  for (let i = 0; i < 90; i += 1) {
    const x = rnd(128, 256);
    const k = rnd(150, 230) | 0;
    c.fillStyle = `rgb(${k},${k},${k + 4})`;
    c.fillRect(x, 0, rnd(0.5, 2), 64);
    o.fillStyle = ormRGB(rnd(0.28, 0.46), 0.85);
    o.fillRect(x, 0, rnd(0.5, 2), 64);
  }
  // ---- резина (128..256, y 64..128 = v 0..0.5)
  c.fillStyle = '#ffffff';
  c.fillRect(128, 64, 128, 64);
  o.fillStyle = ormRGB(0.92, 0);
  o.fillRect(128, 64, 128, 64);

  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  const ormMap = new THREE.CanvasTexture(orm);
  for (const t of [map, ormMap]) {
    t.anisotropy = 4;
    t.generateMipmaps = true;
  }
  return {
    map,
    orm: ormMap,
    dispose() {
      map.dispose();
      ormMap.dispose();
    },
  };
}

// Растворение трупа (вместо ухода под землю): материал остаётся непрозрачным, фрагменты отбрасываются
// (discard) по порогу fade 0…1 — 3D-шум в координатах детали (не плывёт вместе с телом, крупнее у
// больших псов) + байерова сетка 4×4 по экрану (рябь «полупрозрачности»), у кромки — голубое свечение.
// Без прозрачных материалов: ни сортировки, ни depthWrite, программа одна на весь бой.
// injectDissolve(shader, { source: 'attribute' | 'uniform', glow }) — в onBeforeCompile:
//   attribute — у экземпляра атрибут aFade (robodog-instances.js); uniform — uDogFade (один пёс, ниже).
const DISSOLVE_FN = `
float dogHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float dogNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dogHash(i), dogHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(dogHash(i + vec3(0.0, 1.0, 0.0)), dogHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(dogHash(i + vec3(0.0, 0.0, 1.0)), dogHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(dogHash(i + vec3(0.0, 1.0, 1.0)), dogHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float dogBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float dogBayer4(vec2 a) { return dogBayer2(0.5 * a) * 0.25 + dogBayer2(a); }
`;
export function injectDissolve(shader, { source = 'attribute', glow = true } = {}) {
  const input = source === 'uniform' ? 'uniform float uDogFade;' : 'attribute float aFade;';
  const value = source === 'uniform' ? 'uDogFade' : 'aFade';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${input}\nvarying float vDogFade;\nvarying vec3 vDogP;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n\tvDogFade = ${value};\n\tvDogP = position;`);
  const cut = `
\tif (vDogFade > 0.0) {
\t\tfloat dv = clamp((dogNoise(vDogP * 26.0) - 0.2) * 1.67, 0.0, 1.0) * 0.72 + dogBayer4(gl_FragCoord.xy) * 0.28; // шум растянут: исчезает равномерно
\t\tif (dv < vDogFade) discard;
${glow ? '\t\ttotalEmissiveRadiance += vec3(0.12, 0.3, 0.7) * smoothstep(vDogFade + 0.05, vDogFade, dv) * (1.0 - vDogFade);\n' : ''}\t}`;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying float vDogFade;\nvarying vec3 vDogP;\n${DISSOLVE_FN}`)
    .replace(glow ? '#include <emissivemap_fragment>' : '#include <alphamap_fragment>', (m) => `${m}${cut}`);
}

// Скелет без мешей (стая: псов рисует robodog-instances.js экземплярами, по вызову отрисовки на вид
// детали для всех псов). Те же шарниры и setPose, что у buildRobodog; материалы — заглушки с полями,
// которые читает robodog-unit.js (вспышка, глаза), окраска — номер. В сцену не добавляется: матрицы
// считает хозяин (updateMatrixWorld), корень мира — единичный.
export function buildRobodogRig(THREE) {
  const group = new THREE.Group();
  group.name = 'robodog-rig';
  const body = new THREE.Object3D();
  group.add(body);
  const legs = HIPS.map(([x, y, z]) => {
    const hip = new THREE.Object3D();
    hip.position.set(x, y, z);
    body.add(hip);
    const upper = new THREE.Object3D();
    hip.add(upper);
    const knee = new THREE.Object3D();
    knee.position.set(0, -L1, 0);
    upper.add(knee);
    return { hip, upper, knee, side: x < 0 ? 0 : 1 };
  });
  const tYaw = new THREE.Object3D();
  tYaw.position.set(0, 0.112, 0.04);
  tYaw.visible = false;
  body.add(tYaw);
  const tPitch = new THREE.Object3D();
  tPitch.position.set(0, 0.07, 0);
  tYaw.add(tPitch);
  const tMuzzle = new THREE.Object3D();
  tMuzzle.position.set(0, 0.004, -0.225);
  tPitch.add(tMuzzle);
  const rig = {
    group,
    body,
    legs,
    rig: true,
    paint: 0,
    material: { emissive: new THREE.Color(0, 0, 0), dispose() {} },
    eyeMaterial: { color: new THREE.Color(0x45e8ff), dispose() {} },
    turret: { yaw: tYaw, pitch: tPitch, muzzle: tMuzzle, pivotY: tPitch.position.y },
    setPaint(index) {
      rig.paint = ((Math.floor(index) % DOG_PAINTS.length) + DOG_PAINTS.length) % DOG_PAINTS.length || 0;
    },
    setPose(pose) {
      body.position.set(pose.x, pose.y, 0);
      body.rotation.set(pose.pitch, pose.yaw ?? 0, pose.roll);
      for (let i = 0; i < 4; i += 1) {
        const leg = legs[i];
        const a = pose.legs[i];
        leg.hip.rotation.set(0, 0, a.abd);
        leg.upper.rotation.set(a.hip, 0, 0);
        leg.knee.rotation.set(a.knee, 0, 0);
      }
    },
    dispose() {
      group.removeFromParent();
    },
  };
  return rig;
}

export function buildRobodog(THREE, { textures = null, env = null } = {}) {
  const color = new THREE.Color();
  // деталь: геометрия без индексов, uv — в свою область атласа, цвет — в вершинах
  const part = (hex, geometry, list, region = 'paint') => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    const [u0, v0, du, dv] = REGION[region];
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, u0 + uv.getX(i) * du, v0 + uv.getY(i) * dv);
    color.set(hex); // sRGB → линейный (рабочее пространство three.js)
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.clearGroups();
    list.push(g);
    return g;
  };
  const box = (hex, list, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0, region = 'paint') => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return part(hex, g, list, region);
  };
  const steelBox = (list, w, h, d, x, y, z) => box(STEEL, list, w, h, d, x, y, z, 0, 0, 0, 'steel');
  // цилиндр-шарнир вдоль оси X (голая сталь)
  const joint = (list, r, len, x, y, z) => {
    const g = new THREE.CylinderGeometry(r, r, len, 10);
    g.rotateZ(Math.PI / 2);
    g.translate(x, y, z);
    return part(STEEL, g, list, 'steel');
  };
  // тело вращения вокруг Y без индексов и без вырожденных треугольников у полюсов: profile — [r, y],
  // segs граней; sx/sz — растяжение по X/Z (восьмигранник → прямоугольник с фасками), phase — поворот,
  // lug(i, j) — множитель радиуса вершины (протектор: рёбра через одну)
  const revolve = (profile, segs, { sx = 1, sz = 1, phase = 0, lug = null } = {}) => {
    const pos = [];
    const uvs = [];
    const at = (i, j) => {
      const [r0, y] = profile[i];
      const r = r0 * (lug ? lug(i, j) : 1);
      const a = phase + (j / segs) * Math.PI * 2;
      return [r * sx * Math.cos(a), y, -r * sz * Math.sin(a), j / segs, i / (profile.length - 1)];
    };
    const tri = (p, q, s) => {
      for (const v of [p, q, s]) {
        pos.push(v[0], v[1], v[2]);
        uvs.push(v[3], v[4]);
      }
    };
    for (let i = 0; i < profile.length - 1; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const a = at(i, j);
        const b = at(i, j + 1);
        const c = at(i + 1, j + 1);
        const d = at(i + 1, j);
        if (profile[i][0] > 0) tri(a, b, d);
        if (profile[i + 1][0] > 0) tri(b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    return g;
  };
  // Призма без индексов: выпуклый многоугольник poly ([a, b] против часовой, вид с +Z) вытянут вдоль Z
  // на depth; у каждой боковой грани и торцов uv 0…1 — на грань целиком ложится панель атласа
  // (швы, болты, потёртости по краям), как у BoxGeometry
  const prism = (poly, depth) => {
    const pos = [];
    const uvs = [];
    const h = depth / 2;
    const v = (a, b, z, u, w) => {
      pos.push(a, b, z);
      uvs.push(u, w);
    };
    const n = poly.length;
    for (let i = 0; i < n; i += 1) {
      const [pa, pb] = poly[i];
      const [qa, qb] = poly[(i + 1) % n];
      v(pa, pb, -h, 0, 0); v(qa, qb, -h, 1, 0); v(qa, qb, h, 1, 1);
      v(pa, pb, -h, 0, 0); v(qa, qb, h, 1, 1); v(pa, pb, h, 0, 1);
    }
    let a0 = Infinity; let a1 = -Infinity; let b0 = Infinity; let b1 = -Infinity;
    for (const [a, b] of poly) {
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const cu = (a, b, z) => v(a, b, z, (a - a0) / (a1 - a0), (b - b0) / (b1 - b0));
    for (let i = 1; i < n - 1; i += 1) {
      cu(...poly[0], h); cu(...poly[i], h); cu(...poly[i + 1], h);
      cu(...poly[0], -h); cu(...poly[i + 1], -h); cu(...poly[i], -h);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    return g;
  };
  // брусок с фасками на четырёх длинных рёбрах: сечение w×h (X×Y), длина d вдоль Z; along: 'x' | 'y' — длина вдоль X/Y
  const bevelBox = (hex, list, w, h, d, bev, x, y, z, { rx = 0, region = 'paint', along = 'z' } = {}) => {
    const a = w / 2;
    const b = h / 2;
    const g = prism([[a, -b + bev], [a, b - bev], [a - bev, b], [-a + bev, b], [-a, b - bev], [-a, -b + bev], [-a + bev, -b], [a - bev, -b]], d);
    if (along === 'x') g.rotateY(Math.PI / 2);
    if (along === 'y') g.rotateX(Math.PI / 2);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    return part(hex, g, list, region);
  };
  // цилиндр с осью axis ('x' | 'y' | 'z'), segs граней
  const cyl = (hex, list, r, len, segs, x, y, z, axis = 'y', region = 'steel', r2 = r) => {
    const g = new THREE.CylinderGeometry(r2, r, len, segs);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    if (axis === 'z') g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    return part(hex, g, list, region);
  };

  // Детальная стопа (большие псы, LOD в robodog-instances.js): прорезиненный «ботинок» — низ шара
  // радиуса FOOT_R с пятаком, двумя канавками и двумя рядами шипов протектора (всё не дальше FOOT_R от
  // центра — точка касания и утопание в землю как у прежнего шара), выше — гофрированное резиновое
  // голенище (две складки), на нём стальная манжета-щиколотка (восьмигранник с фаской сверху,
  // обхватывает конец голени) и два болта (спереди и снаружи). ~265 треугольников.
  const FOOT_SHIN_END = 1.45; // где кончается голень над центром стопы (× FOOT_R), внутри манжеты
  const detailedFoot = (list, cx, cy, side) => {
    const R = FOOT_R;
    const deg = Math.PI / 180;
    const sp = (phi, k) => [Math.sin(phi * deg) * k, -Math.cos(phi * deg) * k];
    const sole = [
      [0, -1], // полюс: точка касания
      sp(24, 1), // край пятака
      sp(36, 0.88), // канавка
      sp(50, 1), // шипы протектора
      sp(64, 0.88), // канавка
      sp(80, 1), // шипы протектора
      [0.98, 0.15], // плечо
      [0.78, 0.36], // складка голенища (впадина)
      [0.86, 0.5], // гребень
      [0.66, 0.68], // впадина
      [0.74, 0.8], // гребень (под манжетой)
      [0, 0.86], // крышка
    ].map(([r, y]) => [r * R, y * R]);
    const treads = new Set([3, 5]); // ряды шипов: вершины через одну утоплены
    const s = revolve(sole, 10, { lug: (i, j) => (treads.has(i) && j % 2 ? 0.86 : 1) });
    s.translate(cx, cy, 0);
    part(RUBBER, s, list, 'rubber');
    // резина светлее прежней (рисунок читается), канавки, утопленные шипы и впадины складок — почти чёрные
    const sc = s.attributes.color;
    const sp3 = s.attributes.position;
    const lo = new THREE.Color(0x0a0a0b);
    const hi = new THREE.Color(0x3a3b40);
    const dips = new Set([2, 4, 7, 9].map((i) => sole[i][1]));
    for (let i = 0; i < sp3.count; i += 1) {
      const dx = sp3.getX(i) - cx;
      const dy = sp3.getY(i) - cy;
      const dz = sp3.getZ(i);
      const deep = (dy < 0 && Math.hypot(dx, dy, dz) < 0.95 * R) || [...dips].some((y) => Math.abs(y - dy) < 1e-6);
      const c = deep ? lo : hi;
      sc.setXYZ(i, c.r, c.g, c.b);
    }
    // манжета: грани по осям, обхватывает конец голени (0,03×0,036, сдвинут вперёд на CUFF_Z); низ —
    // на верхнем гребне голенища, фаска сверху выше конца голени
    const CUFF_Z = 0.004;
    const flat = Math.cos(Math.PI / 8);
    const cuff = revolve([[1, 0.78 * R], [1, 1.55 * R], [0.8, 1.75 * R], [0, 1.75 * R]], 8, {
      sx: 0.019 / flat,
      sz: 0.02 / flat,
      phase: Math.PI / 8,
    });
    cuff.translate(cx, cy, CUFF_Z);
    part(STEEL, cuff, list, 'steel');
    // болты (тёмная шляпка): спереди (−Z) и снаружи (±X по стороне)
    for (const [bx, bz, w, d] of [[side * 0.019, 0, 0.004, 0.006], [0, -0.02, 0.006, 0.004]]) {
      box(0x3a3d42, list, w, 0.006, d, cx + bx, cy + 1.17 * R, CUFF_Z + bz, 0, 0, 0, 'steel');
    }
  };
  const merged = (list) => {
    const g = mergeGeometries(list);
    for (const p of list) p.dispose();
    g.computeBoundingSphere();
    return g;
  };

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: textures?.map ?? null,
    roughnessMap: textures?.orm ?? null,
    metalnessMap: textures?.orm ?? null,
    roughness: textures ? 1 : 0.45, // с картой — значение из неё
    metalness: textures ? 1 : 0.65,
    envMap: env,
    envMapIntensity: 0.5,
    flatShading: true,
  });
  material.emissive.setRGB(0, 0, 0); // вспышка от попадания (robodog-unit.js)
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x45e8ff, toneMapped: false });
  // растворение трупа (setFade): общий юниформ у корпуса/ног и глаз, программа одна на все кадры
  const fadeU = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDogFade = fadeU;
    injectDissolve(shader, { source: 'uniform' });
  };
  material.customProgramCacheKey = () => 'robodog-dissolve-1';
  eyeMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uDogFade = fadeU;
    injectDissolve(shader, { source: 'uniform', glow: false });
  };
  eyeMaterial.customProgramCacheKey = () => 'robodog-dissolve-eye-1';
  const setFade = (k) => {
    fadeU.value = k;
  };

  const group = new THREE.Group();
  group.name = 'robodog';
  const body = new THREE.Object3D();
  group.add(body);

  // ---- корпус
  const b = [];
  box(BLACK, b, 0.21, 0.09, 0.66, 0, -0.035, 0); // рама и брюхо (чёрная краска)
  box(YELLOW, b, 0.2, 0.08, 0.58, 0, 0.03, 0.005); // жёлтый кожух
  box(YELLOW, b, 0.16, 0.03, 0.5, 0, 0.08, 0.01); // крышка
  box(YELLOW, b, 0.035, 0.03, 0.5, 0.083, 0.068, 0.01, 0, 0, -0.6); // скосы крышки
  box(YELLOW, b, 0.035, 0.03, 0.5, -0.083, 0.068, 0.01, 0, 0, 0.6);
  box(BLACK, b, 0.006, 0.022, 0.42, 0.101, 0.035, 0.02); // чёрные полосы по бокам
  box(BLACK, b, 0.006, 0.022, 0.42, -0.101, 0.035, 0.02);
  // рейки сверху и ручка — голая сталь
  steelBox(b, 0.014, 0.014, 0.36, 0.055, 0.102, 0.02);
  steelBox(b, 0.014, 0.014, 0.36, -0.055, 0.102, 0.02);
  steelBox(b, 0.124, 0.014, 0.014, 0, 0.102, -0.16);
  steelBox(b, 0.124, 0.014, 0.014, 0, 0.102, 0.2);
  // сенсорная голова спереди: чёрный блок со скошенным лбом
  box(BLACK, b, 0.19, 0.085, 0.1, 0, 0.0, -0.345);
  box(BLACK, b, 0.17, 0.04, 0.1, 0, 0.05, -0.335, -0.35);
  steelBox(b, 0.13, 0.03, 0.03, 0, -0.035, -0.39); // нижняя губа
  // задний бампер
  box(BLACK, b, 0.18, 0.07, 0.06, 0, 0.0, 0.33);
  // крепления ног на корпусе — сталь
  for (const [x, y, z] of HIPS) steelBox(b, 0.04, 0.07, 0.09, Math.sign(x) * 0.098, y, z);
  const bodyGeometry = merged(b);

  // ---- детальный корпус (LOD больших псов, robodog-instances.js; у одиночного пса — всегда): тот же
  // силуэт и те же точки крепления (ноги, пулемёт, полосы глаз на тех же гранях), но фаски на рёбрах,
  // решётки охлаждения, болты, камеры на морде, люк и полозья на брюхе. ~900 треугольников против 228.
  const bd = [];
  const GLASS = 0x0d1016; // стекло объективов: тёмная гладкая сталь атласа
  bevelBox(BLACK, bd, 0.21, 0.09, 0.66, 0.014, 0, -0.035, 0); // рама и брюхо
  bevelBox(YELLOW, bd, 0.2, 0.08, 0.58, 0.012, 0, 0.03, 0.005); // кожух
  bevelBox(YELLOW, bd, 0.16, 0.03, 0.5, 0.008, 0, 0.08, 0.01); // крышка
  box(YELLOW, bd, 0.035, 0.03, 0.5, 0.083, 0.068, 0.01, 0, 0, -0.6); // скосы крышки
  box(YELLOW, bd, 0.035, 0.03, 0.5, -0.083, 0.068, 0.01, 0, 0, 0.6);
  box(BLACK, bd, 0.006, 0.022, 0.42, 0.101, 0.035, 0.02); // полосы по бокам
  box(BLACK, bd, 0.006, 0.022, 0.42, -0.101, 0.035, 0.02);
  steelBox(bd, 0.014, 0.014, 0.36, 0.055, 0.102, 0.02); // рейки и ручка
  steelBox(bd, 0.014, 0.014, 0.36, -0.055, 0.102, 0.02);
  steelBox(bd, 0.124, 0.014, 0.014, 0, 0.102, -0.16);
  steelBox(bd, 0.124, 0.014, 0.014, 0, 0.102, 0.2);
  // решётки охлаждения на крышке: тёмная рамка и стальные ламели (задняя — 5, передняя — 4)
  box(BLACK, bd, 0.084, 0.004, 0.084, 0, 0.096, 0.145);
  for (let i = 0; i < 5; i += 1) steelBox(bd, 0.072, 0.005, 0.007, 0, 0.099, 0.115 + i * 0.015);
  box(BLACK, bd, 0.084, 0.004, 0.07, 0, 0.096, -0.1);
  for (let i = 0; i < 4; i += 1) steelBox(bd, 0.072, 0.005, 0.007, 0, 0.099, -0.124 + i * 0.016);
  // боковые решётки сзади (за полосами): рамка и 4 ламели с каждой стороны
  for (const sx of [-1, 1]) {
    box(BLACK, bd, 0.003, 0.046, 0.046, sx * 0.1005, 0.04, 0.262);
    for (let i = 0; i < 4; i += 1) steelBox(bd, 0.004, 0.005, 0.04, sx * 0.102, 0.025 + i * 0.01, 0.262);
    // болты на раме
    for (const bz of [-0.2, 0.2]) steelBox(bd, 0.004, 0.007, 0.007, sx * 0.1055, -0.05, bz);
  }
  // болты по углам крышки
  for (const [bx, bz] of [[0.066, -0.225], [-0.066, -0.225], [0.066, 0.245], [-0.066, 0.245]]) box(0x3a3d42, bd, 0.007, 0.004, 0.007, bx, 0.097, bz, 0, 0, 0, 'steel');
  // сенсорная голова: блок с фасками, скошенный лоб, губа
  bevelBox(BLACK, bd, 0.19, 0.085, 0.1, 0.012, 0, 0.0, -0.345);
  box(BLACK, bd, 0.17, 0.04, 0.1, 0, 0.05, -0.335, -0.35);
  steelBox(bd, 0.13, 0.03, 0.03, 0, -0.035, -0.39);
  // стереокамеры под полосой глаз: стальная оправа, тёмное стекло; между ними — датчик глубины
  for (const sx of [-1, 1]) {
    cyl(STEEL, bd, 0.009, 0.008, 8, sx * 0.052, -0.009, -0.398, 'z');
    cyl(GLASS, bd, 0.0058, 0.004, 8, sx * 0.052, -0.009, -0.4035, 'z');
  }
  box(GLASS, bd, 0.022, 0.008, 0.004, 0, -0.009, -0.397, 0, 0, 0, 'steel');
  // камеры по бокам головы (под боковыми полосами глаз)
  for (const sx of [-1, 1]) {
    cyl(STEEL, bd, 0.008, 0.006, 8, sx * 0.0975, -0.016, -0.35, 'x');
    cyl(GLASS, bd, 0.005, 0.003, 8, sx * 0.1015, -0.016, -0.35, 'x');
  }
  // задний бампер с фасками
  bevelBox(BLACK, bd, 0.18, 0.07, 0.06, 0.012, 0, 0.0, 0.33);
  // крепления ног — сталь с фасками
  for (const [x, y, z] of HIPS) bevelBox(STEEL, bd, 0.04, 0.07, 0.09, 0.008, Math.sign(x) * 0.098, y, z, { region: 'steel' });
  // брюхо: люк батареи и два стальных полоза
  bevelBox(STEEL, bd, 0.14, 0.012, 0.36, 0.004, 0, -0.082, 0, { region: 'steel' });
  for (const sx of [-1, 1]) steelBox(bd, 0.012, 0.008, 0.5, sx * 0.085, -0.082, 0);
  const bodyDetailGeometry = merged(bd);

  const bodyMesh = new THREE.Mesh(bodyDetailGeometry, material); // один пёс — детальный корпус
  bodyMesh.name = 'robodog-body';
  body.add(bodyMesh);

  // ---- «глаза»: полоса спереди, по бокам головы и сзади
  const e = [];
  box(0xffffff, e, 0.15, 0.02, 0.006, 0, 0.012, -0.396);
  box(0xffffff, e, 0.006, 0.016, 0.06, 0.0965, 0.012, -0.35);
  box(0xffffff, e, 0.006, 0.016, 0.06, -0.0965, 0.012, -0.35);
  box(0xffffff, e, 0.1, 0.014, 0.006, 0, 0.012, 0.361);
  const eyeGeometry = merged(e);
  eyeGeometry.deleteAttribute('color');
  const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  eye.name = 'robodog-eye';
  body.add(eye);

  // ---- ноги: геометрия общая для всех ног одной стороны (зеркало по X)
  const upperGeometry = [];
  const lowerGeometry = [];
  const lowerDetailGeometry = [];
  const upperDetailGeometry = [];
  for (const side of [-1, 1]) {
    const u = [];
    joint(u, 0.048, 0.06, side * 0.012, 0, 0); // мотор бедра
    box(YELLOW, u, 0.05, L1 - 0.02, 0.07, side * 0.012, -L1 / 2 + 0.005, 0); // бедро (жёлтая краска)
    box(BLACK, u, 0.006, L1 * 0.6, 0.045, side * 0.04, -L1 / 2, 0); // накладка снаружи
    box(YELLOW, u, 0.04, 0.05, 0.06, side * 0.012, -L1 + 0.02, 0.004); // утолщение у колена
    upperGeometry.push(merged(u));
    const l = [];
    joint(l, 0.03, 0.05, side * 0.012, 0, 0); // колено
    steelBox(l, 0.03, L2 - 0.02, 0.036, side * 0.012, -L2 / 2, 0.004); // голень — тёмная сталь
    box(BLACK, l, 0.032, L2 * 0.35, 0.04, side * 0.012, -L2 * 0.3, 0.004); // кожух голени
    steelBox(l, 0.024, L2 * 0.5, 0.026, side * 0.012, -L2 * 0.68, -0.006); // сужение к стопе
    const foot = new THREE.IcosahedronGeometry(FOOT_R, 1);
    foot.translate(side * 0.012, -L2, 0);
    part(RUBBER, foot, l, 'rubber');
    lowerGeometry.push(merged(l));
    // ---- детальные бедро и голень (LOD больших псов): тот же размер и те же оси суставов
    const cx = side * 0.012;
    const ud = [];
    // актуатор бедра: мотор (12 граней), снаружи кожух в цвет рамы, стальная ступица и 4 болта
    cyl(STEEL, ud, 0.048, 0.06, 12, cx, 0, 0, 'x');
    cyl(BLACK, ud, 0.038, 0.007, 10, side * 0.0455, 0, 0, 'x', 'paint');
    cyl(STEEL, ud, 0.013, 0.006, 8, side * 0.05, 0, 0, 'x');
    for (const [by, bz] of [[0.026, 0], [-0.026, 0], [0, 0.026], [0, -0.026]]) box(0x3a3d42, ud, 0.004, 0.006, 0.006, side * 0.05, by, bz, 0, 0, 0, 'steel');
    // бедро с фасками, накладка снаружи, утолщение у колена
    bevelBox(YELLOW, ud, 0.05, 0.07, L1 - 0.02, 0.01, cx, -L1 / 2 + 0.005, 0, { along: 'y' });
    bevelBox(BLACK, ud, 0.006, 0.045, L1 * 0.6, 0.002, side * 0.04, -L1 / 2, 0, { along: 'y' });
    bevelBox(YELLOW, ud, 0.04, 0.06, 0.05, 0.008, cx, -L1 + 0.02, 0.004, { along: 'y' });
    // кабель сзади бедра (резиновый шланг) и два хомута
    cyl(RUBBER, ud, 0.0045, L1 - 0.07, 6, side * 0.02, -0.03 - (L1 - 0.07) / 2, 0.039, 'y', 'rubber');
    for (const cy of [-0.05, -L1 + 0.06]) steelBox(ud, 0.012, 0.006, 0.012, side * 0.02, cy, 0.037);
    upperDetailGeometry.push(merged(ud));

    // голень: колено с кожухом в цвет рамы и ступицей, голень с фасками и рёбрами, кабель к стопе
    const ld = [];
    cyl(STEEL, ld, 0.03, 0.05, 12, cx, 0, 0, 'x');
    cyl(BLACK, ld, 0.024, 0.006, 10, side * 0.04, 0, 0, 'x', 'paint');
    cyl(STEEL, ld, 0.009, 0.005, 8, side * 0.0445, 0, 0, 'x');
    const shinEnd = -L2 + FOOT_SHIN_END * FOOT_R;
    bevelBox(STEEL, ld, 0.03, 0.036, -0.01 - shinEnd, 0.005, cx, (-0.01 + shinEnd) / 2, 0.004, { along: 'y', region: 'steel' });
    bevelBox(BLACK, ld, 0.032, 0.04, L2 * 0.35, 0.006, cx, -L2 * 0.3, 0.004, { along: 'y' });
    for (const ry of [-0.125, -0.147, -0.169]) bevelBox(BLACK, ld, 0.034, 0.04, 0.005, 0.004, cx, ry, 0.004, { along: 'y' }); // рёбра
    cyl(RUBBER, ld, 0.0035, 0.165, 6, cx, -0.1025, 0.026, 'y', 'rubber');
    detailedFoot(ld, cx, -L2, side);
    lowerDetailGeometry.push(merged(ld));
  }

  const legs = HIPS.map(([x, y, z], i) => {
    const sideIndex = x < 0 ? 0 : 1;
    const hip = new THREE.Object3D();
    hip.position.set(x, y, z);
    body.add(hip);
    const upper = new THREE.Object3D();
    hip.add(upper);
    const upperMesh = new THREE.Mesh(upperDetailGeometry[sideIndex], material); // один пёс — детальное бедро
    upperMesh.name = `robodog-upper-${i}`;
    upper.add(upperMesh);
    const knee = new THREE.Object3D();
    knee.position.set(0, -L1, 0);
    upper.add(knee);
    const lowerMesh = new THREE.Mesh(lowerDetailGeometry[sideIndex], material); // один пёс — детальная стопа
    lowerMesh.name = `robodog-lower-${i}`;
    knee.add(lowerMesh);
    return { hip, upper, knee };
  });

  // ---- пулемёт на спине (стая: у каждого пятого; по умолчанию скрыт). Поворотная башенка (рысканье) и
  // качалка со стволом (тангаж); тот же материал — без новых шейдеров, +2 вызова отрисовки, когда виден.
  const tYaw = new THREE.Object3D();
  tYaw.position.set(0, 0.112, 0.04);
  tYaw.visible = false;
  body.add(tYaw);
  const tb = [];
  part(STEEL, new THREE.CylinderGeometry(0.05, 0.055, 0.025, 10).translate(0, 0.012, 0), tb, 'steel'); // поворотный круг
  box(BLACK, tb, 0.08, 0.02, 0.08, 0, 0.03, 0);
  box(YELLOW, tb, 0.014, 0.05, 0.03, -0.034, 0.06, 0); // вилка
  box(YELLOW, tb, 0.014, 0.05, 0.03, 0.034, 0.06, 0);
  const turretBaseGeometry = merged(tb);
  const turretBase = new THREE.Mesh(turretBaseGeometry, material);
  turretBase.name = 'robodog-turret-base';
  tYaw.add(turretBase);
  const tPitch = new THREE.Object3D();
  tPitch.position.set(0, 0.07, 0);
  tYaw.add(tPitch);
  const tg = [];
  box(BLACK, tg, 0.046, 0.042, 0.11, 0, 0, 0.01); // коробка
  box(YELLOW, tg, 0.03, 0.034, 0.05, 0.036, -0.008, 0.015); // патронный ящик
  steelBox(tg, 0.014, 0.014, 0.17, 0, 0.004, -0.125); // ствол
  steelBox(tg, 0.022, 0.022, 0.035, 0, 0.004, -0.2); // дульный тормоз
  steelBox(tg, 0.008, 0.02, 0.008, 0, 0.026, -0.03); // мушка
  const turretGunGeometry = merged(tg);
  const turretGun = new THREE.Mesh(turretGunGeometry, material);
  turretGun.name = 'robodog-turret-gun';
  tPitch.add(turretGun);
  const tMuzzle = new THREE.Object3D();
  tMuzzle.position.set(0, 0.004, -0.225);
  tPitch.add(tMuzzle);
  const turret = { yaw: tYaw, pitch: tPitch, muzzle: tMuzzle, pivotY: tPitch.position.y };

  // Окраска: вершины жёлтой краски → цвет 0, чёрной → цвет 1 (сталь и резина не меняются). Списки
  // вершин — один раз; смена — запись в атрибут цвета (~тысяча вершин, только при появлении пса).
  let paintIndex = 0;
  let paintSets = null;
  const setPaint = (index) => {
    index = ((Math.floor(index) % DOG_PAINTS.length) + DOG_PAINTS.length) % DOG_PAINTS.length || 0;
    if (index === paintIndex) return;
    const scheme = DOG_PAINTS[index];
    if (!paintSets) {
      const yl = new THREE.Color(YELLOW);
      const bl = new THREE.Color(BLACK);
      const near = (a, i, c) => Math.abs(a[i] - c.r) + Math.abs(a[i + 1] - c.g) + Math.abs(a[i + 2] - c.b) < 1e-4;
      paintSets = [bodyGeometry, bodyDetailGeometry, ...upperGeometry, ...upperDetailGeometry, ...lowerGeometry, ...lowerDetailGeometry, turretBaseGeometry, turretGunGeometry].map((g) => {
        const a = g.attributes.color.array;
        const first = [];
        const second = [];
        for (let i = 0; i < a.length; i += 3) {
          if (near(a, i, yl)) first.push(i);
          else if (near(a, i, bl)) second.push(i);
        }
        return { attr: g.attributes.color, first: Uint32Array.from(first), second: Uint32Array.from(second) };
      });
    }
    paintIndex = index;
    const c0 = color.set(scheme[0]).clone();
    const c1 = color.set(scheme[1]);
    for (const { attr, first, second } of paintSets) {
      const a = attr.array;
      for (const i of first) {
        a[i] = c0.r;
        a[i + 1] = c0.g;
        a[i + 2] = c0.b;
      }
      for (const i of second) {
        a[i] = c1.r;
        a[i + 1] = c1.g;
        a[i + 2] = c1.b;
      }
      attr.needsUpdate = true;
    }
  };

  return {
    setPaint,
    turret,
    // геометрии модели — для отрисовки всех псов стаи экземплярами (robodog-instances.js)
    geometries: { body: bodyGeometry, bodyDetail: bodyDetailGeometry, eye: eyeGeometry, upper: upperGeometry, upperDetail: upperDetailGeometry, lower: lowerGeometry, lowerDetail: lowerDetailGeometry, turretBase: turretBaseGeometry, turretGun: turretGunGeometry },
    group,
    body,
    eye,
    material,
    eyeMaterial,
    setFade,
    legs,
    setPose(pose) {
      body.position.set(pose.x, pose.y, 0);
      body.rotation.set(pose.pitch, pose.yaw ?? 0, pose.roll);
      for (let i = 0; i < 4; i += 1) {
        const leg = legs[i];
        const a = pose.legs[i];
        leg.hip.rotation.set(0, 0, a.abd);
        leg.upper.rotation.set(a.hip, 0, 0);
        leg.knee.rotation.set(a.knee, 0, 0);
      }
    },
    dispose() {
      group.removeFromParent();
      bodyGeometry.dispose();
      bodyDetailGeometry.dispose();
      eyeGeometry.dispose();
      for (const g of [...upperGeometry, ...upperDetailGeometry, ...lowerGeometry, ...lowerDetailGeometry]) g.dispose();
      turretBaseGeometry.dispose();
      turretGunGeometry.dispose();
      material.dispose();
      eyeMaterial.dispose();
    },
  };
}
