// Снайперская винтовка с продольно-скользящим затвором («АВП» — так её зовёт пользователь) в духе
// современной винтовки на шасси (как на фото-образце, без логотипов): плоская ствольная коробка с
// длинной планкой Пикатинни, складной регулируемый приклад-«скелет» (затыльник, щека на стойках,
// нижняя планка, ручки регулировки), резиненная пистолетная рукоятка как у AR, отъёмный магазин,
// длинное цевьё M-LOK с рядами прорезей (сквозь них виден ствол), тяжёлый ствол, компактный
// дульный тормоз, длинный прицел в высоких кольцах (стёкла — scope-lens.js, ставит pistols.js).
// Всё чёрное/тёмно-серое разной фактуры: анодированный алюминий (сатин, лёгкий блеск), полимер
// (матовый, зерно), резина, матовый прицел, воронёная сталь ствола. Текстуры — шум на canvas, раз на
// страницу (__sceneState.awpTex). Детали одного материала и узла слиты в один меш. Живёт в сцене.
//
// Система оружия сцены: метры, ствол в −Z, верх +Y, середина пистолетной рукоятки (ладонь) в
// (0, −0.04, 0.045). Длина ≈ 1,17 м: от дульного тормоза (z ≈ −0.845) до затыльника (z ≈ 0.322).
//
// buildAwp(THREE, { outlineM }) → { group, accent, outlineGeometry, muzzle, ejector, trigger, bolt, rail, scope }
//   trigger — { pivot, maxAngle }; bolt — { pivot, travel, lift }: затвор (стебель с рукояткой справа) —
//   поворот вокруг оси канала (rotation.z) и ход назад (position.z), см. cycleBolt;
//   rail — планка: { top, from, to }; scope — прицел (см. в конце).
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const BORE_Y = 0.05; // ось канала ствола
const RECV_TOP = 0.077; // верх ствольной коробки и цевья
const RAIL_FROM = -0.27;
const RAIL_TO = 0.066;
const RAIL_TOP = RECV_TOP + 0.006 + 0.0045; // верх зубцов планки
const SCOPE_Y = RAIL_TOP + 0.033; // ось прицела (высокие кольца)
const SCOPE_RINGS = [-0.17, -0.02]; // кольца (z при сдвиге 0)
// сдвиг прицела по планке (scope.node.position.z): оба кольца остаются на планке
export const SCOPE_MIN_Z = RAIL_FROM + 0.011 - SCOPE_RINGS[0];
export const SCOPE_MAX_Z = RAIL_TO - 0.011 - SCOPE_RINGS[1];
export const SCOPE_DEFAULT_Z = 0;
const UV_M = 0.03; // тайл шумовых текстур, м

// Цикл затвора после выстрела (мс): ждёт отдачу, вверх, назад (гильза вылетает в конце хода),
// вперёд, вниз. Вся перезарядка ≈ 1 с; темп стрельбы (gapMs) в main.js — 1100 мс.
const BOLT_T = { wait: 200, up: 150, back: 230, hold: 40, fwd: 220, down: 150 };
const T_UP = BOLT_T.wait;
const T_BACK = T_UP + BOLT_T.up;
const T_BACKED = T_BACK + BOLT_T.back; // затвор сзади — гильза летит
const T_FWD = T_BACKED + BOLT_T.hold;
const T_DOWN = T_FWD + BOLT_T.fwd; // затвор впереди — лязг
export const BOLT_CYCLE_MS = T_DOWN + BOLT_T.down;

