# Radial menu

Files: shell `web/src/radial-menu.js` (drawing, stick, confirm; edit = page reload),
scene `web/src/scene/menu.js` (`buildMenu` — what items exist; hot-swapped),
scene `web/src/scene/main.js` (`menuState`, `onMenu`, menu rebuild key).

## Data shape

```js
menu = { title: 'Меню', items: [ item, ... ] }
item = { label: 'Текст' }                                  // plain: closes the wheel, calls onMenu
     | { label: 'Группа', children: [item, ...] }          // submenu (sector shows ▸)
     | { label: 'Физика мишеней: вкл', keepOpen: true }   // toggle: wheel stays open
     | { label: '…', back: true }                         // leads out of a submenu (unused now)
picked = { path: ['Группа', 'Пункт'], label: 'Пункт' }     // what onMenu receives
```

## How it flows

1. `setup` calls `ctx.setMenu(buildMenu(menuState()))`.
2. User: Y tap opens the wheel; stick picks a sector (last pick stays when the stick returns to
   centre; pushing the opposite way clears it); Y tap confirms. Confirm in the centre = back one
   level / close. Grip (`'grip'` action) closes the wheel from any level.
3. On a plain or `keepOpen` item the shell logs `[wheel] выбрано: A > B` to
   `logs/page-console.log` and calls `sceneInstance.onMenu(picked)` (before the scene `update` of
   that frame).
4. Every frame `update` computes
   `key = \`${heldKind}|${gripMode}|${shared.targetPhysics}|${shared.aimOutline}|${shared.laser}\``
   and calls `ctx.setMenu(buildMenu(menuState(heldKind)))` when it changes. Scene actions that
   change the menu otherwise (save/restore/clear scenes) reset `menuKey = ''`.
5. `radial-menu.js tick()` notices a new menu object while open and re-resolves the current
   path by labels, keeping the hovered sector — this is how `keepOpen` toggles relabel live.

## buildMenu (scene/menu.js)

```js
export function buildMenu({ holdingPistol, heldKind, gripMode, targetPhysics = true,
  aimOutline = true, laser = false, features = { targets: true, spawn: true }, scenes = [] })
export const SCENES_MENU = 'Сцены', SAVE_NEW = 'Сохранить как новую', CLEAR_ALL = 'Очистить всё',
  SCENE_CONTINUE = 'Продолжить', SCENE_RESTART = 'Рестарт', RESET_SCORE = 'Сбросить счёт';
```
Current tree:
- `heldKind === 'pistol' | 'ak'` (title Пистолет/Калаш): `Перенастроить оси`, `Удалить оружие`,
  `Лазерный прицел: вкл/выкл` (keepOpen), `Цвет прицела`. (Only weapon items.)
  `Перенастроить оси` also starts `gunResize` (`scene/gun-resize.js`): while the gun is frozen,
  stick X scales it around the grip (×1.6/s at full deflection, 0.3…3, deadzone 0.2; the stick must
  first return to centre), label «Размер ×1,25» above the grip; the re-grab commits seat + size.
- `heldKind === 'plate'` (title Тарелка): `Удалить тарелку`, + common.
- `heldKind === 'binoculars'` (title Бинокль, `scene/binoculars.js`): `Удалить бинокль` (`BINO_REMOVE`),
  `Перенастроить хват` (label shared with the remote; onMenu routes it to the binoculars when they are
  held), + common. Spawn: `Заспавнить ▸ Бинокль` (`BINO_SPAWN`).
- empty hand (title Меню): if `features.spawn`: `Заспавнить ▸ {Заспавнить пистолет, Заспавнить
  калаш, Заспавнить тарелку, Мой дрон ▸ {маленький, средний, большой, огромный}, …}`,
  `Хват: нажать|держать`; + common. Drone sizes: `MY_DRONE_SIZES` (index = size), onMenu checks
  `picked.path.includes(MY_DRONE_SPAWN)`.
- `heldKind === 'remote'` (pult of the personal drone, `scene/my-drone.js`; main.js passes it when
  `myDrone.held`; title Пульт): `Дрон ко мне` (`MY_DRONE_RECALL`), `Удалить` (`MY_DRONE_REMOVE`: remote + drone together),
  + common. Labels are exported constants (`MY_DRONE_SPAWN = 'Мой дрон'` too).
- common also holds `Погода и небо ▸ {Погода ▸ {Ясно и облака ▸, Дождь ▸, Снег и лёд ▸, Туман и ветер ▸},
  Время суток ▸ {Утро и день ▸, Вечер и ночь ▸}, Сезон ▸, Небо ▸, Течение суток: стоит|10 мин|30 мин|2 ч
  (keepOpen), Авто-погода: вкл/выкл (keepOpen)}` (before `Сцены`; `buildMenu({ atmo })` = `atmosphere.target`;
  the current choice is prefixed `● ` (`ATMO_MARK`); `onMenu` checks `picked.path[0] === ATMO_MENU`, strips the
  mark and finds the id by the Russian name; rebuild key includes `atmosphere.rev`; see [atmosphere.md](atmosphere.md)).
- common: if `features.targets`: `Мишени ▸ {Физика мишеней: вкл/выкл (keepOpen), Обводка
  прицела: вкл/выкл (keepOpen), [Сбросить счёт if features.score]}`; `Сцены ▸ {<name> ▸
  {Продолжить, Рестарт}…, Сохранить как новую, Очистить всё}`; `Настройки ▸ {Отцентрировать,
  Расстояние между глазами, Время: ×N (keepOpen), Инерция: вкл/выкл (keepOpen, inertia.js), …,
  Тряска: вкл/сильно/выкл (keepOpen, cycles; shake.js, `scene.shake`), Сбросить размеры оружия
  (`RESET_GUN_SIZES`: all `scene.scale.*` → 1, `resetGunScales` in gun-resize.js), Прицел: аркадный|реалистичный
  (keepOpen, `SCOPE_MODE_PREFIX = 'Прицел:'`; `shared.scopeMode` and `scene.scopeMode` = `'arcade'`
  (default) | `'realistic'`; also in the menu of a held
  scoped gun after «Отладка прицела» and in the binoculars menu)}`.

## onMenu dispatch (scene/main.js)

Matches mostly on `picked.label` (labels must be unique across the tree unless you check
`picked.path`). Scenes use `picked.path[0] === SCENES_MENU` and `picked.path[1]` = scene name.
Toggles use `picked.label.startsWith('Хват:')` etc. and flip `shared.x` + `localStorage`.

## Gotchas

- 8+ sectors get cramped; group into a submenu.
- A label containing state must be built from state passed into `buildMenu`, and that state must
  be part of `menuKey`, otherwise the label won't refresh.
- Opening a panel from the wheel: the confirming button is still held; panels use `releaseFirst`
  so that press doesn't immediately act (see [panels.md](panels.md)).
- `[wheel] выбрано:` lines are the way to verify a pick without the headset screenshot.
