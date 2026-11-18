// Бинокль (меню «Заспавнить ▸ Бинокль»): один на мир, новый спавн переносит его перед игроком.
//
// - Модель процедурная: два ствола (резиновая броня, раструбы объективов с золотым кольцом), мост
//   с шарниром и колесом фокусировки, наглазники, диоптрийное кольцо; 2 вызова отрисовки на корпус
//   (резина и металл, цвета в вершинах) + 2 окуляра + 2 объектива + обводка.
// - Берётся «Абсолютно схватить» хватом (режимы «Хват: нажать / держать»): прыгает в руку в свою
//   посадку — левый ствол над кулаком, стволы вдоль зелёной оси. Обводка: голубая — в досягаемости
//   руки, белая — луч на нём (ray-grab.js берёт его курком издали, как оружие). Своя посадка —
//   пункт «Перенастроить хват» (бинокль замирает, следующий хват рядом берёт его как есть).
// - Окуляры — scope-lens.js: каждый рисует увеличенный мир для глаза за ним (eyeOnly), объективы
//   разнесены как глаза — стерео. Изображение рисуется, только пока бинокль в руке у лица (голова
//   сразу за окулярами); иначе стёкла тёмные.
// - Стик вверх/вниз (в руке, меню закрыто): кратность ZOOM_MIN…ZOOM_MAX, плавно, по кривой (малый
//   наклон — точная доводка); при смене — подпись «×N» в правом окуляре на LABEL_S.
// - Курок с биноклем в руке ничего не делает, Y — как всегда (запись / меню).
// - Состояние: __sceneState.binoculars (переживает подмену, в т. ч. «в руке»), localStorage
//   'scene.binoculars' { p, q, z } (в руке после перезагрузки не остаётся), посадка 'scene.binoculars.seat'.
//
// const bino = createBinoculars({ THREE, root, scene, camera, renderer });
// bino.item — { kind: 'binoculars', group } для ray-grab (null, если бинокля нет)
// bino.hand({ gripWorld, handPosition, seat, gripDown, gripMode, menuIsOpen, handBusy }) → 'grab' | 'release' | null
// bino.update({ realDt, source, menuIsOpen, rayTarget, rayHeld }) — в конце update сцены
// bino.spawn(), bino.remove(), bino.regrip(); held, near, exists; dispose()
// Ручка: __sceneState.binoDebug (info(), zoom(n), api)
import { createScopeLens } from './scope-lens.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const STORE_KEY = 'scene.binoculars';
const SEAT_KEY = 'scene.binoculars.seat';
export const ZOOM_MIN = 2;
export const ZOOM_MAX = 12;
const ZOOM_DEFAULT = 4;
const ZOOM_FULL_S = 1.6; // полный стик: от ZOOM_MIN до ZOOM_MAX за столько секунд
const ZOOM_SMOOTH = 10; // 1/с: показанная кратность догоняет заданную
const STICK_DEAD = 0.15;
const stickCurve = (k) => 0.12 * k + 0.88 * k * k * k; // чуть-чуть стика — доли процента в секунду
const LABEL_S = 1.3; // подпись «×N» держится столько после последней смены
const REACH = 0.15; // м от руки до середины бинокля — можно взять
const OUTLINE_M = 0.0025;
// у лица: голова (камера) в системе бинокля — за окулярами, не дальше FACE_M от стекла и не вбок
const FACE_M = 0.2;
const FACE_SIDE_M = 0.09;
const LENS_SIZE = 448; // текстура окуляра, пикселей
const LOG_EVERY_MS = 5000;

// ---- размеры модели (м). X вправо, Y вверх, −Z вперёд (объективы), +Z к глазам
const BX = 0.032; // ось ствола от середины
const Z0 = 0.05; // задний торец корпуса (дальше назад — наглазник)
const EYE_R = 0.021; // стекло окуляра
const EYE_Z = Z0 + 0.004; // стекло окуляра утоплено в наглазник
const OBJ_R = 0.0236; // стекло объектива
const OBJ_H = 0.133; // где стекло объектива вдоль ствола (от Z0 вперёд)
const OBJ_Z = Z0 - OBJ_H - 0.001;
// посадка в руке по умолчанию — в осях джойстика (красная X вправо, синяя Y вверх, зелёная −Z вперёд):
// левый ствол над кулаком, окуляры чуть позади руки (к лицу)
const SEAT_POS = [BX, 0.035, -0.03];

