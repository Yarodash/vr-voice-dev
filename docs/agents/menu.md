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
- `heldKind === 'plate'` (title Тарелка): `Удалить тарелку`, + common.
- empty hand (title Меню): if `features.spawn`: `Заспавнить ▸ {Заспавнить пистолет, Заспавнить
  калаш, Заспавнить тарелку}`, `Хват: нажать|держать`; + common.
- common: if `features.targets`: `Мишени ▸ {Физика мишеней: вкл/выкл (keepOpen), Обводка
  прицела: вкл/выкл (keepOpen), [Сбросить счёт if features.score]}`; `Сцены ▸ {<name> ▸
  {Продолжить, Рестарт}…, Сохранить как новую, Очистить всё}`; `Настройки ▸ {Отцентрировать,
  Расстояние между глазами, Время: ×N (keepOpen), Инерция: вкл/выкл (keepOpen, inertia.js)}`.

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
