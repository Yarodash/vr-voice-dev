# Recipes

Code matches `web/src/scene/` as of 2026-11-16. Always re-read the target file right before
editing (other agents edit in parallel) and run `npm run scene:check` after each edit.
In `scene/main.js` the closure already has: `THREE, root, renderer, camera, scene, ctx, shared`,
`active` (scene features), `gripMode`, `menuState()`, `menuKey`, `buzz(source, strength, ms)`.

- [Add a menu item](#add-a-menu-item)
- [Add a submenu](#add-a-submenu)
- [Add a keepOpen toggle](#add-a-keepopen-toggle)
- [Add a scene feature flag](#add-a-scene-feature-flag)
- [New weapon kind](#new-weapon-kind)
- [Сгенерированная пушка (picture → card → GLB)](#сгенерированная-пушка)
- [Новый снаряд / новое действие выстрела (projectile module, area damage, kill credit)](#new-projectile)
- [ТЗ новой пушки — шаблон (priorities, acceptance, live delivery)](#tz-template)
- [New grabbable item (absolute or relative)](#new-grabbable-item)
- [Add a sound](#add-a-sound)
- [Add an effect](#add-an-effect)
- [World-space panel with stick input](#world-space-panel-with-stick-input)
- [Per-frame system with telemetry](#per-frame-system-with-telemetry)
- [Verify](#verify)

---

## Add a menu item

1. `scene/menu.js`: put the item where it belongs, e.g. in Settings:
   ```js
   const settingsItem = { label: 'Настройки', children: [{ label: 'Отцентрировать' }, { label: 'Расстояние между глазами' }, { label: 'Мишени передо мной' }] };
   ```
   Empty-hand items go into `spawnItems`, weapon items into the `heldKind` branch, clay items
   into the `'plate'` branch, items for everyone into `common`.
2. `scene/main.js` `onMenu(picked)`: add a branch to the `else if` chain (labels are matched
   exactly; keep them unique or check `picked.path`):
   ```js
   } else if (picked.label === 'Мишени передо мной') {
     shooting.placeInFront();
   ```
3. `scene:check`. Verify the pick without touching the headset: after the user picks it,
   `logs/page-console.log` has `[wheel] выбрано: Настройки > Мишени передо мной`.
   If a label is used in both files, export a constant from menu.js (like `RESET_SCORE`).

## Add a submenu

```js
// menu.js
const weatherItem = { label: 'Погода', children: [{ label: 'Ясно' }, { label: 'Дождь' }] };
const common = [...(features.targets ? [physicsItem] : []), scenesItem, settingsItem, weatherItem];
```
```js
// main.js onMenu — put it before branches that match plain labels
} else if (picked.path?.[0] === 'Погода') {
  setWeather(picked.label); // 'Ясно' | 'Дождь'
```
Submenus can nest; the user leaves a submenu by confirming the centre or with the grip.
Keep ≤ 8 sectors per level.

## Add a keepOpen toggle

A toggle flips state and keeps the wheel open; its label shows the state, so the menu must be
rebuilt when the state changes.

```js
// main.js setup — load (next to scene.laser)
try {
  shared.fog = localStorage.getItem('scene.fog') === 'on';
} catch {
  shared.fog = false;
}
// main.js menuState — pass it
    laser: shared.laser,
    fog: shared.fog,
```
```js
// menu.js — accept it and build the label from it
export function buildMenu({ ..., laser = false, fog = false, features = ..., scenes = [] }) {
  const settingsItem = { label: 'Настройки', children: [
    { label: 'Отцентрировать' }, { label: 'Расстояние между глазами' },
    { label: fog ? 'Туман: вкл' : 'Туман: выкл', keepOpen: true },
  ] };
```
```js
// main.js onMenu
} else if (picked.label.startsWith('Туман:')) {
  shared.fog = !shared.fog;
  try {
    localStorage.setItem('scene.fog', shared.fog ? 'on' : 'off');
  } catch {
    // без хранилища не переживёт перезапуск
  }
// main.js update — add the state to the rebuild key, or the label won't change
const key = `${heldKind}|${gripMode}|${shared.targetPhysics}|${shared.aimOutline}|${shared.laser}|${shared.fog}`;
```
Other modules read `shared.fog` (targets.js reads `shared.targetPhysics` the same way).

## Add a scene feature flag

Example: `fog` only in some scenes.
1. `compositions.js`: `EMPTY_FEATURES = { ..., car: false, fog: false }`; also
   `RANGE_FEATURES` if the default range should have it.
2. `main.js`: read `active.features.fog` in `setup` (initial state) and in `applyScene(data,
   features)` (scene switch). `menu.js`: gate items with `features.fog`.
3. If the feature has state, add it to `snapshot()` (`...(fog ? { fog: fog.get() } : {})`),
   keep it in `freshOf()` if Restart should keep it, and apply it in `applyScene`
   (pattern: `applyCar`).
4. Turn it on for an existing saved scene with a one-time migration (pattern `migrateCarScene`):
   ```js
   // compositions.js
   export function migrateFogScene() {
     const KEY = 'scene.fogMigrated';
     try {
       if (localStorage.getItem(KEY)) return false;
       const list = loadCompositions();
       const entry = list.find((e) => e.name === 'Сцена 1');
       if (entry) {
         entry.features = { ...entry.features, fog: true };
         saveCompositions(list);
       }
       localStorage.setItem(KEY, '1');
       return Boolean(entry);
     } catch {
       return false;
     }
   }
   // main.js setup, right after the car migration line
   if (migrateFogScene() && active.name === 'Сцена 1') active = writeActive(shared, active.name, { ...active.features, fog: true });
   ```
   New scenes saved with `Сохранить как новую` copy the active scene's features.

## New weapon kind

Example kind `'shotgun'`.
1. Model `scene/shotgun-model.js`: `buildShotgun(THREE, { outlineM })` returning
   `{ group, accent, outlineGeometry, muzzle, ejector }` in weapon space (metres, barrel −Z, up
   +Y, palm at `(0, -0.04, 0.045)`; `accent` = `MeshStandardMaterial` with `emissive: 0x000000`).
   Merge parts per material (see pistol-model.js).
2. `pistols.js`: `const KINDS = ['pistol', 'ak', 'shotgun'];` and in `add()` a branch like the
   pistol one:
   ```js
   } else if (kind === 'shotgun') {
     const { outlineGeometry, ...gun } = buildShotgun(THREE, { outlineM: OUTLINE_M });
     model = gun;
     outline = new THREE.Mesh(outlineGeometry, outlineMaterial);
     outline.visible = false;
     model.group.add(outline);
   ```
3. `main.js`: `GUNS.shotgun = { gapMs: 600, auto: false, kickMs: 180, kickRad: 0.3, kickBackM: 0.02, climbRad: 0, buzz: 1 }`;
   `CALIB_KEYS = { ..., shotgun: 'scene.shotgun.calib' }`; `onMenu`:
   `} else if (picked.label === 'Заспавнить дробовик') { spawnWeapon('shotgun');`.
4. `menu.js`: add `{ label: 'Заспавнить дробовик' }` to the `Заспавнить` children; title:
   `heldKind === 'ak' ? 'Калаш' : heldKind === 'shotgun' ? 'Дробовик' : 'Пистолет'`.
5. Sound (`sound.js`): add files to `web/public/sounds/guns/`, `GUN_FILES.shotgun = [...]`,
   `shared.soundBank = { …, pistol: [], ak: [], shotgun: [] }` in `loadBank`, map the kind in `setWeapon`
   and `shot()` (they currently collapse everything that is not `'ak'` to `'pistol'`), bump
   `SOUND_VERSION`.

## Сгенерированная пушка

Pipeline «a gun from a generated picture» — the dispatcher only drops files and edits ONE registry
entry in `web/src/scene/generated-guns.js` (`GENERATED_GUNS`). Every edit hot-swaps the scene; the
gun stays in the hand (same item, pose, held state), only what is drawn inside its group changes.
Code: `scene/generated-gun.js` (builders, caches), wired in `pistols.js` (kind `'gen:<id>'`),
`main.js` (GUNS, calib, fire mode, scope tilt, spawnOnAdd), `menu.js` (spawn items, title, toggles).

**Every new gun's code work** (its shot, projectile, effects, sounds) follows the
[«ТЗ новой пушки — шаблон»](#tz-template): a prioritized spec with an acceptance check per priority,
each priority delivered live (save → `scene:check` → hot-swap) and announced to `main` with a short
`SendMessage` right after it is accepted. User tweaks relayed mid-way take precedence.

Files: `web/public/models/generated/<id>/card.png` (PNG with alpha, gun SIDE view, barrel to the
RIGHT, any size — it is cropped/downscaled to 1024 px in the page) and `<id>/mesh.glb` (Tripo,
~30k tris, 1K texture).

**Auto-placement (user's rule, 2026-11-18: «чтобы оно само подставлялось в игру»).** `npm start` runs
`scripts/gen-autoplace.mjs` (alone: `npm run gen:autoplace`). Agents do NOT copy files or edit
`card`/`glb`/`v` by hand. The **dispatcher calls the generation tools itself** (user: no image/3D agent):
- **Image:** `generate_image` / `edit_image` with `output_dir = …\generated\<id>\src`, then
  `remove_image_background` with `output_path = …\generated\<id>\card.png`. The moment card.png is
  written, the watcher sets `card: true`, bumps `v`, says «Картинка «<name>» в игру» in the headset.
- **3D:** `generate_3d_model(image_path = …\generated\<id>\card.png, remove_background: false)`. When
  the Tripo run finishes (`D:\3d_models\output\mcp\<run>\result.json`, its `image` is that card.png),
  the watcher copies `mesh.glb` into `<id>\`, sets `glb: true`, bumps `v`, says «3D … в игре».
- No entry for `<id>` yet → it adds a minimal one. Log: `logs/gen-autoplace.log`; state (what was
  already placed) is kept in `.vr/gen-autoplace.json`.
Agents still do the rest by hand: placeholder entry, `trigger.box`/`scope` measured from the card,
`glbFlip`.

**Agents (user's rule).** Image and 3D: the dispatcher calls Gemini/Tripo itself (no agent); gen-autoplace
puts the results in the game. Agents of a new gun (shot code, trigger/scope measuring) run on **Haiku**.
The code agent starts from the projectile recipe in this file, not by reading the whole codebase.

**No visual quality gate (user's rule).** Put every generated image and every Tripo model into the
game as soon as it arrives. Don't reject a model by its preview and don't regenerate on your own;
the user looks at it in VR and asks for a redo. The technical steps still apply: background cutout,
registry fields, `npm run scene:check`, muzzle direction (`glbFlip`). Scopes keep their own fitting
checklist (below).

Stages (each is one edit of the entry):

0. **Placeholder, instantly** (no files yet):
   ```js
   { id: 'm4', name: 'М4', length: 0.9, auto: true, shape: 'rifle', card: false, glb: false, v: 1 },
   ```
   A translucent blue hologram of a generic `shape` (`rifle | smg | pistol | shotgun | sniper`;
   without it — by `length`) with a floating label «М4 / генерирую…». Already grabbable and shoots
   (GUN_AUTO / GUN_SEMI). «Заспавнить М4» appears in «Заспавнить ▸» (more than 3 generated guns —
   nested «Новые пушки ▸»). The user spawns it from the menu — do NOT set `spawnOnAdd` (user, 2026-11-18: «не надо мне спавнить пушку, я сам себе могу заспавнить»). `spawnOnAdd: true` would put one copy ~0.55 m in front of the head, sideways,
   once per id+v (localStorage `scene.gen.spawned.<id>.<v>`, both pages spawn their own).
1. **Card**: drop `card.png`, set `card: true`. The placeholder becomes a solid thick picture: two
   picture faces ±`thicknessM/2` (default 3.5 cm; the back is mirrored) + side walls traced from the
   alpha mask (incl. holes), coloured from the edge pixels. Scale: opaque bbox width = `length`.
   Auto-estimated from the mask: muzzle = right edge at barrel height; grip (palm) = first downward
   protrusion from the left (long guns skip the stock). Check: `npm run vr:eval --
   "__sceneState.weaponDebug.gen()"` → per cache key `grip`, `muzzle` (fractions of the image),
   `autoGrip` (false = fallback guess), `muzzleM` (metres in weapon space).
2. **Model**: drop `mesh.glb`, set `glb: true`. Longest axis = barrel; which end is the muzzle is
   decided by comparing silhouette heights at both ends with the card (`muzzleOnPlusAxis`,
   `ratioPlus` vs `cardRatio` in `gen()`); up = +Y of the file. Scaled to `length`; grip and muzzle
   are put at the same fractions of the bbox as on the card, so the gun does not jump in the hand.
   Normals are rebuilt smooth (Tripo has none), white outline = shell along normals.
3. **Scope / trigger / modes** (pixel coordinates of card.png at its REAL size — the Read tool
   shows a downscaled image and prints the factor; or open the png in the browser):
   ```js
   scope: { eyepiece: [810, 483], objective: [1508, 485], radiusPx: 46, objectiveRadiusPx: 34, zoom: 3, offset: [-0.003, -0.003, 0] },
   trigger: { box: [1018, 822, 1060, 893] },  // box around the trigger blade inside the guard; top = pivot
   modes: ['semi', 'auto'],                   // «Режим: авто / полуавтомат» in the held menu
   ```
   Scope = real `scope-lens.js` glass (eyepiece at the rear end centre, objective at the front),
   own stick tilt (`scene.gen.<id>.scopeTilt`) and «Отладка прицела» in the held menu; `offset`
   (metres, weapon axes: x right, y up, z towards the stock) nudges both glasses to sit concentric
   with the drawn tube; `reticle: 'pso'`, `tanApparent` optional. Trigger: on the card the box is
   cut out of the picture into its own small mesh; on the GLB triangles whose centroids fall in the
   box (whole thickness) become a separate mesh on the same vertex buffers; rotates with the
   controller trigger (`maxAngle`, default 0.35 rad). Fire mode persists in
   `scene.gen.<id>.mode`.
4. **Scope the picture does not have** — `addScope` (`scope-addon.js`, e.g. `railgun`):
   ```js
   addScope: { at: [1408, 508], length: 0.28, zoom: 5, height: 0.045, style: 'emerald' },
   ```
   Builds a MODELLED scope (`scope-model.js buildScopeBody`: bell, tube, turrets, rings on risers)
   on a low rail sunk into the receiver top; real `scope-lens.js` glass at its ends (eyepiece to
   the stock, objective to the muzzle), axis parallel to the barrel (−Z). `at` = card.png pixels of
   the receiver top under the middle of the mount (measure the alpha top edge per column in the
   browser; then check the GLB top profile under the scope — `root.getObjectByName('addedScope')`
   is the mount, its parent the gun group — and pick `at`/`height` so the ocular does not sink into
   tall parts behind). `height` = axis above `at`, m (default bell radius + 14 mm); `length` scales
   the body lengthwise (radii fixed: bell 30 mm, tube 16 mm, eye glass 19 mm); `style`: `'emerald'`
   (gunmetal + glowing green rings round both glasses, bands, rail strips) or `'black'`; `reticle`,
   `tanApparent` as in `scope`. Same stick tilt / «Отладка прицела» / gun-resize as `scope`
   (ignored if the entry also has `scope`).
5. **Collimator / red-dot on the rail** — `collimator` (`scene/collimator.js`, e.g. `khaki_m4`):
   ```js
   collimator: { at: [440, 200.5] }, // + zeroM = 30, dotMoa = 5, color, windowR = 0.022, height, length, tilt, tint
   ```
   A modelled tube red-dot on a mount. `at` is card.png pixels of the rail top edge under the middle of
   the mount; measure it from the alpha with a script. On a GLB the mount sits on the highest vertex under
   it. The dot is parallax-free (the glass colours by the eye→glass direction), zeroed every frame to
   where this gun's bullet is at `zeroM`, and works with gun-resize.
   **Window ≥ Ø 4.4 cm (`windowR` ≥ 0.022). That is the user's minimum: «меньше — смотреть
   невозможно». Never smaller.**

**Scope acceptance test** (any added or fitted scope — `addScope`, `scope`, a procedural one; the
user wants it right the first time). Verify EACH point with your own desktop screenshots before
reporting (guard `if (session) return 'skip'`; render with a separate `PerspectiveCamera` into a
`WebGLRenderTarget` in gun-local poses and return `{ note, file: { ext: 'jpg', base64 } }` from
`vr:eval` — the bridge saves it to `logs/screenshots/`):
1. Nothing sticks out or intersects: body sits on its mount, mount on the receiver (no floating gap,
   no clipping into tall parts); no model polygon in front of either glass — close-ups of the
   eyepiece from behind and the objective from the front.
2. Glass fills the scope ends: eyepiece glass radius ≈ inner radius of the eyepiece (no dark ring
   wider than ~1 mm, no hole around it), objective likewise; concentric — shoot straight down the axis.
3. Through the eyepiece at a normal eye relief (~8 cm): magnified view with the reticle, centred,
   clean, no black blobs. The lens draws only for the REAL page camera, so move the gun in front of
   `camera` (eyepiece at camera + relief), wait ~20 frames, `screenshot()`. Desktop `camera.near` is
   0.05 — nearer than that clips the eyecup. Avoid explosions in view (5× of a fireball = white).
4. Aligned with the barrel (zero tilt by default: `__sceneState['genScopeTilt:<id>']`), sensible
   height above the barrel and over tall parts behind the eyepiece (the eye looks over them); white
   outline (force BackSide meshes visible for one render) clean against sky and ground.
5. Works scaled (`gun.scale.setScalar(0.7 / 1.5)`) and with stick tilt (set the tilt prop, side
   view: the scope pivots on its mount). `scope-lens.js` is scale-aware (eyepiece world scale from
   `matrixWorld` each frame: field `tanA × s`, eye relief / pupil / view distance in real metres), so
   at the SAME real eye distance (~8 cm) a ×1.5 or ×0.7 scope fills its glass like ×1. Move other
   scoped guns out of the way first — an earlier test may have parked one at the same spot.
6. Check BOTH optics modes (`__sceneState.scopeMode` `'arcade'` (default) | `'realistic'`, menu
   «Прицел: аркадный / реалистичный»). Every `createScopeLens` reads it in `update()`; nothing to wire
   per scope. Аркадный is the forgiving optics (EYE_SHIFT 0.35, PUPIL_*, TILT_END). Реалистичный is
   the real one: true eye offset, an exit-pupil eyebox
   (`EXIT_OBJ_R / mag` ± `EYE_PUPIL_R` on the eye-relief plane: black crescent off-axis, a smaller
   circle when too far or too close, fully black ~9 mm off-axis at 4×), barrel distortion `BARREL`,
   stronger edge chroma, vignette and desaturation, reticle parallax `PARALLAX_K`, convex sheen with
   a sun glint `CURVE`, a dark tube ring. The modes are a uniform branch, so there is no recompile; in
   the realistic mode an eye outside the eyebox skips its render. To compare the modes, flip
   `__sceneState.scopeMode` on the desktop page and take screenshots. NEVER `import()` scene files
   in `vr:eval` (an orphan module copy makes every later edit fully reload the headset page).

Re-generated files: overwrite them and bump `v` (URLs get `?v=<v>`, caches are keyed by it).

Tuning overrides in the entry: `grip: [u, v]`, `muzzle: [u, v]` (fractions of the whole image from
the top-left), `thicknessM`, `glbFlip: true` (model came out backwards), `calib` (localStorage key
of the hand seat; default own `scene.gen.<id>.calib`, falling back to the AK seat for guns ≥ 0.45 m
and the pistol seat for shorter ones — recalibrate with «Перенастроить оси»), any firing field of
`GUN_AUTO` / `GUN_SEMI` (`gapMs`, `kickRad`, `kickBackM`, `climbRad`, `speed`, `flash`, `sound`
`'ak'|'pistol'`, `shotKind`, `rifleCasing`, `autoAim`).

**Auto-aim** — `autoAim: <deg>` in the entry (e.g. `sam_rifle: autoAim: 5`; also works on any
`GUNS` entry in main.js; default 0 = off). On every shot `fire()` calls
`shooting.autoAim(muzzle, barrel, deg, speed)`: the best target inside the cone of half-angle `deg`
around the barrel (no lock marker is drawn — removed at the user's request) — standing plates (not fallen), flying clays, alive/knocked ENEMY dogs (allies
skipped; body centre) — smallest angle wins, within ~0.15° the nearer one; the bullet is launched
at its centre with the exact ballistic angle for the gun's `speed` and lead `v·t` for moving
targets (gravity per projectile: 9.81, mana 2.5). Only the bullet direction changes, the gun pose
does not; the search runs only on shots. New target types join by adding
`aimTargets(visit)` to their `addShootable` handler: `visit(centre: Vector3, vx, vy, vz)` per live
target, no allocations (see robodog-horde.js / clays.js). Debug: `__sceneState.shooting.autoAimLock()`.

**Mana projectile** — `projectile: 'mana'` (+ optional `projectileColor: 0xRRGGBB`, default cyan
`0x39c6ff`; `gravity` m/s², mana default 2.5) and `sound: 'mana'` in the entry (or a GUNS entry):
glowing orb with trail and sparkles on the bullet's own ballistic path (`scene/mana.js`, one
instanced additive draw), blue muzzle glow + ring, magic burst on any hit; no tracer, smoke, AK
flash, casings, metal sparks. Hit logic, damage and auto-aim are unchanged.

**Homing** — `homing: { delayS = 0.05, turnDegS = 360, gravity = 0 }` + `autoAim: <deg>`: the
target is picked in the auto-aim cone at fire time, the projectile leaves ALONG the barrel and after
`delayS` steers its velocity toward the target's CURRENT centre (lead v·t) — turn rate
`max(turnDegS, 2·angle / timeToGo)`, so the arc is visible and always converges; constant speed.
Target gone (`aimTargets` no longer lists its `key`) or overshot → continues straight. Numeric flight
in `shooting.js stepHoming` (1/120 s steps, each step is a hit segment), mana orb follows via
`mana.track` (trail along the last head positions). Providers MUST pass a stable key:
`visit(centre, vx, vy, vz, key)` (dog object, clay, drone). `sam_rifle`: `autoAim: 15, speed: 100,
homing: { delayS: 0.04, turnDegS: 240 }` — hits 20/40/60 m targets 10–14° off the barrel in
0.25/0.4/0.64 s with a 4–14 m sideways arc. Sound: effects-and-sound.md (`manaShot`/`manaHit`).

**Black hole projectile** — `projectile: 'blackhole'` (`cosmo_sniper`, «Космо-снайперка»): no bullet;
`shooting.shoot` hands off to `scene/blackhole.js` (`blackhole.fire(from, dir, { k })`, also wakes the
horde/drones via `shootables[].shot`). A travelling hole (≤ 3; a 4th collapses the oldest): flies straight
(no gravity) at `92 − 12k` m/s with drag 0.15/s (~200–260 m), lives `2.8 + 1.7k` s or until the ground, then collapses
(shrinks + brightens for `COLLAPSE_SWELL_S / rate` so the reversed swell of the sound ends on the
burst) → flash, rings, sparks, captured particles flung out, blast (`3 + 9k` m: damage + outward push
to dogs/drones/plates, `screenShake` by distance). Gravity in `R = 4 + 15.5k` m: `a = min(120, A·0.3R/max(r,1))·(1 − (r/R)⁴)`,
`A = 36 + 44k`, × mass factor `scale^−0.6` (dogs), `span^−0.5` (drones), × 0.6 for allies.
**Capture = death** (user): an ENEMY dog/drone of any size where the raw pull `a > CAPTURE_A` (10), or
anyone (allies too) inside the core, is killed at once (`unit.strike(…, 1e4)` / `droneStrike(…, 1e4)`,
≤ 3 kills per substep); corpses in the vortex stay `dying` (sparks, arcs) and tumble on an orbit with
random particle kicks (≤ `SWIRL_MAX` 4 simulated, = horde `RAGDOLL_MAX`); beyond that they are dragged
along the ground (`unit.drag(dx, dz, dt)` → `ragdoll.drag`: shift, same pose, sinks to the ground at
≤ 5·√s m/s, follows terrain — safe to call every substep; the old `ragdoll.pos` shift + instant
`unit.settle()` dropped an airborne corpse to the ground in one frame, ≤ 6 per substep); captured drones spin hard.
Allies outside the core: alive with `a > 10` → `unit.knock` + toss (≤ `LIFT_MAX` 6 lifted ragdolls at once), held airborne by the hook
`unit.holdDown()` (robodog-unit.js: resets the «down» timer); heavier/over cap — slide toward it +
stagger; corpses (dying / awake / close) pulled via `ragdoll.push`; near the core the ragdoll velocity
is pulled toward the hole's (captured dogs are carried along). Core (`0.9 + 1.6k` m): `unit.strike` /
`shared.droneStrike` every 0.3 s. Drones: velocity + yaw spin. Plates: knocked once per hole; flying
clays pulled. Never within `SAFE_M` 6 m of the player's head or the tower (`shared.towerPos`).
Look: one camera(head)-facing quad per hole, ShaderMaterial with premultiplied alpha (black core +
dark-violet fresnel rim, tilted accretion disc from a cached 256×64 periodic noise texture
`__sceneState.bhNoise` — bands rotate ∝ r^−1.5, white-blue → violet → orange, doppler side, front half
over the core, lensed far side around the shadow, photon ring, halo, dark haze; flattening from the
view elevation), + one additive particle batch (orbiting streaks in hole-relative coords, ground grit
sucked up, bursts). 2 draws when active, hidden when idle; buffers written once per frame (last world
substep). Telemetry `[blackhole] cpu=… holes= parts= lifted=` every 5 s.
**Charge** — `charge: { minS: 0.3, maxS: 3 }` in the entry (main.js `chargeStep`, real time): the
trigger charges, release fires with `shot.charge = k = clamp((held − minS)/(maxS − minS))`; charging
starts only when `gapMs` (game time) has passed. While charging `shooting.chargeFx(item, k, s)` draws a
growing pulsing hole at the muzzle — a disc mesh in the plane ⟂ BARREL (the gun's world quaternion,
spinning about the barrel; same `heat/disc` GLSL cut out of `holeFragment`) + a black fresnel-rim core
sphere, streaks orbit in that plane (2 extra draws only while charging) — + whine, `buzz()` every 90 ms
growing with k; full → flash + «дзинь» + strong buzz. `chargeFx(null)` when released/dropped. Sound:
`scene/blackhole-sound.js` (own baked bank `__sceneState.bhSoundBank`, voices `__sceneState.bhVoices`:
4 one-shots + 2 loops — rumble of the nearest hole, charge whine with rate 0.55→2.15). Debug:
`__sceneState.shooting.blackhole.stats()`; desktop only: `.blackhole.fire(from, dir, { k, speed })`.

**Arena projectiles** — `projectile: 'rocket' | 'rail' | 'plasma'` (`rocket_launcher`, `railgun`,
`plasma_gun`). Code `scene/arena-weapons.js` (owned by shooting.js like mana/blackhole; FX + splash)
and `scene/arena-sound.js` (JS-baked bank `__sceneState.arenaSoundBank`, voices `__sceneState.arenaVoices`:
10 one-shot HRTF + 1 looping hiss given to the nearest rocket). No casings / AK flash / tracer.
- **Rocket**: a bullet of the shooting.js pool with `b.g = gravity` (entry `speed: 48, gravity: 7` —
  visible arc; drop ≈ 3.8 m at 50 m) and `b.life = ROCKET_LIFE` 4 s; arena draws the same parabola
  (`fire(kind, from, dir, speed, g)`): instanced body (nose along the velocity tangent, rolls), flame
  + glow + exhaust sparks, smoke trail through the shared smoke system (`effects.smokePuff` →
  `smoke.puff`, step 0.5 m near / `dist·0.035` far; smoke CAP raised to 280). Contact with anything
  (ground, plate, clay, dog, drone) or end of life → `arena.impact(id, point, what)` → explosion:
  `artillerySystem.explode(x, y, z, 0.3)` (new artillery API: scaled-down shell blast, FX only;
  air bursts skip crater/scorch) + flash, shock ring, sparks; splash `ROCKET_R` 4 m (+0.4×scale): enemy
  dogs `unit.strike` dmg `1 + 5k²` (kill → `unit.blast`, small/medium → `unit.knock`), corpses blasted,
  drones `droneStrike` + push, plates knocked; allies unharmed; `screenShake(min(0.85, 2.4/d))` < 32 m.
  Direct hit also does the bullet hit with `shotKind: 'ak'`. Gap 800 ms.
- **Rail**: `shooting.js railShot` — instant, no bullet: ground by 1.5 m march + bisection (≤ 300 m),
  candidates = every plate intersection, clay, each horde unit `unit.cast`, each drone sphere; sorted,
  each hit through its normal handler with a 0.35 m `castExtra` from 5 cm before it (so damage/legs/
  allies/corpses behave like a bullet with `shotKind: 'awp'` → small/medium/large dogs die, legs break).
  `arena.rail(...)`: core + soft glow + green helix ribbon (vertex-shader strip, 1024 segments, first
  60 m, pitch 0.55 m, radius grows as it fades over 1 s, front sweeps out at 2600 m/s), sparks at
  each hit and at the end. Debug: `__sceneState.shooting.railInfo()` → `{ far, ground, candidates, hits, any }`.
- **Plasma**: pool bullet with `g = 0`, `speed: 50`, `gapMs: 90` (~11/s), `shotKind: 'pistol'` (1 dmg);
  blue core + halo + short streak trail; impact: rings (radius `PLASMA_R` 1 m), flash, sparks, and if it
  did not hit a shootable directly — 1 dmg splash to enemy dogs/drones within ~1 m. Hit sound ≤ 1/45 ms.
- Draws: sprites (one additive InstancedBufferGeometry; kinds core/glow/ring/streak/flame), beams,
  rocket bodies — each hidden when empty (3 warm frames). Telemetry `[arena]` every 10 s while active.
  Debug: `__sceneState.shooting.arena.stats()`. Desktop test: spawn `gen:<id>` via `weaponDebug`, pose
  the item, `weaponDebug.fire(index)`; or `shooting.shoot(from, dir, { projectile: 'rail' })`.

How the swap works: `buildGenerated` returns one item (pistols.js does not copy it) with a fixed
`group` → `visual` child (placeholder / card meshes / GLB meshes), `outline` mesh, trigger pivot,
scope mount; `muzzle`/`ejector` vectors are updated in place. Heavy work (mask analysis, canvases,
GLB prep) is done once per id+v+code version in `__sceneState.genGunCache`; geometries/materials are
shared (`userData.shared`, `pistols.remove` skips them). Card ready in cache → shown in the same
frame; otherwise placeholder until the promise resolves. Debug: `__sceneState.weaponDebug.items()`
(each gen item has `gen.shows`: `placeholder | card | glb`), `.spawn('gen:m16')`, `.gen()`.

Verify without the headset: on the `[desktop]` page only
(`if (/Quest|OculusBrowser/.test(navigator.userAgent)) return 'skip'` — not `if (session)`: the Quest
page has no session while the user is out of VR) `__sceneState.weaponDebug.spawn('gen:<id>')`, then
move `weaponDebug.items().at(-1).group` in front of `camera` and `return await screenshot()`. Objects
added to `root` by an eval vanish at the next scene swap (other agents edit in parallel) — re-run.

<a id="new-projectile"></a>
## Новый снаряд / новое действие выстрела

Fill-in-the-template job. The template is THREE files, so three agents work at once, each in its own
file only (`scene/projectiles/`):
- `_template.js` → `<name>.js` — **logic**: `[П1]` shot (flight, landing, waiting `FUSE_S` of game
  time) and `[П2]` `detonate()` (by default a full artillery blast with player-credited area damage;
  `BLAST = false` → it only counts). It calls the other two by event.
- `_template.sounds.js` → `<name>.sounds.js` — **`[П3]` sounds**: `SOUNDS` keyed by event
  `launch | land | preStrike | strike | expire` (`{ seconds, variants, render, vol, ref, lead }`);
  a missing key is silent.
- `_template.fx.js` → `<name>.fx.js` — **`[П4]` looks**: `createFx(ctx)` → hooks
  `fire | fly | land | wait | strike | expire | update | dispose | stats`; an exception in a hook is
  swallowed with one `[<name>-fx]` warning, so the shot keeps working.
The core look (the glowing sprite, its colour, the blink) stays in the logic file.

**П0 — the dispatcher, before any agent, ~1 s:**
`npm run new:projectile -- <name> <gun id> [--speed 40] [--gravity 9.81] [--fuse 3] [--no-blast]`
(`scripts/new-projectile.mjs`). It copies the three files, registers `<name>` in `projectiles/index.js`,
adds `projectile, speed, gravity, projectileOpts.fuseS` to the gun entry and runs `scene:check`. The bare
template shot is in VR at once. `--no-blast` is for a gun whose effect is not an explosion. Then three
agents start in parallel (warm ones, see [Warm gun agents](#warm-agents)): logic П1→П2, sounds П3,
looks П4. Each touches **only** its file; logic may also tune the gun entry. Do not open `shooting.js`,
`artillery.js`, `arena-weapons.js`.

Never delete a projectile file and re-create it under the same name: Vite's module graph keeps the dead
node, `scene-hmr-guard` cuts it as an orphan («orphan cut» in `logs/npm-start.log`), and edits stop
reaching the page. Take a new name instead.

1. (П0 did it) files copied, `NAME`/`create<Name>` renamed, registered, gun entry set.
2. Logic agent: fill `[П1]`, then `[П2]` in `<name>.js`; gun fields: `speed, gravity?, gapMs, kickMs,
   kickRad, kickBackM, buzz, projectileOpts: { …anything… }`. `projectileOpts` reaches `fire({ opts })`
   untouched; no other file needs a new field.
3. Sound agent: `<name>.sounds.js` only. Looks agent: `<name>.fx.js` only. Their acceptance: below.
4. **Проверка:** `npm run test:shot -- <gun id> --enemy 3 --ally 3 --shot` (one command, ~10 s,
   desktop page only; `scripts/test-shot.mjs` → `__sceneState.testKit.shotTest`, `scene/test-kit.js`).
   It needs the desktop page in a **foreground** browser tab: a background tab throttles frames, and
   the shot never lands (`landed: 0`). It fires the gun exactly like its trigger (same `GUNS` options) 20° up from the camera, waits for
   `landed` +1, puts a frozen enemy and ally dog 3 m from `lastPoint` across the line of fire
   (shielded from the running battle: only your module's code can hurt them), waits for `strikes`
   +1, screenshots that moment, and prints ONE JSON; exit 0 only if every declared check passed:
   ```json
   {"gun":"gen:flare_shotgun","module":"flare","shots":1,"fired":1,"landed":1,"landedAfterS":2.83,
    "landPoint":[0,0.86,-107.04],"strikes":1,"strikeAfterS":6.24,"lastStrike":{"x":0,"z":-107.04,"dogs":7,"drones":2,"kills":4},
    "enemy":{"team":"enemy","mode":"dead","hp0":2,"hp":-5,"hurt":true,"dist":3,"hpAtStrike":2},
    "ally":{"team":"ally","mode":"alive","hp0":2,"hp":2,"hurt":false,"dist":3,"hpAtStrike":2},
    "killConfirm":{"kills":4,"dogs":2,"drones":2,"hits":5},"money":{"balance":140},"creditedToPlayer":true,
    "checks":{"fired":true,"landed":true,"strikes":true,"enemyHurtAndCredited":true,"allyUnharmed":true,"noPageErrors":true},
    "ok":true,"screenshot":"D:\\vr_something\\logs\\screenshots\\…-desktop.jpg","pageErrors":[]}
   ```
   It reads only your `stats()` counters, so keep the template's names: `fired`, `landed`,
   `strikes` (a missing counter is skipped, not failed), `lastPoint: { x, y, z }` (where the last one
   landed; else the newest `live[]` entry), `lastStrike: { x, z, dogs, drones, kills }`. Strike at the
   moment of landing → it places the dogs and fires a second shot (`shots: 2`). Options: `--wait 8`
   (s, raise it for long fuses), `--pitch 20`, `--yaw 0`, `--keep` (leave the dogs). Pieces for your
   own checks in vr:eval: `testKit.placeDog(team, x, z, { size, frozen, shield })`, `clearTestDogs()`,
   `fireGun(kind, { pitchDeg, yawDeg, from })`, `waitFor(fn, ms)`, `snapshotStats()`.
   `npm run scene:check` after every save; errors also land in `logs/page-console.log`. A file
   that nothing imports yet (the copy before step 2) makes `scene:check` wait: register first.
   **Vite trap:** a module file deleted and re-created under the same name (or saved several times
   quickly) can stay stale while `scene:check` says OK. Edit it once more, then confirm the new code
   is live, e.g. `npm run vr:eval -- "String(__sceneState.shooting.projectiles.<name>.update).includes('<new bit>')"`.

**Module contract** (`create<Name>(ctx)` returns; all optional except `fire`): `life` (s of flight,
default 3), `gravity` (default 9.81), `pool: false` (fly yourself: only `fire` is called);
`fire({ from, dir, speed, g, opts }) → id > 0` (play the launch sound here, `duck: true`);
`move(id, pos, age)` each substep in flight; `impact(id, point, what, vel)` — `what` 1 ground,
2 plate, 3 stand, 4 dog/drone/clay (direct hit already applied); `expire(id, point)` — ended in the
air or evicted; `update(dt)` game-time substep (`Math.min(MAX_STEP_S, dt)`, no `performance.now()`);
`stats()`; `dispose()` (remove meshes from `group`, dispose own materials, not cached textures).
`from`/`dir`/`point`/`pos` are shared vectors: copy them.

**ctx helpers**: `THREE, group, camera, shared, effects, groundAt(x, z)`;
`areaDamage(point, radius, maxDamage, { credit: 'player' | null, allies = false, push = 1 })` →
`{ dogs, drones, kills }` (dogs and drones, allies spared; `'player'` gives hitmarker, «клац», money);
`strike(x, z, { damage = 0, radius = 7.5, credit = 'player', sound = true, shake = true })` — full
artillery shell blast on the ground (fireball, crater, scorch, boom, shake; with `damage` it calls
`areaDamage`); `explode(x, y, z, S = 0.3)` — small blast, visuals only;
`soundBank(key, { snd: { seconds, variants, render(d, sr) } }, { voices })` →
`play(snd, point, vol, { rate, ref, duck })` (baked once, fixed voices; also importable with
`normalize`, `fadeTail` from `../sound-bank.js`); `smokePuff(...)`, `plates()`, `knockPlate(p, point, dir)`.
Same handles in vr:eval: `__sceneState.areaDamage`, `__sceneState.artillerySystem.strike`.

<a id="tz-template"></a>
## ТЗ новой пушки — шаблон

Every generated gun's code work (projectile, special shot, effect) is written and accepted by this
spec. Filled-in example: [tz/flare-shotgun.md](tz/flare-shotgun.md).

**Выдача по частям (leading rule).** The user is in VR and looks at the gun right away:
- every priority, or a working half of one, goes live at once: save → `npm run scene:check` = OK →
  hot-swapped; nothing is held back "until the end";
- right after each accepted priority: a short `SendMessage` to `main` with what is live and the key
  numbers («П1 в игре: свеча летит и горит; дальность ~35 м, 20 м/с»), the dispatcher tells the user;
- user tweaks relayed mid-way beat the plan: apply, ship, continue;
- every save keeps the gun shooting (no half-states that break the shot).

**Who does what, in parallel.** П0 is the dispatcher's `npm run new:projectile` (~1 s, the bare shot is
live). Then three agents at once, each in its own file: **logic** П1 → П2 in order (`<name>.js`),
**sounds** П3 (`<name>.sounds.js`), **looks** П4 (`<name>.fx.js`). Each announces its own steps to
`main`. The sound and looks agents start from the spec and the template stub, not from the logic
agent's code: the events and hooks are fixed in advance.

**Spec skeleton** (copy into `docs/agents/tz/<id>.md`; within the logic file the next priority comes
only after the previous is accepted):
- **П1 — the shot works** (required): trigger → the projectile, rate, speed, arc, what it looks like
  in flight and where it ends; caps (max alive, life).
  **Приёмка:** `npm run test:shot -- <id> --shot` (step 4 above): `fired: 1`, `landed: 1`,
  `landPoint` on the ground, `pageErrors: []`; look at the screenshot.
- **П2 — main effect and damage, credited to the player** (required): what happens, when (game
  time), radius and damage; allies spared.
  **Приёмка:** `npm run test:shot -- <id> --enemy 3 --ally 3 --shot` (needs the dog battle on) →
  exit 0: `strikes: 1`, `checks.enemyHurtAndCredited` (enemy `hurt`, `killConfirm` kills/hits grew),
  `checks.allyUnharmed`; screenshot of the effect.
- **П3 — sounds** (own agent, `<name>.sounds.js` only): which events sound and how (`launch`, `land`
  = burning/idle, `preStrike` + `lead`, `strike`, `expire`); baked, `launch` ducks the world by itself.
  **Приёмка:** `npm run test:shot -- <id>` exit 0 (the shot still works), then
  `npm run vr:eval -- "__sceneState.projectileDebug.<name>.stats().sound"`: `baked` lists every
  sound with ≥ 1 variant, `played` grows per shot; no `[<name>-sound]` warnings in `logs/page-console.log`.
- **П4 — looks** (own agent, `<name>.fx.js` only): muzzle flash, trail, flame, smoke, sparks; pools,
  no `new` per frame; shader warm-up if a new material. **Приёмка:** `npm run test:shot -- <id> --shot`
  exit 0, `stats().fx` (your own counters), no `[<name>-fx]` warnings, screenshot viewed, first shot
  without a hitch (`[perf] worst`).
- **Docs** (whoever finishes last): a line in the recipe, `npm run docs:index`.

**Report** per priority: «принято» + evidence (the `stats()` numbers, screenshot path) or
«не сделано — почему». Plus `FIRST WORKING: <time>` when П1 and П2 are accepted.

<a id="warm-agents"></a>
### Warm gun agents (pre-briefed, waiting)

So that no agent spends its first seconds reading, the dispatcher keeps three agents already briefed:
`gun-logic-warm`, `gun-sound-warm`, `gun-fx-warm` (pipeline model, see «Agents»). Each one:
- is spawned with the warm-up prompt: read this recipe's [Новый снаряд](#new-projectile) and
  [ТЗ](#tz-template) sections, the template file(s) for its role, the filled-in example
  `tz/flare-shotgun.md` (the gun itself was removed from the game); reply `ГОТОВ` in one line
  and **stop**, editing nothing;
- gets the job later via `SendMessage` (to its name): gun id, projectile name, the spec path or the
  spec text. Its context is intact, so it starts writing at once;
- is used for ONE gun. Right after handing it a job, the dispatcher spawns a fresh warm agent of the
  same role for the next gun, so the done one's context does not grow.
Order for a new gun: placeholder entry → `npm run new:projectile` (П0) → spec file → `SendMessage` to
the three warm agents → spawn three new warm agents.

## New grabbable item

Self-contained module with the same `update({...})` signature as `text-test.js`, so main.js
only forwards the grip state. Choose the style: `'relative'` (stays where it is relative to the
hand, «относительно схватить») or `'absolute'` (snaps into a seat in the hand, «абсолютно»).

```js
// scene/lantern.js
import { createRelativeGrab } from './relative-grab.js';

const REACH_M = 0.15;

export function createLantern({ THREE, root, camera, shared, mode = 'relative' }) {
  const group = new THREE.Group();
  group.name = 'lantern';
  const geometry = new THREE.BoxGeometry(0.08, 0.14, 0.08);
  const material = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.6 });
  group.add(new THREE.Mesh(geometry, material));
  root.add(group);

  const savePose = () => {
    shared.lanternPose = { p: group.position.toArray(), q: group.quaternion.toArray() };
  };
  if (shared.lanternPose) {
    group.position.fromArray(shared.lanternPose.p);
    group.quaternion.fromArray(shared.lanternPose.q);
  } else {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    group.position.copy(head).addScaledVector(dir.normalize(), 0.6);
    group.position.y -= 0.3;
  }

  const relative = createRelativeGrab({ THREE, object: group });
  const SEAT = new THREE.Matrix4().makeTranslation(0, 0.03, -0.08); // absolute: seat in hand space
  const world = new THREE.Matrix4();
  const center = new THREE.Vector3();
  let held = false;

  return {
    get held() {
      return held;
    },
    // called from main.js inside `if (hand)`, after the nearest weapon/clay search
    update({ gripWorld, handPosition, gripDown, gripWasDown, gripMode, menuIsOpen, handBusy, source }) {
      const pressed = gripDown && !gripWasDown;
      if (held) {
        const letGo = gripMode === 'hold' ? !gripDown && !menuIsOpen : pressed && !menuIsOpen;
        if (letGo) {
          held = false;
          relative.release();
          savePose();
          source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.2, 90);
          return;
        }
        if (mode === 'relative') relative.update(gripWorld);
        else world.multiplyMatrices(gripWorld, SEAT).decompose(group.position, group.quaternion, group.scale); // root is at identity
        return;
      }
      const near = !handBusy && group.getWorldPosition(center).distanceTo(handPosition) < REACH_M;
      if (near && pressed && !menuIsOpen) {
        held = true;
        if (mode === 'relative') relative.grab(gripWorld);
        source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
      }
    },
    dispose() {
      savePose(); // survives the swap; add a localStorage key too if it must survive a reload
      root.remove(group);
      geometry.dispose();
      material.dispose();
    },
  };
}
```
Wire it in `scene/main.js`:
```js
import { createLantern } from './lantern.js';
const lantern = createLantern({ THREE, root, camera, shared });          // setup
// update, inside `if (hand) {`: guard the weapon/clay search
if (!heldItem && !heldClay && !recalibratingItem && !textTest.held && !lantern.held) {
// update, right after textTest.update({...}):
lantern.update({
  hand, gripWorld, handPosition, gripDown, gripWasDown, gripMode, menuIsOpen, source,
  handBusy: Boolean(heldItem || heldClay || recalibratingItem || nearItem || nearClay || textTest.held),
});
// and add `|| lantern.held` to textTest's handBusy
lantern.dispose();                                                         // dispose
```
Weapons/clays near the hand win (they are searched first and `handBusy` blocks the lantern).
If the item should block firing or the X spawn while held, also check `lantern.held` there.
For a seat that the user can tune later, copy the weapon calibration idea
(`calib = inverse(gripWorld) × item.matrixWorld`, saved in localStorage).

## Add a sound

Never build a node graph per call (that broke audio under rapid fire, see
[effects-and-sound.md](effects-and-sound.md#soundjs)). In `scene/sound.js`, synth sounds are
recipes baked once into buffers and played through pooled voices:
```js
// 1. RECIPES: draw into `out` at time t (works in OfflineAudioContext)
  bell(c, out, t) {
    tone(c, out, t, { from: 1760, gain: 0.3, decay: 0.8 });
    tone(c, out, t, { type: 'triangle', from: 2640, gain: 0.12, decay: 0.5 });
    noise(c, out, t, { seconds: 0.03, type: 'highpass', from: 6000, to: 4000, gain: 0.2, decay: 0.02 });
  },
// 2. BAKES: [recipe, variants, seconds]
  bell: ['bell', 3, 0.85],
// 3. method on the returned object (pool 'impact' = HRTF, 'mech'/'small' = equalpower, 'gun' = near field)
    bell(position) {
      return safe(() => play('impact', pick(shared.soundBank?.fx.bell), { position, gain: 0.6, wet: 0.4 }));
    },
```
Then bump **`BAKE_VERSION`** (rebakes the bank) and **`SOUND_VERSION`**. Call it:
`shared.sound?.bell?.(worldPosition)`; without a position it plays at the listener.

Sample sound: put `web/public/sounds/<name>.ogg` (record the licence) and decode it in
`loadBank` into `bank.fx.<name>` (like the gun files), then `play(...)` it the same way.
Rate-limit bursts (see `SOUND_BURST` in clays.js); pools also cap and steal the oldest voice.

## Add an effect

Small one-shot on shots/hits: add a method to `effects.js` using `spawn(...)`, then expose it
through shooting.js (only shooting holds `effects`), like `puff`:
```js
// effects.js return object
    ring(point) {
      spawn(sphere, { color: 0x9be7ff, additive: true, opacity: 0.8 }, point, { life: 250, scale0: 0.02, scale1: 0.2 });
    },
// shooting.js api
    ring(point) {
      effects.ring(point);
    },
```
Continuous or many particles: own pooled module, one draw call, no allocations per frame
(the smoke/tracer pattern, simplified with `InstancedMesh`):
```js
// scene/sparkles.js
const CAP = 128;
export function createSparkles({ THREE, root }) {
  const geometry = new THREE.SphereGeometry(1, 6, 4);
  const material = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geometry, material, CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color()); // creates instanceColor
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false; // shader compiles at scene start, not on the first burst
  mesh.renderOrder = 2;
  root.add(mesh);

  const px = new Float32Array(CAP), py = new Float32Array(CAP), pz = new Float32Array(CAP);
  const vx = new Float32Array(CAP), vy = new Float32Array(CAP), vz = new Float32Array(CAP);
  const age = new Float32Array(CAP), life = new Float32Array(CAP);
  let count = 0;
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const color = new THREE.Color(), base = new THREE.Color(0xffd27a);

  return {
    burst(point, n = 12) {
      for (let k = 0; k < n; k += 1) {
        const i = count < CAP ? count++ : Math.floor(Math.random() * CAP); // full: overwrite one
        px[i] = point.x; py[i] = point.y; pz[i] = point.z;
        vx[i] = (Math.random() - 0.5) * 3; vy[i] = Math.random() * 3; vz[i] = (Math.random() - 0.5) * 3;
        age[i] = 0; life[i] = 0.4 + Math.random() * 0.4;
      }
    },
    update(dt) {
      const h = Math.min(dt, 0.05);
      for (let i = count - 1; i >= 0; i -= 1) {
        age[i] += h;
        if (age[i] >= life[i]) { // swap-remove
          count -= 1;
          px[i] = px[count]; py[i] = py[count]; pz[i] = pz[count];
          vx[i] = vx[count]; vy[i] = vy[count]; vz[i] = vz[count];
          age[i] = age[count]; life[i] = life[count];
          continue;
        }
        vy[i] -= 9.8 * h;
        px[i] += vx[i] * h; py[i] += vy[i] * h; pz[i] += vz[i] * h;
      }
      for (let i = 0; i < count; i += 1) {
        const k = 1 - age[i] / life[i];
        m.compose(p.set(px[i], py[i], pz[i]), q, s.setScalar(0.006 * k + 0.002));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, color.copy(base).multiplyScalar(k)); // additive: darker = fainter
      }
      mesh.count = count;
      mesh.visible = count > 0;
      if (count) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      root.remove(mesh);
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
```
Create in `setup`, call `sparkles.update(dt)` near `shooting.update(dt)`, dispose in `dispose()`.
Custom `ShaderMaterial` instead? End the fragment shader with `#include <colorspace_fragment>`.
Patching a built-in material with `onBeforeCompile`? Set a `customProgramCacheKey` and bump it on
every GLSL change. Never add a light per effect (animate one permanent light).

## World-space panel with stick input

Template distilled from `ipd-panel.js` / `laser-panel.js`:
```js
// scene/volume-panel.js
const W = 1024, H = 576, PANEL_W_M = 0.4, DISTANCE_M = 0.6;
const STICK_ON = 0.5, STICK_OFF = 0.3, TRIGGER = 0, GRIP = 1;

export function createVolumePanel({ THREE, renderer, camera, root, shared }) {
  shared.volume ??= 5;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W_M, (PANEL_W_M * H) / W),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: false }),
  );
  mesh.renderOrder = 950;
  mesh.visible = false;
  mesh.name = 'scene-volume-panel';
  root.add(mesh);

  let painted = '';
  const paint = () => {
    const key = String(shared.volume);
    if (key === painted) return; // repaint (and re-upload) only on change
    painted = key;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(15, 23, 42, 0.92)';
    g.beginPath();
    g.roundRect(8, 8, W - 16, H - 16, 40);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 160px system-ui, "Noto Sans", sans-serif';
    g.fillText(key, W / 2, H / 2);
    texture.needsUpdate = true;
  };

  const head = new THREE.Vector3();
  const forward = new THREE.Vector3();
  let open = false;
  let releaseFirst = false; // the button that opened/closed the panel is still held
  let wasTrigger = true;
  let wasGrip = true;
  let stickDir = 0;

  return {
    open() {
      camera.getWorldPosition(head);
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      mesh.position.copy(head).addScaledVector(forward, DISTANCE_M);
      mesh.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0); // faces the player
      painted = '';
      paint();
      mesh.visible = open = releaseFirst = true;
      stickDir = 0;
    },
    get isOpen() {
      return open;
    },
    busy() {
      return open || releaseFirst;
    },
    update(source, menuOpen) {
      const buttons = source?.gamepad?.buttons ?? [];
      const trigger = Boolean(buttons[TRIGGER]?.pressed);
      const grip = Boolean(buttons[GRIP]?.pressed);
      if (releaseFirst && !trigger && !grip) releaseFirst = false;
      if (open && !menuOpen) {
        if (!releaseFirst && ((trigger && !wasTrigger) || (grip && !wasGrip))) {
          open = mesh.visible = false;
          releaseFirst = true; // don't let this press fire or grab
        } else {
          const x = source?.gamepad?.axes?.[2] ?? 0;
          const dir = x > STICK_ON ? 1 : x < -STICK_ON ? -1 : Math.abs(x) < STICK_OFF ? 0 : stickDir;
          if (dir !== stickDir) {
            stickDir = dir;
            if (dir) {
              shared.volume = Math.min(10, Math.max(0, shared.volume + dir));
              source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.15, 15);
            }
          }
        }
        paint();
      } else if (open) {
        stickDir = 0; // the stick belongs to the wheel while it is open
      }
      wasTrigger = trigger;
      wasGrip = grip;
    },
    dispose() {
      root.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      texture.dispose();
    },
  };
}
```
Wire in `scene/main.js`:
```js
const volumePanel = createVolumePanel({ THREE, renderer, camera, root, shared });   // setup
// update, next to ipd.update(...), BEFORE panelBusy/menuIsOpen are computed:
volumePanel.update(source, menuNow || menuWasOpen);
const panelBusy = ipd.busy() || volumePanel.busy();   // blocks fire, grabs, X spawn
// onMenu:
} else if (picked.label === 'Громкость') {
  volumePanel.open();
// dispose:
volumePanel.dispose();
```
Persist the value with `localStorage` in `try/catch` if it must survive a reload. Selection by
shooting at the panel: see `laserPanel.cast/shoot` in [panels.md](panels.md).

## Per-frame system with telemetry

```js
// scene/birds.js
const LOG_EVERY_MS = 5000;
export function createBirds({ THREE, root }) {
  let sum = 0, worst = 0, frames = 0, since = performance.now();
  // ... scratch vectors allocated here, once
  return {
    update(dt) {
      const t0 = performance.now();
      // ... work, no allocations
      const spent = performance.now() - t0;
      sum += spent; worst = Math.max(worst, spent); frames += 1;
      if (t0 - since >= LOG_EVERY_MS) {
        console.log(`[birds] cpu=${(sum / frames).toFixed(2)}/${worst.toFixed(2)}ms n=${frames}`);
        sum = worst = frames = 0;
        since = t0;
      }
    },
    dispose() { /* remove what is outside root, stop timers */ },
  };
}
```
Call it from `update` in main.js before `liveLeft -= dt` (with the other `*.update(dt)` calls);
dispose it in `dispose()`. Compare `[perf] cpu=` and `calls/tris` before and after in
`logs/page-console.log`. Remove or slow down the log once tuned.

## Verify

```powershell
npm run scene:check                                   # OK / error text / not connected
npm run vr:eval -- "root.children.map(c => c.name)"   # inspect
npm run vr:eval -- "__sceneState.shooting.targetsEnabled()"
npm run vr:eval -- "recording"                        # must be false before a shell edit
npm run vr:shot                                       # prints logs\screenshots\....jpg -> open with Read
npm run vr:eval -- "await screenshot({ eyes: 'left', width: 1600 })"
Get-Content logs\page-console.log -Tail 30            # [perf], [wheel] выбрано, errors
```
- With both `[quest]` and `[desktop]` pages connected each answer is tagged; the desktop page
  has no XR (`session` null, no controller). Judge visuals on `[quest]`.
- A screenshot shows only what is rendered; if the headset is off the page draws no frames and
  the eval times out (`--timeout 30`).
- Things placed "in front of the player" use the head pose: check with
  `npm run vr:eval -- "camera.getWorldPosition(new THREE.Vector3())"`.
- Don't change the user's world to test (spawning, firing, moving items) unless asked; prefer
  reading state and screenshots.
