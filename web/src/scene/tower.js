// Вышка: игрок стоит на площадке на высоте TOWER_H и стреляет сверху (пункт меню «Вышка: вкл/выкл»).
//
// Деревянная вышка: 4 наклонные ноги на бетонных подушках, горизонтальные связи и стальные
// крестовые растяжки, площадка 3,2 × 3,2 м из досок, перила — верхняя широкая доска на высоте
// RAIL_H над полом (на неё удобно положить винтовку), лестница сзади (+Z), перед перил — к −Z
// («вперёд» мира, откуда бегут псы). Крыши нет — небо не загораживает.
//
// Дёшево: геометрия слита по материалам (дерево, сталь, бетон) — 3 вызова отрисовки + тень. Тень —
// плоская проекция вдоль луча солнца (то же солнце, что у теней травы и мишеней), нарисованная один
// раз на canvas и положенная на землю квадратом, который умножает землю (как тени мишеней).
// Геометрия и текстура тени кэшируются в __sceneState по исходнику строителя (подмена сцены не
// пересобирает и не перезагружает их в GPU).
//
// Игрок: rig оболочки (родитель камеры) поднимается на TOWER_H, пока вышка включена. Чтобы это было
// надёжно, «поднят ли rig» решается по его высоте (без вышки rig около 0: local-floor; на вышке —
// около TOWER_H), поэтому повторное включение/выключение, перезагрузка (rig сохранён в 'vr.rig' уже
// поднятым) и «Отцентрировать» (оболочка ставит rig заново, сцена потом поднимает) не накапливают
// сдвиг. Вышка ставится под голову в момент включения и после «Отцентрировать».
// Состояние: localStorage 'scene.tower' = { on, x, z, h } (h — на сколько поднят rig), __sceneState.towerOn,
// __sceneState.playerElevation (метры над землёй: читает стая, robodog-horde.js), ручка __sceneState.tower.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundAt } from './targets.js';

export const TOWER_H = 8; // верх пола площадки над землёй, м
const RAIL_H = 1.05; // верх перил над полом
const HALF = 1.6; // половина площадки
const FOOT = 2.1; // ноги внизу: ±FOOT по X и Z
const TOP = 1.42; // ноги вверху (под площадкой)
const KEY = 'scene.tower';
const RIG_KEY = 'vr.rig';

const SUN_AZIMUTH = -8; // как в world.js / targets.js
const SHADOW_ELEVATION = 22;
const SHADOW_DARK = 0.3; // линейная яркость тени (как у мишеней)
const WOOD_M = 0.5; // текстура дерева покрывает 0,5 × 0,5 м
const WOOD_URL = `${import.meta.env.BASE_URL}textures/wood/rough_wood_`;

