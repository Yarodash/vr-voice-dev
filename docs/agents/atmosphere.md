# Atmosphere: weather, time of day, seasons, sky styles

User request (2026-11-25): add weather phenomena, times of day, seasons and several sky styles to the
game, **with smooth transitions between any two states**, plus sound effects. The user will not look at
it in VR for now, so agents verify everything themselves on the desktop page.

One module owns the state (`scene/atmosphere.js`); everything else only **reads** it. Nobody but the
state module writes into `now`.

## Files and owners

| File | What | Owner agent |
|---|---|---|
| `scene/atmosphere.js` | state, presets, blending, API, persistence, lightning scheduler | `atmosphere-state` |
| `scene/menu.js`, `scene/main.js` (wiring, `onMenu`) | menu «Погода и небо ▸», create/update/dispose | `atmosphere-state` |
| lights, exposure, `scene.fog`, `sun-shadows.js` | how scene objects (dogs, guns, drones) are lit | `atmosphere-state` |
| `scene/world.js` | sky, clouds, sun, moon, stars, rainbow, ground, grass | `world-sky-seasons` |
| `scene/weather-fx.js` (new) | rain, snow, hail, dust, leaves, splashes, lightning bolt | `weather-particles` |
| `scene/weather-sound.js` (new) | rain, wind, thunder, hail, nature ambience | `weather-sound` |

`weather-fx.js` and `weather-sound.js` are wired into `main.js` by their own agents: one import, one
`create…(ctx)`, one `update(dt)`, one `dispose()`; small `Edit`s only.

## The state: `__sceneState.atmosphere`

```js
const atmo = shared.atmosphere;      // also __sceneState.atmosphere in vr:eval
atmo.now                             // current smooth values, the SAME object every frame (mutated in place)
atmo.setWeather(id, seconds = 25)    // blend to a weather preset
atmo.setTime(idOrHour, seconds = 8)  // blend to a time of day (the sun travels along its path, shortest way)
atmo.setSeason(id, seconds = 20)
atmo.setSky(id, seconds = 6)
atmo.setFlow(minutesPerDay)          // 0 = time stands still
atmo.setAutoWeather(on)              // weather changes by itself, suited to the season
atmo.setWind(degrees, seconds = 3)   // fix the wind: degrees it blows TO (0 → +X, 90 → +Z, 180 → −X, 270 → −Z);
                                     // setWind(null) — the wind chooses its direction itself again
atmo.target                          // { weather, time, season, sky, flow, auto, wind } — what was chosen (wind: null | degrees)
atmo.WEATHERS / TIMES / SEASONS / SKIES   // [{ id, name }] — name is the Russian menu label
atmo.on('lightning', fn) → off()     // fn({ x, y, z, distM, power })  — a strike point in the world
atmo.update(dt, realDt)              // called by main.js BEFORE world / fx / sound updates
// for checks and screenshots (vr:eval):
atmo.snap()                          // finish all blends now; wet / puddles / snowCover as if the weather had lasted long
atmo.reset(seconds = 0)              // back to the first-run state (partlyCloudy, sunset, summer, pink, time stands, auto off)
atmo.strikeNow()                     // one lightning strike right now, in any weather (event + flash)
atmo.rev                             // number, grows with every change of the choice (main.js rebuilds the menu on it)
```

`seconds = 0` in `setWeather` / `setSeason` is instant and also settles `wet` / `puddles` / `snowCover`
to what that weather and season give. The event object of `on('lightning')` is reused: copy the numbers.

Debug handles of the readers (all in `vr:eval`, none of them touches `atmo`):
- sky, ground, grass: `__sceneState.atmoOverride = __sceneState.worldDebug.makeNow()` — a private state
  object only for `world.js` (it has `sun(elevDeg, azimuthDeg)`; change its fields freely);
  `__sceneState.atmoOverride = null` returns the real one. `__sceneState.skyLook` — what the sky gives the
  ground right now (`sunLight`, `skyLight`, `horizonSun`, `horizonFar`, `zenith`, `lightDir`, `night`, `shadow`, `snow`).
