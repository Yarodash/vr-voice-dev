// Радиальное меню на джойстике. Живёт в сцене, чтобы добавление и правка пунктов подхватывались
// на лету, без перезагрузки страницы (запись голоса и положение в мире не сбрасываются).
//
// Пункт: { label } или { label, children: [пункты] } (подменю). Что делает выбранный пункт,
// решает `onMenu(picked)` в main.js: picked = { path: ['Подменю', 'Пункт'], label: 'Пункт' }.
// Меню собирается заново, когда меняется состояние: что игрок держит (heldKind: 'pistol' | 'ak' |
// 'plate' | null), режим хвата, активная сцена (compositions.js) и список сохранённых сцен.
//
// Сцены: features активной сцены решают, какие пункты есть (targets — «Мишени», spawn —
// «Заспавнить» и «Хват»; счёта сейчас нет нигде). «Сцены ▸» и «Настройки ▸» есть всегда, кроме
// меню с оружием в руке (там только пункты оружия).
import { GENERATED_GUNS, genEntry, genSpawnLabel } from './generated-guns.js';

export const FIRE_MODE_PREFIX = 'Режим:'; // «Режим: авто / полуавтомат» у сгенерированных пушек с modes

export const SCENES_MENU = 'Сцены';
export const SAVE_NEW = 'Сохранить как новую';
export const CLEAR_ALL = 'Очистить всё';
export const SCENE_CONTINUE = 'Продолжить';
export const SCENE_RESTART = 'Рестарт';
export const RESET_SCORE = 'Сбросить счёт';
export const RESET_GUN_SIZES = 'Сбросить размеры оружия'; // Настройки ▸: все scene.scale.* → 1 (gun-resize.js)
// машина (car-drive.js): первый пункт любого меню в сцене с функцией «car»
export const CAR_ENTER = 'Сесть за руль';
export const CAR_EXIT = 'Выйти из машины';
// стая робопсов: «Собаки ▸ Союзники: вкл/выкл» (обрабатывает main.js → shared.allies)
export const DOGS_MENU = 'Собаки';
// «Собаки ▸ Квадрокоптеры: вкл/выкл» (обрабатывает main.js → shared.drones, drones.js)
export const DRONES_ON = 'Квадрокоптеры: вкл';
export const DRONES_OFF = 'Квадрокоптеры: выкл';
// «Собаки ▸ Артиллерия: вкл/выкл» (обрабатывает main.js → shared.artillery, artillery.js)
// «Заспавнить ▸ Мой дрон» и пункты пульта в руке (main.js → my-drone.js)
export const MY_DRONE_SPAWN = 'Мой дрон';
export const MY_DRONE_RECALL = 'Дрон ко мне';
export const MY_DRONE_REMOVE = 'Удалить дрон'; // пульт и его дрон вместе
export const MY_DRONE_REGRIP = 'Перенастроить хват'; // пульт замирает, хват берёт его как удобно
export const MY_DRONE_RELEASE = 'Отпустить пульт';
export const MY_DRONE_AUTOPILOT_ON = 'Автопилот: вкл';
export const MY_DRONE_AUTOPILOT_OFF = 'Автопилот: выкл';
export const MY_DRONE_SIZES = ['маленький', 'средний', 'большой', 'огромный']; // «Мой дрон ▸ …» — индекс = размер (my-drone.js SIZES)
export const ARTILLERY_ON = 'Артиллерия: вкл';
export const ARTILLERY_OFF = 'Артиллерия: выкл';