// Строит геометрию (по материалам) и тень. Вызывается один раз на версию этого кода.
function buildTower(THREE) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const wood = [];
  const steel = [];
  const concrete = [];
  const basis = new THREE.Matrix4();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647); // своё зерно: одинаково каждую сборку

  // UV в метрах, волокна вдоль локальной Y (длина бруса)
  const woodUv = (geometry) => {
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    const du = rnd();
    const dv = rnd();
    for (let i = 0; i < pos.count; i += 1) {
      const nx = Math.abs(nor.getX(i));
      const ny = Math.abs(nor.getY(i));
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (ny > 0.5) uv.setXY(i, x / WOOD_M + du, z / WOOD_M + dv); // торец
      else uv.setXY(i, (nx > 0.5 ? z : x) / WOOD_M + du, y / WOOD_M + dv);
    }
  };
  // ставит геометрию, вытянутую по локальной Y и с центром в 0, между точками a и b; hint — куда
  // смотрит локальная Z (поперёк длины)
  const orient = (geometry, a, b, hint) => {
    ay.subVectors(b, a).normalize();
    az.copy(hint).addScaledVector(ay, -hint.dot(ay));
    if (az.lengthSq() < 1e-6) az.set(1, 0, 0).addScaledVector(ay, -ay.x);
    az.normalize();
    ax.crossVectors(ay, az);
    basis.makeBasis(ax, ay, az).setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    geometry.applyMatrix4(basis);
    return geometry;
  };
  const Z_HINT = V(0, 0, 1);
  const UP = V(0, 1, 0);
  // брус: сечение w (по локальной X) × d (по hint)
  const beam = (a, b, w, d, hint = Z_HINT) => {
    const g = new THREE.BoxGeometry(w, a.distanceTo(b), d);
    woodUv(g);
    wood.push(orient(g, a, b, hint));
  };
  // ящик по осям мира: центр и размеры
  const box = (list, cx, cy, cz, sx, sy, sz) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (list === wood) woodUv(g);
    g.translate(cx, cy, cz);
    list.push(g);
  };
  const rod = (a, b, r, list = steel, seg = 6) => list.push(orient(new THREE.CylinderGeometry(r, r, a.distanceTo(b), seg, 1), a, b, Z_HINT));

  // ---- ноги: от бетонной подушки к углу под площадкой
  const FLOOR_Y = TOWER_H;
  const RIM_Y = FLOOR_Y - 0.05 - 0.1; // центр обвязки площадки
  const LEG_BOTTOM = 0.3;
  const LEG_TOP = FLOOR_Y - 0.25;
  const legAt = (sx, sz, y) => {
    const t = (y - LEG_BOTTOM) / (LEG_TOP - LEG_BOTTOM);
    const r = FOOT + (TOP - FOOT) * t;
    return V(sx * r, y, sz * r);
  };
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of corners) {
    const bottom = legAt(sx, sz, LEG_BOTTOM);
    const top = legAt(sx, sz, LEG_TOP);
    beam(bottom, top, 0.24, 0.24, V(sx, 0, sz).normalize());
    box(concrete, sx * FOOT, 0.1, sz * FOOT, 0.62, 0.4, 0.62); // подушка (чуть в земле)
    box(steel, sx * FOOT, 0.31, sz * FOOT, 0.4, 0.025, 0.4); // опорная плита
    // башмак и хомуты на ногах (сталь чуть шире бруса)
    for (const y of [0.45, 2.8, 5.5, LEG_TOP - 0.12]) {
      const c = legAt(sx, sz, y);
      const g = new THREE.BoxGeometry(0.29, y === 0.45 ? 0.28 : 0.16, 0.29);
      steel.push(orient(g, c.clone().addScaledVector(UP, -0.08), c.clone().addScaledVector(UP, 0.08), V(sx, 0, sz).normalize()));
    }
  }
  // ---- связи и растяжки по четырём граням
  const LEVELS = [0.45, 2.8, 5.5, LEG_TOP - 0.12];
  const faces = [
    { a: [-1, -1], b: [1, -1], n: V(0, 0, -1) }, // перед
    { a: [1, -1], b: [1, 1], n: V(1, 0, 0) },
    { a: [1, 1], b: [-1, 1], n: V(0, 0, 1) }, // зад (лестница)
    { a: [-1, 1], b: [-1, -1], n: V(-1, 0, 0) },
  ];
  for (const face of faces) {
    for (const y of [2.8, 5.5]) {
      beam(legAt(face.a[0], face.a[1], y), legAt(face.b[0], face.b[1], y), 0.14, 0.1, face.n); // связь
    }
    for (let i = 0; i < LEVELS.length - 1; i += 1) {
      const out = face.n.clone().multiplyScalar(0.15); // растяжки снаружи ног
      const a0 = legAt(face.a[0], face.a[1], LEVELS[i] + 0.1).add(out);
      const b0 = legAt(face.b[0], face.b[1], LEVELS[i] + 0.1).add(out);
      const a1 = legAt(face.a[0], face.a[1], LEVELS[i + 1] - 0.1).add(out);
      const b1 = legAt(face.b[0], face.b[1], LEVELS[i + 1] - 0.1).add(out);
      rod(a0, b1, 0.022);
      rod(b0, a1, 0.022);
      // стяжная шайба на перекрестье
      const mid = a0.clone().add(b1).add(b0).add(a1).multiplyScalar(0.25);
      steel.push(orient(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 10), mid.clone().addScaledVector(face.n, -0.015), mid.clone().addScaledVector(face.n, 0.015), UP));
    }
  }
  // ---- площадка: обвязка, лаги, доски
  const R = HALF - 0.06;
  // beam(a, b, w, d, hint): d — вдоль hint, w — поперёк (для горизонтального бруса с hint вбок w — высота)
  beam(V(-HALF, RIM_Y, -R), V(HALF, RIM_Y, -R), 0.2, 0.12, V(0, 0, 1));
  beam(V(-HALF, RIM_Y, R), V(HALF, RIM_Y, R), 0.2, 0.12, V(0, 0, 1));
  beam(V(-R, RIM_Y, -HALF + 0.12), V(-R, RIM_Y, HALF - 0.12), 0.2, 0.12, V(1, 0, 0));
  beam(V(R, RIM_Y, -HALF + 0.12), V(R, RIM_Y, HALF - 0.12), 0.2, 0.12, V(1, 0, 0));
  for (const x of [-0.75, 0, 0.75]) beam(V(x, RIM_Y + 0.01, -HALF + 0.12), V(x, RIM_Y + 0.01, HALF - 0.12), 0.18, 0.08, V(1, 0, 0));
  // косынки на углах обвязки (сталь)
  for (const [sx, sz] of corners) {
    box(steel, sx * (HALF - 0.2), RIM_Y, sz * (HALF + 0.006), 0.32, 0.18, 0.012);
    box(steel, sx * (HALF + 0.006), RIM_Y, sz * (HALF - 0.2), 0.012, 0.18, 0.32);
  }
  const PLANKS = 21;
  const pitch = (HALF * 2) / PLANKS;
  for (let i = 0; i < PLANKS; i += 1) {
    const z = -HALF + pitch * (i + 0.5);
    const w = pitch - 0.012;
    const g = new THREE.BoxGeometry(w, HALF * 2 + 0.04 * (rnd() - 0.5), 0.05);
    woodUv(g);
    wood.push(orient(g, V(-HALF, FLOOR_Y - 0.025, z), V(HALF, FLOOR_Y - 0.025, z), UP)); // локальная X → вдоль Z
  }
  // ---- перила: стойки, широкая верхняя доска (RAIL_H), средняя перекладина, бортик
  const P = HALF - 0.05; // стойки
  const GAP = 0.34; // проём лестницы сзади: |x| < GAP
  const posts = [[-P, -P], [0, -P], [P, -P], [P, 0], [P, P], [GAP, P], [-GAP, P], [-P, P], [-P, 0]];
  for (const [x, z] of posts) box(wood, x, FLOOR_Y + (RAIL_H - 0.05 - 0.25) / 2, z, 0.1, RAIL_H - 0.05 + 0.25, 0.1); // от обвязки до верхней доски
  const railY = FLOOR_Y + RAIL_H - 0.025;
  const midY = FLOOR_Y + 0.55;
  const toeY = FLOOR_Y + 0.075;
  const E = HALF + 0.03; // край перил наружу
  const sideRail = (x0, z0, x1, z1, n) => {
    beam(V(x0, railY, z0), V(x1, railY, z1), 0.17, 0.05, UP); // верхняя доска: плоская, 17 см
    const o = n.clone().multiplyScalar(0.07);
    beam(V(x0, midY, z0).add(o), V(x1, midY, z1).add(o), 0.1, 0.035, n);
    beam(V(x0, toeY, z0).add(o), V(x1, toeY, z1).add(o), 0.15, 0.025, n);
  };
  sideRail(-E, -P, E, -P, V(0, 0, -1)); // перед
  sideRail(P, -E + 0.17, P, E - 0.17, V(1, 0, 0));
  sideRail(-P, -E + 0.17, -P, E - 0.17, V(-1, 0, 0));
  sideRail(-E, P, -GAP + 0.05, P, V(0, 0, 1)); // зад, слева от проёма
  sideRail(GAP - 0.05, P, E, P, V(0, 0, 1)); // справа
  // ---- лестница сзади: от земли к краю площадки, тетивы выше пола (поручни)
  const ladderZ = (y) => 2.75 - 1.07 * (y / (FLOOR_Y + 1));
  const LX = 0.25;
  for (const sx of [-1, 1]) {
    beam(V(sx * LX, 0, ladderZ(0)), V(sx * LX, FLOOR_Y + 1, ladderZ(FLOOR_Y + 1)), 0.06, 0.09, V(1, 0, 0));
    // стальные кронштейны к задним связям
    for (const y of [2.8, 5.5, RIM_Y]) {
      const legZ = y === RIM_Y ? HALF : legAt(1, 1, y).z;
      box(steel, sx * LX, y, (ladderZ(y) + legZ) / 2, 0.03, 0.06, Math.abs(ladderZ(y) - legZ));
    }
  }
  for (let y = 0.3; y < FLOOR_Y - 0.05; y += 0.3) {
    rod(V(-LX, y, ladderZ(y)), V(LX, y, ladderZ(y)), 0.018, steel, 6);
  }

  const merge = (list) => {
    const g = mergeGeometries(list);
    list.forEach((p) => p.dispose());
    g.computeBoundingSphere();
    return g;
  };

  // ---- тень: каждую (выпуклую) деталь проецируем на землю вдоль солнца, рисуем выпуклую оболочку
  const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - SHADOW_ELEVATION), THREE.MathUtils.degToRad(90 + SUN_AZIMUTH));
  const slopeX = sun.x / sun.y;
  const slopeZ = sun.z / sun.y;
  const hulls = [];
  let minX = -4;
  let maxX = 4;
  let minZ = -4;
  let maxZ = 4;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (const part of [...wood, ...steel]) {
    const pos = part.attributes.position;
    const pts = [];
    for (let i = 0; i < pos.count; i += 1) {
      const y = Math.max(0, pos.getY(i));
      const x = pos.getX(i) - slopeX * y;
      const z = pos.getZ(i) - slopeZ * y;
      pts.push([x, z]);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    hulls.push(lower.slice(0, -1).concat(upper.slice(0, -1)));
  }
  minX -= 1;
  maxX += 1;
  minZ -= 1;
  maxZ += 1;
  const scale = 1024 / (maxX - minX);
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.min(1024, Math.ceil((maxZ - minZ) * scale));
  const sy = canvas.height / (maxZ - minZ);
  const g2 = canvas.getContext('2d');
  g2.fillStyle = '#fff';
  g2.fillRect(0, 0, canvas.width, canvas.height);
  g2.globalCompositeOperation = 'darken'; // пересечения не темнее
  // мягкое затенение под самой вышкой
  const cx = -minX * scale;
  const cz = -minZ * sy;
  const blob = g2.createRadialGradient(cx, cz, 0, cx, cz, 3.4 * scale);
  blob.addColorStop(0, 'rgb(150,150,150)');
  blob.addColorStop(1, 'rgb(255,255,255)');
  g2.fillStyle = blob;
  g2.fillRect(0, 0, canvas.width, canvas.height);
  const dark = Math.round(255 * SHADOW_DARK);
  g2.fillStyle = `rgb(${dark},${dark},${dark})`;
  g2.filter = 'blur(1.2px)';
  for (const hull of hulls) {
    g2.beginPath();
    hull.forEach(([x, z], i) => (i ? g2.lineTo((x - minX) * scale, (z - minZ) * sy) : g2.moveTo((x - minX) * scale, (z - minZ) * sy)));
    g2.closePath();
    g2.fill();
  }
  const shadowTexture = new THREE.CanvasTexture(canvas); // без перевода цвета: значения как есть
  shadowTexture.anisotropy = 4;

  return {
    wood: merge(wood),
    steel: merge(steel),
    concrete: merge(concrete),
    shadowTexture,
    shadowBounds: { minX, maxX, minZ, maxZ },
  };
}

