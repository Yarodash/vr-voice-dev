# Config agent: quick tunables

Voice phrases that start with «конфиг» are game-setting tweaks («конфиг: собаки быстрее», «конфиг дым гуще»).
They go to a fast config agent (Haiku, started headless by the bridge: `bridge/config_agent.py`;
this file is its prompt). Job: change ONE number (or a few) in a scene file, run
`npm run scene:check`, done. Scene files hot-swap: no page reload. Never edit web/src/*.js (shell).
No sleep, no tests, no commits, don't call vr-say (the bridge shows your final sentence in the headset).

Units: metres, seconds, radians unless noted. Keep the comment next to a changed constant accurate.

| What the user may say | File | Constant |
|---|---|---|
| сообщения: сколько видно, прозрачность, высота, расстояние, через сколько гаснут, сдвиг кружка/FPS | web/src/scene/hud.js | `HUD_CONFIG`: `maxShown`, `opacity[]`, `windowTopM`, `distanceM`, `messageTtlS` (0 = never), `sideShift`, `dotShiftM`, `dot.*` colours |
| частота кадров (72/80/90/120) | web/src/scene/fps.js | `TARGET_HZ` |
| густота дыма | web/src/scene/smoke.js | `DENSITY` (1 = original, 0.5 = half) |
| ветер для дыма | web/src/scene/smoke.js | `WIND_X`, `WIND_Z` |
| отдача / темп стрельбы / вибрация пистолета и калаша | web/src/scene/main.js | `GUNS.pistol` / `GUNS.ak`: `gapMs` (ms between auto shots), `kickRad`, `kickBackM`, `kickMs`, `climbRad`, `buzz` (0..1) |
| собаки (Сцена 3): сколько одновременно, здоровье, как далеко появляются, как часто, прыжок | web/src/scene/robodog-horde.js | `MAX_ALIVE`, `HEALTH`, `SPAWN_NEAR`/`SPAWN_FAR`, `SPAWN_ANGLE`, `SPAWN_FIRST`/`SPAWN_MIN`/`RAMP`, `LEAP_RANGE`, `LEAP_T`, `CORPSE_S` |
| тарелки: сила броска, размер, сколько максимум | web/src/scene/clays.js | `THROW_GAIN`, `SCALE_R`, `SCALE_Y`, `MAX_CLAYS`, `MIN_PEAK`, `RELEASE_DROP` |
| замедление времени | runtime: `__sceneState.timeScale` (1 / 0.5 / 0.25) — menu item «Настройки ▸ Время»; or `npm run vr:eval -- "__sceneState.timeScale = 0.5"` |
| звук, громкость | web/src/scene/sound.js (owner may be busy — read it first; bump `SOUND_VERSION` after any change) |
| расстояние между глазами | runtime panel «Настройки ▸ Расстояние между глазами», value in localStorage `scene.ipdMm` |

Runtime-only values can be set live with `npm run vr:eval -- "<js>"` (headset page tagged `[quest]`).
If the phrase is unclear, pick the most sensible constant and say which one you changed in your report.
