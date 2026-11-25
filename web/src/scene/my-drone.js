// «Мой дрон»: личный квадрокоптер игрока и пульт к нему (меню «Заспавнить ▸ Мой дрон»).
//
// - Дрон: модель лёгкого коптера (drone-model.js), перекрашен в белый с золотом, золотой маяк сверху,
//   под носом пулемёт. В нём никто не стреляет и он бессмертный: он не попадает ни в
//   shared.droneTargets, ни в shooting.addShootable — для псов, коптеров, артиллерии и чёрных дыр
//   его просто нет.
// - Пульт: предмет «Абсолютно схватить» (хватом прыгает в руку в свою посадку, как оружие; режимы
//   «Хват: нажать / держать»). На пульте экран — живое изображение с камеры дрона (камера под носом,
//   смотрит вперёд с наклоном CAM_TILT_DEG вниз, стабилизирована: крен и тангаж корпуса её не качают).
// - УПРАВЛЕНИЯ С ПУЛЬТА ПОКА НЕТ (пользователь добавляет его по одному элементу): пульт только берут и
//   кладут хватом, кнопки с ним в руке значат то же, что всегда; дрон висит на месте. Готовые части на
//   будущее: полёт (update: fwd/yaw/up/down с разгоном и наклонами), наклон камеры st.camPitch,
//   пулемёт fireGun (shooting.shoot — пули игрока) — их пока двигает только debug.input с ПК.
// - Размеры (SIZES, как у коптеров drones.js): маленький / средний / большой / огромный — больше =
//   медленнее, тяжёлая рама, крупнее пулемёт и громче. Дрон один: новый спавн заменяет прежний.
// - Пульт не в руке — дрон тормозит и висит на месте (удержание позиции).
// - Время: дрон — «рука игрока», а не мир: летит по реальному dt (замедление времени его не тормозит).
// - Звук: гул винтов — свой постоянный голос игрока (→ master, не шина мира, бюджет не спрашивает),
//   буфер «hum» из drone-sound.js.
// - Переживает подмену сцены (__sceneState.myDrone) и перезагрузку (localStorage 'scene.myDrone';
//   в руке после перезагрузки пульт не остаётся — как оружие).
//
// const my = createMyDrone({ THREE, root, scene, camera, renderer, shooting });
// my.hand({ gripWorld, handPosition, seat, gripDown, gripPressed, gripMode, menuIsOpen, handBusy }) → 'grab' | 'release' | null
//   (каждый кадр, пока рука есть, в разделе хвата main.js; seat — объект осей джойстика или null)
// my.update(realDt, source, menuIsOpen)  // полёт, звук, экран — каждый кадр в конце update сцены
// my.spawn(size = 1), my.recall(), my.remove(); my.held, my.near, my.exists; my.dispose()
// Ручка: __sceneState.myDroneDebug (info(), input = { sx, sy, up, down, fire } — подменить ввод на ПК, shot())
import { buildDroneGeometries, droneTextures, MOTORS, ROTOR_R, GUN_PIVOT, GUN_MUZZLE } from './drone-model.js';
import { createDroneSound } from './drone-sound.js';
import { groundHeight } from './car.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const STORE_KEY = 'scene.myDrone';
// Размеры (индекс = st.size; названия — в menu.js MY_DRONE_SIZES). span — размах, м; frame — рама
// drone-model.js; maxV/upV — м/с; yaw — рад/с; acc — м/с²; gap — с между выстрелами; shot — калибр
// (shared.shotKind: урон и отброс как у этого оружия; 'awp' — ×5 по псам и коптерам), sound — звук
// выстрела (sound.js setWeapon); speed — пули, м/с; flash — вторая вспышка; hum — [громкость,
// скорость петли, опорное расстояние] гула
// скорости (по просьбе): огромный в 4 раза быстрее прежнего (5 → 20 м/с), большой и средний — пропорционально
export const SIZES = [
  { span: 0.45, frame: 'light', maxV: 12, upV: 5, yaw: 2.2, acc: 13, gap: 0.12, shot: 'pistol', sound: 'pistol', speed: 400, flash: false, hum: [0.24, 2.1, 1.6] },
  { span: 0.9, frame: 'light', maxV: 14, upV: 5, yaw: 1.75, acc: 12, gap: 0.1, shot: 'ak', sound: 'ak', speed: 900, flash: false, hum: [0.32, 1.45, 2.6] },
  { span: 2, frame: 'heavy', maxV: 16, upV: 6, yaw: 1.2, acc: 11, gap: 0.14, shot: 'ak', sound: 'ak', speed: 900, flash: true, hum: [0.5, 0.8, 5] },
  { span: 5, frame: 'heavy', maxV: 20, upV: 8, yaw: 0.7, acc: 10, gap: 0.55, shot: 'awp', sound: 'awp', speed: 1000, flash: true, hum: [0.75, 0.42, 12] },
];
const GUN_SCALE_HEAVY = 1.5; // пулемёт тяжёлой рамы (большой, огромный) крупнее
// камера под носом (в долях размаха): лёгкая рама — у камеры-шарика, тяжёлая — у сенсора
const CAM_AT = { light: [0, -0.03, -0.2], heavy: [0, -0.07, -0.3] };
const RESPONSE = 2.2; // 1/с: как быстро скорость догоняет заданную
const ALT_MIN = 0.5; // м над землёй (+ 0,3 размаха)
const ALT_MAX = 60;
const RANGE_M = 400; // дальше от начала мира не улетает
const REACH = 0.2; // м: рука ближе к пульту — можно взять (пульт крупнее)
const GROUND_FX = [2, 3, 5, 8]; // размер пыли от попадания в землю по размерам дрона (у пуль игрока 1)
const REMOTE_SCALE = 1.5; // пульт целиком в 1,5 раза больше (просьба пользователя)
const CAM_TILT_DEG = 12; // камера дрона смотрит вниз (с самого начала; дальше — стиком)
const CAM_PITCH_MIN = -60; // градусы: стик вниз/вверх наклоняет камеру и прицел в этих пределах
const CAM_PITCH_MAX = 30;
const CAM_PITCH_RATE = 70; // °/с при полном отклонении (в режиме 2 — ×0,6 и кривая aimCurve)
const aimCurve = (v) => v * v * v; // режим 2: чуть-чуть стика — доли градуса в секунду
const CAM_FOV = 62; // вертикальный угол камеры
const SCREEN_W = 0.096; // экран пульта, м (4:3)
const SCREEN_H = 0.072;
const RT_W = 320; // текстура экрана
const RT_H = 240;
const RT_SAMPLES = 2;
const CAM_FPS = 25; // кадров камеры в секунду
const LOG_EVERY_MS = 10000;
// посадка пульта в руке: в осях джойстика (красная X вправо, синяя Y вверх, зелёная −Z вперёд) —
// над рукой, экраном к глазам (наклон назад на SEAT_TILT_DEG)
const SEAT_POS = [0.0, 0.075, -0.005];
const SEAT_TILT_DEG = 50;

