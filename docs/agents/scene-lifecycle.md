# Scene lifecycle, ctx, persistence, ownership

Files: `web/src/scene-host.js` (shell), `web/src/main.js` (shell: ctx, frame loop, HMR),
`web/src/scene/main.js` (scene entry, wires every subsystem).

## Contract

```js
// web/src/scene/main.js
export function setup(ctx) {          // must be synchronous (async setup is rejected)
  ...
  return { update(dt) {}, dispose() {}, onMenu(picked) {} };   // all optional
}
```

`SceneHost` (`scene-host.js`) swaps in two phases, **prepare then commit**, so a scene edit does
not freeze the headset:
- `swap(next)` (synchronous, in the HMR callback): while it runs, `dispose()` of every
  `BufferGeometry`, `Material`, `Texture` and `InstancedMesh` is **held back** (queued, not run).
  Old `dispose()` (exceptions caught -> `console.warn`) -> old `ctx.root` children move into a
  frozen group `scene-host-previous` that stays drawn (their own `onBeforeRender/onAfterRender`
  are muted) -> new `setup(ctx)` fills `ctx.root` -> `renderer.compileAsync`
  of what will be drawn (visible scene + the hidden root). If `setup` throws, the previous module
  is started again and the error is reported (`scene:check` shows it). **Usual case:** no new
  program and no texture to upload -> committed right inside `swap()`, the frozen copy is never
  drawn. Lights of the frozen copy are switched off and lights of the new root stay on (only its
  drawable objects are hidden), so the light setup during prepare equals the one after the commit
  (otherwise every lit material would compile a variant for the frozen frames).
- prepare (next frames, inside `update`, only if something is new): programs that are really new get their link wait taken
  one or two per frame (the Quest browser has no `KHR_parallel_shader_compile`, so this is where a
  new shader costs), then textures of drawn objects not yet on the GPU are uploaded
  (`renderer.initTexture`), ~6 ms of work per frame. The new `update` is not called yet; the old
  scene is frozen on screen. Timeout 3 s.
- commit (one frame): frozen group removed, `ctx.root` shown, new `update(dt)` runs the same frame.
  Two frames later the held-back disposes run, **except for what the live scene still draws with**
  (scene graph traversal: geometries, materials, material textures and uniform textures). So a
  material with the same shader reuses the old program (three shares programs by cache key while
  one user is alive), and textures/geometries cached in `__sceneState` are never re-uploaded.
- Timings of the last swap: `npm run vr:eval -- "sceneHost.lastSwap"`; each commit logs
  `[swap] dispose=… setup=… compile=… prepare=…ms/Nfr newProgs=N uploads=N` to the page console.
- `update(dt)`: an exception marks the scene `broken`: `update` is not called again until the next
  swap. One report, not 72/s.
- If the XR session is paused (headset off) a swap stays pending (root hidden, old copy frozen)
  until frames resume or the next swap arrives.
- `render(draw)`: an exception while drawing hides `ctx.root` and reports `ошибка отрисовки: …`.
- `dt` is seconds, clamped to 0.1.

HMR (`web/src/main.js`): `import.meta.hot.accept('./scene/main.js', …)`. Any change in any file
imported (transitively) by `scene/main.js` re-evaluates the scene modules and swaps. A syntax
error keeps the old scene running and reports `сцена не загрузилась` (scene:check then runs
`node --check` over scene files and prints file:line). Scene files may import shell helpers
(`../canvas-text.js`, `../ui-layout.js`), but editing those helpers reloads the page.
`three` is excluded from Vite pre-bundling, so a new `three/addons/...` import does not reload.

## ctx

| Field | What |
|---|---|
| `THREE` | the three module |
| `root` | `THREE.Group` owned by the scene; host empties it on swap and frees what the new scene no longer uses. While a swap is being prepared its meshes/points/lines are `visible=false` (lights stay on) |
| `scene`, `camera`, `renderer` | shell objects. `camera` is inside `rig` (recenter moves the rig) |
| `getLeftController()` | left **grip** space `Object3D` or `null` (the "hand"). Ray space: `renderer.xr.getController(i)` whose grip is the hand (see `rayOf` in scene/main.js) |
| `pointerAim` | `{ object }`: the wheel sits on this object; scene sets it to the controller axes group |
| `setMenu(menu)` | radial menu `{ title, items }` ([menu.md](menu.md)) |
| `setMapper(map)` | button map object with `step(nowMs, {buttons})` ([input-and-controls.md](input-and-controls.md)) |
| `setHud(cfg)` | HUD look ([hud-and-messages.md](hud-and-messages.md)) |
| `menuOpen()` | `true` while the wheel is open |
| `recenter()` | current head pose becomes origin; saved to `localStorage 'vr.rig'` |

