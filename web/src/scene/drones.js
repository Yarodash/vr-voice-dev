// Квадрокоптеры с пулемётами в большой битве («Сцена 3», функция сцены «robodogHorde»; меню
// «Собаки ▸ Квадрокоптеры: вкл/выкл», shared.drones, localStorage 'scene.drones', по умолчанию вкл).
//
// Четыре размера (SIZES: маленький 0,4 м, средний 0,9 м, большой 2 м, огромный 5 м размаха), у всех
// пулемёт на шаре-подвесе под корпусом. Две команды, как у псов: враги (красно-оранжевые) прилетают
// волнами спереди (с «вперёд» мира, −Z, ±35°, 95–130 м), союзники (зелёно-белые) — сзади. Стороны
// наравне: TEAM_MAX живых у каждой, одинаковые волны и доли размеров; отставшая сторона догоняет
// (волна больше на разницу, до CATCH_UP, и чаще); волна псов стороны (shared.dogWave из
// robodog-horde.js) — большая волна её коптеров.
// Летают на своей высоте (крупнее — выше: 3–9 м … 22–40 м над землёй), кружат вокруг цели на своём
// радиусе, иногда меняют направление; корпус наклоняется по ускорению (крен в повороте), висит с
// лёгким покачиванием. Цель — ближайший противник (игрок, пёс или коптер другой команды; «липкая»,
// пересмотр раз в RETARGET_S). Стреляют очередями по 3–5 (трассеры цвета команды, разброс по
// размеру). По игроку — только спереди (±FRONT_ANGLE от «вперёд» мира, как пулемёты псов) и без
// урона: попадание лишь трясёт обзор (shared.screenShake). По псам и коптерам — урон.
// Враги спокойны (кружат, не стреляют), пока игрок не выстрелил или их не задели.
// Часть коптеров — сопровождение стай псов (ESCORT_*, d.squad): висят низко над своей стаей, идут за
// ней и бьют противника рядом со стаей; цель — метка для псов стаи (shared.squadMarks).
//
// Попадания игрока: shooting.addShootable (шар на коптер), aimTargets — для автонаводки (союзники
// пропускаются, по своим — искры без урона). HP по размеру; АВП бьёт сильно. Подбит: хлопок, искры,
// дымный след, крутится и падает; о землю — взрыв (огонь, дым, искры, звук, тряска рядом, урон псам
// рядом), обломки лежат обугленные и уходят в землю.
//
// Дёшево: все коптеры — экземплярами (drone-model.js): корпус лёгкий, корпус тяжёлый, пулемёт, диски
// винтов, огни, огонь, дым + искры/трассеры (robodog-fx.js) — 8 вызовов отрисовки на всех, пустые не
// рисуются. Состояние — простые объекты из пула (MAX), без выделений памяти в кадре; далёкие коптеры
// решают, куда лететь, реже (LOD_*), но двигаются каждый кадр. Звук — drone-sound.js.
//
// Для стаи псов (robodog-horde.js может читать, не обязательно): shared.droneTargets — массив коптеров
// ({ isDrone, state: 'alive'|…, team, x, y, z, span }); shared.droneStrike(drone, point, dir, damage) —
// попадание по коптеру (урон, искры; противник — враг для союзников и наоборот).
//
// createDrones({ THREE, root, camera, renderer, shooting, horde }) → { apply(on, { keep }), update(dt),
//   debug, dispose() }
import { buildDroneGeometries, droneTextures, MOTORS, ROTOR_R, GUN_PIVOT, GUN_MUZZLE, LIGHTS } from './drone-model.js';
import { createDroneSound, BURST_GAP } from './drone-sound.js';
import { createZapFx } from './robodog-fx.js';
import { ensureWeaponEnv } from './weapon-env.js';
import { groundHeight } from './car.js';
import { MAX_STEP_S } from './world-clock.js';
import { battleSeconds, droneSizeWeights, dronesAllowed, pickWeighted } from './progression.js';

const PROGRAM_KEY = 'drone-inst-1';
const MAX = 44; // коптеров всего (живые, падающие, обломки)
// стороны наравне и в воздухе, и на земле (по просьбе пользователя): живых у каждой не больше TEAM_MAX
const TEAM_MAX = 20;
// сколько пуль игрока сбивает коптер по размеру (маленький, средний, большой, огромный) — по просьбе
const PLAYER_SHOTS = [1, 2, 4, 6];
// Размеры. span — размах, м; kind — корпус; hp — [от, до]; speed, acc — м/с, м/с²; alt — высота над
// землёй; R — радиус круга вокруг цели; range — дальность стрельбы; rounds — выстрелов в очереди;
// cd — пауза между очередями, с; spread — разброс, рад (σ); dmg — урон псу/коптеру за пулю; tilt —
// наибольший наклон корпуса, рад; turn, gunTurn — рад/с; weight — доля при появлении; maxAlive —
// живых такого размера в команде не больше
const SIZES = [
  { name: 'маленький', span: 0.4, kind: 'light', hp: [1, 2], speed: 13, acc: 12, alt: [3, 9], R: [6, 12], range: 45, rounds: [3, 3], cd: [1.4, 2.4], spread: 0.022, dmg: 0.5, tilt: 0.55, turn: 3, gunTurn: 4, weight: 40 },
  { name: 'средний', span: 0.9, kind: 'light', hp: [3, 4], speed: 11, acc: 8, alt: [6, 16], R: [10, 18], range: 55, rounds: [3, 4], cd: [1.6, 2.8], spread: 0.017, dmg: 0.7, tilt: 0.45, turn: 2.2, gunTurn: 3.2, weight: 32 },
  { name: 'большой', span: 2, kind: 'heavy', hp: [8, 9], speed: 8.5, acc: 5, alt: [12, 26], R: [16, 28], range: 70, rounds: [4, 5], cd: [1.8, 3], spread: 0.013, dmg: 1, tilt: 0.32, turn: 1.2, gunTurn: 2.4, weight: 20, maxAlive: 4 },
  { name: 'огромный', span: 5, kind: 'heavy', hp: [20, 20], speed: 6.5, acc: 3, alt: [22, 40], R: [25, 40], range: 95, rounds: [5, 5], cd: [2, 3.2], spread: 0.01, dmg: 1.5, tilt: 0.2, turn: 0.6, gunTurn: 1.6, weight: 8, maxAlive: 2 },
];
const SIZE_WEIGHT = SIZES.reduce((s, z) => s + z.weight, 0);
const PAINT = {
  enemy: [0xd2451c, 0x1d1d1f], // красно-оранжевый + чёрный
  ally: [0x3fae4a, 0xe9ece6], // зелёный + белый (как союзные псы)
};
const BEACON = { enemy: 0xff2a14, ally: 0x3dff6a };
const EYE = { enemy: 0xff3a1a, ally: 0x7dffb0 };
const BULLET_SPEED = 180; // м/с — трассер видно
const HIT_R_PLAYER = 0.3; // пуля ближе к точке прицела (голова −0,25 м) — попала
const FRONT_ANGLE = (70 * Math.PI) / 180; // по игроку — только спереди (как пулемёты псов)
const FRONT_ORBIT = (60 * Math.PI) / 180; // враги кружат вокруг игрока только в этом секторе
const RETARGET_S = 0.7;
const SEARCH_M = 160;
const LOD_NEAR = 70; // дальше — решают, куда лететь, раз в 2 кадра
const LOD_FAR = 120; // дальше — раз в 4
const WRECK_S = 4; // обломки лежат
const WRECK_BUSY_S = 2;
const SINK_S = 1.5;
const FIRST_ENEMY = 3; // с до первой волны
const FIRST_ALLY = 5;
const WAVE_GAP = 10; // с между волнами стороны в начале (у обеих одинаково)
const WAVE_GAP_MIN = 6; // и через ~3 минуты
const WAVE_N = [3, 5]; // коптеров в обычной волне (у обеих одинаково)
// волна псов стороны (robodog-horde.js → shared.dogWave) — с ней вылетает и волна её коптеров
// SURGE_N штук, а обычная волна этой стороны откладывается (качели и в воздухе)
const SURGE_N = [6, 8];
const CATCH_UP = 4; // отставшая сторона добавляет к волне разницу в живых, но не больше стольких
const RAMP = 0.02;
const FIRE_CAP = 90;
const SMOKE_CAP = 120;
const PENDING = 48;
const SHAKE_GAP_MS = 350;
const LOG_EVERY_MS = 10000;
// Сопровождение стай (по просьбе пользователя: псы и коптеры заодно). Новая стая (robodog-horde.js →
// shared.squadQueue) получает 1–3 коптера (маленькие/средние) с d.squad = номер стаи: висят низко над
// стаей (ESCORT_ALT над землёй, кругом ESCORT_R, на равных углах), идут за ней и бьют ближайшего
// противника стаи (в ESCORT_SEEK м от её центра — псы, коптеры, игрок спереди); цель — метка для псов
// стаи (shared.squadMarks). Стая погибла — коптер становится свободным.
const ESCORT_ALT = [3, 8];
const ESCORT_R = [4, 8]; // +√(число псов)
const ESCORT_SEEK = 23;
const ESCORT_EVERY = 0.3; // с — пересчёт центра стаи и цели
const ESCORT_SPIN = 0.35; // рад/с — круг над стаей
const ESCORT_MAX = 12; // сопровождения у стороны не больше (≈60 % TEAM_MAX)
const ESCORT_KEEP = 6; // свободные волны оставляют сопровождению хотя бы столько мест

const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(Math.PI * 2 * Math.random());
const turnTo = (cur, goal, step) => cur + Math.max(-step, Math.min(step, wrap(goal - cur)));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const newDrone = (id) => ({
  id, isDrone: true, state: 'off', team: 'enemy', size: 0, span: 1, hp: 1, hpMax: 1,
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, az: 0, yaw: 0, pitch: 0, roll: 0, tx: 0, tz: 0,
  gy: 0, gp: 0, aimErr: 9, alt: 10, R: 10, orbitDir: 1, orbitA: 0, t: 0, age: 0,
  target: null, retarget: 0, cd: 1, shots: 0, gap: 0, flash: 0, angry: false, spin: 0, wob: 0,
  lodAcc: 0, smokeT: 0, humJit: 0, spinRate: 0, tumble: 0, blink: 0, hitR: 0.2,
  squad: 0, sqT: 0, sqN: 0, sqX: 0, sqZ: 0, sqVX: 0, sqVZ: 0, sqSince: 0, sqP: false, sqA: 0, sqDir: 1,
});