export function createTower({ THREE, root, camera, shared }) {
  if (shared.towerCache?.key !== buildTower.toString()) {
    const old = shared.towerCache?.value;
    shared.towerCache = { key: buildTower.toString(), value: buildTower(THREE) };
    if (old) setTimeout(() => [old.wood, old.steel, old.concrete, old.shadowTexture].forEach((x) => x.dispose()), 5000);
  }
  const parts = shared.towerCache.value;

  // дерево — те же текстуры, что у мишеней (targets.js) и калаша
  const woodTex = (shared.woodTextures ??= (() => {
    const loader = new THREE.TextureLoader();
    const load = (name, srgb) => {
      const texture = loader.load(`${WOOD_URL}${name}_1k.jpg`);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      return texture;
    };
    return { map: load('diff', true), normalMap: load('nor_gl', false), roughnessMap: load('rough', false) };
  })());
  const materials = [];
  const keep = (m) => (materials.push(m), m);
  const woodMat = keep(new THREE.MeshStandardMaterial({ ...woodTex, color: 0xb89a7c, normalScale: new THREE.Vector2(1.2, 1.2), metalness: 0 }));
  const steelMat = keep(new THREE.MeshStandardMaterial({ color: 0x4a4d52, metalness: 0.75, roughness: 0.5, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.8 }));
  const concreteMat = keep(new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.95, metalness: 0 }));
  const shadowMat = keep(new THREE.MeshBasicMaterial({
    map: parts.shadowTexture,
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

  const group = new THREE.Group();
  group.name = 'scene-tower';
  for (const [geometry, material] of [[parts.wood, woodMat], [parts.steel, steelMat], [parts.concrete, concreteMat]]) {
    group.add(new THREE.Mesh(geometry, material));
  }
  // квадрат-приёмник тени повторяет рельеф (за 6 м от центра земля волнистая); пересобирается при переносе
  const b = parts.shadowBounds;
  let receiverGeometry = null;
  const shadowQuad = new THREE.Mesh(new THREE.BufferGeometry(), shadowMat);
  shadowQuad.renderOrder = -1;
  shadowQuad.frustumCulled = false;
  group.add(shadowQuad);
  const buildReceiver = () => {
    receiverGeometry?.dispose();
    const g = new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ, 48, 16).rotateX(-Math.PI / 2);
    g.translate((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, groundAt(x + group.position.x, z + group.position.z) + 0.015);
      uv.setXY(i, (x - b.minX) / (b.maxX - b.minX), 1 - (z - b.minZ) / (b.maxZ - b.minZ));
    }
    receiverGeometry = shadowQuad.geometry = g;
  };
  root.add(group);

  // ---- состояние
  let state = shared.towerState;
  if (!state) {
    state = { on: false, x: 0, z: 0, h: TOWER_H };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (saved && typeof saved.on === 'boolean') state = { on: saved.on, x: +saved.x || 0, z: +saved.z || 0, h: +saved.h || TOWER_H };
    } catch {
      // без хранилища — выключена
    }
    shared.towerState = state;
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // не переживёт перезагрузку
    }
  };
  const saveRig = (rig) => {
    try {
      localStorage.setItem(RIG_KEY, JSON.stringify({ p: rig.position.toArray(), q: rig.quaternion.toArray() }));
    } catch {
      // не переживёт перезагрузку
    }
  };
  const head = new THREE.Vector3();
  const place = () => {
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(head);
    state.x = head.x;
    state.z = head.z;
  };
  const show = () => {
    group.position.set(state.x, 0, state.z);
    group.visible = state.on;
    if (state.on) buildReceiver();
    shared.towerOn = state.on;
    shared.playerElevation = state.on ? TOWER_H : 0;
    shared.towerPos = state.on ? { x: state.x, z: state.z } : null;
  };
  // rig вверх/вниз: «поднят» — если выше половины вышки (без вышки rig около 0)
  const syncRig = () => {
    const rig = camera.parent;
    if (!rig || shared.carSeat?.seated) return;
    const have = rig.position.y > TOWER_H / 2 ? state.h : 0;
    const want = state.on ? TOWER_H : 0;
    if (Math.abs(want - have) < 1e-6) return;
    rig.position.y += want - have;
    rig.updateMatrixWorld(true);
    state.h = TOWER_H;
    saveRig(rig);
  };
  const set = (on) => {
    if (on && !state.on) place(); // вышка встаёт под голову
    state.on = Boolean(on);
    syncRig();
    show();
    save();
    console.log(`[tower] ${state.on ? 'вкл' : 'выкл'} x=${state.x.toFixed(2)} z=${state.z.toFixed(2)}`);
    return state.on;
  };
  show();
  syncRig(); // после перезагрузки rig уже поднят (из 'vr.rig'); если нет — поднять

  const api = {
    get on() {
      return state.on;
    },
    set,
    toggle: () => set(!state.on),
    // после ctx.recenter (оболочка поставила rig заново, голова — в начале мира): вышку — под голову, rig — вверх
    afterRecenter() {
      if (!state.on) return;
      place();
      syncRig();
      show();
      save();
    },
    group,
    dispose() {
      root.remove(group);
      for (const m of materials) m.dispose();
      receiverGeometry?.dispose();
      // геометрия и текстура тени — в кэше __sceneState
    },
  };
  shared.tower = api; // ручка для npm run vr:eval
  return api;
}
