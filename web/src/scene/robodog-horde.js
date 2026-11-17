// Стая робопсов (функция сцены «robodogHorde», «Сцена 3»): псы появляются далеко впереди игрока
// (25–40 м, в пределах ±40° от того, куда он смотрит в момент появления), бегут к нему и с ~2,5 м
// прыгают на грудь. Достал — игрока «ударило» (onPlayerHit: красная вспышка по краям обзора тут,
// вибрация в main.js, глухой удар), пёс отлетает назад, приземляется и снова бежит.
// Псы четырёх размеров (SIZES: маленький … огромный), у каждого своя окраска и скорость.
// Пёс умирает от size.hp попаданий (смерть и кукла — robodog-unit.js), труп через CORPSE_S секунд
// уходит в землю, и модель снова свободна. Сначала новый пёс раз в SPAWN_FIRST с, потом всё чаще
// (до SPAWN_MIN); живых одновременно не больше MAX_ALIVE.
//
// Дёшево: POOL готовых моделей (11 вызовов отрисовки на пса: корпус, глаза, 8 частей ног, тень) +
// один общий меш искр и дуг; модели переиспользуются, без создания на лету.
import { createDogSfx, createDogUnit } from './robodog-unit.js';
import { createDog, yawTo } from './robodog-ai.js';
import { createZapFx } from './robodog-fx.js';
import { createDogInstances } from './robodog-instances.js';
import { createHorn } from './robodog-horn.js';
import { makeDogTextures, makeShadowTexture } from './robodog-model.js';
import { ensureWeaponEnv } from './weapon-env.js';
import { BODY_Y } from './robodog-gait.js';
import { groundHeight } from './car.js';

// моделей всего (живые + трупы): ≤ POOL × 11 + 1 вызовов отрисовки. Сначала POOL_START, остальные
// строятся по одной, когда не хватает (сборка модели — несколько мс, не всё сразу при подмене сцены)
// Ограничений нет (по просьбе пользователя): предел — только POOL моделей. Новые строятся по одной за
// кадр, заранее, пока свободных меньше двух (без рывка в момент появления стаи).
// (на Quest 10 моделей — 6 живых и 4 трупа-куклы — роняли до ~64 к/с при 90 Гц)
// Псы рисуются экземплярами (robodog-instances.js: 9 вызовов отрисовки на всех), модель пса — только
// скелет; пул большой, растёт по нескольку скелетов за кадр.
const POOL = 80; // (волны сопоставимы с другой стороной — нужно место на обе)
const POOL_START = 8;
const MAX_ALIVE = 99; // в «местах» (маленький = 1; большие и великаны занимают больше — SIZES.slots)
// стаи: волна — PACK псов кучкой (2–4 м от центра, с зазором по размеру), потом пауза
const PACK = [3, 8]; // большая битва: стаи крупнее (было 2–5)
const PACK_SPREAD = [2, 5];
// Размеры псов (по просьбе пользователя): маленький — прежний пёс. scale — масштаб модели (всё
// остальное в robodog-unit.js подстраивается само), weight — доля при появлении, hp — попаданий до
// смерти, knock — первое попадание сбивает с ног (большие только пошатываются), slots — мест из
// MAX_ALIVE, run — множитель скорости бега, giant — великан (живых таких не больше одного, топает с
// пылью), paw — не прыгает, а встаёт перед игроком и бьёт передней лапой (pawStep).
const SIZES = [
  { name: 'маленький', scale: 1, weight: 45, hp: 2, knock: true, slots: 1, run: 1 },
  { name: 'средний', scale: 1.6, weight: 28, hp: 3, knock: true, slots: 1, run: 1.08 },
  { name: 'большой', scale: 2.5, weight: 15, hp: 5, knock: false, slots: 2, run: 1.2, paw: true },
  { name: 'огромный', scale: 4, weight: 6, hp: 8, knock: false, slots: 2, run: 1.35, paw: true },
  { name: 'гигантский', scale: 7, weight: 4, hp: 15, knock: false, slots: 3, run: 1.5, giant: true, paw: true },
  { name: 'колоссальный', scale: 12, weight: 2, hp: 30, knock: false, slots: 4, run: 1.7, giant: true, paw: true },
  // титан — в 3 раза больше колоссального; сам не появляется (weight 0), только по просьбе через hordeDebug
  { name: 'титанический', scale: 36, weight: 0, hp: 90, knock: false, slots: 12, run: 2.2, giant: true, paw: true },
];
const SIZE_WEIGHT = SIZES.reduce((s, z) => s + z.weight, 0);
const sizeOf = (dog) => SIZES.find((z) => z.scale === dog.scale) ?? SIZES[0];
const RUN_MUL = [0.75, 1.35]; // у каждого пса ещё и своя скорость бега
const PAINTS = 6; // окрасок (DOG_PAINTS в robodog-model.js)
const CORPSE_S = 8; // труп лежит
const CORPSE_BUSY_S = 3; // столько, когда псов много (больше BUSY_USED моделей занято)
const BUSY_USED = 24;
const RAGDOLL_MAX = 4; // считаются не больше стольких кукол-трупов, остальные ложатся сразу
const LOD_NEAR = 25; // дальше — поза раз в 2 кадра (между ними только переезжает)
const LOD_FAR = 60; // дальше — всё раз в 4 кадра
const SINK_S = 1.5; // и уходит в землю
const SPAWN_FIRST = 4; // с до первой стаи
const PACK_GAP = 8; // с между стаями в начале
const PACK_GAP_MIN = 4; // и через пару минут
const RAMP = 0.02; // на столько секунд пауза короче за каждую секунду игры
// дальше, чтобы успеть пострелять (по просьбе пользователя): маленькие 45–65 м, крупнее — дальше
// (× (1 + 0,25·(размер − 1)): огромный 79–114 м, колоссальный 169–244 м)
const SPAWN_NEAR = 45;
const SPAWN_FAR = 65;
const SPAWN_GROW = 0.25;
// Спокойные псы идут шагом (CALM_SPEED от бега), почти не петляют, не уворачиваются, пулемёт молчит;
// первый выстрел игрока (любой пули — shootable.shot) или попадание — ярость: короткая стойка
// «тревога» (дёрнулся, злой электрический лай, глаза красные), потом бег во всю прыть.
const CALM_SPEED = 0.35;
const ALERT_S = 0.55;
// пулемётчики в ярости держатся на расстоянии и бегают вбок (STRAFE_NEAR..STRAFE_FAR м, ±STRAFE_EDGE)
const STRAFE_FAR = 35;
const STRAFE_NEAR = 12;
const STRAFE_EDGE = (60 * Math.PI) / 180;
// ± от направления «вперёд» мира (−Z, куда смотрит игрок после «Отцентрировать»), а не от взгляда:
// сектор 25° всего (по просьбе пользователя)
const SPAWN_ANGLE = (30 * Math.PI) / 180; // большая битва: фронт шире (было ±12,5°)
// нападать можно только спереди: пёс в пределах ±FRONT_ANGLE от «вперёд» мира (от игрока); сзади и
// сбоку — обегает по кругу вперёд
const FRONT_ANGLE = (70 * Math.PI) / 180;
const LEAP_RANGE = 2.5;
const LEAP_T = 0.42; // с полёта до игрока
const CHEST_BELOW_HEAD = 0.35;
const CONTACT_R = 0.55; // центр корпуса ближе этого к линии голова–грудь — удар
const PERSONAL_M = 0.9; // по земле ближе к игроку не подходит
const GRAVITY = 9.81;
const LOG_EVERY_MS = 10000;
// Союзники (меню «Собаки ▸ Союзники», shared.allies, по умолчанию вкл): стаи позади игрока (±25° от
// «назад» мира, 15–30 м), вылезают из-под земли и бегут вперёд, к врагам. Цель каждого пса — ближайший
// противник (для врагов — и игрок), с «липкостью»: пересмотр раз в RETARGET_S с, смена — если новый
// заметно ближе. Ближний бой — бросок/лапа по другому псу (урон по размеру), пулемёты бьют по псам.
// Пули игрока своих не ранят (искры, пошатнулся, обиженный писк).
const ALLY_PAINT = 6;
const ALLY_ANGLE = (40 * Math.PI) / 180; // широкой дугой позади
const ALLY_NEAR = 15;
const ALLY_FAR = 30;
// стороны наравне (по просьбе пользователя): у каждой не больше половины POOL моделей (живые и трупы)
const TEAM_POOL = POOL / 2;
const ALLY_FIRST = 3; // с до первой союзной стаи
const RETARGET_S = 0.6;
// волны (surgeStep): большая волна стороны раз в SURGE_EVERY с, SURGE_SIZE псов стаями по SURGE_PACK
// через SURGE_GAP с; между волнами — стаи TRICKLE_PACK раз в TRICKLE_GAP с
const SURGE_EVERY = [25, 40];
// размер волны — от живых у другой стороны (не меньше SURGE_SIZE[0]), у обеих сторон одинаково
// (по просьбе пользователя — наравне): ×0,9–1,2
const WAVE_REL = [0.9, 1.2];
const COUNTER_NEAR = 25; // враги ближе к игроку — ответная волна союзников
const COUNTER_DELAY = [12, 18]; // или через столько секунд после начала волны врагов
const WAVE_MAX_S = 30; // волна кончается не позже этого (время сцены)
const AFTER_ALLY_WAVE = [5, 10]; // с от конца волны союзников до волны врагов (не позже их таймера)
const NO_ENEMY_S = 8; // врагов нет дольше — волна врагов сразу
const SURGE_SIZE = [10, 20];
const SURGE_PACK = 6;
const SURGE_GAP = 1.6;
const FIRST_SURGE = 15;
const TRICKLE_PACK = [2, 4];
const TRICKLE_GAP = [9, 13];
// подкрепления вровень (matchStep): цель — живые у другой стороны × MATCH, пол растёт от MATCH_FLOOR[0]
// на MATCH_RAMP в секунду до MATCH_FLOOR[1]; отстала больше MATCH_TOL — стаи чаще (MATCH_FAST с)
const MATCH = [0.95, 1.1];
const MATCH_FLOOR = [6, 30];
const MATCH_RAMP = 0.1;
const MATCH_TOL = 0.2;
const MATCH_FAST = [2, 3.5];
// перевес (momentumStep): множитель здоровья стороны от отношения живых, степень и пределы
const MOMENTUM_K = 0.7;
const HP_MUL = [0.4, 1.6];
const RALLY_M = 18; // без врагов союзники ждут тут впереди игрока
// пулемёт на спине (каждый TURRET_EVERY-й пёс): целится в голову, очередь из 3 раз в секунду, если
// игрок ближе TURRET_RANGE и пёс спереди; перед очередью — замах TURRET_WIND с (наводка, вжик, огонёк).
// Пули — трассеры robodog-fx (bolt); попадание не ранит, только трясёт обзор (shared.screenShake).
// Разброс: σ ≈ 0,0106 рад — на 20 м примерно половина пуль проходит в 0,25 м от точки прицела.
const TURRET_EVERY = 5;
const TURRET_RANGE = 40;
const TURRET_WIND = 0.35;
const TURRET_GAP = 0.09; // с между пулями очереди
const TURRET_SPREAD = 0.0106;
const TURRET_HIT_R = 0.25;
const TURRET_SPEED = 160; // м/с — видно, как летит
const TURRET_TURN = 2.5; // рад/с наводки
// Характер и приёмы («чтобы реально внушали», по просьбе пользователя). Роль пса dog.kind:
// 'rusher' — в лоб, ближе CHARGE_NEAR срывается в рывок (×CHARGE_MUL, галоп с фазой полёта) с рёвом,
//   издалека бросается наскоком (POUNCE: присел, глаза добела, рык — длинный прыжок на грудь);
// 'flanker' — заходит сбоку фронта (±FLANK_ANGLE, стороны по очереди — клещи), вблизи — в лоб;
// 'stalker' — ближе STALK_R крадётся по кругу пригнувшись, корпус довёрнут к цели, рычит, потом с
//   рёвом срывается в рывок (и тоже наскок).
// Ещё: спокойные крадутся (prowl), уворот маленьких — прыжком вбок, через трупы перепрыгивают,
// резкое торможение — юзом с пылью, большие (paw) бьют сериями: мах, двойной мах (левой-правой),
// на дыбы с рёвом и удар обеими лапами (REAR_*); тревога большого — встал на дыбы и ревёт.
// Игрок на вышке: мелкие кружат у подножия и прыгают на её ноги (CLIMB_*), срываются.
// Глаза: тусклее вдали, ярче у цели, добела перед атакой (unit.glow).
const KINDS = [['rusher', 0.4], ['flanker', 0.35], ['stalker', 0.25]];
const CHARGE_MUL = 1.3;
const CHARGE_S = [1.6, 2.6];
const CHARGE_NEAR = 24;
const STALK_R = 13; // м × √размер
const STALK_S = [2.2, 4];
const POUNCE = [4.2, 7]; // × размер: с такого расстояния наскок
const POUNCE_CROUCH = 0.42;
const POUNCE_T = 0.62; // с полёта (× √размер)
const POUNCE_CD = [4, 7];
const FLANK_ANGLE = 0.85; // рад (≈49°) от «вперёд» мира
const ALERT_REAR_S = 1.5; // тревога большого: на дыбах
const CLIMB_H = [1.2, 2.2]; // × размер, м: прыжок на ногу вышки
const CLIMB_GAP = [2.5, 6];
const TOWER_LEG_R = 2.3; // м от центра вышки: тут ноги — отскакивает

