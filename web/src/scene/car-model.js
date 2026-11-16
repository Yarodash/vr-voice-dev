// Машина: угловатый немецкий седан конца 80-х (по мотивам E30), в натуральную величину, low-poly.
// Без эмблем. Перед машины — к −Z, правый бок — к +X, начало координат — на земле посередине между
// осями. Неподвижные части слиты по материалам; колёса, поворотные кулаки и руль — отдельные группы.
//
// buildCar(THREE) → { group, wheels[4], frontWheelPivots[2], steeringWheel, setSteer(-1..1),
//   setWheelSpin(рад/с), update(dt), dispose() }
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WHEELBASE = 2.7;
const TRACK = 0.71; // половина колеи (центр колеса по X)
const WHEEL_R = 0.305; // 195/65 R14
const WHEEL_W = 0.195;
const ARCH_R = 0.36;
const HALF_W = 0.825; // половина ширины кузова
const SLAB = 0.08; // толщина боковины
const BELT = 0.84; // линия окон
const ROOF = 1.37;
const MAX_STEER = THREE_DEG(35);
const WHEEL_TURNS = 1.5; // оборотов руля от центра до упора

function THREE_DEG(d) {
  return (d * Math.PI) / 180;
}

export function buildCar(THREE) {
  const parts = {}; // материал → геометрии
  const mats = {
    paint: new THREE.MeshStandardMaterial({ color: 0x6a0f16, roughness: 0.38, metalness: 0.1, flatShading: true }),
    trim: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.7, metalness: 0, flatShading: true }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.22, metalness: 0.35, flatShading: true }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1c2a33, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.32, depthWrite: false }),
    inside: new THREE.MeshStandardMaterial({ color: 0x2a2a2d, roughness: 0.9, metalness: 0, flatShading: true }),
    seat: new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.95, metalness: 0, flatShading: true }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff6dc, roughness: 0.2, emissive: 0x3a3428, flatShading: true }),
    tail: new THREE.MeshStandardMaterial({ color: 0xb01010, roughness: 0.3, emissive: 0x3a0000, flatShading: true }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, metalness: 0, flatShading: true }),
    rim: new THREE.MeshStandardMaterial({ color: 0xa9adb2, roughness: 0.35, metalness: 0.3, flatShading: true }),
  };
  const add = (mat, geometry) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    g.clearGroups();
    (parts[mat] ??= []).push(g);
    return g;
  };
  const box = (mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateX(rx);
    g.rotateY(ry);
    g.rotateZ(rz);
    g.translate(x, y, z);
    return add(mat, g);
  };
  // брусок от точки a до точки b
  const up = new THREE.Vector3(0, 1, 0);
  const bar = (mat, a, b, t) => {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const g = new THREE.BoxGeometry(t, A.distanceTo(B), t);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, B.clone().sub(A).normalize()));
    g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    return add(mat, g);
  };
  // сужение кверху (заваленные внутрь стёкла): выше линии окон x сжимается до 85 % у крыши
  const taperX = (x, y) => x * (1 - 0.15 * Math.min(1, Math.max(0, (y - BELT) / (ROOF - BELT))));
  const taper = (g) => {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i += 1) p.setX(i, taperX(p.getX(i), p.getY(i)));
    return g;
  };
  // Профиль сбоку (u = z, v = y) → выдавливание по ширине: x от x0 до x0 + depth
  const extrude = (points, x0, depth) => {
    const shape = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    g.rotateY(-Math.PI / 2); // (u, v, w) → (x = −w, y = v, z = u)
    g.translate(x0 + depth, 0, 0);
    return g;
  };
  // обрезать многоугольник по u ∈ [a, b] (Сазерленд — Ходжман)
  const clip = (points, a, b) => {
    const cut = (pts, inside, at) => {
      const out = [];
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        const pin = inside(p);
        const qin = inside(q);
        if (pin) out.push(p);
        if (pin !== qin) {
          const t = (at - p[0]) / (q[0] - p[0]);
          out.push([at, p[1] + (q[1] - p[1]) * t]);
        }
      }
      return out;
    };
    return cut(cut(points, (p) => p[0] >= a, a), (p) => p[0] <= b, b);
  };

  // ---- кузов: профиль сбоку с арками колёс
  const SILL = 0.25;
  const arch = (zc) => {
    const pts = [];
    const start = -Math.asin((WHEEL_R - SILL) / ARCH_R); // где арка встречает порог
    const end = Math.PI - start;
    const N = 7;
    // профиль обходится снизу сзади наперёд: арка от заднего края к переднему (против часовой)
    for (let i = 0; i <= N; i += 1) {
      const a = start + ((end - start) * i) / N;
      pts.push([zc + ARCH_R * Math.cos(a), WHEEL_R + ARCH_R * Math.sin(a)]);
    }
    return pts;
  };
  const F = -WHEELBASE / 2;
  const R = WHEELBASE / 2;
  const profile = [
    [-2.2, SILL + 0.02],
    [-2.23, 0.62],
    [-2.16, 0.72],
    [-0.78, BELT],
    [1.46, BELT + 0.02],
    [2.2, 0.83],
    [2.3, 0.75],
    [2.3, 0.3],
    [2.22, SILL],
    ...arch(R),
    ...arch(F),
  ];
  // боковины (с порогами) — тонкие, между ними салон открыт сверху (его закрывают стёкла)
  add('paint', extrude(profile, HALF_W - SLAB, SLAB));
  add('paint', extrude(profile, -HALF_W, SLAB));
  // капот и багажник — на всю ширину между боковинами
  add('paint', extrude(clip(profile, -3, -0.78), -HALF_W + SLAB, 2 * (HALF_W - SLAB)));
  add('paint', extrude(clip(profile, 1.46, 3), -HALF_W + SLAB, 2 * (HALF_W - SLAB)));
  // Колёсам — свободное место: |x| ≥ 0,43, z = ось ± 0,37, y ≤ 0,67 (переднее колесо, повёрнутое на
  // 35°, заходит внутрь до |x| ≈ 0,46). Туда не заходит ничего, кроме стенок ниш.
  const CLEAR = ARCH_R + 0.01;
  // днище: середина во всю длину, бока — только между арками и на свесах
  box('trim', 0.8, 0.06, 4.4, 0, SILL + 0.02, 0.03);
  for (const s of [-1, 1]) {
    for (const [z0, z1] of [
      [-2.18, F - CLEAR],
      [F + CLEAR, R - CLEAR],
      [R + CLEAR, 2.26],
    ]) box('trim', HALF_W - 0.41, 0.06, z1 - z0, s * (0.4 + (HALF_W - 0.41) / 2), SILL + 0.02, (z0 + z1) / 2);
    // внутренние стенки ниш (закрывают сквозной проём арки в капоте и багажнике)
    box('trim', 0.02, 0.42, 2 * ARCH_R, s * 0.42, SILL + 0.21, F);
    // задние не поворачиваются: ниша уже, до |x| = 0,58; в салоне она — короб под обивкой
    box('trim', 0.02, 0.45, 2 * ARCH_R, s * 0.58, SILL + 0.225, R);
  }

  // ---- стёкла: одна «теплица» (лобовое, боковые, заднее), без нижней грани
  const glassProfile = [
    [-0.78, BELT],
    [-0.17, ROOF],
    [1.0, ROOF],
    [1.48, BELT + 0.02],
  ];
  {
    const g = taper(extrude(glassProfile, -0.8, 1.6)); // ExtrudeGeometry — уже без индекса
    const p = g.attributes.position;
    const keep = [];
    for (let i = 0; i < p.count; i += 3) {
      const low = [0, 1, 2].every((k) => p.getY(i + k) < BELT + 0.025);
      if (!low) keep.push(i);
    }
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const src = g.attributes[name];
      const arr = new Float32Array(keep.length * 3 * src.itemSize);
      keep.forEach((i, n) => {
        for (let k = 0; k < 3 * src.itemSize; k += 1) arr[n * 3 * src.itemSize + k] = src.array[i * src.itemSize + k];
      });
      out.setAttribute(name, new THREE.BufferAttribute(arr, src.itemSize));
    }
    g.dispose();
    add('glass', out);
  }
  // крыша, стойки
  add('paint', taper(new THREE.BoxGeometry(1.64, 0.04, 1.22).translate(0, ROOF + 0.015, 0.42)));
  for (const s of [-1, 1]) {
    // A-стойка вдоль края лобового
    bar('paint', [s * taperX(0.815, BELT), BELT, -0.78], [s * taperX(0.815, ROOF), ROOF, -0.17], 0.06);
    // B-стойка (чёрная)
    bar('trim', [s * taperX(0.815, BELT), BELT, 0.15], [s * taperX(0.815, ROOF), ROOF, 0.15], 0.07);
    // C-стойка с «изломом» у заднего бокового окна
    const c = [
      [0.8, BELT + 0.01],
      [1.47, BELT + 0.02],
      [1.0, ROOF],
      [0.6, ROOF],
      [0.8, 1.04],
    ];
    add('paint', taper(extrude(c, s > 0 ? 0.802 : -0.822, 0.02)));
    // зеркала
    box('trim', 0.12, 0.08, 0.07, s * 0.89, 0.93, -0.62);
    // молдинг по борту — три куска между арками
    for (const [z0, z1] of [
      [-2.15, F - ARCH_R - 0.02],
      [F + ARCH_R + 0.02, R - ARCH_R - 0.02],
      [R + ARCH_R + 0.02, 2.26],
    ]) box('trim', 0.02, 0.05, z1 - z0, s * (HALF_W + 0.006), 0.56, (z0 + z1) / 2);
    // хромовая окантовка окон по линии пояса и ручки дверей
    box('chrome', 0.015, 0.015, 2.25, s * (HALF_W - 0.01), BELT + 0.01, 0.35);
    box('chrome', 0.015, 0.025, 0.14, s * (HALF_W + 0.006), 0.76, -0.12);
    box('chrome', 0.015, 0.025, 0.14, s * (HALF_W + 0.006), 0.76, 0.95);
  }

  // ---- перед: плоская маска, двойные круглые фары, решётка, хромовый бампер
  box('trim', 1.52, 0.2, 0.02, 0, 0.6, -2.228);
  for (const x of [-0.58, -0.36, 0.36, 0.58]) {
    add('lamp', new THREE.CylinderGeometry(0.07, 0.07, 0.03, 10).rotateX(Math.PI / 2).translate(x, 0.6, -2.235));
    add('chrome', new THREE.CylinderGeometry(0.082, 0.082, 0.02, 10).rotateX(Math.PI / 2).translate(x, 0.6, -2.229));
  }
  box('chrome', 0.3, 0.19, 0.012, 0, 0.6, -2.236); // рамка решётки (общая, без эмблем)
  box('trim', 0.26, 0.15, 0.012, 0, 0.6, -2.242);
  box('chrome', 1.68, 0.06, 0.08, 0, 0.42, -2.25);
  box('trim', 1.6, 0.12, 0.06, 0, 0.33, -2.22);
  box('lamp', 0.16, 0.05, 0.02, -0.6, 0.33, -2.255);
  box('lamp', 0.16, 0.05, 0.02, 0.6, 0.33, -2.255);
  // ---- зад: квадратные фонари, номер, бампер
  for (const s of [-1, 1]) box('tail', 0.5, 0.15, 0.02, s * 0.53, 0.66, 2.305);
  box('trim', 0.56, 0.15, 0.015, 0, 0.66, 2.302);
  box('chrome', 0.52, 0.11, 0.012, 0, 0.5, 2.305);
  box('chrome', 1.68, 0.06, 0.08, 0, 0.4, 2.34);
  box('trim', 1.6, 0.12, 0.06, 0, 0.31, 2.31);

  // ---- салон
  const IN = HALF_W - SLAB;
  const RW = R - CLEAR + 0.02; // передний край задней ниши в салоне (0,99)
  box('inside', 2 * IN, 0.06, RW + 0.78, 0, 0.3, (RW - 0.78) / 2); // пол
  box('inside', 1.16, 0.06, 1.46 - RW, 0, 0.3, (RW + 1.46) / 2); // пол между задними нишами
  for (const s of [-1, 1]) {
    box('inside', 0.02, 0.52, RW + 0.78, s * (IN - 0.01), 0.58, (RW - 0.78) / 2); // обивка дверей
    box('inside', 0.02, 0.14, 1.46 - RW, s * (IN - 0.01), 0.77, (RW + 1.46) / 2); // над нишей
    // короб задней ниши в салоне: стенка, перед, крышка (колесо внутри не задевает)
    box('inside', 0.02, 0.42, 1.46 - RW, s * 0.58, 0.49, (RW + 1.46) / 2);
    box('inside', IN - 0.58, 0.42, 0.02, s * (0.58 + IN) / 2, 0.49, RW);
    box('inside', IN - 0.58 + 0.02, 0.02, 1.46 - RW, s * (0.58 + IN) / 2, 0.7, (RW + 1.46) / 2);
  }
  box('inside', 2 * IN, 0.28, 0.45, 0, 0.83, -0.6); // торпедо
  box('inside', 0.42, 0.09, 0.14, -0.37, 1.0, -0.44); // козырёк приборов
  for (const x of [-0.47, -0.27]) add('chrome', new THREE.CylinderGeometry(0.06, 0.06, 0.01, 10).rotateX(Math.PI / 2).translate(x, 0.965, -0.372));
  box('inside', 0.22, 0.4, 0.1, 0, 0.66, -0.42); // центральная консоль
  box('inside', 0.22, 0.2, 0.62, 0, 0.42, -0.08);
  box('trim', 0.16, 0.06, 0.16, 0, 0.53, -0.05); // чехол рычага
  bar('trim', [0, 0.54, -0.05], [0, 0.72, 0.0], 0.018); // рычаг КПП
  box('trim', 0.045, 0.045, 0.045, 0, 0.73, 0.005);
  for (const x of [-0.37, 0.37]) {
    box('seat', 0.5, 0.13, 0.5, x, 0.46, 0.05);
    box('seat', 0.5, 0.62, 0.12, x, 0.82, 0.36, 0.22);
    box('seat', 0.26, 0.16, 0.1, x, 1.2, 0.45, 0.22);
  }
  box('seat', 1.14, 0.13, 0.5, 0, 0.48, 0.92); // задний диван — между нишами
  box('seat', 1.14, 0.55, 0.12, 0, 0.8, 1.2, 0.3);
  // рулевая колонка: от торпедо к водителю, ~27° к горизонту
  const COL_A = new THREE.Vector3(-0.37, 0.86, -0.62);
  const COL_B = new THREE.Vector3(-0.37, 0.99, -0.36);
  bar('trim', COL_A.toArray(), COL_B.toArray(), 0.05);

  // ---- сборка неподвижного
  const group = new THREE.Group();
  group.name = 'car';
  const meshes = [];
  for (const [mat, list] of Object.entries(parts)) {
    const mesh = new THREE.Mesh(mergeGeometries(list), mats[mat]);
    list.forEach((g) => g.dispose());
    if (mat === 'glass') mesh.renderOrder = 1;
    meshes.push(mesh);
    group.add(mesh);
  }

  // ---- руль: обод, три спицы, ступица — один меш в группе, крутится вокруг оси колонки (свой Z)
  const steerMount = new THREE.Group();
  steerMount.position.copy(COL_B).addScaledVector(COL_B.clone().sub(COL_A).normalize(), 0.03);
  const colAngle = Math.atan2(COL_B.y - COL_A.y, COL_B.z - COL_A.z);
  steerMount.rotation.x = -colAngle; // свой +Z смотрит вдоль колонки на водителя
  const steeringWheel = new THREE.Group();
  {
    const geos = [new THREE.TorusGeometry(0.19, 0.016, 5, 14)];
    for (const a of [-Math.PI / 2, -0.15, Math.PI + 0.15]) {
      // спицы: вниз и в стороны
      geos.push(new THREE.BoxGeometry(0.17, 0.03, 0.012).translate(0.095, 0, 0).rotateZ(a));
    }
    geos.push(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 8).rotateX(Math.PI / 2));
    const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      return g;
    }));
    geos.forEach((g) => g.dispose());
    steeringWheel.add(new THREE.Mesh(merged, mats.trim));
  }
  steerMount.add(steeringWheel);
  group.add(steerMount);

  // ---- колёса
  const wheelGeometry = (side) => {
    const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 12, 1, false).rotateZ(Math.PI / 2);
    const rims = [new THREE.CylinderGeometry(0.19, 0.19, WHEEL_W + 0.01, 10).rotateZ(Math.PI / 2)];
    for (let k = 0; k < 5; k += 1) {
      rims.push(new THREE.BoxGeometry(0.02, 0.15, 0.04).translate(side * 0.1, 0.085, 0).rotateX((k * 2 * Math.PI) / 5));
    }
    rims.push(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 8).rotateZ(Math.PI / 2).translate(side * 0.105, 0, 0));
    const rim = mergeGeometries(rims.map((g) => g.toNonIndexed()));
    rims.forEach((g) => g.dispose());
    return { tyre, rim };
  };
  const wheelGeo = { [-1]: wheelGeometry(-1), [1]: wheelGeometry(1) };
  const wheels = [];
  const frontWheelPivots = [];
  for (const [z, front] of [
    [F, true],
    [R, false],
  ]) {
    for (const s of [-1, 1]) {
      const wheel = new THREE.Group();
      wheel.add(new THREE.Mesh(wheelGeo[s].tyre, mats.tyre), new THREE.Mesh(wheelGeo[s].rim, mats.rim));
      if (front) {
        const pivot = new THREE.Group();
        pivot.position.set(s * TRACK, WHEEL_R, z);
        pivot.add(wheel);
        frontWheelPivots.push(pivot);
        group.add(pivot);
      } else {
        wheel.position.set(s * TRACK, WHEEL_R, z);
        group.add(wheel);
      }
      wheels.push(wheel);
    }
  }

  // ---- мягкая тень под машиной (пятно), чуть к −X (солнце низко справа)
  const shadowTexture = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 128;
    const g = canvas.getContext('2d');
    g.translate(32, 64);
    g.scale(1, 2);
    const grad = g.createRadialGradient(0, 0, 4, 0, 0, 32);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.75)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(-32, -32, 64, 64);
    return new THREE.CanvasTexture(canvas);
  })();
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, opacity: 0.75, depthWrite: false, color: 0x000000 });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 5.4).rotateX(-Math.PI / 2), shadowMat);
  shadow.position.y = 0.015;
  group.add(shadow);

  let spin = 0;
  const setSteer = (s) => {
    const v = Math.max(-1, Math.min(1, s));
    for (const pivot of frontWheelPivots) pivot.rotation.y = -v * MAX_STEER; // + — вправо
    steeringWheel.rotation.z = v * WHEEL_TURNS * 2 * Math.PI;
  };
  const setWheelSpin = (radPerSec) => {
    spin = radPerSec;
  };

  return {
    group,
    wheels,
    frontWheelPivots,
    steeringWheel,
    setSteer,
    setWheelSpin,
    update(dt) {
      if (!spin) return;
      for (const wheel of wheels) wheel.rotation.x -= spin * dt; // + — вперёд (к −Z)
    },
    dispose() {
      group.removeFromParent();
      for (const mesh of meshes) mesh.geometry.dispose();
      steeringWheel.children[0].geometry.dispose();
      for (const s of [-1, 1]) {
        wheelGeo[s].tyre.dispose();
        wheelGeo[s].rim.dispose();
      }
      shadow.geometry.dispose();
      shadowTexture.dispose();
      shadowMat.dispose();
      for (const m of Object.values(mats)) m.dispose();
    },
  };
}
