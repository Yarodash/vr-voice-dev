# Shooting, targets, score, laser

Files: `scene/main.js` (`fire`, `GUNS`, recoil, aim, AK flash), `scene/shooting.js` (raycast,
decals, glue to effects/sound/targets/clays), `scene/targets.js` (stands, plates, physics,
shadows, aim outline), `scene/plate-texture.js` (plate texture, cached, `VERSION = 4`),
`scene/score.js`, `scene/laser.js`, `scene/laser-panel.js` ([panels.md](panels.md)),
`scene/message-holes.js` (bullets also hit HUD windows, [hud-and-messages.md](hud-and-messages.md)).

## fire(source) in scene/main.js

```js
const GUNS = {
  pistol: { gapMs: 140, auto: false, kickMs: 140, kickRad: 0.2,  kickBackM: 0,     climbRad: 0,    buzz: 0.8 },
  ak:     { gapMs: 100, auto: true,  kickMs: 85,  kickRad: 0.075, kickBackM: 0.014, climbRad: 0.03, buzz: 1 },
};
```
Per shot: rate limit by `gapMs` (auto fire keeps exact cadence), barrel climb, then
`shared.sound.setWeapon(kind)`, muzzle/ejector/barrel/right/up from `heldItem.group.matrixWorld`,
`messageHoles.hit(muzzle, barrel)` + `crackedGlasses.test` (instant — they are < 2 m away), laser
panel cast/shoot if open, `shooting.shoot(muzzle, barrel, { ejector, right, up | big, speed: gun.speed, onResult })`;
`onResult(hit)` fires when the bullet lands: `score.shot(hit)` if `features.score` and the colour
panel was closed, hit haptic. Fire haptic and AK flash are immediate. `GUNS[kind].speed` — muzzle
velocity m/s: pistol 360, ak 715, awp 900.
Called when `triggerDown && heldItem && !panelBusy && !laserPanel.blocksFire() && (!triggerWasDown || GUNS[kind].auto)`.
Recoil: rotation about `HANDLE` by `kickRad` fading over `kickMs` (+ `kickBackM` push) + climb,
applied when placing the held weapon. Debug: `__sceneState.weaponDebug.fire(index)` fires item
`index` as if held (acts in the user's world — avoid while they play).

## shooting.js API (`shared.shooting`)

```js
const shooting = createShooting({ THREE, root, camera });
shooting.shoot(muzzle, dir, { ejector, right, up, big, speed = 360, onResult(true|false|null) })  // launches a bullet
shooting.aim(muzzle|null, dir, range = 60, speed = 360) -> Vector3|null   // per frame: outline on the plate the BALLISTIC path hits (5 segments to range); returns the STRAIGHT-ray point for the laser
shooting.bullets() -> [{ age, speed, kind, x, y, z }]; shooting.aimedIndex()   // debug for vr:eval
shooting.castSegment(from, to) -> { point, normal, target, isStand } | null   // shared result object
shooting.hitTarget(target, point, dir, quiet)    // non-bullet hit (clays)
shooting.puff(point)                             // dust (effects.dust)
shooting.setClayTarget({ cast(origin, dir, far) -> distance|-1, hit(origin, dir, distance) } | null)
shooting.addShootable({ cast, hit -> true|false|null, shot?(origin, dir, far) }) -> remove()  // more targets (robodog.js); nearest of clay+shootables wins; shoot() returns null = "hit, not scored"
shooting.setTargetsEnabled(on); shooting.targetsEnabled()
shooting.getTargets() -> { layout, stands, bodies, decals } | null
shooting.setTargets(state | {} | null)           // {} = place fresh in front; null = no targets
shooting.placeInFront(gaze = true)
shooting.update(dt); shooting.dispose()
```
Bullets are projectiles with gravity (no drag): `p(t) = muzzle + dir·v·t − ½·9.81·t²` (analytic,
not Euler). Pool of 32 (oldest becomes a miss), stepped in `shooting.update(dt)` with the scene dt
(slow-mo slows them), clamp 0.05 s, cut into chords ≤ 1/60 s; each chord is cast against: ground
(`groundAt`, bisection) → plates+stands raycast (InstancedMesh, `instanceId` -> plate) → clay and
shootables (`castExtra`, nearest wins); `shot?()` of shootables gets every chord. First hit
resolves at that point and time: decal (`shared.targetDecals`), `targetSet.knock` with the
velocity direction at impact, `effects.impact`, delayed `sound.hit`; clay/dog `hit(chordStart,
chordDir, distance)` with `shared.shotKind` = the bullet's own kind; ground → dust (≤ 150 m from
the player). Life 3 s / 1500 m. Drop: 10 m — pistol 3.8 mm, AK 1 mm, AWP 0.6 mm; 100 m —
pistol 38 cm, AK 9.6 cm, AWP 6.1 cm. Muzzle flash, smoke, sound are at fire time.