const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const pickKind = () => {
  let r = Math.random();
  for (const [name, w] of KINDS) if ((r -= w) <= 0) return name;
  return KINDS[0][0];
};

export function createHorde({ THREE, root, camera, renderer = null, shooting, onPlayerHit, onKill }) {
  const shared = (globalThis.__sceneState ??= {});
  if (shared.allies === undefined) {
    try {
      shared.allies = localStorage.getItem('scene.allies') !== 'off'; // «Собаки ▸ Союзники» (main.js)
    } catch {
      shared.allies = true;
    }
  }
  const sfx = createDogSfx(shared);
  const shadowTexture = makeShadowTexture(THREE);
  let units = null;
  let fx = null;
  let textures = null;
  let inst = null; // все псы экземплярами (robodog-instances.js)
  let removeShootable = null;
  let enabled = false;
  // { elapsed, nextSpawn, dogs: [{ dog, health }] } — живые псы переживают подмену файла сцены
  let run = shared.hordeRun ?? null;

  const head = new THREE.Vector3();
  const look = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const contact = new THREE.Vector3();

  // ---- красная вспышка по краям обзора (квадрат у камеры, как HUD)
  const vignetteCanvas = document.createElement('canvas');
  vignetteCanvas.width = vignetteCanvas.height = 128;
  {
    const g = vignetteCanvas.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 18, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,0,0,0)');
    grad.addColorStop(0.45, 'rgba(230,10,10,0.25)');
    grad.addColorStop(1, 'rgba(200,0,0,0.9)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const vignetteTexture = new THREE.CanvasTexture(vignetteCanvas);
  vignetteTexture.colorSpace = THREE.SRGBColorSpace;
  const vignette = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: vignetteTexture, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  vignette.name = 'horde-vignette';
  vignette.position.set(0, 0, -0.26);
  vignette.renderOrder = 1002;
  vignette.frustumCulled = false;
  vignette.visible = false;
  camera.add(vignette);
  let hurt = 0;

  const refreshHead = () => {
    camera.getWorldPosition(head);
    camera.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) look.set(0, 0, -1);
    look.normalize();
  };

  // ---- цель для пуль: ближайший пёс на луче
  let rayUnit = null;
  function cast(origin, dir, far) {
    rayUnit = null;
    if (!enabled || !units) return -1;
    let best = -1;
    for (let i = 0; i < units.length; i += 1) {
      const t = units[i].cast(origin, dir, best >= 0 ? best : far);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        rayUnit = units[i];
      }
    }
    return best;
  }
  // автонаводка (shooting.js searchLock): живые и сбитые враги — центр корпуса и скорость (союзники — нет)
  function aimTargets(visit) {
    if (!enabled || !units) return;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if (u.dog.team === 'ally' || (u.mode !== 'alive' && !u.knocked)) continue;
      const d = u.dog;
      const v = u.mode === 'alive' ? d.v ?? 0 : 0;
      visit(u.bodyCenter, -Math.sin(d.yaw) * v, d.jump ? u.jumpVy : 0, -Math.cos(d.yaw) * v, d); // d — ключ цели (самонаведение)
    }
  }
  function hit(origin, dir, distance) {
    const unit = rayUnit;
    rayUnit = null;
    if (!unit) return null;
    if (unit.dog.team === 'ally' && (unit.mode === 'alive' || unit.knocked)) {
      // свой: не ранит — искры, пошатнулся, обиженно пискнул
      v1.copy(origin).addScaledVector(dir, distance);
      fx.sparks(v1, v2.copy(dir).negate(), 6, { speed: [1, 3] });
      if (unit.mode === 'alive') unit.stagger(dir);
      sfx.bark(v1, 0.55);
      return null;
    }
    // первое попадание сбивает маленького и среднего с ног (кукла ~1 с, потом вскакивает); большие
    // и следующие попадания — пошатнулся и притормозил; последнее по hp — насмерть
    const size = sizeOf(unit.dog);
    const first = unit.mode === 'alive' && unit.health >= size.hp;
    // AWP по большим бьёт сильнее: огромному 2, гигантскому 2, колоссальному 4 попадания за выстрел
    const damage = shared.shotKind === 'awp' ? 5 * (1 + Math.floor(size.hp / 8)) : 1; // АВП ×5 (по просьбе пользователя)
    const emerging = unit.emerging; // вылезает из-под земли: попадания считаются, но без отброса
    // перевес: врагов меньше, чем союзников — урон по ним больше (momentumStep)
    let result = unit.hit(origin, dir, distance, { knockdown: size.knock && first && !emerging, damage: damage * damageMul(unit) });
    if (result === 'corpse') return null;
    // попадание в ногу: перебивает её (большим — со второго раза, АВП — сразу); вторая — насмерть
    if ((result === 'hit' || result === 'knock') && unit.hitPart >= 1 && legHit(unit, unit.hitPart, shared.shotKind === 'awp', dir) === 'kill') result = 'kill';
    if (!unit.dog.angry) enrage(unit, 0); // раненый — всегда в ярости
    if (result === 'hit' && unit.mode === 'alive' && !emerging) {
      unit.stagger(dir);
      const dog = unit.dog;
      if (!dog.jump) {
        dog.state = 'stun';
        dog.t = 0.1; // тормозит на 0,25 с
      }
    }
    if (result === 'kill') {
      try {
        onKill?.();
      } catch {
        // счёт не важнее выстрела
      }
    }
    return true;
  }

  // ---- ноги: part — часть из cast (1–4 бёдра, 5–8 голени). Нога перебита после need попаданий
  // (большим и крупнее — 2, АВП — 1); перебита вторая нога — пёс мёртв. Хромает: медленнее, бьёт реже.
  const legHit = (unit, part, strong, dir) => {
    const dog = unit.dog;
    const leg = part <= 4 ? part - 1 : part - 5;
    const bit = 1 << leg;
    if ((dog.broken | 0) & bit) return null;
    dog.legHits ??= [0, 0, 0, 0];
    dog.legHits[leg] += 1;
    if (dog.legHits[leg] < (strong ? 1 : unit.scale >= 2.5 ? 2 : 1)) return 'hit';
    if (dog.broken) {
      dog.broken |= bit;
      unit.kill(dir, 0.6);
      return 'kill';
    }
    unit.breakLeg(leg);
    if (dog.paw && dog.paw.leg === leg) dog.paw.leg = leg ^ 1;
    return 'broken';
  };

  // ---- ярость: выстрел игрока будит всех спокойных живых псов (каждого с небольшой задержкой)
  let rageQueued = false;
  const shot = () => {
    rageQueued = true; // любая пуля игрока в полёте; разбор — в update, раз за кадр
  };
  const enrage = (unit, delay) => {
    const dog = unit.dog;
    dog.angry = true;
    unit.setAngry?.(true);
    if (unit.mode !== 'alive' || dog.jump) return;
    dog.state = 'alert';
    dog.t = -delay;
    dog.alerted = false;
  };
  const rageStep = () => {
    rageQueued = false;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if ((u.mode === 'alive' || u.knocked) && !u.dog.angry && u.dog.team !== 'ally') enrage(u, Math.random() * 0.3);
    }
  };

  let makeUnit = null;
  // великан топает: облачко пыли у стопы (effects.dust через shooting.puff — десяток частиц)
  const footfall = (point) => {
    try {
      shooting?.puff?.(point);
    } catch {
      // пыль не важнее игры
    }
  };
  const ensurePool = () => {
    if (units) return;
    const anchors = [];
    fx = createZapFx({ THREE, root, anchors });
    textures = makeDogTextures(THREE);
    const env = renderer ? ensureWeaponEnv(THREE, renderer) : null; // крашеный металл бликует, как оружие
    units = [];
    inst = createDogInstances({ THREE, root, textures, env, shadowTexture, capacity: POOL });
    makeUnit = () => {
      const unit = createDogUnit({ THREE, root, fx, anchors, shadowTexture, sfx, camera, textures, env, shared, rig: true });
      unit.onFootfall = footfall;
      units.push(unit);
      return unit;
    };
    for (let i = 0; i < POOL_START; i += 1) makeUnit();
    removeShootable = shooting?.addShootable?.({ cast, hit, shot, aimTargets }) ?? null;
    prewarm();
  };
  // Шейдеры и текстуры псов — заранее: модели в пуле скрыты, и без этого первый пёс в бою собирал
  // 2–3 программы прямо в кадре (на Quest без KHR_parallel_shader_compile — десятки мс, «фриз»).
  // compile() только начинает сборку; ожидание связывания и загрузка текстур — по одной за кадр в
  // update (как у подмены сцены, scene-host.js), до первого пса (SPAWN_FIRST) успевает.
  let warmQueue = [];
  const prewarm = () => {
    if (!renderer?.compile || !inst) return;
    let scene = root;
    while (scene.parent) scene = scene.parent;
    const known = new Set(renderer.info.programs);
    try {
      for (const mesh of inst.meshes) renderer.compile(mesh, camera, scene);
    } catch (error) {
      console.warn('[horde] prewarm:', error?.message ?? error);
      return;
    }
    warmQueue = renderer.info.programs.filter((p) => !known.has(p));
    for (const t of [textures?.map, textures?.orm, shadowTexture]) if (t) warmQueue.push(t);
  };
  const warmStep = () => {
    const item = warmQueue.shift();
    try {
      if (item.isTexture) renderer.initTexture(item);
      else if (item.program) {
        item.getUniforms();
        item.getAttributes();
      }
    } catch {
      // соберётся при первой отрисовке, как раньше
    }
  };
  const teardown = () => {
    removeShootable?.();
    removeShootable = null;
    warmQueue = [];
    for (const unit of units ?? []) unit.dispose();
    units = null;
    makeUnit = null;
    fx?.dispose();
    fx = null;
    inst?.dispose();
    inst = null;
    textures?.dispose();
    textures = null;
  };
  const newRun = () => {
    run = shared.hordeRun = { elapsed: 0, nextSpawn: SPAWN_FIRST, dogs: [], pending: true };
  };

  // живых — в местах (огромный занимает два)
  const aliveCount = () => {
    let n = 0;
    for (let i = 0; i < units.length; i += 1) if (units[i].mode === 'alive' || units[i].knocked) n += sizeOf(units[i].dog).slots;
    return n;
  };
  const pickSize = (free) => {
    let r = Math.random() * SIZE_WEIGHT;
    for (const z of SIZES) {
      r -= z.weight;
      if (r <= 0) return z.slots <= free ? z : SIZES[0];
    }
    return SIZES[0];
  };
  // свободная модель; нет — самый старый труп уходит в землю прямо сейчас
  const freeUnit = () => {
    let oldest = null;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if (u.mode === 'off') return u;
      if (u.mode === 'dead' && (!oldest || u.deadFor > oldest.deadFor)) oldest = u;
    }
    if (oldest && oldest.deadFor < CORPSE_S) oldest.deadFor = CORPSE_S;
    return null;
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  // роль и приёмы (KINDS); флангеры заходят по очереди слева и справа. Зовётся и для псов, переживших
  // подмену файла из версии без ролей (steer)
  const initTraits = (dog, size) => {
    run.sides = (run.sides ?? 0) + 1;
    dog.kind = size.giant && Math.random() < 0.6 ? 'rusher' : pickKind();
    dog.side = run.sides % 2 ? 1 : -1;
    dog.prowl = dog.rear = dog.rearReach = dog.brake = dog.look = 0;
    dog.charge = 0;
    dog.charged = false;
    dog.stalk = 0;
    dog.pounceCd = rand(1, 3);
    dog.hopCd = 0;
    dog.skidT = 0;
    dog.climb = null;
    dog.climbCd = rand(1, 4);
  };
  // поставить пса размера size в (x, z) мордой к игроку; delay — с до старта (стая не в ногу)
  const placeDog = (unit, size, x, z, speedMul, delay = 0, team = 'enemy') => {
    const dog = createDog();
    dog.scale = size.scale;
    dog.team = team;
    dog.wave = curWave; // из какой волны (0 — не из волны)
    dog.squad = curSquad; // стая (spawnPack): к ней drones.js цепляет коптеры-сопровождение; 0 — без стаи
    // союзники — своя зелёно-белая окраска (DOG_PAINTS[6]) и зелёные глаза, всегда «в бою»
    dog.paint = team === 'ally' ? ALLY_PAINT : Math.floor(Math.random() * PAINTS);
    dog.angry = team === 'ally';
    dog.target = null;
    dog.retarget = 0;
    // характер: гибкость корпуса и зигзаг [размах, рад; частота, рад/с; фаза] — у каждого свои
    dog.style = rand(0.7, 1.4);
    dog.weave = [rand(0.08, 0.22) / Math.sqrt(size.scale), rand(0.5, 1.1) / Math.sqrt(size.scale), rand(0, Math.PI * 2)];
    dog.age = 0;
    dog.vs = 0;
    dog.dodgeT = 0;
    dog.dodgeSide = 1;
    // каждый пятый — с пулемётом на спине
    run.spawned = (run.spawned ?? 0) + 1;
    initTraits(dog, size);
    dog.turret = run.spawned % TURRET_EVERY === 0;
    dog.gun = null;
    dog.x = x;
    dog.z = z;
    dog.yaw = yawTo(head.x - x, head.z - z);
    dog.state = delay > 0 ? 'recover' : 'run';
    dog.t = 0.8 - delay; // 'recover' кончается при t > 0.8
    dog.speed = Math.min(5, 3.3 + Math.random() * 0.9 + run.elapsed * 0.004) * size.run * speedMul;
    unit.spawn(dog, { health: size.hp, emerge: true }); // вылезает из-под земли
  };
  // центр стаи: от игрока по «вперёд» мира (−Z) в секторе ±SPAWN_ANGLE, куда бы он ни смотрел;
  // большие — дальше (огромный 36–58 м, колоссальный 66–106 м), чтобы не возникали под носом
  const packCentre = (scale, out) => {
    const a = (Math.random() * 2 - 1) * SPAWN_ANGLE;
    const dist = rand(SPAWN_NEAR, SPAWN_FAR) * (1 + SPAWN_GROW * (scale - 1));
    out.x = head.x + Math.sin(a) * dist;
    out.z = head.z - Math.cos(a) * dist;
    return out;
  };
  const centre = { x: 0, z: 0 };
  // ручка для npm run vr:eval: __sceneState.hordeDebug.spawn('огромный', 10, 60) — count псов размера
  // name линией поперёк «вперёд» мира на расстоянии dist м; возвращает, сколько поставлено
  shared.hordeDebug = {
    // убрать всех псов (живых и трупы) — освободить модели
    clear() {
      if (!units) return 0;
      let n = 0;
      for (const u of units) if (u.mode !== 'off') { u.hide(); n += 1; }
      return n;
    },
    spawn(name = 'огромный', count = 10, dist = 60) {
      if (!run || !units) return 0;
      refreshHead();
      const size = SIZES.find((z) => z.name === name) ?? SIZES[3];
      let n = 0;
      for (let k = 0; k < count; k += 1) {
        const unit = freeUnit();
        if (!unit) break;
        const a = (Math.random() * 2 - 1) * 0.35; // моделей может не хватить сразу — зовут несколько раз
        placeDog(unit, size, head.x + Math.sin(a) * dist, head.z - Math.cos(a) * dist, 1, k * 0.15);
        n += 1;
      }
      return n;
    },
  };
  const placed = []; // [x, z, scale] уже поставленных в этой стае (только при появлении стаи)
  // Стаи и коптеры-сопровождение (drones.js): у каждой стаи свой номер dog.squad (счётчик в
  // shared.squadSeq — не сбрасывается); о новой стае — событие в shared.squadQueue ({ id, team, n, x, z },
  // drones.js забирает и шлёт 1–3 коптера); shared.squadMarks[id] — цель, которую видит сопровождение
  // стаи (пёс другой команды): псы стаи её предпочитают (pickTarget)
  let curSquad = 0;
  // Волна: PACK псов кучкой — размеры по весам (пока есть места), вокруг центра на 2–4 м (×√размер),
  // не внахлёст; скорость общая для стаи ±8 %, старт вразнобой до 0,7 с.
  // wantOverride — сколько псов (волна); иначе по PACK. Возвращает, сколько поставлено.
  const spawnPack = (team = 'enemy', wantOverride = 0) => {
    refreshHead();
    let free = MAX_ALIVE - aliveCount();
    let want = wantOverride || PACK[0] + Math.floor(Math.random() * (PACK[1] - PACK[0] + 1));
    // у каждой стороны — не больше половины поля (иначе волне другой стороны негде появиться)
    free = Math.min(free, TEAM_POOL - teamInUse(team));
    if (free <= 0) return 0;
    const sizes = [];
    for (let k = 0; k < want && free > 0; k += 1) {
      const size = pickSize(free);
      if (size.slots > free) break;
      sizes.push(size);
      free -= size.slots;
    }
    if (!sizes.length) return false;
    sizes.sort((p, q) => q.scale - p.scale); // крупные в центр
    if (team === 'ally') {
      // союзники — позади игрока (± ALLY_ANGLE от «назад» мира), 15–30 м
      const a = (Math.random() * 2 - 1) * ALLY_ANGLE;
      const dist = rand(ALLY_NEAR, ALLY_FAR) * (1 + 0.1 * (sizes[0].scale - 1));
      centre.x = head.x + Math.sin(a) * dist;
      centre.z = head.z + Math.cos(a) * dist;
    } else packCentre(sizes[0].scale, centre);
    const packMul = rand(RUN_MUL[0], RUN_MUL[1]);
    placed.length = 0;
    shared.squadSeq = (shared.squadSeq ?? 0) + 1;
    curSquad = shared.squadSeq;
    let n = 0;
    for (const size of sizes) {
      const unit = freeUnit();
      if (!unit) break;
      let x = centre.x;
      let z = centre.z;
      for (let tries = 0; tries < 8 && n > 0; tries += 1) {
        const ang = Math.random() * Math.PI * 2;
        const r = rand(PACK_SPREAD[0], PACK_SPREAD[1]) * Math.sqrt(size.scale) + (tries > 3 ? tries : 0);
        x = centre.x + Math.cos(ang) * r;
        z = centre.z + Math.sin(ang) * r;
        let ok = true;
        for (const [px, pz, ps] of placed) if (Math.hypot(x - px, z - pz) < 0.75 * (ps + size.scale)) ok = false;
        if (ok) break;
      }
      placed.push([x, z, size.scale]);
      placeDog(unit, size, x, z, packMul * rand(0.92, 1.08), n === 0 ? 0 : rand(0, 0.7), team);
      n += 1;
    }
    if (n > 0) {
      const q = (shared.squadQueue ??= []);
      if (q.length >= 8) q.shift(); // коптеров нет (выключены) — очередь не растёт
      q.push({ id: curSquad, team, n, x: centre.x, z: centre.z });
    }
    curSquad = 0;
    return n;
  };
  const teamInUse = (team) => {
    let n = 0;
    for (let i = 0; i < units.length; i += 1) if (units[i].mode !== 'off' && (units[i].dog.team ?? 'enemy') === team) n += 1;
    return n;
  };
  // проверка с ПК: один пёс размера size прямо по «вперёд» мира
  const spawnOne = (size) => {
    const unit = freeUnit();
    if (!unit) return false;
    refreshHead();
    packCentre(size.scale, centre);
    placeDog(unit, size, centre.x, centre.z, rand(RUN_MUL[0], RUN_MUL[1]));
    return true;
  };

  // удар по игроку (бросок, лапа, пулемёт): красная вспышка, глухой удар, вибрация, тряска экрана.
  // (dx, dz) — от пса к игроку; strength — сила тряски; sound — размер для звука (0 — без звука)
  const shakeDir = new THREE.Vector3();
  const playerHit = (point, dx, dz, strength, sound = 1, flash = 1) => {
    if (sound) sfx.thud(point, sound);
    hurt = Math.max(hurt, flash);
    try {
      onPlayerHit?.(point);
    } catch {
      // вибрация не важнее игры
    }
    try {
      shakeDir.set(dx, 0, dz).normalize();
      shared.screenShake?.(Math.min(1, strength), shakeDir);
    } catch {
      // тряска не важнее игры
    }
  };

  // ---- удар лапой (большие псы, SIZES.paw): встал перед игроком, поднял переднюю лапу (замах), быстро
  // махнул вниз и вбок через то место, где игрок, опустил; снова через 1,5–2 с, пока игрок рядом и
  // спереди. Поза — цель стопы в системе «стоп» модели (robodog-gait.js, cmd.paw).
  const PAW_REACH = 0.85; // ×размер: с такого расстояния (до центра корпуса) замахивается
  const PAW_STAND = 0.62; // ×размер: тут останавливается
  const pawStep = (unit, dog, s, dt, dist, inFront, faceDiff) => {
    const p = (dog.paw ??= { phase: 0, t: 0, leg: 0, hit: false, cd: 0.6, pose: { leg: 0, x: 0, y: 0, z: 0, k: 0 } });
    p.cd -= dt;
    if (p.phase === 0) {
      dog.pawPose = null;
      if (dog.state === 'run' && inFront && dist < PAW_REACH * s && faceDiff < 0.45 && p.cd <= 0) {
        p.phase = 1;
        p.t = 0;
        p.leg = Math.random() < 0.5 ? 0 : 1;
        if ((dog.broken | 0) & (1 << p.leg)) p.leg ^= 1; // перебитой лапой не бьёт
        p.hit = false;
        // приём: на дыбы и обеими лапами (первым делом и потом через раз; хромой не встаёт), двойной
        // мах левой-правой или одиночный
        const r = Math.random();
        p.kind = !dog.broken && (!p.used || r < 0.3) ? 'rear' : !dog.broken && r < 0.65 ? 'combo' : 'swipe';
        p.used = true;
        p.chain = p.kind === 'combo' ? 1 : 0;
        p.quick = false;
        if (p.kind === 'rear') {
          sfx.howl(unit.bodyCenter, s);
          unit.kick(-6, 0);
        }
      }
      return;
    }
    p.t += dt;
    const side = p.leg === 0 ? -1 : 1;
    const ahead = Math.min(0.85, dist / s); // где игрок впереди, в единицах модели
    // медленно и читаемо (по просьбе пользователя): замах ~1–1,2 с, удар ~0,35–0,55 с, опускает ~1 с;
    // второй мах серии (quick) — вдвое быстрее; на дыбы — встаёт ~1 с, удар ~0,3 с
    const lame = dog.broken ? 1.4 : 1; // хромой бьёт медленнее
    const fast = p.quick ? 0.45 : 1;
    const tw = (0.9 + 0.025 * s) * lame * fast; // замах
    const ts = (0.3 + 0.02 * s) * lame; // удар
    const tr = (0.8 + 0.03 * s) * lame * (p.chain > 0 ? 0.35 : 1); // опустить (перед вторым махом — быстро)
    if (p.kind === 'rear') {
      rearStep(unit, dog, p, s, tw * 1.1, ts * 0.9, tr);
      dog.pawPose = null;
      return;
    }
    const pose = p.pose;
    pose.leg = p.leg;
    const wx = side * 0.26;
    const wy = BODY_Y + 0.14;
    const wz = -0.4;
    const ex = -side * 0.1;
    const ey = 0.04;
    const ez = -ahead;
    if (p.phase === 1) {
      const k = Math.min(1, p.t / tw);
      pose.k = k * k * (3 - 2 * k);
      pose.x = wx;
      pose.y = wy;
      pose.z = wz;
      if (p.t >= tw) {
        p.phase = 2;
        p.t = 0;
        sfx.whoosh(unit.bodyCenter, s);
      }
    } else if (p.phase === 2) {
      const u = Math.min(1, p.t / ts);
      const e = u * u;
      pose.k = 1;
      pose.x = wx + (ex - wx) * e;
      pose.y = wy + (ey - wy) * e;
      pose.z = wz + (ez - wz) * e;
      if (!p.hit && u >= 0.45 && !tp.rally && (!tp.player || Math.abs(bearingOf(dog)) < FRONT_ANGLE + 0.25)) {
        // попал, если стопа прошла рядом с целью (по горизонтали) и не выше её «головы»
        unit.foot(p.leg, v1);
        // вышка (tower.js, shared.playerElevation — высота площадки): до игрока наверху лапа достаёт, только если s·1,25 ≥ высоты (гигантский, колоссальный)
        if (Math.hypot(v1.x - tp.x, v1.z - tp.z) < 0.3 + 0.2 * s + tp.r && v1.y < tp.y + 0.25 && !(tp.player && (globalThis.__sceneState?.playerElevation ?? 0) > s * 1.25)) {
          p.hit = true;
          if (tp.player) {
            v2.set(head.x, head.y - 0.4, head.z);
            playerHit(v2, head.x - dog.x, head.z - dog.z, 0.6 + 0.08 * s, s);
          } else if (tp.unit) targetHit(unit, tp.unit, v1, tp.x - dog.x, tp.z - dog.z, 1.5);
        }
      }
      if (u >= 1) {
        p.phase = 3;
        p.t = 0;
        if (!p.hit) sfx.groundThud(unit.foot(p.leg, v1), 0.8, s); // мимо — лапа в землю
      }
    } else {
      const k = Math.min(1, p.t / tr);
      pose.k = 1 - k * k * (3 - 2 * k);
      if (k >= 1) {
        if (p.chain > 0) {
          // серия: сразу второй мах другой лапой
          p.chain -= 1;
          if (!((dog.broken | 0) & (1 << (p.leg ^ 1)))) p.leg ^= 1;
          p.phase = 1;
          p.t = 0;
          p.hit = false;
          p.quick = true;
        } else {
          p.phase = 0;
          p.cd = rand(0.5, 0.9); // пауза до следующего замаха
        }
      }
    }
    dog.pawPose = p.phase ? pose : null;
  };
  // На дыбы и удар обеими лапами (большие): встаёт (передние молотят воздух, глаза добела, рёв —
  // в pawStep), обрушивается лапами вперёд-вниз; попал — если середина передних стоп рядом с целью.
  // Мимо — земля дрожит: пыль, глухой удар, игрока рядом или на вышке над ним слегка трясёт (не ранит).
  const rearStep = (unit, dog, p, s, tw, ts, tr) => {
    if (p.phase === 1) {
      dog.rear = smooth01(p.t / (tw * 0.5));
      if (p.t >= tw) {
        p.phase = 2;
        p.t = 0;
        sfx.whoosh(unit.bodyCenter, s);
      }
    } else if (p.phase === 2) {
      const u = Math.min(1, p.t / ts);
      dog.rear = 1 - u * u;
      dog.rearReach = smooth01(u * 1.6);
      if (!p.hit && u >= 0.7 && !tp.rally && (!tp.player || Math.abs(bearingOf(dog)) < FRONT_ANGLE + 0.25)) {
        unit.foot(0, v1);
        unit.foot(1, v2);
        v1.lerp(v2, 0.5);
        if (Math.hypot(v1.x - tp.x, v1.z - tp.z) < 0.45 + 0.25 * s + tp.r && v1.y < tp.y + 0.25 && !(tp.player && (shared.playerElevation ?? 0) > s * 1.25)) {
          p.hit = true;
          if (tp.player) {
            v2.set(head.x, head.y - 0.4, head.z);
            playerHit(v2, head.x - dog.x, head.z - dog.z, 0.85 + 0.1 * s, s, 1.2);
          } else if (tp.unit) targetHit(unit, tp.unit, v1, tp.x - dog.x, tp.z - dog.z, 2.5);
        }
      }
      if (u >= 1) {
        p.phase = 3;
        p.t = 0;
        unit.foot(0, v1);
        unit.foot(1, v2);
        footfall(v1);
        footfall(v2);
        v1.lerp(v2, 0.5);
        sfx.groundThud(v1, 1, s);
        // земля дрожит: игрок рядом (или на вышке прямо над псом) — лёгкая тряска, спереди
        if (!p.hit && tp.player && Math.abs(bearingOf(dog)) < FRONT_ANGLE + 0.25) {
          const tw2 = shared.towerPos;
          const near = Math.hypot(v1.x - head.x, v1.z - head.z) < 2.5 * s || (tw2 && Math.hypot(v1.x - tw2.x, v1.z - tw2.z) < 3.5 + 0.3 * s);
          if (near) {
            try {
              shared.screenShake?.(Math.min(0.35, 0.05 * s + 0.08), shakeDir.set(head.x - dog.x, 0, head.z - dog.z).normalize());
            } catch {
              // тряска не важнее игры
            }
          }
        }
      }
    } else {
      const k = Math.min(1, p.t / tr);
      dog.rearReach = 1 - smooth01(k);
      if (k >= 1) {
        p.phase = 0;
        p.cd = rand(0.7, 1.2);
      }
    }
  };
  const bearingOf = (dog) => Math.atan2(dog.x - head.x, head.z - dog.z);

  // ---- цель пса (две команды): tp — куда бежать и по чему бить. player — игрок (голова), unit — пёс
  // другой команды, rally — союзнику некого бить: ждёт впереди игрока. r — «радиус» цели (полкорпуса).
  const tp = { x: 0, y: 0, z: 0, unit: null, player: true, rally: false, r: 0 };
  const alive = (u) => u && (u.mode === 'alive' || u.knocked);
  const pickTarget = (unit, dt) => {
    const dog = unit.dog;
    const ally = dog.team === 'ally';
    dog.retarget = (dog.retarget ?? 0) - dt;
    let cur = dog.target;
    if (cur && cur !== 'player' && !alive(cur)) {
      cur = dog.target = null;
      dog.retarget = 0;
    }
    if (dog.retarget <= 0 || cur == null) {
      dog.retarget = RETARGET_S * rand(0.8, 1.2);
      let best = null;
      let bestD = Infinity;
      if (!ally) {
        best = 'player';
        bestD = Math.hypot(head.x - dog.x, head.z - dog.z);
      }
      if (shared.allies !== false || ally) {
        for (let i = 0; i < units.length; i += 1) {
          const o = units[i];
          if (o === unit || !alive(o) || o.emerging || (o.dog.team === 'ally') === ally) continue;
          const d = Math.hypot(o.dog.x - dog.x, o.dog.z - dog.z);
          if (d < bestD) {
            bestD = d;
            best = o;
          }
        }
      }
      // липкость: прежнюю цель меняет, только если новая заметно ближе
      if (cur && cur !== best) {
        const cd = cur === 'player' ? Math.hypot(head.x - dog.x, head.z - dog.z) : Math.hypot(cur.dog.x - dog.x, cur.dog.z - dog.z);
        if (bestD > 0.75 * cd) best = cur;
      }
      // сопровождение стаи (drones.js) метит цель — псы стаи бегут на неё, если она не намного дальше
      const mark = dog.squad ? shared.squadMarks?.[dog.squad] : null;
      if (mark && mark !== best && mark !== unit && mark.dog && alive(mark) && !mark.emerging && (mark.dog.team === 'ally') !== ally) {
        const md = Math.hypot(mark.dog.x - dog.x, mark.dog.z - dog.z);
        if (md < 1.5 * bestD + 4) best = mark;
      }
      dog.target = best;
    }
    const t = dog.target;
    tp.unit = null;
    tp.player = false;
    tp.rally = false;
    if (t === 'player') {
      tp.player = true;
      tp.x = head.x;
      tp.y = head.y;
      tp.z = head.z;
      tp.r = 0;
    } else if (t) {
      tp.unit = t;
      tp.x = t.dog.x;
      tp.z = t.dog.z;
      tp.y = t.bodyCenter.y + CHEST_BELOW_HEAD * t.scale; // «голова» пса-цели: прыгают на корпус
      tp.r = 0.45 * t.scale;
      // враг, на которого бегут союзники, тоже приходит в ярость
      if (!ally && !dog.angry && Math.hypot(tp.x - dog.x, tp.z - dog.z) < 30) enrage(unit, 0);
    } else {
      tp.rally = true;
      tp.x = head.x;
      tp.y = head.y;
      tp.z = head.z - RALLY_M;
      tp.r = 0;
    }
  };
  // удар пса по псу другой команды: урон по размеру нападающего
  const targetHit = (attacker, target, point, dx, dz, scale = 1) => {
    v2.set(dx, 0, dz).normalize();
    const result = target.strike(point, v2, Math.max(1, Math.round(attacker.scale * scale)) * damageMul(target));
    if (target.dog.team !== 'ally' && !target.dog.angry) enrage(target, 0);
    sfx.thud(point, attacker.scale);
    return result;
  };

  let forcePose = null; // отладка: { rear, rearReach, prowl, brake, look } поверх поведения (только с ПК)
  let skidLeft = 0; // сколько облачков пыли юзом ещё можно в этом кадре (update ставит 3)
  // рывок вбок (уворот, 0,4 с; идёт и в прыжке вбок)
  const dodgeTick = (dog, rs, dt) => {
    if (!(dog.dodgeT > 0)) {
      dog.vs = 0;
      return;
    }
    dog.dodgeT -= dt;
    dog.vs = dog.dodgeSide * 3.2 * rs * Math.sin(Math.PI * clamp01(1 - dog.dodgeT / 0.4));
    if (dog.dodgeT <= 0) dog.vs = 0;
  };
  // прыжок на ногу вышки (dog.climb): присел — стоит; взлетел — к центру; у ног или в верхней точке —
  // отскок назад (скрежет когтей), падает
  const climbStep = (unit, dog, j, s) => {
    const c = dog.climb;
    if (j.phase === 0) {
      dog.v = 0.3;
      return;
    }
    if (!c.go) {
      c.go = true;
      dog.v = c.v;
    }
    if (!c.bounced && j.phase === 1 && (unit.jumpVy <= 0.3 || Math.hypot(dog.x - c.x, dog.z - c.z) < TOWER_LEG_R)) {
      c.bounced = true;
      dog.v = -1.3 * Math.sqrt(s);
      unit.kick(-7, (Math.random() - 0.5) * 6);
      sfx.scrape(unit.bodyCenter, 0.9, s);
    }
  };
  // ---- поведение одного пса (бег к игроку, бросок или лапа, отскок)
  const steer = (unit, dt) => {
    const dog = unit.dog;
    const s = unit.scale; // размер: дальности ×s, время броска ×√s
    const rs = Math.sqrt(s);
    const size = sizeOf(dog);
    if (dog.kind === undefined) initTraits(dog, size);
    if (dog.frozen) {
      // отладка (снимки поз с ПК): стоит на месте, поза — debug.force
      dog.v = dog.w = dog.vs = 0;
      if (forcePose) Object.assign(dog, forcePose);
      return;
    }
    dog.t += dt;
    dog.age = (dog.age ?? 0) + dt;
    pickTarget(unit, dt); // tp: игрок, пёс другой команды или точка сбора союзников
    const dx = tp.x - dog.x;
    const dz = tp.z - dog.z;
    const dist = Math.hypot(dx, dz) || 1e-3;
    // где пёс относительно игрока: угол от «вперёд» мира (−Z), + вправо; на игрока — только спереди
    const bearing = bearingOf(dog);
    const inFront = !tp.player || Math.abs(bearing) < FRONT_ANGLE;
    const j = dog.jump;
    // поза и глаза: цели на этот кадр (на дыбы и удар с дыб выставляют pawStep/тревога, сглаживания им
    // не нужно — кривые и так плавные); крадётся и довёрнут — сглаживаются ниже
    dog.rear = 0;
    dog.rearReach = 0;
    let prowlGoal = 0;
    let lookGoal = 0;
    let brakeGoal = 0;
    // глаза: вдали тусклее, у цели — ярко и пульсируют, перед атакой — добела
    let glow = !dog.angry ? 1 : dist < 25 ? 1 + 0.12 * Math.sin(dog.age * 9) : 0.72;
    dog.hopCd = (dog.hopCd ?? 0) - dt;
    if (j) {
      // бросок: присел — почти стоит; полетел — с расчётной скоростью к игроку
      if (dog.leap) {
        if (j.phase === 0) {
          dog.v = 0.4;
          glow = 1.3 + 0.2 * Math.random(); // присел перед броском: глаза добела, мерцают
        } else if (j.phase === 1 && !dog.leap.flying) {
          dog.leap.flying = true;
          dog.v = dog.leap.v;
          if (dog.leap.pounce) sfx.whoosh(unit.bodyCenter, s);
        }
        // в полёте: центр корпуса у линии голова–грудь — удар
        if (j.phase === 1 && !dog.leap.struck && tp.unit) {
          // бросок на пса: корпус долетел до корпуса цели — удар
          if (unit.bodyCenter.distanceTo(tp.unit.bodyCenter) < CONTACT_R * s + tp.r) {
            dog.leap.struck = true;
            dog.v = -2.4 * rs;
            unit.jumpVy = Math.max(0, unit.jumpVy) * 0.3 + 1.2 * rs;
            v1.copy(unit.bodyCenter).lerp(tp.unit.bodyCenter, 0.5);
            targetHit(unit, tp.unit, v1, dx, dz);
          }
        } else if (j.phase === 1 && !dog.leap.struck && tp.player) {
          const by = unit.bodyCenter.y;
          const top = head.y;
          const bottom = head.y - 0.7;
          const cy = by > top ? top : by < bottom ? bottom : by;
          contact.set(head.x, cy, head.z);
          if (Math.abs(bearing) < FRONT_ANGLE + 0.25 && unit.bodyCenter.distanceTo(contact) < CONTACT_R * s) {
            dog.leap.struck = true;
            dog.v = -2.4 * rs; // отлетает назад
            unit.jumpVy = Math.max(0, unit.jumpVy) * 0.3 + 1.2 * rs;
            unit.kick(-7, (Math.random() - 0.5) * 6);
            v1.copy(unit.bodyCenter).lerp(contact, 0.5);
            playerHit(v1, dx, dz, 0.5 + 0.1 * s, s);
          }
        }
      } else if (dog.climb) climbStep(unit, dog, j, s);
      else dodgeTick(dog, rs, dt); // прыжок вбок (уворот) или через труп: рывок вбок продолжается
      dog.w = 0;
    } else {
      if (dog.leap) {
        // приземлился после броска: постоять и снова бежать
        dog.state = 'recover';
        dog.t = dog.leap.struck ? -0.6 : 0.4; // ударил — дольше приходит в себя (1,4 с)
        dog.leap = null;
        dog.charged = false;
      }
      if (dog.climb) {
        // сорвался с ноги вышки: приземлился, встряхнулся
        dog.climb = null;
        dog.state = 'recover';
        dog.t = 0.3;
      }
      let goal = 0;
      let face = yawTo(dx, dz);
      const faceDiff = Math.abs(wrap(face - dog.yaw));
      if (size.paw) pawStep(unit, dog, s, dt, dist - tp.r, inFront && !tp.rally, faceDiff);
      const striking = Boolean(dog.paw?.phase);
      if (dog.state === 'stun') {
        if (dog.t > 0.35) dog.state = 'run';
      } else if (dog.state === 'recover') {
        if (dog.t > 0.8) dog.state = 'run';
      } else if (dog.state === 'alert') {
        // тревога: встал, дёрнулся, злой лай — и вперёд; большой — встаёт на дыбы и ревёт
        const big = size.paw && !dog.broken;
        if (dog.t >= 0 && !dog.alerted) {
          dog.alerted = true;
          unit.kick(-8, (Math.random() - 0.5) * 8);
          if (big || Math.random() < 0.25) sfx.howl(unit.bodyCenter, s);
          else sfx.bark(unit.bodyCenter, s);
        }
        if (dog.t >= 0) {
          glow = 1.5;
          if (big) {
            const k = dog.t / ALERT_REAR_S;
            dog.rear = smooth01(k / 0.3) * (1 - smooth01((k - 0.75) / 0.25));
          }
        }
        face = yawTo(dx, dz);
        if (dog.t > (big ? ALERT_REAR_S : ALERT_S)) dog.state = 'run';
      } else {
        dog.state = 'run';
        goal = dog.speed * (dog.angry ? 1 : CALM_SPEED);
        if (!dog.angry) prowlGoal = 0.6; // спокойный — крадётся, низко и широко
        // рывок (rusher — ближе CHARGE_NEAR, stalker — после засады): быстрее, во весь опор
        if (dog.charge > 0) {
          dog.charge -= dt;
          goal *= CHARGE_MUL;
        } else if (dog.kind === 'rusher' && dog.angry && !dog.charged && inFront && !tp.rally && dist < CHARGE_NEAR * Math.sqrt(rs) && dist > 6 * s + tp.r) {
          dog.charged = true;
          dog.charge = rand(CHARGE_S[0], CHARGE_S[1]);
          unit.kick(-5, 0);
          if (Math.random() < 0.5) sfx.howl(unit.bodyCenter, s);
          else sfx.bark(unit.bodyCenter, s);
        }
        if (dist > CHARGE_NEAR * 1.6 * Math.sqrt(rs)) dog.charged = false;
        // к игроку; сзади или сбоку — сначала обежать по кругу вперёд (точка на круге, на ~50° ближе
        // к «вперёд»), там уже бросаться
        let ox = dx / dist;
        let oz = dz / dist;
        // пулемётчик в ярости ближе STRAFE_FAR: бежит вбок поперёк фронта игрока (направление меняет
        // каждые 2–5 с и у края сектора ±60°), медленно сближаясь; корпус — по бегу, башня — на игрока
        const strafing = tp.player && dog.turret && dog.angry && inFront && dist < STRAFE_FAR && dist > STRAFE_NEAR;
        if (strafing) {
          dog.strafeT = (dog.strafeT ?? 0) - dt;
          if (!dog.strafeDir || dog.strafeT <= 0) {
            dog.strafeDir = dog.strafeDir ? -dog.strafeDir : Math.random() < 0.5 ? -1 : 1;
            dog.strafeT = rand(2, 5);
          }
          if (Math.abs(bearing) > STRAFE_EDGE && Math.sign(bearing) === dog.strafeDir) {
            dog.strafeDir = -dog.strafeDir;
            dog.strafeT = rand(2, 5);
          }
          const b = bearing + dog.strafeDir * 0.5;
          const r = Math.max(STRAFE_NEAR, dist - 1.2);
          const tx = head.x + Math.sin(b) * r - dog.x;
          const tz = head.z - Math.cos(b) * r - dog.z;
          const td = Math.hypot(tx, tz) || 1e-3;
          ox = tx / td;
          oz = tz / td;
          goal *= 0.8;
        }
        // флангер: заходит сбоку — на игрока по спирали к краю фронта (±FLANK_ANGLE), на пса — курсом в
        // сторону от прямой; вблизи (6 × размер) — в лоб
        if (dog.kind === 'flanker' && dog.angry && !strafing && !tp.rally && dist > 6 * s + tp.r) {
          if (tp.player) {
            const b = dog.side * FLANK_ANGLE;
            const r = Math.max(4 * s, dist * 0.72);
            const tx = head.x + Math.sin(b) * r - dog.x;
            const tz = head.z - Math.cos(b) * r - dog.z;
            const td = Math.hypot(tx, tz) || 1e-3;
            ox = tx / td;
            oz = tz / td;
          } else {
            const a = dog.side * 0.6 * clamp01((dist - 6 * s) / (10 * s));
            const c = Math.cos(a);
            const sn = Math.sin(a);
            const nx = ox * c - oz * sn;
            oz = ox * sn + oz * c;
            ox = nx;
          }
        }
        if (!inFront) {
          const b = bearing - Math.sign(bearing) * 0.9;
          const ring = LEAP_RANGE * s * 1.3 + 1.5;
          const tx = head.x + Math.sin(b) * ring - dog.x;
          const tz = head.z - Math.cos(b) * ring - dog.z;
          const td = Math.hypot(tx, tz) || 1e-3;
          ox = tx / td;
          oz = tz / td;
        }
        // не толкаться: отталкивание от других живых псов; труп прямо по курсу — перепрыгнуть
        // (маленькие и средние на бегу, тем же проходом)
        const hopper = !size.paw && dog.hopCd <= 0 && dog.v > 2 * rs;
        const fwx = -Math.sin(dog.yaw);
        const fwz = -Math.cos(dog.yaw);
        let hopOver = 0;
        for (let i = 0; i < units.length; i += 1) {
          const other = units[i];
          if (other === unit || other === tp.unit) continue;
          if (other.mode !== 'alive') {
            if (hopper && (other.mode === 'dead' || other.mode === 'dying') && other.scale <= 1.7 * s) {
              const cx = other.bodyCenter.x - dog.x;
              const cz = other.bodyCenter.z - dog.z;
              const along = cx * fwx + cz * fwz;
              if (along > 0.3 * s && along < 1.3 * s + 0.4 * other.scale && Math.abs(cx * fwz - cz * fwx) < 0.35 * (s + other.scale) && other.bodyCenter.y - groundHeight(other.bodyCenter.x, other.bodyCenter.z) > -0.1) hopOver = Math.max(hopOver, other.scale);
            }
            continue;
          }
          const ax = dog.x - other.dog.x;
          const az = dog.z - other.dog.z;
          const room = 0.8 * (s + other.scale);
          const a2 = ax * ax + az * az;
          if (a2 >= room * room) continue; // без корня для далёких (их почти все)
          const ad = Math.sqrt(a2);
          if (ad > 1e-3) {
            const push = ((room - ad) / room) * 1.5;
            ox += (ax / ad) * push;
            oz += (az / ad) * push;
          }
        }
        if (hopOver && unit.jump({ height: 0.3 + (0.22 * hopOver) / s, crouch: 0.04 })) dog.hopCd = 1.2;
        face = yawTo(ox, oz);
        // бег не по линейке: плавный зигзаг (у каждого пса свой размах и частота), у игрока гаснет
        const wv = dog.weave;
        if (wv && !striking && !strafing) face += wv[0] * (dog.angry ? 1 : 0.35) * Math.max(0, Math.min(1, (dist - 4 * s) / (8 * s))) * Math.sin(dog.age * wv[1] + wv[2]);
        // засада (stalker): ближе STALK_R крадётся по кругу пригнувшись (круг медленно сжимается), корпус
        // довёрнут к цели, рычит; через 2–4 с — рёв и рывок (наскок разрешён сразу)
        if (dog.kind === 'stalker' && dog.angry && !strafing && !tp.rally && !(tp.player && (shared.playerElevation ?? 0) > 1)) {
          if (dog.stalk === 0 && inFront && dist < STALK_R * rs && dist > 5 * s + tp.r) {
            dog.stalk = rand(STALK_S[0], STALK_S[1]);
            dog.stalkR = dist;
            dog.circleDir = Math.random() < 0.5 ? -1 : 1;
            dog.growlT = 0;
          }
          if (dog.stalk > 0) {
            dog.stalk -= dt;
            dog.stalkR = Math.max(4 * s + tp.r, dog.stalkR - 0.7 * rs * dt);
            // у края сектора спереди — в другую сторону (на игрока нападают только спереди)
            if (tp.player && Math.abs(bearing) > FRONT_ANGLE - 0.25 && Math.abs(bearing) > Math.abs(dog.lastBearing ?? 0)) dog.circleDir = -dog.circleDir;
            const cd = dog.circleDir;
            const k = (dist - dog.stalkR) / (2 * rs);
            face = yawTo((-dz * cd + dx * k) / dist, (dx * cd + dz * k) / dist);
            goal = dog.speed * 0.3;
            prowlGoal = 1;
            lookGoal = 1;
            glow = 1.15 + 0.15 * Math.sin(dog.age * 6);
            dog.growlT -= dt;
            if (dog.growlT <= 0) {
              dog.growlT = rand(1.1, 2);
              sfx.growl(unit.bodyCenter, s);
            }
            if (dog.stalk <= 0) {
              dog.stalk = -1;
              dog.charge = rand(CHARGE_S[0], CHARGE_S[1]) * 1.2;
              dog.pounceCd = 0;
              unit.kick(-7, (Math.random() - 0.5) * 4);
              sfx.howl(unit.bodyCenter, s);
            }
          } else if (dog.stalk < 0 && dist > STALK_R * rs * 1.6) dog.stalk = 0; // отбросило далеко — снова засада
        }
        dog.lastBearing = bearing;
        if (size.paw && inFront) {
          // лапой: подбегает и встаёт перед игроком (тормозит заранее), бьёт стоя, мордой к нему
          goal *= Math.max(0, Math.min(1, (dist - tp.r - PAW_STAND * s) / (1.2 * s)));
          if (striking) goal = 0;
          if (dist - tp.r < PAW_REACH * s * 1.3) face = yawTo(dx, dz);
        }
        if (tp.rally) goal = dist > 3 ? dog.speed * 0.45 : 0; // союзник без врагов: ждёт впереди игрока
        // вышка (tower.js): игрок на площадке — мелкие (без лапы) не прыгают, а кружат у подножия (~3,5 м от центра)
        const onTower = tp.player && (globalThis.__sceneState?.playerElevation ?? 0) > 1;
        if (onTower && !size.paw && dist < 6) {
          const cd = (dog.circleDir ??= Math.random() < 0.5 ? -1 : 1);
          const k = (dist - 3.5) / 2;
          face = yawTo((-dz * cd + dx * k) / dist, (dx * cd + dz * k) / dist);
          goal = dog.speed * 0.5;
          lookGoal = 1;
          // кидается на ногу вышки: присел, прыжок вверх-к центру на 1,2–2,2 м (× размер), у ног —
          // отскок, срывается вниз
          dog.climbCd = (dog.climbCd ?? 2) - dt;
          if (dog.climbCd <= 0 && dog.angry && !dog.broken && dist > 2.6 && dist < 4.8) {
            dog.climbCd = rand(CLIMB_GAP[0], CLIMB_GAP[1]);
            const twp = shared.towerPos;
            const cx = twp ? twp.x : head.x;
            const cz = twp ? twp.z : head.z;
            const hgt = rand(CLIMB_H[0], CLIMB_H[1]);
            if (unit.jump({ height: hgt, crouch: 0.25 })) {
              const dc = Math.hypot(cx - dog.x, cz - dog.z);
              const up = Math.sqrt(2 * GRAVITY * hgt * s) / GRAVITY; // с до верхней точки
              dog.yaw = yawTo(cx - dog.x, cz - dog.z);
              dog.climb = { x: cx, z: cz, v: Math.max(0.6, Math.min(4, (dc - TOWER_LEG_R + 0.2) / up)), go: false, bounced: false };
              if (Math.random() < 0.4) sfx.growl(unit.bodyCenter, s);
            }
          }
        }
        if (dog.broken) goal *= 0.55; // хромает
        const diff = Math.abs(wrap(yawTo(dx, dz) - dog.yaw));
        if (!size.paw && !tp.rally && !onTower && inFront && dist < LEAP_RANGE * s * (size.leap ?? 1) + tp.r + dog.v * 0.15 && diff < 0.5) {
          // бросок: долететь до груди за LEAP_T (большой — дольше и выше, огромный просто сносит;
          // великан — низкий выпад всей тушей)
          const slow = s > 1.2; // средний — медленнее и заметнее: долгий присед, полёт дольше
          const lt = LEAP_T * rs * (slow ? 1.2 : 1);
          const chest = tp.y - CHEST_BELOW_HEAD - groundHeight(dog.x, dog.z) - BODY_Y * s;
          const h = size.giant ? 0.12 * s : Math.max(0.3 * s, chest);
          const vy = (h + 0.5 * GRAVITY * lt * lt) / lt;
          if (unit.jump({ vy, crouch: dog.broken ? 0.4 : 0.12 })) {
            dog.leap = { v: Math.max(1, dist - 0.25 * s) / lt, flying: false, struck: false };
            dog.yaw = yawTo(dx, dz);
          }
        }
        // наскок издалека (rusher, stalker; маленькие и средние): присел с рыком, глаза добела — длинный
        // прыжок высокой дугой на грудь (от него можно уйти: курс задан в момент решения)
        dog.pounceCd = (dog.pounceCd ?? 0) - dt;
        const pr = dist - tp.r;
        if (!dog.jump && !size.paw && dog.kind !== 'flanker' && dog.angry && !tp.rally && !onTower && inFront && !(dog.stalk > 0) && !dog.broken
          && dog.pounceCd <= 0 && pr > POUNCE[0] * s && pr < POUNCE[1] * s && diff < 0.3 && Math.random() < dt * 2.5) {
          const lt = POUNCE_T * rs;
          const chest = tp.y - CHEST_BELOW_HEAD - groundHeight(dog.x, dog.z) - BODY_Y * s;
          const h = Math.max(0.35 * s, chest);
          const vy = (h + 0.5 * GRAVITY * lt * lt) / lt;
          if (unit.jump({ vy, crouch: POUNCE_CROUCH })) {
            dog.leap = { v: Math.max(1, dist - 0.25 * s) / lt, flying: false, struck: false, pounce: true };
            dog.yaw = yawTo(dx, dz);
            dog.pounceCd = rand(POUNCE_CD[0], POUNCE_CD[1]);
            sfx.growl(unit.bodyCenter, s);
          }
        }
      }
      const diff = wrap(face - dog.yaw);
      dog.w = Math.max(-4, Math.min(4, diff * 5));
      dog.yaw = wrap(dog.yaw + dog.w * dt);
      goal *= Math.max(0.2, Math.min(1, 1.3 - Math.abs(diff) / 1.2));
      // резко тормозит с разгона (засада, вышка, перед лапой, крутой поворот) — юзом: корпус назад,
      // передние упираются, пыль из-под лап, скрежет
      const decel = dog.v - goal;
      if (dog.state === 'run' && decel > 2.2 * rs && dog.v > 2.6 * rs) brakeGoal = Math.min(1, decel / (4 * rs));
      dog.v += Math.max(-(6 + 5 * brakeGoal) * dt, Math.min(3.5 * dt, goal - dog.v));
      dog.skidT = (dog.skidT ?? 0) - dt;
      if (brakeGoal > 0.45 && dog.skidT <= 0 && skidLeft > 0 && Math.abs(dog.x - head.x) + Math.abs(dog.z - head.z) < 50) {
        skidLeft -= 1; // пыль юзом — не больше 3 облачков за кадр на всех
        dog.skidT = 0.11;
        unit.foot(Math.random() < 0.5 ? 0 : 1, v1);
        v1.y = groundHeight(v1.x, v1.z);
        footfall(v1);
        sfx.scrape(unit.bodyCenter, brakeGoal, s);
      }
      // изредка — резкий уворот вбок (не великаны и не вблизи игрока): 0,4 с рывка; маленькие и
      // средние чаще всего — прыжком вбок
      if (dog.dodgeT > 0) dodgeTick(dog, rs, dt);
      else if (!size.paw && dog.angry && !dog.turret && dog.state === 'run' && !(dog.stalk > 0) && dist > 6 * s && dist < 32 && Math.random() < dt * 0.3) {
        dog.dodgeT = 0.4;
        dog.dodgeSide = Math.random() < 0.5 ? -1 : 1;
        if (s <= 1.6 && Math.random() < 0.6) unit.jump({ height: 0.28, crouch: 0.05 });
      }
      if (lookGoal) lookGoal = wrap(yawTo(dx, dz) - dog.yaw); // корпус довёрнут к цели
    }
    if (dog.leap || dog.climb) dog.vs = 0;
    // сглаживание позы: крадётся, довёрнут, юзом
    const ks = Math.min(1, dt * 5);
    dog.prowl = (dog.prowl ?? 0) + (prowlGoal - (dog.prowl ?? 0)) * ks;
    dog.look = (dog.look ?? 0) + (lookGoal - (dog.look ?? 0)) * ks;
    dog.brake = (dog.brake ?? 0) + (brakeGoal - (dog.brake ?? 0)) * Math.min(1, dt * 10);
    if (dog.paw?.phase === 1) glow = 1.3 + 0.2 * Math.random(); // замах лапой / встаёт на дыбы
    if (forcePose) Object.assign(dog, forcePose); // отладка (debug.force): поза на всех псов
    unit.glow(glow);
    dog.x -= Math.sin(dog.yaw) * dog.v * dt;
    dog.z -= Math.cos(dog.yaw) * dog.v * dt;
    if (dog.vs) {
      dog.x += Math.cos(dog.yaw) * dog.vs * dt;
      dog.z -= Math.sin(dog.yaw) * dog.vs * dt;
    }
    if (!dog.jump) {
      // по земле сквозь игрока не проходит
      const ax = dog.x - head.x;
      const az = dog.z - head.z;
      const ad = Math.hypot(ax, az);
      const personal = (size.paw ? 0.55 : PERSONAL_M) * s;
      if (ad < personal && ad > 1e-3) {
        dog.x = head.x + (ax / ad) * personal;
        dog.z = head.z + (az / ad) * personal;
      }
    }
  };

  // ---- пулемёт на спине
  const pendingHits = new Float32Array(16 * 3); // [через сколько с, dx, dz] попаданий в пути
  let pendingCount = 0;
  const aim = new THREE.Vector3();
  const muzzle = new THREE.Vector3();
  const shotDir = new THREE.Vector3();
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(Math.PI * 2 * Math.random());
  const turnTo = (cur, goal, maxStep) => cur + Math.max(-maxStep, Math.min(maxStep, wrap(goal - cur)));
  // точка прицела пулемёта: голова игрока или корпус пса-цели; false — целиться не во что
  const aimPoint = (dog, out) => {
    const t = dog.target;
    if (t === 'player') {
      out.set(head.x, head.y - 0.25, head.z);
      return true;
    }
    if (t && alive(t)) {
      out.copy(t.bodyCenter);
      return true;
    }
    return false;
  };
  const fireRound = (unit) => {
    const t = unit.model.turret;
    const dog = unit.dog;
    if (!aimPoint(dog, aim)) return;
    t.muzzle.getWorldPosition(muzzle);
    const ally = dog.team === 'ally';
    shotDir.subVectors(aim, muzzle);
    const range = shotDir.length() || 1;
    shotDir.divideScalar(range);
    shotDir.x += gauss() * TURRET_SPREAD;
    shotDir.y += gauss() * TURRET_SPREAD;
    shotDir.z += gauss() * TURRET_SPREAD;
    shotDir.normalize();
    const s = unit.scale;
    if (dog.target !== 'player') {
      // по псу: луч против его корпуса и ног (cast); попал — 1 урон сразу
      const target = dog.target;
      const tHit = target.cast(muzzle, shotDir, range + 10 * target.scale);
      fx.bolt(muzzle, shotDir, TURRET_SPEED, tHit >= 0 ? tHit : range + 40, ally);
      fx.flash(muzzle, 0.09 * Math.sqrt(s), true);
      sfx.mg(muzzle, Math.sqrt(s));
      if (tHit >= 0) {
        const part = target.hitPart; // strike() его сбросит
        if (targetHit(unit, target, v1.copy(muzzle).addScaledVector(shotDir, tHit), shotDir.x, shotDir.z, 1 / Math.max(1, s)) === 'hit' && part >= 1) legHit(target, part, false, shotDir);
      }
      return;
    }
    // мимо или в игрока: расстояние от луча до точки прицела
    v1.subVectors(aim, muzzle);
    const along = v1.dot(shotDir);
    const miss = Math.sqrt(Math.max(0, v1.lengthSq() - along * along));
    const hitPlayer = along > 0 && miss < TURRET_HIT_R;
    fx.bolt(muzzle, shotDir, TURRET_SPEED, hitPlayer ? along : along + 40, ally);
    fx.flash(muzzle, 0.09 * Math.sqrt(s), true);
    sfx.mg(muzzle, Math.sqrt(s));
    if (hitPlayer && pendingCount < 16) {
      const j = pendingCount * 3;
      pendingHits[j] = along / TURRET_SPEED;
      pendingHits[j + 1] = shotDir.x;
      pendingHits[j + 2] = shotDir.z;
      pendingCount += 1;
    }
  };
  const turretStep = (unit, dt) => {
    const dog = unit.dog;
    const t = unit.model.turret;
    const g = (dog.gun ??= { cd: 1 + Math.random(), wind: 0, shots: 0, gap: 0 });
    // наводка: цель (голова игрока или корпус пса) в системе корпуса → углы башенки
    const has = aimPoint(dog, aim);
    if (!has) aim.set(dog.x - Math.sin(dog.yaw) * 10, unit.bodyCenter.y, dog.z - Math.cos(dog.yaw) * 10); // вперёд
    const dist = Math.hypot(aim.x - dog.x, aim.z - dog.z);
    unit.model.body.worldToLocal(aim);
    aim.sub(t.yaw.position);
    const goalYaw = Math.atan2(-aim.x, -aim.z);
    const goalPitch = Math.max(-0.5, Math.min(0.9, Math.atan2(aim.y - t.pivotY, Math.hypot(aim.x, aim.z))));
    const step = TURRET_TURN * dt;
    t.yaw.rotation.y = turnTo(t.yaw.rotation.y, goalYaw, step);
    t.pitch.rotation.x = turnTo(t.pitch.rotation.x, goalPitch, step);
    const aimed = Math.abs(wrap(goalYaw - t.yaw.rotation.y)) < 0.08 && Math.abs(goalPitch - t.pitch.rotation.x) < 0.08;
    const can = has && unit.mode === 'alive' && !unit.emerging && dog.angry && dist < TURRET_RANGE && (dog.target !== 'player' || Math.abs(bearingOf(dog)) < FRONT_ANGLE);
    g.cd -= dt;
    if (g.shots > 0) {
      g.gap -= dt;
      if (g.gap <= 0) {
        if (can) fireRound(unit);
        g.shots -= 1;
        g.gap = TURRET_GAP;
      }
    } else if (g.wind > 0) {
      g.wind -= dt;
      if (g.wind <= 0) {
        g.shots = 3;
        g.gap = 0;
      }
    } else if (can && aimed && g.cd <= 0) {
      // замах: вжик наводки и огонёк на дуле — видно и слышно, что сейчас будет очередь
      g.wind = TURRET_WIND;
      g.cd = 1;
      t.muzzle.getWorldPosition(muzzle);
      sfx.turretWind(muzzle, Math.sqrt(unit.scale)); // мотор башенки раскручивается (robodog-sound.js)
      fx.flash(muzzle, 0.05 * Math.sqrt(unit.scale), true);
    }
  };
  const hitsStep = (dt) => {
    for (let i = pendingCount - 1; i >= 0; i -= 1) {
      const j = i * 3;
      pendingHits[j] -= dt;
      if (pendingHits[j] > 0) continue;
      try {
        shakeDir.set(pendingHits[j + 1], 0, pendingHits[j + 2]).normalize();
        shared.screenShake?.(0.25, shakeDir);
      } catch {
        // тряска не важнее игры
      }
      pendingCount -= 1;
      const k = pendingCount * 3;
      pendingHits[j] = pendingHits[k];
      pendingHits[j + 1] = pendingHits[k + 1];
      pendingHits[j + 2] = pendingHits[k + 2];
    }
  };

  // ---- бюджет кукол: считаются не больше RAGDOLL_MAX трупов; лишние (давние) сразу ложатся на землю.
  // Тела на Quest — самое дорогое в стае (~0,5 мс на куклу).
  const ragdollBudget = () => {
    let active = 0;
    for (let i = 0; i < units.length; i += 1) if (units[i].ragdollActive()) active += 1;
    while (active > RAGDOLL_MAX) {
      let oldest = null;
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u.ragdollActive() && (!oldest || u.deadFor > oldest.deadFor)) oldest = u;
      }
      if (!oldest) break;
      oldest.settle();
      active -= 1;
    }
  };

  // ---- волны: у каждой стороны раз в 25–40 с большая волна (10–20 псов стаями по SURGE_PACK за
  // несколько секунд), между ними — по чуть-чуть; волны сторон сдвинуты на полпериода, так что фронт
  // качается туда-сюда. Перед волной — рог (робот-рог, robodog-horn.js): врагов — низкий, спереди
  // издалека; союзников — выше, сзади.
  const randInt = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));
  const horn = createHorn(shared);
  // Качели (по просьбе пользователя), стороны наравне: волна врагов — по таймеру; размер любой волны —
  // от живых у другой стороны (×0,9–1,2, не меньше 10). Пока волна стороны идёт (от начала, пока от неё
  // не осталась четверть или 30 с), у ДРУГОЙ стороны подкреплений нет (её «понемногу» стоит). Ответная
  // волна союзников — когда враги прорвались ближе COUNTER_NEAR м к игроку, через COUNTER_DELAY с или
  // сразу, если волну врагов отбили раньше. Кончилась волна союзников — волна врагов через
  // AFTER_ALLY_WAVE с (не позже их таймера SURGE_EVERY). Так волны чередуются: враги → союзники → враги.
  // Перевес (momentumStep) усиливает качели. Дроны (drones.js) вылетают волной вместе с волной псов.
  let waveId = 0;
  let curWave = 0; // номер волны, которую сейчас выпускает spawnPack (placeDog метит псов)
  const aliveOf = (team, id = 0) => {
    let n = 0;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if (alive(u) && (u.dog.team === 'ally') === (team === 'ally') && (!id || u.dog.wave === id)) n += 1;
    }
    return n;
  };
  const startWave = (sv, team, why) => {
    const s = sv[team];
    const other = team === 'ally' ? 'enemy' : 'ally';
    const opp = aliveOf(other);
    s.size = Math.max(SURGE_SIZE[0], Math.round(opp * rand(WAVE_REL[0], WAVE_REL[1])));
    s.left = s.size;
    s.gap = 0;
    s.age = 0;
    s.id = ++waveId;
    s.countered = false;
    s.delay = rand(COUNTER_DELAY[0], COUNTER_DELAY[1]);
    s.next = rand(SURGE_EVERY[0], SURGE_EVERY[1]); // таймер не перезапускает волну сразу
    sv.active = team; // у другой стороны — пауза подкреплений
    // недоспавненная волна другой стороны досыпается (иначе ответ обрывал её на полпути — перекос)
    // для drones.js: с волной псов вылетает и волна коптеров этой стороны (n растёт с каждой волной)
    shared.dogWave = { team, n: (shared.dogWave?.n ?? 0) + 1 };
    v1.set(head.x, head.y + 5, head.z + (team === 'ally' ? 40 : -90));
    horn.play(v1, team === 'ally' ? 1.25 : 0.85, team === 'ally' ? 1 : 1.6);
    console.log(`[horde] волна: ${team === 'ally' ? 'союзники' : 'враги'} ×${s.size} (${why}; против живых ${opp}, своих живых ${aliveOf(team)})`);
  };
  const surgeStep = (dt) => {
    const sv = (run.surge ??= { active: null, enemy: { next: FIRST_SURGE, left: 0, gap: 0, age: 0 }, ally: { next: 0, left: 0, gap: 0, age: 0 } });
    const alliesOn = shared.allies !== false;
    // волна врагов по таймеру: тикает всегда, кроме их собственной волны (волна союзников его не
    // замораживает). Страховка: врагов нет дольше NO_ENEMY_S — волна сразу.
    if (sv.active !== 'enemy') {
      sv.enemy.next -= dt;
      sv.noEnemy = momentum.enemies === 0 ? (sv.noEnemy ?? 0) + dt : 0;
      if (sv.enemy.next <= 0 || sv.noEnemy > NO_ENEMY_S) {
        const why = sv.noEnemy > NO_ENEMY_S ? 'врагов нет' : 'по таймеру';
        sv.noEnemy = 0;
        startWave(sv, 'enemy', why);
      }
    }
    // ответ союзников: враги прорвались близко к игроку или прошло COUNTER_DELAY с
    const ew = sv.enemy;
    // (не раньше, чем волна врагов почти вся выпущена — стаи по SURGE_PACK раз в SURGE_GAP с)
    if (alliesOn && sv.active === 'enemy' && !ew.countered && ew.age > 6) {
      // прорыв — только псы этой волны
      let near = Infinity;
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u.dog.wave === ew.id && u.mode === 'alive') near = Math.min(near, Math.hypot(u.dog.x - head.x, u.dog.z - head.z));
      }
      if (near < COUNTER_NEAR || ew.age > ew.delay) {
        ew.countered = true;
        startWave(sv, 'ally', near < COUNTER_NEAR ? `враги в ${near.toFixed(0)} м` : 'ответ');
      }
    }
    for (const team of ['enemy', 'ally']) {
      if (team === 'ally' && !alliesOn) continue;
      const s = sv[team];
      s.age += dt;
      if (s.left > 0) {
        s.gap -= dt;
        if (s.gap <= 0) {
          curWave = s.id;
          const n = spawnPack(team, Math.min(s.left, SURGE_PACK));
          curWave = 0;
          s.left -= n;
          s.gap = n ? SURGE_GAP : 0.5;
          // сторона упёрлась в свой предел — остаток волны не ждёт (иначе волна не кончалась никогда)
          if (!n && teamInUse(team) >= TEAM_POOL) s.left = 0;
        }
      }
      // волна кончилась: выпущена и от неё осталась четверть — или в любом случае через WAVE_MAX_S
      if (sv.active === team && (s.age > WAVE_MAX_S || (s.left <= 0 && aliveOf(team, s.id) <= s.size * 0.25))) {
        s.left = 0;
        sv.active = null;
        console.log(`[horde] волна ${team === 'ally' ? 'союзников' : 'врагов'} кончилась (${s.age.toFixed(0)} с; живых: союзники ${aliveOf('ally')}, враги ${aliveOf('enemy')})`);
        // волны чередуются: волну врагов отбили раньше ответа — союзники сразу идут в ответ;
        // кончилась волна союзников — волна врагов скоро (AFTER_ALLY_WAVE с)
        if (team === 'enemy') {
          sv.enemy.next = rand(SURGE_EVERY[0], SURGE_EVERY[1]) * 0.6;
          if (alliesOn && !s.countered) {
            s.countered = true;
            startWave(sv, 'ally', 'враги отбиты');
          }
        } else sv.enemy.next = Math.min(sv.enemy.next, rand(AFTER_ALLY_WAVE[0], AFTER_ALLY_WAVE[1]));
      }
    }
  };
  const waveActive = () => run?.surge?.active ?? null;
  // Подкрепления вровень (по просьбе пользователя: «больше наших — больше и врагов», и наоборот):
  // сторона добирает живых до цели = живые у другой × MATCH (0,95–1,1), но не меньше пола (растёт
  // со временем MATCH_FLOOR) и не больше TEAM_POOL. Небольшой перебор (до 1,1) — обе стороны растут
  // вместе, рывками. Отстала больше чем на MATCH_TOL (20 %) — стаи по SURGE_PACK раз в MATCH_FAST с,
  // иначе — TRICKLE_PACK раз в TRICKLE_GAP. Пока идёт волна другой стороны — подкреплений нет.
  const matchStep = () => {
    const alliesOn = shared.allies !== false;
    const floor = Math.min(MATCH_FLOOR[1], MATCH_FLOOR[0] + run.elapsed * MATCH_RAMP);
    for (const team of ['enemy', 'ally']) {
      if (team === 'ally' && !alliesOn) continue;
      const key = team === 'ally' ? 'nextAlly' : 'nextSpawn';
      if (run[key] > 0) continue;
      const other = team === 'ally' ? 'enemy' : 'ally';
      if (waveActive() === other || aliveCount() > MAX_ALIVE - PACK[0]) {
        run[key] = 1;
        continue;
      }
      const opp = team === 'enemy' && !alliesOn ? 0 : aliveOf(other);
      const goal = Math.min(TEAM_POOL, Math.max(floor, Math.round(opp * rand(MATCH[0], MATCH[1]))));
      const lack = goal - aliveOf(team);
      if (lack < 2) {
        run[key] = 1;
        continue;
      }
      const behind = lack > goal * MATCH_TOL;
      const n = spawnPack(team, Math.min(lack, behind ? SURGE_PACK : randInt(TRICKLE_PACK)));
      run[key] = !n ? 1 : behind ? rand(MATCH_FAST[0], MATCH_FAST[1]) : rand(TRICKLE_GAP[0], TRICKLE_GAP[1]);
    }
  };
  // ---- перевес: живых больше у одной стороны — у другой «меньше здоровья» (урон по ней × 1/hpMul).
  // hpMul(союзники) = clamp((A/E)^k, 0,4…1,6), враги — наоборот; пересчёт раз в секунду.
  const momentum = { allies: 0, enemies: 0, hpAlly: 1, hpEnemy: 1, t: 0 };
  const momentumStep = (dt) => {
    momentum.t -= dt;
    if (momentum.t > 0) return;
    momentum.t = 1;
    let a = 0;
    let e = 0;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if (!alive(u)) continue;
      if (u.dog.team === 'ally') a += 1;
      else e += 1;
    }
    momentum.allies = a;
    momentum.enemies = e;
    const clampMul = (x) => Math.max(HP_MUL[0], Math.min(HP_MUL[1], x));
    momentum.hpAlly = clampMul(((a + 1) / (e + 1)) ** MOMENTUM_K);
    momentum.hpEnemy = clampMul(((e + 1) / (a + 1)) ** MOMENTUM_K);
  };
  const damageMul = (unit) => 1 / (unit.dog.team === 'ally' ? momentum.hpAlly : momentum.hpEnemy);

  let frameNo = 0;
  let sum = 0;
  let worst = 0;
  let frames = 0;
  let since = performance.now();

  return {
    // on — есть ли стая в сцене; keep — подмена файла сцены (живые псы остаются), иначе заново
    apply(on, { keep = false } = {}) {
      enabled = Boolean(on);
      if (!enabled) {
        teardown();
        run = shared.hordeRun = null;
        return;
      }
      ensurePool();
      for (const unit of units) unit.hide();
      fx.clear();
      if (keep && run) {
        run.dogs.forEach(({ dog, health }, i) => {
          const unit = units[i] ?? (units.length < POOL ? makeUnit() : null);
          if (unit) unit.spawn(dog, { health, boot: false });
        });
        return;
      }
      newRun();
    },
    update(dt) {
      if (hurt > 0) {
        hurt = Math.max(0, hurt - dt / 0.6);
        vignette.material.opacity = hurt * hurt;
        vignette.visible = hurt > 0;
      }
      if (warmQueue.length) warmStep();
      if (!enabled || !units || !run) return;
      const t0 = performance.now();
      dt = Math.min(dt, 0.05);
      refreshHead();
      if (run.pending) {
        if (head.lengthSq() === 0) return; // камера ещё не на месте
        run.pending = false;
      }
      run.elapsed += dt;
      run.nextSpawn -= dt;
      if (rageQueued) rageStep();
      // запас моделей: свободных меньше двух — одна новая за кадр (не больше POOL)
      if (units.length < POOL && makeUnit) {
        let off = 0;
        for (let i = 0; i < units.length; i += 1) if (units[i].mode === 'off') off += 1;
        // скелет дешёвый (без мешей): запас 8 свободных, до 3 новых за кадр
        for (let k = 0; k < 3 && off < 8 && units.length < POOL; k += 1, off += 1) makeUnit();
      }
      // подкрепления вровень с другой стороной (matchStep); союзники выключены — уходят
      if (shared.allies !== false) run.nextAlly = (run.nextAlly ?? ALLY_FIRST) - dt;
      else for (let i = 0; i < units.length; i += 1) if (units[i].mode !== 'off' && units[i].dog.team === 'ally') units[i].hide();
      matchStep();
      surgeStep(dt);
      momentumStep(dt);
      const PS = globalThis.__prof?.sub; // ВРЕМЕННО: профилировщик
      let used = 0;
      for (let i = 0; i < units.length; i += 1) if (units[i].mode !== 'off') used += 1;
      const corpseS = used > BUSY_USED ? CORPSE_BUSY_S : CORPSE_S; // псов много — трупы уходят раньше
      frameNo += 1;
      skidLeft = 3;
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i];
        if (unit.mode === 'off') continue;
        const ta = performance.now();
        if (unit.mode === 'alive' && !unit.emerging) steer(unit, dt);
        const tb = performance.now();
        const m0 = unit.mode;
        // LOD: живой пёс дальше LOD_NEAR м — походка и поза раз в 2 кадра, дальше LOD_FAR — раз в 3
        // (в пропущенных кадрах только переезжает); время копится
        let every = 1;
        if (unit.mode === 'alive' && !unit.emerging) {
          const ddx = unit.dog.x - head.x;
          const ddz = unit.dog.z - head.z;
          const d2 = ddx * ddx + ddz * ddz;
          every = d2 > LOD_FAR * LOD_FAR ? 4 : d2 > LOD_NEAR * LOD_NEAR ? 2 : 1;
        }
        unit.lodAcc = (unit.lodAcc ?? 0) + dt;
        if (every === 1 || (frameNo + i) % every === 0) {
          unit.update(Math.min(0.12, unit.lodAcc));
          unit.lodAcc = 0;
        } else if (every === 2) unit.follow(); // ближе LOD_FAR — хоть переезжает каждый кадр
        if (unit.dog.turret && unit.mode === 'alive') turretStep(unit, dt);
        if (PS) { PS.hSteer = (PS.hSteer || 0) + tb - ta; PS['h_' + m0] = (PS['h_' + m0] || 0) + performance.now() - tb; }
        if (unit.mode === 'dead' && unit.deadFor > corpseS) {
          const k = (unit.deadFor - corpseS) / SINK_S;
          if (k >= 1) unit.hide();
          else unit.setSink(k * 0.6 * unit.scale);
        }
      }
      if (pendingCount) hitsStep(dt);
      ragdollBudget();
      // все псы — в буферы экземпляров (позы уже посчитаны)
      inst.begin();
      for (let i = 0; i < units.length; i += 1) if (units[i].mode !== 'off') inst.add(units[i]);
      inst.end();
      const tf = performance.now();
      fx.update(dt);
      if (PS) PS.hFx = (PS.hFx || 0) + performance.now() - tf;

      const spent = performance.now() - t0;
      sum += spent;
      worst = Math.max(worst, spent);
      frames += 1;
      if (t0 - since >= LOG_EVERY_MS) {
        console.log(`[horde] cpu=${(sum / frames).toFixed(3)}/${worst.toFixed(2)}ms alive=${aliveCount()} used=${units.filter((u) => u.mode !== 'off').length} t=${run.elapsed.toFixed(0)}s fx=${fx.active} A=${momentum.allies} E=${momentum.enemies} hpA=${momentum.hpAlly.toFixed(2)} hpE=${momentum.hpEnemy.toFixed(2)} waveE=${run.surge?.enemy.next.toFixed(0)} waveA=${run.surge?.ally.next.toFixed(0)}`);
        sum = worst = frames = 0;
        since = t0;
      }
    },
    debug: {
      // проверка с ПК (не в шлеме!): поставить пса размера i (0 маленький … 3 огромный)
      spawn: (i = 0) => Boolean(units && run && spawnOne(SIZES[i] ?? SIZES[0])),
      pack: () => Boolean(units && run && spawnPack()),
      allyPack: () => Boolean(units && run && spawnPack('ally')),
      // волны и перевес: когда следующая волна каждой стороны, сколько осталось выпустить, живых, hpMul
      waves: () => {
        const sv = run?.surge;
        const side = (s) => s && { nextIn: +(s.next ?? 0).toFixed(1), size: s.size ?? 0, toSpawn: s.left, age: +(s.age ?? 0).toFixed(0), waveAlive: s.id ? aliveOf(s === sv.ally ? 'ally' : 'enemy', s.id) : 0, countered: Boolean(s.countered) };
        return { active: sv?.active ?? null, enemy: side(sv?.enemy), ally: side(sv?.ally), alive: { allies: momentum.allies, enemies: momentum.enemies }, hpMul: { allies: +momentum.hpAlly.toFixed(2), enemies: +momentum.hpEnemy.toFixed(2) } };
      },
      units: () => units,
      // поза поверх поведения на всех псов (проверка с ПК, не в шлеме): force({ rear: 1 }), force(null)
      force: (pose) => {
        forcePose = pose ?? null;
        return forcePose;
      },
      // роли и приёмы живых: { rusher, flanker, stalker, stalking, charging, rearing, prowling, braking, climbing, pouncing }
      kinds: () => {
        const r = { rusher: 0, flanker: 0, stalker: 0, stalking: 0, charging: 0, rearing: 0, prowling: 0, braking: 0, climbing: 0, pouncing: 0 };
        for (const u of units ?? []) {
          if (u.mode !== 'alive') continue;
          const d = u.dog;
          r[d.kind] = (r[d.kind] ?? 0) + 1;
          if (d.stalk > 0) r.stalking += 1;
          if (d.charge > 0) r.charging += 1;
          if (d.rear > 0.05) r.rearing += 1;
          if (d.prowl > 0.3) r.prowling += 1;
          if (d.brake > 0.3) r.braking += 1;
          if (d.climb) r.climbing += 1;
          if (d.leap?.pounce) r.pouncing += 1;
        }
        return r;
      },
      info: () =>
        run && {
          elapsed: +run.elapsed.toFixed(1),
          nextSpawn: +run.nextSpawn.toFixed(1),
          units: units?.map((u) => ({ mode: u.mode, hp: u.health, scale: u.scale, paint: u.dog.paint ?? 0, speed: +(u.dog.speed ?? 0).toFixed(2), state: u.dog.state, d: +Math.hypot(u.dog.x - head.x, u.dog.z - head.z).toFixed(1), jump: Boolean(u.dog.jump) })),
        },
    },
    dispose() {
      if (run && units) run.dogs = units.filter((u) => u.mode === 'alive').map((u) => ({ dog: { ...u.dog, jump: null, leap: null, paw: null, pawPose: null, climb: null, rear: 0, rearReach: 0 }, health: u.health }));
      teardown();
      shadowTexture.dispose();
      vignette.removeFromParent();
      vignette.geometry.dispose();
      vignette.material.dispose();
      vignetteTexture.dispose();
    },
  };
}
