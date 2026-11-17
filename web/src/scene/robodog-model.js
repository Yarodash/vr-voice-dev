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
// где в атласе вид металла: [u0, v0, du, dv]
const REGION = { paint: [0, 0, 0.5, 1], steel: [0.5, 0.5, 0.5, 0.5], rubber: [0.5, 0, 0.5, 0.5] };

// мягкое тёмное пятно для тени под псом (одна текстура на всех псов)
export function makeShadowTexture(THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
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
  const bodyMesh = new THREE.Mesh(merged(b), material);
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
  }

  const legs = HIPS.map(([x, y, z], i) => {
    const sideIndex = x < 0 ? 0 : 1;
    const hip = new THREE.Object3D();
    hip.position.set(x, y, z);
    body.add(hip);
    const upper = new THREE.Object3D();
    hip.add(upper);
    const upperMesh = new THREE.Mesh(upperGeometry[sideIndex], material);
    upperMesh.name = `robodog-upper-${i}`;
    upper.add(upperMesh);
    const knee = new THREE.Object3D();
    knee.position.set(0, -L1, 0);
    upper.add(knee);
    const lowerMesh = new THREE.Mesh(lowerGeometry[sideIndex], material);
    lowerMesh.name = `robodog-lower-${i}`;
    knee.add(lowerMesh);
    return { hip, upper, knee };
  });

  return {
    group,
    body,
    eye,
    material,
    eyeMaterial,
    legs,
    setPose(pose) {
      body.position.set(pose.x, pose.y, 0);
      body.rotation.set(pose.pitch, 0, pose.roll);
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
      bodyMesh.geometry.dispose();
      eyeGeometry.dispose();
      for (const g of [...upperGeometry, ...lowerGeometry]) g.dispose();
      material.dispose();
      eyeMaterial.dispose();
    },
  };
}
