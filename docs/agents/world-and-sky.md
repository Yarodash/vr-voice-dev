# World: sky, ground, grass (and the car)

File: `scene/world.js` (~840 lines, one function). `createWorld({ THREE, scene, root, camera,
renderer })` -> `{ update(dt), dispose() }`. No other API; nothing else reads its internals.

## What it sets globally (and restores in dispose)

- `camera.far = 5000` (shell uses 100).
- `renderer.toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 0.55`. This affects
  standard materials (weapons, targets, clays). Sky/ground/grass and UI use `toneMapped: false`
  and compute final colours themselves.
- Hides the shell `GridHelper`.
- `dispose()` runs each cleanup step in its own `try/catch` (template for robust disposal).

## Pieces

| Piece | Object (name) | Notes |
|---|---|---|
| Sky | `scene-sky` group (follows the head) / `scene-sky-dome` mesh, `ShaderMaterial` | sunset gradient (sun right, +X, `SUN_ELEVATION 2.2°`, `SUN_AZIMUTH -8°`), clouds from a 1024² cloud map (cached in `globalThis.__skyCloudMap`, key `'clumps-v3'`; bump the key when the generator changes), Milky Way. `renderOrder 900`: drawn after opaque so hidden pixels are skipped |
| Stars | `scene-stars` (`Points`, `renderOrder -999`) | angular size; `starPx` uniform from eye viewport |
| Ground | `scene-ground` (`ShaderMaterial`, 9000 m plane, 128² warped grid) | height `height(x,z)`: flat within 6 m, hills to 70 m. Colour from a 256² noise `DataTexture` (GPU hash noise cost ~30 fps on Quest), horizon haze matches sky (`hazeWarm`, `hazeCool`) |
| Grass | `scene-grass` group, 3 `InstancedMesh` LODs = 3 draws (`GRASS_COUNT 72000` blade-equivalents): LOD0 2-segment blade < `LOD_DISTANCE 8` m (~6.6k), LOD1 one triangle < `CLUMP_FROM 20` m (~18k), LOD2 "crown" = `CROWN_BLADES 6` blades leaning outward, sharing base verts (12 verts), growing with distance, to `GRASS_RING 60` m (~7.9k) — ≈188k verts / 92k tris per eye (old cone: 141k / 69k) | **full circle** around the origin (density `1/(1+((d−2)/12)²)`, dense where the tower looks: 10–40 m, front −Z ×1, back ×0.8; far blades wider/taller), `GRASS_HEIGHT 1`. Shader lighting uses the geometry `normal` (crowns need it). Wind in vertex shader only; per-instance `aVariation` precomputed on CPU (vertex texture fetch is expensive on Quest). Blades fade to the ground's field colour (fully at the ring edge), so the ring edge is invisible |
| Far grass field | ground shader (`MEADOW_GLSL`: `grassLush`, `grassField`, `windWave`) | beyond/between blades the ground draws "grass seen from afar": blade lighting averaged over orientations (sky + low sun + translucency against the sun), tone and dry patches, and **painted blades**: `bladeTex` (256² `DataTexture` of 2600 tapered strokes, dark base → light tip, G = dry tip; built once, cached in `worldCache.bladeData/bladeTexture`, mipmaps + anisotropy 4) sampled at 3 scales (2.5 m, 11 m rotated, 45 m rotated; `strokes = max(...)`) — light blade tips over dark gaps everywhere, so the ground reads as dense grass from the 8 m tower and the 45 m layer keeps a tufty texture far out; `cover = strokes·1.3 + graze²·0.35` (grazing = blades hide the gaps). `windWave(p)` (sines only, ~40 m bands, ~7 m/s along +X, `time` = `grassTime` = world clock) bends + brightens blades and brightens the far field identically |
| Grass shadows | baked once into a 2048² render target from an ortho "sun" camera (`SHADOW_ELEVATION 22°`), centred on the origin (±30 m across the sun, ±80 m along it) | ground shader darkens by it; `renderer.xr.enabled = false` while rendering to the target |

Per frame (`update`): sky group follows camera, cloud/warp offsets drift, `skyTime`,
`grassTime`, star pixel size; first frame bakes grass shadows.

## Ground height for placing things

Use `groundAt(x, z)` exported from `scene/targets.js` (same formula as world.js `height`); within
6 m of the origin it is 0. `car.js` has its own copy. If you change terrain, change all three.

## Shader gotchas

- Custom `ShaderMaterial` fragment shaders end with `#include <colorspace_fragment>`; colours in
  the shader are linear.
- Prefer texture lookups over procedural noise in fragment shaders; avoid texture fetches in
  vertex shaders (precompute attributes on CPU).
- Everything is drawn twice (two eyes) at 120 Hz: count triangles (`[perf] tris=`).
- Sun direction is duplicated as constants in `targets.js` (`SUN_AZIMUTH`, `SHADOW_ELEVATION`)
  and `smoke.js` (`SUN`); keep them in sync.

## Car — IN PROGRESS

`scene/car.js`: `createCar({ THREE, root, camera })` -> `{ apply(enabled, saved) -> newPose|null,
pose(), model, update(dt), dispose() }`. Enabled by scene feature `car`
([scenes-compositions.md](scenes-compositions.md)); placed once 3.4 m in front of the player at
ground height, pose `{ p:[x,y,z], yaw }` stored in the scene's `data.car`/`live.car`
(`storeCarPose`). Currently display only: steering oscillates, wheels spin.
`scene/car-model.js`: `buildCar(THREE)` -> `{ group, wheels[4], frontWheelPivots[2],
steeringWheel, setSteer(-1..1), setWheelSpin(radPerSec), update(dt), dispose() }`; front −Z,
right +X, origin on the ground between the axles. Handle: `__sceneState.car`.