const PEARL = 0xeceae4;
const GOLD = 0xd6a632;
const DARK = 0x24272b;
const BLACK = 0x0d0e10;

// ---- модель пульта: X вправо, Y вверх по лицевой стороне, +Z — из экрана к игроку
function buildRemoteGeometry(THREE) {
  const color = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const list = [];
  const part = (g, hex, pos, rot = [0, 0, 0]) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    color.set(hex);
    const n = ng.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      c[i * 3] = color.r;
      c[i * 3 + 1] = color.g;
      c[i * 3 + 2] = color.b;
    }
    ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
    ng.deleteAttribute('uv');
    m.compose(v.set(pos[0], pos[1], pos[2]), q.setFromEuler(e.set(rot[0], rot[1], rot[2])), one);
    ng.applyMatrix4(m);
    list.push(ng);
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cylZ = (r0, r1, h, seg = 12) => new THREE.CylinderGeometry(r0, r1, h, seg);
  const RX = Math.PI / 2; // цилиндр осью по Z
  part(box(0.17, 0.12, 0.026), PEARL, [0, 0, 0]); // корпус
  part(box(0.15, 0.1, 0.03), PEARL, [0, -0.004, -0.004]); // задняя «подушка»
  for (const sx of [-1, 1]) {
    part(cylZ(0.026, 0.022, 0.1, 10), PEARL, [sx * 0.078, -0.06, -0.014], [0.25, 0, sx * 0.38]); // рукоятки
    part(cylZ(0.0265, 0.0265, 0.012, 10), GOLD, [sx * 0.0655, -0.0285, -0.006], [0.25, 0, sx * 0.38]); // золотые кольца
    part(cylZ(0.018, 0.018, 0.004, 14), DARK, [sx * 0.064, -0.038, 0.0135], [RX, 0, 0]); // подвес стика
    part(cylZ(0.004, 0.004, 0.016, 6), DARK, [sx * 0.064, -0.038, 0.021], [RX, 0, 0]); // ось стика
    part(cylZ(0.009, 0.01, 0.006, 12), DARK, [sx * 0.064, -0.038, 0.03], [RX, 0, 0]); // шляпка
    part(cylZ(0.0095, 0.0095, 0.0015, 12), GOLD, [sx * 0.064, -0.038, 0.0335], [RX, 0, 0]);
    part(box(0.012, 0.075, 0.006), DARK, [sx * 0.064, 0.09, -0.006], [0, 0, -sx * 0.12]); // антенны
    part(box(0.014, 0.008, 0.008), GOLD, [sx * 0.06, 0.055, -0.006], [0, 0, 0]); // их шарниры
    part(box(0.03, 0.008, 0.012), DARK, [sx * 0.05, 0.062, -0.002]); // плечевые кнопки
  }
  part(box(0.112, 0.084, 0.006), BLACK, [0, 0.018, 0.0145]); // рамка экрана
  part(box(0.116, 0.004, 0.008), GOLD, [0, 0.062, 0.0145]); // золотая кайма
  part(box(0.116, 0.004, 0.008), GOLD, [0, -0.026, 0.0145]);
  part(cylZ(0.006, 0.006, 0.004, 10), GOLD, [0, -0.042, 0.0145], [RX, 0, 0]); // кнопка питания
  part(cylZ(0.004, 0.004, 0.004, 8), DARK, [-0.02, -0.046, 0.0145], [RX, 0, 0]);
  part(cylZ(0.004, 0.004, 0.004, 8), DARK, [0.02, -0.046, 0.0145], [RX, 0, 0]);
  const g = mergeGeometries(list, false);
  for (const p of list) p.dispose();
  g.computeBoundingSphere();
  return g;
}

