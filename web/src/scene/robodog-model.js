// Робопёс: low-poly модель в духе Boston Dynamics Spot (~0,9 м длиной, ~0,6 м в холке сзади).
// Жёлтый корпус с чёрной рамой, спереди сенсорная голова с голубой светящейся полосой «глаз»,
// четыре ноги: тазовый узел → бедро → колено → голень со стопой. Скиннинга нет: каждая часть —
// свой шарнир (Object3D), неподвижные детали слиты в один меш на шарнир. Цвета — в вершинах (один
// материал на всё тело), глаза — свой светящийся материал. Итого 10 вызовов отрисовки.
//
// Система: вперёд −Z, вправо +X, вверх +Y. buildRobodog(THREE) → { group, body, eye, material,
// eyeMaterial, legs: [{ hip, upper, knee }] ×4 (ЛП, ПП, ЛЗ, ПЗ), setPose(pose), dispose() };
// pose — как из createGait (robodog-gait.js).
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HIPS, L1, L2, FOOT_R } from './robodog-gait.js';

const YELLOW = 0xf2b807;
const BLACK = 0x1b1c1f;
const DARK = 0x3a3d42; // шарниры, стопы
const RUBBER = 0x111112;

export function buildRobodog(THREE) {
  const color = new THREE.Color();
  // деталь: геометрия без индексов и uv, с цветом в вершинах
  const part = (hex, geometry, list) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    g.deleteAttribute('uv');
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
  const box = (hex, list, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return part(hex, g, list);
  };
  // цилиндр-шарнир вдоль оси X
  const joint = (hex, list, r, len, x, y, z) => {
    const g = new THREE.CylinderGeometry(r, r, len, 10);
    g.rotateZ(Math.PI / 2);
    g.translate(x, y, z);
    return part(hex, g, list);
  };
  const merged = (list) => {
    const g = mergeGeometries(list);
    for (const p of list) p.dispose();
    g.computeBoundingSphere();
    return g;
  };

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15, flatShading: true });
  material.emissive.setRGB(0, 0, 0); // вспышка от попадания (robodog.js)
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x45e8ff, toneMapped: false });

  const group = new THREE.Group();
  group.name = 'robodog';
  const body = new THREE.Object3D();
  group.add(body);

  // ---- корпус
  const b = [];
  box(BLACK, b, 0.21, 0.09, 0.66, 0, -0.035, 0); // рама и брюхо
  box(YELLOW, b, 0.2, 0.08, 0.58, 0, 0.03, 0.005); // жёлтый кожух
  box(YELLOW, b, 0.16, 0.03, 0.5, 0, 0.08, 0.01); // крышка
  box(YELLOW, b, 0.035, 0.03, 0.5, 0.083, 0.068, 0.01, 0, 0, -0.6); // скосы крышки
  box(YELLOW, b, 0.035, 0.03, 0.5, -0.083, 0.068, 0.01, 0, 0, 0.6);
  box(BLACK, b, 0.006, 0.022, 0.42, 0.101, 0.035, 0.02); // чёрные полосы по бокам
  box(BLACK, b, 0.006, 0.022, 0.42, -0.101, 0.035, 0.02);
  // рейки сверху и ручка
  box(DARK, b, 0.014, 0.014, 0.36, 0.055, 0.102, 0.02);
  box(DARK, b, 0.014, 0.014, 0.36, -0.055, 0.102, 0.02);
  box(DARK, b, 0.124, 0.014, 0.014, 0, 0.102, -0.16);
  box(DARK, b, 0.124, 0.014, 0.014, 0, 0.102, 0.2);
  // сенсорная голова спереди: чёрный блок со скошенным лбом
  box(BLACK, b, 0.19, 0.085, 0.1, 0, 0.0, -0.345);
  box(BLACK, b, 0.17, 0.04, 0.1, 0, 0.05, -0.335, -0.35);
  box(DARK, b, 0.13, 0.03, 0.03, 0, -0.035, -0.39); // нижняя губа
  // задний бампер с фонарём
  box(BLACK, b, 0.18, 0.07, 0.06, 0, 0.0, 0.33);
  // крепления ног на корпусе
  for (const [x, y, z] of HIPS) box(DARK, b, 0.04, 0.07, 0.09, Math.sign(x) * 0.098, y, z);
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
    joint(DARK, u, 0.048, 0.06, side * 0.012, 0, 0); // мотор бедра
    box(YELLOW, u, 0.05, L1 - 0.02, 0.07, side * 0.012, -L1 / 2 + 0.005, 0); // бедро
    box(BLACK, u, 0.006, L1 * 0.6, 0.045, side * 0.04, -L1 / 2, 0); // накладка снаружи
    box(YELLOW, u, 0.04, 0.05, 0.06, side * 0.012, -L1 + 0.02, 0.004); // утолщение у колена
    upperGeometry.push(merged(u));
    const l = [];
    joint(DARK, l, 0.03, 0.05, side * 0.012, 0, 0); // колено
    box(BLACK, l, 0.03, L2 - 0.02, 0.036, side * 0.012, -L2 / 2, 0.004); // голень
    box(BLACK, l, 0.024, L2 * 0.5, 0.026, side * 0.012, -L2 * 0.68, -0.006); // сужение к стопе
    const foot = new THREE.IcosahedronGeometry(FOOT_R, 1);
    foot.translate(side * 0.012, -L2, 0);
    part(RUBBER, foot, l);
    lowerGeometry.push(merged(l));
  }

  const legs = HIPS.map(([x, y, z], i) => {
    const side = x < 0 ? 0 : 1;
    const hip = new THREE.Object3D();
    hip.position.set(x, y, z);
    body.add(hip);
    const upper = new THREE.Object3D();
    hip.add(upper);
    const upperMesh = new THREE.Mesh(upperGeometry[side], material);
    upperMesh.name = `robodog-upper-${i}`;
    upper.add(upperMesh);
    const knee = new THREE.Object3D();
    knee.position.set(0, -L1, 0);
    upper.add(knee);
    const lowerMesh = new THREE.Mesh(lowerGeometry[side], material);
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