## Update order (scene/main.js `update(dt)`)

0. `worldClock.begin(realDt)` -> `clock` (`dt = clock.total`, see «Game time»).
1. `fps.beginFrame()` (CPU frame cost starts here), `world.update(dt)`, `shared.sound?.update?.(camera)`, `fps.update()`.
2. `source` = first `session.inputSources` with `handedness === 'left' && gamepad && !hand`; `hand = ctx.getLeftController()`.
3. `menuNow = ctx.menuOpen()`; `ipd.update(source, menuNow || menuWasOpen)`; `laserPanel.update(...)`.
4. `menuIsOpen = menuNow || menuWasOpen || ipd.busy() || laserPanel.busy()`; `menuWasOpen = menuNow`
   (one-frame lag: the grip that closed the wheel must not also grab).
5. If `hand`: `showController`, hide the controller model while a weapon is held, `gripWorld`,
   `handPosition`, nearest weapon/clay (only with an empty hand), `textTest.update(...)`, grip
   rising edge -> recalibration glue / drop clay / release weapon / grab clay / grab weapon.
6. Hold-mode release; `gripWasDown = gripDown`.
7. Trigger: grab clay with trigger, place held clay, `clays.updateHand` (throw); `clays.setNear`.
8. X rising edge -> `spawnClay()` (if `features.xPlate`, hand empty, menu closed).
9. `fire(source)` if trigger (rising edge, or held for `auto` guns) and no panel blocks it.
10. Barrel climb recovery; held weapon pose = `gripWorld × held × recoil`.
11. `placeFlash()`, `paintPistols()`; aim: `shooting.aim`, `laserPanel.cast`, `laser.update`.
12. World substeps (`clock.n` × `clock.sub`): `shooting`, `clays`, `robodog`, `horde`, `drones`
    (car and casings are substepped earlier); then `messageHoles.update()`, `score.update(realDt)`.
13. Every 3 s `saveLive()` (active scene snapshot, written only if changed).
14. Rebuild the menu if `menuKey` (`heldKind|gripMode|targetPhysics|aimOutline|laser`) changed.
15. `pistols.save(...)` while something is held or the held item changed.

`dispose()` order matters: save pistols; free AK flash; `clays`, `laser`, `laserPanel`;
`saveLive()` **before** `shooting.dispose()` (the snapshot reads targets); remove window
listeners; `score`, `car`, `shooting`, `messageHoles`, `world`; `ipd.dispose()` **before**
`fps.dispose()` (both wrap `scene.onBeforeRender`, restore in reverse order); `textTest`; axes.
The real controller model (`shared.realModel`) is intentionally left on the hand.

## Ownership patterns (hot-swap safe)

- **Inside `root`**: freed by the host automatically. Still free what you create in your own
  `dispose()` if you allocate repeatedly.
- **Outside `root`** (children of `camera`/HUD group, `scene.add`, `scene.onBeforeRender`,
  `window`/`document` listeners, timers, patched shell materials): undo in `dispose()`.
- **Wrapping a hook**: keep `prev`, call it inside, restore only if still yours:
  `if (scene.onBeforeRender === hook) scene.onBeforeRender = prevBefore;` (ipd-panel.js).
- **Long-lived objects in `__sceneState`** with a version/key; rebuild on mismatch:
  `if (shared.sound?.version !== SOUND_VERSION) shared.sound = createSound();`
  (`soundBank.key = GUN_FILES + BAKE_VERSION + sampleRate`, `akModel.url`, `plateTextures.version`,
  `globalThis.__skyCloudMap.key = 'clumps-v3'`, `messageHolesVersion = 3`).
- **Find leftovers of an older scene version by name** and remove them before adding yours
  (score.js removes `scene-score*` children from the HUD).
- Calling `dispose()` on something cached and reused is harmless during a swap: the host skips it
  if the new scene still draws with it. Outside a swap `dispose()` runs at once as usual (three
  re-uploads a disposed texture/geometry on next use: correct, but a hitch).
