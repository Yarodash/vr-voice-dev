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
Outline = same parts slightly larger, `BackSide`, white; visible when near/recalibrating/just released.

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
- Spawn (`spawnWeapon(kind)`): new item placed at the hand seat (not attached) or 0.55 m in
  front of the head if no hand; grab it with the grip.
- Delete: `Удалить оружие` removes the held one.
- `GUNS[kind]` holds firing params ([shooting-targets-score.md](shooting-targets-score.md)).
  `CALIB_KEYS` lists kinds with their own calibration.

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

## Where to hook a new item

- New weapon kind: [recipes.md](recipes.md#new-weapon-kind).
- Gun from a generated picture/model (kind `'gen:<id>'`, registry `scene/generated-guns.js`,
  placeholder → card → GLB, scope/trigger/modes): [recipes.md](recipes.md#сгенерированная-пушка).
- New generic grabbable: self-contained module with an `update({...})` like text-test, called in
  the grip section of `update`, plus `!myThing.held` in the near-search guard and in `handBusy`
  of other items. See [recipes.md](recipes.md#new-grabbable-item).
