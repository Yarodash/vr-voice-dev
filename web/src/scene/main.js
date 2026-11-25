// Сцена. Этот файл (и любые файлы рядом с ним) Claude меняет по голосовым командам;
// страница подхватывает изменения без перезагрузки и без выхода из VR.
//
// Контракт: setup(ctx) добавляет объекты в ctx.root и возвращает { update(dt), dispose(), onMenu }.
// Единицы — метры. Пол на высоте 0. Начало координат — центр игровой зоны, а не место, где
// стоит игрок: чтобы поставить что-то «перед игроком», бери положение и направление ctx.camera.
//
// Что тут: мир (world.js: земля, закатное небо, облака), оружие (pistols.js: пистолеты — модель
// pistol-model.js, и калаши — ak-model.js; его может быть сколько угодно), стрельба по мишеням
// (shooting.js, эффекты — effects.js, звук — sound.js), модель настоящего контроллера на руке,
// радиальное меню (menu.js). Пистолет стреляет по одному, калаш — очередью, пока зажат курок.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ControlMap } from './controls-map.js';
import { HUD_CONFIG } from './hud.js';
import { FIRE_MODE_PREFIX, DOGS_MENU, RESET_GUN_SIZES, EPOCH_PREFIX } from './menu.js';
import { STAGE_FROM, STAGE_NAMES, battleSeconds, setStage } from './progression.js';
import { buildMenu, SCENES_MENU, SAVE_NEW, CLEAR_ALL, SCENE_CONTINUE, SCENE_RESTART, RESET_SCORE, CAR_ENTER, CAR_EXIT } from './menu.js';
import { MY_DRONE_SPAWN, MY_DRONE_RECALL, MY_DRONE_REMOVE, MY_DRONE_SIZES, MY_DRONE_REGRIP, MY_DRONE_RELEASE, MY_DRONE_AUTOPILOT_ON, MY_DRONE_AUTOPILOT_OFF } from './menu.js';
import { EMPTY_FEATURES, freshOf, loadCompositions, migrateCarScene, migrateHordeScenes, migrateStandoffScene, nextName, readActive, saveCompositions, snapshot, storeCarPose, storeLive, writeActive } from './compositions.js';
import { createCar } from './car.js';
import { createRobodog } from './robodog.js';
import { createHorde } from './robodog-horde.js';
import { createDrones } from './drones.js';
import { createArtillery } from './artillery.js';
import { createCarDrive } from './car-drive.js';
import { createScore } from './score.js';
import { createCasings } from './casings.js';
import { createPistols } from './pistols.js';
import { GENERATED_GUNS, genKind, genKindByLabel, genGunParams, genEntry } from './generated-guns.js';
import { genGunDebug } from './generated-gun.js';
import { ensureWeaponEnv } from './weapon-env.js';
import { createSound, SOUND_VERSION } from './sound.js';
import { createShooting } from './shooting.js';
import { createMessageHoles } from './message-holes.js';
import { createCrackedGlasses } from './cracked-glasses.js';
import { createClays } from './clays.js';
import { createWorld } from './world.js';
import { createSunShadows } from './sun-shadows.js';
import { createAtmosphere } from './atmosphere.js';
import { createAtmosphereLight } from './atmosphere-light.js';
import { createFps, TARGET_HZ as FPS_TARGET_HZ } from './fps.js';
import { createLaser } from './laser.js';
import { createLaserPanel } from './laser-panel.js';
import { createIpd } from './ipd-panel.js';
import { createShake } from './shake.js';
import { createScopeLens } from './scope-lens.js';
import { createScopeDebug, SCOPE_DEBUG_REACH_M } from './scope-debug.js';
import { createInertia } from './inertia.js';
import { createTower } from './tower.js';
import { createWorldClock, FAST_FROM, FAST_HZ, STEP_S } from './world-clock.js';
import { createGunResize, resetGunScales } from './gun-resize.js';
import { createRayGrab } from './ray-grab.js';
import { createMyDrone } from './my-drone.js';
import { createBinoculars } from './binoculars.js';
import { createKillConfirm } from './kill-confirm.js';
import { createTestKit } from './test-kit.js';
import { createTwoHandAim } from './two-hand-aim.js';
import { BINO_SPAWN, BINO_REMOVE } from './menu.js';
import { SCOPE_MODE_PREFIX, ZOOM_PREFIX } from './menu.js';
import { ATMO_MENU, ATMO_WEATHER, ATMO_TIME, ATMO_SEASON, ATMO_SKY, ATMO_FLOW_PREFIX, ATMO_AUTO_PREFIX, ATMO_MARK } from './menu.js';
import { WEATHERS, TIMES, SEASONS, SKIES, FLOW_STEPS } from './atmosphere.js';
import { createWeatherSound } from './weather-sound.js';
import { createWeatherFx } from './weather-fx.js';

const GRIP_BUTTON = 1; // xr-standard gamepad: хват
const TRIGGER_BUTTON = 0; // курок
const X_BUTTON = 4; // X: заспавнить тарелку в руку
const REACH = 0.132; // метров от рукоятки пистолета до контроллера, чтобы взять

