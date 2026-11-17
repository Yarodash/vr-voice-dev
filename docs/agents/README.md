# Agent map of VR Voice Dev (start here)

A WebXR page (three.js r187, Vite) for Quest 3S. The user stands in the headset, dictates by voice,
and a Claude Code session on the PC edits the code; the scene hot-swaps without a page reload and
without leaving VR. User-facing rules are in `CLAUDE.md` (Russian); this folder is the code map.
Code comments in `web/src/scene/` are Russian and accurate; they are the second source of truth.

## 60-second mental model

- **Shell** = `web/src/*.js` (renderer, XR session, mic, controller, radial wheel, HUD message
  windows, remote console). Editing any shell file **reloads the page** (loses recording, closes
  the wheel). Before a shell edit check `npm run vr:eval -- "recording"` is `false`.
- **Scene** = `web/src/scene/*.js`. Entry `scene/main.js` exports `setup(ctx)` returning
  `{ update(dt), dispose(), onMenu(picked) }`. Vite HMR re-runs the **whole** scene on any scene
  file change: old `dispose()` -> host empties `ctx.root` -> new `setup(ctx)`. Module-level
  variables in scene files are re-created each swap.
- **`ctx`** (from `web/src/main.js`): `THREE, root, scene, camera, renderer, pointerAim,
  getLeftController(), setMenu(menu), setHud(cfg), setMapper(map), menuOpen(), recenter()`.
- **State that must survive a swap** lives in `globalThis.__sceneState` (each module does
  `const shared = (globalThis.__sceneState ??= {})`). State that must survive a page reload goes to
  `localStorage` under `scene.*` keys (always inside `try/catch`). Full key list:
  [scene-lifecycle.md](scene-lifecycle.md#persisted-state).
- **Frame**: shell `setAnimationLoop` -> `controls.tick` (button map -> actions; a short Y press
  confirms the wheel and calls `onMenu` **before** `update` in the same frame) -> HUD/wheel ->
  `sceneHost.update(dt)` -> `renderer.render` -> screenshot tick.
- **Scene `update(dt)` order** (scene/main.js): `fps.beginFrame` -> `world.update` ->
  `sound.update(camera)` -> `fps.update` -> find left gamepad source -> `ipd.update` ->
  `laserPanel.update` -> compute `menuIsOpen` (wheel open this or last frame, or a panel busy) ->
  grip: nearest item search, `textTest.update`, grab/release/recalibrate -> hold-mode release ->
  trigger: clay grab/throw -> X spawns clay -> `fire()` -> recoil/climb -> place held weapon ->
  flash/outline paint -> aim (`shooting.aim`, laser) -> `shooting/car/clays/messageHoles/score
  .update` -> periodic `saveLive` (3 s) -> rebuild menu if `menuKey` changed -> `pistols.save`.
  Details: [scene-lifecycle.md](scene-lifecycle.md).

## Verify (no unit tests, no sleep)

| What | Command |
|---|---|
| Did the page accept the scene? | `npm run scene:check` -> `OK` (0) / error (1) / not connected (2) |
| Run JS on the page | `npm run vr:eval -- "expr"`, `--file x.js` (use `return`), `--timeout 30` |
| Screenshot | `npm run vr:shot` -> prints a path in `logs/screenshots/`; open it with Read |
| Console + `[perf]` lines | tail `logs/page-console.log` (lines tagged `[quest]` / `[desktop]`) |

When two pages are connected, every eval answer is prefixed `[quest]` or `[desktop]`; read the
`[quest]` one. Debug handles on `__sceneState`: `scenes, shooting, weaponDebug, clayDebug, car,
ipd, laserPanel, textTest, sound`. See [perf.md](perf.md) and [recipes.md](recipes.md#verify).

## Rules for agents

- No `sleep` in commands; poll the real condition (`scene:check`, eval, a log line).
- No unit tests (do not write or run vitest/pytest). Verify live.
- No commits / pushes.
- Edit `web/src/scene/` only, unless asked to change the shell; shell edits need `recording`
  false first. `bridge/` edits need a bridge restart (ask).
- Do not act in the headset: don't spawn/fire/move the user's items, don't run
  `scripts/e2e_voice.py` (fake dictation mixes into the user's real draft), don't call
  `scripts/vr-say.mjs` unless you are the session talking to the user. Read-only evals and
  screenshots are fine.
- Other agents may be editing scene files at the same time: re-read a file right before editing,
  keep edits local, don't reformat.
- After every scene edit: `npm run scene:check`; fix errors yourself.
- `python` from PATH is wrong here; use `.venv\Scripts\python`.

## Topic files

| File | One line |
|---|---|
| [scene-lifecycle.md](scene-lifecycle.md) | SceneHost, ctx, hot-swap ownership, `__sceneState`, persisted keys, update/dispose order, general gotchas |
| [input-and-controls.md](input-and-controls.md) | Left Touch buttons, ControlMap (`controls-map.js`), reading the gamepad in the scene, edge detection, `menuIsOpen`/busy gating, controller model and axes |
| [menu.md](menu.md) | Radial wheel (`radial-menu.js`), `buildMenu` (`scene/menu.js`), `onMenu`, submenus, `keepOpen` toggles, menu rebuild key |
| [items-and-grabbing.md](items-and-grabbing.md) | Weapons (`pistols.js`, models), absolute grab + axis recalibration, relative grab (`relative-grab.js`), clays as items, text test board |
| [shooting-targets-score.md](shooting-targets-score.md) | `fire()`, GUNS table, `shooting.js` API, targets physics/shadows, clays as targets, score, laser sight + colour panel, robodog horde, quadcopters (`drones.js`) |
| [effects-and-sound.md](effects-and-sound.md) | `effects.js`, `smoke.js`, `tracer.js`, AK flash; `sound.js` (3D, near field, samples, `SOUND_VERSION`) |
| [world-and-sky.md](world-and-sky.md) | `world.js`: sky/clouds/stars/ground/grass shaders, ground height, tone mapping, baked shadows; car (in progress) |
| [hud-and-messages.md](hud-and-messages.md) | Shell HUD (message windows, dot), `hud.js` config, attaching to the HUD, `message-holes.js` shader patch, render orders, text test board (in progress) |
| [panels.md](panels.md) | World-space canvas panels with stick input: IPD (`ipd-panel.js`), laser colour (`laser-panel.js`) |
| [scenes-compositions.md](scenes-compositions.md) | Saved scenes, `features` flags, `snapshot`/`freshOf`, live save, Continue/Restart |
| [perf.md](perf.md) | `[perf]` telemetry, 120 Hz budget, Quest-specific costs |
| [bridge-and-voice.md](bridge-and-voice.md) | Python bridge, `/inbox` `/say` `/eval`, pairing, logs, dictation pipeline |
| [recipes.md](recipes.md) | Step-by-step: menu item/submenu/toggle, feature flag, grabbable item, sound, effect, panel, per-frame system, verify |

In progress tonight (check the file before relying on it): **car** (`car.js`, `car-model.js`:
display only, steering animates by itself, enabled by scene feature `car`) and the **text test board** (`text-test.js`: kept as a tool but NOT created any more — `main.js` uses a
stub `textTest = { held:false, update(){}, dispose(){} }`; the user picked variant 3, now applied to the message windows in `web/src/message-panel.js`: 2× canvas, trilinear mipmaps, anisotropy 16, LOD bias −0.5).

Design background: `docs/superpowers/specs/2026-11-16-vr-voice-dev-design.md`.
