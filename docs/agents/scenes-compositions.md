# Scenes (compositions) and feature flags

Files: `scene/compositions.js` (storage + snapshot helpers), `scene/main.js` (`scenes` object,
`applyScene`, live saving, `onMenu` for `Сцены ▸`), `scene/menu.js` (features decide items).
`saves/scene-1.json` is a manual export of `scene.compositions` (not read by code).

## Data

```js
// localStorage 'scene.compositions'
[{ name: 'Сцена 1', savedAt: ISO, features: {...}, data: Snapshot|null, live: Snapshot }]
// localStorage 'scene.active' (+ shared.activeScene)
{ name: 'Сцена 1' | null, features: {...} }      // no key at all = legacy range: RANGE_FEATURES
// Snapshot (compositions.snapshot)
{ version: 1, car?: {p, yaw}, weapons: [{kind, position, quaternion}], clays: [{p, q}],
  targets: {layout, stands, bodies, decals} | null, score: {score, streak} | null }
```
Numbers are rounded to 5 decimals.

Feature flags (only main.js and menu.js read them):
```js
RANGE_FEATURES = { targets: true, spawn: true, xPlate: true, score: false, car: false, robodog: false, robodogHorde: false }
EMPTY_FEATURES = { ...all false }
```
`score` is forced off everywhere (the `features()` normalizer sets `score: false`; menu item
«Сбросить счёт» removed; score.js kept unused). `robodog` — single wandering robot dog (robodog.js,
on in no scene now; snapshot `robodog: { alive }`). `robodogHorde` — «Сцена 3»: dogs spawn
25–40 m ahead, run at the player and leap (robodog-horde.js; nothing in the snapshot; Restart/Continue
= fresh horde). One-time `migrateHordeScenes()` (`scene.hordeMigrated`): score off in all scenes,
robodog off in «Сцена 1», adds «Сцена 3» (empty world, `HORDE_FEATURES`).
`targets` — targets exist + `Мишени ▸`; `spawn` — `Заспавнить ▸` and `Хват:`; `xPlate` — X spawns
a clay; `score` — score plate + `Сбросить счёт` (defaults to `targets` for old saves); `car` — car.

## API (compositions.js)

`loadCompositions()`, `saveCompositions(list) -> bool`, `readActive(shared)`,
`writeActive(shared, name, features)`, `storeLive(name, json)`, `storeCarPose(name, pose)`,
`migrateCarScene()` (one-time, `scene.carMigrated`), `nextName(list)` (`Сцена N`),
`snapshot({ pistols, clays, shooting, score, car })`, `freshOf(data)` (Restart: weapons kept,
targets standing without holes, no clays, score 0, car kept).

`__sceneState.scenes` (scene/main.js): `list()`, `active()`, `snapshot()`, `saveLive()`,
`saveNew(name?) -> name|null`, `restore(name, 'continue'|'restart') -> bool`, `clear()`.

## Flow

- Menu `Сцены ▸ <name> ▸ Продолжить` -> `restore(name, 'continue')` uses `live ?? data`;
  `Рестарт` -> `freshOf(data)`; `Сохранить как новую` -> `saveNew()` (current world + active
  features); `Очистить всё` -> active = `{ name: null, features: EMPTY_FEATURES }`.
- `applyScene(data, features)`: car, drop held refs, remove all weapons, add saved weapons,
  `clays.setAll`, `shooting.setTargets(features.targets ? data.targets ?? {} : null)`,
  `score.set`, `score.setVisible`. After any of these `menuKey = ''` to rebuild the menu.
- `saveLive()` every 3 s in `update`, on `pagehide`/hidden, in `dispose`, and before switching;
  writes only when the JSON changed.
- Page reload: weapons and clays restore themselves from their own keys; targets and score come
  from the active scene's `live` (`reloaded` flags).

## Adding a feature to scenes

1. Add the flag to `EMPTY_FEATURES` (and `RANGE_FEATURES` if the range should have it).
2. Read `active.features.<flag>` in main.js (`setup` and `applyScene`); in menu.js gate items
   with `features.<flag>`.
3. If it has state: add it to `snapshot()` and `freshOf()`, apply it in `applyScene` (pattern:
   `applyCar`).
4. There is no menu to edit a scene's features; enable it for an existing scene with a one-time
   migration (pattern: `migrateCarScene`) or ask the dispatcher. Recipe:
   [recipes.md](recipes.md#add-a-scene-feature-flag).
