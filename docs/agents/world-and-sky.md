# World: sky, ground, grass (and the car)

Files: `scene/world.js` (one big function; geometry, textures, shaders) and `scene/sky-palettes.js`
(CPU only: what the sky and the light look like for a given atmosphere state).
`createWorld({ THREE, scene, root, camera, renderer, sunShadow })` -> `{ shadowSun, update(dt), dispose() }`.

## Time of day, weather, season, sky style

World only **reads** the atmosphere state (`shared.atmosphere.now`, contract:
[atmosphere.md](atmosphere.md)). Every frame `skyLook.update(now, dt)` (sky-palettes.js) turns it into
ready colours and numbers (`look.*`: `THREE.Color` / `Vector*` mutated in place) and the shaders get
them as uniforms that hold those same objects. **No shader program changes with the weather; nothing
is allocated per frame** (~1 µs on the PC).

- **Palette** = sky style × sun height. `STYLES.{pink,gold,blue,cosmic}` each have 5 keys at
  `KEY_ELEV = [-16, -5, 2.2, 11, 38]`° (night, dusk, sunset, golden hour, day): zenith / band /
  horizon on the sun side and on the far side, glows, sun disc, cloud lit/shade colours, and the light
  on the grass (`sunLight` — at night the moon's, `skyLight`, `glowTint`). Styles blend by
  `now.sky` weights, keys by sun elevation. `pink[2]` is exactly the old hard-coded sunset: with the
  default state (pink, sunset, `partlyCloudy`) the picture equals the pre-atmosphere one — keep it so
  (`CLOUD_COVER_TODAY 0.35`, `CLOUD_DARK_TODAY 0.05`, `VISIBILITY_TODAY 16000` are the default
  weather's values at which every weather term is exactly zero). Mornings (`now.hour < 12`) shift the
  low-sun colours to rose.
- **Tuning a look = editing sky-palettes.js** (a normal cheap scene swap). Editing `createWorld`
  rebuilds the whole world (cache key = its source text).
- **Weather in the sky**: `cloudCover` shifts the cloud-map thickness (`cloudP.x`: below 0.35 the
  clouds melt, above it the warp noise fills the gaps, 1 = solid sheet; no extra texture fetch),
  `cloudDark` greys and darkens, `flash` lights clouds from inside (brightest toward the strike from
  `atmo.on('lightning')`), `visibilityM` + `fogColor` veil the sky from the horizon up (`veilP`) and
  fog the ground and blades by distance (`fogP`), `rainbow` draws an arc 42° from the antisolar point.
- **Night**: stars all over the sky (`nightP`; the Points are hidden by day), Milky Way, a moon disc
  lit by the real sun direction (the phase follows from `sunDir`/`moonDir`), cosmic style adds a
  nebula and an aurora (their texture fetches run only in that style, behind uniform branches).
- **Ground and grass**: light from the palette × weather (`sunDirect`, overcast, storm), seasons
  (`SEASONS`: grass colours, share of dry blades, spring flowers, autumn leaves), `wet` (darker +
  sheen), `puddles` (noise lows, mirror the sky, sun glint, rain rings), `snowCover` (patchy first,
  then a sheet; blades whiten and shorten; sparkles), wind (`wind`, `gust`, `windDir`: sway, wave
  speed, flattening in a storm), moving cloud shadows by day (`shadeP`, sines only). The wind
  direction that reaches the shaders is **smoothed** in sky-palettes.js (~6 s, at most 5°/s):
  `now.windDir` swings ±12° on gusts and can point anywhere, while the field patterns (wind waves,
  cloud shadows) are built in wind axes and turn around the world origin — unsmoothed, far stripes
  would jerk by tens of metres. Flowers, leaves
  and sparkles come from the B and A channels of the blade-stroke texture — same fetches as before.
- **Shadows**: `world.shadowSun` is one `Vector3` moved in place every frame toward the light (sun,
  the moon below `-5.5°`), never lower than 22°. Baked grass shadows are re-rendered when it has moved
  more than 2.5° and is not racing (> 3°/s fades them out until it settles); their strength is
  `now.keyShadow` (0 under overcast: the two fetches are skipped).
- For neighbours: `shared.skyLook` (same object, updated every frame in `world.update`):
  `sunLight`, `skyLight` (light on the ground), `zenith`, `lightDir`, `night`, `shadow`, `snow`, and
  the **actual horizon colour** — what the sky shader draws at elevation 0 and what the far ground
  fades into (linear, "ready for the screen", like `now.fogColor`; it already contains the style
  palette for this sun height, overcast and storm darkening, the weather fog and the lightning
  flash): `horizonSun` / `horizonFar` (toward the sun and away from it), `horizon` (their average
  over the circle — one colour for fog on objects), `horizonAt(x, z, out)` (exact colour in a
  direction, with the glow next to the sun), `sunFlat` (`Vector2`: colour in direction `d` is
  `mix(horizonFar, horizonSun, s³)`, `s = dot(d.xz, sunFlat) · 0.5 + 0.5`), `veil` (0..1 share of
  `now.fogColor` in it).
- **Do not rename the sky dome's uniforms without telling the atmosphere owner**: `atmosphere.js`
  reads `hazeCool`, `hazeWarm`, `bandCool`, `bandWarm`, `cloudLitFar`, `cloudShadeFar`, `cloudSun`,
  `cloudP`, `veilP` straight from the `scene-sky-dome`
  material every frame to match `now.fogColor` to the sky behind distant objects. What the shader
  draws low above the horizon (sin elevation 0.08, no veil) under a solid cloud sheet, measured to
  0…+10 %: sky = `mix(mix(hazeCool, hazeWarm, s³), mix(bandCool, bandWarm, s²), 1 − exp(−11·e))`;
  cloud = `mix(cloudShadeFar, cloudLitFar, k) · (1 − 0.415·cloudP.w)`, `k = d²(3 − 2d)`,
  `d = clamp(cloudSun.y·0.6 + 0.42)`, blended 23 % into the horizon colour.
- Checking a look without touching the shared state: `__sceneState.atmoOverride =
  __sceneState.worldDebug.makeNow()` (a default `now` with a `sun(elevDeg, azDeg)` helper; set fields,
  take the screenshot in the same `vr:eval` call, then `atmoOverride = null`).

## What it sets globally (and restores in dispose)

- `camera.far = 5000` (shell uses 100).
- `renderer.toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 0.55` (set once; afterwards
  the exposure is driven by `atmosphere-light.js`). This affects standard materials (weapons, targets,
  clays). Sky/ground/grass and UI use `toneMapped: false` and compute final colours themselves.
- Hides the shell `GridHelper`.
- `dispose()` runs each cleanup step in its own `try/catch` (template for robust disposal).

## Pieces

| Piece | Object (name) | Notes |
|---|---|---|
| Sky | `scene-sky` group (follows the head) / `scene-sky-dome` mesh, `ShaderMaterial` | gradient from the palette (default: sunset, sun right, +X, 2.2° up, 8° toward +Z), sun and moon, clouds from a 1024² cloud map (cached in `globalThis.__skyCloudMap`, key `'clumps-v3'`; bump the key when the generator changes), Milky Way, nebula, aurora, rainbow, fog veil. `renderOrder 900`: drawn after opaque so hidden pixels are skipped. Texture fetches per pixel: 5 at the default sunset (as before), 4 by day, 0 with no clouds; +2 nebula and +2 aurora only in the cosmic style |
| Stars | `scene-stars` (`Points`, `renderOrder -999`) | angular size; `starPx` uniform from eye viewport. 1400 on the dark side of the sunset sky + 800 more that show only when stars cover the whole sky (night); hidden by day |
| Ground | `scene-ground` (`ShaderMaterial`, 9000 m plane, 128² warped grid) | height `height(x,z)`: flat within 6 m, hills to 70 m. Colour from a 256² noise `DataTexture` (GPU hash noise cost ~30 fps on Quest), horizon haze matches sky (`hazeWarm`, `hazeCool`) |
| Grass | `scene-grass` group, 3 `InstancedMesh` LODs = 3 draws (`GRASS_COUNT 72000` blade-equivalents): LOD0 2-segment blade < `LOD_DISTANCE 8` m (~6.6k), LOD1 one triangle < `CLUMP_FROM 20` m (~18k), LOD2 "crown" = `CROWN_BLADES 6` blades leaning outward, sharing base verts (12 verts), growing with distance, to `GRASS_RING 60` m (~7.9k) — ≈188k verts / 92k tris per eye (old cone: 141k / 69k) | **full circle** around the origin (density `1/(1+((d−2)/12)²)`, dense where the tower looks: 10–40 m, front −Z ×1, back ×0.8; far blades wider/taller), `GRASS_HEIGHT 1`. Shader lighting uses the geometry `normal` (crowns need it). Wind in vertex shader only; per-instance `aVariation` precomputed on CPU (vertex texture fetch is expensive on Quest). Blades fade to the ground's field colour (fully at the ring edge), so the ring edge is invisible |
| Far grass field | ground shader (`MEADOW_GLSL`: `grassLush`, `grassField`, `windWave`) | beyond/between blades the ground draws "grass seen from afar": blade lighting averaged over orientations (sky + low sun + translucency against the sun), tone and dry patches, and **painted blades**: `bladeTex` (256² `DataTexture` of 2600 tapered strokes, dark base → light tip, G = dry tip; built once, cached in `worldCache.bladeData/bladeTexture`, mipmaps + anisotropy 4) sampled at 3 scales (2.5 m, 11 m rotated, 45 m rotated; `strokes = max(...)`) — light blade tips over dark gaps everywhere, so the ground reads as dense grass from the 8 m tower and the 45 m layer keeps a tufty texture far out; `cover = strokes·1.3 + graze²·0.35` (grazing = blades hide the gaps). `windWave(p)` (sines only, ~40 m bands, ~7 m/s along +X, `time` = `grassTime` = world clock) bends + brightens blades and brightens the far field identically |
| Grass shadows | baked into a 2048² render target from an ortho "sun" camera (never lower than `SHADOW_ELEVATION 22°`), centred on the origin (±30 m across the sun, up to ±80 m along it); re-baked when the light has moved (see above) | ground shader darkens by it; `renderer.xr.enabled = false` while rendering to the target |

Per frame (`update`): `skyLook.update` (atmosphere → uniforms), `shadowSun`, sky group follows
camera, cloud/warp offsets drift with the wind, `skyTime`, `grassTime`, star pixel size, grass
shadow re-bake when due.

## Ground height for placing things

Use `groundAt(x, z)` exported from `scene/targets.js` (same formula as world.js `height`); within
6 m of the origin it is 0. `car.js` has its own copy. If you change terrain, change all three.

## Shader gotchas

- Custom `ShaderMaterial` fragment shaders end with `#include <colorspace_fragment>`; colours in
  the shader are linear.
- Prefer texture lookups over procedural noise in fragment shaders; avoid texture fetches in
  vertex shaders (precompute attributes on CPU).
- Everything is drawn twice (two eyes) at 120 Hz: count triangles (`[perf] tris=`).
- The old sunset sun direction is still duplicated as constants in `targets.js` and `tower.js`
  (`SUN_AZIMUTH`, `SHADOW_ELEVATION`: their baked shadows) and `smoke.js` (`SUN`): those do not
  follow the time of day yet. The live direction is `world.shadowSun` / `shared.skyLook.lightDir`.
- Sky and ground materials use three's own dithering (`dithering: true` + `#include <common>`,
  `<dithering_pars_fragment>`, and `<dithering_fragment>` after `<colorspace_fragment>`): ±0.5 of the
  last bit from a `gl_FragCoord` hash, no texture fetch. Without it the dark night sky and the moon
  halo band into rings. `vr:shot` renders into a **linear** 8-bit target, so dark gradients band far
  more in screenshots than on the real screen (and the dither shows there as fine grain); to judge
  banding look at the real window (`mcp__claude-browser__browser_screenshot`). Grass blades are not
  dithered (their fragment shader is kept minimal).
- GLSL ES 3 reserved words bite in `ShaderMaterial` code (`flat`, `sample`, `smooth`, …). three only
  logs a shader compile error (it does not throw), so after a shader edit also grep
  `logs/page-console.log` for `Shader Error`.

## Car — IN PROGRESS

`scene/car.js`: `createCar({ THREE, root, camera })` -> `{ apply(enabled, saved) -> newPose|null,
pose(), model, update(dt), dispose() }`. Enabled by scene feature `car`
([scenes-compositions.md](scenes-compositions.md)); placed once 3.4 m in front of the player at
ground height, pose `{ p:[x,y,z], yaw }` stored in the scene's `data.car`/`live.car`
(`storeCarPose`). Currently display only: steering oscillates, wheels spin.
`scene/car-model.js`: `buildCar(THREE)` -> `{ group, wheels[4], frontWheelPivots[2],
steeringWheel, setSteer(-1..1), setWheelSpin(radPerSec), update(dt), dispose() }`; front −Z,
right +X, origin on the ground between the axles. Handle: `__sceneState.car`.