- particles: `__sceneState.weatherFxDebug.set({ rain: 1, wind: 0.5 })` overrides fields of `now` for
  `weather-fx.js` (`.clear()` — the real ones again), `.strike({ distM: 400, side, power })` draws a bolt
  (`side` — metres sideways from the line of sight), `.stats()`.
- sound: `__sceneState.weatherSoundDebug.set({ rain: 1, wind: 1.2, gust: 0.5 })` overrides fields of `now`
  for `weather-sound.js` only — **while it is set, real `lightning` events make no thunder** and the sound
  does not follow the weather, so always `.clear()` after a check; `.thunder(distM, power, azimuthDeg)`
  plays a thunder after `distM / 343` s (works with the override too), `.stats()` (layers, node counts,
  `played`, `errors`); master volume `__sceneState.weatherVolume` (0…2, default 1). Details:
  `docs/agents/effects-and-sound.md` «weather-sound.js».
- light on objects: `__sceneState.objectLight` (`dir`, `sun`, `amb`, `lit` — what effect shaders get),
  `__sceneState.shellLights` (the shell's original lights), `__sceneState.atmoSkyRef` (the sky colour
  the fog is matched to), `__sceneState.atmoTune` (try numbers without a scene swap).

Blends between presets run in **real** seconds. The flow of the day runs in **game** time (it follows
«Время ×N»). Choices are saved in `localStorage 'scene.atmo'`. The first run must look exactly like the
game looked before this work: pink sky, sunset on the right, the same clouds, summer.

### `atmo.now` fields

All are plain numbers in 0..1 unless said otherwise. `THREE.Vector*` and `THREE.Color` objects are
mutated in place; do not keep copies, do not write into them.

| Field | Meaning |
|---|---|
| `hour` | 0..24, game time of day |
| `sunDir`, `moonDir` | `Vector3`, world, pointing TO the body; `sunElev`, `moonElev` — degrees, below 0 under the horizon |
| `keyDir` | `Vector3` TO the key light of objects and shadows: the sun, or the moon when `sunElev < −5.5°`; never lower than 22°. It **jumps** at the switch, but the direct light is zero then. `world.shadowSun` follows it |
| `keyShadow` | 0..1, how strong the shadows of the key light are: × `sunDirect`, ≈0.4 under the moon, 0 in twilight while the light changes hands, weaker in a veil of fog / dust. Dog shadows and grass shadows scale by it |
| `day` | 0 night … 1 day, smooth through twilight |
| `sunColor`, `ambientColor` | `Color`, what lights scene objects; `sunPower`, `ambientPower` — multipliers of the usual intensity |
| `cloudCover` | 0 clear … 1 solid overcast |
| `cloudDark` | 0 white clouds … 1 heavy storm clouds |
| `sunDirect` | share of direct light that reaches the ground: 1 clear, 0 overcast (shadows fade with it) |
| `fog` | 0..1, how dense; `visibilityM` — metres (20000 clear … 30 dense fog); `fogColor` — `Color`, already matched to the time of day |
| `wind` | 0 calm, 0.3 usual, 1 storm, up to 1.5 hurricane; `windDir` — `Vector2` unit, xz, where it blows TO — **any direction of the full circle** (a new one with every change of weather, turning smoothly); `gust` — 0..1 current gust |
| `rain` | 0.15 drizzle, 0.5 rain, 1 downpour |
| `snow` | 0.25 light snow, 1 blizzard |
| `hail`, `sleet`, `dust`, `smoke` | density of the particles / haze |
| `leaves` | flying leaves, debris, petals |
| `wet` | wet surfaces; grows in rain, dries slowly |
| `puddles` | standing water; grows only in real rain |
| `snowCover` | snow lying on the ground; grows in snowfall, melts by season (stays in winter) |
| `lightning` | how often lightning strikes; `flash` — brightness of a flash right now |
| `rainbow` | visible rainbow |
| `spring`, `summer`, `autumn`, `winter` | season weights, sum 1 |
| `sky` | `{ pink, gold, blue, cosmic }` sky-style weights, sum 1 |

