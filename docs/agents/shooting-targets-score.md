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
shooting.autoAim(muzzle, dir, deg, speed, gravity?, projectile?) -> Vector3|null   // auto-aim shot direction (shared vector) into the best target of the deg° cone, ballistic + lead; null = nobody (recipes.md «Сгенерированная пушка», autoAim)
// shoot() also takes { projectile: 'mana', color, gravity } — mana bolt (mana.js) instead of a bullet,
//   and { homing: { delayS, turnDegS, gravity }, autoAimDeg } — homing projectile (recipes.md «Homing»)
// aimTargets(visit): visit(centre, vx, vy, vz, key) — key = stable target object (homing re-finds it each step)
shooting.autoAimLock() -> { x, y, z, plate, deg, dist, ring } | null       // debug: last lock
shooting.bullets() -> [{ age, speed, kind, x, y, z }]; shooting.aimedIndex()   // debug for vr:eval
shooting.castSegment(from, to) -> { point, normal, target, isStand } | null   // shared result object
shooting.hitTarget(target, point, dir, quiet)    // non-bullet hit (clays)
shooting.puff(point)                             // dust (effects.dust)
shooting.setClayTarget({ cast(origin, dir, far) -> distance|-1, hit(origin, dir, distance) } | null)
shooting.addShootable({ cast, hit -> true|false|null, shot?(origin, dir, far), aimTargets?(visit) }) -> remove()  // aimTargets: visit(centre, vx, vy, vz) per auto-aim candidate  // more targets (robodog.js); nearest of clay+shootables wins; shoot() returns null = "hit, not scored"
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
  `robodog-horde.js` (feature `robodogHorde`, «Сцена 3», two-team battle). Horde dogs are joint
  rigs only (`buildRobodogRig`, `createDogUnit({ rig: true })`, not in the scene graph); ALL of them
  are drawn by `robodog-instances.js` (9 InstancedMeshes: body, eyes, upper/lower leg L/R, turret
  base/gun, shadow; per-instance paint `aPaintA/aPaintB` via `paintSlot` vertex attribute, hit
  flash `aEmissive`, shadow `aAlpha`; program key `robodog-inst-1`). Pool 64 rigs (grows 3/frame).
  Sizes `SIZES` 1×…12× (+ titan 36× debug-only), packs of 3–8 that emerge from the ground, calm
  until the player's first shot, then enraged (red eyes). Allies (`dog.team = 'ally'`, green paint
  6 + green eyes, menu «Собаки ▸ Союзники», `shared.allies`, localStorage `scene.allies`) spawn
  behind and fight enemies; targets = nearest hostile with stickiness (`pickTarget`, `tp`).
  Large+ dogs strike with a front paw (`pawStep`, gait `cmd.paw`), small/medium leap. Every 5th
  dog has a back turret (tracers = `fx.bolt`). Legs break (`legHit`, gait `cmd.broken`), 2nd
  broken leg kills. Budgets: ≤ `RAGDOLL_MAX` simulating corpses (others `settle()` flat), update
  LOD by distance (`LOD_NEAR`/`LOD_FAR`: pose every 2/4 frames), corpses sink sooner when busy.
  Debug: `__sceneState.horde.debug.{info, units, spawn(i), pack, allyPack}`, `__sceneState.hordeDebug.{spawn(name, n, dist), clear}`.
  Ragdoll gotcha: constraint arrays must fit all constraints (`MAX_C`); overflow silently read
  `undefined` and made every ragdoll ~15× slower. Bullets throw ragdolls by calibre: main.js sets `shared.shotKind` before each
  shot (pistol 0.45, ak 0.7, awp 1). Ragdoll: Verlet 16 particles, 1/120 s substep, 10 iterations,
  speed clamp 14 m/s. Corpse hits return `null`. All gameplay timers run on `dt` (slow-mo safe).
  Debug: `__sceneState.robodog.debug.info()`, `__sceneState.horde.debug.info()`.