const RUBBER = 0x2c3529;
const RUBBER_DARK = 0x1b2019;
const CUP = 0x111214;
const METAL = 0x3a3e44;
const GOLD = 0xb8913a;
const SILVER = 0xc9ced4;

// Геометрии корпуса (в системе модели): { rubber, metal } — цвета в вершинах, без uv
function buildBinocularGeometry(THREE) {
  const color = new THREE.Color();
  const rubber = [];
  const metal = [];
  const SEG = 36;
  const paint = (g, hexOf) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    if (ng.attributes.uv) ng.deleteAttribute('uv');
    const n = ng.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      color.set(typeof hexOf === 'function' ? hexOf(i) : hexOf);
      c[i * 3] = color.r;
      c[i * 3 + 1] = color.g;
      c[i * 3 + 2] = color.b;
    }
    ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return ng;
  };
  // тело вращения вокруг оси ствола: профиль [[r, h], …] (h — от Z0 вперёд), цвет по точке профиля.
  // Порядок точек задаёт наружу смотрящие нормали: снаружи — h растёт, торец вперёд — r убывает.
  const lathe = (profile, colorOf, x, list) => {
    const pts = profile.map(([r, h]) => new THREE.Vector2(r, h));
    const g = new THREE.LatheGeometry(pts, SEG);
    // вершины лат: (сегмент i) × (точка j) — цвет по j
    const per = pts.length;
    const cols = new Float32Array(g.attributes.position.count * 3);
    for (let v = 0; v < g.attributes.position.count; v += 1) {
      color.set(colorOf(v % per));
      cols[v * 3] = color.r;
      cols[v * 3 + 1] = color.g;
      cols[v * 3 + 2] = color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.rotateX(-Math.PI / 2); // ось Y профиля → −Z (h растёт к объективу)
    g.translate(x, 0, Z0);
    const ng = g.toNonIndexed();
    g.dispose();
    ng.deleteAttribute('uv');
    list.push(ng);
  };
  // ствол: резиновая броня от окуляра до раструба, внутри торцы закрыты (за стёклами)
  const body = [
    [0, 0], [0.0205, 0], [0.0222, 0.002], [0.0232, 0.008], [0.0232, 0.016], [0.0256, 0.024], [0.0262, 0.034],
    [0.0254, 0.05], [0.025, 0.07], [0.0254, 0.09], [0.0264, 0.104], [0.0276, 0.118], [0.0282, 0.13],
    [0.0276, 0.137], [0.025, 0.1375], [0.025, 0.132], [0, 0.132],
  ];
  // полосы хвата потемнее (середина ствола)
  const bodyColor = (j) => (j >= 7 && j <= 9 ? RUBBER_DARK : j >= 14 ? CUP : RUBBER);
  // наглазник: кольцо (снаружи вперёд, торец, внутри назад, задний торец наружу)
  const cup = [
    [0.0262, -0.016], [0.0262, 0.006], [0.023, 0.006], [0.0215, 0.003], [0.0215, -0.0175],
    [0.0228, -0.0192], [0.025, -0.019], [0.0262, -0.016],
  ];
  // золотое кольцо у раструба и металлический обод объектива
  const ring = (r0, r1, h0, h1) => [[r1, h0], [r1, h1], [r0, h1], [r0, h0], [r1, h0]];
  for (const sx of [-1, 1]) {
    const x = sx * BX;
    lathe(body, bodyColor, x, rubber);
    lathe(cup, () => CUP, x, rubber);
    lathe(ring(0.0276, 0.0286, 0.112, 0.116), () => GOLD, x, metal);
    lathe(ring(0.0272, 0.0287, 0.1335, 0.139), () => METAL, x, metal);
    // шильдик сверху ствола
    const badge = new THREE.BoxGeometry(0.011, 0.0016, 0.022);
    badge.translate(x, 0.0258, Z0 - 0.06);
    metal.push(paint(badge, SILVER));
    // ушко для ремня снаружи
    const lug = new THREE.BoxGeometry(0.004, 0.008, 0.012);
    lug.translate(sx * (BX + 0.027), 0.004, Z0 - 0.03);
    metal.push(paint(lug, METAL));
  }
  // диоптрийное кольцо на правом окуляре с белой меткой
  lathe(ring(0.0231, 0.0241, 0.009, 0.0145), () => METAL, BX, metal);
  const tick = new THREE.BoxGeometry(0.0012, 0.0012, 0.004);
  tick.translate(BX, 0.0243, Z0 - 0.0118);
  metal.push(paint(tick, 0xf2f2f2));
  // мост: два перешейка между стволами + шарнир по оси Z
  const bridge = (z, d) => {
    const b = new THREE.BoxGeometry(2 * BX - 0.03, 0.011, d);
    b.translate(0, 0.002, z);
    rubber.push(paint(b, RUBBER_DARK));
  };
  bridge(Z0 - 0.03, 0.026);
  bridge(Z0 - 0.105, 0.03);
  const hinge = new THREE.CylinderGeometry(0.0085, 0.0085, 0.12, 20);
  hinge.rotateX(Math.PI / 2);
  hinge.translate(0, 0.001, Z0 - 0.067);
  metal.push(paint(hinge, METAL));
  for (const [z, hex] of [[Z0 - 0.007, METAL], [Z0 - 0.127, GOLD]]) {
    const cap = new THREE.CylinderGeometry(0.0089, 0.0089, 0.003, 20);
    cap.rotateX(Math.PI / 2);
    cap.translate(0, 0.001, z);
    metal.push(paint(cap, hex));
  }
  // колесо фокусировки на мосту (ось X), рифлёное
  const wheel = new THREE.CylinderGeometry(0.0105, 0.0105, 0.019, 28);
  wheel.rotateZ(Math.PI / 2);
  wheel.translate(0, 0.014, Z0 - 0.03);
  rubber.push(paint(wheel, RUBBER_DARK));
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 14) * Math.PI * 2;
    const rib = new THREE.BoxGeometry(0.019, 0.0016, 0.0016);
    rib.rotateX(a);
    rib.translate(0, 0.014 + Math.cos(a) * 0.0108, Z0 - 0.03 + Math.sin(a) * 0.0108);
    rubber.push(paint(rib, CUP));
  }
  for (const sx of [-1, 1]) {
    const side = new THREE.CylinderGeometry(0.0095, 0.0095, 0.0015, 24);
    side.rotateZ(Math.PI / 2);
    side.translate(sx * 0.0102, 0.014, Z0 - 0.03);
    metal.push(paint(side, METAL));
  }
  const r = mergeGeometries(rubber, false);
  const m = mergeGeometries(metal, false);
  rubber.concat(metal).forEach((g) => g.dispose());
  // обводка: всё вместе, раздуто по нормалям
  const all = mergeGeometries([r, m], false);
  const pos = all.attributes.position;
  const nor = all.attributes.normal;
  for (let i = 0; i < pos.count; i += 1) {
    pos.setXYZ(i, pos.getX(i) + nor.getX(i) * OUTLINE_M, pos.getY(i) + nor.getY(i) * OUTLINE_M, pos.getZ(i) + nor.getZ(i) * OUTLINE_M);
  }
  all.deleteAttribute('color');
  for (const g of [r, m, all]) g.computeBoundingSphere();
  return { rubber: r, metal: m, outline: all };
}