export function buildMenu({
  holdingPistol,
  heldKind = holdingPistol ? 'pistol' : null,
  gripMode,
  targetPhysics = true,
  aimOutline = true,
  laser = false,
  features = { targets: true, spawn: true },
  scenes = [],
  car = null, // null — машины нет; 'out' — стоит рядом; 'in' — за рулём
  timeScale = 1, // замедление времени: 1 → 0,5 → 0,25 → 1 (пункт в «Настройках»)
  scopeDebug = false, // панель отладки прицела (scope-debug.js), пункт у АВП в руке
  inertia = false, // «Инерция: вкл/выкл» в «Настройках»: гасит дрожание руки (inertia.js)
  prone = false, // «Режим лёжа: вкл/выкл» в «Настройках»: центрирование ставит глаза в ~35 см над землёй
  tracersOff = false, // «Трассеры: вкл/выкл» в «Настройках»
  droneAutopilot = false, // «Автопилот: вкл/выкл» в меню пульта (my-drone.js)
  fireMode = null, // 'semi' | 'auto' — у пушки в руке с modes (generated-guns.js)
  shake = 1, // «Тряска: вкл / сильно / выкл» в «Настройках» (shake.js): 1 | 2 | 0
  allies = null, // «Собаки ▸ Союзники: вкл/выкл» (стая, robodog-horde.js); null — пункта нет
  tower = false, // «Вышка: вкл/выкл» (tower.js): в «Собаки ▸», если он есть, иначе в «Настройки ▸»
  drones = null, // «Собаки ▸ Квадрокоптеры: вкл/выкл» (drones.js); null — пункта нет
  artillery = null, // «Собаки ▸ Артиллерия: вкл/выкл» (artillery.js); null — пункта нет
}) {
  const towerItem = { label: tower ? 'Вышка: вкл' : 'Вышка: выкл', keepOpen: true };
  const carItems = car ? [{ label: car === 'in' ? CAR_EXIT : CAR_ENTER }] : [];
  const outlineItem = { label: aimOutline ? 'Обводка прицела: вкл' : 'Обводка прицела: выкл', keepOpen: true };
  const physicsItem = {
    label: 'Мишени',
    children: [
      { label: 'Зареспавнить мишени' }, // все мишени снова на стойках, пробоины стёрты
      { label: targetPhysics ? 'Физика мишеней: вкл' : 'Физика мишеней: выкл', keepOpen: true },
      outlineItem,
      // «Сбросить счёт» (RESET_SCORE) убран: счёта нет ни в одной сцене (compositions.js)
    ],
  };
  // сохранённые сцены по именам: у каждой «Продолжить» (как было) и «Рестарт» (заново); сохранить
  // мир как новую сцену; очистить всё
  const scenesItem = {
    label: SCENES_MENU,
    children: [
      ...scenes.map((name) => ({ label: name, children: [{ label: SCENE_CONTINUE }, { label: SCENE_RESTART }] })),
      { label: SAVE_NEW },
      { label: CLEAR_ALL },
    ],
  };
  // настройки: «Отцентрировать» (ctx.recenter: где стоишь и куда смотришь — начало мира),
  // «Расстояние между глазами» открывает панель IPD (ipd-panel.js)
  const timeLabel = `Время: ×${String(timeScale).replace('.', ',')}`;
  const settingsItem = { label: 'Настройки', children: [{ label: 'Отцентрировать' }, { label: 'Расстояние между глазами' }, { label: timeLabel, keepOpen: true }, { label: inertia ? 'Инерция: вкл' : 'Инерция: выкл', keepOpen: true }, { label: prone ? 'Режим лёжа: вкл' : 'Режим лёжа: выкл' }, { label: tracersOff ? 'Трассеры: выкл' : 'Трассеры: вкл', keepOpen: true }, { label: shake === 0 ? 'Тряска: выкл' : shake === 2 ? 'Тряска: сильно' : 'Тряска: вкл', keepOpen: true }, { label: RESET_GUN_SIZES }, ...(allies === null ? [towerItem] : [])] };
  const dogsItem = allies === null ? [] : [{ label: DOGS_MENU, children: [{ label: allies ? 'Союзники: вкл' : 'Союзники: выкл', keepOpen: true }, towerItem, ...(drones === null ? [] : [{ label: drones ? DRONES_ON : DRONES_OFF, keepOpen: true }]), ...(artillery === null ? [] : [{ label: artillery ? ARTILLERY_ON : ARTILLERY_OFF, keepOpen: true }])] }];
  const common = [...(features.targets ? [physicsItem] : []), ...dogsItem, scenesItem, settingsItem];
  if (heldKind === 'remote') {
    // пульт «Моего дрона» в руке (my-drone.js; управления дроном с пульта пока нет)
    // меню с пультом открывается кнопкой «≡» (controls-map.js)
    return { title: 'Пульт', items: [{ label: droneAutopilot ? MY_DRONE_AUTOPILOT_ON : MY_DRONE_AUTOPILOT_OFF, keepOpen: true }, { label: MY_DRONE_REGRIP }, { label: MY_DRONE_RELEASE }, { label: MY_DRONE_REMOVE }, { label: MY_DRONE_RECALL }] };
  }
  if (heldKind === 'plate') {
    // глиняная тарелка в руке: курок не стреляет, а взводит бросок (clays.js)
    return { title: 'Тарелка', items: [...carItems, { label: 'Удалить тарелку' }, ...common] };
  }
  if (heldKind) {
    // оружие в руке: перенастроить его посадку (оно замирает, джойстик переставляют, второй хват
    // приклеивает; у пистолета и калаша посадка своя) или убрать его совсем
    return { title: genEntry(heldKind)?.name ?? (heldKind === 'ak' ? 'Калаш' : heldKind === 'ak2' ? 'Калаш 2.0' : heldKind === 'awp' ? 'АВП' : 'Пистолет'), items: [
        ...carItems,
        { label: 'Перенастроить оси' },
        { label: 'Удалить оружие' },
        { label: laser ? 'Лазерный прицел: вкл' : 'Лазерный прицел: выкл', keepOpen: true },
        { label: 'Цвет прицела' }, // закрывает колесо и открывает панель laser-panel.js
        ...(genEntry(heldKind)?.modes?.length > 1 ? [{ label: `${FIRE_MODE_PREFIX} ${fireMode === 'auto' ? 'авто' : 'полуавтомат'}`, keepOpen: true }] : []),
        ...(heldKind === 'awp' || heldKind === 'ak2' || (genEntry(heldKind)?.scope || genEntry(heldKind)?.addScope) ? [{ label: scopeDebug ? 'Отладка прицела: вкл' : 'Отладка прицела: выкл', keepOpen: true }] : []),
      ],
    };
  }
  // руки свободны: новое оружие (каждый раз ещё одно) и режим хвата (в подписи текущий режим)
  const spawnItems = features.spawn
    ? [
        // всё, что можно заспавнить, — в одном подменю (onMenu смотрит только на подпись пункта)
        // сгенерированные пушки (generated-guns.js): «Заспавнить <name>»; больше трёх — своим подменю
        { label: 'Заспавнить', children: [{ label: 'Заспавнить пистолет' }, { label: 'Заспавнить калаш' }, { label: 'Заспавнить калаш 2.0' }, { label: 'Заспавнить АВП' }, { label: 'Заспавнить тарелку' }, { label: MY_DRONE_SPAWN, children: MY_DRONE_SIZES.map((label) => ({ label })) },
          ...(GENERATED_GUNS.length > 3 ? [{ label: 'Новые пушки', children: GENERATED_GUNS.map((g) => ({ label: genSpawnLabel(g) })) }] : GENERATED_GUNS.map((g) => ({ label: genSpawnLabel(g) })))] },
        { label: gripMode === 'hold' ? 'Хват: держать' : 'Хват: нажать' },
      ]
    : [];
  return { title: 'Меню', items: [...carItems, ...spawnItems, ...common] };
}