## targets.js

Rows at 5/10/17/26/38 m (`ROWS`; `TARGET_LAYOUT = JSON.stringify(ROWS)` — changing rows re-places
targets after a swap). Exports `groundAt(x, z)` (same terrain formula as world.js),
`targetSpots(head, forward) -> [{x, z, yaw, near}]`, `TARGET_COUNT`, `createTargets(...)` ->
`{ plates, plateMesh, standMesh, place(spots, {resetFallen}), knock(plate, point, dir),
getBodies(), setBodies(saved), setAim(plate|null), update(dt), dispose() }`.
- Rigid-body physics per plate (impulse at hit point, gravity, ground bounce, substep 1/240),
  skipped when `shared.targetPhysics === false`. Bodies persist in `shared.targetBodies`.
- Aim outline (instanced) fades in on the aimed plate unless `shared.aimOutline === false`.
- Shadows: near rows (≤20 m) are projected silhouettes rendered into a texture (only when
  something moved), far rows a blob. Renderer is taken from the first `onBeforeRender` of the
  shadow quad; render-to-texture temporarily sets `renderer.xr.enabled = false`.
- After moving instances call `computeBoundingSphere()` (raycasts and culling use it).

## Score (score.js) — feature `score`

`createScore({ THREE, camera, shared })` -> `{ state, setVisible(on), shot(hit), reset(), get(),
set(saved), update(dt), dispose() }`. Hit: `+round(100 × 1.2^streak)`, streak+1; miss: −20 (not
below 0), streak 0. State in `shared.score`; saved in scene snapshots. Plate attaches to the HUD
group (found as the camera child containing a `CircleGeometry`), left of the message windows,
`renderOrder 1001`, `depthTest: false`. Menu `Мишени ▸ Сбросить счёт`.

## Laser sight (laser.js) and colour (laser-panel.js)

`createLaser({ THREE, root })` -> `{ update(muzzle, dir, hitPoint|null), setColor(hex),
setVisible(on), dispose() }`: additive beam cylinder + constant-screen-size sprite dot; without a
hit point the beam stops at ground y=0 or 60 m. Visible when `shared.laser` (menu toggle
`Лазерный прицел`) or while the colour panel is open. Colour = `shared.laserColor`
(`LASER_COLORS` in laser-panel.js, saturated colours because additive blending washes them out).

## Hook points

- New gun: `GUNS`, `CALIB_KEYS`, model, sound ([recipes.md](recipes.md#new-weapon-kind)).
- New shootable thing: either add its mesh to `rayObjects` in shooting.js, or register a
  `cast/hit` handler with `shooting.addShootable` (pattern: `robodog.js`). `aim()` also casts
  shootables (laser stops on them; clays are still not aimed at).
- Robot dogs: one dog = `robodog-unit.js` (model `robodog-model.js`, gait/IK `robodog-gait.js`,
  ragdoll `robodog-ragdoll.js`, cast/hit, death); shared sparks/arcs `robodog-fx.js` (1 draw call);
  sounds `robodog-sound.js` (own module on `__sceneState.audioGraph`: recipes baked once with
  OfflineAudioContext into `__sceneState.dogSoundBank`, 8 permanent HRTF voices in
  `__sceneState.dogVoices`, oldest stolen; zap, crackle, powerDown, clank, clankHeavy, thud, servo,
  groundThud, scrape). Metal look: one material per dog with an atlas (`makeDogTextures`: paint
  panels/bolts/wear, bare steel, rubber; roughness+metalness maps) + `weapon-env.js` env map.
  Controllers: `robodog.js` (feature `robodog`, wanderer, brain `robodog-ai.js`, 5 HP) and
  `robodog-horde.js` (feature `robodogHorde`, «Сцена 3»: pool of 5 models = 55 draw calls max, ≤3
  alive, 2 HP: first hit knocks it down — ragdoll ~1 s, then a 0.55 s get-up blend — second
  kills; leap at the chest → red vignette on the camera + `onPlayerHit` haptic in main.js; corpses
  sink after 8 s). Bullets throw ragdolls by calibre: main.js sets `shared.shotKind` before each
  shot (pistol 0.45, ak 0.7, awp 1). Ragdoll: Verlet 16 particles, 1/120 s substep, 10 iterations,
  speed clamp 14 m/s. Corpse hits return `null`. All gameplay timers run on `dt` (slow-mo safe).
  Debug: `__sceneState.robodog.debug.info()`, `__sceneState.horde.debug.info()`.
- Score is off in every scene (compositions.js); `score.js` (+ `bonus(points)`) kept for later.
