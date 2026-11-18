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
//   projectile 'rocket' | 'plasma' (pool bullet + arena-weapons.js FX/splash) | 'rail' (instant piercing railShot) — recipes.md «Arena projectiles»; a new type: recipes.md «Новый снаряд»
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
  groundThud, scrape, whoosh, bark, growl, howl, mg, turretWind; growl/howl are budget category `voice`;
  a recipe added without a `BAKE_VERSION` bump is baked incrementally on the next swap). Metal look: one material per dog with an atlas (`makeDogTextures`: paint
  panels/bolts/wear, bare steel, rubber; roughness+metalness maps) + `weapon-env.js` env map.
  Controllers: `robodog.js` (feature `robodog`, wanderer, brain `robodog-ai.js`, 5 HP) and
  `robodog-horde.js` (feature `robodogHorde`, «Сцена 3», two-team battle). Horde dogs are joint
  rigs only (`buildRobodogRig`, `createDogUnit({ rig: true })`, not in the scene graph); ALL of them
  are drawn by `robodog-instances.js` (9 InstancedMeshes: body, eyes, upper/lower leg L/R, turret
  base/gun, shadow; per-instance paint `aPaintA/aPaintB` via `paintSlot` vertex attribute, hit
  flash `aEmissive`, shadow `aAlpha`; program key `robodog-inst-1`). Pool 64 rigs (grows 3/frame).
  Sizes `SIZES` 1×…12× (+ titan 36× debug-only); which size spawns is set by the battle stage
  (`progression.js`, game time since `shared.battleStartMs`: stage weights [small, medium, big, huge],
  «huge» split over огромный/гигантский/колоссальный 0.5/0.33/0.17 = `HUGE_SPLIT`, `pickSize`, both teams
  alike; explicit spawns `hordeDebug.spawn(name)` / `debug.spawn(i)` ignore it). `horde.apply(on, { keep,
  battleS })` sets `battleStartMs = sceneNowMs − battleS` on a new battle (Restart: 0; Continue / page
  reload: `live.battleS`, written by main.js `scenes.snapshot()` rounded to 10 s); a hot swap keeps it;
  horde off → `null` (drones then skip progression). Alive cap per side `teamCap()` = max(2,
  round(TEAM_POOL × `dogsAllowed`)) = 8 / 16 / 28 / 40 by stage, same for both teams: `spawnPack` trims
  `want` to it, wave size is ≤ cap − alive (a wave stops when the side hits the cap), `matchStep` goal ≤
  cap; dogs above the cap (after a stage jump back) live on, they just aren't replaced; explicit
  `hordeDebug.spawn` ignores it. Stage change (polled every horde update via
  `stageOf(battleSeconds)`, so menu «Эпоха» jumps count too; `run.stage`, the first stage of a battle is
  silent): `[battle] стадия N: <STAGE_NAMES>` in the console, horn far ahead (`horn.play`, pitch 1.05),
  banner «Стадия: <name>» on the camera (canvas 512×128 redrawn only on change, 3.2 s real time,
  `horde-stage-banner`). Packs of 3–8 that emerge from the ground, calm
  until the player's first shot, then enraged (red eyes). Allies (`dog.team = 'ally'`, green paint
  6 + green eyes, menu «Собаки ▸ Союзники», `shared.allies`, localStorage `scene.allies`) spawn
  behind and fight enemies; targets = nearest hostile with stickiness (`pickTarget`, `tp`).
  Teams are EQUAL (user request): each side ≤ `TEAM_POOL` = POOL/2 = 40 rigs (alive + corpses),
  same size odds. Top-ups track the other side (`matchStep`, «больше наших — больше и врагов»):
  goal = other side alive × `MATCH` 0.95–1.1, at least a floor growing 6 → 30 (+0.1/s,
  `MATCH_FLOOR`/`MATCH_RAMP`), at most 40; behind by > 20 % (`MATCH_TOL`) → packs of 6 every
  2–3.5 s (`MATCH_FAST`), else `TRICKLE_PACK` 2–4 every `TRICKLE_GAP` 9–13 s. Waves
  (`surgeStep`): enemy wave on a timer (`FIRST_SURGE` 15 s, then `SURGE_EVERY` 25–40 s); ally
  counter-wave when the enemy wave's dogs come within `COUNTER_NEAR` 25 m, after `COUNTER_DELAY`
  12–18 s, or at once if the enemy wave was beaten first; after an ally wave ends the next enemy
  wave comes in `AFTER_ALLY_WAVE` 5–10 s → waves alternate E → A → E. Any wave = `WAVE_REL`
  0.9–1.2 × the other side alive (min 10), released in packs of 6 every 1.6 s (a counter-wave
  doesn't cut the other wave's unreleased rest; counter not before the enemy wave is 6 s old);
  while a side's wave runs the other side's top-ups pause; a wave ends at ≤ 25 % left or `WAVE_MAX_S` 30 s; no
  enemies for 8 s → enemy wave. Momentum: damage to a side × 1/hpMul, hpMul = clamp(((A+1)/(E+1))^0.7,
  0.4…1.6). Each wave start sets `shared.dogWave = { team, n }` (drones launch with it).
  Large+ dogs strike with a front paw (`pawStep`, gait `cmd.paw`), small/medium leap.
  Variety / intimidation (2026-11-17): each dog has a role `dog.kind` (`initTraits`, `KINDS`): `rusher`
  (≤ `CHARGE_NEAR` 24 m → charge ×1.3 for 1.6–2.6 s with howl/bark), `flanker` (spirals to the edge of the
  front sector ±`FLANK_ANGLE` 49°, sides alternate per spawn; vs dogs: heading offset), `stalker` (≤ `STALK_R`
  13 m×√s: prowls sideways on a shrinking circle, body turned to the target, growls, then howl + charge).
  Small/medium rusher/stalker pounce from `POUNCE` 4.2–7 m×s (crouch 0.42 s, eyes white-hot, growl, long
  leap = same `dog.leap` contact code, `leap.pounce`). Dodges are often a side hop (`dodgeTick` runs during
  the hop), corpses ahead are hopped over (checked inside the separation loop), hard deceleration in `run`
  = skid (`dog.brake`, dust ≤ 3 puffs/frame `skidLeft`, scrape). Paw dogs pick `p.kind`: `rear` (first
  attack, then 30 %: rears up with howl, both paws slam — `rearStep`, hit test at the front-feet midpoint,
  a miss shakes the player lightly if near/on the tower in front), `combo` (left-right, 2nd swing ×0.45
  windup), `swipe`. Calm big dogs alerted by a shot rear up for `ALERT_REAR_S` 1.5 s. Tower: small/medium
  circling at its base jump at the legs (`CLIMB_H` 1.2–2.2 m×s every 2.5–6 s, `climbStep` bounces at
  `TOWER_LEG_R` 2.3 m or the apex). Eyes: `unit.glow(k)` per frame (0.72 far, ~1 + pulse near the target,
  1.3–1.5 = white-hot during crouch/windup/rear/alert). Gait inputs (all 0..1 except `look`, rad): `cmd.prowl`
  (low, wide, slow high steps), `cmd.rear` (pitch up to 0.85 rad around the hind hips, front legs paw the air
  in body space), `cmd.rearReach` (paws forward-down), `cmd.brake`, `cmd.look` (body twist ≤ 0.3); full
  gallop (`sprint`, v 3–5.2 model m/s): duty 0.3, bigger bob/pitch. Horde writes `dog.prowl/rear/rearReach/
  brake/look`, unit.animate passes them. Debug (desktop page only — guard with
  `/Quest|OculusBrowser/.test(navigator.userAgent)`, `session` alone is not enough when the user is out of
  VR): `horde.debug.kinds()` (roles + how many stalking/charging/rearing/prowling/braking/climbing/pouncing),
  `horde.debug.force({ rear, rearReach, prowl, brake, look } | null)` (pose on all dogs), `dog.frozen = true`
  (stands still, takes the forced pose). Every 5th
  dog has a back turret (tracers = `fx.bolt`). Legs break (`legHit`, gait `cmd.broken`), 2nd
  broken leg kills. Budgets: ≤ `RAGDOLL_MAX` simulating corpses; over budget the CALMEST one (lowest
  `ragdoll.motion()`) gets `unit.rest()`: near the ground it just sleeps in its pose, in the air the same
  pose sinks rigidly to the ground over 0.3 s×√s (`ragdoll.rest`, `ragdoll.easing`), flying ones
  (motion > `RAGDOLL_FLYING`) keep simulating up to `RAGDOLL_MAX + 2`. Never use the instant
  `unit.settle()` for that (it dropped every particle to the ground in one frame — the user saw corpses
  "fall in one frame"; it stays only for black-hole dragging, which now uses `unit.drag`). Ragdoll leg bones take their twist from the
  knee hinge (normal of the thigh–shin plane, `placeRagdoll`), the same as the alive IK — the death frame
  has no bone flick (measured 0.000 rad vs 0.1–0.4 before). Update
  LOD by distance only for small/medium dogs (`LOD_NEAR`/`LOD_FAR`: pose every 2/4 frames, the body
  still follows every frame); large+ (scale ≥ 2.5) pose EVERY frame (user: big dogs looked "low frame
  rate"), corpses sink sooner when busy. Smoothness rules: turning has inertia (`dog.w` accelerates
  ≤ 16/√s rad/s², max 4/s^¼ rad/s — never assign `dog.w`/`dog.yaw` directly); a jump's heading goes to
  `dog.jumpYaw` and is turned to during the crouch (no snap); gait rhythm (frequency, duty, trot↔gallop
  phase offsets) follows a smoothed speed `vS` (~0.25 s) so speed jumps don't teleport feet in the cycle.
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
  in `shared.droneRun` (survives swaps, grows on MAX change; teams equal: each ≤ `TEAM_MAX` 20 alive, same size weights and large/huge caps 4/2), both sides waves `WAVE_N` 3–5 (+ the gap to the other side, ≤ `CATCH_UP` 4) every gap×0.85–1.15 (×0.5 when > 20 % behind), gap 10→6 s, first waves at 3/5 s; a dog wave (`shared.dogWave`) launches `SURGE_N` 6–8 drones of that side at once and resets its timer (enemies
  in front 95–130 m, allies behind). Flight: PD steering to an orbit point around the target (enemy
  vs player — only in the ±60° front sector), tilt from acceleration, wobble; steering LOD > 70/120 m.
  Target = nearest hostile (player ×0.8, dogs via `horde.debug.units()` read-only, drones), sticky,
  BY PRIORITY TIERS (`tierOf`, user request 2026-11-17; distance only within a tier): big drones
  (size ≥ `BIG_DRONE` 2) — big dogs (scale ≥ `BIG_DOG` 2.5) → small dogs → rest (drones, player);
  small/medium — big drones → small drones → small dogs → rest (big dogs, player). Same tiers for escorts
  within `ESCORT_SEEK`. Hysteresis (`keepCurrent`): current kept unless a higher tier appears or, same tier,
  one 25 % closer.
  Calm until the player's first shot (`run.angry`) or a hit. Fire: pre-mixed burst sound + per-round
  `fx.bolt` tracers (own `createZapFx`), hits queued by travel time: player → `screenShake(0.18)` at most
  every 350 ms, front-only (±70°); dog → `unit.strike`; drone → `damage`. Player bullets: `addShootable`
  (sphere `hitR`, `aimTargets` skips allies, allies/dying take no damage; AWP `5 + hpMax/4`). Death:
  spin + fall + smoke trail → `explode` on the ground (fire/smoke billboards, sparks, boom, shake < 35 m,
  splash on dogs) → wreck → sinks. Draw calls: light body, heavy body, gun, rotor discs, lights, fire,
  smoke (+1 fx); per-instance `aPaintA/aPaintB/aFx` (program `drone-inst-1`). Exposed for the horde:
  `shared.droneTargets` (drone objects `{ isDrone, state, team, x, y, z, span }`) and
  `shared.droneStrike(drone, point, dir, dmg)` — dogs don't target drones yet.
  Progression (`progression.js`, user request): when `shared.battleStartMs` is set (horde battle), drones.js
  `progStep()` per frame → `prog.cap = ceil(TEAM_MAX × dronesAllowed(t))`, `escMax`/`keep` scaled the same;
  sizes of new drones (waves, surges, escorts — escorts small/medium only) from `droneSizeWeights(t)` copied
  into `wBuf` (never mutate the stage arrays); all 0 → nothing spawns. Existing drones stay. No
  `battleStartMs` → no progression (old weights, TEAM_MAX). `debug.info().prog`, telemetry `battle=…s cap=…`.
  Squad escorts (2026-11-17, «псы и коптеры заодно»): every `spawnPack` in robodog-horde.js gets a squad
  id (`shared.squadSeq`, never reset; `dog.squad`, survives swaps) and pushes `{ id, team, n, x, z }` to
  `shared.squadQueue` (≤ 8); drones.js drains it each frame (`addEscorts`): 1 / 2 / 3 escorts for packs
  ≤ 3 / ≤ 6 / more, small/medium only, `d.squad = id`; new ones appear 18–26 m behind the pack (away from
  the player) 10–16 m up, or — if the side is at `TEAM_MAX` — the nearest free small/medium drone is
  recruited. Caps: escorts per side ≤ `ESCORT_MAX` 12; free waves ≤ `TEAM_MAX − max(escorts, ESCORT_KEEP 6)`.
  Escort flight (`escortGoal` in `steer`): every `ESCORT_EVERY` 0.3 s `escortScan` = centroid of the
  pack's alive dogs (+ smoothed centroid velocity, used as lead and feed-forward) and `escortTarget` =
  nearest enemy within `ESCORT_SEEK` 23 m of the CENTROID (enemy dogs, enemy drones the gimbal can reach
  — not > 0.36·horizontal above, the player for enemy escorts ×0.6 if the pack's dogs target him; sticky);
  orbit `ESCORT_R` 4–8 + √n m around the centroid at `ESCORT_ALT` 3–8 m above ground, equal angles,
  `ESCORT_SPIN` 0.35 rad/s, leaning ≤ 6 m toward the target. Fire = the normal `fly` code (front-only rule
  for the player intact). Pack gone (0 alive dogs, drone age > 4 s) → `freeEscort` (own size's alt/R).
  Marks: `shared.squadMarks[id]` = the escort's target; horde `pickTarget` takes it for that pack's dogs
  if it is an enemy dog ≤ 1.5 × nearest + 4 m (deleted on escort death / pack end, cleared on swap).
  Debug: `debug.info().escorts`, `debug.list()` rows with `squad, packN, fromPack, aboveGround`.
  Telemetry `[drones]` every 10 s (`enemy=N(esc k)`). Debug: `__sceneState.droneSystem.debug.{info, list, spawn(team, n), kill(id), sound,
  showcase(on, team)}` (showcase freezes the sim — desktop page only).
  The player's own drone (`my-drone.js`, see [items-and-grabbing.md](items-and-grabbing.md#personal-drone--remote-my-dronejs))
  is a separate object, deliberately NOT in `droneTargets`/`addShootable`: nothing targets or damages it.
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