const load = () => {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s?.p?.length === 3 && s?.q?.length === 4) {
      return { exists: true, held: false, p: s.p, q: s.q, zoom: Number.isFinite(s.z) ? s.z : ZOOM_DEFAULT };
    }
  } catch {
    // нет сохранённого
  }
  return { exists: false, held: false, zoom: ZOOM_DEFAULT };
};

export function createBinoculars({ THREE, root, scene, camera, renderer }) {
  const shared = (globalThis.__sceneState ??= {});
  const st = (shared.binoculars ??= load());
  st.zoom = THREE.MathUtils.clamp(st.zoom ?? ZOOM_DEFAULT, ZOOM_MIN, ZOOM_MAX);

  // геометрии — один раз на версию этого файла (живут в __sceneState, оболочка их не освобождает, пока
  // они нарисованы)
  const source = buildBinocularGeometry.toString();
  let geo = shared.binoGeo;
  if (geo?.source !== source) {
    geo = shared.binoGeo = { source, ...buildBinocularGeometry(THREE) };
  }

  const group = new THREE.Group();
  group.name = 'binoculars';
  const env = shared.weaponEnv ?? null;
  const rubberMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, envMap: env, envMapIntensity: 0.25 });
  const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.75, envMap: env, envMapIntensity: 0.7 });
  const rubberMesh = new THREE.Mesh(geo.rubber, rubberMat);
  const metalMesh = new THREE.Mesh(geo.metal, metalMat);
  group.add(rubberMesh, metalMesh);
  // обводка: белая (луч) и голубая (рука дотянется) — подмена материала, без выделений в кадре
  const outlineWhite = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, depthWrite: false });
  const outlineBlue = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, side: THREE.BackSide, depthWrite: false });
  const outline = new THREE.Mesh(geo.outline, outlineWhite);
  outline.visible = false;
  group.add(outline);

  // окуляры: каждый — для своего глаза (в шлеме), объективы — у переднего торца своего ствола
  const zoomNow = { value: st.zoom };
  const lensOpts = { THREE, renderer, scene, camera, magnification: st.zoom, lensR: EYE_R, tanApparent: 0.36, eyeRelief: 0.07, size: LENS_SIZE };
  const lenses = [-1, 1].map((sx, i) => {
    const lens = createScopeLens({ ...lensOpts, eyeOnly: i });
    lens.setReticle(false);
    lens.eyepiece.position.set(sx * BX, 0, EYE_Z);
    lens.objective.position.set(sx * BX, 0, OBJ_Z);
    lens.objective.scale.setScalar(OBJ_R);
    group.add(lens.eyepiece, lens.objective);
    return lens;
  });

  // подпись кратности «×N» — в правом окуляре снизу, поверх изображения
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const c2d = canvas.getContext('2d');
  const labelTex = new THREE.CanvasTexture(canvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false, toneMapped: false });
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.015, 0.0056), labelMat);
  label.position.set(BX, -0.0128, EYE_Z + 0.0015);
  label.visible = false;
  group.add(label);
  let labelText = '';
  let labelLeft = 0;
  let labelDrawAt = 0;
  const drawLabel = (z) => {
    const text = `×${z < 9.95 ? z.toFixed(1).replace('.', ',') : Math.round(z)}`;
    if (text === labelText) return;
    labelText = text;
    c2d.clearRect(0, 0, 128, 48);
    c2d.font = 'bold 34px sans-serif';
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    c2d.lineWidth = 6;
    c2d.strokeStyle = 'rgba(0,0,0,0.75)';
    c2d.strokeText(text, 64, 25);
    c2d.fillStyle = '#ffffff';
    c2d.fillText(text, 64, 25);
    labelTex.needsUpdate = true;
  };

  // как у оружия (pistols.js liftModel): обводка после неба (900), сам прибор — после неё
  group.traverse((o) => {
    if (o.isMesh) o.renderOrder = o === outline ? 901 : o === label ? 903 : 902;
  });
  group.visible = Boolean(st.exists);
  root.add(group);

  const item = { kind: 'binoculars', group };

  // ---- посадка
  const seatLocal = new THREE.Matrix4().makeTranslation(SEAT_POS[0], SEAT_POS[1], SEAT_POS[2]);
  try {
    const saved = JSON.parse(localStorage.getItem(SEAT_KEY));
    if (Array.isArray(saved) && saved.length === 16) seatLocal.fromArray(saved);
  } catch {
    // посадка по умолчанию
  }
  const seatM = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const head = new THREE.Vector3();
  const center = new THREE.Vector3();
  let near = false;
  let regrip = false;
  let gripWas = true; // хват, зажатый при подмене, не считается новым нажатием
  let dirty = false;
  let saveLeft = 1;
  let wasActive = false;
  let statN = 0, statSum = 0, statMax = 0, statAt = performance.now(), activeFrames = 0;
  let lastInt = Math.floor(st.zoom);

  const applyPose = () => {
    if (!st.exists || !st.p) return;
    group.position.fromArray(st.p);
    group.quaternion.fromArray(st.q);
    group.scale.set(1, 1, 1);
  };
  const storePose = () => {
    st.p = group.position.toArray();
    st.q = group.quaternion.toArray();
  };
  const save = () => {
    dirty = false;
    try {
      if (!st.exists) localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, JSON.stringify({ p: st.p.map((n) => +n.toFixed(4)), q: st.q.map((n) => +n.toFixed(5)), z: +st.zoom.toFixed(2) }));
    } catch {
      // без хранилища не переживёт перезагрузку
    }
  };
  const seatOf = (seat) => {
    if (seat) {
      seat.updateMatrix();
      seatM.copy(seat.matrix);
    } else seatM.identity();
    return seatM;
  };
  applyPose();

  const api = {
    get item() {
      return st.exists && !st.held ? item : null;
    },
    get held() {
      return Boolean(st.exists && st.held);
    },
    get near() {
      return near;
    },
    get exists() {
      return Boolean(st.exists);
    },
    get zoom() {
      return st.zoom;
    },
    // перед игроком: 0,45 м вперёд, чуть ниже глаз, объективами от игрока
    spawn() {
      camera.getWorldPosition(head);
      camera.getWorldDirection(tmpV);
      tmpV.y = 0;
      if (tmpV.lengthSq() < 1e-6) tmpV.set(0, 0, -1);
      tmpV.normalize();
      group.position.copy(head).addScaledVector(tmpV, 0.45);
      group.position.y -= 0.15;
      group.quaternion.setFromAxisAngle(tmpS.set(0, 1, 0), Math.atan2(-tmpV.x, -tmpV.z));
      group.scale.set(1, 1, 1);
      st.exists = true;
      st.held = false;
      regrip = false;
      storePose();
      save();
    },
    remove() {
      st.exists = false;
      st.held = false;
      regrip = false;
      near = false;
      save();
    },
    // «Перенастроить хват»: бинокль замирает, следующий хват рядом — новая посадка (как он висит)
    regrip() {
      if (!st.exists) return;
      st.held = false;
      regrip = true;
      storePose();
      save();
    },
    get regripping() {
      return regrip;
    },
    // хват (main.js, раздел хвата; только когда рука есть). 'grab' | 'release' | null
    hand({ gripWorld, handPosition, seat = null, gripDown, gripMode, menuIsOpen, handBusy }) {
      const pressed = gripDown && !gripWas;
      gripWas = gripDown;
      near = false;
      if (!st.exists) return null;
      if (st.held) {
        const letGo = gripMode === 'hold' ? !gripDown && !menuIsOpen : pressed && !menuIsOpen;
        if (letGo) {
          st.held = false;
          storePose();
          save();
          return 'release';
        }
        tmpM.copy(gripWorld).multiply(seatOf(seat)).multiply(seatLocal);
        tmpM.decompose(group.position, group.quaternion, tmpS);
        group.scale.set(1, 1, 1);
        storePose();
        dirty = true;
        return null;
      }
      if (handBusy || menuIsOpen) return null;
      group.updateWorldMatrix(true, false);
      center.set(0, 0, Z0 - 0.06).applyMatrix4(group.matrixWorld);
      near = center.distanceTo(handPosition) < REACH;
      if (near && pressed) {
        if (regrip) {
          // новая посадка: бинокль остаётся, как висел, относительно руки
          seatLocal.copy(gripWorld).multiply(seatOf(seat)).invert().multiply(group.matrixWorld);
          try {
            localStorage.setItem(SEAT_KEY, JSON.stringify(seatLocal.toArray().map((n) => +n.toFixed(5))));
          } catch {
            // посадка живёт до перезагрузки
          }
          regrip = false;
        }
        st.held = true;
        near = false;
        return 'grab';
      }
      return null;
    },
    // каждый кадр в конце update сцены: обводка, кратность (стик), окуляры
    update({ realDt, source, menuIsOpen, rayTarget = null, rayHeld = null }) {
      const dt = Math.min(Math.max(realDt, 0), 0.1);
      group.visible = Boolean(st.exists);
      if (!st.exists) {
        outline.visible = false;
        if (wasActive) {
          for (const lens of lenses) lens.update(false);
          wasActive = false;
        }
        return;
      }
      const rayOn = rayTarget === item || rayHeld === item;
      if (rayHeld === item) {
        storePose(); // двигают лучом (ray-grab.js)
        dirty = true;
      } else if (!st.held && !regrip) applyPose();
      outline.visible = !st.held && (near || rayOn);
      outline.material = near ? outlineBlue : outlineWhite;

      // кратность: стик вверх (ось < 0) — больше; скорость в логарифме, по кривой
      if (st.held && !menuIsOpen) {
        const ay = source?.gamepad?.axes?.[3] ?? 0;
        if (Math.abs(ay) > STICK_DEAD) {
          const k = (Math.abs(ay) - STICK_DEAD) / (1 - STICK_DEAD);
          const rate = (Math.log(ZOOM_MAX / ZOOM_MIN) / ZOOM_FULL_S) * stickCurve(k) * -Math.sign(ay);
          const z = THREE.MathUtils.clamp(st.zoom * Math.exp(rate * dt), ZOOM_MIN, ZOOM_MAX);
          if (z !== st.zoom) {
            st.zoom = z;
            labelLeft = LABEL_S;
            dirty = true;
            const n = Math.floor(z + 1e-6);
            if (n !== lastInt) {
              lastInt = n;
              source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.08, 8); // щелчок на каждом целом
            }
          }
        }
      }
      const zPrev = zoomNow.value;
      zoomNow.value = Math.exp(Math.log(zoomNow.value) + (Math.log(st.zoom) - Math.log(zoomNow.value)) * Math.min(1, dt * ZOOM_SMOOTH));
      if (Math.abs(zoomNow.value - st.zoom) < 0.002) zoomNow.value = st.zoom;
      if (zoomNow.value !== zPrev) for (const lens of lenses) lens.setMagnification(zoomNow.value);

      // у лица: голова за окулярами
      let active = false;
      if (st.held) {
        group.updateWorldMatrix(true, false);
        camera.getWorldPosition(head);
        group.worldToLocal(head);
        active = head.z > EYE_Z && head.z < EYE_Z + FACE_M && Math.abs(head.x) < FACE_SIDE_M && Math.abs(head.y) < FACE_SIDE_M;
      }
      // подпись — только у лица и недолго после смены
      labelLeft = Math.max(0, labelLeft - dt);
      label.visible = active && labelLeft > 0;
      if (label.visible) {
        const now = performance.now();
        if (now - labelDrawAt > 40) {
          labelDrawAt = now;
          drawLabel(zoomNow.value);
        }
      }
      if (active || wasActive) {
        const t0 = performance.now();
        for (const lens of lenses) lens.update(active, group);
        const ms = performance.now() - t0;
        if (active) {
          statN += 1;
          statSum += ms;
          statMax = Math.max(statMax, ms);
          activeFrames += 1;
        }
      }
      wasActive = active;
      const now = performance.now();
      if (now - statAt >= LOG_EVERY_MS) {
        if (statN) console.log(`[bino] frames=${activeFrames}/${((now - statAt) / 1000).toFixed(0)}s lenses cpu=${(statSum / statN).toFixed(2)}/${statMax.toFixed(2)}ms x${st.zoom.toFixed(1)} size=${LENS_SIZE}`);
        statN = statSum = statMax = activeFrames = 0;
        statAt = now;
      }
      saveLeft -= dt;
      if (saveLeft <= 0) {
        saveLeft = 1;
        if (dirty) save();
      }
    },
    dispose() {
      if (dirty) save();
      for (const lens of lenses) lens.dispose();
      root.remove(group);
      [rubberMat, metalMat, outlineWhite, outlineBlue, labelMat, labelTex, label.geometry].forEach((o) => o.dispose());
      if (shared.binoDebug?.api === api) shared.binoDebug = null;
    },
  };
  // ручка для npm run vr:eval
  shared.binoDebug = {
    api,
    group,
    lenses,
    info: () => ({ ...st, near, regrip, zoomShown: +zoomNow.value.toFixed(2), active: wasActive }),
    zoom(n) {
      st.zoom = THREE.MathUtils.clamp(n, ZOOM_MIN, ZOOM_MAX);
      labelLeft = LABEL_S;
      return st.zoom;
    },
  };
  return api;
}
