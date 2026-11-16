# Effects and sound

Files: `scene/effects.js` (owned by shooting.js: `createEffects({ THREE, group })`),
`scene/smoke.js`, `scene/tracer.js`, AK flash in `scene/main.js`, `scene/sound.js`.
Assets: `web/public/sounds/guns/*.ogg` (CC0, LICENSE.txt).

## effects.js

```js
const effects = createEffects({ THREE, group });
effects.muzzleFlash(position, direction)   // core + petals + sparks + smoke.muzzle + flash light
effects.setMuzzle(position|null)           // per frame: smoke wisp follows the current muzzle
effects.eject(position, right, up)         // brass casing + ejection-port smoke
effects.impact(point, normal)              // sparks + glow + impact dust
effects.dust(point)                        // clay dust cloud
effects.tracer(from, to)                   // tracer.js
effects.update(dt); effects.dispose()
```
Only shooting.js holds `effects`; scene code reaches it via `shooting.shoot/aim/puff`.
Generic particles use `spawn(geometry, {color, additive, opacity}, position, {life ms, velocity,
gravity, drag, scale0, scale1, quaternion, spin, fadePower})`: one `Mesh` + one new
`MeshBasicMaterial` per particle (legacy; fine for tens of particles per shot, avoid for
continuous emitters). Geometries (`sphere`, `cone`, `unitBox`, casing) are shared.

**One permanent `PointLight`** (`flashLight`), intensity animated. Never add/remove lights at
runtime: three recompiles every lit shader (frame hitch).

## smoke.js / tracer.js (the efficient pattern)

Both are one `InstancedBufferGeometry` + one custom `ShaderMaterial`, CPU particle state in
typed arrays (struct-of-arrays, live ones first `count`), no allocations per frame,
`DynamicDrawUsage` attributes with `clearUpdateRanges()/addUpdateRange()`,
`geometry.instanceCount = n` (0 = no draw call), `frustumCulled = false` so the shader compiles
at scene start (not on first shot). Smoke cap 200 puffs, tracer cap 12 bullets (oldest replaced).
- smoke: `muzzle(pos, dir)`, `setMuzzle(pos|null)`, `eject(pos, right, up)`,
  `impact(point, normal)`, `update(dt)`, `dispose()`. Lit by the sunset sun from +X, wind to −X.
- tracer: `fire(from, to)`, `update(dt)`, `dispose()`. Camera-facing quads built in the vertex
  shader; 190 m/s visual speed; streak + fading trail.
- Custom fragment shaders end with `#include <colorspace_fragment>` (and `toneMapped: false`
  where colours are final). Without it colours are wrong in the headset and in screenshots.

AK flash (scene/main.js `flash`): one merged mesh (3 crossed planes + disc), additive canvas
gradient texture, visible 45 ms after a shot at the shooter's muzzle (`placeFlash`).

## sound.js

```js
export const SOUND_VERSION = 17;     // bump when the returned object must be rebuilt
export const GUN_FILES = { pistol: ['pistolB1', 'pistolB2'], ak: ['ak1', 'ak2', 'ak3'] };
const sound = createSound();          // lives in __sceneState.sound
sound.version
sound.update(camera)                  // listener = head; called every frame from scene/main.js
sound.setWeapon('pistol' | 'ak')      // what shot() without kind sounds like
sound.shot({ kind, position })        // sample (random variant, ±3 % pitch) or synth fallback
sound.hit(position)                   // metal ping (synth), 3D
sound.shatter(position)               // clay break (synth), 3D
sound.previewFile(name) -> Promise<duration|null>   // raw file at the listener (for a sound board; no board file exists now)
```
Lifecycle: scene/main.js does
`if (shared.sound?.version !== SOUND_VERSION) shared.sound = createSound();` before
`createShooting` (shooting.js captures `shared.sound` once). The `AudioContext`, master gain,
compressor and convolver reverb live in `shared.audioGraph` and are reused across versions (a
page can create only a few contexts). Samples are decoded once into `shared.gunSamples`, keyed
by `JSON.stringify(GUN_FILES)`, loaded from `/sounds/guns/<name>.ogg` at creation. The context
starts suspended and resumes on the first sound (`ensure()`).

Routing:
- `makePanner(c, position, refDistance = 1.5, out = master)`: HRTF `PannerNode`, inverse model,
  rolloff 0.5; returns `master` if no position.
- `makeNear(c, position)`: within 1.2 m of the head an equal-power stereo path with low-shelf
  "proximity" boost, crossfading into HRTF by 0.55–1.2 m; quieter, 30 ms delayed reverb send.
  Used for your own gunshot near the hand.
- Helpers: `noise(c, t, {seconds, type, from, to, gain, decay, send, dest, reverb})`,
  `tone(c, t, {type, from, to, gain, decay, send, dest, reverb})`; `playSample(c, kind, dest,
  reverb)` with max 6 voices.
- Every public method wraps its body in `try { … } catch {}` — sound must never break a shot.

Gotchas: bump `SOUND_VERSION` for any change in `createSound` (otherwise the old object keeps
playing after the swap); change `GUN_FILES` to reload samples; keep per-burst limits (clays.js
limits shatter/hit sounds to 6 per 80 ms).