### Ids and Russian names

- **Weather** (18): `clear` Ясно, `partlyCloudy` Переменная облачность, `overcast` Пасмурно, `drizzle`
  Морось, `rain` Дождь, `heavyRain` Ливень, `thunderstorm` Гроза, `lightSnow` Лёгкий снег, `blizzard`
  Метель, `hail` Град, `sleet` Дождь со снегом, `mist` Дымка, `denseFog` Густой туман, `windy` Ветрено,
  `dustStorm` Пыльная буря, `sunshower` Слепой дождь, `smog` Смог, `hurricane` Ураган.
- **Time** (10, in order): `preDawn` Предрассветные сумерки, `dawn` Рассвет, `morning` Утро, `noon`
  Полдень, `afternoon` День, `goldenHour` Золотой час, `sunset` Закат, `dusk` Сумерки, `night` Ночь,
  `midnight` Глубокая ночь.
- **Season** (4): `spring` Весна, `summer` Лето, `autumn` Осень, `winter` Зима.
- **Sky style** (4): `pink` Розовое (today's cartoon pink, the default), `gold` Золотое, `blue` Синее
  (plain blue with white clouds), `cosmic` Космическое (dark teal and violet, nebula, aurora at night).
  A style is a palette as a function of the sun height (day / low sun / twilight / night), so every
  time of day works in every style.

What each weather and time of day should look like is in the user's list: `docs/agents/atmosphere-request.md`.

## Rules for every agent here

- Quest 3S is the target and the battle is already at 60–75 fps. Each effect must be cheap:
  - precipitation — one draw call per kind, animated in the vertex shader, no per-particle CPU work;
  - no allocations per frame; no new shader programs when the weather changes (uniforms only);
  - never switch `scene.fog` or material defines on and off at run time (that recompiles shaders);
  - when a value is 0 the effect is hidden (`visible = false`), not drawn with zero alpha.
- Edit only `web/src/scene/`. Never `web/src/*.js` (that reloads the page).
- A change of several edits that break the scene one by one goes in a transaction:
  `npm run scene:tx -- begin <agent> <files…>` → edits → `npm run scene:tx -- commit <agent>` →
  `npm run scene:check` = OK.
- Verify on the desktop page: `npm run vr:eval` with the guard
  `/Quest|OculusBrowser/.test(navigator.userAgent) ? 'skip' : …`; set the camera and take the
  screenshot **in the same eval call** (other agents move the camera too); open the screenshot and look.
  Never `import()` scene files in vr:eval. No `sleep`, no unit tests.
- Research current best practice briefly before choosing a technique.
- If your module starts before `shared.atmosphere` exists, it must not throw: skip the frame.

## How it works (`scene/atmosphere.js`, `scene/atmosphere-light.js`)

**Four channels, everything else derived.** The state has four independent blend channels: the
weather vector (15 numbers per preset, table `WEATHERS`; `visibilityM` blends in log space), the hour
(0..24 on a circle, shortest way), four season weights and four sky-style weights. Each `set…` stores
the CURRENT channel values as the start and runs a smoothstep to the target in real seconds, so a
blend can be interrupted at any moment without a jump (`seconds = 0` is instant). Every other field of
`now` (sun, moon, light colours and powers, `fogColor`, `day`, `rainbow`, key light) is recomputed
each frame in `derive()` as a continuous function of the channels — that is why any combination of
transitions stays smooth. `update(dt, realDt)`: blends use `realDt`; the flow of the day, `wet` /
`puddles` / `snowCover` / `gust`, the wind direction, lightning and auto-weather use game `dt`.

**Sun and moon path.** The player looks at −Z ("south") by default, west is +X (right), east −X. The
sun moves on a great circle through the east and west points, tilted to the south by the noon height
`peak` of the season (`SEASONS`: spring 48°, summer 62°, autumn 42°, winter 24°; blended by weights):
`dir(H) = sin H · west + cos H · (cos peak · south + sin peak · up)`, `H = (hour − 12) · 15°`. Sunrise
is always at 6:00 on the left, sunset at 18:00 on the right; only the arc height changes. The `sunset`
preset hour (≈17.83) and the rotation of the west/south axes are solved so that summer sunset gives
exactly the old world.js sun (elevation 2.2°, 8° from +X toward +Z; checked to 1e-15). The moon is
"full": the same kind of arc, 168° behind the sun (rises ~50 min after sunset, high at night, still up
at dawn), higher in winter.

**Light on scene objects** (`atmosphere-light.js`, updated right after `atmosphere.update`): drives
the two shell lights (found in `scene`, restored in `dispose`), `scene.fog`, the exposure, the dog
shadow strength and the env-map reflections.
- Palette per sky style at four sun heights (`SKIES[..].keys`: night ≤ −14°, twilight −5°, low sun
  2.2°, day ≥ 35°): key-light colour and power, ambient colour and power, horizon haze colour. Weather
  then dims and tints them (`sunDirect`, cloud darkness, veil of fog / dust / smoke, snow bounce).
  A calibration at start makes the default state (pink / sunset / summer / partlyCloudy) give exactly
  `sunPower = ambientPower = 1`, white colours, `keyShadow = 1` — the lights equal the shell's 2.2 / 1.5.
  `ambientPower` never drops below 0.3 (enemies must stay readable in the headset on a stormy night).
- Key light = the sun, or the moon when `sunElev < KEY_SWITCH_ELEV` (−5.5°, **the same rule as the
  ground and grass in `sky-palettes.js`** — keep them equal). The directional power fades to zero
  around the switch (twilight is ambient only), so the direction jump is invisible. `keyDir` is that
  light lifted to ≥ 22° like world.js `shadowSun`; `keyShadow` is its shadow strength.
  The DirectionalLight follows the azimuth of `keyDir` (plus the constant offset the old
  light had from the sunset sun) and never goes below the old light's height (~59°), so in the default
  state it sits exactly at the shell's (1.5, 3, 1). The shell values are remembered once per page in
  `shared.shellLights`.
- `scene.fog` is a `FogExp2` created once and left in the scene (also after `dispose`), colour
  `now.fogColor` (three.js mixes fog after tone mapping, so the colour shows as is). The curve is a true
  exponential `1 − exp(−density · distance)` with `density = 3.9 / visibilityM − 3.9 / 16000` (≥ 0):
  98 % at the visibility distance and exactly zero at the default weather. **It is the same curve and
  the same numbers as the weather fog of the ground and grass** (`sky-palettes.js`: `look.fogP.y`,
  `VISIBILITY_TODAY`) — change them together, or dogs stand out of the haze. three.js `FogExp2` is
  squared-exponential, so the shared shader chunk `fog_fragment` is replaced as a whole once per page
  (`THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT`, before the scene materials compile).
- **Past the visibility range an object is gone, not a pale silhouette** (the user's request: a huge
  far dog covers sky of different colours and reads however well the fog colour is matched). The same
  chunk does it: while the fog share of a pixel goes from `VANISH_FROM` 0.85 to `VANISH_TO` 0.97, opaque
  materials `discard` pixels by a screen-space noise (`#ifdef OPAQUE`), transparent ones fade their
  alpha; beyond that nothing is drawn. Glowing additive things fade earlier (`GLOW_FROM` 0.7 …
  `GLOW_TO` 0.9), so that arcs, drone lights and tracers never hang in the air without the body. With
  density 0 the share is 0 and nothing is discarded. Ranges: storm (500 m) 250–465 m, blizzard 70–130 m,
  dense fog 20–36 m, mist (900 m) 465–860 m. Dog blob shadows fade with the same chunk; the sun
  shadows of a vanished dog fall on ground that is already ≥ 85 % haze.
  three.js picks a built-in program by a key that does not include the chunk text, so every fogged
  built-in material under `ctx.root` gets the mark `FOG_KEY` appended to its `customProgramCacheKey`
  (`atmosphereLight.adopt()` at the end of `setup` in `main.js`, then the periodic traverse for late
  ones). **Changing `FOG_FRAGMENT`: bump `FOG_MARK` and `FOG_KEY`**, otherwise running pages keep the
  old programs until a reload. Check such changes on the real canvas (`renderer.render` + `drawImage`
  in one eval), not with `screenshot()` — that one draws with its own programs and without ACES.
- What `scene.fog` does not cover gets the fog by mesh name (`FOG_BY_NAME` in `atmosphere-light.js`,
  applied on the scene traverse before the first frame): effects on `ShaderMaterial` (tracers, sparks,
  beams, artillery, gun smoke, black holes) get two lines appended after `#include <colorspace_fragment>`
  (distance from `gl_FragCoord.w`, no vertex shader change), additive MeshBasic glows (drone lights and
  fire, dog fx, `fx-particles`) get the fog chunk swapped. Modes: `fade` (additive: goes dark),
  `mix` (normal alpha: goes to the fog colour), `premult` (premultiplied alpha); all three also vanish
  past the visibility range. A new effect with its
  own shader: add its mesh name there. Additive MeshBasic / Sprite materials keep `fog: false` at the
  source, so one that is not in the table stays visible instead of glowing with the fog colour.
  Weather particles (`weather-*`) handle their own distance.
- **The fog colour follows the sky behind the objects.** A far tall object fades into `now.fogColor`,
  while the sky above the horizon is the clouds seen through a thinner veil — with a fog colour of its
  own it stood on a dark storm sky as a light ghost. So every frame `atmosphere-light.js` reads from the
  uniforms of the sky mesh `scene-sky-dome` (`hazeCool/Warm`, `bandCool/Warm`, `cloudLitFar/Mid`,
  `cloudShadeFar`, `cloudP`, `veilP` — **do not rename them in `world.js` without telling**) the colour
  the sky draws low above the horizon WITHOUT the veil (≈4.5°, leaning to the side away from the sun)
  and the share of veil at ≈9°, and writes them to `shared.atmoSkyRef { r, g, b, free, ok }`. Next
  frame `atmosphere.js` moves `now.fogColor` from its own value toward that sky colour until a fully
  fogged object differs from the sky behind it by no more than `SKY_MATCH` (10 % of the sky luminance);
  when the veil covers that part of the sky too (dense fog, blizzard, dust storm: `free → 1`) the fog
  colour is free. Sky veil, ground, grass, particles and `scene.fog` all take `now.fogColor`, so they
  stay together. Measured on the desktop page with a ×36 dog at 250 m: the dog is 0.75–1.05 of the sky
  luminance behind it (at most 3–4 sRGB levels lighter, up to ~12 darker) in storm at dusk / midnight /
  noon, heavy rain, smog, blizzard, dust storm, dense fog, mist at dawn. Without the sky mesh
  (`ok = false`) the old colour is used.
- Smoke is lit, not glowing: `shared.objectLight.lit` = direct light × 0.7 (a quarter of that under the
  moon) + ambient × 0.3, where the ambient part goes by the **sky** luminance from `atmoSkyRef`, not by
  `ambientPower` (that one has a floor so that enemies stay readable, smoke with it glowed on a dark
  sky); exactly 1 at the default sunset. `artillery-fx` gets it in the shader (`LIT_GLSL`: fire,
  `vAdd = 1`, is left alone), `drones-smoke` and the non-additive `fx-particles` through the material
  colour (`LIT_BASIC`), gun smoke — `objectLight.sun / amb` (`smoke.js`).
- `__sceneState.atmoTune` — numbers that can be tried from vr:eval without a scene swap (empty = values
  from the code): `skyMatch`, `skyWarm`, `cloudLit`, `cloudThick`, `cloudFar`, `litAmbient`.
- Exposure: `renderer.toneMappingExposure = 0.55 × (1 + 0.35 · flash)` every frame (world.js only
  sets and restores it). Lightning also adds to the hemisphere light, and to the fog colour exactly as
  the sky adds it to its veil (`+ (0.26, 0.29, 0.38) · flash`).
- `envMapIntensity` of every material that uses `shared.weaponEnv` is scaled by the ambient
  brightness (the env map is a baked sunset); materials are collected by a scene traverse every 0.7 s.
- `shared.objectLight { dir, sun, amb }` — the same light for effects with their own shader
  (`smoke.js` reads it through uniforms): direction TO the sun / moon, colour × power, 1 by default.
- Dog shadows: `main.js` calls `sunShadows.setSun(world.shadowSun)` every frame (free while the vector
  does not change); strength = `SHADOW_STRENGTH × now.keyShadow`.

**Wind direction.** `windDir` = a base angle + a slow wander (±35° over minutes) + a small turn with
every gust (up to ±12°). The base is the old direction (to +X and a little to +Z, ≈17°) on the first
run; every `setWeather` to a NEW weather (auto-weather too, instant sets too) picks a new base anywhere
on the circle and turns to it the shortest way during the blend, so there is no jump. The base is saved
in `scene.atmo` (`windDeg`). `setWind(degrees)` fixes the direction exactly (no wander, no gust turn,
weather changes do not touch it) — use it for repeatable screenshots; `setWind(null)` frees it;
`reset()` returns the first-run base. Readers must take both components: rain / snow / leaves tilt
(`weather-fx.js`), grass sway and cloud drift (`world.js`) follow it in all four directions.

**Slow things.** `wet` grows in ~10–25 s of rain and dries in ~1.5–3 min; `puddles` need `rain > 0.25`
and are capped by the rain strength; `snowCover` grows in snowfall (blizzard ≈ 45 s to full), never
drops below 0.8 × winter weight, melts in ~20–30 s in summer and ~30–50 s in spring and autumn (light
snow does not settle then).
A rainbow also appears for ~1.5 min after rain when the sun comes out. Lightning: mean gap 4–14 s at
`lightning = 1`; the event object is reused (copy the numbers); `flash` = 2–3 flickers, ~0.3 s decay.
Auto-weather picks by season from the `AUTO` weights every 2.5–6 game minutes with a 40 s blend.

**Persistence.** `localStorage 'scene.atmo'` = `target` + `hour`. On a scene hot-swap the new object
takes the channel values and running blends from the old one (`carry()`; bump `CARRY_V` when the
shape of the carried state changes, otherwise the new code reads foreign fields).

**Menu.** `scene/menu.js` builds «Погода и небо ▸» from `WEATHER_GROUPS` / `TIME_GROUPS` / `SEASONS` /
`SKIES`; the current choice is marked `● `; `main.js onMenu` matches `picked.path[0] === ATMO_MENU`
and looks the item up by its Russian name; the menu is rebuilt when `atmosphere.rev` changes.

**To add a weather**: one line in `WEATHERS` (`w(id, name, cover, dark, direct, fog, visibilityM,
wind, { rain, snow, … })`), its id in a `WEATHER_GROUPS` entry (keep ≤ 6 per group: the wheel gets
cramped) and, if it should appear by itself, weights in `AUTO`. A new time of day: a line in `TIMES`
and its id in `TIME_GROUPS`. A new sky style is more work: an entry in `SKIES`, its weight in
`now.sky` and `derive()`, the style channel arrays (sized 4) — and a palette in `sky-palettes.js`.