export function setup(ctx) {
  const { THREE, root, renderer, camera, scene } = ctx;
  const shared = (globalThis.__sceneState ??= {});
  // основная рука: 'left' | 'right' (оболочка, «Настройки ▸ Основная рука»; см. ниже у gripWorld)
  const primaryHand = () => (ctx.getPrimaryHand?.() === 'right' ? 'right' : 'left');
  // сценовые часы (мс): идут с замедлением времени; переживают подмену сцены. Читают и другие файлы
  shared.sceneNowMs ??= performance.now();
  const sceneNow = () => shared.sceneNowMs;
  // мир — по сценовым часам подшагами, игрок — по реальному времени (world-clock.js)
  const worldClock = createWorldClock(shared);
  const walkFwd = new THREE.Vector3(); // ходьба по вышке стиком
  let hzSession = null; // частота экрана под «Время» ×32/×64 (update)
  let hzAsked = 0;
  shared.worldClock = worldClock.state; // ручка для npm run vr:eval
  // атмосфера (atmosphere.js): погода, время суток, сезон, стиль неба — раньше мира и эффектов, они читают
  // shared.atmosphere.now; значения переживают подмену сцены (берутся из прежнего объекта)
  const atmosphere = createAtmosphere({ THREE, camera, shared });
  const SHOW_AXES = false; // нарисовать оси (красная, зелёная, синяя) на джойстике

  // Режим хвата (пункт меню, запоминается): 'toggle' — нажал хват, пистолет взят, нажал ещё раз —
  // отпущен; 'hold' — пистолет в руке, пока хват зажат.
  const GRIP_MODE_KEY = 'scene.gripMode';
  let gripMode = 'toggle';
  try {
    gripMode = localStorage.getItem(GRIP_MODE_KEY) === 'hold' ? 'hold' : 'toggle';
  } catch {
    // без хранилища: режим «нажать»
  }
  // Физика мишеней (пункт меню, запоминается): выкл — попадание не сбивает мишень (читает targets.js)
  const PHYSICS_KEY = 'scene.targetPhysics';
  try {
    shared.targetPhysics = localStorage.getItem(PHYSICS_KEY) !== 'off';
  } catch {
    shared.targetPhysics = true;
  }
  try {
    shared.aimOutline = localStorage.getItem('scene.aimOutline') !== 'off'; // обводка прицела на мишенях
  } catch {
    shared.aimOutline = true;
  }
  try {
    shared.laser = localStorage.getItem('scene.laser') === 'on'; // лазерный прицел (laser.js), по умолчанию выкл
  } catch {
    shared.laser = false;
  }
  try {
    shared.inertia = localStorage.getItem('scene.inertia') === 'on'; // «Инерция» (inertia.js), по умолчанию выкл
  } catch {
    shared.inertia = false;
  }
  try {
    shared.tracersOff = localStorage.getItem('scene.tracers') === 'off'; // «Трассеры», по умолчанию вкл
  } catch {
    shared.tracersOff = false;
  }
  try {
    shared.prone = localStorage.getItem('scene.prone') === 'on'; // «Режим лёжа», по умолчанию выкл
  } catch {
    shared.prone = false;
  }
  try {
    // «Прицел: аркадный / реалистичный» (scope-lens.js), по умолчанию аркадный ('2' — старое имя реалистичного)
    const saved = localStorage.getItem('scene.scopeMode');
    shared.scopeMode = saved === 'realistic' || saved === '2' ? 'realistic' : 'arcade';
  } catch {
    shared.scopeMode = shared.scopeMode === 'realistic' ? 'realistic' : 'arcade';
  }
  // «Режим лёжа»: оболочка центрирует на высоту глаз стоя (1,6 м); в режиме лёжа сцена сразу опускает
  // игрока (rig — родитель камеры) так, чтобы глаза были на PRONE_EYE_M над землёй, и сохраняет это в
  // 'vr.rig' (тот же формат, что у оболочки), чтобы перезагрузка не вернула стоячую высоту.
  const STANDING_EYE_M = 1.6;
  const PRONE_EYE_M = 0.35;
  const recenterPlayer = () => {
    if (typeof ctx.recenter !== 'function') {
      console.warn('[scene] ctx.recenter ещё нет в оболочке');
      return;
    }
    if (ctx.recenter() !== 'готово') return;
    const rig = ctx.camera.parent;
    if (shared.prone && rig) {
      rig.position.y -= STANDING_EYE_M - PRONE_EYE_M; // rig лежит прямо в сцене: сдвиг по Y мира
      try {
        localStorage.setItem('vr.rig', JSON.stringify({ p: rig.position.toArray(), q: rig.quaternion.toArray() }));
      } catch {
        // без хранилища не переживёт перезагрузку
      }
    }
    tower.afterRecenter(); // на вышке: вышка под голову, rig снова на её высоту (tower.js; с «Режимом лёжа» — лёжа на площадке)
  };
  // Сцены (compositions.js): активная задаёт, что есть в мире и в меню (features); список — для «Сцены ▸»
  let active = readActive(shared);
  if (migrateCarScene() && active.name === 'Сцена 2') active = writeActive(shared, active.name, { ...active.features, car: true });
  // счёт выключен везде, у «Сцены 1» нет робопса, появилась «Сцена 3» со стаей (compositions.js)
  if (migrateHordeScenes() && active.name) {
    const entry = loadCompositions().find((e) => e.name === active.name);
    if (entry) active = writeActive(shared, entry.name, entry.features);
  }
  migrateStandoffScene(); // появилась «Сцена 4» — армии стенка на стенку (compositions.js)
  let sceneNames = loadCompositions().map((entry) => entry.name);
  // «Кратность ×N» в меню оружия с прицелом: по кругу ZOOM_STEPS, своя у каждого вида, 'scene.zoom.<kind>'
  // (заданная — главнее кратности из кода: применяется к линзе каждый кадр, если отличается)
  const ZOOM_STEPS = [1.5, 2, 3, 4, 6, 8, 12];
  const heldLens = () => {
    try {
      return heldItem?.lens ?? heldItem?.model?.lens ?? null;
    } catch {
      return null; // меню строится в setup раньше, чем объявлен heldItem
    }
  };
  const zoomCache = {}; // kind → заданная кратность (0 — не задана)
  const zoomKey = (kind) => `scene.zoom.${kind}`;
  const savedZoom = (kind) => {
    try {
      const v = Number.parseFloat(localStorage.getItem(zoomKey(kind)));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  };
  const menuState = (heldKind = null) => ({
    holdingPistol: Boolean(heldKind),
    heldKind,
    gripMode,
    targetPhysics: shared.targetPhysics,
    aimOutline: shared.aimOutline,
    laser: shared.laser,
    features: active.features,
    scenes: sceneNames,
    car: active.features.car ? (shared.carSeat?.seated ? 'in' : 'out') : null, // «Сесть за руль» / «Выйти из машины»
    timeScale: shared.timeScale ?? 1,
    scopeDebug: Boolean(shared.scopeDebug), // «Отладка прицела: вкл/выкл» (у АВП в руке)
    inertia: Boolean(shared.inertia), // «Инерция: вкл/выкл» (Настройки)
    primaryHand: ctx.setPrimaryHand ? primaryHand() : null, // «Основная рука: левая / правая» (Настройки); null — оболочка не умеет
    prone: Boolean(shared.prone), // «Режим лёжа: вкл/выкл» (Настройки)
    fireMode: heldKind && GUNS[heldKind]?.auto ? 'auto' : 'semi', // «Режим: авто / полуавтомат» (generated-guns.js modes)
    tracersOff: Boolean(shared.tracersOff),
    shadows: sunShadows.enabled, // «Тени: вкл/выкл» (Настройки; sun-shadows.js)
    droneAutopilot: Boolean(shared.myDrone?.autopilot), // «Автопилот: вкл/выкл» (меню пульта) // «Трассеры: вкл/выкл» (Настройки; effects.js)
    shake: shared.shakeLevel ?? 1, // «Тряска: вкл / сильно / выкл» (Настройки; shake.js)
    allies: active.features.robodogHorde ? shared.allies !== false : null, // «Собаки ▸ Союзники» (robodog-horde.js)
    drones: active.features.robodogHorde ? shared.drones !== false : null, // «Собаки ▸ Квадрокоптеры» (drones.js)
    artillery: active.features.robodogHorde ? shared.artillery !== false : null, // «Собаки ▸ Артиллерия» (artillery.js)
    tower: Boolean(shared.towerOn), // «Вышка: вкл/выкл» (tower.js)
    scopeZoom: heldLens()?.magnification ?? null,
    scopeMode: shared.scopeMode, // «Прицел: аркадный / реалистичный» (Настройки, меню оружия с прицелом и бинокля; scope-lens.js)
    atmo: atmosphere.target, // «Погода и небо ▸»: что выбрано (atmosphere.js); пересборка меню — по atmosphere.rev
  });
  // тени псов и коптеров по солнцу (каскады карт силуэтов): до мира (земля и трава читают их uniforms)
  // и до стаи/коптеров (регистрируют отбрасыватели через shared.sunShadows)
  const sunShadows = createSunShadows({ THREE, renderer, camera, shared });
  shared.sunShadows = sunShadows;
  ctx.setMenu?.(buildMenu(menuState())); // меню (menu.js): меняется на лету
  ctx.setMapper?.(new ControlMap(() => ctx.menuOpen?.(), () => Boolean(shared.myDrone?.exists && shared.myDrone?.held && !ctx.menuOpen?.()), () => Boolean(shared.myDrone?.exists && shared.myDrone?.held), () => (primaryHand() === 'right' ? 3 : 12))); // какая кнопка что делает (controls-map.js): тоже на лету
  ctx.setHud?.(HUD_CONFIG); // окна сообщений и кружок-индикатор (hud.js): тоже на лету

  const world = createWorld({ THREE, scene, root, camera, renderer, sunShadow: sunShadows.uniforms });
  sunShadows.setSun(world.shadowSun);
  // свет атмосферы на предметах: светильники оболочки, туман сцены, экспозиция, сила теней (atmosphere-light.js)
  const atmosphereLight = createAtmosphereLight({ THREE, scene, root, renderer, shared, atmosphere, sunShadows });
  const fps = createFps({ THREE, camera, renderer, scene });
  // расстояние между глазами (Настройки ▸): сдвиг камер глаз + панель; после fps (оба оборачивают
  // scene.onBeforeRender), в dispose — до fps
  const ipd = createIpd({ THREE, renderer, scene, camera, root, shared });
  shared.ipd = ipd; // ручка для npm run vr:eval
  // тряска от выстрелов (shake.js): тоже оборачивает scene.onBeforeRender/onAfterRender — после ipd,
  // в dispose — до ipd; shared.screenShake(сила, dir) — для других систем
  const shake = createShake({ THREE, scene, camera, shared });
  // доска теста чёткости текста (text-test.js) спрятана: выбор сделан (вариант 3 → окна сообщений);
  // чтобы вернуть — createTextTest({ THREE, root, camera, renderer, shared }) из ./text-test.js
  const textTest = { held: false, update() {}, dispose() {} };
  ensureWeaponEnv(THREE, renderer); // карта окружения для металла оружия, один раз
  // подзорной трубы больше нет (убрана по просьбе); её сохранённое положение стирается один раз.
  // Оптика осталась в scope-lens.js (для прицела на АВП).
  try {
    localStorage.removeItem('scene.spyglass');
  } catch {
    // без хранилища и стирать нечего
  }
  delete shared.spyglassPose;
  delete shared.spyglass;
  // прицел АВП (awp-model.js): настоящая линза scope-lens.js, AWP_ZOOM×, дуплекс-сетка; настройки
  // бывшей подзорной трубы. Стик вверх/вниз, пока АВП в руке и меню закрыто, двигает прицел по планке
  // (AWP_SCOPE_SPEED м/с); положение общее для всех АВП и запоминается (scene.awp.scopeZ).
  const AWP_ZOOM = 2; // было 6 → 4 → 2: пользователь дважды просил слабее
  const AWP_SCOPE_SPEED = 0.07;
  const AWP_SCOPE_KEY = 'scene.awp.scopeZ';
  const makeAwpLens = (scope) => createScopeLens({
    THREE, renderer, scene, camera, magnification: scope.magnification ?? AWP_ZOOM, lensR: scope.lensR,
    eyeRelief: 0.07, tanApparent: scope.tanApparent ?? 0.39, size: 448, reticleStyle: scope.reticle ?? 'duplex', // «Калаш 2.0»: 4×, уголки
  });
  if (typeof shared.awpScopeZ !== 'number') {
    try {
      const saved = Number.parseFloat(localStorage.getItem(AWP_SCOPE_KEY));
      shared.awpScopeZ = Number.isFinite(saved) ? saved : null;
    } catch {
      shared.awpScopeZ = null; // по умолчанию — SCOPE_DEFAULT_Z модели
    }
  }
  // стик вверх/вниз слегка меняет УГОЛ прицела (наклон вверх/вниз, как пристрелка; по просьбе
  // пользователя; положение по планке он уже настроил — scene.awp.scopeZ больше не меняется):
  // наклон scene.awp.scopeTilt, радианы (+ — передний конец выше)
  const AWP_SCOPE_TILT_KEY = 'scene.awp.scopeTilt';
  const AWP_SCOPE_TILT_SPEED = 0.02; // рад/с при полном отклонении (≈ 1,1°/с)
  const AWP_SCOPE_TILT_MAX = 0.035; // ±2°
  if (typeof shared.awpScopeTilt !== 'number') {
    try {
      const saved = Number.parseFloat(localStorage.getItem(AWP_SCOPE_TILT_KEY));
      shared.awpScopeTilt = Number.isFinite(saved) ? saved : 0;
    } catch {
      shared.awpScopeTilt = 0;
    }
  }
  // у «Калаша 2.0» наклон свой: scene.ak2.scopeTilt (shared.ak2ScopeTilt); какой ключ у какого вида:
  const SCOPE_TILT = { awp: ['awpScopeTilt', AWP_SCOPE_TILT_KEY], ak2: ['ak2ScopeTilt', 'scene.ak2.scopeTilt'] };
  if (typeof shared.ak2ScopeTilt !== 'number') {
    try {
      const saved = Number.parseFloat(localStorage.getItem(SCOPE_TILT.ak2[1]));
      shared.ak2ScopeTilt = Number.isFinite(saved) ? saved : 0;
    } catch {
      shared.ak2ScopeTilt = 0;
    }
  }
  const scopeTilts = { awp: 0, ak2: 0 }; // каждый кадр → pistols.updateLenses
  // сгенерированные пушки с прицелом (generated-guns.js scope): свой наклон scene.gen.<id>.scopeTilt
  const genTilts = []; // [[kind, prop]]
  for (const g of GENERATED_GUNS) {
    if (!g.scope && !g.addScope) continue;
    const kind = genKind(g.id);
    const prop = `genScopeTilt:${g.id}`;
    SCOPE_TILT[kind] = [prop, `scene.gen.${g.id}.scopeTilt`];
    if (typeof shared[prop] !== 'number') {
      try {
        const saved = Number.parseFloat(localStorage.getItem(SCOPE_TILT[kind][1]));
        shared[prop] = Number.isFinite(saved) ? saved : 0;
      } catch {
        shared[prop] = 0;
      }
    }
    genTilts.push([kind, prop]);
  }
  shared.awpScopeY = 0; // прежний подъём по высоте отменён
  try { localStorage.removeItem('scene.awp.scopeY'); } catch { /* нет хранилища */ }
  let scopeSliding = false;
  const pistols = createPistols({ THREE, root, makeLens: makeAwpLens });
  // «Относительно схватить» издали: луч на оружие + хват (ray-grab.js)
  const rayGrab = createRayGrab({ THREE, root, camera });
  shared.rayGrab = rayGrab; // ручка для npm run vr:eval
  // панель отладки прицела (scope-debug.js): текстуры прицела АВП в руке (или первого с прицелом)
  const scopeDebug = createScopeDebug({
    THREE, root, camera, shared,
    getLens: () => (heldItem?.lens ?? pistols.items.find((item) => item.lens)?.lens ?? null),
  });
  const casings = createCasings({ THREE, root, shared });
  // звук (sound.js) живёт между подменами сцены; новая версия файла — новый объект (контекст тот же)
  if (shared.sound?.version !== SOUND_VERSION) shared.sound = createSound();
  const shooting = createShooting({ THREE, root, camera });
  const laser = createLaser({ THREE, root });
  const inertia = createInertia(THREE); // «Инерция»: фильтр позы руки (inertia.js)
  shared.inertiaDebug = { filter: inertia, make: (params) => createInertia(THREE, params) }; // ручка для npm run vr:eval
  const laserPanel = createLaserPanel({ THREE, renderer, camera, root, shared }); // «Цвет прицела»
  shared.laserPanel = laserPanel; // ручка для npm run vr:eval
  laser.setColor(shared.laserColor);
  shooting.setTargetsEnabled(active.features.targets); // до первого кадра: в сцене без мишеней они не встают
  const reloaded = { targets: !Array.isArray(shared.targetStands), score: !shared.score }; // страницу перезагрузили (не подмена сцены)
  const score = createScore({ THREE, camera, shared }); // счёт стрельбы (score.js) — функция сцены «score»
  score.setVisible(active.features.score);
  const messageHoles = createMessageHoles({ THREE, camera });
  const crackedGlasses = createCrackedGlasses({ THREE, camera, renderer, shared }); // выстрел себе в глаз (cracked-glasses.js)
  const weatherSound = createWeatherSound({ camera }); // звук погоды и природы (weather-sound.js): читает shared.atmosphere.now
  const weatherFx = createWeatherFx(ctx); // частицы погоды и молния (weather-fx.js): читает shared.atmosphere.now
  shared.crackedGlasses = { debug: (side = 'left') => crackedGlasses.trigger(side === 'right' ? 1 : 0) };
  // глиняные тарелки (clays.js): спавн в руку, хват как у оружия, курок — бросок взмахом
  const clays = createClays({ THREE, root, shooting, camera });
  shared.clayDebug = { clays, spawn: () => spawnClay() }; // ручка для npm run vr:eval
  let heldClay = clays.held(); // после подмены сцены тарелка остаётся в руке
  let nearClay = null;
  const clayHeld = new THREE.Matrix4(); // положение тарелки относительно руки
  const CLAY_OFFSET = new THREE.Vector3(0, 0.035, -0.1); // по осям джойстика: чуть выше и впереди

  // ---- Посадка пистолета в руку
  const HANDLE = new THREE.Vector3(0, -0.04, 0.045); // середина рукоятки (ладонь) в системе пистолета
  // «Размер» (меню оружия в руке): стик влево/вправо масштабирует оружие вокруг HANDLE (gun-resize.js)
  const gunResize = createGunResize({ THREE, root, handle: HANDLE });
  // Смещение пистолета в руке относительно осей джойстика: x — по красной, y — по синей, z — против
  // зелёной. Сейчас пистолет на 5 см ниже осей (против синей стрелки).
  const PISTOL_SHIFT = new THREE.Vector3(0, -0.05, 0);
  // Перенастройка осей (пункт меню, пока оружие в руке): оно замирает, джойстик ставят как
  // удобно, второй хват «приклеивает» его. Это положение относительно джойстика (calib) своё у
  // каждого вида оружия (все пистолеты — одно, все калаши — другое) и сохраняется; пока его нет,
  // оружие садится осями на оси джойстика.
  const CALIB_KEYS = { pistol: 'scene.pistol.calib', ak: 'scene.ak.calib', awp: 'scene.awp.calib', ak2: 'scene.ak.calib' }; // «Калаш 2.0» сидит в руке как калаш
  // сгенерированные пушки (generated-guns.js): своя посадка, а пока её нет — как у калаша (длинные)
  // или пистолета (короткие)
  for (const g of GENERATED_GUNS) CALIB_KEYS[genKind(g.id)] = g.calib ?? `scene.gen.${g.id}.calib`;
  const calibs = {};
  for (const [kind, key] of Object.entries(CALIB_KEYS)) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(saved) && saved.length === 16) calibs[kind] = new THREE.Matrix4().fromArray(saved);
    } catch {
      // нет сохранённого положения: оси на оси
    }
  }
  for (const g of GENERATED_GUNS) calibs[genKind(g.id)] ??= calibs[(g.length ?? 0) >= 0.45 ? 'ak' : 'pistol'];

  const held = new THREE.Matrix4(); // положение пистолета в руке относительно руки
  const heldToArray = () => held.toArray();
  const inHand = new THREE.Matrix4();
  const gripWorld = new THREE.Matrix4();
  const twoHandAim = createTwoHandAim(THREE); // курок второй руки — целиться двумя руками (two-hand-aim.js)
  // Основная рука («Настройки ▸ Основная рука»): ей держат оружие и предметы, на ней все кнопки;
  // ctx.getLeftController() отдаёт именно её (оболочка, localStorage 'vr.primaryHand'). Посадки в руке
  // («Перенастроить оси») хранятся для левой; в правой — зеркально: S·M·S, S = отражение по красной оси.
  const mirrorX = (m) => {
    const e = m.elements; // по столбцам: строка 0 — e[4], e[8], e[12]; столбец 0 — e[1], e[2], e[3]
    for (const i of [1, 2, 3, 4, 8, 12]) e[i] = -e[i];
    return m;
  };
  let lastPrimary = null;
  shared.twoHandAim = twoHandAim;
  const pistolWorld = new THREE.Matrix4();
  const unusedPosition = new THREE.Vector3();
  const unusedScale = new THREE.Vector3();
  const unusedQuaternion = new THREE.Quaternion();
  const handPosition = new THREE.Vector3();
  const palm = new THREE.Vector3();
  const seatM = new THREE.Matrix4(); // посадка вида в руке (поиск оружия рядом)

  let heldItem = null; // пистолет в руке
  let recalibratingItem = null; // пистолет, который замер для перенастройки
  let nearItem = null; // ближайший пистолет, который можно взять
  let releasedItem = null; // только что отпущенный: коротко вспыхивает обводка
  let releaseFlashUntil = 0;
  let gripWasDown = false;
  let menuWasOpen = false;
  let triggerWasDown = false;
  let xWasDown = true; // нажатая при подмене сцены X не спавнит
  const headForward = new THREE.Vector3();
  let menuKey = '';

  const restored = pistols.restore();
  if (restored.held >= 0 && pistols.items[restored.held] && restored.heldMatrix) {
    heldItem = pistols.items[restored.held];
    held.fromArray(restored.heldMatrix);
    gripWasDown = true; // хват уже зажат: заново «брать» не нужно
  }
  if (heldClay) gripWasDown = true;
  let savedHeld = heldItem; // с каким «в руке» положения сохранены последний раз (см. конец update)

  // ---- Левый контроллер, который виден в шлеме: настоящая модель Touch (стандартная фабрика three.js
  // берёт её по профилю контроллера). Модель переживает подмену сцены: без повторной загрузки.
  const factory = new XRControllerModelFactory(new GLTFLoader());
  let realModel = shared.realModel ?? null;
  let axes = null;
  const axesMatrix = new THREE.Matrix4();
  const AXES_RED_M = 0.003; // оси сдвинуты в сторону красной (метры)
  const AXES_LIFT_M = 0.025; // оси приподняты в сторону синей (метры)
  // оси провёрнуты на 40° вокруг красной (X): зелёная уходит вниз, синяя — от игрока
  const axesTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(-40));
  const AXIS_M = 0.05;
  const AXIS_THICK = 0.002;
  // Три оси: красная — вправо (+X), зелёная — вперёд (−Z), синяя — вверх (+Y). Не рисуются, но
  // от них считаются посадка пистолета, меню на плите джойстика и наведение.
  const buildAxes = () => {
    const group = new THREE.Group();
    const bar = (color, x, y, z) => {
      const size = [Math.abs(x) ? AXIS_M : AXIS_THICK, Math.abs(y) ? AXIS_M : AXIS_THICK, Math.abs(z) ? AXIS_M : AXIS_THICK];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color }));
      mesh.position.set((x * AXIS_M) / 2, (y * AXIS_M) / 2, (z * AXIS_M) / 2);
      group.add(mesh);
    };
    bar(0xef4444, 1, 0, 0);
    bar(0x22c55e, 0, 0, -1);
    bar(0x3b82f6, 0, 1, 0);
    return group;
  };
  // Объект луча того же контроллера, что и «рука» (three.js заполняет слоты в порядке подключения).
  const rayOf = (hand) => {
    for (const index of [0, 1]) {
      if (renderer.xr.getControllerGrip(index) === hand) return renderer.xr.getController(index);
    }
    return null;
  };
  const showController = (hand, source) => {
    // основная рука сменилась: модель и оси уходят со старой руки (модель каждой руки — своя, в кэше)
    if (realModel && realModel.parent !== hand) {
      realModel.parent?.remove(realModel);
      realModel = null;
      shared.realModel = null;
      if (axes) axes.parent?.remove(axes);
      axes = null;
    }
    const cachedModel = source && shared.realModels?.[source.handedness];
    if (!realModel && cachedModel) {
      realModel = cachedModel;
      hand.add(realModel);
      shared.realModel = realModel;
    }
    if (!realModel && source) {
      for (const old of hand.children.filter((child) => child.name.startsWith('scene-pad'))) hand.remove(old);
      realModel = factory.createControllerModel(hand);
      realModel.name = 'scene-pad-real';
      hand.add(realModel);
      shared.realModel = realModel;
      (shared.realModels ??= {})[source.handedness] = realModel;
      hand.dispatchEvent({ type: 'connected', data: source }); // «подключение» уже случилось до этой сцены
    }
    if (!axes && realModel) {
      axes = buildAxes();
      axes.name = 'scene-pad-axes';
      hand.add(axes);
      if (ctx.pointerAim) ctx.pointerAim.object = axes; // луч окон идёт по зелёной оси
    }
    const aimRay = rayOf(hand);
    if (axes && aimRay) {
      hand.updateWorldMatrix(true, false);
      aimRay.updateWorldMatrix(true, false);
      axesMatrix.copy(hand.matrixWorld).invert().multiply(aimRay.matrixWorld).decompose(unusedPosition, axes.quaternion, unusedScale);
      axes.quaternion.multiply(axesTurn);
      axes.position.set(AXES_RED_M, AXES_LIFT_M, 0).applyQuaternion(axes.quaternion);
    }
  };

  // Как оружие этого вида лежит в руке: перенастроенное положение, а если его нет, осями на оси
  // джойстика (рукоятка у пистолета и калаша в одной точке HANDLE).
  const heldOffset = (target, kind = 'pistol') => {
    const calib = calibs[kind];
    if (calib) {
      target.copy(calib);
      if (primaryHand() === 'right') mirrorX(target); // посадка записана для левой руки
      return;
    }
    if (axes) {
      axes.updateMatrix();
      target.copy(axes.matrix);
    } else {
      target.identity();
    }
    target.multiply(inHand.makeTranslation(PISTOL_SHIFT.x - HANDLE.x, PISTOL_SHIFT.y - HANDLE.y, PISTOL_SHIFT.z - HANDLE.z));
  };

  // Тарелка в руке: куполом вверх по синей оси, чуть впереди руки (без перенастройки)
  const clayOffset = (target) => {
    if (axes) {
      axes.updateMatrix();
      target.copy(axes.matrix);
    } else target.identity();
    target.multiply(inHand.makeTranslation(CLAY_OFFSET.x, CLAY_OFFSET.y, CLAY_OFFSET.z));
  };
  if (heldClay) clayOffset(clayHeld);

  const spawnClay = () => {
    const hand = ctx.getLeftController();
    if (hand && axes) {
      hand.updateWorldMatrix(true, false);
      clayOffset(pistolWorld);
      pistolWorld.premultiply(hand.matrixWorld).decompose(palm, unusedQuaternion, unusedScale);
    } else {
      const head = camera.getWorldPosition(palm);
      const direction = camera.getWorldDirection(unusedPosition);
      direction.y = 0;
      direction.normalize();
      head.addScaledVector(direction, 0.5);
      head.y -= 0.3;
      unusedQuaternion.identity();
    }
    clays.spawn(palm, unusedQuaternion);
  };

  const buzz = (source, strength = 0.4, ms = 40) => source?.gamepad?.hapticActuators?.[0]?.pulse?.(strength, ms);

  const putInFrontOfPlayer = (item) => {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const direction = camera.getWorldDirection(new THREE.Vector3());
    direction.y = 0;
    direction.normalize();
    item.group.position.copy(head).addScaledVector(direction, 0.55);
    item.group.position.y = head.y - 0.35;
    item.group.rotation.set(0, Math.atan2(-direction.x, -direction.z), 0); // стволом от игрока
  };

  // «Заспавнить пистолет» / «Заспавнить калаш»: каждый раз новый, прямо в руке (как удерживаемый,
  // но не прикреплён: хватом его потом берут). Руки не видно — перед игроком.
  const spawnWeapon = (kind) => {
    const item = pistols.add(null, kind);
    const hand = ctx.getLeftController();
    if (hand && axes) {
      hand.updateWorldMatrix(true, false);
      heldOffset(pistolWorld, kind);
      gunResize.apply(pistolWorld, kind); // свой «Размер» вида, рукоятка на месте
      pistolWorld.premultiply(hand.matrixWorld).decompose(item.group.position, item.group.quaternion, item.group.scale);
    } else {
      putInFrontOfPlayer(item);
    }
    pistols.save(heldItem, held.toArray(), true);
  };

  // spawnOnAdd (generated-guns.js): новая запись сама кладёт одну пушку перед игроком — боком,
  // стволом вправо, ~0,55 м перед головой — один раз на id+v (localStorage scene.gen.spawned.<id>.<v>)
  for (const g of GENERATED_GUNS) {
    if (!g.spawnOnAdd) continue;
    const key = `scene.gen.spawned.${g.id}.${g.v ?? 1}`;
    try {
      if (localStorage.getItem(key)) continue;
      localStorage.setItem(key, '1');
    } catch {
      continue; // без хранилища — не спавнить на каждой подмене
    }
    const item = pistols.add(null, genKind(g.id));
    putInFrontOfPlayer(item);
    item.group.rotation.y -= Math.PI / 2; // боком: картинкой к игроку, стволом вправо
    pistols.save(heldItem, held.toArray(), true);
  }

  const releasePistol = (source) => {
    releasedItem = heldItem;
    heldItem = null;
    buzz(source, 0.2, 90);
    releaseFlashUntil = performance.now() + 250;
  };

  // «Удалить пистолет»: тот, что в руке.
  const deleteHeld = () => {
    if (!heldItem) return;
    pistols.remove(heldItem);
    heldItem = null;
    pistols.save(null, held.toArray(), true);
  };

  // ---- Выстрел: луч от дула вдоль ствола, отдача стволом вверх
  const muzzleWorld = new THREE.Vector3();
  const aimMuzzle = new THREE.Vector3(); // для прицела (каждый кадр)
  const aimBarrel = new THREE.Vector3();
  const ejectWorld = new THREE.Vector3();
  const barrel = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  // У каждого вида своя стрельба: пистолет — по одному выстрелу на нажатие курка; калаш — очередь,
  // пока курок зажат (600 выстр./мин), отдача сильнее, а ствол от очереди понемногу задирается
  // (CLIMB_*) и, когда стрельба стихла, плавно возвращается.
  const GUNS = {
    pistol: { gapMs: 0, /* без ограничения темпа: сколько жмёшь, столько стреляет */ auto: false, kickMs: 140, kickRad: 0.2, kickBackM: 0, climbRad: 0, buzz: 0.8, speed: 360 /* м/с: пуля падает под гравитацией (shooting.js) */ },
    // у калаша по просьбе пользователя очень маленькая отдача: лёгкий толчок, почти без увода ствола
    ak: { gapMs: 100, auto: true, kickMs: 60, kickRad: 0.018, kickBackM: 0.004, climbRad: 0.005, buzz: 0.7, speed: 715 },
    // АВП: самозарядный (по просьбе пользователя) — выстрел на нажатие, не чаще раза в 170 мс; затвор
    // дёргается сам (awp-model.js); толчок назад и вверх сильный, но короткий — успеваешь на второй
    // выстрел; пуля на range м
    awp: { gapMs: 170, auto: false, kickMs: 220, kickRad: 0.13, kickBackM: 0.035, climbRad: 0, buzz: 1, buzzMs: 110, range: 400, big: 1.9, speed: 900 },
  };
  GUNS.ak2 = GUNS.ak; // «Калаш 2.0» стреляет как калаш
  for (const g of GENERATED_GUNS) GUNS[genKind(g.id)] = genGunParams(g); // шаблон GUN_AUTO/GUN_SEMI + поля записи
  const CLIMB_MAX_RAD = 0.2; // больше ствол от очереди не задирается
  const CLIMB_RECOVER = 4; // 1/с: как быстро задранный ствол возвращается
  let lastShotAt = -1e9; // реальное время последнего выстрела (отдача, вспышка)
  let lastShotGame = -1e9; // игровое (shared.sceneNowMs) — для темпа стрельбы
  // ---- заряд (gun.charge = { minS, maxS }, Космо-снайперка): курок держат — копится (РЕАЛЬНОЕ время,
  // рука не ускоряется), отпустили — выстрел силы 0..1 (shot.charge). Пока копится — растущая дыра у
  // дула и вой (shooting.chargeFx → blackhole.js), дрожь в руке крепнет; полный — толчок.
  let chargeS = -1; // < 0 — не копится
  let chargeBuzzIn = 0;
  let fireCharge = 0;
  const chargeStep = (source, gun, down, realDt) => {
    const c = gun.charge;
    if (down && chargeS < 0 && shared.sceneNowMs - lastShotGame >= gun.gapMs) {
      chargeS = 0;
      chargeBuzzIn = 0;
    }
    if (chargeS < 0) return;
    const level = Math.min(1, Math.max(0, (chargeS - (c.minS ?? 0.3)) / Math.max(0.1, (c.maxS ?? 3) - (c.minS ?? 0.3))));
    if (!down) {
      chargeS = -1;
      shooting.chargeFx?.(null);
      fireCharge = level;
      fire(source);
      fireCharge = 0;
      return;
    }
    chargeS += realDt;
    if (shooting.chargeFx?.(heldItem, level, chargeS)) buzz(source, 1, 140); // полный заряд
    else if ((chargeBuzzIn -= realDt) <= 0) {
      chargeBuzzIn = 0.09;
      buzz(source, 0.1 + 0.55 * level * level, 110);
    }
  };
  let lastGun = GUNS.pistol;
  let climb = 0; // накопленный подъём ствола, рад
  let climbYaw = 0; // и чуть вбок
  const kick = new THREE.Matrix4();
  const kickPivot = new THREE.Matrix4();
  const kickBack = new THREE.Matrix4();
  const kickEuler = new THREE.Euler();

  // Большая вспышка калаша: «звезда» пламени из трёх скрещённых плоскостей вдоль ствола и диск
  // поперёк — один меш, одна текстура; горит один кадр-два после выстрела. Обычная вспышка, искры
  // и дым из effects.js (через shooting.shoot) — сверх неё.
  const flash = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const g = canvas.getContext('2d');
    const glow = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    glow.addColorStop(0, 'rgba(255,255,235,1)');
    glow.addColorStop(0.18, 'rgba(255,215,120,0.95)');
    glow.addColorStop(0.45, 'rgba(255,130,30,0.55)');
    glow.addColorStop(1, 'rgba(255,80,0,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false, // светящееся (сложение): туман сцены не перекрашивает (atmosphere-light.js)
    });
    // плоскости вдоль ствола (−Z), начинаются у дула; и диск поперёк ствола у самого дула
    const planes = [];
    for (let i = 0; i < 3; i += 1) {
      const plane = new THREE.PlaneGeometry(0.11, 0.3);
      plane.rotateX(-Math.PI / 2);
      plane.translate(0, 0, -0.13);
      plane.rotateZ((i * Math.PI) / 3);
      planes.push(plane);
    }
    const disc = new THREE.PlaneGeometry(0.17, 0.17);
    disc.translate(0, 0, -0.01);
    planes.push(disc);
    const geometry = mergeGeometries(planes);
    planes.forEach((p) => p.dispose());
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.renderOrder = 2;
    root.add(mesh);
    return { mesh, texture, until: 0 };
  })();
  const flashOffset = new THREE.Vector3();

  // затвор дошёл назад: гильза вылетает из окна выброса (с учётом отката затвора)
  const ejectCasing = (item) => {
    if (GUNS[item.kind]?.projectile) return; // мана, чёрная дыра — без гильз
    item.group.updateWorldMatrix(true, false);
    ejectWorld.copy(item.ejector);
    if (item.slide) ejectWorld.z += item.slide.travel;
    ejectWorld.applyMatrix4(item.group.matrixWorld);
    right.set(1, 0, 0).transformDirection(item.group.matrixWorld);
    up.set(0, 1, 0).transformDirection(item.group.matrixWorld);
    barrel.set(0, 0, -1).transformDirection(item.group.matrixWorld);
    if (item.kind === 'awp') casings.eject(ejectWorld, right, up, barrel, 1.5, 2.4); // .338: толстая и длинная
    else casings.eject(ejectWorld, right, up, barrel, item.kind === 'ak' || item.kind === 'ak2' || Boolean(GUNS[item.kind]?.rifleCasing));
  };

  // Сам выстрел пушки kind (запись gun из GUNS) из from по dir — общий для курка (fire) и проверки
  // с ПК (test-kit.js fireGun): звук оружия, калибр, снаряд и его опции, автонаводка, заряд.
  const shootGun = (kind, gun, from, dir, onResult = null, casing = null) => {
    shared.sound?.setWeapon?.(gun.sound ?? (kind === 'ak2' ? 'ak' : kind)); // shooting.shoot звучит выбранным оружием
    shared.shotKind = gun.shotKind ?? kind; // калибр для целей (робопсы: как сильно отбрасывает и звенит)
    // projectile: 'mana' — мана-снаряд (mana.js): своя вспышка и попадание, без гильзы и дыма
    // projectileOpts — настройки снаряда-модуля из записи оружия (projectiles/*), доходят до mod.fire как есть
    const shot = { speed: gun.speed, onResult, projectile: gun.projectile ?? null, color: gun.projectileColor ?? null, gravity: gun.gravity ?? null, projectileOpts: gun.projectileOpts ?? null };
    if (gun.big) shot.big = true;
    else if (casing) Object.assign(shot, casing); // дым из окна выброса: { ejector, right, up }
    // автонаводка (gun.autoAim°): пуля — в лучшую цель конуса, с поправкой на падение (shooting.js);
    // с gun.homing — вылетает вдоль ствола и доворачивает к цели по дуге (самонаведение)
    if (gun.homing && gun.autoAim > 0) Object.assign(shot, { homing: gun.homing, autoAimDeg: gun.autoAim });
    if (gun.charge) shot.charge = fireCharge; // сила заряда 0..1 (chargeStep)
    shooting.shoot(from, (!shot.homing && gun.autoAim > 0 && shooting.autoAim?.(from, dir, gun.autoAim, gun.speed, shot.gravity, shot.projectile)) || dir, shot);
  };

  const fire = (source) => {
    // Темп стрельбы — по ИГРОВОМУ времени (пользователь: «скорострельность должна соответствовать
    // скорости игры»): на ×4 калаш стреляет вчетверо чаще (но не больше раза за кадр), на ×0,25 — реже.
    // Отдача, вспышка, затвор — по реальному (lastShotAt), рука игрока не ускоряется.
    const now = performance.now();
    const gameNow = shared.sceneNowMs;
    if (!heldItem) return;
    const gun = GUNS[heldItem.kind] ?? GUNS.pistol;
    if (gameNow - lastShotGame < gun.gapMs) return;
    // очередь идёт ровно в темпе, а не «как получилось по кадрам»
    lastShotGame = gun.auto && gameNow - lastShotGame < gun.gapMs * 2 ? lastShotGame + gun.gapMs : gameNow;
    lastShotAt = now;
    lastGun = gun;
    if (gun.climbRad) {
      climb = Math.min(CLIMB_MAX_RAD, climb + gun.climbRad * (0.8 + Math.random() * 0.4));
      climbYaw = THREE.MathUtils.clamp(climbYaw + (Math.random() - 0.45) * gun.climbRad * 0.5, -0.06, 0.06);
    }
    const { group } = heldItem;
    group.updateWorldMatrix(true, false);
    muzzleWorld.copy(heldItem.muzzle).applyMatrix4(group.matrixWorld);
    ejectWorld.copy(heldItem.ejector).applyMatrix4(group.matrixWorld);
    barrel.set(0, 0, -1).transformDirection(group.matrixWorld);
    right.set(1, 0, 0).transformDirection(group.matrixWorld);
    up.set(0, 1, 0).transformDirection(group.matrixWorld);
    messageHoles.hit(muzzleWorld, barrel);
    const eyeHit = crackedGlasses.test(muzzleWorld, barrel);
    if (eyeHit >= 0) { crackedGlasses.trigger(eyeHit); buzz(source, 1, 300); }
    if (laserPanel.isOpen) {
      laserPanel.cast(muzzleWorld, barrel); // выстрел в плашку выбирает цвет (laser-panel.js)
      laserPanel.shoot(source);
    }
    pistols.kick(heldItem);
    // у AWP затвор при выстреле закрыт: дыма из окна выброса нет (гильза — при ходе затвора назад)
    // пуля летит с гравитацией (shooting.js): попала или нет — узнаём, когда долетит (onResult)
    // выстрел в панель выбора цвета — не игра: очки не меняет
    const scored = active.features.score && !laserPanel.isOpen;
    const onResult = (hit) => {
      // hit === null — попал во что-то не в счёт (лежащий робопёс): ни очков, ни штрафа
      if (scored && hit !== null) score.shot(hit); // попал в мишень, тарелку или робопса — очки, иначе −20
      if (hit && source) buzz(source, 0.95, 50); // попадание отдаётся в руку, когда пуля долетела
    };
    shootGun(heldItem.kind, gun, muzzleWorld, barrel, onResult, gun.big || gun.projectile ? null : { ejector: ejectWorld, right, up });
    buzz(source, gun.buzz, gun.buzzMs ?? 60);
    shake.kick(heldItem.kind, gun); // лёгкий толчок вида (shake.js)
    if ((heldItem.kind === 'ak' || heldItem.kind === 'ak2' || gun.big || gun.flash) && !gun.projectile) {
      const big = gun.big ?? 1; // AWP: вспышка крупнее и дольше
      flash.until = now + 45 * (big > 1 ? 1.6 : 1);
      flash.mesh.userData.item = heldItem;
      flash.mesh.scale.set((0.8 + Math.random() * 0.5) * big, (0.8 + Math.random() * 0.5) * big, (0.75 + Math.random() * 0.6) * big);
      flash.mesh.scale.multiplyScalar(group.scale.x); // «Размер» оружия (gun-resize.js)
      flash.mesh.userData.spin = Math.random() * Math.PI;
    }
  };

  // ручка для npm run vr:eval: выстрелить из оружия номер index (как будто оно в руке) или убрать его;
  // spawn(kind) — как пункт меню; gen() — что разобрано из картинок сгенерированных пушек
  shared.weaponDebug = {
    spawn: (kind) => spawnWeapon(kind),
    items: () => pistols.items,
    gen: () => genGunDebug(),
    fire(index) {
      const keep = heldItem;
      heldItem = pistols.items[index] ?? null;
      fire(null);
      heldItem = keep;
    },
    remove(index) {
      const item = pistols.items[index];
      if (!item || item === heldItem) return false;
      pistols.remove(item);
      pistols.save(heldItem, held.toArray(), true);
      return true;
    },
  };
  // приёмка выстрела с ПК (test-kit.js, npm run test:shot): только десктоп, в шлеме — null
  const testKit = (shared.testKit = createTestKit({
    THREE, camera, shared, shooting, guns: GUNS, shootGun,
    kindOf: (id) => (Object.hasOwn(GUNS, id) ? id : Object.hasOwn(GUNS, genKind(id)) ? genKind(id) : null),
  }));

  // ---- Сцены (compositions.js): вернуть сохранённый мир или очистить его — на лету, без перезагрузки.
  // data: снимок (snapshot) или null — пустое поле; features: что есть в сцене (мишени, спавн, X, счёт).
  const car = createCar({ THREE, root, camera }); // машина (car.js) — функция сцены «car»
  shared.car = car; // ручка для npm run vr:eval
  const carDrive = createCarDrive({ THREE, camera, car, shared }); // за рулём (car-drive.js)
  shared.carDrive = carDrive; // ручка для npm run vr:eval
  const applyCar = (data, features) => {
    const placed = car.apply(Boolean(features.car), data?.car);
    if (placed && active.name) storeCarPose(active.name, placed); // поставили впервые — запомнить в сцене
  };
  // робопёс (robodog.js) — функция сцены «robodog»: бегает по полю, в него можно стрелять; убил —
  // +500 к счёту (чуть позже, чтобы табличка успела показать очки за сам выстрел)
  let disposed = false;
  const KILL_BONUS = 500;
  const robodog = createRobodog({
    THREE, root, camera, renderer, shooting,
    onKill: () => setTimeout(() => {
      if (!disposed && active.features.score) score.bonus(KILL_BONUS);
    }, 450),
  });
  shared.robodog = robodog; // ручка для npm run vr:eval (robodog.debug)
  // стая робопсов (robodog-horde.js) — функция сцены «robodogHorde» («Сцена 3»): бегут на игрока и
  // прыгают; достал — красная вспышка (в horde), удар и сильная вибрация левого джойстика
  let padSource = null; // левый контроллер этого кадра (для вибрации)
  const horde = createHorde({
    THREE, root, camera, renderer, shooting,
    onPlayerHit: () => buzz(padSource, 1, 250),
  });
  shared.horde = horde; // ручка для npm run vr:eval (horde.debug.info())
  // квадрокоптеры с пулемётами (drones.js) — в той же битве («robodogHorde»), «Собаки ▸ Квадрокоптеры»
  const drones = createDrones({ THREE, root, camera, renderer, shooting, horde });
  // «Мой дрон» + пульт с экраном камеры (my-drone.js): никто в него не стреляет, бессмертный
  const myDrone = createMyDrone({ THREE, root, scene: ctx.scene, camera, renderer, shooting });
  const binoculars = createBinoculars({ THREE, root, scene: ctx.scene, camera, renderer }); // «Заспавнить ▸ Бинокль» (binoculars.js)
  const killConfirm = createKillConfirm({ THREE, root, camera }); // убил игрок — «клац» + крест-хитмаркер (kill-confirm.js, shared.killConfirm)
  const rayItems = []; // что можно взять лучом: оружие + бинокль (ray-grab.js), без выделений в кадре
  shared.droneSystem = drones; // ручка для npm run vr:eval (droneSystem.debug.info())
  // артиллерия (artillery.js) — в той же битве («robodogHorde»), «Собаки ▸ Артиллерия»; ручка shared.artillerySystem
  const artillery = createArtillery({ THREE, root, camera, horde });
  // вышка (tower.js): «Вышка: вкл/выкл» — игрок на площадке TOWER_H м, shared.playerElevation для стаи
  const tower = createTower({ THREE, root, camera, shared });
  // «Сцена 4» (armyStandoff): бой всегда на последней эпохе («Конец 4») — с её начала или дальше
  const battleOf = (data, features) => (features.armyStandoff ? Math.max(STAGE_FROM[STAGE_FROM.length - 1], data?.battleS ?? 0) : data?.battleS ?? 0);
  const applyScene = (data, features) => {
    applyCar(data, features);
    robodog.apply(features.robodog, data?.robodog);
    horde.apply(features.robodogHorde, { battleS: battleOf(data, features), standoff: features.armyStandoff }); // «Рестарт» и «Продолжить» — стая заново (стадия боя — из data)
    drones.apply(features.robodogHorde); // и квадрокоптеры
    artillery.apply(features.robodogHorde); // и артиллерия
    heldItem = recalibratingItem = nearItem = releasedItem = null;
    heldClay = nearClay = null;
    for (const item of [...pistols.items]) pistols.remove(item);
    for (const weapon of data?.weapons ?? []) pistols.add(weapon, weapon.kind);
    pistols.save(null, held.toArray(), true);
    savedHeld = null;
    clays.setAll(data?.clays ?? []);
    shooting.setTargets(features.targets ? (data?.targets ?? {}) : null);
    score.set(data?.score);
    score.setVisible(features.score);
  };
  // Последнее состояние активной сцены (live, для «Продолжить» и перезагрузки): раз в LIVE_EVERY_S,
  // при подмене сцены, уходе со страницы и перед переключением на другую сцену. Пишется, только
  // если что-то поменялось.
  const LIVE_EVERY_S = 3;
  let lastLive = '';
  let liveLeft = LIVE_EVERY_S;
  const saveLive = () => {
    if (!active.name) return;
    const json = JSON.stringify(scenes.snapshot());
    if (json !== lastLive && storeLive(active.name, json)) lastLive = json;
  };
  const onPageHide = () => {
    if (document.visibilityState !== 'visible') saveLive();
  };
  window.addEventListener('pagehide', saveLive);
  document.addEventListener('visibilitychange', onPageHide);
  const scenes = {
    list: () => loadCompositions(),
    active: () => active,
    // battleS — возраст боя стаи (стадия, progression.js), с точностью до 10 с: «Продолжить» и
    // перезагрузка продолжают стадию, «Рестарт» (freshOf) — с нуля
    snapshot: () => {
      const s = snapshot({ pistols, clays, shooting, score, car, robodog });
      if (active.features.robodogHorde && shared.battleStartMs != null) s.battleS = Math.floor(battleSeconds(shared) / 10) * 10;
      return s;
    },
    saveLive,
    // текущий мир — новая сцена (с режимом активной); она же становится активной
    saveNew(name) {
      saveLive();
      const list = loadCompositions();
      const data = scenes.snapshot();
      const entry = { name: name ?? nextName(list), savedAt: new Date().toISOString(), features: { ...active.features }, data, live: data };
      list.push(entry);
      if (!saveCompositions(list)) return null;
      sceneNames = list.map((e) => e.name);
      active = writeActive(shared, entry.name, entry.features);
      lastLive = '';
      menuKey = '';
      return entry.name;
    },
    // mode: 'continue' — как было (live), 'restart' — заново (freshOf: мишени стоят, счёт 0)
    restore(name, mode = 'continue') {
      saveLive(); // уходящая сцена запоминает, где остановились
      const entry = loadCompositions().find((e) => e.name === name);
      if (!entry) return false;
      active = writeActive(shared, entry.name, entry.features);
      applyScene(mode === 'restart' ? freshOf(entry.data) : entry.live ?? entry.data, active.features);
      lastLive = '';
      saveLive();
      menuKey = '';
      return true;
    },
    clear() {
      saveLive();
      active = writeActive(shared, null, EMPTY_FEATURES);
      applyScene(null, active.features);
      lastLive = '';
      menuKey = '';
      return true;
    },
  };
  shared.scenes = scenes; // ручка для npm run vr:eval
  // после перезагрузки страницы активная сцена продолжается, как была: мишени (с дырками) и счёт —
  // из её live (оружие и тарелки сохраняют себя сами)
  if (reloaded.targets || reloaded.score) {
    const entry = active.name ? loadCompositions().find((e) => e.name === active.name) : null;
    const live = entry?.live ?? entry?.data;
    if (live && reloaded.targets && active.features.targets && live.targets) shooting.setTargets(live.targets);
    if (live && reloaded.score) score.set(live.score);
  }
  {
    // машина — при каждой загрузке сцены (и после подмены файла сцены)
    const entry = active.name ? loadCompositions().find((e) => e.name === active.name) : null;
    applyCar(entry?.live?.car ? entry.live : entry?.data, active.features);
    // робопёс: после подмены файла сцены — где был; после перезагрузки — жив/мёртв из live
    robodog.apply(active.features.robodog, (entry?.live ?? entry?.data)?.robodog, { keep: true });
    horde.apply(active.features.robodogHorde, { keep: true, battleS: battleOf(entry?.live ?? entry?.data, active.features), standoff: active.features.armyStandoff });
    drones.apply(active.features.robodogHorde, { keep: true });
    artillery.apply(active.features.robodogHorde);
  }

  // вспышка калаша — у дула того, кто стрелял (положение — после отдачи этого кадра)
  const placeFlash = () => {
    const item = flash.mesh.userData.item;
    const visible = performance.now() < flash.until && item && pistols.items.includes(item);
    flash.mesh.visible = Boolean(visible);
    if (!visible) return;
    item.group.updateWorldMatrix(true, false);
    flash.mesh.position.copy(flashOffset.copy(item.muzzle).applyMatrix4(item.group.matrixWorld));
    flash.mesh.quaternion.copy(item.group.quaternion);
    flash.mesh.rotateZ(flash.mesh.userData.spin);
  };

  // Оранжевая деталь светится у пистолета, который в руке или рядом; белая обводка — у того, что
  // можно взять, у замершего для перенастройки и коротко у только что отпущенного.
  const paintPistols = () => {
    const now = performance.now();
    for (const item of pistols.items) {
      const active = item === heldItem || item === nearItem || item === recalibratingItem || item === rayGrab.target || item === rayGrab.item;
      item.accent.emissive.set(active ? 0x14161a : 0x000000); // спуск тёмный: свечение еле заметное
      item.outline.visible =
        // замершее для перенастройки — без обводки: оно полупрозрачное (gun-resize.js), белая кайма просвечивала бы
        (item === nearItem && !heldItem && item !== recalibratingItem) || (item === releasedItem && now < releaseFlashUntil) ||
        item === rayGrab.target || item === rayGrab.item; // луч на оружии / держим лучом
      // голубая — в досягаемости руки (хват возьмёт сейчас; главнее луча), белая — луч и остальное
      if (item.outline.visible) pistols.tintOutline(item, item === nearItem && !heldItem);
    }
  };

  // туман и свет атмосферы — всему, что создано выше (atmosphere-light.js): в самом конце setup, чтобы
  // оболочка дособрала новые программы в фоне подмены, а не рывком в первом кадре
  atmosphereLight.adopt();

  return {
    // Выбран пункт радиального меню: { path, label }
    onMenu(picked) {
      if (picked.path?.[0] === ATMO_MENU) {
        // «Погода и небо ▸ …» (atmosphere.js): переходы плавные, выбор сохраняется в 'scene.atmo'
        const name = picked.label.startsWith(ATMO_MARK) ? picked.label.slice(ATMO_MARK.length) : picked.label;
        const byName = (list) => list.find((e) => e.name === name)?.id;
        const kind = picked.path[1];
        if (picked.label.startsWith(ATMO_FLOW_PREFIX)) atmosphere.setFlow(FLOW_STEPS[(FLOW_STEPS.indexOf(atmosphere.target.flow) + 1) % FLOW_STEPS.length]);
        else if (picked.label.startsWith(ATMO_AUTO_PREFIX)) atmosphere.setAutoWeather(!atmosphere.target.auto);
        else if (kind === ATMO_WEATHER && byName(WEATHERS)) atmosphere.setWeather(byName(WEATHERS));
        else if (kind === ATMO_TIME && byName(TIMES)) atmosphere.setTime(byName(TIMES));
        else if (kind === ATMO_SEASON && byName(SEASONS)) atmosphere.setSeason(byName(SEASONS));
        else if (kind === ATMO_SKY && byName(SKIES)) atmosphere.setSky(byName(SKIES));
        else console.warn(`[atmo] непонятный пункт меню: ${picked.path.join(' > ')}`);
        const t = atmosphere.target;
        console.log(`[atmo] ${t.weather} / ${t.time} / ${t.season} / ${t.sky} / течение ${t.flow} мин / авто ${t.auto ? 'вкл' : 'выкл'}`);
        menuKey = null;
        return;
      }
      // бинокль (binoculars.js): «Перенастроить хват» у него та же подпись, что у пульта дрона
      if (binoculars.held && picked.label === MY_DRONE_REGRIP) return binoculars.regrip();
      if (picked.label === BINO_REMOVE) return binoculars.remove();
      if (picked.label === BINO_SPAWN) return binoculars.spawn();
      if (picked.label.startsWith('Вышка:')) {
        tower.toggle(); // rig вверх/вниз на высоту вышки (tower.js)
        menuKey = null;
        return;
      }
      if (picked.label.startsWith('Артиллерия:')) {
        // «Собаки ▸ Артиллерия: вкл/выкл» — artillery.js сам читает shared.artillery
        shared.artillery = shared.artillery === false;
        try {
          localStorage.setItem('scene.artillery', shared.artillery ? 'on' : 'off');
        } catch {
          // не сохранится — не беда
        }
        menuKey = null;
        return;
      }
      if (picked.label.startsWith('Квадрокоптеры:')) {
        // «Собаки ▸ Квадрокоптеры: вкл/выкл» — drones.js сам читает shared.drones
        shared.drones = shared.drones === false;
        try {
          localStorage.setItem('scene.drones', shared.drones ? 'on' : 'off');
        } catch {
          // не сохранится — не беда
        }
        menuKey = null;
        return;
      }
      if (picked.path?.[0] === DOGS_MENU) {
        // «Собаки ▸ Союзники: вкл/выкл» — стая сама читает shared.allies (robodog-horde.js)
        shared.allies = shared.allies === false;
        try {
          localStorage.setItem('scene.allies', shared.allies ? 'on' : 'off');
        } catch {
          // не сохранится — не беда
        }
        menuKey = null;
        return;
      }
      if (picked.path?.[0] === SCENES_MENU) {
        if (picked.label === SAVE_NEW) console.log(`[scenes] сохранена: ${scenes.saveNew()}`);
        else if (picked.label === CLEAR_ALL) scenes.clear();
        else if (picked.label === SCENE_CONTINUE || picked.label === SCENE_RESTART) {
          // путь: ['Сцены', '<имя сцены>', 'Продолжить' | 'Рестарт']
          const name = picked.path[1];
          if (!scenes.restore(name, picked.label === SCENE_RESTART ? 'restart' : 'continue')) console.warn(`[scenes] нет сцены «${name}»`);
        }
      } else if (picked.label === CAR_ENTER) {
        if (!carDrive.enter()) console.warn('[car] сесть не вышло: нет машины или rig');
      } else if (picked.label === CAR_EXIT) {
        carDrive.exit();
      } else if (picked.label === RESET_SCORE) {
        score.reset();
      } else if (picked.label === 'Заспавнить пистолет') {
        spawnWeapon('pistol');
      } else if (picked.label === 'Заспавнить калаш') {
        spawnWeapon('ak');
      } else if (picked.label === 'Заспавнить калаш 2.0') {
        spawnWeapon('ak2');
      } else if (picked.label === 'Заспавнить АВП') {
        spawnWeapon('awp');
      } else if (genKindByLabel(picked.label)) {
        spawnWeapon(genKindByLabel(picked.label)); // «Заспавнить <name>» (generated-guns.js)
      } else if (picked.path?.includes(MY_DRONE_SPAWN) && MY_DRONE_SIZES.includes(picked.label)) {
        myDrone.spawn(MY_DRONE_SIZES.indexOf(picked.label)); // «Мой дрон ▸ <размер>»: заменяет прежний; пульт — перед игроком (my-drone.js)
      } else if (picked.label === MY_DRONE_RECALL) {
        myDrone.recall();
      } else if (picked.label === MY_DRONE_AUTOPILOT_ON || picked.label === MY_DRONE_AUTOPILOT_OFF) {
        myDrone.toggleAutopilot(); // дрон сам воюет в рою союзников (my-drone.js)
        menuKey = null;
      } else if (picked.label === MY_DRONE_REGRIP) {
        myDrone.regrip(); // пульт замер; следующий хват рядом — новая посадка (my-drone.js)
      } else if (picked.label === MY_DRONE_RELEASE) {
        myDrone.release();
      } else if (picked.label === MY_DRONE_REMOVE) {
        myDrone.remove();
      } else if (picked.label === 'Заспавнить тарелку') {
        spawnClay();

      } else if (picked.label === 'Удалить тарелку' && heldClay) {
        clays.remove(heldClay);
        heldClay = null;
      } else if (picked.label.startsWith(FIRE_MODE_PREFIX) && heldItem && genEntry(heldItem.kind)) {
        // режим огня сгенерированной пушки: очередь ↔ по выстрелу на нажатие (темп тот же)
        const gun = GUNS[heldItem.kind];
        gun.auto = !gun.auto;
        try {
          localStorage.setItem(`scene.gen.${genEntry(heldItem.kind).id}.mode`, gun.auto ? 'auto' : 'semi');
        } catch {
          // без хранилища не переживёт перезагрузку
        }
      } else if (picked.label.startsWith('Хват:')) {
        gripMode = gripMode === 'toggle' ? 'hold' : 'toggle';
        try {
          localStorage.setItem(GRIP_MODE_KEY, gripMode);
        } catch {
          // без хранилища режим не переживёт перезапуск
        }
      } else if (picked.label.startsWith('Физика мишеней:')) {
        shared.targetPhysics = !shared.targetPhysics;
        try {
          localStorage.setItem(PHYSICS_KEY, shared.targetPhysics ? 'on' : 'off');
        } catch {
          // без хранилища не переживёт перезапуск
        }
      } else if (picked.label.startsWith('Обводка прицела:')) {
        shared.aimOutline = !shared.aimOutline;
        try {
          localStorage.setItem('scene.aimOutline', shared.aimOutline ? 'on' : 'off');
        } catch {
          // без хранилища не переживёт перезапуск
        }
      } else if (picked.label.startsWith('Лазерный прицел:')) {
        shared.laser = !shared.laser;
        try {
          localStorage.setItem('scene.laser', shared.laser ? 'on' : 'off');
        } catch {
          // без хранилища не переживёт перезапуск
        }
      } else if (picked.label.startsWith('Отладка прицела')) {
        shared.scopeDebug = !shared.scopeDebug; // панель scope-debug.js встаёт перед головой при включении
      } else if (picked.label === 'Цвет прицела') {
        if (heldItem) laserPanel.open();
      } else if (picked.label === 'Зареспавнить мишени') {
        shooting.respawnTargets();
      } else if (picked.label.startsWith('Основная рука:')) {
        ctx.setPrimaryHand?.(primaryHand() === 'right' ? 'left' : 'right'); // оболочка: кнопки, луч, меню; localStorage 'vr.primaryHand'
        console.log(`[hand] основная рука: ${primaryHand()}`);
        menuKey = null;
      } else if (picked.label.startsWith('Инерция:')) {
        shared.inertia = !shared.inertia; // гасит дрожание руки (inertia.js)
        try {
          localStorage.setItem('scene.inertia', shared.inertia ? 'on' : 'off');
        } catch {
          // без хранилища не переживёт перезагрузку
        }
      } else if (picked.label.startsWith('Время:')) {
        // замедление времени: 1 → 0,5 → 0,25 → 1 (живёт до перезагрузки страницы)
        // ×1 → ×2 → … → ×64 (ускорение) → ×0,25 → ×0,5 (замедление) → ×1
        const next = { 1: 2, 2: 4, 4: 8, 8: 16, 16: 32, 32: 64, 64: 0.25, 0.25: 0.5, 0.5: 1 };
        shared.timeScale = next[shared.timeScale ?? 1] ?? 1;
        console.log(`[time] ×${shared.timeScale}`);
      } else if (picked.label === 'Отцентрировать') {
        recenterPlayer(); // в «Режиме лёжа» — глаза в ~35 см над землёй
        if (carDrive.seated) carDrive.enter(); // за рулём: голова снова на месте водителя
      } else if (picked.label.startsWith('Тряска:')) {
        shake.cycle(); // вкл → сильно → выкл → вкл (localStorage 'scene.shake')
        menuKey = null;
      } else if (picked.label.startsWith(ZOOM_PREFIX)) {
        const lens = heldLens();
        if (lens && heldItem) {
          const cur = lens.magnification;
          const next = ZOOM_STEPS.find((z) => z > cur + 1e-3) ?? ZOOM_STEPS[0];
          lens.setMagnification(next);
          zoomCache[heldItem.kind] = next;
          try {
            localStorage.setItem(zoomKey(heldItem.kind), String(next));
          } catch {
            // без хранилища — до перезагрузки
          }
          menuKey = null; // подпись «Кратность ×N» сразу новая
        }
      } else if (picked.label.startsWith(SCOPE_MODE_PREFIX)) {
        shared.scopeMode = shared.scopeMode === 'realistic' ? 'arcade' : 'realistic'; // все прицелы и бинокль (scope-lens.js) — со следующего кадра
        try {
          localStorage.setItem('scene.scopeMode', shared.scopeMode);
        } catch {
          // без хранилища не переживёт перезагрузку
        }
        console.log(`[scope] режим ${shared.scopeMode}`);
        menuKey = null;
      } else if (picked.label.startsWith('Тени:')) {
        sunShadows.enabled = !sunShadows.enabled; // сам пишет localStorage 'scene.sunShadows'
        console.log(`[shadows] ${sunShadows.enabled ? 'вкл' : 'выкл'}`);
        menuKey = null;
      } else if (picked.label.startsWith('Трассеры:')) {
        shared.tracersOff = !shared.tracersOff; // effects.tracer() не запускает трассер
        try {
          localStorage.setItem('scene.tracers', shared.tracersOff ? 'off' : 'on');
        } catch {
          // без хранилища не переживёт перезагрузку
        }
        menuKey = null;
      } else if (picked.label.startsWith('Режим лёжа:')) {
        // переключение сразу центрирует: лёг и включил — уже лежишь на земле; выключил — снова стоишь
        shared.prone = !shared.prone;
        try {
          localStorage.setItem('scene.prone', shared.prone ? 'on' : 'off');
        } catch {
          // без хранилища не переживёт перезагрузку
        }
        recenterPlayer();
        menuKey = null;
      } else if (picked.label.startsWith(EPOCH_PREFIX)) {
        // стадия боя прямо сейчас: новые волны псов и коптеров — по ней (progression.js)
        const n = STAGE_NAMES.indexOf(picked.label.slice(EPOCH_PREFIX.length)) + 1;
        if (n > 0) {
          setStage(shared, n);
          console.log(`[battle] эпоха из меню: ${picked.label}`);
        }
      } else if (picked.label === RESET_GUN_SIZES) {
        resetGunScales(pistols.items); // всё оружие снова в свой размер (в руке — со следующего кадра)
      } else if (picked.label === 'Расстояние между глазами') {
        ipd.open();
      } else if (picked.label === 'Перенастроить оси' && heldItem) {
        recalibratingItem = heldItem; // замирает там, где он сейчас; рука его больше не ведёт
        heldItem = null;
        gunResize.start(recalibratingItem); // заодно стик влево/вправо — размер (gun-resize.js)
      } else if (picked.label === 'Удалить оружие' || picked.label === 'Удалить пистолет') {
        deleteHeld();
      }
    },
    update(realDt) {
      // время мира («Настройки ▸ Время»): dt — сколько мира прожито за кадр (сценовые часы уже сдвинуты),
      // мир шагает подшагами clock.sub × clock.n; рука, оружие в руке, HUD — по realDt (world-clock.js)
      const clock = worldClock.begin(realDt);
      // машина и гильзы — шагами не длиннее STEP_S (в быстром режиме подшаг мира длиннее)
      const fineN = clock.fast ? clock.n * Math.ceil(clock.sub / STEP_S - 1e-6) : clock.n;
      const fineSub = fineN > 0 ? clock.total / fineN : 0;
      const dt = clock.total;
      // ×32/×64: экран шлема FAST_HZ (кадры всё равно длинные), иначе снова TARGET_HZ (world-clock.js)
      {
        const xs = renderer.xr.getSession?.();
        const wantHz = (shared.timeScale ?? 1) >= FAST_FROM ? FAST_HZ : FPS_TARGET_HZ;
        if (xs && xs.updateTargetFrameRate && (xs !== hzSession || hzAsked !== wantHz)) {
          hzSession = xs;
          hzAsked = wantHz;
          const rates = xs.supportedFrameRates ? [...xs.supportedFrameRates] : [];
          if (rates.includes(wantHz)) xs.updateTargetFrameRate(wantHz).catch((error) => console.warn('[perf] частота не сменилась:', error));
        }
      }
      fps.beginFrame(); // отсюда до конца renderer.render — цена кадра на CPU (см. fps.js)
      atmosphere.update(dt, realDt); // до мира, частиц и звука погоды: они читают shared.atmosphere.now этого кадра
      atmosphereLight.update(realDt);
      world.update(dt);
      weatherFx.update(dt); // после атмосферы: дождь, снег, град, пыль, листья — по shared.atmosphere.now
      shared.sound?.update?.(camera); // слушатель 3D-звука = голова
      weatherSound.update(realDt); // после атмосферы: громкости дождя, ветра, птиц — по shared.atmosphere.now
      fps.update();
      if (ctx.pointerAim) ctx.pointerAim.hideBeam = Boolean(heldItem || heldClay || scopeDebug.held || carDrive.seated || rayGrab.showing || myDrone.held || binoculars.held); // луч не рисуется, пока что-то в руке (rayGrab рисует свой — до оружия)

      const session = renderer.xr.getSession();
      let source;
      for (const s of session?.inputSources ?? []) {
        if (s.handedness === primaryHand() && s.gamepad && !s.hand) {
          source = s;
          break;
        }
      }
      padSource = source;
      const hand = ctx.getLeftController(); // основная рука (оболочка)
      if (lastPrimary !== primaryHand()) {
        // оружие в руке переходит в другую руку зеркально; сглаживание и двуручный хват — заново
        if (lastPrimary && heldItem) mirrorX(held);
        lastPrimary = primaryHand();
        inertia.reset();
        twoHandAim.reset();
      }
      const menuNow = Boolean(ctx.menuOpen?.());
      // панель расстояния между глазами: стик и курок её, пока она открыта (и пока не отпущена
      // кнопка, которой её закрыли) — оружие не стреляет, предметы не берутся и не отпускаются
      ipd.update(source, menuNow || menuWasOpen);
      if (!heldItem && laserPanel.isOpen) laserPanel.close();
      laserPanel.update(source, menuNow || menuWasOpen);
      const panelBusy = ipd.busy();
      const menuOrPanel = menuNow || menuWasOpen || panelBusy || laserPanel.busy();
      // машина: педали и руль, игрок за рулём едет с ней — до руки и оружия, чтобы они не отставали
      for (let i = 0; i < fineN; i += 1) carDrive.update(fineSub, source, menuOrPanel);
      // пока открыто меню (и в кадр, когда хват его закрыл) или игрок за рулём (хват и курок — педали),
      // оружие не берётся и не отпускается
      const menuIsOpen = menuOrPanel || carDrive.seated;
      menuWasOpen = menuNow;
      const gripDown = Boolean(source?.gamepad.buttons[GRIP_BUTTON]?.pressed);

      if (hand) {
        showController(hand, source);
        // пока пистолет в руке, джойстика не видно; при перенастройке (пистолет замер) он снова виден
        if (realModel) realModel.visible = !heldItem && !myDrone.held && !binoculars.held; // пульт дрона, бинокль в руке — тоже вместо джойстика
        if (axes) axes.visible = SHOW_AXES;
        hand.updateWorldMatrix(true, false);
        gripWorld.copy(hand.matrixWorld);
        handPosition.setFromMatrixPosition(gripWorld);
        // «Инерция» (inertia.js): дальше gripWorld — поза без дрожи (оружие, прицел, выстрел, тарелка в
        // руке, панели); handPosition остаётся сырым (поиск рядом, бросок тарелки). dt — реальный
        if (shared.inertia) inertia.apply(hand, gripWorld, realDt, Boolean(heldItem?.scope)); // с прицелом — сильнее
        else inertia.reset();

        // ближайший пистолет, который можно взять (по расстоянию до его рукоятки)
        nearItem = null;
        nearClay = null;
        let best = REACH;
        if (!heldItem && !heldClay && !recalibratingItem && !textTest.held && !scopeDebug.held && !rayGrab.item && !myDrone.held && !binoculars.held) {
          for (const item of pistols.items) {
            item.group.updateWorldMatrix(true, false);
            // расстояние до места РУКИ, в котором это оружие держат (посадка вида: calib), а не до HANDLE:
            // у перенастроенных (гранатомёт: рука в 17 см от HANDLE) рука на рукоятке иначе «не дотягивалась».
            // С «Размером» s рука сидит в H + (q − H) / s системы оружия (масштаб вокруг HANDLE);
            // у увеличенного досягаемость растёт с ним (меньше 1 — как есть)
            heldOffset(seatM, item.kind);
            const s = item.group.scale.x;
            palm.setFromMatrixPosition(seatM.invert()).sub(HANDLE).divideScalar(s).add(HANDLE).applyMatrix4(item.group.matrixWorld);
            const distance = palm.distanceTo(handPosition) / Math.max(1, s);
            if (distance < best) {
              best = distance;
              nearItem = item;
            }
          }
          // тарелка ближе оружия — берётся она
          nearClay = clays.nearest(handPosition, best);
          if (nearClay) nearItem = null;
        }
        // панель отладки прицела (scope-debug.js): «Относительно схватить», если она ближе оружия
        const debugDistance = scopeDebug.distance(handPosition);
        const debugNearest = !heldItem && !heldClay && !recalibratingItem && !textTest.held && !rayGrab.item && !binoculars.held &&
          debugDistance < SCOPE_DEBUG_REACH_M && debugDistance < best;
        if (debugNearest) nearItem = nearClay = null;
        scopeDebug.update({ hand, gripWorld, gripDown, gripWasDown, gripMode, menuIsOpen, nearest: debugNearest, source });
        // доска теста текста (text-test.js): «Относительно схватить», только пустой рукой
        textTest.update({
          hand, gripWorld, handPosition, gripDown, gripWasDown, gripMode, menuIsOpen, source,
          handBusy: Boolean(heldItem || heldClay || recalibratingItem || nearItem || nearClay || binoculars.held),
        });
        // пульт «Моего дрона» (my-drone.js): «Абсолютно схватить» хватом, только пустой рукой
        const droneEvent = myDrone.hand({
          gripWorld, handPosition, seat: axes, gripDown, gripPressed: gripDown && !gripWasDown, gripMode, menuIsOpen,
          handBusy: Boolean(heldItem || heldClay || recalibratingItem || nearItem || nearClay || debugNearest || textTest.held || scopeDebug.held || rayGrab.item || binoculars.held || binoculars.near),
        });
        if (droneEvent === 'grab') buzz(source);
        else if (droneEvent === 'release') buzz(source, 0.2, 90);
        // бинокль (binoculars.js): «Абсолютно схватить» хватом, только пустой рукой
        const binoEvent = binoculars.hand({
          gripWorld, handPosition, seat: axes, gripDown, gripMode, menuIsOpen,
          handBusy: Boolean(heldItem || heldClay || recalibratingItem || nearItem || nearClay || debugNearest || textTest.held || scopeDebug.held || rayGrab.item || myDrone.held || myDrone.near),
        });
        if (binoEvent === 'grab') buzz(source);
        else if (binoEvent === 'release') buzz(source, 0.2, 90);
        rayItems.length = 0;
        for (let i = 0; i < pistols.items.length; i += 1) rayItems.push(pistols.items[i]);
        if (binoculars.item) rayItems.push(binoculars.item);
        // луч на оружие издали (ray-grab.js): берёт и держит КУРОК; только пустой рукой и когда рядом
        // взять нечего (ближний хват и тарелка под курком главнее; окно HUD на луче — тоже)
        const rayTrigger = Boolean(source?.gamepad.buttons[TRIGGER_BUTTON]?.pressed);
        const rayEvent = rayGrab.update({
          rayObj: rayOf(hand), gripWorld, items: rayItems, menuIsOpen,
          triggerDown: rayTrigger, triggerPressed: rayTrigger && !triggerWasDown, stickX: source?.gamepad.axes?.[2] ?? 0, stickY: source?.gamepad.axes?.[3] ?? 0, dt: realDt,
          canPoint: !heldItem && !heldClay && !recalibratingItem && !textTest.held && !scopeDebug.held &&
            !nearItem && !nearClay && !debugNearest && !carDrive.seated && !myDrone.held && !myDrone.near && !binoculars.held && !binoculars.near,
        });
        if (rayEvent === 'grab') buzz(source);
        else if (rayEvent === 'release') {
          buzz(source, 0.2, 90);
          pistols.save(heldItem, held.toArray(), true);
        } else if (rayEvent === 'hover') buzz(source, 0.1, 15);

        const gripPressed = gripDown && !gripWasDown;
        if (gripPressed && recalibratingItem) {
          // второй хват: оружие «приклеивается» там, где замерло, относительно джойстика; сохраняется
          // для его вида (пистолеты и калаши — каждый своё)
          recalibratingItem.group.updateWorldMatrix(true, false);
          const kind = CALIB_KEYS[recalibratingItem.kind] ? recalibratingItem.kind : 'pistol';
          const calib = new THREE.Matrix4().copy(gripWorld).invert().multiply(recalibratingItem.group.matrixWorld);
          gunResize.apply(calib, recalibratingItem.kind, true); // посадка — без размера (он накладывается сверху)
          gunResize.stop(); // размер, выбранный стиком, записан
          held.copy(calib);
          if (primaryHand() === 'right') mirrorX(calib); // храним для левой руки
          calibs[kind] = calib;
          try {
            localStorage.setItem(CALIB_KEYS[kind], JSON.stringify(calib.toArray()));
          } catch {
            // без хранилища положение не переживёт перезапуск
          }
          heldItem = recalibratingItem;
          recalibratingItem = null;
          buzz(source, 0.5, 80);
        } else if (gripPressed && heldClay && gripMode === 'toggle' && !menuIsOpen) {
          clays.drop(heldClay); // повисает, где была
          heldClay = null;
          buzz(source, 0.2, 90);
        } else if (gripPressed && heldItem && gripMode === 'toggle' && !menuIsOpen) {
          releasePistol(source);
        } else if (gripPressed && !heldItem && !heldClay && nearClay && !menuIsOpen) {
          heldClay = nearClay;
          nearClay = null;
          clays.grab(heldClay);
          buzz(source);
        } else if (gripPressed && !heldItem && !heldClay && nearItem && !menuIsOpen) {
          heldItem = nearItem;
          nearItem = null;
          heldOffset(held, heldItem.kind); // всё оружие одного вида садится в руку одинаково
          buzz(source);
        }
      }
      // режим «держать»: пистолет в руке, пока хват зажат; при открытом меню отпустится после закрытия
      if (gripMode === 'hold' && heldItem && !gripDown && !menuIsOpen) releasePistol(source);
      if (gripMode === 'hold' && heldClay && !gripDown && !menuIsOpen) {
        clays.drop(heldClay);
        heldClay = null;
      }
      gripWasDown = gripDown;
      gunResize.update({ recalibrating: recalibratingItem, items: pistols.items, source, menuOpen: menuIsOpen, dt: realDt }); // перенастройка: стик X — размер

      // АВП в руке, меню и панели закрыты: стик вверх/вниз слегка наклоняет прицел (меняет угол)
      {
        const stickY = heldItem?.scope && !menuIsOpen ?(source?.gamepad.axes?.[3] ?? 0) : 0;
        const DEAD = 0.18;
        const [tiltProp, tiltKey] = SCOPE_TILT[heldItem?.kind] ?? SCOPE_TILT.awp; // у каждого вида свой наклон
        if (Math.abs(stickY) > DEAD) {
          const k = (Math.abs(stickY) - DEAD) / (1 - DEAD);
          const tilt = shared[tiltProp] - Math.sign(stickY) * k * AWP_SCOPE_TILT_SPEED * Math.min(realDt, 0.1); // стик вверх (ось < 0) — передний конец выше
          shared[tiltProp] = Math.min(AWP_SCOPE_TILT_MAX, Math.max(-AWP_SCOPE_TILT_MAX, tilt));
          scopeSliding = tiltProp;
        } else if (scopeSliding) {
          const [prop, key] = Object.values(SCOPE_TILT).find(([p]) => p === scopeSliding) ?? [tiltProp, tiltKey];
          scopeSliding = false;
          try {
            localStorage.setItem(key, String(shared[prop]));
          } catch {
            // без хранилища положение не переживёт перезагрузку
          }
        }
      }

      // курок стреляет, пока оружие в руке: пистолет — раз на нажатие, калаш — пока зажат
      const triggerDown = Boolean(source?.gamepad.buttons[TRIGGER_BUTTON]?.pressed);
      // тарелка в руке: курок взводит бросок, рука затормозила на взмахе — тарелка летит
      if (hand) {
        // курок у тарелки в досягаемости (рука пуста) — берёт её, и бросок сразу взведён (курок зажат)
        if (triggerDown && !triggerWasDown && !heldItem && !heldClay && !recalibratingItem && nearClay && !menuIsOpen) {
          heldClay = nearClay;
          nearClay = null;
          clays.grab(heldClay);
          buzz(source);
        }
        if (heldClay) {
          clayOffset(clayHeld);
          clays.place(heldClay, pistolWorld.copy(gripWorld).multiply(clayHeld));
        }
        camera.getWorldDirection(headForward); // тарелка летит только вперёд от головы
        if (clays.updateHand(handPosition, realDt, triggerDown && !menuIsOpen, headForward)) {
          heldClay = null;
          buzz(source, 0.6, 50);
        }
      }
      clays.setNear(heldItem || heldClay ? null : nearClay);
      // X: новая тарелка в руку (как пункт меню), если рука свободна и меню закрыто
      const xDown = Boolean(source?.gamepad.buttons[X_BUTTON]?.pressed);
      if (xDown && !xWasDown && active.features.xPlate && !heldItem && !heldClay && !recalibratingItem && !rayGrab.item && !myDrone.held && !binoculars.held && !menuIsOpen) { // с пультом дрона X — вниз (my-drone.js)
        spawnClay();
        buzz(source, 0.3, 40);
      }
      xWasDown = xDown;
      if (heldItem && GUNS[heldItem.kind]?.charge) chargeStep(source, GUNS[heldItem.kind], triggerDown && !panelBusy && !carDrive.seated && !laserPanel.blocksFire(), realDt);
      else {
        if (chargeS >= 0) {
          chargeS = -1; // оружие убрали посреди заряда
          shooting.chargeFx?.(null);
        }
        if (triggerDown && heldItem && !panelBusy && !carDrive.seated && !laserPanel.blocksFire() && (!triggerWasDown || GUNS[heldItem.kind]?.auto)) fire(source);
      }
      triggerWasDown = triggerDown;

      // задранный очередью ствол плавно возвращается
      const recover = Math.exp(-CLIMB_RECOVER * Math.min(realDt, 0.1));
      climb *= recover;
      climbYaw *= recover;
      if (!heldItem) climb = climbYaw = 0;

      if (heldItem && hand) {
        pistolWorld.copy(gripWorld).multiply(held);
        // правый курок зажат — ствол по линии левая→правая рука, крен от левой (two-hand-aim.js)
        twoHandAim.apply(pistolWorld, HANDLE, renderer, hand.parent?.matrixWorld, true, realDt, null, primaryHand() === 'right' ? 'left' : 'right');
        // отдача: поворот стволом вверх вокруг рукоятки (у калаша ещё толчок назад), быстро
        // затухает; сверху — подъём ствола от очереди
        const age = performance.now() - lastShotAt;
        let pitch = climb;
        if (age < lastGun.kickMs) {
          const fade = (1 - age / lastGun.kickMs) ** 2;
          pitch += lastGun.kickRad * fade;
          if (lastGun.kickBackM) pistolWorld.multiply(kickBack.makeTranslation(0, 0, lastGun.kickBackM * fade));
        }
        if (pitch > 1e-4 || Math.abs(climbYaw) > 1e-4) {
          kickPivot.makeTranslation(HANDLE.x, HANDLE.y, HANDLE.z);
          kick.makeRotationFromEuler(kickEuler.set(pitch, climbYaw, 0, 'YXZ'));
          pistolWorld.multiply(kickPivot).multiply(kick).multiply(kickPivot.invert());
        }
        gunResize.apply(pistolWorld, heldItem.kind); // «Размер» вида вокруг рукоятки (gun-resize.js)
        pistolWorld.decompose(heldItem.group.position, heldItem.group.quaternion, heldItem.group.scale);
      }
      if (!(heldItem && hand)) twoHandAim.reset();
      pistols.updateTriggers(heldItem && hand ? heldItem : null, source?.gamepad.buttons[TRIGGER_BUTTON]?.value ?? 0, realDt, ejectCasing);
      for (let i = 0; i < fineN; i += 1) casings.update(fineSub);
      placeFlash();
      paintPistols();
      // прицел: контур у мишени, в которую попадёт выстрел сейчас (тот же луч, что в fire)
      if (heldItem && hand) {
        heldItem.group.updateWorldMatrix(true, false);
        aimMuzzle.copy(heldItem.muzzle).applyMatrix4(heldItem.group.matrixWorld);
        aimBarrel.set(0, 0, -1).transformDirection(heldItem.group.matrixWorld);
        let aimPoint = shooting.aim(aimMuzzle, aimBarrel, GUNS[heldItem.kind]?.range, GUNS[heldItem.kind]?.speed);
        // панель цвета: подсветка плашки под прицелом; лазер виден, пока она открыта
        if (laserPanel.isOpen) {
          const d = laserPanel.cast(aimMuzzle, aimBarrel);
          if (d >= 0 && (!aimPoint || aimMuzzle.distanceTo(aimPoint) > d)) aimPoint = laserPanel.point;
        }
        laser.setColor(shared.laserColor);
        laser.setVisible(shared.laser || laserPanel.isOpen);
        laser.update(aimMuzzle, aimBarrel, aimPoint);
      } else {
        shooting.aim(null);
        laser.setVisible(false);
      }
      // мир: clock.n подшагов по clock.sub с (не больше 8 и в бюджете CPU, world-clock.js)
      const worldT0 = performance.now();
      // ×32/×64 (clock.fast): подшаг длиннее STEP_S — тарелки и одиночный пёс получают его дробями;
      // clock.last — последний подшаг кадра (картинка считается только на нём); кадр затянулся дольше
      // hardMs — этот подшаг последний, непрожитое возвращается часам (world-clock.js)
      const fine = clock.fast ? Math.ceil(clock.sub / STEP_S - 1e-6) : 1;
      const fineDt = clock.sub / fine;
      const PW = globalThis.__prof?.world; // профилировщик подшага: __prof = { world: {} } из vr:eval
      for (let i = 0; i < clock.n; i += 1) {
        if (clock.fast && i < clock.n - 1 && performance.now() - worldT0 > worldClock.hardMs) worldClock.cut(i + 1);
        clock.last = i === clock.n - 1;
        if (PW) {
          let t = performance.now(), u;
          shooting.update(clock.sub); u = performance.now(); PW.shooting = (PW.shooting || 0) + u - t; t = u;
          for (let k = 0; k < fine; k += 1) clays.update(fineDt);
          for (let k = 0; k < fine; k += 1) robodog.update(fineDt);
          u = performance.now(); PW.small = (PW.small || 0) + u - t; t = u;
          horde.update(clock.sub); u = performance.now(); PW.horde = (PW.horde || 0) + u - t; t = u;
          drones.update(clock.sub); u = performance.now(); PW.drones = (PW.drones || 0) + u - t; t = u;
          artillery.update(clock.sub); u = performance.now(); PW.artillery = (PW.artillery || 0) + u - t;
          PW.subs = (PW.subs || 0) + 1;
          continue;
        }
        shooting.update(clock.sub);
        for (let k = 0; k < fine; k += 1) clays.update(fineDt);
        for (let k = 0; k < fine; k += 1) robodog.update(fineDt);
        horde.update(clock.sub);
        drones.update(clock.sub);
        artillery.update(clock.sub);
      }
      clock.last = true;
      worldClock.measure(performance.now() - worldT0);
      artillery.frame(clock.total); // частицы разрывов: раз в кадр, игровое время
      messageHoles.update();
      crackedGlasses.update();
      score.update(realDt);
      scopeTilts.awp = shared.awpScopeTilt;
      scopeTilts.ak2 = shared.ak2ScopeTilt;
      for (let i = 0; i < genTilts.length; i += 1) scopeTilts[genTilts[i][0]] = shared[genTilts[i][1]];
      pistols.updateLenses(shared.awpScopeZ, scopeTilts); // прицелы (АВП, «Калаш 2.0»): сдвиг, наклон и изображение (только когда в окуляр смотрят)
      myDrone.update(realDt, source, menuIsOpen); // «Мой дрон»: полёт с пульта, гул, экран камеры (my-drone.js)
      binoculars.update({ realDt, source, menuIsOpen, rayTarget: rayGrab.target, rayHeld: rayGrab.item }); // бинокль: обводка, кратность стиком, окуляры у лица
      killConfirm.update(); // хитмаркеры убийств: только uniform времени (kill-confirm.js)
      sunShadows.setSun(world.shadowSun); // мир двигает этот вектор на месте (время суток); без изменений — ничего не стоит
      sunShadows.update(); // тени по солнцу: псы и коптеры уже записали матрицы этого кадра
      if (!hand) scopeDebug.update({ hand: null, gripDown: false, gripWasDown: false, gripMode, menuIsOpen: true }); // без руки — только видна
      if (!hand) rayGrab.hide();
      liveLeft -= realDt;
      if (liveLeft <= 0) {
        liveLeft = LIVE_EVERY_S;
        saveLive(); // последнее состояние активной сцены (compositions.js: live)
      }

      // меню зависит от того, что игрок держит, и от режима хвата
      const heldKind = heldItem?.kind ?? (heldClay ? 'plate' : myDrone.held ? 'remote' : binoculars.held ? 'binoculars' : null);
      {
        const lensZ = heldLens();
        if (lensZ && heldItem) {
          const z = (zoomCache[heldItem.kind] ??= savedZoom(heldItem.kind) ?? 0);
          if (z && Math.abs(lensZ.magnification - z) > 1e-3) lensZ.setMagnification(z);
        }
      }
      // на вышке с пустой рукой: стик — ходить по площадке (вперёд — куда смотришь), 1,2 м/с; не при
      // открытом меню и не пока лучом держится оружие (стик у ray-grab)
      if (tower.on && !heldKind && !menuIsOpen && !rayGrab.item && !recalibratingItem && !textTest.held && !scopeDebug.held && source?.gamepad) { // при «Перенастроить оси» стик — размер оружия
        const dzW = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
        const sxW = dzW(source.gamepad.axes?.[2] ?? 0);
        const syW = dzW(source.gamepad.axes?.[3] ?? 0);
        if (sxW || syW) {
          camera.getWorldDirection(walkFwd);
          walkFwd.y = 0;
          if (walkFwd.lengthSq() > 1e-6) {
            walkFwd.normalize();
            const step = 1.2 * realDt;
            // вправо от взгляда: (−fz, fx)
            tower.walk((walkFwd.x * -syW - walkFwd.z * sxW) * step, (walkFwd.z * -syW + walkFwd.x * sxW) * step, realDt);
          }
        }
      } // 'remote' — пульт дрона, 'binoculars' — бинокль (menu.js)
      const key = `${heldKind}|${gripMode}|${shared.targetPhysics}|${shared.aimOutline}|${shared.laser}|${carDrive.seated}|${shared.timeScale ?? 1}|${Boolean(shared.scopeDebug)}|${Boolean(shared.inertia)}|${GUNS[heldKind]?.auto}|${shared.allies !== false}|${shared.drones !== false}|${shared.artillery !== false}|${shared.scopeMode}|${heldLens()?.magnification}|${sunShadows.enabled}|${atmosphere.rev}`; // сцены сбрасывают menuKey сами
      if (key !== menuKey) {
        menuKey = key;
        ctx.setMenu?.(buildMenu(menuState(heldKind)));
      }
      // положение запоминается, пока пистолет в руке (он движется), и сразу, когда его взяли/отпустили;
      // без пистолета в руке ничего не меняется — и не сохраняется каждый кадр (меньше мусора для GC)
      if (heldItem || heldItem !== savedHeld || rayGrab.item) { // rayGrab.item — оружие, которое двигают лучом
        pistols.save(heldItem, heldToArray, heldItem !== savedHeld); // массив — только когда пишется
        savedHeld = heldItem;
      }
    },
    dispose() {
      pistols.save(heldItem, held.toArray(), true);
      root.remove(flash.mesh);
      flash.mesh.geometry.dispose();
      flash.mesh.material.dispose();
      flash.texture.dispose();
      clays.dispose();
      casings.dispose();
      laser.dispose();
      myDrone.dispose();
      binoculars.dispose();
      killConfirm.dispose();
      if (testKit && shared.testKit === testKit) delete shared.testKit; // псы кита остаются в стае
      laserPanel.dispose();
      saveLive(); // до shooting.dispose: снимок читает мишени
      window.removeEventListener('pagehide', saveLive);
      document.removeEventListener('visibilitychange', onPageHide);
      score.dispose();
      carDrive.dispose();
      car.dispose();
      disposed = true;
      robodog.dispose(); // до shooting.dispose: снимает свою цель для пуль
      drones.dispose(); // до shooting.dispose: снимает свою цель для пуль
      artillery.dispose();
      horde.dispose();
      tower.dispose();
      shooting.dispose();
      messageHoles.dispose();
      crackedGlasses.dispose();
      weatherSound.dispose();
      weatherFx.dispose();
      atmosphereLight.dispose(); // светильники оболочки — как были (до world.dispose: он возвращает экспозицию)
      world.dispose();
      atmosphere.dispose(); // объект остаётся в shared.atmosphere: следующая версия сцены продолжит с его значений
      sunShadows.dispose();
      if (shared.sunShadows === sunShadows) delete shared.sunShadows;
      shake.dispose(); // до ipd и fps: все оборачивают scene.onBeforeRender
      ipd.dispose(); // до fps: оба оборачивают scene.onBeforeRender
      fps.dispose();
      textTest.dispose();
      pistols.disposeLenses();
      gunResize.dispose();
      scopeDebug.dispose();
      rayGrab.dispose();
      if (ctx.pointerAim?.object === axes) ctx.pointerAim.object = null;
      if (ctx.pointerAim) ctx.pointerAim.hideBeam = false;
      axes?.parent?.remove(axes);
      axes?.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      // модель настоящего контроллера остаётся на руке: её подхватит следующая версия сцены
    },
  };
}
