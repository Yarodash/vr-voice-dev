# Items and grabbing

Files: `scene/pistols.js` (weapon registry + persistence), `scene/pistol-model.js`,
`scene/ak-model.js` (+ `web/public/models/ak47/ak47.glb`, built by `scripts/build-ak47-model.mjs`),
`scene/relative-grab.js`, `scene/clays.js` (clay plates, kind `'plate'`), `scene/text-test.js`
(relatively-grabbed board, in progress), all wired in `scene/main.js`.

Two grab styles (user's terms):
- **«Абсолютно схватить»** (absolute): item snaps into a fixed seat in the hand
  (`held` matrix = calibration or axes × shift). Weapons, clays.
- **«Относительно схватить»** (relative): at grab time `offset = inverse(hand) × item`; each frame
  `item = hand × offset`. Item doesn't jump. Text test board (`relative-grab.js`).

Grip modes (menu `Хват: нажать|держать`, `scene.gripMode`): `'toggle'` — press to take, press
again to release; `'hold'` — held while grip is down. Every grabbable must honour both.

## Weapon model contract

Model coordinate system: metres, barrel −Z, up +Y, grip centre (palm) at
`HANDLE = (0, -0.04, 0.045)`. Builders return:
```js
buildPistol(THREE, { outlineM }) -> { group, accent, outlineGeometry, muzzle: Vector3, ejector: Vector3 }
buildAk(THREE)                   -> { group, accent, muzzle, ejector, ready: Promise<outlineGeometry|null> }
```
`accent` is a `MeshStandardMaterial` whose `emissive` glows when held/near (`paintPistols`).
`muzzle`/`ejector` are local points used by `fire()`. Pistol meshes are merged per material
(8 draw calls). AK geometry is loaded once (`shared.akModel`, keyed by URL with `?v=1`); bump the
`?v=` when the .glb changes.

## pistols.js API

```js
const pistols = createPistols({ THREE, root });
pistols.items                     // [{ kind, group, accent, outline, muzzle, ejector }]
pistols.add(pose|null, kind)      // kind 'pistol' | 'ak' (KINDS); pose {position[3], quaternion[4]}
pistols.remove(item)              // disposes its geometries/materials (not the shared outline material)
pistols.restore() -> { held, heldMatrix }  // held survives only a swap, not a reload
pistols.save(heldItem, heldMatrixArray, force)  // writes shared.pistols always; localStorage at most every 500 ms unless force
```
Outline = same parts slightly larger, `BackSide`; visible when near / ray-targeted / ray-held / just
released (hidden while recalibrating). Colour: LIGHT BLUE `0x7dd3fc` = within near-grab reach (grip
takes it now; wins), WHITE = ray target and the rest. `pistols.tintOutline(item, near)` (called in
`paintPistols`) swaps `outline`/`scopeOutline`/`fixedOutline` materials between the white material and
its lazily-made blue twin (`material.userData.nearTwin`, `shared`), no per-frame allocation.

## Absolute grab in scene/main.js (weapons)

- Near search: `distance(HANDLE in item space -> world, handPosition) < REACH (0.132 m)`; only if
  nothing is held/recalibrating and `!textTest.held`. A clay closer than the best weapon wins.
- On grab: `heldOffset(held, kind)`: if a saved calibration exists for that kind
  (`calibs[kind]`, keys `scene.pistol.calib`, `scene.ak.calib`) use it; else
  `axes.matrix × translate(PISTOL_SHIFT − HANDLE)`.
- Each frame: `pistolWorld.copy(gripWorld).multiply(held)` + recoil, then
  `decompose(group.position, group.quaternion, group.scale)`.
- **Recalibration** (menu `Перенастроить оси`): `recalibratingItem = heldItem; heldItem = null`
  (weapon freezes); the next grip press stores `calib = inverse(gripWorld) × item.matrixWorld`
  for that kind and re-grabs.
- **Size** (set during `Перенастроить оси`: stick X while frozen, the re-grab commits;
  `scene/gun-resize.js`, `start(item)` stores the unscaled frozen pose and rescales it around HANDLE): per kind (`'gen:<id>'` too) in
  `shared.gunScales` + localStorage `scene.scale.<kind>`. Held: `gunResize.apply(pistolWorld, kind)`
  right before the decompose = `× T(HANDLE)·S·T(−HANDLE)`, so the palm stays put and muzzle, flash,
  laser, trigger, outline and scope glass follow `group.matrixWorld`; `group.scale` = the size.
  Resting items: `pistols.add` sets `group.scale` (around the group origin). Recalibration strips it
  (`apply(calib, kind, true)`), so `calib` never contains the size. `gunScaleOf(kind)` reads it.
  Near-grab distance is divided by `max(1, group.scale.x)` (bigger gun, bigger reach). `ray-grab.js`:
  if the ray starts inside a gun's sphere and hits no front face, a reverse ray from behind the gun
  finds the exit face (the player stands inside a huge gun). Way out: `Настройки ▸ Сбросить размеры оружия`.
  While recalibrating the frozen gun is 80 % opaque: `gunResize.start` swaps each mesh material for a
  per-mesh clone (transparent, opacity ×0.8, depthWrite on; outline BackSide and lens ShaderMaterial
  untouched), `stop`/`dispose` put the originals back and dispose the clones; its outline is hidden.
- Spawn (`spawnWeapon(kind)`): new item placed at the hand seat (not attached) or 0.55 m in
  front of the head if no hand; grab it with the grip.
- Delete: `Удалить оружие` removes the held one.
- `GUNS[kind]` holds firing params ([shooting-targets-score.md](shooting-targets-score.md)).
  `CALIB_KEYS` lists kinds with their own calibration.

## Ray grab at a distance (ray-grab.js) — TRIGGER, «держу пушку лучом»

User's term for this state: **«держу пушку лучом»**. It does not shoot (user decided).

Empty hand, menu/panels closed, nothing in near reach (near grab, clays, scope-debug panel win),
not in the car: the controller ray (ray space −Z, `rayOf(hand)`, same as the shell beam) picks a
weapon up to 15 m. Pick = broad phase ray-vs-bounding-sphere (local sphere cached per item in
`item.rayBounds`, refreshed every 1 s) + exact `Raycaster` on the item's visible meshes (outline
`BackSide` skipped); nearest real hit wins — no proximity cone (user's request). A visible HUD mesh
(camera children: message windows, the green preview with its buttons) hit before the gun blocks
the pick, so the trigger presses the shell button instead. Target: white outline, own white beam +
dot to the hit point (shell beam hidden via `pointerAim.hideBeam = rayGrab.showing`), tiny buzz.
**Trigger** press on the target = «Относительно схватить»: `offset = inverse(gripWorld) ×
item.matrixWorld`, each frame `item = gripWorld × offset` (filtered by «Инерция»), beam to the
grabbed point; held while the trigger is down, released on trigger up (stays floating). Grip is
not involved. Stick Y while holding: forward = closer, back = farther along the ray, linear up to
3 m/s, grab point clamped to 0.3–15 m (`STICK_SPEED`, `STICK_FORWARD_PULLS`). Stick X: spin around the ray
axis through the grab point, up to 180°/s (`SPIN_SPEED`; right = clockwise looking along the ray). `rayGrab.item`
blocks near search / X spawn and is saved by `pistols.save`. Handle: `__sceneState.rayGrab`
(`target`, `item`, `showing`, `update({...})`).

## Clays as items (clays.js)

`spawn(position, quaternion)`, `held()`, `nearest(pos, maxDist=0.16)`, `grab(clay)`,
`drop(clay)`, `remove(clay)`, `place(clay, worldMatrix)`, `launch(clay, velocity, spin)`,
`updateHand(handPosition, dt, triggerDown, headForward)` (returns thrown clay or null),
`setNear(clay|null)` (outline), `setAll(poses)`, `list`, `debugThrow(i, vx, vy, vz)`.
States: `'rest'` (hangs in the air), `'held'`, `'fly'`. Grabbed by grip or trigger (trigger grab
arms the throw). Seat: `axes × translate(CLAY_OFFSET (0, 0.035, -0.1))`. Throw = trigger held +
swing: released when hand speed drops below 85 % of the peak (forward only), speed × 4.5.
Max 40 clays (oldest resting removed). One InstancedMesh for clays, one for shards.

## Relative grab (relative-grab.js)

```js
const grab = createRelativeGrab({ THREE, object });
grab.grab(hand.matrixWorld);   // at grip press
grab.update(hand.matrixWorld); // every frame (no-op when not held); respects object.parent
grab.release();
grab.held                      // boolean
```

## Text test board (text-test.js) — hidden (tool kept, not created)

`createTextTest({ THREE, root, camera, renderer, shared })` -> `{ board, respawn(), held,
update({...}), dispose() }`. Always created in `setup` (no menu item yet). 3×4 cells comparing
text rendering variants; grabbed relatively within 0.15 m of the board; frame colour shows
idle/near/held. Pose in `shared.textTestPose`. Handle: `__sceneState.textTest.respawn()`.
Its `update` is the cleanest template for a self-contained grabbable:
```js
textTest.update({ hand, gripWorld, handPosition, gripDown, gripWasDown, gripMode, menuIsOpen, source,
  handBusy: Boolean(heldItem || heldClay || recalibratingItem || nearItem || nearClay) });
```

## Personal drone + remote (my-drone.js)

Menu `Заспавнить ▸ Мой дрон ▸ маленький|средний|большой|огромный` → `myDrone.spawn(size 0–3)`:
ONE white/gold quadcopter (`drone-model.js` frame recoloured, gun merged in; 3 draw calls) 2.5 m +
1.5 span in front of the head + a remote (one merged mesh + screen quad + outline) 0.45 m in front,
screen to the player. Spawning again replaces the drone (new size) and moves the remote. Never
targeted, never damaged: it is not in `shared.droneTargets` nor `addShootable`. Held-remote menu
`Удалить` → `myDrone.remove()` (remote and drone together).
Sizes (`SIZES` in my-drone.js, like drones.js): span 0.45 / 0.9 / 2 / 5 m; frame light/light/heavy/
heavy (heavy: gun ×1.5); max speed 12 / 9 / 7 / 5 m/s, up 5 / 4 / 3.2 / 2.5 m/s (down ×0.85), yaw
2.2 / 1.75 / 1.2 / 0.7 rad/s, accel 13 / 10 / 6 / 3.5 m/s²; gun: pistol 8/s · ak 10/s · ak 7/s + big
flash · awp (×5 damage) 1.8/s + big flash; hum lower/louder/farther with size.
- Grab: «Абсолютно схватить» with the grip (both grip modes), only with a free hand (`handBusy`).
  Seat = `gripWorld × axes.matrix × SEAT` (`SEAT_POS` 7.5 cm above the grip along blue, tilted
  back `SEAT_TILT_DEG` 50° so the screen faces the eyes). Controller model and shell beam hidden while held.
- main.js hooks: `myDrone.hand({...})` in the grip section before `rayGrab.update` (returns
  'grab'/'release' → buzz); `!myDrone.held` in the near-weapon search, X-plate spawn, ray-grab
  `canPoint` (also `!myDrone.near`); `myDrone.update(realDt, source, menuIsOpen)` after
  `pistols.updateLenses`; `heldKind = 'remote'` for the menu.
- **NO CONTROLS YET** (user's decision: they will be added one element at a time). Holding the
  remote changes no button: Y records / opens the wheel, trigger, X, Z, «≡», stick as usual (the
  hand is just busy, like with a weapon: no X plate, no near grab, no ray grab). Release = grip per
  «Хват» mode. The drone hovers in place. controls-map.js has no drone logic.
- Ready but not wired to buttons (only `debug.input = { fwd, sx, sy, up, down, fire }` on the PC moves
  them): flight (real dt, not game time) `fwd` −1…1 along the nose, `sx` yaw, `up`/`down`; camera +
  aim pitch `st.camPitch` from `sy` (−60°…+30°, 70°/s, persists, saved as `c`); gun `fire` →
  `fireGun` = `shooting.shoot`
  — the player's hit path (dogs, legs, corpses, drones, targets, clays; player tracers; `sound.shot`
  = player sound, at the drone), `shared.shotKind`/`setWeapon` from the size, along the camera = the
  screen crosshair, cadence `size.gap` (taps can't beat it), hit → controller buzz. Response 2.2/s,
  accel ≤ `size.acc`, nose-down pitch from speed/accel, bank from yaw rate, hover wobble. Altitude
  (0.5 + 0.3 span)–60 m over `groundHeight` (car.js), ≤ 400 m from origin.
  Not held → brakes and holds position.
- Screen: drone camera (nose, yaw-stabilised, 12° down, fov 62°, `camera.far` so the sky dome is
  seen) → `shared.myDroneRT` 320×240 MSAA 2 (`isXRRenderTarget` + sRGB like scope-lens) at 25 fps,
  only while the remote is held; drone and screen hidden in its own pass, HUD hidden via `camera.visible`, scene
  `onBeforeRender/onAfterRender` muted. Shader adds crosshair, altitude bar (0–60 m), vignette; no
  signal → grey noise. Quest 3S measured: ~0.7 ms CPU per pass, 25 calls (≈ 0.2 ms/frame at 90 Hz).
  Log `[mydrone] cam n=… cpu=…` every 10 s while rendering.
- Sound: own persistent hum voice `shared.myDroneVoice` (loop of drone-sound's baked `hum` →
  HRTF panner → `audioGraph.master`, i.e. a PLAYER sound, not on the NPC bus/budget).
- State: `shared.myDrone` (survives swaps, incl. `held`), localStorage `scene.myDrone`
  `{ s: size, d: [x, y, z, yaw], r: { p, q } }` (held is not restored after a reload).
- Debug (desktop page only): `__sceneState.myDroneDebug.{ info(), input = { sx, sy, up, down, fire } | null,
  shot(pose?) -> { ms, calls }, api }`.

## Where to hook a new item

- New weapon kind: [recipes.md](recipes.md#new-weapon-kind).
- Gun from a generated picture/model (kind `'gen:<id>'`, registry `scene/generated-guns.js`,
  placeholder → card → GLB, scope/trigger/modes): [recipes.md](recipes.md#сгенерированная-пушка).
- New generic grabbable: self-contained module with an `update({...})` like text-test, called in
  the grip section of `update`, plus `!myThing.held` in the near-search guard and in `handBusy`
  of other items. See [recipes.md](recipes.md#new-grabbable-item).
