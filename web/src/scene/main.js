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
import { buildMenu } from './menu.js';
import { createPistols } from './pistols.js';
import { createSound, SOUND_VERSION } from './sound.js';
import { createShooting } from './shooting.js';
import { createMessageHoles } from './message-holes.js';
import { createClays } from './clays.js';
import { createWorld } from './world.js';
import { createFps } from './fps.js';

const GRIP_BUTTON = 1; // xr-standard gamepad: хват
const TRIGGER_BUTTON = 0; // курок
const X_BUTTON = 4; // X: заспавнить тарелку в руку
const REACH = 0.132; // метров от рукоятки пистолета до контроллера, чтобы взять

export function setup(ctx) {
  const { THREE, root, renderer, camera, scene } = ctx;
  const shared = (globalThis.__sceneState ??= {});
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
  ctx.setMenu?.(buildMenu({ holdingPistol: false, gripMode, targetPhysics: shared.targetPhysics, aimOutline: shared.aimOutline })); // меню (menu.js): меняется на лету
  ctx.setMapper?.(new ControlMap()); // какая кнопка что делает (controls-map.js): тоже на лету
  ctx.setHud?.(HUD_CONFIG); // окна сообщений и кружок-индикатор (hud.js): тоже на лету

  const world = createWorld({ THREE, scene, root, camera, renderer });
  const fps = createFps({ THREE, camera, renderer, scene });
  const pistols = createPistols({ THREE, root });
  // звук (sound.js) живёт между подменами сцены; новая версия файла — новый объект (контекст тот же)
  if (shared.sound?.version !== SOUND_VERSION) shared.sound = createSound();
  const shooting = createShooting({ THREE, root, camera });
  const messageHoles = createMessageHoles({ THREE, camera });
  // глиняные тарелки (clays.js): спавн в руку, хват как у оружия, курок — бросок взмахом
  const clays = createClays({ THREE, root, shooting, camera });
  shared.clayDebug = { clays, spawn: () => spawnClay() }; // ручка для npm run vr:eval
  let heldClay = clays.held(); // после подмены сцены тарелка остаётся в руке
  let nearClay = null;
  const clayHeld = new THREE.Matrix4(); // положение тарелки относительно руки
  const CLAY_OFFSET = new THREE.Vector3(0, 0.035, -0.1); // по осям джойстика: чуть выше и впереди

  // ---- Посадка пистолета в руку
  const HANDLE = new THREE.Vector3(0, -0.04, 0.045); // середина рукоятки (ладонь) в системе пистолета
  // Смещение пистолета в руке относительно осей джойстика: x — по красной, y — по синей, z — против
  // зелёной. Сейчас пистолет на 5 см ниже осей (против синей стрелки).
  const PISTOL_SHIFT = new THREE.Vector3(0, -0.05, 0);
  // Перенастройка осей (пункт меню, пока оружие в руке): оно замирает, джойстик ставят как
  // удобно, второй хват «приклеивает» его. Это положение относительно джойстика (calib) своё у
  // каждого вида оружия (все пистолеты — одно, все калаши — другое) и сохраняется; пока его нет,
  // оружие садится осями на оси джойстика.
  const CALIB_KEYS = { pistol: 'scene.pistol.calib', ak: 'scene.ak.calib' };
  const calibs = {};
  for (const [kind, key] of Object.entries(CALIB_KEYS)) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(saved) && saved.length === 16) calibs[kind] = new THREE.Matrix4().fromArray(saved);
    } catch {
      // нет сохранённого положения: оси на оси
    }
  }

  const held = new THREE.Matrix4(); // положение пистолета в руке относительно руки
  const inHand = new THREE.Matrix4();
  const gripWorld = new THREE.Matrix4();
  const pistolWorld = new THREE.Matrix4();
  const unusedPosition = new THREE.Vector3();
  const unusedScale = new THREE.Vector3();
  const unusedQuaternion = new THREE.Quaternion();
  const handPosition = new THREE.Vector3();
  const palm = new THREE.Vector3();

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
    if (!realModel && source) {
      for (const old of hand.children.filter((child) => child.name.startsWith('scene-pad'))) hand.remove(old);
      realModel = factory.createControllerModel(hand);
      realModel.name = 'scene-pad-real';
      hand.add(realModel);
      shared.realModel = realModel;
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
      pistolWorld.premultiply(hand.matrixWorld).decompose(item.group.position, item.group.quaternion, item.group.scale);
    } else {
      putInFrontOfPlayer(item);
    }
    pistols.save(heldItem, held.toArray(), true);
  };

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
    pistol: { gapMs: 140, auto: false, kickMs: 140, kickRad: 0.2, kickBackM: 0, climbRad: 0, buzz: 0.8 },
    ak: { gapMs: 100, auto: true, kickMs: 85, kickRad: 0.075, kickBackM: 0.014, climbRad: 0.03, buzz: 1 },
  };
  const CLIMB_MAX_RAD = 0.2; // больше ствол от очереди не задирается
  const CLIMB_RECOVER = 4; // 1/с: как быстро задранный ствол возвращается
  let lastShotAt = -1e9;
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

  const fire = (source) => {
    const now = performance.now();
    if (!heldItem) return;
    const gun = GUNS[heldItem.kind] ?? GUNS.pistol;
    if (now - lastShotAt < gun.gapMs) return;
    // очередь идёт ровно в темпе, а не «как получилось по кадрам»
    lastShotAt = gun.auto && now - lastShotAt < gun.gapMs * 2 ? lastShotAt + gun.gapMs : now;
    lastGun = gun;
    if (gun.climbRad) {
      climb = Math.min(CLIMB_MAX_RAD, climb + gun.climbRad * (0.8 + Math.random() * 0.4));
      climbYaw = THREE.MathUtils.clamp(climbYaw + (Math.random() - 0.45) * gun.climbRad * 0.5, -0.06, 0.06);
    }
    shared.sound?.setWeapon?.(heldItem.kind); // shooting.shoot звучит выбранным оружием
    const { group } = heldItem;
    group.updateWorldMatrix(true, false);
    muzzleWorld.copy(heldItem.muzzle).applyMatrix4(group.matrixWorld);
    ejectWorld.copy(heldItem.ejector).applyMatrix4(group.matrixWorld);
    barrel.set(0, 0, -1).transformDirection(group.matrixWorld);
    right.set(1, 0, 0).transformDirection(group.matrixWorld);
    up.set(0, 1, 0).transformDirection(group.matrixWorld);
    messageHoles.hit(muzzleWorld, barrel);
    const hit = shooting.shoot(muzzleWorld, barrel, { ejector: ejectWorld, right, up });
    buzz(source, hit ? Math.max(gun.buzz, 0.95) : gun.buzz, 60);
    if (heldItem.kind === 'ak') {
      flash.until = now + 45;
      flash.mesh.userData.item = heldItem;
      flash.mesh.scale.set(0.8 + Math.random() * 0.5, 0.8 + Math.random() * 0.5, 0.75 + Math.random() * 0.6);
      flash.mesh.userData.spin = Math.random() * Math.PI;
    }
  };

  // ручка для npm run vr:eval: выстрелить из оружия номер index (как будто оно в руке) или убрать его
  shared.weaponDebug = {
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
      const active = item === heldItem || item === nearItem || item === recalibratingItem;
      item.accent.emissive.set(active ? 0x7c2d12 : 0x000000);
      item.outline.visible =
        (item === nearItem && !heldItem) || item === recalibratingItem || (item === releasedItem && now < releaseFlashUntil);
    }
  };

  return {
    // Выбран пункт радиального меню: { path, label }
    onMenu(picked) {
      if (picked.label === 'Заспавнить пистолет') {
        spawnWeapon('pistol');
      } else if (picked.label === 'Заспавнить калаш') {
        spawnWeapon('ak');
      } else if (picked.label === 'Заспавнить тарелку') {
        spawnClay();
      } else if (picked.label === 'Удалить тарелку' && heldClay) {
        clays.remove(heldClay);
        heldClay = null;
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
      } else if (picked.label === 'Перенастроить оси' && heldItem) {
        recalibratingItem = heldItem; // замирает там, где он сейчас; рука его больше не ведёт
        heldItem = null;
      } else if (picked.label === 'Удалить оружие' || picked.label === 'Удалить пистолет') {
        deleteHeld();
      }
    },
    update(dt) {
      fps.beginFrame(); // отсюда до конца renderer.render — цена кадра на CPU (см. fps.js)
      world.update(dt);
      shared.sound?.update?.(camera); // слушатель 3D-звука = голова
      fps.update();

      const session = renderer.xr.getSession();
      let source;
      for (const s of session?.inputSources ?? []) {
        if (s.handedness === 'left' && s.gamepad && !s.hand) {
          source = s;
          break;
        }
      }
      const hand = ctx.getLeftController();
      const menuNow = Boolean(ctx.menuOpen?.());
      const menuIsOpen = menuNow || menuWasOpen; // пока открыто меню (и в кадр, когда хват его закрыл), оружие не берётся и не отпускается
      menuWasOpen = menuNow;
      const gripDown = Boolean(source?.gamepad.buttons[GRIP_BUTTON]?.pressed);

      if (hand) {
        showController(hand, source);
        // пока пистолет в руке, джойстика не видно; при перенастройке (пистолет замер) он снова виден
        if (realModel) realModel.visible = !heldItem;
        if (axes) axes.visible = SHOW_AXES;
        hand.updateWorldMatrix(true, false);
        gripWorld.copy(hand.matrixWorld);
        handPosition.setFromMatrixPosition(gripWorld);

        // ближайший пистолет, который можно взять (по расстоянию до его рукоятки)
        nearItem = null;
        nearClay = null;
        let best = REACH;
        if (!heldItem && !heldClay && !recalibratingItem) {
          for (const item of pistols.items) {
            item.group.updateWorldMatrix(true, false);
            const distance = palm.copy(HANDLE).applyMatrix4(item.group.matrixWorld).distanceTo(handPosition);
            if (distance < best) {
              best = distance;
              nearItem = item;
            }
          }
          // тарелка ближе оружия — берётся она
          nearClay = clays.nearest(handPosition, best);
          if (nearClay) nearItem = null;
        }

        const gripPressed = gripDown && !gripWasDown;
        if (gripPressed && recalibratingItem) {
          // второй хват: оружие «приклеивается» там, где замерло, относительно джойстика; сохраняется
          // для его вида (пистолеты и калаши — каждый своё)
          recalibratingItem.group.updateWorldMatrix(true, false);
          const kind = CALIB_KEYS[recalibratingItem.kind] ? recalibratingItem.kind : 'pistol';
          const calib = new THREE.Matrix4().copy(gripWorld).invert().multiply(recalibratingItem.group.matrixWorld);
          calibs[kind] = calib;
          held.copy(calib);
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
        if (clays.updateHand(handPosition, dt, triggerDown && !menuIsOpen, headForward)) {
          heldClay = null;
          buzz(source, 0.6, 50);
        }
      }
      clays.setNear(heldItem || heldClay ? null : nearClay);
      // X: новая тарелка в руку (как пункт меню), если рука свободна и меню закрыто
      const xDown = Boolean(source?.gamepad.buttons[X_BUTTON]?.pressed);
      if (xDown && !xWasDown && !heldItem && !heldClay && !recalibratingItem && !menuIsOpen) {
        spawnClay();
        buzz(source, 0.3, 40);
      }
      xWasDown = xDown;
      if (triggerDown && heldItem && (!triggerWasDown || GUNS[heldItem.kind]?.auto)) fire(source);
      triggerWasDown = triggerDown;

      // задранный очередью ствол плавно возвращается
      const recover = Math.exp(-CLIMB_RECOVER * Math.min(dt, 0.1));
      climb *= recover;
      climbYaw *= recover;
      if (!heldItem) climb = climbYaw = 0;

      if (heldItem && hand) {
        pistolWorld.copy(gripWorld).multiply(held);
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
        pistolWorld.decompose(heldItem.group.position, heldItem.group.quaternion, heldItem.group.scale);
      }
      placeFlash();
      paintPistols();
      // прицел: контур у мишени, в которую попадёт выстрел сейчас (тот же луч, что в fire)
      if (heldItem && hand) {
        heldItem.group.updateWorldMatrix(true, false);
        aimMuzzle.copy(heldItem.muzzle).applyMatrix4(heldItem.group.matrixWorld);
        aimBarrel.set(0, 0, -1).transformDirection(heldItem.group.matrixWorld);
        shooting.aim(aimMuzzle, aimBarrel);
      } else shooting.aim(null);
      shooting.update(dt);
      clays.update(dt);
      messageHoles.update();

      // меню зависит от того, что игрок держит, и от режима хвата
      const heldKind = heldItem?.kind ?? (heldClay ? 'plate' : null);
      const key = `${heldKind}|${gripMode}|${shared.targetPhysics}|${shared.aimOutline}`;
      if (key !== menuKey) {
        menuKey = key;
        ctx.setMenu?.(buildMenu({ holdingPistol: Boolean(heldKind), heldKind, gripMode, targetPhysics: shared.targetPhysics, aimOutline: shared.aimOutline }));
      }
      // положение запоминается, пока пистолет в руке (он движется), и сразу, когда его взяли/отпустили;
      // без пистолета в руке ничего не меняется — и не сохраняется каждый кадр (меньше мусора для GC)
      if (heldItem || heldItem !== savedHeld) {
        pistols.save(heldItem, held.toArray(), heldItem !== savedHeld);
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
      shooting.dispose();
      messageHoles.dispose();
      world.dispose();
      fps.dispose();
      if (ctx.pointerAim?.object === axes) ctx.pointerAim.object = null;
      axes?.parent?.remove(axes);
      axes?.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      // модель настоящего контроллера остаётся на руке: её подхватит следующая версия сцены
    },
  };
}