// корпус дрона: рама frame ('light' | 'heavy'), краска слотов (1 — белый перламутр, 2 — золото)
// запечена в цвета вершин, пулемёт на подвесе — в ту же геометрию (один вызов отрисовки)
function buildBodyGeometry(THREE, frame = 'light') {
  const geo = buildDroneGeometries(THREE);
  const paint = (g) => {
    const slot = g.attributes.paintSlot;
    const col = g.attributes.color;
    const white = new THREE.Color(0xf4f2ee);
    const gold = new THREE.Color(GOLD);
    // корпус (графит) — белый, моторы (металл) — золотые; лучи и подвес остаются карбоном
    const graphite = new THREE.Color(0x24272b);
    const gunmetal = new THREE.Color(0x2e3236); // броня тяжёлой рамы
    const metal = new THREE.Color(0x6d7178);
    const same = (i, c) => Math.abs(col.getX(i) - c.r) + Math.abs(col.getY(i) - c.g) + Math.abs(col.getZ(i) - c.b) < 0.003;
    const body = g !== geo.gun;
    for (let i = 0; i < col.count; i += 1) {
      const s = slot.getX(i);
      if (s === 1 || (s === 0 && (same(i, graphite) || (body && same(i, gunmetal))))) col.setXYZ(i, white.r, white.g, white.b);
      else if (s === 2 || (s === 0 && same(i, metal))) col.setXYZ(i, gold.r, gold.g, gold.b);
    }
    g.deleteAttribute('paintSlot');
    return g;
  };
  const heavy = frame === 'heavy';
  const body = paint(heavy ? geo.heavy : geo.light);
  const gun = paint(geo.gun);
  if (heavy) gun.scale(GUN_SCALE_HEAVY, GUN_SCALE_HEAVY, GUN_SCALE_HEAVY); // крупнее пулемёт
  // пулемёт — отдельной сеткой на шарнире (GUN_PIVOT): наклоняется вместе с камерой (стик вверх/вниз)
  for (const g of [body, gun]) if (g.attributes.uv) g.deleteAttribute('uv');
  const merged = body.index ? body.toNonIndexed() : body;
  if (merged !== body) body.dispose();
  const gunGeo = gun.index ? gun.toNonIndexed() : gun;
  if (gunGeo !== gun) gun.dispose();
  (heavy ? geo.light : geo.heavy).dispose();
  geo.puff.dispose();
  // диски винтов: четыре круга (одна геометрия); у тяжёлой — внутри колец
  const discs = [];
  for (const [mx, my, mz] of MOTORS[frame]) {
    const d = geo.rotor.clone();
    d.scale(ROTOR_R[frame], 1, ROTOR_R[frame]);
    d.translate(mx, my + (heavy ? 0.005 : 0.045), mz);
    discs.push(d);
  }
  geo.rotor.dispose();
  const rotor = mergeGeometries(discs, false);
  discs.forEach((d) => d.dispose());
  return { body: merged, gun: gunGeo, rotor };
}

const screenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// изображение с камеры (байты как есть: цель отрисовки — как у прицела, scope-lens.js), крестик,
// шкала высоты справа; без сигнала — серый шум
const screenFragment = /* glsl */ `
  uniform sampler2D map;
  uniform float live;
  uniform float alt;
  uniform float time;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec3 c = texture2D(map, vUv).rgb;
    float n = hash(floor(vUv * vec2(160.0, 120.0)) + floor(time * 20.0));
    c = mix(vec3(0.08 + 0.12 * n), c, live);
    vec2 p = (vUv - 0.5) * vec2(4.0 / 3.0, 1.0);
    float px = fwidth(p.y) * 1.2;
    float h = (1.0 - smoothstep(0.004, 0.004 + px, abs(p.y))) * step(0.018, abs(p.x)) * step(abs(p.x), 0.06);
    float v = (1.0 - smoothstep(0.004, 0.004 + px, abs(p.x))) * step(0.018, abs(p.y)) * step(abs(p.y), 0.06);
    c = mix(c, vec3(1.0, 0.92, 0.6), max(h, v) * 0.85 * live);
    // шкала высоты: 0..60 м
    if (vUv.x > 0.94 && vUv.x < 0.965 && vUv.y > 0.12 && vUv.y < 0.88) {
      float k = (vUv.y - 0.12) / 0.76;
      c = mix(c, k < alt ? vec3(0.84, 0.65, 0.2) : vec3(0.1), 0.75 * live);
    }
    float r = length((vUv - 0.5) * vec2(1.0, 0.75));
    c *= 1.0 - 0.35 * smoothstep(0.35, 0.62, r);
    gl_FragColor = vec4(c, 1.0);
  }
`;

const load = () => {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s?.d?.length === 4 && s?.r?.p?.length === 3 && s?.r?.q?.length === 4) {
      const size = SIZES[s.s] ? s.s : 1; // в первых сохранениях размера нет — средний
      return { exists: true, size, camPitch: Number.isFinite(s.c) ? s.c : undefined, x: s.d[0], y: s.d[1], z: s.d[2], yaw: s.d[3], vx: 0, vy: 0, vz: 0, yawRate: 0, pitch: 0, roll: 0, rp: s.r.p, rq: s.r.q, held: false };
    }
  } catch {
    // нет сохранённого
  }
  return { exists: false, held: false, size: 1 };
};