- **Anything that costs > ~5 ms in `setup` must be cached** across swaps, keyed by the source of
  the function that builds it, so it rebuilds only when its own code changes:
  `if (shared.x?.key !== build.toString()) shared.x = { key: build.toString(), value: build() }`.
  Done: `shared.worldCache` (world.js: key `createWorld.toString()` — noise/cloud `DataTexture`s,
  ground geometry, grass instance matrices + attributes, baked grass-shadow render target; the stale
  cache is freed 5 s later), `shared.smokeTexture` (smoke.js), `shared.modelCache`
  (`scene/model-cache.js` `cachedBuild(buildFn, THREE, opts)`: weapon models built once, each item
  is a clone with its own nodes and materials and shared geometries/textures; used by pistols.js for
  pistol and AWP), plus the older `pistolTex`, wood/plate textures, `__skyCloudMap`, sounds.
- `dispose()` must never throw: a throw skips the rest of your cleanup. Wrap risky steps:
  `for (const step of steps) { try { step(); } catch (e) { console.warn('[x] dispose:', e); } }`
  (world.js).

## Persisted state

`localStorage` (survives reload; always `try/catch`):

| Key | Owner | Value |
|---|---|---|
| `vr.rig` | shell main.js | rig pose `{p,q}` (recenter) |
| `vr.messages` | shell | HUD messages shown |
| `pairCode` | shell | pairing code |
| `scene.gripMode` | scene/main.js | `'toggle'` / `'hold'` |
| `scene.targetPhysics` | scene/main.js | `'on'`/`'off'` |
| `scene.aimOutline` | scene/main.js | `'on'`/`'off'` |
| `scene.laser` | scene/main.js | `'on'`/`'off'` (default off) |
| `scene.inertia` | scene/main.js | `'on'`/`'off'` (default off), hand tremor filter `inertia.js` |
| `scene.artillery` | scene/main.js | `'on'`/`'off'` (default on), «Собаки ▸ Артиллерия» (artillery.js) |
| `scene.shake` | shake.js | `'1'` on (default) / `'2'` strong / `'0'` off — «Настройки ▸ Тряска» |
| `scene.atmo` | atmosphere.js | `{ weather, time, season, sky, flow, auto, hour }` — «Погода и небо ▸» ([atmosphere.md](atmosphere.md)) |
| `scene.pistol.calib`, `scene.ak.calib` | scene/main.js | 16-number hand->weapon matrix |
| `scene.pistols` | pistols.js | `{ list:[{kind,position,quaternion}], held:-1 }` (old: `scene.pistol`) |
| `scene.clays` | clays.js | resting clays `[{p,q}]` |
| `scene.compositions` | compositions.js | saved scenes `[{name,savedAt,features,data,live}]` |
| `scene.active` | compositions.js | `{ name, features }` |
| `scene.carMigrated` | compositions.js | one-time migration flag |
| `scene.laserColor` | laser-panel.js | `0xRRGGBB` as decimal string |
| `scene.ipdMm` | ipd-panel.js | number (mm) or absent |
| `scene.messageHoles3` | message-holes.js | holes per message key (last 12 messages) |

`globalThis.__sceneState` (survives swap, not reload): `targetPhysics, aimOutline, laser,
laserColor, activeScene, pistols, lastPistolStore, clays, score, targetStands, targetLayout,
targetBodies, targetDecals, woodTextures, plateTextures, akModel, akWoodMap, realModel, sound,
audioGraph, soundBank, soundCounters, previewBuffers, messageHoles, messageHolesRev, messageHolesVersion,
textTestPose, ipdMm, ipdNativeMm` + debug handles `scenes, shooting, weaponDebug, clayDebug, car,
ipd, laserPanel, textTest`; swap caches `worldCache, smokeTexture, modelCache`. Also
`globalThis.__skyCloudMap` (world.js).

Reload vs swap: weapons "in hand" survive only a swap (`pistols.restore()` uses
`shared.pistols`); after a reload targets and score come from the active scene's `live`
(`reloaded` flags in scene/main.js).

## General gotchas

- Units metres, floor y=0 (ground is flat within 6 m of origin, see world.js). Origin = play-area
  centre after recenter, not the player: place things from `camera.getWorldPosition/Direction`
  with `direction.y = 0; normalize()`.