- Quadcopters: `drones.js` (system), `drone-model.js` (geometry/textures, cached in `__sceneState`),
  `drone-sound.js`. Same battle (feature `robodogHorde`), menu «Собаки ▸ Квадрокоптеры: вкл/выкл»
  (`shared.drones`, localStorage `scene.drones`, default on; main.js `onMenu` checks the label before the
  allies toggle). `SIZES` small 0.4 m / medium 0.9 / large 2 / huge 5 (hp 1–2/3–4/8–9/20, altitude
  3–9…22–40 m, orbit radius, range, burst 3–5, spread, dmg to dogs/drones). Pool `MAX` 44 plain objects
  in `shared.droneRun` (survives swaps, grows on MAX change; enemy ≤ 26 with large/huge weighted ×2, ally ≤ 14 with half the large/huge caps — enemies dominate the air too), enemy waves 4–6 every 0.8×gap, ally waves 2–4 every 1.2×gap, gap 10→6 s, first waves at 3/5 s (enemies
  in front 95–130 m, allies behind). Flight: PD steering to an orbit point around the target (enemy
  vs player — only in the ±60° front sector), tilt from acceleration, wobble; steering LOD > 70/120 m.
  Target = nearest hostile (player ×0.8, dogs via `horde.debug.units()` read-only, drones), sticky.
  Calm until the player's first shot (`run.angry`) or a hit. Fire: pre-mixed burst sound + per-round
  `fx.bolt` tracers (own `createZapFx`), hits queued by travel time: player → `screenShake(0.18)` at most
  every 350 ms, front-only (±70°); dog → `unit.strike`; drone → `damage`. Player bullets: `addShootable`
  (sphere `hitR`, `aimTargets` skips allies, allies/dying take no damage; AWP `5 + hpMax/4`). Death:
  spin + fall + smoke trail → `explode` on the ground (fire/smoke billboards, sparks, boom, shake < 35 m,
  splash on dogs) → wreck → sinks. Draw calls: light body, heavy body, gun, rotor discs, lights, fire,
  smoke (+1 fx); per-instance `aPaintA/aPaintB/aFx` (program `drone-inst-1`). Exposed for the horde:
  `shared.droneTargets` (drone objects `{ isDrone, state, team, x, y, z, span }`) and
  `shared.droneStrike(drone, point, dir, dmg)` — dogs don't target drones yet. Telemetry `[drones]`
  every 10 s. Debug: `__sceneState.droneSystem.debug.{info, list, spawn(team, n), kill(id), sound,
  showcase(on, team)}` (showcase freezes the sim — desktop page only).
- Artillery: `artillery.js` (system + all explosion FX) + `artillery-sound.js`. Same battle (feature
  `robodogHorde`), menu «Собаки ▸ Артиллерия: вкл/выкл» (`shared.artillery`, localStorage
  `scene.artillery`, default on). Off-map batteries (not drawn): enemy 1400 m ahead (−Z), allies 1400 m
  behind; each side every 10–25 s fires 3–8 shells (×1.6 during its own horde wave, more with many
  targets) at the densest cluster of the other team's dogs (`horde.debug.units()`, cluster 12 m,
  scatter ≤ 8 m; no targets → field 28–140 m ahead). Never within `SAFE_R` 18 m of the head /
  `shared.towerPos`. Shell timeline (game time, `shared.artilleryRun` survives swaps): horizon flash →
  battery thump after 1400/343 s → re-aim to the tracked dog 2.1 s before impact → whistle (voice
  follows the shell) 1.8 s → streak 0.5 s → blast. Splash `SPLASH_R` 7.5 m (+0.5×scale): `unit.strike`
  dmg 1–8; kill → `unit.blast(v)` (ragdoll push, hook added to robodog-unit.js); small/medium
  survivors `unit.knock`; corpses `unit.blast`; drones `shared.droneStrike` (1–11). Shake
  `screenShake(min(0.85, 15/d))` + 3 decaying taps (< 170 m). FX: ONE instanced quad mesh + one
  ShaderMaterial (premultiplied blending: `iVel.w` = additive share, so fire and dark smoke share a
  draw call), atlas 512×256 (8 cells, `shared.artilleryAtlas`), modes billboard / ground-flat /
  velocity-stretched, per-cell noise erosion (fire dissolves into smoke). CAP 1500 particles in
  `shared.artilleryFx` (survive swaps), scorch decals ≤ 24 × 30 s; LOD by distance and recent-blast
  heat. No PointLight (would recompile every lit shader) — light = flat additive ground pool. `update(dt)`
  in the substep loop (logic), `frame(clock.total)` once per frame (particles + buffer). Telemetry
  `[artillery]` every 10 s (~0.1 ms/frame on Quest). Debug (desktop only): `__sceneState.artillerySystem.debug.{info,
  barrage({team,n,dist,bearing,flight}), blast(dist, bearingDeg), clear}`.
- Score is off in every scene (compositions.js); `score.js` (+ `bonus(points)`) kept for later.