export function createMyDrone({ THREE, root, scene, camera, renderer, shooting = null }) {
  const shared = (globalThis.__sceneState ??= {});
  const st = (shared.myDrone ??= load());
  const tex = droneTextures(THREE);
  const droneSound = createDroneSound(shared); // запекает буфер гула (кэш в __sceneState)

  // ---- дрон (геометрия — под размер st.size; новый размер — setSize)
  if (!SIZES[st.size]) st.size = 1;
  let size = SIZES[st.size];
  const built = buildBodyGeometry(THREE, size.frame);
  const drone = new THREE.Group();
  drone.name = 'my-drone';
  drone.scale.setScalar(size.span);
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.35, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.5 });
  const bodyMesh = new THREE.Mesh(built.body, bodyMat);
  drone.add(bodyMesh);
  const gunPivot = new THREE.Group(); // шарнир пулемёта: rotation.x = st.camPitch
  gunPivot.position.fromArray(GUN_PIVOT[size.frame]);
  const gunMesh = new THREE.Mesh(built.gun, bodyMat);
  gunPivot.add(gunMesh);
  drone.add(gunPivot);
  const rotorMap = tex.rotor.clone(); // своя копия для вращения (картинка та же: загрузка общая)
  rotorMap.center.set(0.5, 0.5);
  const rotorMat = new THREE.MeshBasicMaterial({ map: rotorMap, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const rotors = new THREE.Mesh(built.rotor, rotorMat);
  const setSize = (i) => {
    st.size = SIZES[i] ? i : 1;
    if (SIZES[st.size] === size) return;
    const was = size;
    size = SIZES[st.size];
    drone.scale.setScalar(size.span);
    if (was.frame === size.frame) return;
    const next = buildBodyGeometry(THREE, size.frame);
    bodyMesh.geometry.dispose();
    rotors.geometry.dispose();
    bodyMesh.geometry = next.body;
    rotors.geometry = next.rotor;
    gunMesh.geometry.dispose();
    gunMesh.geometry = next.gun;
    gunPivot.position.fromArray(GUN_PIVOT[size.frame]);
  };
  rotors.renderOrder = 3;
  drone.add(rotors);
  const beaconMat = new THREE.SpriteMaterial({ map: tex.glow, color: GOLD, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }); // fog: false — светящееся туман сцены не перекрашивает
  const beacon = new THREE.Sprite(beaconMat);
  beacon.position.set(0, 0.11, 0.06);
  beacon.scale.setScalar(0.22);
  drone.add(beacon);
  drone.visible = false;
  root.add(drone);

  // ---- пульт
  const remote = new THREE.Group();
  remote.scale.setScalar(REMOTE_SCALE); // весь пульт крупнее (экран вместе с ним)
  remote.name = 'my-drone-remote';
  const remoteGeo = buildRemoteGeometry(THREE);
  const remoteMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.25, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.6 });
  const remoteMesh = new THREE.Mesh(remoteGeo, remoteMat);
  remoteMesh.renderOrder = 2;
  remote.add(remoteMesh);
  // обводка «можно взять»: тот же силуэт крупнее, изнутри (как у оружия, pistols.js)
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, depthWrite: false });
  const outline = new THREE.Mesh(remoteGeo, outlineMat);
  outline.scale.setScalar(1.07);
  outline.renderOrder = 1;
  outline.visible = false;
  remote.add(outline);
  // экран: цель отрисовки живёт в __sceneState (переживает подмену, последняя картинка остаётся)
  if (!shared.myDroneRT || shared.myDroneRT.width !== RT_W) {
    shared.myDroneRT?.dispose();
    const t = new THREE.WebGLRenderTarget(RT_W, RT_H, { samples: RT_SAMPLES, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: true });
    t.isXRRenderTarget = true; // тон-маппинг и вывод как в шлеме (как scope-lens.js)
    t.texture.colorSpace = THREE.SRGBColorSpace;
    t.texture.internalFormat = 'RGBA8';
    shared.myDroneRT = t;
  }
  const target = shared.myDroneRT;
  const screenMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: target.texture }, live: { value: 0 }, alt: { value: 0 }, time: { value: 0 } },
    vertexShader: screenVertex,
    fragmentShader: screenFragment,
    toneMapped: false,
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), screenMat);
  screen.position.set(0, 0.018, 0.0178);
  screen.renderOrder = 2;
  remote.add(screen);
  remote.visible = false;
  root.add(remote);

  const cam = new THREE.PerspectiveCamera(CAM_FOV, RT_W / RT_H, 0.05, camera.far); // дальность как у глаз: купол неба ~4,5 км
  // наклон камеры (и прицела пулемёта) — стик вверх/вниз с пультом в руке; переживает подмену
  if (!Number.isFinite(st.camPitch)) st.camPitch = THREE.MathUtils.degToRad(-CAM_TILT_DEG);

  // ---- состояние
  let near = false;
  let lastFire = -1e9; // время последнего выстрела (time)
  let camLeft = 0;
  let saveLeft = 1;
  let dirty = false;
  let time = 0;
  let renders = 0, renderMs = 0, renderMax = 0, renderCalls = 0, statAt = performance.now();
  const seatM = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const seatTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(-SEAT_TILT_DEG));
  const seatLocal = new THREE.Matrix4().compose(new THREE.Vector3(...SEAT_POS), seatTilt, new THREE.Vector3(1, 1, 1));
  // своя посадка пульта в руке («Перенастроить хват»): localStorage 'scene.myDrone.seat' (16 чисел)
  const SEAT_KEY = 'scene.myDrone.seat';
  try {
    const saved = JSON.parse(localStorage.getItem(SEAT_KEY));
    if (Array.isArray(saved) && saved.length === 16) seatLocal.fromArray(saved);
  } catch {
    // без хранилища — посадка по умолчанию
  }
  let regrip = false;
  const headFwd = new THREE.Vector3(); // взгляд игрока по горизонтали (абсолютное управление)
  // АВТОПИЛОТ (пункт меню пульта): дрон сам воюет в рою союзников — ближайший враг (псы через
  // shooting.forEachEnemy, коптеры — shared.droneTargets не 'ally'), облёт по кругу, огонь, когда нос на цели
  const apTarget = new THREE.Vector3();
  let apHave = false;
  let apPick = 0; // с до следующего выбора цели
  let apAngle = Math.random() * Math.PI * 2;
  let modeYWas = true; // Y: режим пульта 1 ↔ 2 по нажатию (true — не срабатывать на уже зажатую при подмене) // «Перенастроить хват»: пульт замер, следующий хват берёт его как есть
  const debugInput = { value: null };

  const applyRemote = () => {
    if (!st.exists) return;
    remote.position.fromArray(st.rp);
    remote.quaternion.fromArray(st.rq);
  };
  const storeRemote = () => {
    st.rp = remote.position.toArray();
    st.rq = remote.quaternion.toArray();
  };
  const save = () => {
    dirty = false;
    try {
      if (!st.exists) localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, JSON.stringify({ s: st.size, c: +st.camPitch.toFixed(3), d: [st.x, st.y, st.z, st.yaw].map((n) => +n.toFixed(3)), r: { p: st.rp, q: st.rq } }));
    } catch {
      // без хранилища не переживёт перезагрузку
    }
  };

  // перед игроком: дрон в 2,5 м + 1,5 размаха впереди чуть выше глаз, носом от игрока; пульт — в полуметре, экраном к нему
  const headPose = () => {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    return { head, dir };
  };
  const placeDrone = () => {
    const { head, dir } = headPose();
    const far = 2.5 + 1.5 * size.span;
    st.x = head.x + dir.x * far;
    st.z = head.z + dir.z * far;
    st.y = Math.max(head.y + 0.3 + 0.3 * size.span, groundHeight(st.x, st.z) + ALT_MIN + 0.6 * size.span);
    st.yaw = Math.atan2(-dir.x, -dir.z);
    st.vx = st.vy = st.vz = st.yawRate = st.pitch = st.roll = 0;
  };
  // новый дрон размера i (0 маленький … 3 огромный) заменяет прежний; пульт — снова перед игроком
  const spawn = (i = st.size ?? 1) => {
    setSize(i);
    placeDrone();
    const { head, dir } = headPose();
    remote.position.copy(head).addScaledVector(dir, 0.45);
    remote.position.y = head.y - 0.3;
    euler.set(-0.5, Math.atan2(-dir.x, -dir.z), 0, 'YXZ'); // экраном (+Z) к игроку, наклон назад
    remote.quaternion.setFromEuler(euler);
    st.exists = true;
    st.held = false;
    storeRemote();
    save();
  };

  // ---- звук гула: свой постоянный голос (игрок; → master)
  const humVoice = () => {
    const g = shared.audioGraph;
    const c = g?.context;
    const buffer = shared.droneSoundBank?.buffers?.hum?.[0];
    if (!c || !g.master || !buffer) return null;
    const old = shared.myDroneVoice;
    if (old?.context === c && old.master === g.master) return old;
    try {
      old?.source?.stop();
      old?.input.disconnect();
    } catch {
      // уже отключён
    }
    const input = c.createGain();
    input.gain.value = 0;
    const panner = c.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 2.5;
    panner.rolloffFactor = 1;
    panner.maxDistance = 300;
    input.connect(panner).connect(g.master);
    if (g.reverbSend) {
      const send = c.createGain();
      send.gain.value = 0.06;
      input.connect(send).connect(g.reverbSend);
    }
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(input);
    source.start();
    return (shared.myDroneVoice = { context: c, master: g.master, input, panner, source });
  };
  const humStep = () => {
    try {
      const v = humVoice();
      if (!v) return;
      const t = v.context.currentTime;
      if (!st.exists) {
        v.input.gain.setTargetAtTime(0, t, 0.05);
        return;
      }
      if (v.panner.positionX) {
        v.panner.positionX.value = st.x;
        v.panner.positionY.value = st.y;
        v.panner.positionZ.value = st.z;
      } else v.panner.setPosition(st.x, st.y, st.z);
      // по размеру: больше — ниже, громче и слышнее издалека (hum: громкость, скорость, опорное расстояние)
      const [gain, rate, ref] = size.hum;
      if (v.panner.refDistance !== ref) v.panner.refDistance = ref;
      const sp = Math.min(1, Math.hypot(st.vx, st.vy, st.vz) / size.maxV);
      const climb = Math.max(0, st.vy / size.upV);
      v.input.gain.setTargetAtTime(gain * (1 + 0.4 * sp + 0.2 * climb), t, 0.1);
      v.source.playbackRate.value = rate * (1 + 0.14 * sp + 0.1 * climb);
    } catch {
      // звук не важнее игры
    }
  };

  // ---- камера дрона → экран пульта
  const noop = () => {};
  const renderCamera = () => {
    const t0 = performance.now();
    euler.set(st.camPitch, st.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(euler);
    const at = CAM_AT[size.frame];
    cam.position.set(st.x, st.y, st.z).add(tmpV.set(at[0], at[1], at[2]).multiplyScalar(size.span).applyQuaternion(tmpQ.setFromEuler(euler.set(0, st.yaw, 0, 'YXZ'))));
    cam.updateMatrixWorld();
    const prevTarget = renderer.getRenderTarget();
    const xrWas = renderer.xr.enabled;
    const before = scene.onBeforeRender;
    const after = scene.onAfterRender;
    const cameraWas = camera.visible;
    const extra = shared.scopeHide;
    const extraWas = [];
    try {
      renderer.xr.enabled = false;
      scene.onBeforeRender = noop;
      scene.onAfterRender = noop;
      drone.visible = false;
      screen.visible = false;
      if (extra) for (const o of extra) { extraWas.push(o.visible); o.visible = false; }
      camera.visible = false; // HUD висит на камере
      renderer.setRenderTarget(target);
      // звёзды — в пикселях этого кадра (240 по высоте), иначе они размером как в шлеме и выглядят огромными
      const starPx = shared.skyStarPx;
      const starWas = starPx?.value;
      if (starPx) starPx.value = RT_H / 2;
      renderer.render(scene, cam);
      if (starPx) starPx.value = starWas;
      renderCalls = renderer.info.render.calls;
    } finally {
      camera.visible = cameraWas;
      if (extra) { let k = 0; for (const o of extra) o.visible = extraWas[k++] ?? o.visible; }
      drone.visible = st.exists;
      screen.visible = true;
      scene.onBeforeRender = before;
      scene.onAfterRender = after;
      renderer.xr.enabled = xrWas;
      renderer.setRenderTarget(prevTarget);
    }
    const ms = performance.now() - t0;
    renders += 1;
    renderMs += ms;
    renderMax = Math.max(renderMax, ms);
  };

  // ---- пулемёт дрона: пули игрока вдоль камеры (в крестик)
  const muzzle = new THREE.Vector3();
  const aim = new THREE.Vector3();
  // shooting.shoot — та же дорога, что у оружия в руке: псы, ноги, тела, коптеры, мишени, тарелки;
  // трассер и звук выстрела — игрока (звук — у дрона, в 3D). onResult(true) — попал: отдача в руку
  let padSource = null;
  const onResult = (hit) => {
    if (hit) padSource?.gamepad?.hapticActuators?.[0]?.pulse?.(0.7, 40);
  };
  const fireGun = (source) => {
    if (!shooting) return;
    padSource = source;
    euler.set(st.camPitch, st.yaw, 0, 'YXZ');
    tmpQ.setFromEuler(euler);
    aim.set(0, 0, -1).applyQuaternion(tmpQ);
    drone.updateWorldMatrix(true, false);
    const pivot = GUN_PIVOT[size.frame];
    const g = size.frame === 'heavy' ? GUN_SCALE_HEAVY : 1;
    gunPivot.updateWorldMatrix(true, false);
    muzzle.set(GUN_MUZZLE[0] * g, GUN_MUZZLE[1] * g, GUN_MUZZLE[2] * g).applyMatrix4(gunPivot.matrixWorld); // шарнир наклонён — дуло тоже
    void pivot;
    shared.sound?.setWeapon?.(size.sound);
    shared.shotKind = size.shot;
    // трассер всегда (даже при «Трассеры: выкл») и заметная пыль в земле — крупнее у больших дронов
    shooting.shoot(muzzle, aim, { speed: size.speed, big: size.flash, onResult, forceTracer: true, groundFx: GROUND_FX[st.size] ?? 2 });
    source?.gamepad?.hapticActuators?.[0]?.pulse?.(size.shot === 'awp' ? 0.6 : 0.25, size.shot === 'awp' ? 60 : 25);
  };


  applyRemote();
  let debug = null;
  const api = {
    get held() {
      return Boolean(st.exists && st.held);
    },
    get near() {
      return near;
    },
    get exists() {
      return Boolean(st.exists);
    },
    spawn,
    get size() {
      return st.size;
    },
    // «Дрон ко мне»: дрон снова перед игроком
    recall() {
      if (!st.exists) return spawn();
      placeDrone();
      save();
    },
    // «Отпустить пульт»: пульт висит, где был
    release() {
      if (!st.held) return;
      st.held = false;
      regrip = false;
      storeRemote();
      save();
    },
    // «Перенастроить хват»: пульт замирает, следующий хват рядом задаёт новую посадку
    regrip() {
      if (!st.exists) return;
      st.held = false;
      regrip = true;
      storeRemote();
      save();
    },
    // «Автопилот: вкл/выкл»
    toggleAutopilot() {
      st.autopilot = !st.autopilot;
      apPick = 0;
      save();
      return st.autopilot;
    },
    get autopilot() {
      return Boolean(st.autopilot);
    },
    get regripping() {
      return regrip;
    },
    remove() {
      st.exists = false;
      st.held = false;
      near = false;
      save();
    },
    // хват (main.js, раздел хвата; только когда рука есть). Возвращает 'grab' | 'release' | null
    hand({ gripWorld, handPosition, seat = null, gripDown, gripPressed, gripMode, menuIsOpen, handBusy }) {
      near = false;
      if (!st.exists) return null;
      if (st.held) {
        // отпустить — только пунктом меню «Отпустить пульт» (меню — кнопкой «≡»); хват пульт не отпускает
        if (seat) {
          seat.updateMatrix();
          seatM.copy(seat.matrix);
        } else seatM.identity();
        tmpM.copy(gripWorld).multiply(seatM).multiply(seatLocal);
        tmpM.decompose(remote.position, remote.quaternion, tmpV2);
        storeRemote();
        return null;
      }
      if (!handBusy && !menuIsOpen) {
        remote.updateWorldMatrix(true, false);
        near = remote.getWorldPosition(tmpV).distanceTo(handPosition) < REACH;
        if (near && gripPressed) {
          if (regrip) {
            // новая посадка: пульт остаётся, как висел, относительно руки (как «Перенастроить оси» у оружия)
            if (seat) {
              seat.updateMatrix();
              seatM.copy(seat.matrix);
            } else seatM.identity();
            remote.updateWorldMatrix(true, false);
            seatLocal.copy(gripWorld).multiply(seatM).invert().multiply(remote.matrixWorld);
            try {
              localStorage.setItem(SEAT_KEY, JSON.stringify(seatLocal.toArray().map((n) => +n.toFixed(5))));
            } catch {
              // без хранилища посадка живёт до перезагрузки
            }
            regrip = false;
          }
          st.held = true;
          near = false;
          camLeft = 0; // экран оживает сразу
          return 'grab';
        }
      }
      return null;
    },
    // полёт, звук, экран; realDt — реальное время (дрон — не мир)
    update(realDt, source, menuIsOpen) {
      const dt = Math.min(Math.max(realDt, 0), 0.05);
      time += dt;
      drone.visible = st.exists;
      remote.visible = st.exists;
      outline.visible = near && !st.held;
      if (!st.exists) {
        humStep();
        return;
      }
      if (!st.held) applyRemote();
      // ввод: пульт в руке и меню закрыто (или подмена с ПК: debug.input)
      // УПРАВЛЕНИЯ С ПУЛЬТА ПОКА НЕТ (пользователь добавляет его по одному элементу): кнопки контроллера
      // с пультом в руке значат то же, что всегда. Ввод — только подмена с ПК (debug.input):
      // fwd −1 (назад) … 1 (вперёд), sx — поворот, sy — наклон камеры, up/down, fire
      let sx = 0, sy = 0, fwdIn = 0, up = 0, down = 0, fire = false;
      if (debugInput.value) ({ sx = 0, sy = 0, fwd: fwdIn = 0, up = 0, down = 0, fire = false } = debugInput.value);
      // АБСОЛЮТНОЕ управление (пользователь): пульт в руке, меню закрыто —
      //   стик вверх/вниз — дрон от игрока / к игроку, влево/вправо — влево/вправо (по взгляду игрока, а не по носу дрона);
      //   курок — вверх, хват — вниз (по силе нажатия). Камера/разворот/стрельба с пульта пока не управляются.
      let absX = 0, absZ = 0;
      if (st.held && !menuIsOpen && !st.autopilot) {
        const gp = source?.gamepad;
        if (gp) {
          const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
          const ax = dz(gp.axes?.[2] ?? 0);
          const ay = dz(gp.axes?.[3] ?? 0);
          camera.getWorldDirection(headFwd);
          headFwd.y = 0;
          if (headFwd.lengthSq() < 1e-6) headFwd.set(0, 0, -1);
          headFwd.normalize();
          // вправо от взгляда: (−fz, fx)
          // Y (кнопка 5; с пультом в руке у Y другой роли нет, controls-map.js) — переключить режим 1 ↔ 2
          const yNow = Boolean(gp.buttons?.[5]?.pressed);
          if (yNow && !modeYWas) {
            st.mode = st.mode === 2 ? 1 : 2;
            gp.hapticActuators?.[0]?.pulse?.(0.5, st.mode === 2 ? 120 : 40); // режим 2 — длинный толчок
          }
          modeYWas = yNow;
          sx = ax; // в обоих режимах влево/вправо — разворот дрона
          if (st.mode === 2) {
            // РЕЖИМ 2: вверх/вниз — пушка и камера вверх/вниз; курок — стрелять
            // прицеливание: кубическая кривая — малый наклон стика очень медленно (точно), полный — быстро;
            // разворот в режиме 2 ещё и вдвое медленнее, чем в полёте
            sy = aimCurve(ay) * 0.6;
            sx = aimCurve(ax) * 0.5;
            fire = Boolean(gp.buttons?.[0]?.pressed);
          } else {
            // РЕЖИМ 1: стик вверх/вниз — дрон вверх/вниз; курок — вперёд по носу, хват — назад (по силе нажатия)
            const trig = gp.buttons?.[0]?.value ?? (gp.buttons?.[0]?.pressed ? 1 : 0);
            const grip = gp.buttons?.[1]?.value ?? (gp.buttons?.[1]?.pressed ? 1 : 0);
            fwdIn = trig - grip;
            up = Math.max(0, -ay); // стик вверх — ось < 0
            down = Math.max(0, ay);
          }
        }
      }
      // наклон камеры (только отладочный ввод): sy < 0 — камера вверх
      if (sy) st.camPitch = THREE.MathUtils.clamp(st.camPitch - sy * THREE.MathUtils.degToRad(CAM_PITCH_RATE) * dt, THREE.MathUtils.degToRad(CAM_PITCH_MIN), THREE.MathUtils.degToRad(CAM_PITCH_MAX));
      const fx = -Math.sin(st.yaw), fz = -Math.cos(st.yaw);
      const fwd = fwdIn * size.maxV; // отладочный ввод — по носу
      let tvx = fx * fwd + absX, tvz = fz * fwd + absZ;
      let tvy = up * size.upV - down * size.upV * 0.85;
      if (st.autopilot) {
        apPick -= dt;
        if (apPick <= 0) {
          apPick = 0.5;
          apHave = false;
          let best = Infinity;
          const consider = (c) => {
            const d2 = (c.x - st.x) ** 2 + (c.y - st.y) ** 2 + (c.z - st.z) ** 2;
            if (d2 < best && d2 < 250 * 250) { best = d2; apTarget.set(c.x, c.y, c.z); apHave = true; }
          };
          shooting?.forEachEnemy?.((c) => consider(c));
          const list = shared.droneTargets;
          if (list) for (let i = 0; i < list.length; i += 1) { const t = list[i]; if (t.team !== 'ally' && t.state === 'alive') consider(t); } // в пуле есть пустые ('off') в (0,0,0) — под вышкой
        }
        if (apHave) {
          // облёт цели: радиус и высота по размеру дрона
          apAngle += dt * 0.35;
          const R = 10 + 5 * st.size;
          const ox = apTarget.x + Math.cos(apAngle) * R, oz = apTarget.z + Math.sin(apAngle) * R;
          const oy = apTarget.y + 5 + size.span * 1.5;
          const dx = ox - st.x, dy = oy - st.y, dzz = oz - st.z;
          const dist = Math.hypot(dx, dzz) || 1;
          const sp = Math.min(size.maxV, dist * 1.2);
          tvx = (dx / dist) * sp; tvz = (dzz / dist) * sp;
          tvy = THREE.MathUtils.clamp(dy * 1.5, -size.upV, size.upV);
          // нос и пушка — на цель
          const hx = apTarget.x - st.x, hz = apTarget.z - st.z, hy = apTarget.y - st.y;
          const wantYaw = Math.atan2(-hx, -hz);
          let dyaw = wantYaw - st.yaw;
          dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
          sx = THREE.MathUtils.clamp(-dyaw * 2.5, -1, 1);
          const wantPitch = THREE.MathUtils.clamp(Math.atan2(hy, Math.hypot(hx, hz)), THREE.MathUtils.degToRad(CAM_PITCH_MIN), THREE.MathUtils.degToRad(CAM_PITCH_MAX));
          st.camPitch += (wantPitch - st.camPitch) * Math.min(1, dt * 4);
          fire = Math.abs(dyaw) < 0.12 && Math.hypot(hx, hz, hy) < 80;
        } else {
          tvx = 0; tvz = 0; tvy = 0; // нет врагов — висит
        }
      }
      const k = Math.min(1, dt * RESPONSE * 2.2);
      let ax = (tvx - st.vx) * k / Math.max(dt, 1e-4);
      let ay = (tvy - st.vy) * k / Math.max(dt, 1e-4);
      let az = (tvz - st.vz) * k / Math.max(dt, 1e-4);
      const a = Math.hypot(ax, ay, az);
      if (a > size.acc) {
        ax *= size.acc / a;
        ay *= size.acc / a;
        az *= size.acc / a;
      }
      st.vx += ax * dt;
      st.vy += ay * dt;
      st.vz += az * dt;
      st.yawRate += (-sx * size.yaw - st.yawRate) * Math.min(1, dt * 6);
      st.yaw += st.yawRate * dt;
      st.x += st.vx * dt;
      st.y += st.vy * dt;
      st.z += st.vz * dt;
      // границы: высота над землёй, дальность от центра мира
      const gy = groundHeight(st.x, st.z);
      const low = ALT_MIN + 0.3 * size.span;
      if (st.y < gy + low) {
        st.y = gy + low;
        st.vy = Math.max(0, st.vy);
      } else if (st.y > gy + ALT_MAX) {
        st.y = gy + ALT_MAX;
        st.vy = Math.min(0, st.vy);
      }
      const r = Math.hypot(st.x, st.z);
      if (r > RANGE_M) {
        st.x *= RANGE_M / r;
        st.z *= RANGE_M / r;
      }
      // наклон корпуса: нос вниз при разгоне вперёд, крен в поворот; лёгкое покачивание в висении
      const vf = st.vx * fx + st.vz * fz;
      const af = ax * fx + az * fz;
      const pitchT = THREE.MathUtils.clamp(-(0.3 * vf) / size.maxV - 0.025 * af, -0.5, 0.5);
      const rollT = THREE.MathUtils.clamp(0.06 * st.yawRate * Math.max(2, Math.abs(vf)), -0.45, 0.45);
      st.pitch += (pitchT - st.pitch) * Math.min(1, dt * 6);
      st.roll += (rollT - st.roll) * Math.min(1, dt * 6);
      const wob = 0.025 * Math.sin(time * 1.7) + 0.012 * Math.sin(time * 4.3);
      drone.position.set(st.x, st.y + wob, st.z);
      gunPivot.rotation.x = st.camPitch; // пулемёт смотрит туда же, куда камера (стик вверх/вниз)
      euler.set(st.pitch + 0.02 * Math.sin(time * 2.3), st.yaw, st.roll + 0.025 * Math.sin(time * 1.9), 'YXZ');
      drone.quaternion.setFromEuler(euler);
      rotorMap.rotation = (rotorMap.rotation + dt * 31) % (Math.PI * 2);
      beaconMat.opacity = 0.55 + 0.45 * Math.max(0, Math.sin(time * 5));
      beacon.scale.setScalar(0.24 + 0.14 * beaconMat.opacity);

      // курок зажат — очередь в темпе size.gap (частые нажатия быстрее темпа не стреляют)
      if (fire && time - lastFire >= size.gap) {
        lastFire = time - dt > lastFire + size.gap * 2 ? time : lastFire + size.gap;
        fireGun(source);
      }

      humStep();

      // экран: живой, пока пульт в руке (CAM_FPS кадров в секунду)
      const live = st.held || Boolean(debugInput.value);
      screenMat.uniforms.live.value += ((live ? 1 : 0) - screenMat.uniforms.live.value) * Math.min(1, dt * 8);
      screenMat.uniforms.alt.value = (st.y - gy) / ALT_MAX;
      screenMat.uniforms.time.value = time;
      if (live) {
        camLeft -= realDt;
        if (camLeft <= 0) {
          camLeft = Math.max(0, camLeft + 1 / CAM_FPS);
          renderCamera();
        }
      }
      const now = performance.now();
      if (now - statAt >= LOG_EVERY_MS) {
        if (renders) console.log(`[mydrone] cam n=${renders}/${((now - statAt) / 1000).toFixed(0)}s cpu=${(renderMs / renders).toFixed(2)}/${renderMax.toFixed(2)}ms calls=${renderCalls} ${RT_W}x${RT_H} msaa=${RT_SAMPLES}`);
        renders = renderMs = renderMax = 0;
        statAt = now;
      }
      saveLeft -= dt;
      if (Math.abs(st.vx) + Math.abs(st.vy) + Math.abs(st.vz) > 0.01 || st.held) dirty = true;
      if (saveLeft <= 0) {
        saveLeft = 1;
        if (dirty) save();
      }
    },
    dispose() {
      // объекты в root освобождает оболочка (и держит их, пока новая сцена не нарисована)
      const steps = [
        () => dirty && save(),
        () => {
          const v = shared.myDroneVoice;
          if (v && !st.exists) v.input.gain.setTargetAtTime(0, v.context.currentTime, 0.05);
        },
        () => [bodyMesh.geometry, gunMesh.geometry, rotors.geometry, remoteGeo, screen.geometry, bodyMat, rotorMat, rotorMap, beaconMat, remoteMat, outlineMat, screenMat].forEach((o) => o.dispose()),
        () => {
          if (shared.myDroneDebug === debug) shared.myDroneDebug = null;
        },
      ];
      for (const step of steps) {
        try {
          step();
        } catch (e) {
          console.warn('[mydrone] dispose:', e);
        }
      }
    },
  };
  // ручка для npm run vr:eval (только страница на ПК: шлем не трогать)
  debug = {
    info: () => ({ ...st, near, renders, lastMs: renders ? +(renderMs / renders).toFixed(2) : null, calls: renderCalls, sound: droneSound ? 'ok' : null }),
    set input(v) {
      debugInput.value = v;
    },
    get input() {
      return debugInput.value;
    },
    // нарисовать кадр камеры сейчас, вернуть мс; pose { x, y, z, yaw } — временно оттуда (замер цены
    // без дрона: на экран ничего не попадает)
    shot(pose = null) {
      const keep = { x: st.x, y: st.y, z: st.z, yaw: st.yaw };
      if (pose) Object.assign(st, pose);
      const t0 = performance.now();
      try {
        renderCamera();
      } finally {
        if (pose) Object.assign(st, keep);
      }
      return { ms: +(performance.now() - t0).toFixed(2), calls: renderCalls };
    },
    api,
    drone,
    remote,
  };
  shared.myDroneDebug = debug;
  return api;
}