export function createDrones({ THREE, root, camera, renderer = null, shooting = null, horde = null, onKill = null }) {
  const shared = (globalThis.__sceneState ??= {});
  if (shared.drones === undefined) {
    try {
      shared.drones = localStorage.getItem('scene.drones') !== 'off';
    } catch {
      shared.drones = true;
    }
  }
  const sound = createDroneSound(shared);
  let enabled = false;
  let built = null; // меши и материалы (создаются при первом включении)
  let fx = null; // искры, вспышки, трассеры (robodog-fx.js)
  let removeShootable = null;
  // { elapsed, nextEnemy, nextAlly, angry, drones } — переживает подмену файла сцены
  let run = shared.droneRun ?? null;
  let drones = run?.drones ?? null;

  const head = new THREE.Vector3();
  const camQ = new THREE.Quaternion();
  const M = new THREE.Matrix4();
  const L = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const Qr = new THREE.Quaternion();
  const E = new THREE.Euler(0, 0, 0, 'YXZ');
  const V = new THREE.Vector3();
  const V2 = new THREE.Vector3();
  const P = new THREE.Vector3();
  const S3 = new THREE.Vector3();
  const muzzle = new THREE.Vector3();
  const shotDir = new THREE.Vector3();
  const hitP = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const ZAXIS = new THREE.Vector3(0, 0, 1);
  const YAXIS = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const teamPaint = {
    enemy: [new THREE.Color(PAINT.enemy[0]), new THREE.Color(PAINT.enemy[1])],
    ally: [new THREE.Color(PAINT.ally[0]), new THREE.Color(PAINT.ally[1])],
  };
  const beacon = { enemy: new THREE.Color(BEACON.enemy), ally: new THREE.Color(BEACON.ally) };
  const eyeCol = { enemy: new THREE.Color(EYE.enemy), ally: new THREE.Color(EYE.ally) };
  const navRed = new THREE.Color(0xff2a1a);
  const navGreen = new THREE.Color(0x2aff55);
  const white = new THREE.Color(0xffffff);

  // ---------------------------------------------------------------- меши
  const build = () => {
    const geo = buildDroneGeometries(THREE);
    const tex = droneTextures(THREE);
    const env = renderer ? ensureWeaponEnv(THREE, renderer) : null;
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.45, envMap: env, envMapIntensity: 0.6, flatShading: true });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float paintSlot;\nattribute vec3 aPaintA;\nattribute vec3 aPaintB;\nattribute vec4 aFx;\nvarying vec3 vDroneEm;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n\tvColor.rgb = paintSlot > 1.5 ? aPaintB : ( paintSlot > 0.5 ? aPaintA : vColor.rgb );\n\tvColor.rgb *= aFx.w;\n\tvDroneEm = aFx.rgb;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDroneEm;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vDroneEm;');
    };
    material.customProgramCacheKey = () => PROGRAM_KEY;
    // forceSinglePass: прозрачный DoubleSide three рисует в два прохода (задние, потом передние грани) и
    // дважды за вызов ставит material.needsUpdate — лишний вызов и перепроверка программы на каждый глаз
    // каждый кадр. Диск плоский — порядок граней не важен.
    const rotorMat = new THREE.MeshBasicMaterial({ map: tex.rotor, color: 0xb4b9bf, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
    const lightMat = new THREE.MeshBasicMaterial({ map: tex.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }); // fog: false — светящееся (сложение) туман сцены не перекрашивает, иначе вдали оно светилось бы цветом тумана (atmosphere-light.js)
    const fireMat = new THREE.MeshBasicMaterial({ map: tex.puff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
    const smokeMat = new THREE.MeshBasicMaterial({ map: tex.puff, transparent: true, depthWrite: false });
    smokeMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vDroneAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvDroneAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDroneAlpha;')
        .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n\tdiffuseColor.a *= vDroneAlpha;');
    };
    smokeMat.customProgramCacheKey = () => `${PROGRAM_KEY}-smoke`;
    const meshes = [];
    const kind = (geometry, mat, cap, name, { painted = false, color = false, alpha = false, order = 0 } = {}) => {
      if (painted) {
        geometry.setAttribute('aPaintA', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('aPaintB', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('aFx', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
      }
      if (alpha) geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
      const mesh = new THREE.InstancedMesh(geometry, mat, cap);
      mesh.name = name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (color) {
        mesh.setColorAt(0, col.set(0xffffff));
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      mesh.frustumCulled = false; // коптеры по всему небу; шейдер собирается сразу
      mesh.count = 0;
      mesh.renderOrder = order;
      root.add(mesh);
      meshes.push(mesh);
      const at = geometry.attributes;
      return { mesh, n: 0, cap, painted, color, alpha, m: mesh.instanceMatrix.array, a: at.aPaintA?.array, b: at.aPaintB?.array, f: at.aFx?.array, al: at.aAlpha?.array, c: mesh.instanceColor?.array };
    };
    const kinds = {
      light: kind(geo.light, material, MAX, 'drones-light', { painted: true }),
      heavy: kind(geo.heavy, material, MAX, 'drones-heavy', { painted: true }),
      gun: kind(geo.gun, material, MAX, 'drones-gun', { painted: true }),
      rotor: kind(geo.rotor, rotorMat, MAX * 4, 'drones-rotor', { order: 2 }),
      lights: kind(geo.puff, lightMat, MAX * 5, 'drones-lights', { color: true, order: 4 }),
      fire: kind(geo.puff.clone(), fireMat, FIRE_CAP, 'drones-fire', { color: true, order: 4 }),
      smoke: kind(geo.puff.clone(), smokeMat, SMOKE_CAP, 'drones-smoke', { color: true, alpha: true, order: 3 }),
    };
    geo.puff.dispose(); // клоны у огня и дыма; у огней — свой
    // тени по солнцу (sun-shadows.js): корпуса и пушки коптеров — отбрасыватели
    const sunShadows = globalThis.__sceneState?.sunShadows ?? null;
    const casters = [kinds.light.mesh, kinds.heavy.mesh];
    for (const mesh of casters) sunShadows?.addCaster(mesh, { cascades: 'far' }); // высоко: тени далеко
    return {
      meshes,
      kinds,
      list: Object.values(kinds),
      dispose() {
        for (const mesh of casters) sunShadows?.removeCaster(mesh);
        for (const mesh of meshes) {
          mesh.removeFromParent();
          mesh.geometry.dispose();
          mesh.dispose();
        }
        material.dispose();
        rotorMat.dispose();
        lightMat.dispose();
        fireMat.dispose();
        smokeMat.dispose();
        // текстуры — в кэше __sceneState (drone-model.js), не освобождаются
      },
    };
  };
  let warm = 0;
  const flush = (k) => {
    const mesh = k.mesh;
    mesh.count = k.n;
    mesh.visible = k.n > 0 || warm < 3; // первые кадры виден и пуст: шейдер собирается сразу
    if (!k.n) return;
    const im = mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, k.n * 16);
    im.needsUpdate = true;
    const g = mesh.geometry.attributes;
    if (k.painted) {
      for (const [name, size] of PAINT_ATTRS) {
        const attr = g[name];
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, k.n * size);
        attr.needsUpdate = true;
      }
    }
    if (k.alpha) {
      g.aAlpha.clearUpdateRanges();
      g.aAlpha.addUpdateRange(0, k.n);
      g.aAlpha.needsUpdate = true;
    }
    if (k.color) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, k.n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  };
  const PAINT_ATTRS = [['aPaintA', 3], ['aPaintB', 3], ['aFx', 4]];
  // экземпляр с краской: матрица M, команда и вспышка/обугленность коптера d
  const putPainted = (k, d) => {
    if (k.n >= k.cap) return;
    const i = k.n;
    k.m.set(M.elements, i * 16);
    const tp = teamPaint[d.team];
    const pa = tp[0];
    const pb = tp[1];
    const j = i * 3;
    const char = d.state === 'wreck' ? 0.22 : d.state === 'dying' ? 0.55 : 1;
    k.a[j] = pa.r * (d.state === 'alive' ? 1 : 0.4);
    k.a[j + 1] = pa.g * (d.state === 'alive' ? 1 : 0.4);
    k.a[j + 2] = pa.b * (d.state === 'alive' ? 1 : 0.4);
    k.b[j] = pb.r;
    k.b[j + 1] = pb.g;
    k.b[j + 2] = pb.b;
    const f = d.flash;
    const h = i * 4;
    k.f[h] = 1.6 * f;
    k.f[h + 1] = 0.75 * f;
    k.f[h + 2] = 0.35 * f;
    k.f[h + 3] = char;
    k.n += 1;
  };
  const putMatrix = (k) => {
    if (k.n >= k.cap) return;
    k.m.set(M.elements, k.n * 16);
    k.n += 1;
  };
  const putColor = (k, r, g, b, a = 1) => {
    if (k.n >= k.cap) return;
    const i = k.n;
    k.m.set(M.elements, i * 16);
    k.c[i * 3] = r;
    k.c[i * 3 + 1] = g;
    k.c[i * 3 + 2] = b;
    if (k.alpha) k.al[i] = a;
    k.n += 1;
  };

  // ---------------------------------------------------------------- огонь и дым (частицы-плашки)
  const mkPuffs = (cap) => ({
    n: 0, cap,
    x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap),
    vx: new Float32Array(cap), vy: new Float32Array(cap), vz: new Float32Array(cap),
    age: new Float32Array(cap), life: new Float32Array(cap), s0: new Float32Array(cap), s1: new Float32Array(cap),
    rot: new Float32Array(cap), spin: new Float32Array(cap), tone: new Float32Array(cap), a0: new Float32Array(cap),
  });
  const fire = mkPuffs(FIRE_CAP);
  const smoke = mkPuffs(SMOKE_CAP);
  const PUFF_KEYS = Object.keys(mkPuffs(1)).filter((k) => k !== 'n' && k !== 'cap');
  const addPuff = (p, x, y, z, vx, vy, vz, s0, s1, life, tone, a0 = 1) => {
    const i = p.n < p.cap ? p.n++ : Math.floor(Math.random() * p.cap); // полный — вытесняет случайную
    p.x[i] = x; p.y[i] = y; p.z[i] = z;
    p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
    p.age[i] = 0; p.life[i] = life; p.s0[i] = s0; p.s1[i] = s1;
    p.rot[i] = Math.random() * Math.PI * 2; p.spin[i] = rand(-0.8, 0.8); p.tone[i] = tone; p.a0[i] = a0;
  };
  const stepPuffs = (p, dt, buoy, drag) => {
    for (let i = p.n - 1; i >= 0; i -= 1) {
      p.age[i] += dt;
      if (p.age[i] >= p.life[i]) {
        p.n -= 1;
        for (let k = 0; k < PUFF_KEYS.length; k += 1) p[PUFF_KEYS[k]][i] = p[PUFF_KEYS[k]][p.n];
        continue;
      }
      const dr = 1 - drag * dt;
      p.vx[i] = p.vx[i] * dr - 0.35 * dt; // ветер к −X (как дым выстрелов, smoke.js)
      p.vy[i] = p.vy[i] * dr + buoy * dt;
      p.vz[i] *= dr;
      p.x[i] += p.vx[i] * dt;
      p.y[i] += p.vy[i] * dt;
      p.z[i] += p.vz[i] * dt;
      p.rot[i] += p.spin[i] * dt;
    }
  };
  // плашка частицы i лицом к камере: M
  const puffMatrix = (p, i, size) => {
    Qr.setFromAxisAngle(ZAXIS, p.rot[i]);
    Q.copy(camQ).multiply(Qr);
    M.compose(V.set(p.x[i], p.y[i], p.z[i]), Q, S3.set(size, size, size));
  };
  const drawPuffs = () => {
    const kf = built.kinds.fire;
    for (let i = 0; i < fire.n; i += 1) {
      const k = fire.age[i] / fire.life[i];
      puffMatrix(fire, i, fire.s0[i] + (fire.s1[i] - fire.s0[i]) * Math.sqrt(k));
      // жар: бело-жёлтый → оранжевый → тёмно-красный, гаснет (аддитивно — яркость = цвет)
      const fade = (1 - k) * (1 - k);
      const hot = fire.tone[i] * (1 - k);
      putColor(kf, (1.0 + 0.4 * hot) * fade, (0.45 + 0.45 * hot) * fade, (0.12 + 0.35 * hot * hot) * fade);
    }
    const ks = built.kinds.smoke;
    for (let i = 0; i < smoke.n; i += 1) {
      const k = smoke.age[i] / smoke.life[i];
      puffMatrix(smoke, i, smoke.s0[i] + (smoke.s1[i] - smoke.s0[i]) * Math.sqrt(k));
      const t = smoke.tone[i];
      // вначале быстро густеет, потом медленно тает
      const a = smoke.a0[i] * Math.min(1, k * 8) * (1 - k) * (1 - k * 0.5);
      putColor(ks, t, t * 0.98, t * 0.95, a);
    }
  };

  // ---------------------------------------------------------------- взрыв о землю
  const explode = (d) => {
    const s = d.span;
    const z = d.size;
    const gy = groundHeight(d.x, d.z);
    const y0 = gy + 0.15 * s + 0.1;
    // вспышка, огненные клубы, дым, искры
    addPuff(fire, d.x, y0 + 0.3 * s, d.z, 0, 1, 0, 0.6 * s + 0.6, 2.6 * s + 2, 0.22, 1);
    const nf = 5 + 3 * z;
    for (let k = 0; k < nf; k += 1) {
      V.set(rand(-1, 1), rand(0.2, 1.2), rand(-1, 1)).normalize().multiplyScalar(rand(1.5, 4.5) * Math.sqrt(s));
      addPuff(fire, d.x, y0, d.z, V.x, V.y, V.z, 0.3 * s + 0.3, (0.9 * s + 0.9) * rand(0.8, 1.2), rand(0.35, 0.75), rand(0.4, 1));
    }
    const ns = 3 + 2 * z;
    for (let k = 0; k < ns; k += 1) {
      addPuff(smoke, d.x + rand(-0.4, 0.4) * s, y0 + rand(0, 0.5) * s, d.z + rand(-0.4, 0.4) * s, rand(-1, 1) * Math.sqrt(s), rand(0.8, 2.2) * Math.sqrt(s), rand(-1, 1) * Math.sqrt(s), 0.5 * s + 0.6, (2.4 * s + 2.5) * rand(0.8, 1.2), rand(2.5, 4.5), rand(0.05, 0.13), 0.9);
    }
    normal.set(0, 1, 0);
    hitP.set(d.x, y0, d.z);
    fx.sparks(hitP, normal, 18 + 8 * z, { speed: [3, 9 + 2 * z], spread: 1.2, hot: true, size: 1 + 0.5 * z });
    fx.flash(hitP, 0.4 + 0.5 * s, true);
    sound.boom(hitP, z);
    // тряска, если рядом
    const dist = Math.hypot(d.x - head.x, gy - head.y, d.z - head.z);
    if (dist < 35) {
      try {
        V2.set(head.x - d.x, 0, head.z - d.z).normalize();
        shared.screenShake?.(Math.min(0.7, ((0.15 + 0.15 * z) * 8) / Math.max(6, dist)), V2);
      } catch {
        // тряска не важнее игры
      }
    }
    // крупные бьют псов рядом
    if (z >= 1) {
      const units = dogUnits();
      if (units) {
        const r = 1.2 * s + 1;
        for (let i = 0; i < units.length; i += 1) {
          const u = units[i];
          if (!dogAlive(u)) continue;
          const dd = Math.hypot(u.bodyCenter.x - d.x, u.bodyCenter.z - d.z);
          if (dd > r) continue;
          V2.set(u.bodyCenter.x - d.x, 0.5, u.bodyCenter.z - d.z).normalize();
          try {
            u.strike(u.bodyCenter, V2, 1 + z);
          } catch {
            // пёс не важнее взрыва
          }
        }
      }
    }
  };

  // ---------------------------------------------------------------- цели
  const dogUnits = () => {
    try {
      return horde?.debug?.units?.() ?? null; // псы стаи (robodog-horde.js), только чтение
    } catch {
      return null;
    }
  };
  const dogAlive = (u) => u && (u.mode === 'alive' || u.knocked) && !u.emerging;
  const targetAlive = (t) => (t === 'player' ? true : t?.isDrone ? t.state === 'alive' : dogAlive(t));
  // точка прицела цели t → out; false — не во что
  const targetPos = (t, out) => {
    if (!t) return false;
    if (t === 'player') {
      out.set(head.x, head.y - 0.25, head.z);
      return true;
    }
    if (t.isDrone) {
      if (t.state !== 'alive') return false;
      out.set(t.x, t.y, t.z);
      return true;
    }
    if (!dogAlive(t)) return false;
    out.copy(t.bodyCenter);
    return true;
  };
  // Приоритеты целей по размеру (по просьбе пользователя), и у свободных, и у сопровождения (у них — в
  // радиусе стаи). Ярус 0 — главнее; внутри яруса — ближайший:
  //   большой/огромный коптер: 0 крупные псы (≥ BIG_DOG) → 1 мелкие псы → 2 остальное (коптеры, игрок);
  //   маленький/средний: 0 крупные коптеры → 1 мелкие коптеры → 2 мелкие псы → 3 остальное (крупные псы, игрок).
  // Липкость: прежнюю цель держит, пока новая не выше ярусом или (в том же ярусе) не заметно ближе.
  const BIG_DOG = 2.5; // масштаб пса: «большой» и крупнее (бьют лапой)
  const BIG_DRONE = 2; // SIZES: «большой», «огромный»
  const tierOf = (big, t) => {
    if (t === 'player') return big ? 2 : 3;
    if (t.isDrone) return big ? 2 : t.size >= BIG_DRONE ? 0 : 1;
    const bigDog = t.scale >= BIG_DOG;
    if (big) return bigDog ? 0 : 1;
    return bigDog ? 3 : 2;
  };
  // выбор: consider(цель, взвешенное расстояние) — без выделений памяти
  let selBig = false;
  let selBest = null;
  let selD = Infinity;
  let selT = 9;
  const selStart = (d) => {
    selBig = d.size >= BIG_DRONE;
    selBest = null;
    selD = Infinity;
    selT = 9;
  };
  const consider = (t, dd) => {
    const tier = tierOf(selBig, t);
    if (tier < selT || (tier === selT && dd < selD)) {
      selBest = t;
      selD = dd;
      selT = tier;
    }
  };
  // прежняя цель (ещё в досягаемости, cd — её взвешенное расстояние) остаётся, если новая не выше ярусом
  // и не ближе на четверть в том же ярусе
  const keepCurrent = (cur, cd) => {
    if (cur === selBest) return;
    const ct = tierOf(selBig, cur);
    if (ct < selT || (ct === selT && selD > 0.75 * cd)) {
      selBest = cur;
      selD = cd;
      selT = ct;
    }
  };
  const pickTarget = (d, units) => {
    const ally = d.team === 'ally';
    let cur = d.target;
    if (cur && !targetAlive(cur)) cur = d.target = null;
    selStart(d);
    if (!ally) {
      const pd = Math.hypot(head.x - d.x, head.y - d.y, head.z - d.z) * 0.8; // игрок — чуть желаннее
      if (pd < SEARCH_M) consider('player', pd);
    }
    if (units && (ally || shared.allies !== false)) {
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (!dogAlive(u) || (u.dog.team === 'ally') === ally) continue;
        const c = u.bodyCenter;
        const dd = Math.hypot(c.x - d.x, c.y - d.y, c.z - d.z);
        if (dd < SEARCH_M) consider(u, dd);
      }
    }
    for (let i = 0; i < drones.length; i += 1) {
      const o = drones[i];
      if (o.state !== 'alive' || o.team === d.team) continue;
      const dd = Math.hypot(o.x - d.x, o.y - d.y, o.z - d.z) * 0.9; // по воздуху — чуть охотнее
      if (dd < SEARCH_M) consider(o, dd);
    }
    if (cur && targetPos(cur, P)) {
      const cd = Math.hypot(P.x - d.x, P.y - d.y, P.z - d.z) * (cur === 'player' ? 0.8 : cur.isDrone ? 0.9 : 1);
      if (cd < SEARCH_M) keepCurrent(cur, cd);
    }
    const best = selBest;
    if (best !== d.target) {
      d.target = best;
      // новая цель — подлетает с ближней стороны
      if (best && targetPos(best, P)) d.orbitA = Math.atan2(d.x - P.x, d.z - P.z);
    }
  };
  const bearingOf = (x, z) => Math.atan2(x - head.x, head.z - z); // 0 — «вперёд» мира от игрока

  // ---------------------------------------------------------------- сопровождение стаи (ESCORT_*)
  const squadMarks = (shared.squadMarks ??= {}); // номер стаи → цель её сопровождения (читают псы)
  // центр живых псов стаи d.squad (и скорость центра), бежит ли стая на игрока
  const escortScan = (d, units, dt) => {
    let n = 0;
    let sx = 0;
    let sz = 0;
    let onPlayer = false;
    if (units) {
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (!(u.mode === 'alive' || u.knocked) || u.dog?.squad !== d.squad) continue;
        n += 1;
        sx += u.dog.x;
        sz += u.dog.z;
        if (u.dog.target === 'player') onPlayer = true;
      }
    }
    if (n) {
      sx /= n;
      sz /= n;
      // скорость центра — для упреждения (сглажена: гибель пса сдвигает центр скачком)
      if (d.sqN && dt > 0.05) {
        const k = 0.5;
        d.sqVX += (clamp((sx - d.sqX) / dt, -12, 12) - d.sqVX) * k;
        d.sqVZ += (clamp((sz - d.sqZ) / dt, -12, 12) - d.sqVZ) * k;
      }
      d.sqX = sx;
      d.sqZ = sz;
      d.sqP = onPlayer;
      d.sqSince = 0;
    }
    d.sqN = n;
  };
  // ближайший противник у стаи (от её центра, не от коптера); пулемёт задирается не выше 0,35 рад —
  // коптеры высоко над ним не цель
  const escortTarget = (d, units) => {
    const ally = d.team === 'ally';
    const cx = d.sqX;
    const cz = d.sqZ;
    selStart(d); // ярусы по размеру (tierOf), расстояние — от центра стаи
    if (!ally) {
      const pd = Math.hypot(head.x - cx, head.z - cz) * (d.sqP ? 0.6 : 1); // стая бежит на игрока — он желаннее
      if (pd < ESCORT_SEEK) consider('player', pd);
    }
    if (units && (ally || shared.allies !== false)) {
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (!dogAlive(u) || (u.dog.team === 'ally') === ally) continue;
        const dd = Math.hypot(u.dog.x - cx, u.dog.z - cz);
        if (dd < ESCORT_SEEK) consider(u, dd);
      }
    }
    for (let i = 0; i < drones.length; i += 1) {
      const o = drones[i];
      if (o.state !== 'alive' || o.team === d.team) continue;
      const h = Math.hypot(o.x - d.x, o.z - d.z);
      if (o.y - d.y > 0.36 * h) continue;
      const dd = Math.hypot(o.x - cx, o.z - cz) * 0.9;
      if (dd < ESCORT_SEEK) consider(o, dd);
    }
    // липкость: прежняя цель, пока она у стаи (и для коптера — в досягаемости подвеса)
    const cur = d.target;
    if (cur && targetPos(cur, P) && !(cur.isDrone && P.y - d.y > 0.36 * Math.hypot(P.x - d.x, P.z - d.z))) {
      const cd = Math.hypot(P.x - cx, P.z - cz) * (cur === 'player' && d.sqP ? 0.6 : cur.isDrone ? 0.9 : 1);
      if (cd < ESCORT_SEEK * 1.2) keepCurrent(cur, cd);
    }
    const best = selBest;
    d.target = best;
    squadMarks[d.squad] = best;
  };
  // стая погибла — свободный коптер: высота и круг своего размера
  const freeEscort = (d) => {
    delete squadMarks[d.squad];
    d.squad = 0;
    const s = SIZES[d.size];
    d.alt = rand(s.alt[0], s.alt[1]);
    d.R = rand(s.R[0], s.R[1]);
    d.target = null;
    d.retarget = 0;
  };
  // цель полёта сопровождения → G; false — стаи нет (стал свободным)
  const G = new THREE.Vector3();
  const escortGoal = (d, dt, units) => {
    d.sqT -= dt;
    d.sqSince += dt;
    if (d.sqT <= 0 || (d.target && !targetAlive(d.target))) {
      const since = d.sqSince;
      d.sqT = ESCORT_EVERY * rand(0.85, 1.15);
      escortScan(d, units, since);
      if (!d.sqN) {
        // псы ещё вылезают из-под земли — подождать; дольше — стаи нет
        if (d.age > 4) {
          freeEscort(d);
          return false;
        }
        d.target = null;
      } else escortTarget(d, units);
    }
    // центр стаи с упреждением, круг на равных углах (сосед по стае — +2π/k)
    d.sqA += d.sqDir * ESCORT_SPIN * dt;
    let cx = d.sqX + d.sqVX * d.sqSince;
    let cz = d.sqZ + d.sqVZ * d.sqSince;
    if (d.target && targetPos(d.target, P)) {
      // к цели подаётся, но от стаи не дальше 6 м
      const dx = P.x - cx;
      const dz = P.z - cz;
      const dl = Math.hypot(dx, dz);
      if (dl > 1) {
        const k = Math.min(6, dl * 0.3) / dl;
        cx += dx * k;
        cz += dz * k;
      }
    }
    G.x = cx + Math.sin(d.sqA) * d.R;
    G.z = cz + Math.cos(d.sqA) * d.R;
    G.y = groundHeight(G.x, G.z) + d.alt * (1 + 0.1 * Math.sin(d.age * 0.37 + d.wob * 2));
    return true;
  };
  // сделать d сопровождением стаи ev ({ id, n, x, z }); a — угол на круге, dir — куда кружат
  const makeEscort = (d, ev, a, dir) => {
    d.squad = ev.id;
    d.sqX = ev.x;
    d.sqZ = ev.z;
    d.sqVX = d.sqVZ = 0;
    d.sqSince = 0;
    d.sqN = 0;
    d.sqT = 0.6; // псы вылезают
    d.sqP = false;
    d.sqA = a;
    d.sqDir = dir;
    d.alt = rand(ESCORT_ALT[0], ESCORT_ALT[1]);
    d.R = rand(ESCORT_R[0], ESCORT_R[1]) + Math.sqrt(ev.n);
    d.target = null;
    d.retarget = 0;
  };

  // ---------------------------------------------------------------- урон
  let clankAt = 0;
  let ownClankAt = 0; // звон от пули игрока — свой темп: чужие попадания (бой коптеров) его не съедают
  // own — убила/попала пуля игрока: звук своими голосами, мимо бюджета мира (audio-budget.js)
  const kill = (d, dir, own = false) => {
    d.state = 'dying';
    d.t = 0;
    d.shots = 0;
    d.target = null;
    if (d.squad) {
      delete squadMarks[d.squad]; // другой коптер стаи (если есть) отметит заново
      d.squad = 0;
    }
    d.spinRate = rand(4, 8) * (Math.random() < 0.5 ? -1 : 1) / Math.sqrt(Math.max(0.5, d.span));
    d.tumble = rand(-0.6, 0.6);
    d.vx += dir.x * 2;
    d.vy += 1 + Math.max(0, dir.y) * 2;
    d.vz += dir.z * 2;
    hitP.set(d.x, d.y, d.z);
    normal.copy(dir).negate();
    fx.sparks(hitP, normal, 14 + 6 * d.size, { speed: [2, 6], spread: 1.4, hot: true, size: 0.8 + 0.4 * d.size });
    fx.flash(hitP, 0.15 + 0.25 * d.span, true);
    addPuff(fire, d.x, d.y, d.z, 0, 0.5, 0, 0.25 * d.span + 0.1, 0.8 * d.span + 0.3, 0.25, 1);
    sound.pop(hitP, d.size, own);
    try {
      onKill?.(d);
    } catch {
      // счёт не важнее
    }
  };
  // попадание по коптеру d: урон dmg, точка point, направление dir
  const damage = (d, dmg, point, dir, own = false) => {
    if (d.state !== 'alive') return null;
    d.hp -= dmg;
    d.flash = 1;
    d.angry = true;
    normal.copy(dir).negate();
    fx.sparks(point, normal, 6 + 2 * d.size, { speed: [1.5, 4], hot: true, size: 0.6 + 0.3 * d.size });
    const now = performance.now();
    if (own ? now - ownClankAt > 30 : now - clankAt > 45) {
      if (own) ownClankAt = now;
      else clankAt = now;
      sound.clank(point, d.size, own);
    }
    // толчок
    d.vx += dir.x * (1.2 / d.span);
    d.vy += dir.y * (1.2 / d.span);
    d.vz += dir.z * (1.2 / d.span);
    if (d.hp <= 0) {
      kill(d, dir, own);
      return 'kill';
    }
    return 'hit';
  };
  shared.droneStrike = (d, point, dir, dmg = 1) => (d?.isDrone ? damage(d, dmg, point, dir) : null);

  // попадания в пути: { t — через сколько с, kind 0 игрок / 1 пёс / 2 коптер, ref, точка, направление, урон }
  const pending = [];
  for (let i = 0; i < PENDING; i += 1) pending.push({ t: 0, kind: 0, ref: null, px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 0, dmg: 0 });
  let pendingCount = 0;
  let shakeAt = 0;
  const queueHit = (t, kind, ref, point, dir, dmg) => {
    if (pendingCount >= PENDING) return;
    const h = pending[pendingCount++];
    h.t = t; h.kind = kind; h.ref = ref; h.dmg = dmg;
    h.px = point.x; h.py = point.y; h.pz = point.z;
    h.dx = dir.x; h.dy = dir.y; h.dz = dir.z;
  };
  const stepHits = (dt) => {
    for (let i = pendingCount - 1; i >= 0; i -= 1) {
      const h = pending[i];
      h.t -= dt;
      if (h.t > 0) continue;
      try {
        V.set(h.px, h.py, h.pz);
        V2.set(h.dx, h.dy, h.dz);
        if (h.kind === 0) {
          // по игроку: только тряска, и не чаще раза в SHAKE_GAP_MS (много коптеров — не дрожь без конца)
          const now = performance.now();
          if (now - shakeAt > SHAKE_GAP_MS) {
            shakeAt = now;
            V2.y = 0;
            V2.normalize();
            shared.screenShake?.(0.18, V2);
          }
        } else if (h.kind === 1) {
          const u = h.ref;
          if (dogAlive(u)) {
            u.strike(V, V2, h.dmg); // искры, звон и смерть пса — его же код (robodog-unit.js)
            if (u.dog.team !== 'ally' && !u.dog.angry) {
              u.dog.angry = true;
              u.setAngry?.(true);
            }
          }
        } else if (h.kind === 2) damage(h.ref, h.dmg, V, V2);
      } catch {
        // попадание не важнее игры
      }
      pendingCount -= 1;
      const last = pending[pendingCount];
      pending[pendingCount] = h;
      pending[i] = last;
      h.ref = null;
    }
  };

  // ---------------------------------------------------------------- стрельба
  const bodyMatrix = (d, out) => {
    const wob = d.state === 'alive' ? 0.035 * Math.sqrt(d.span) * Math.sin(d.age * 1.7 + d.wob) : 0;
    E.set(d.pitch, d.yaw, d.roll, 'YXZ');
    Q.setFromEuler(E);
    out.compose(V.set(d.x, d.y + wob, d.z), Q, S3.set(d.span, d.span, d.span));
    return out;
  };
  const BODY = new THREE.Matrix4();
  const gunMatrix = (d, out) => {
    const pv = GUN_PIVOT[SIZES[d.size].kind];
    V.set(pv[0], pv[1], pv[2]).applyMatrix4(BODY);
    E.set(d.gp, d.gy, 0, 'YXZ');
    Q.setFromEuler(E);
    out.compose(V, Q, S3.set(d.span, d.span, d.span));
    return out;
  };
  const GUN = new THREE.Matrix4();
  const fireRound = (d) => {
    const z = SIZES[d.size];
    if (!targetPos(d.target, P)) return;
    muzzle.set(GUN_MUZZLE[0], GUN_MUZZLE[1], GUN_MUZZLE[2]).applyMatrix4(GUN);
    shotDir.subVectors(P, muzzle);
    const range = shotDir.length() || 1;
    shotDir.divideScalar(range);
    shotDir.x += gauss() * z.spread;
    shotDir.y += gauss() * z.spread;
    shotDir.z += gauss() * z.spread;
    shotDir.normalize();
    const ally = d.team === 'ally';
    let len = range + 40;
    const t = d.target;
    if (t === 'player') {
      V.subVectors(P, muzzle);
      const along = V.dot(shotDir);
      const miss = Math.sqrt(Math.max(0, V.lengthSq() - along * along));
      if (along > 0 && miss < HIT_R_PLAYER) {
        len = along;
        queueHit(along / BULLET_SPEED, 0, null, P, shotDir, 0);
      }
    } else if (t.isDrone) {
      const tt = raySphere(muzzle, shotDir, t.x, t.y, t.z, t.hitR * 1.2, range + 10);
      if (tt >= 0) {
        len = tt;
        hitP.copy(muzzle).addScaledVector(shotDir, tt);
        queueHit(tt / BULLET_SPEED, 2, t, hitP, shotDir, z.dmg);
      }
    } else {
      const tt = t.cast(muzzle, shotDir, range + 10 * t.scale);
      if (tt >= 0) {
        len = tt;
        hitP.copy(muzzle).addScaledVector(shotDir, tt);
        queueHit(tt / BULLET_SPEED, 1, t, hitP, shotDir, z.dmg);
      }
    }
    fx.bolt(muzzle, shotDir, BULLET_SPEED, len, ally);
    fx.flash(muzzle, 0.03 + 0.05 * Math.sqrt(d.span), true);
  };
  // луч (единичный dir) против шара: расстояние до входа или −1
  const raySphere = (o, dir, cx, cy, cz, r, far) => {
    const ox = cx - o.x;
    const oy = cy - o.y;
    const oz = cz - o.z;
    const tca = ox * dir.x + oy * dir.y + oz * dir.z;
    if (tca < -r) return -1;
    const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
    if (d2 > r * r) return -1;
    const thc = Math.sqrt(r * r - d2);
    let t0 = tca - thc;
    if (t0 < 0) t0 = tca + thc;
    return t0 >= 0 && t0 <= far ? t0 : -1;
  };

  // ---------------------------------------------------------------- полёт
  const steer = (d, dt, units) => {
    const z = SIZES[d.size];
    let tx = 0;
    let ty = 0;
    let tz = 0;
    let has = false;
    let Rcur = d.R;
    let gx;
    let gy;
    let gz;
    const escort = d.squad > 0 && escortGoal(d, dt, units);
    if (escort) {
      // сопровождение: круг низко над своей стаей (escortGoal)
      has = targetPos(d.target, P);
      tx = P.x;
      tz = P.z;
      gx = G.x;
      gy = G.y;
      gz = G.z;
    } else {
      d.retarget -= dt;
      if (d.retarget <= 0 || (d.target && !targetAlive(d.target))) {
        d.retarget = RETARGET_S * rand(0.8, 1.2);
        pickTarget(d, units);
      }
      has = targetPos(d.target, P);
      if (has) {
        tx = P.x;
        ty = P.y;
        tz = P.z;
      } else {
        // союзнику некого бить — ждёт впереди игрока
        tx = head.x;
        tz = head.z - 22;
        ty = groundHeight(tx, tz);
      }
      Rcur = d.R * (1 + 0.18 * Math.sin(d.age * 0.23 + d.wob));
      const dh = Math.hypot(d.x - tx, d.z - tz);
      if (dh > Rcur * 1.6) d.orbitA = Math.atan2(d.x - tx, d.z - tz); // далеко — летит прямо к цели
      else d.orbitA += (d.orbitDir * z.speed * 0.5 * dt) / Math.max(Rcur, 4);
      if (d.target === 'player' && d.team === 'enemy') {
        // вокруг игрока — только в секторе спереди; у края разворачивается
        const off = wrap(d.orbitA - Math.PI);
        if (Math.abs(off) > FRONT_ORBIT) {
          d.orbitA = Math.PI + Math.sign(off) * FRONT_ORBIT;
          d.orbitDir = -Math.sign(off);
        }
      }
      if (Math.random() < dt * 0.06) d.orbitDir = -d.orbitDir; // иногда — в другую сторону
      gx = tx + Math.sin(d.orbitA) * Rcur;
      gz = tz + Math.cos(d.orbitA) * Rcur;
      gy = groundHeight(gx, gz) + d.alt * (1 + 0.12 * Math.sin(d.age * 0.37 + d.wob * 2));
      if (has) gy = Math.max(gy, ty + (d.size >= 2 ? 6 : 1.5)); // не ныряет под цель
    }
    // желаемая скорость: к точке, не быстрее speed (вверх-вниз — вдвое медленнее); сопровождение
    // добавляет скорость стаи — не отстаёт
    let vx = (gx - d.x) * 0.9 + (escort ? d.sqVX : 0);
    let vz = (gz - d.z) * 0.9 + (escort ? d.sqVZ : 0);
    let vy = (gy - d.y) * 0.9;
    const hs = Math.hypot(vx, vz);
    if (hs > z.speed) {
      vx *= z.speed / hs;
      vz *= z.speed / hs;
    }
    vy = clamp(vy, -0.5 * z.speed, 0.5 * z.speed);
    // не толкаться с другими коптерами
    for (let i = 0; i < drones.length; i += 1) {
      const o = drones[i];
      if (o === d || o.state !== 'alive') continue;
      const ax = d.x - o.x;
      const ay = d.y - o.y;
      const az = d.z - o.z;
      const room = (d.span + o.span) * 1.2 + 1;
      const a2 = ax * ax + ay * ay + az * az;
      if (a2 >= room * room || a2 < 1e-6) continue;
      const ad = Math.sqrt(a2);
      const push = ((room - ad) / room) * 6;
      vx += (ax / ad) * push;
      vy += (ay / ad) * push;
      vz += (az / ad) * push;
    }
    // и не влетать в игрока
    {
      const ax = d.x - head.x;
      const ay = d.y - head.y;
      const az = d.z - head.z;
      const room = 3 + d.span * 1.5;
      const a2 = ax * ax + ay * ay + az * az;
      if (a2 < room * room && a2 > 1e-6) {
        const ad = Math.sqrt(a2);
        const push = ((room - ad) / room) * 10;
        vx += (ax / ad) * push;
        vy += (ay / ad) * push;
        vz += (az / ad) * push;
      }
    }
    const floor = groundHeight(d.x, d.z) + 1 + d.span;
    if (d.y < floor) vy += (floor - d.y) * 3;
    // ускорение (ограничено) → скорость; оно же наклоняет корпус
    let ax = (vx - d.vx) * 2.2;
    let ay = (vy - d.vy) * 2.2;
    let az = (vz - d.vz) * 2.2;
    const a = Math.hypot(ax, ay, az);
    if (a > z.acc) {
      ax *= z.acc / a;
      ay *= z.acc / a;
      az *= z.acc / a;
    }
    d.vx += ax * dt;
    d.vy += ay * dt;
    d.vz += az * dt;
    d.ax = ax;
    d.az = az;
    // курс: к цели, если она близко, иначе — по полёту
    let face = d.yaw;
    if (has && Math.hypot(tx - d.x, tz - d.z) < 2.5 * Rcur) face = Math.atan2(-(tx - d.x), -(tz - d.z));
    else if (Math.hypot(d.vx, d.vz) > 1) face = Math.atan2(-d.vx, -d.vz);
    d.yaw = turnTo(d.yaw, face, z.turn * dt);
  };

  // в кадре: двигается, наклон, пулемёт, огонь
  const fly = (d, dt) => {
    const z = SIZES[d.size];
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;
    // наклон: по горизонтальной тяге (ускорение + сопротивление), в системе корпуса
    const k = Math.min(1, dt * 6);
    d.tx += ((d.ax + 0.25 * d.vx) / 9.81 - d.tx) * k;
    d.tz += ((d.az + 0.25 * d.vz) / 9.81 - d.tz) * k;
    const sy = Math.sin(d.yaw);
    const cy = Math.cos(d.yaw);
    const fwd = -sy * d.tx - cy * d.tz; // вперёд (−Z корпуса)
    const right = cy * d.tx - sy * d.tz; // вправо (+X корпуса)
    const wob = 0.025 / Math.sqrt(d.span);
    d.pitch = -clamp(Math.atan(fwd), -z.tilt, z.tilt) + wob * Math.sin(d.age * 2.3 + d.wob);
    d.roll = -clamp(Math.atan(right), -z.tilt, z.tilt) + wob * Math.sin(d.age * 1.9 + d.wob * 3);
    // пулемёт: стабилизированный подвес, наводится на цель
    let goalYaw = d.yaw;
    let goalPitch = -0.15;
    const has = targetPos(d.target, P);
    if (has) {
      const dx = P.x - d.x;
      const dy = P.y - d.y;
      const dz = P.z - d.z;
      goalYaw = Math.atan2(-dx, -dz);
      goalPitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -1.45, 0.35);
    }
    const step = z.gunTurn * dt;
    d.gy = turnTo(d.gy, goalYaw, step);
    d.gp += clamp(goalPitch - d.gp, -step, step);
    d.aimErr = Math.abs(wrap(goalYaw - d.gy)) + Math.abs(goalPitch - d.gp);
    // огонь: очередь идёт — по выстрелу через BURST_GAP; иначе — новая очередь, если можно
    d.cd -= dt;
    if (d.shots > 0) {
      d.gap -= dt;
      if (d.gap <= 0) {
        bodyMatrix(d, BODY);
        gunMatrix(d, GUN);
        fireRound(d);
        d.shots -= 1;
        d.gap += BURST_GAP;
      }
    } else if (has && d.cd <= 0 && d.aimErr < 0.08 && (d.angry || (run.angry && d.team === 'enemy'))) {
      const dist = Math.hypot(P.x - d.x, P.y - d.y, P.z - d.z);
      const front = d.target !== 'player' || Math.abs(bearingOf(d.x, d.z)) < FRONT_ANGLE;
      if (dist < z.range && front) {
        d.shots = z.rounds[0] + Math.floor(Math.random() * (z.rounds[1] - z.rounds[0] + 1));
        d.gap = 0;
        d.cd = rand(z.cd[0], z.cd[1]);
        bodyMatrix(d, BODY);
        gunMatrix(d, GUN);
        muzzle.set(GUN_MUZZLE[0], GUN_MUZZLE[1], GUN_MUZZLE[2]).applyMatrix4(GUN);
        sound.burst(muzzle, d.shots, d.size);
      }
    }
    // подбитый (меньше половины HP) дымит
    if (d.size >= 1 && d.hp < d.hpMax * 0.5) {
      d.smokeT -= dt;
      if (d.smokeT <= 0) {
        d.smokeT = 0.35;
        addPuff(smoke, d.x, d.y, d.z, d.vx * 0.2, 0.4, d.vz * 0.2, 0.15 * d.span + 0.1, 0.7 * d.span + 0.4, 1.4, 0.16, 0.45);
      }
    }
  };

  // падает: крутится, кувыркается, дымный след; о землю — взрыв
  const fall = (d, dt) => {
    d.t += dt;
    const dr = 1 - 0.35 * dt;
    d.vx *= dr;
    d.vz *= dr;
    d.vy = d.vy * dr - 9.81 * 0.8 * dt; // винты ещё чуть держат
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;
    d.yaw = wrap(d.yaw + d.spinRate * dt);
    d.roll = clamp(d.roll + d.tumble * dt, -1.1, 1.1);
    d.pitch = clamp(d.pitch + d.tumble * 0.5 * dt, -0.9, 0.9);
    d.flash = Math.max(d.flash, Math.random() < 0.08 ? 0.7 : 0); // искрит
    d.smokeT -= dt;
    if (d.smokeT <= 0) {
      d.smokeT = 0.075 + 0.01 * d.size; // реже и короче: на Quest дорого не число, а площадь прозрачного
      addPuff(smoke, d.x, d.y, d.z, rand(-0.3, 0.3), 0.3, rand(-0.3, 0.3), 0.35 * d.span + 0.15, 1.3 * d.span + 0.6, rand(1.2, 1.9), rand(0.04, 0.1), 0.75);
      if (d.size >= 1) addPuff(fire, d.x, d.y, d.z, 0, 0.2, 0, 0.25 * d.span + 0.1, 0.5 * d.span + 0.2, 0.3, 0.6);
      if (Math.random() < 0.3) {
        hitP.set(d.x, d.y, d.z);
        normal.set(rand(-1, 1), 0.5, rand(-1, 1)).normalize();
        fx.sparks(hitP, normal, 3 + d.size, { speed: [1, 3], hot: true, size: 0.6 + 0.3 * d.size });
      }
    }
    const gy = groundHeight(d.x, d.z);
    if (d.y <= gy + 0.12 * d.span || d.t > 12) {
      explode(d);
      d.state = 'wreck';
      d.t = 0;
      d.y = gy + 0.06 * d.span;
      d.pitch = rand(-0.35, 0.35);
      d.roll = rand(-0.35, 0.35);
      d.vx = d.vy = d.vz = 0;
      d.flash = 0;
      d.smokeT = 0.2;
    }
  };

  // ---------------------------------------------------------------- появление
  const counts = { enemy: 0, ally: 0 };
  const escorts = { enemy: 0, ally: 0 }; // живых сопровождений стай
  const sizeAlive = [[0, 0, 0, 0], [0, 0, 0, 0]];
  const recount = () => {
    counts.enemy = counts.ally = 0;
    escorts.enemy = escorts.ally = 0;
    for (let k = 0; k < 4; k += 1) sizeAlive[0][k] = sizeAlive[1][k] = 0;
    for (let i = 0; i < drones.length; i += 1) {
      const d = drones[i];
      if (d.state === 'off') continue;
      counts[d.team] += 1;
      if (d.state === 'alive') {
        sizeAlive[d.team === 'ally' ? 1 : 0][d.size] += 1;
        if (d.squad > 0) escorts[d.team] += 1;
      }
    }
  };
  // Прогрессия боя (progression.js, по просьбе пользователя): в начале боя коптеров нет, потом маленькие,
  // средние, большие, огромные. Нет shared.battleStartMs (стая не ведёт бой) — прогрессии нет, всё как
  // было. Раз в кадр (update → progStep): prog.on, prog.t — игровые секунды боя, prog.cap — живых на
  // сторону (TEAM_MAX × dronesAllowed), prog.escMax / prog.keep — то же для сопровождения.
  // Уже летающие коптеры остаются.
  const prog = { on: false, t: 0, allowed: 1, cap: TEAM_MAX, escMax: ESCORT_MAX, keep: ESCORT_KEEP };
  const progStep = () => {
    prog.on = shared.battleStartMs != null;
    if (!prog.on) {
      prog.allowed = 1;
      prog.cap = TEAM_MAX;
      prog.escMax = ESCORT_MAX;
      prog.keep = ESCORT_KEEP;
      return;
    }
    prog.t = battleSeconds(shared);
    prog.allowed = dronesAllowed(prog.t);
    prog.cap = Math.ceil(TEAM_MAX * prog.allowed);
    prog.escMax = Math.ceil(ESCORT_MAX * prog.allowed);
    prog.keep = Math.round(ESCORT_KEEP * prog.allowed);
  };
  const wBuf = [0, 0, 0, 0];
  // размер нового коптера; −1 — пока никакой (прогрессия). smallOnly — сопровождение (маленький/средний)
  const pickSize = (team, smallOnly = false) => {
    const ally = team === 'ally';
    const row = sizeAlive[ally ? 1 : 0];
    if (prog.on) {
      // своя копия: progression.js отдаёт свой массив стадии — его не портить
      const src = droneSizeWeights(prog.t);
      const w = wBuf;
      for (let i = 0; i < 4; i += 1) w[i] = smallOnly && i > 1 ? 0 : src[i] ?? 0;
      for (let tries = 0; tries < 4; tries += 1) {
        const k = pickWeighted(w);
        if (k < 0) return -1;
        if (row[k] < (SIZES[k].maxAlive ?? 99)) return k;
      }
      return w[0] > 0 ? 0 : -1;
    }
    // у обеих сторон одни веса и одни пределы крупных (maxAlive)
    for (let tries = 0; tries < 4; tries += 1) {
      let r = Math.random() * SIZE_WEIGHT;
      for (let k = 0; k < SIZES.length; k += 1) {
        r -= SIZES[k].weight;
        if (r > 0) continue;
        const cap = SIZES[k].maxAlive ?? 99;
        if (row[k] < cap) return k;
        break;
      }
    }
    return 0;
  };
  // свободный коптер; нет — самый давний обломок уходит сразу
  const freeDrone = () => {
    let oldest = null;
    for (let i = 0; i < drones.length; i += 1) {
      const d = drones[i];
      if (d.state === 'off') return d;
      if (d.state === 'wreck' && (!oldest || d.t > oldest.t)) oldest = d;
    }
    if (oldest) {
      oldest.state = 'off';
      return oldest;
    }
    return null;
  };
  const place = (d, team, size, x, y, z) => {
    const s = SIZES[size];
    d.state = 'alive';
    d.team = team;
    d.size = size;
    d.span = s.span * rand(0.92, 1.08);
    d.hpMax = d.hp = s.hp[0] + Math.floor(Math.random() * (s.hp[1] - s.hp[0] + 1));
    d.hitR = Math.max(0.14, 0.32 * d.span);
    d.x = x;
    d.y = y;
    d.z = z;
    // летит к игроку
    const dx = head.x - x;
    const dz = head.z - z;
    const dl = Math.hypot(dx, dz) || 1;
    d.vx = (dx / dl) * s.speed * 0.7;
    d.vz = (dz / dl) * s.speed * 0.7;
    d.vy = 0;
    d.ax = d.az = d.tx = d.tz = 0;
    d.yaw = d.gy = Math.atan2(-dx, -dz);
    d.pitch = d.roll = 0;
    d.gp = -0.2;
    d.alt = rand(s.alt[0], s.alt[1]);
    d.R = rand(s.R[0], s.R[1]);
    d.orbitDir = Math.random() < 0.5 ? -1 : 1;
    d.orbitA = Math.atan2(x - head.x, z - head.z);
    d.t = d.age = 0;
    d.target = null;
    d.retarget = Math.random() * 0.3;
    d.cd = rand(1, 2.5);
    d.shots = 0;
    d.flash = 0;
    d.angry = team === 'ally';
    d.spin = Math.random() * 6;
    d.wob = Math.random() * Math.PI * 2;
    d.lodAcc = 0;
    d.smokeT = 0;
    d.humJit = rand(-0.06, 0.06);
    d.blink = Math.random();
    d.squad = 0; // свободный (сопровождением делает makeEscort)
    d.hold = 0; // «Сцена 4»: столько с висит в строю (standoff)
  };
  // волна: count коптеров кучкой (враги — спереди, союзники — сзади)
  const spawnWave = (team, count) => {
    camera.getWorldPosition(head);
    recount();
    const cap = prog.cap; // TEAM_MAX, в начале боя меньше (прогрессия)
    const ally = team === 'ally';
    const a = (Math.random() * 2 - 1) * ((ally ? 40 : 35) * Math.PI) / 180;
    const dist = ally ? rand(35, 55) : rand(95, 130);
    const cx = head.x + Math.sin(a) * dist;
    const cz = ally ? head.z + Math.cos(a) * dist : head.z - Math.cos(a) * dist;
    // свободным — не больше cap за вычетом мест сопровождения (сколько есть, но не меньше prog.keep)
    const freeCap = cap - Math.max(escorts[team], prog.keep);
    let n = 0;
    for (let k = 0; k < count && counts[team] < cap && counts[team] - escorts[team] < freeCap; k += 1) {
      const size = pickSize(team);
      if (size < 0) break; // коптеров ещё нет
      const d = freeDrone();
      if (!d) break;
      const s = SIZES[size];
      const x = cx + rand(-8, 8);
      const z = cz + rand(-8, 8);
      place(d, team, size, x, groundHeight(x, z) + rand(s.alt[0], s.alt[1]) + 4, z);
      sizeAlive[ally ? 1 : 0][size] += 1;
      counts[team] += 1;
      n += 1;
    }
    return n;
  };
  // «Сцена 4» (robodog-horde.js ставит shared.standoff = { id, yaw, hold }, когда псы встали строем): коптеры
  // строем тем же фронтом — враги впереди (крупнее — дальше и выше), союзники позади; so.hold с висят
  // на месте (без цели, не стреляют), потом в бой. Сколько — как свободных мест на сторону в бою
  // (prog.cap − prog.keep: место сопровождению остаётся).
  const STANDOFF_DEPTH = { enemy: [62, 78, 96, 118], ally: [16, 24, 34, 46] };
  const STANDOFF_WIDTH = [30, 40, 50, 60]; // ± м вбок по размеру
  const standoff = (so) => {
    camera.getWorldPosition(head);
    recount();
    progStep();
    const fx = Math.sin(so.yaw);
    const fz = -Math.cos(so.yaw);
    const n = { enemy: 0, ally: 0 };
    for (const team of shared.allies === false ? ['enemy'] : ['enemy', 'ally']) {
      const ally = team === 'ally';
      const sign = ally ? -1 : 1;
      const want = Math.max(0, prog.cap - prog.keep - counts[team]);
      for (let k = 0; k < want; k += 1) {
        const size = pickSize(team);
        if (size < 0) break;
        const d = freeDrone();
        if (!d) break;
        const s = SIZES[size];
        const depth = (STANDOFF_DEPTH[team][size] + rand(-6, 6)) * sign;
        const lat = rand(-1, 1) * STANDOFF_WIDTH[size];
        const x = head.x + fx * depth - fz * lat;
        const z = head.z + fz * depth + fx * lat;
        place(d, team, size, x, groundHeight(x, z) + rand(s.alt[0], s.alt[1]), z);
        d.vx = d.vz = 0;
        d.yaw = d.gy = Math.atan2(fx * sign, fz * sign); // носом к другой армии
        d.hold = so.hold;
        d.angry = false;
        sizeAlive[ally ? 1 : 0][size] += 1;
        counts[team] += 1;
        n[team] += 1;
      }
    }
    // обычные волны — после схода
    run.nextEnemy = so.hold + WAVE_GAP * 0.5;
    run.nextAlly = so.hold + WAVE_GAP * 0.6;
    console.log(`[drones] строем: враги ${n.enemy}, союзники ${n.ally}`);
  };
  // новая стая ev ({ id, team, n, x, z } из robodog-horde.js): 1–3 сопровождения — новые (прилетают из-за
  // стаи, от игрока дальше) или, если сторона полна, ближайшие свободные маленькие/средние
  const addEscorts = (ev) => {
    const team = ev.team;
    if (team === 'ally' && shared.allies === false) return 0;
    recount();
    const want = ev.n <= 3 ? 1 : ev.n <= 6 ? 2 : 3;
    const dir = ev.id % 2 ? 1 : -1;
    const a0 = Math.random() * Math.PI * 2;
    const ally = team === 'ally';
    let made = 0;
    // прогрессия: до коптеров — без сопровождения; размеры — по весам боя (только маленький/средний)
    for (let k = 0; k < want && escorts[team] < prog.escMax; k += 1) {
      let size = pickSize(team, true);
      if (size < 0) break;
      if (size > 1) size = Math.random() < 0.55 ? 0 : 1; // без прогрессии веса общие
      let d = counts[team] < prog.cap ? freeDrone() : null;
      if (d) {
        // за стаей, от игрока дальше на 18–26 м, выше — снижается к стае
        const ox = ev.x - head.x;
        const oz = ev.z - head.z;
        const ol = Math.hypot(ox, oz) || 1;
        const back = rand(18, 26);
        const x = ev.x + (ox / ol) * back + rand(-5, 5);
        const z = ev.z + (oz / ol) * back + rand(-5, 5);
        place(d, team, size, x, groundHeight(x, z) + rand(10, 16), z);
        sizeAlive[ally ? 1 : 0][size] += 1;
        counts[team] += 1;
      } else {
        // сторона полна — к стае уходит ближайший свободный маленький/средний
        let bestD = 150;
        for (let i = 0; i < drones.length; i += 1) {
          const o = drones[i];
          if (o.state !== 'alive' || o.team !== team || o.squad > 0 || o.size > 1) continue;
          const dd = Math.hypot(o.x - ev.x, o.z - ev.z);
          if (dd < bestD) {
            bestD = dd;
            d = o;
          }
        }
        if (!d) break;
      }
      makeEscort(d, ev, a0 + (k * Math.PI * 2) / want, dir);
      escorts[team] += 1;
      made += 1;
    }
    return made;
  };

  // ---------------------------------------------------------------- пули игрока
  let rayDrone = null;
  function cast(origin, dir, far) {
    rayDrone = null;
    if (!active()) return -1;
    let best = -1;
    for (let i = 0; i < drones.length; i += 1) {
      const d = drones[i];
      if (d.state !== 'alive' && d.state !== 'dying') continue;
      const t = raySphere(origin, dir, d.x, d.y, d.z, d.hitR, best >= 0 ? best : far);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        rayDrone = d;
      }
    }
    return best;
  }
  function hit(origin, dir, distance) {
    const d = rayDrone;
    rayDrone = null;
    if (!d) return null;
    hitP.copy(origin).addScaledVector(dir, distance);
    run.angry = true;
    if (d.state !== 'alive' || d.team === 'ally') {
      // падающий или свой: искры и звон, без урона
      normal.copy(dir).negate();
      fx.sparks(hitP, normal, 5, { speed: [1, 3], hot: true, size: 0.6 + 0.3 * d.size });
      sound.clank(hitP, d.size, true); // пуля игрока — свой голос
      return null;
    }
    // пуля игрока (по просьбе): маленький — с 1 выстрела, средний — с 2, большой — с 4, огромный — с 6
    // (урон = доля HP, +ε против 6 × (20/6) < 20); АВП — тяжёлый урон (огромному 2 выстрела)
    const dmg = shared.shotKind === 'awp' ? Math.max(5 + Math.floor(d.hpMax / 4), d.hpMax / PLAYER_SHOTS[d.size] + 1e-6) : d.hpMax / (PLAYER_SHOTS[d.size] ?? 1) + 1e-6;
    const res = damage(d, dmg, hitP, dir, true); // пуля игрока: звон и хлопок — свои голоса, мимо бюджета мира
    if (res === 'kill') shared.killConfirm?.drone(d); // пуля игрока: «клац» + хитмаркер
    else if (res === 'hit') shared.killConfirm?.hitAt(hitP.x, hitP.y, hitP.z); // ранил: серый крестик + тик
    return true;
  }
  function shot() {
    if (run) run.angry = true; // любой выстрел игрока будит врагов
  }
  const AIM = new THREE.Vector3();
  function aimTargets(visit) {
    if (!active()) return;
    for (let i = 0; i < drones.length; i += 1) {
      const d = drones[i];
      if (d.state !== 'alive' || d.team === 'ally') continue;
      visit(AIM.set(d.x, d.y, d.z), d.vx, d.vy, d.vz, d); // d — ключ цели (самонаведение, shooting.js)
    }
  }

  // ---------------------------------------------------------------- жизненный цикл
  const active = () => enabled && shared.drones !== false && Boolean(run) && Boolean(built);
  const ensure = () => {
    if (built) return;
    built = build();
    fx = createZapFx({ THREE, root, anchors: [] });
    removeShootable = shooting?.addShootable?.({ cast, hit, shot, aimTargets }) ?? null;
  };
  const teardown = () => {
    removeShootable?.();
    removeShootable = null;
    built?.dispose();
    built = null;
    fx?.dispose();
    fx = null;
  };
  const newRun = () => {
    drones = [];
    for (let i = 0; i < MAX; i += 1) drones.push(newDrone(i));
    // dogWave — номер последней волны псов, которую уже видели (старая из прошлого забега не считается)
    run = shared.droneRun = { elapsed: 0, nextEnemy: FIRST_ENEMY, nextAlly: FIRST_ALLY, angry: false, drones, dogWave: shared.dogWave?.n, standoff: shared.standoff?.id };
  };
  const clearAll = () => {
    if (!drones) return;
    for (const d of drones) {
      d.state = 'off';
      d.target = null;
    }
    fire.n = smoke.n = 0;
    pendingCount = 0;
    fx?.clear();
  };
  shared.droneTargets = null;

  let frameNo = 0;
  let fxAcc = 0; // ×32/×64: время мира, накопленное за промежуточные подшаги кадра (искры, гул)
  let sum = 0;
  let worst = 0;
  let frames = 0;
  let since = performance.now();
  let wasOn = true;
  let freeze = false; // debug.showcase

  const draw = () => {
    const k = built.kinds;
    for (const kk of built.list) kk.n = 0;
    for (let i = 0; i < drones.length; i += 1) {
      const d = drones[i];
      if (d.state === 'off') continue;
      const z = SIZES[d.size];
      bodyMatrix(d, BODY);
      M.copy(BODY);
      putPainted(k[z.kind], d);
      if (d.state === 'wreck') continue;
      gunMatrix(d, GUN);
      M.copy(GUN);
      putPainted(k.gun, d);
      // винты: диск у каждого мотора, крутится (падающий — медленнее и сходит на нет)
      const motors = MOTORS[z.kind];
      const rr = ROTOR_R[z.kind];
      for (let m = 0; m < 4; m += 1) {
        const p = motors[m];
        Qr.setFromAxisAngle(YAXIS, d.spin * (m === 0 || m === 3 ? 1 : -1));
        L.compose(V.set(p[0], p[1] + 0.012, p[2]), Qr, S3.set(rr, 1, rr));
        M.multiplyMatrices(BODY, L);
        putMatrix(k.rotor);
      }
      // огни: размер не меньше «пары пикселей» издали (видно в небе)
      const dist = Math.hypot(d.x - head.x, d.y - head.y, d.z - head.z);
      const lights = LIGHTS[z.kind];
      const ph = (d.age + d.blink) % 1;
      const ph2 = (d.age * 0.7 + d.blink) % 1;
      const dying = d.state === 'dying';
      for (let m = 0; m < lights.length; m += 1) {
        const l = lights[m];
        const type = l[3];
        let c = null;
        let gain = 1;
        if (type === 0) c = navRed;
        else if (type === 1) c = navGreen;
        else if (type === 2) {
          if (ph > 0.12) continue; // маяк команды: вспышка раз в секунду
          c = beacon[d.team];
          gain = 1.6;
        } else if (ph2 > 0.06 && (ph2 < 0.14 || ph2 > 0.2)) continue; // строб: двойная вспышка
        else c = white;
        if (dying && Math.random() < 0.5) continue;
        V.set(l[0], l[1], l[2]).applyMatrix4(BODY);
        const size = Math.max((type >= 2 ? 0.09 : 0.06) * d.span, dist * (type >= 2 ? 0.0045 : 0.003));
        M.compose(V, camQ, S3.set(size, size, size));
        putColor(k.lights, c.r * gain, c.g * gain, c.b * gain);
      }
      // «глаз» сенсора спереди: враги — красный, союзники — бледно-зелёный
      if (!dying) {
        V.set(0, z.kind === 'light' ? -0.005 : -0.058, z.kind === 'light' ? -0.18 : -0.26).applyMatrix4(BODY);
        const size = Math.max(0.05 * d.span, dist * 0.0022);
        M.compose(V, camQ, S3.set(size, size, size));
        const ec = eyeCol[d.team];
        putColor(k.lights, ec.r * 0.8, ec.g * 0.8, ec.b * 0.8);
      }
    }
    drawPuffs();
    if (warm < 3) warm += 1;
    for (const kk of built.list) flush(kk);
  };

  return {
    // on — есть ли коптеры в сцене (функция «robodogHorde»); keep — подмена файла сцены (летают дальше)
    apply(on, { keep = false } = {}) {
      enabled = Boolean(on);
      if (!enabled) {
        teardown();
        clearAll();
        run = shared.droneRun = null;
        drones = null;
        shared.droneTargets = null;
        return;
      }
      ensure();
      fire.n = smoke.n = 0;
      pendingCount = 0;
      if (keep && run && drones?.length <= MAX) {
        while (drones.length < MAX) drones.push(newDrone(drones.length)); // MAX вырос — пул дорастает, летящие остаются
        // псы после подмены — новые объекты: цели-псы забыть
        for (const d of drones) if (d.target && d.target !== 'player' && !d.target.isDrone) d.target = null;
        for (const k in squadMarks) delete squadMarks[k]; // и метки стай (там тоже псы)
      } else newRun();
      shared.droneTargets = drones;
    },
    update(dt) {
      if (!enabled || !built || !run) return;
      if (shared.drones === false) {
        // выключены в меню: все улетают (исчезают); включили — волны заново
        if (wasOn) {
          clearAll();
          for (const kk of built.list) {
            kk.n = 0;
            flush(kk);
          }
          wasOn = false;
        }
        return;
      }
      if (!wasOn) {
        wasOn = true;
        run.nextEnemy = 3;
        run.nextAlly = 6;
      }
      const t0 = performance.now();
      // ×32/×64 (world-clock.js): подшаг до MAX_STEP_S; рисовка, искры и гул — раз в кадр (последний подшаг)
      const wc = shared.worldClock;
      const fast = Boolean(wc?.fast);
      const lazy = fast && !wc.last;
      dt = Math.min(dt, fast ? MAX_STEP_S : 0.05);
      camera.getWorldPosition(head);
      camera.getWorldQuaternion(camQ);
      if (head.lengthSq() === 0) return;
      if (freeze) {
        // проверка с ПК (debug.showcase): всё замерло, только рисуется
        draw();
        return;
      }
      run.elapsed += dt;
      progStep(); // прогрессия боя: сколько и каких коптеров уже можно
      const so = shared.standoff; // «Сцена 4»: псы встали строем — коптеры тоже
      if (so && so.id !== run.standoff) {
        run.standoff = so.id;
        standoff(so);
      }
      // волны
      // волны: у обеих сторон одинаковые (WAVE_N раз в gap); волна псов стороны — большая волна её
      // коптеров (SURGE_N) сразу, обычная откладывается на полный gap
      const gap = Math.max(WAVE_GAP_MIN, WAVE_GAP - run.elapsed * RAMP);
      const randN = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));
      const dw = shared.dogWave;
      if (dw && dw.n !== run.dogWave) {
        run.dogWave = dw.n;
        if (dw.team === 'enemy' || shared.allies !== false) {
          const n = spawnWave(dw.team, randN(SURGE_N));
          if (dw.team === 'ally') run.nextAlly = gap * rand(0.85, 1.15);
          else run.nextEnemy = gap * rand(0.85, 1.15);
          console.log(`[drones] волна с псами: ${dw.team === 'ally' ? 'союзники' : 'враги'} +${n} (живых: враги ${counts.enemy}, союзники ${counts.ally})`);
        }
      }
      // вровень (по просьбе пользователя): отстала от другой стороны — волна больше на разницу (до
      // +CATCH_UP) и следующая вдвое скорее, если отстала больше чем на 20 %
      const tick = (team, key) => {
        run[key] -= dt;
        if (run[key] > 0) return;
        const own = counts[team];
        const opp = counts[team === 'ally' ? 'enemy' : 'ally'];
        spawnWave(team, randN(WAVE_N) + clamp(opp - own, 0, CATCH_UP));
        run[key] = gap * rand(0.85, 1.15) * (own < opp * 0.8 ? 0.5 : 1);
      };
      tick('enemy', 'nextEnemy');
      if (shared.allies !== false) tick('ally', 'nextAlly');
      // новые стаи псов — их сопровождение
      const sq = shared.squadQueue;
      if (sq?.length) {
        for (let i = 0; i < sq.length; i += 1) addEscorts(sq[i]);
        sq.length = 0;
      }
      frameNo += 1;
      const units = dogUnits();
      const busy = counts.enemy + counts.ally > MAX - 4;
      for (let i = 0; i < drones.length; i += 1) {
        const d = drones[i];
        if (d.state === 'off') continue;
        d.age += dt;
        d.flash = Math.max(0, d.flash - dt * 5);
        if (d.state === 'alive') {
          // LOD: далёкие решают, куда лететь, реже (время копится), двигаются каждый кадр
          const dd = (d.x - head.x) ** 2 + (d.z - head.z) ** 2;
          const every = dd > LOD_FAR * LOD_FAR ? 4 : dd > LOD_NEAR * LOD_NEAR ? 2 : 1;
          d.lodAcc += dt;
          if (d.hold > 0) {
            // «Сцена 4»: висит в строю, без цели; время вышло — в бой
            d.hold -= dt;
            d.vx = d.vy = d.vz = d.ax = d.az = 0;
            d.target = null;
            d.lodAcc = 0;
            if (d.hold <= 0) d.angry = true;
          } else if (every === 1 || (frameNo + i) % every === 0) {
            steer(d, Math.min(0.15, d.lodAcc), units);
            d.lodAcc = 0;
          }
          fly(d, dt);
          d.spin = (d.spin + (20 + 10 / Math.sqrt(d.span)) * dt) % (Math.PI * 2);
        } else if (d.state === 'dying') {
          fall(d, dt);
          d.spin += Math.max(0, 15 - d.t * 8) * dt;
        } else if (d.state === 'wreck') {
          d.t += dt;
          if (d.t < 2.5) {
            d.smokeT -= dt;
            if (d.smokeT <= 0) {
              d.smokeT = 0.4;
              addPuff(smoke, d.x, d.y + 0.1 * d.span, d.z, 0, 0.6, 0, 0.3 * d.span + 0.2, 1.4 * d.span + 1, 2.4, 0.07, 0.5); // тлеет
            }
          }
          const keep = busy ? WRECK_BUSY_S : WRECK_S;
          if (d.t > keep) {
            d.y -= ((0.25 * d.span + 0.1) / SINK_S) * dt; // уходит в землю
            if (d.t > keep + SINK_S) d.state = 'off';
          }
        }
      }
      if (pendingCount) stepHits(dt);
      stepPuffs(fire, dt, 1.2, 2.2);
      stepPuffs(smoke, dt, 0.5, 0.6);
      fxAcc += dt;
      if (!lazy) {
        draw();
        fx.update(fxAcc);
        sound.update(head, drones, fxAcc);
        fxAcc = 0;
      }
      if ((frameNo & 15) === 0) recount();

      const spent = performance.now() - t0;
      sum += spent;
      worst = Math.max(worst, spent);
      frames += 1;
      if (t0 - since >= LOG_EVERY_MS) {
        recount();
        console.log(`[drones] cpu=${(sum / frames).toFixed(3)}/${worst.toFixed(2)}ms enemy=${counts.enemy}(esc ${escorts.enemy}) ally=${counts.ally}(esc ${escorts.ally}) fire=${fire.n} smoke=${smoke.n} fx=${fx.active} t=${run.elapsed.toFixed(0)}s${prog.on ? ` battle=${prog.t.toFixed(0)}s cap=${prog.cap}` : ''}`);
        sum = worst = frames = 0;
        since = t0;
      }
    },
    debug: {
      // с ПК (не в шлеме!): __sceneState.droneSystem.debug.spawn('enemy', 3) — волна сейчас
      spawn: (team = 'enemy', n = 3) => (active() ? spawnWave(team, n) : 0),
      list: () => drones?.filter((d) => d.state !== 'off').map((d) => ({ id: d.id, team: d.team, size: SIZES[d.size].name, state: d.state, hp: d.hp, x: +d.x.toFixed(1), y: +d.y.toFixed(1), z: +d.z.toFixed(1), target: d.target === 'player' ? 'player' : d.target?.isDrone ? `drone${d.target.id}` : d.target ? 'dog' : null, angry: d.angry, squad: d.squad || 0, ...(d.squad ? { packN: d.sqN, packX: +d.sqX.toFixed(1), packZ: +d.sqZ.toFixed(1), aboveGround: +(d.y - groundHeight(d.x, d.z)).toFixed(1), fromPack: +Math.hypot(d.x - d.sqX, d.z - d.sqZ).toFixed(1) } : {}) })),
      info: () => run && { elapsed: +run.elapsed.toFixed(1), angry: run.angry, nextEnemy: +run.nextEnemy.toFixed(1), counts: (recount(), { ...counts }), escorts: { ...escorts }, prog: { ...prog, t: +prog.t.toFixed(1), allowed: +prog.allowed.toFixed(2) }, marks: Object.keys(squadMarks).length, fire: fire.n, smoke: smoke.n, pending: pendingCount },
      kill: (id) => {
        const d = drones?.[id];
        if (d?.state === 'alive') kill(d, V2.set(0, 0, -1));
        return Boolean(d);
      },
      sound: () => sound.stats(),
      // с ПК, только на странице без шлема: все размеры рядком перед камерой и замереть (false — дальше)
      showcase: (on = true, team = 'enemy') => {
        freeze = Boolean(on);
        if (!freeze || !active()) return freeze;
        clearAll();
        camera.getWorldPosition(head);
        camera.getWorldDirection(V2);
        V2.y = 0;
        V2.normalize();
        const xs = [-1.3, -0.5, 1.2, 5.5]; // вправо от взгляда
        const zs = [2.2, 2.8, 4.5, 11]; // вперёд
        const ys = [0.5, 0.7, 1.2, 2.5];
        for (let k = 0; k < 4; k += 1) {
          const d = drones[k];
          place(d, team, k, head.x + V2.x * zs[k] - V2.z * xs[k], head.y + ys[k], head.z + V2.z * zs[k] + V2.x * xs[k]);
          d.yaw = Math.atan2(-V2.x, -V2.z) + Math.PI + 0.6; // боком-мордой к камере
          d.gy = 0.2;
          d.gp = -0.3;
          d.vx = d.vz = 0;
        }
        return freeze;
      },
    },
    dispose() {
      teardown();
      if (shared.droneTargets === drones) shared.droneTargets = null;
      // run и коптеры остаются в shared.droneRun — новая версия сцены подхватит (apply keep)
    },
  };
}