const ease = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// Затвор по времени после выстрела (age, мс). Вызывает pistols.updateTriggers. Звук — через
// __sceneState.sound.bolt (открыть / закрыть), гильза — onEject(item) в конце хода назад.
// Возвращает true, когда цикл закончен.
export function cycleBolt(item, age, onEject) {
  const bolt = item.bolt;
  if (bolt.shotAt !== item.shotAt) {
    bolt.shotAt = item.shotAt;
    bolt.events = 0;
  }
  let lift = 0;
  let back = 0;
  if (age < T_BACK) lift = ease((age - T_UP) / BOLT_T.up);
  else if (age < T_FWD) {
    lift = 1;
    back = ease((age - T_BACK) / BOLT_T.back);
  } else if (age < T_DOWN) {
    lift = 1;
    back = 1 - ease((age - T_FWD) / BOLT_T.fwd);
  } else lift = 1 - ease((age - T_DOWN) / BOLT_T.down);
  bolt.pivot.rotation.z = lift * bolt.lift;
  bolt.pivot.position.z = back * bolt.travel;
  const sound = (phase) => {
    try {
      item.group.updateWorldMatrix(true, false);
      globalThis.__sceneState?.sound?.bolt?.(bolt.tmp.set(0, BORE_Y, 0.06).applyMatrix4(item.group.matrixWorld), phase);
    } catch {
      // без звука
    }
  };
  if (age >= T_UP && bolt.events < 1) {
    bolt.events = 1;
    sound('open'); // щелчок, лязг хода назад запечён в нём же
  }
  if (age >= T_BACKED && bolt.events < 2) {
    bolt.events = 2;
    onEject?.(item);
  }
  if (age >= T_DOWN && bolt.events < 3) {
    bolt.events = 3;
    sound('close'); // удар вперёд и щелчок рукоятки вниз
  }
  if (age >= BOLT_CYCLE_MS) {
    bolt.pivot.rotation.z = 0;
    bolt.pivot.position.z = 0;
    return true;
  }
  return false;
}