- `world.js` sets `camera.far = 5000`, ACES tone mapping exposure 0.55, hides the shell
  GridHelper; it restores them in dispose.
- Top-right of the view is the HUD (messages); don't cover it.
- No per-frame allocations in hot paths: keep scratch `Vector3/Matrix4` in the closure.
- Time: see «Game time» below. World simulation never reads `performance.now()`.

## Game time (time multiplier, `scene/world-clock.js`)

«Настройки ▸ Время» sets `__sceneState.timeScale` (×0.25 … ×64). **Rule: game time =
`shared.sceneNowMs` / the scaled `dt` your `update(dt)` receives; never `performance.now()`,
`Date.now()`, `setTimeout` or a "one fixed step per frame" for world simulation.**
- `scene/main.js update(realDt)`: `worldClock.begin(realDt)` wants `realDt × timeScale` of world, cuts it
  into `clock.n` equal substeps `clock.sub ≤ 0.05 s` (`STEP_S`, = every system's own dt clamp),
  `n ≤ 8` (`MAX_SUB`) and within ~10 ms CPU (`BUDGET_MS`, measured cost per substep), and advances
  `shared.sceneNowMs` by exactly what will be simulated (`clock.total`). What does not fit is
  dropped, not caught up: the world runs slower than asked, and fps.js prints the honest speed
  (`×17/64` = 17 achieved of 64 asked). Ceiling 0.4 s of world per frame (×29 at 72 Hz); in a
  heavy horde battle on Quest ~×4–8 (one `horde.update` ≈ 3–5 ms). Handle: `__sceneState.worldClock`
  (`n, sub, total, wanted, costMs, fast, last, step`).
- **Fast mode (×32, ×64; `clock.fast`)**: the user trades fps for real speed. Substep `clock.step`
  0.1 s (×32) / 0.2 s (×64), world budget 30 / 48 ms per frame (15–25 fps, screen 72 Hz), and a hard
  cut after 80 ms (`worldClock.cut`, the rest is given back to the clock). Systems in the world loop
  must accept `dt` up to `MAX_STEP_S` (0.2) in fast mode (horde, drones, bullets, tracers, ragdoll
  accumulator); small ones get `fine` slices ≤ `STEP_S` (car, casings, clays, single robodog).
  **`clock.last`** (`shared.worldClock.last`) is false on all but the last substep of a frame: there
  do logic only — horde skips gait/pose of alive dogs (body still `follow()`s; jumping dogs pose every
  substep), instance buffers and sparks; drones skip `draw`, sparks and hum; visuals run once on the
  last substep with the accumulated dt (`fxAcc`). Horde ragdoll budget is `RAGDOLL_FAST` (1). Normal
  speed (`fast` false) takes exactly the old path. Per-system cost: `globalThis.__prof = { world: {}, sub: {} }`
  from `vr:eval`, read it back and set it to `null` (main.js world loop, horde `PS`).
- Called `clock.n` times with `clock.sub`: `carDrive.update` (car), `casings.update`, and the world
  block `shooting.update` (bullets, targets, smoke, tracers, impacts, mana), `clays.update`,
  `robodog.update`, `horde.update`, `drones.update`, `artillery.update`. Once with `dt = clock.total`: `world.update`
  (sky, clouds, star twinkle, grass wind — all analytic), `artillery.frame` (explosion particles). A new world system goes into that loop
  (or takes `dt` and clamps at 0.05 s); timers inside it count `dt`, not wall clock.
- Fixed-step physics inside a system: accumulate `dt`, step while `acc ≥ STEP`, cap `acc` at
  `0.05 + STEP` (robodog-ragdoll.js: 1/120 s, cap 7 steps).
- **Real time** (`realDt`, `performance.now()`), the player is never slowed or sped up: hand and
  inertia filter, clay throw hand velocity (`clays.updateHand(realDt)`), the gun in hand (fire rate
  `fire()`, recoil, climb recovery, muzzle flash `flash.until`, slide/bolt `pistols.kick/updateTriggers`),
  scope tilt stick, HUD, menu, panels, score popup, message holes, cracked glasses, camera shake,
  `saveLive` timer, generated-gun holo shimmer, sound rate limits. Sounds keep their pitch.
