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
| Grass | `scene-grass` group, 2 `InstancedMesh` LODs (`GRASS_COUNT 36000`, `LOD_DISTANCE 10`) | wind in vertex shader only; meadow area `GRASS_AREA` (in front, −Z); per-instance `aVariation` precomputed on CPU (vertex texture fetch is expensive on Quest) |
| Grass shadows | baked once into a 2048² render target from an ortho "sun" camera (`SHADOW_ELEVATION 22°`) | ground shader darkens by it; `renderer.xr.enabled = false` while rendering to the target |

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