// шумовые текстуры (раз на страницу): точки светлее/темнее на сером; bump/roughness-карты
const makeTextures = (THREE) => {
  const noise = (dots, rMin, rMax, light, dark, base = '#808080') => {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < dots; i += 1) {
      g.fillStyle = Math.random() < 0.5 ? dark : light;
      g.beginPath();
      g.arc(Math.random() * size, Math.random() * size, rMin + Math.random() * (rMax - rMin), 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  return {
    polymerBump: noise(2200, 0.6, 1.4, '#b8b8b8', '#4a4a4a'), // мелкое зерно полимера
    gripBump: noise(4200, 0.8, 1.8, '#ffffff', '#202020'), // «шагрень» резиненной рукоятки
    rubberBump: noise(3500, 0.8, 2.2, '#c0c0c0', '#404040'), // мягкая резина затыльника и наглазника
    anodizeRough: noise(3000, 0.5, 1.2, '#a6a6a6', '#5a5a5a', '#808080'), // пятнистость блика анодировки
    steelRough: noise(2600, 0.5, 1.5, '#e0e0e0', '#909090', '#b8b8b8'), // матовое воронение ствола
  };
};

export function buildAwp(THREE, { outlineM = 0 } = {}) {
  const shared = (globalThis.__sceneState ??= {});
  const env = shared.weaponEnv ?? null;
  const tex = (shared.awpTex ??= makeTextures(THREE));
  const group = new THREE.Group();
  // разные фактуры чёрного
  const alu = new THREE.MeshStandardMaterial({ color: 0x1f2124, roughness: 0.42, metalness: 0.6, roughnessMap: tex.anodizeRough, envMap: env, envMapIntensity: 0.55 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.82, metalness: 0, bumpMap: tex.polymerBump, bumpScale: 0.5 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x18191a, roughness: 0.9, metalness: 0, bumpMap: tex.gripBump, bumpScale: 1.4 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151617, roughness: 0.95, metalness: 0, bumpMap: tex.rubberBump, bumpScale: 1.1 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x2b2c2f, roughness: 0.62, metalness: 0.62, roughnessMap: tex.steelRough, envMap: env, envMapIntensity: 0.45 });
  const scopeMat = new THREE.MeshStandardMaterial({ color: 0x121315, roughness: 0.6, metalness: 0.4, roughnessMap: tex.anodizeRough, envMap: env, envMapIntensity: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x060607, roughness: 0.9, metalness: 0 }); // прорези, окна, глубина
  const accent = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.55, metalness: 0.6, emissive: 0x000000, envMap: env, envMapIntensity: 0.35 });

  const parts = []; // { geometry (отцентрована), center, material, tag }
  let tag = null; // 'trigger' | 'bolt' | 'scope' — деталь уходит в свой узел
  // UV: плоская проекция по главной оси нормали, в метрах / UV_M — зерно одного размера на всех деталях
  const planarUv = (g) => {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i += 1) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      let u, v;
      if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); } else if (ay >= az) { u = p.getZ(i); v = p.getX(i); } else { u = p.getX(i); v = p.getY(i); }
      uv[i * 2] = u / UV_M; uv[i * 2 + 1] = v / UV_M;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  };
  const place = (geometry, material, { rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0 } = {}) => {
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    g.clearGroups();
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    planarUv(g);
    g.computeBoundingBox();
    const center = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-center.x, -center.y, -center.z);
    g.computeBoundingBox();
    parts.push({ geometry: g, center, material, tag });
  };
  // брусок со скруглёнными рёбрами (r — радиус): размеры по X, Y, Z; положение — центр
  const rbox = (w, h, d, material, x, y, z, { r = 0.002, seg = 1, ...rot } = {}) =>
    place(new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2.01, h / 2.01, d / 2.01)), material, { ...rot, x, y, z });
  const box = (w, h, d, material, x, y, z, rot = {}) => place(new THREE.BoxGeometry(w, h, d), material, { ...rot, x, y, z });
  // цилиндр вдоль Z от z0 до z1 (r0 — у z0, r1 — у z1)
  const tubeZ = (r0, r1, z0, z1, material, x = 0, y = BORE_Y, segments = 24) => {
    const g = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), segments, 1);
    g.rotateX(Math.PI / 2); // +Y → +Z: верх цилиндра (r1) — к +Z
    if (z1 < z0) g.rotateY(Math.PI);
    place(g, material, { x, y, z: (z0 + z1) / 2 });
  };
  const cylX = (r, h, material, x, y, z, segments = 20) => place(new THREE.CylinderGeometry(r, r, h, segments), material, { rz: Math.PI / 2, x, y, z });
  const cylY = (r, h, material, x, y, z, segments = 20) => place(new THREE.CylinderGeometry(r, r, h, segments), material, { x, y, z });
  // стержень от точки a до точки b
  const up = new THREE.Vector3(0, 1, 0);
  const rod = (a, b, r, material, segments = 10) => {
    const from = new THREE.Vector3(...a);
    const dir = new THREE.Vector3(...b).sub(from);
    const g = new THREE.CylinderGeometry(r, r, dir.length(), segments, 1);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize()));
    const mid = from.addScaledVector(dir, 0.5);
    place(g, material, { x: mid.x, y: mid.y, z: mid.z });
  };
  // профиль вращением ([радиус, z], спереди назад; ось вращения +Y → +Z оружия)
  const lathe = (points, material, y, segments = 32) => {
    const g = new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(r, z)), segments);
    g.rotateX(Math.PI / 2);
    place(g, material, { y });
  };
  // многоугольник со скруглёнными углами (r — радиус скругления)
  const rounded = (path, points, r) => {
    const n = points.length;
    for (let i = 0; i < n; i += 1) {
      const p = points[i];
      const prev = points[(i + n - 1) % n];
      const next = points[(i + 1) % n];
      const lenIn = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      const lenOut = Math.hypot(next[0] - p[0], next[1] - p[1]);
      const rr = Math.min(r, lenIn * 0.45, lenOut * 0.45);
      const inX = p[0] + ((prev[0] - p[0]) / lenIn) * rr;
      const inY = p[1] + ((prev[1] - p[1]) / lenIn) * rr;
      const outX = p[0] + ((next[0] - p[0]) / lenOut) * rr;
      const outY = p[1] + ((next[1] - p[1]) / lenOut) * rr;
      if (i === 0) path.moveTo(inX, inY);
      else path.lineTo(inX, inY);
      path.quadraticCurveTo(p[0], p[1], outX, outY);
    }
    path.closePath();
    return path;
  };
  const rect = (z0, y0, z1, y1) => [[z0, y0], [z1, y0], [z1, y1], [z0, y1]];
  // Плита по боковому профилю (точки [z, y]), выдавленная поперёк (по X) на width; кромки и края
  // отверстий скруглены четвертью круга (radius в плоскости профиля, depth поперёк; стенки — на контуре)
  const slab = (outer, holes, width, material, { r = 0.004, holeR = r, radius = 0.004, depth = 0.005, segments = 3, curve = 5, x = 0 } = {}) => {
    const shape = rounded(new THREE.Shape(), outer, r);
    for (const hole of holes) shape.holes.push(rounded(new THREE.Path(), hole, holeR));
    const core = Math.max(width - depth * 2, 1e-4);
    let g = new THREE.ExtrudeGeometry(shape, { depth: core, bevelEnabled: true, bevelThickness: depth, bevelSize: radius, bevelOffset: -radius, bevelSegments: segments, curveSegments: curve });
    g.translate(0, 0, -core / 2);
    g.rotateY(-Math.PI / 2); // x профиля → z оружия, выдавливание → X
    g = toCreasedNormals(g, THREE.MathUtils.degToRad(40));
    place(g, material, { x });
  };

  // ---- ствольная коробка: верх (алюминий, плоский), низ с шахтой магазина и спусковой скобой
  rbox(0.034, RECV_TOP - 0.02, 0.283, alu, 0, (RECV_TOP + 0.02) / 2, -0.0635, { r: 0.004, seg: 2 });
  rbox(0.037, 0.03, 0.27, alu, 0, 0.01, -0.07, { r: 0.004, seg: 2 }); // низ
  rbox(0.039, 0.02, 0.03, alu, 0, -0.007, -0.177, { r: 0.004, seg: 2 }); // раструб шахты
  box(0.0012, 0.016, 0.055, dark, 0.0172, BORE_Y + 0.006, -0.035); // окно выброса справа
  box(0.0012, 0.009, 0.07, dark, 0.0172, BORE_Y - 0.002, 0.036); // паз рукоятки затвора
  box(0.0014, 0.002, 0.24, dark, 0.0185, 0.025, -0.07); // шов верха и низа
  box(0.0014, 0.002, 0.24, dark, -0.0185, 0.025, -0.07);
  // спусковая скоба и предохранитель
  rbox(0.012, 0.005, 0.07, alu, 0, -0.033, -0.022, { r: 0.002 });
  rbox(0.012, 0.03, 0.006, alu, 0, -0.019, -0.055, { r: 0.002 });
  cylX(0.0045, 0.042, alu, 0, 0.012, 0.02, 16); // ось-предохранитель
  // планка Пикатинни по всей длине (над коробкой и задом цевья)
  rbox(0.016, 0.006, RAIL_TO - RAIL_FROM, alu, 0, RECV_TOP + 0.003, (RAIL_FROM + RAIL_TO) / 2, { r: 0.0015 });
  for (let z = RAIL_FROM + 0.005; z <= RAIL_TO - 0.004; z += 0.01) box(0.0212, 0.0045, 0.0055, alu, 0, RECV_TOP + 0.006 + 0.00225, z);

  // ---- цевьё M-LOK: боковые стенки с двумя рядами прорезей (насквозь), верх, низ, скруглённые углы
  const HG0 = -0.205, HG1 = -0.6, HG_W = 0.05, HG_B = 0.02;
  {
    const slots = [];
    for (let i = 0; i < 9; i += 1) {
      const z = HG0 - 0.03 - i * 0.04;
      if (z - 0.026 > HG1 + 0.012) slots.push(rect(z - 0.026, 0.0545, z, 0.0615)); // верхний ряд
      const z2 = z - 0.02;
      if (z2 - 0.026 > HG1 + 0.012) slots.push(rect(z2 - 0.026, 0.033, z2, 0.04)); // нижний ряд, вразбежку
    }
    for (const side of [-1, 1]) {
      slab(rect(HG1, HG_B + 0.004, HG0, RECV_TOP - 0.004), slots, 0.004, alu, { r: 0.002, holeR: 0.0034, radius: 0.0011, depth: 0.0011, segments: 2, curve: 3, x: side * (HG_W / 2 - 0.002) });
    }
    rbox(HG_W - 0.008, 0.004, HG0 - HG1, alu, 0, RECV_TOP - 0.002, (HG0 + HG1) / 2, { r: 0.0015 });
    rbox(HG_W - 0.008, 0.004, HG0 - HG1, alu, 0, HG_B + 0.002, (HG0 + HG1) / 2, { r: 0.0015 });
    for (const sx of [-1, 1]) for (const yy of [RECV_TOP - 0.004, HG_B + 0.004]) tubeZ(0.005, 0.005, HG1, HG0, alu, sx * (HG_W / 2 - 0.004), yy, 12);
    // прорези снизу (тёмные), торцевое кольцо спереди
    for (let i = 0; i < 5; i += 1) box(0.008, 0.0012, 0.026, dark, 0, HG_B - 0.0002, HG0 - 0.05 - i * 0.07);
    tubeZ(0.014, 0.014, HG1 + 0.008, HG1, alu, 0, BORE_Y, 20); // гайка-заглушка вокруг ствола
  }

  // ---- ствол (воронёная сталь) и дульный тормоз
  tubeZ(0.0105, 0.0094, -0.2, -0.79, steel, 0, BORE_Y, 24);
  rbox(0.027, 0.024, 0.056, steel, 0, BORE_Y, -0.818, { r: 0.004, seg: 2 }); // тормоз
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i += 1) box(0.001, 0.016, 0.009, dark, side * 0.0136, BORE_Y, -0.801 - i * 0.015); // окна тормоза
  }
  tubeZ(0.004, 0.004, -0.846, -0.8465, dark, 0, BORE_Y, 12); // канал на срезе

  // ---- магазин
  rbox(0.024, 0.06, 0.08, polymer, 0, -0.022, -0.125, { r: 0.003, seg: 2 });
  rbox(0.028, 0.008, 0.086, polymer, 0, -0.054, -0.125, { r: 0.003, seg: 2 }); // пятка
  box(0.0014, 0.012, 0.012, dark, 0.0124, -0.035, -0.105); // окошко

  // ---- пистолетная рукоятка как у AR (резиненная), с бобром сверху и выступом под пальцы
  slab([
    [0.02, 0.004], [0.022, -0.012], [0.028, -0.035], [0.024, -0.05], [0.032, -0.064], [0.038, -0.1], [0.041, -0.112],
    [0.075, -0.106], [0.07, -0.07], [0.06, -0.025], [0.062, -0.006], [0.085, 0.003], [0.082, 0.008],
  ], [], 0.028, grip, { r: 0.006, radius: 0.006, depth: 0.008, segments: 3, curve: 4 });

  // ---- складной приклад-«скелет»: узел складывания, верхняя балка, щека на стойках, затыльник
  // с резиновой подушкой, нижняя планка, раскос к узлу, ручки регулировки
  rbox(0.032, 0.036, 0.034, alu, 0, 0.016, 0.095, { r: 0.004, seg: 2 }); // узел
  cylY(0.006, 0.04, alu, 0.014, 0.016, 0.11, 16); // шарнир
  rbox(0.024, 0.018, 0.18, alu, 0, 0.021, 0.2, { r: 0.004, seg: 2 }); // верхняя балка
  for (let i = 0; i < 6; i += 1) box(0.0012, 0.006, 0.014, dark, 0.0121, 0.021, 0.135 + i * 0.022); // облегчающие окна
  for (let i = 0; i < 6; i += 1) box(0.0012, 0.006, 0.014, dark, -0.0121, 0.021, 0.135 + i * 0.022);
  slab([[0.17, 0.042], [0.172, 0.06], [0.268, 0.061], [0.272, 0.042]], [], 0.032, polymer, { r: 0.006, radius: 0.005, depth: 0.007, segments: 3 }); // щека
  for (const z of [0.19, 0.25]) cylY(0.004, 0.014, steel, 0, 0.036, z, 12); // стойки щеки
  rbox(0.03, 0.125, 0.016, alu, 0, -0.004, 0.289, { r: 0.004, seg: 2 }); // плита затыльника
  rbox(0.02, 0.012, 0.11, alu, 0, -0.054, 0.23, { r: 0.003, seg: 2 }); // нижняя планка
  rbox(0.016, 0.012, 0.086, alu, 0, -0.026, 0.14, { r: 0.003, seg: 2, rx: 0.69 }); // раскос к узлу
  cylX(0.01, 0.042, polymer, 0, -0.012, 0.152, 24); // ручка длины приклада
  cylX(0.008, 0.038, polymer, 0, 0.021, 0.27, 20); // ручка высоты щеки
  cylY(0.007, 0.01, polymer, 0, -0.064, 0.25, 16); // упор под моно-сошку
  {
    // резиновая подушка: скруглённый прямоугольник (x, y), выдавленный назад по Z
    const pad = rounded(new THREE.Shape(), [[-0.022, -0.071], [0.022, -0.071], [0.022, 0.062], [-0.022, 0.062]], 0.014);
    let g = new THREE.ExtrudeGeometry(pad, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelOffset: -0.005, bevelSegments: 3, curveSegments: 6 });
    g = toCreasedNormals(g, THREE.MathUtils.degToRad(40));
    place(g, rubber, { z: 0.302 });
    for (let i = 0; i < 4; i += 1) box(0.046, 0.0015, 0.016, dark, 0, -0.045 + i * 0.03, 0.312); // рифление по бокам
  }

  // ---- спуск (свой узел)
  tag = 'trigger';
  box(0.006, 0.024, 0.007, accent, 0, -0.019, -0.012, { rx: 0.25 });
  // ---- затвор (свой узел, поворот вокруг оси канала): стебель, хвостовик, рукоятка с шаром справа
  tag = 'bolt';
  tubeZ(0.0125, 0.0125, -0.12, 0.078, steel, 0, BORE_Y, 20);
  tubeZ(0.0135, 0.0115, 0.078, 0.092, alu, 0, BORE_Y, 20); // хвостовик
  rod([0.008, BORE_Y, 0.06], [0.048, BORE_Y - 0.02, 0.072], 0.0045, steel);
  place(new THREE.SphereGeometry(0.011, 16, 12), polymer, { x: 0.052, y: BORE_Y - 0.023, z: 0.075 });

  // ---- оптический прицел (свой узел scope.node: ездит по планке, position.z — сдвиг)
  // Длинная труба 30 мм, колокол объектива 56 мм, окуляр с резиновым наглазником, высокий
  // вертикальный барабан, боковой, параллакс слева, два высоких кольца на планке; матовый чёрный.
  tag = 'scope';
  const sy = SCOPE_Y;
  lathe([
    [0.0265, -0.293], [0.0265, -0.3], [0.0292, -0.303], [0.0305, -0.298], [0.0305, -0.235], [0.028, -0.222],
    [0.0158, -0.19], [0.0158, -0.004], [0.019, 0.012], [0.0235, 0.02], [0.0235, 0.054], [0.021, 0.0545],
  ], scopeMat, sy, 40);
  lathe([[0.0228, 0.053], [0.025, 0.055], [0.0252, 0.068], [0.0238, 0.071], [0.0218, 0.069], [0.0216, 0.0556]], rubber, sy, 32); // наглазник
  for (const z of [-0.26, -0.248, 0.03, 0.038]) tubeZ(0.0308, 0.0308, z, z + 0.004, scopeMat, 0, sy, 40); // кольцевые рёбра колоколов
  tubeZ(0.019, 0.019, -0.112, -0.07, scopeMat, 0, sy, 28); // седло барабанов
  cylY(0.0145, 0.03, scopeMat, 0, sy + 0.019 + 0.015, -0.091, 32); // вертикальный барабан (высокий)
  cylY(0.0155, 0.005, scopeMat, 0, sy + 0.019 + 0.032, -0.091, 32); // его крышка
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    box(0.002, 0.012, 0.002, dark, Math.cos(a) * 0.0146, sy + 0.019 + 0.024, -0.091 + Math.sin(a) * 0.0146, { ry: -a }); // насечка
  }
  cylX(0.0135, 0.024, scopeMat, 0.019 + 0.012, sy, -0.091, 28); // горизонтальный (справа)
  cylX(0.0115, 0.018, scopeMat, -0.019 - 0.009, sy, -0.091, 24); // параллакс (слева)
  cylX(0.0045, 0.004, dark, 0.019 + 0.0245, sy, -0.091, 12); // метка
  for (const z of SCOPE_RINGS) {
    tubeZ(0.0195, 0.0195, z - 0.011, z + 0.011, scopeMat, 0, sy, 32); // кольцо
    rbox(0.026, 0.022, 0.018, scopeMat, 0, RAIL_TOP + 0.011, z, { r: 0.003, seg: 2 }); // высокая стойка
    rbox(0.034, 0.008, 0.022, scopeMat, 0, RAIL_TOP + 0.003, z, { r: 0.002 }); // зажим на планке
    cylX(0.0035, 0.04, steel, 0, RAIL_TOP + 0.003, z, 10); // поперечный болт
    for (const side of [-1, 1]) cylX(0.0025, 0.004, steel, side * 0.0205, sy + 0.012, z - 0.006, 8); // винты крышки
  }
  tag = null;

  // ---- сборка: детали одного материала и узла — одним мешом
  const trigger = { pivot: new THREE.Object3D(), maxAngle: 0.35 };
  trigger.pivot.position.set(0, -0.007, -0.012);
  const bolt = { pivot: new THREE.Object3D(), travel: 0.07, lift: 1.2, tmp: new THREE.Vector3(), shotAt: 0, events: 0 };
  bolt.pivot.position.set(0, BORE_Y, 0);
  const scopeNode = new THREE.Group();
  scopeNode.position.z = SCOPE_DEFAULT_Z;
  group.add(trigger.pivot, bolt.pivot, scopeNode);
  const holders = { trigger: trigger.pivot, bolt: bolt.pivot, scope: scopeNode };
  const byKey = new Map();
  for (const part of parts) {
    const key = part.material.uuid + (part.tag ?? '');
    if (!byKey.has(key)) byKey.set(key, { material: part.material, tag: part.tag, geometries: [] });
    byKey.get(key).geometries.push(part.geometry.clone().translate(part.center.x, part.center.y, part.center.z));
  }
  let triangles = 0;
  for (const { material, tag: owner, geometries } of byKey.values()) {
    const merged = mergeGeometries(geometries);
    triangles += merged.attributes.position.count / 3;
    if (owner && owner !== 'scope') { // у прицела узел только сдвигается (геометрия — при сдвиге 0)
      const p = holders[owner].position;
      merged.translate(-p.x, -p.y, -p.z);
    }
    (owner ? holders[owner] : group).add(new THREE.Mesh(merged, material));
    geometries.forEach((g) => g.dispose());
  }
  group.userData.triangles = triangles;

  // обводка: каждая деталь растянута от своего центра на outlineM (как у пистолета); у прицела своя
  // (ездит вместе с ним: scope.outlineGeometry); мелочь (прорези, насечки) не нужна
  const shellsOf = (list) => {
    const size = new THREE.Vector3();
    return mergeGeometries(list.map(({ geometry, center }) => {
      geometry.boundingBox.getSize(size);
      const g = geometry.clone()
        .scale(1 + (outlineM * 2) / Math.max(size.x, 1e-4), 1 + (outlineM * 2) / Math.max(size.y, 1e-4), 1 + (outlineM * 2) / Math.max(size.z, 1e-4))
        .translate(center.x, center.y, center.z);
      const only = new THREE.BufferGeometry();
      only.setAttribute('position', g.attributes.position);
      return only;
    }));
  };
  let outlineGeometry = null;
  let scopeOutline = null;
  if (outlineM > 0) {
    const big = (p) => p.material !== dark && p.tag !== 'trigger';
    outlineGeometry = shellsOf(parts.filter((p) => big(p) && p.tag !== 'scope'));
    scopeOutline = shellsOf(parts.filter((p) => big(p) && p.tag === 'scope'));
  }
  parts.forEach((p) => p.geometry.dispose());

  return {
    group,
    accent,
    outlineGeometry,
    trigger,
    bolt,
    rail: { top: RAIL_TOP, from: RAIL_FROM, to: RAIL_TO },
    // прицел: node — его узел (position.z — сдвиг по планке, minZ..maxZ); стёкла — на оси y: окуляр
    // в eyepieceZ (смотрит назад, радиус lensR), объектив в objectiveZ радиусом objectiveR;
    // outlineGeometry — его обводка (ставится в node)
    scope: {
      node: scopeNode, y: SCOPE_Y, eyepieceZ: 0.0535, objectiveZ: -0.293, objectiveR: 0.0265, lensR: 0.021,
      minZ: SCOPE_MIN_Z, maxZ: SCOPE_MAX_Z, defaultZ: SCOPE_DEFAULT_Z, outlineGeometry: scopeOutline,
    },
    muzzle: new THREE.Vector3(0, BORE_Y, -0.847),
    ejector: new THREE.Vector3(0.018, BORE_Y + 0.006, -0.035), // окно выброса справа
  };
}
