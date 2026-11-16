// Радиальное меню на джойстике. Живёт в сцене, чтобы добавление и правка пунктов подхватывались
// на лету, без перезагрузки страницы (запись голоса и положение в мире не сбрасываются).
//
// Пункт: { label } или { label, children: [пункты] } (подменю). Что делает выбранный пункт,
// решает `onMenu(picked)` в main.js: picked = { path: ['Подменю', 'Пункт'], label: 'Пункт' }.
// Меню собирается заново, когда меняется состояние: что игрок держит (heldKind: 'pistol' | 'ak' |
// 'plate' | null), режим хвата, активная сцена (compositions.js) и список сохранённых сцен.
//
// Сцены: features активной сцены решают, какие пункты есть (targets — «Мишени», spawn —
// «Заспавнить» и «Хват», score — «Сбросить счёт»). «Сцены ▸» и «Настройки ▸» есть всегда, кроме
// меню с оружием в руке (там только пункты оружия).
export const SCENES_MENU = 'Сцены';
export const SAVE_NEW = 'Сохранить как новую';
export const CLEAR_ALL = 'Очистить всё';
export const SCENE_CONTINUE = 'Продолжить';
export const SCENE_RESTART = 'Рестарт';
export const RESET_SCORE = 'Сбросить счёт';
// машина (car-drive.js): первый пункт любого меню в сцене с функцией «car»
export const CAR_ENTER = 'Сесть за руль';
export const CAR_EXIT = 'Выйти из машины';

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
}) {
  const carItems = car ? [{ label: car === 'in' ? CAR_EXIT : CAR_ENTER }] : [];
  const outlineItem = { label: aimOutline ? 'Обводка прицела: вкл' : 'Обводка прицела: выкл', keepOpen: true };
  const physicsItem = {
    label: 'Мишени',
    children: [
      { label: targetPhysics ? 'Физика мишеней: вкл' : 'Физика мишеней: выкл', keepOpen: true },
      outlineItem,
      ...(features.score ? [{ label: RESET_SCORE }] : []), // счёт (score.js) — только в сценах со счётом
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
  const settingsItem = { label: 'Настройки', children: [{ label: 'Отцентрировать' }, { label: 'Расстояние между глазами' }] };
  const common = [...(features.targets ? [physicsItem] : []), scenesItem, settingsItem];
  if (heldKind === 'plate') {
    // глиняная тарелка в руке: курок не стреляет, а взводит бросок (clays.js)
    return { title: 'Тарелка', items: [...carItems, { label: 'Удалить тарелку' }, ...common] };
  }
  if (heldKind) {
    // оружие в руке: перенастроить его посадку (оно замирает, джойстик переставляют, второй хват
    // приклеивает; у пистолета и калаша посадка своя) или убрать его совсем
    return { title: heldKind === 'ak' ? 'Калаш' : 'Пистолет', items: [
        ...carItems,
        { label: 'Перенастроить оси' },
        { label: 'Удалить оружие' },
        { label: laser ? 'Лазерный прицел: вкл' : 'Лазерный прицел: выкл', keepOpen: true },
        { label: 'Цвет прицела' }, // закрывает колесо и открывает панель laser-panel.js
      ],
    };
  }
  // руки свободны: новое оружие (каждый раз ещё одно) и режим хвата (в подписи текущий режим)
  const spawnItems = features.spawn
    ? [
        // всё, что можно заспавнить, — в одном подменю (onMenu смотрит только на подпись пункта)
        { label: 'Заспавнить', children: [{ label: 'Заспавнить пистолет' }, { label: 'Заспавнить калаш' }, { label: 'Заспавнить тарелку' }] },
        { label: gripMode === 'hold' ? 'Хват: держать' : 'Хват: нажать' },
      ]
    : [];
  return { title: 'Меню', items: [...carItems, ...spawnItems, ...common] };
}
